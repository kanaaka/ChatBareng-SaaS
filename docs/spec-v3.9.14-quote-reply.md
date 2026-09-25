# Spec — ChatBareng SaaS v3.9.14: Quote Reply (WhatsApp contextInfo)

**Status:** DRAFT — awaiting Kanaka GO → then Dory implements end-to-end.
**Priority rationale (Kanaka 2026-09-25):** "make it a feature now, it's essential" — customers quote-reply in real WhatsApp; CS currently loses that context entirely.
**Version target:** v3.9.14 (next additive feature release).

---

## 0. Verified groundwork (Alita, 2026-09-25)

- Baileys supports quoting natively: `node_modules/@whiskeysockets/baileys/lib/Types/Message.d.ts` →
  `MiscMessageGenerationOptions.quoted?: WAMessage` ("the message you want to quote").
  Send signature: `sock.sendMessage(jid, content, { quoted: waMessage })` — Baileys fills
  `contextInfo` (stanzaId + participant + quotedMessage proto) in the outgoing stanza.
- Inbound: quoted replies arrive as `msg.message.extendedTextMessage` (+ optional other keys) with
  `contextInfo = { stanzaId, participant, quotedMessage }` — full quoted proto embedded.
- ChatBareng today: **zero** handling — `extractText()` (pool.js:791) reads only
  `conversation` / `extendedTextMessage.text`; send path (chats.js `/:id/reply` →
  `wa.sendMessageForTenant` → `sock.sendMessage(waJid, { text })`) never passes `quoted`.
- Message model (schema.prisma): has `waMessageId`, `participantJid`, `direction`, encrypted
  `content`, `mediaType`, `purged` — everything needed to reconstruct quotes. No quoted columns yet.

---

## 1. Goals

1. **Inbound:** customer quote-reply → CS sees a quote chip (author + snippet + type icon) on the bubble; data persisted.
2. **Outbound:** CS replies to any bubble → outgoing message carries real WA `contextInfo` → customer sees the standard quote preview in WhatsApp.
3. 1:1 AND group chats both supported (groups: participant JID matters for the quote).
4. Additive-only migration; no change to queue/claim semantics, CSAT, auto-reply, Menu Gateway, or Public API v1 behavior.

## 2. Non-goals (P1)

- Quoting via Public API v1 (`/api/v1/messages` stays quote-less; actor-less semantics locked).
- Scheduled messages & blast with quotes.
- Reply-with-media (media sends stay unquoted). Text reply **quoting a media bubble** IS supported.
- Resolving `@lid` participants inside contextInfo (store raw; display resolves via DB lookup).

---

## 3. Data model (additive migration `20260925XXXXXX_message_quote`)

`Message` + 4 nullable columns:

| column | type | meaning |
|---|---|---|
| `quotedWaMessageId` | String? | `contextInfo.stanzaId` (in) / target `waMessageId` (out) |
| `quotedParticipantJid` | String? | full JID of quoted author (groups); null in 1:1 |
| `quotedSnippet` | String? | **encrypted** (`encryptText`) truncated plaintext snippet, ≤200 chars — fallback when the referenced row is gone |
| `quotedType` | String? | `text\|image\|video\|audio\|sticker\|document` — chip icon |

- Resolution at read time: find row in same chat where `waMessageId = quotedWaMessageId`
  (existing `@@index([waMessageId])` covers it). No new index.
- Snippet is stored on the reply itself → quote survives purge/hard-delete of the original bubble.

## 4. Inbound (src/wa/pool.js)

1. New helper `extractQuote(msg)`: read `contextInfo` generically (first message key carrying it —
   `extendedTextMessage` is the 99% case). Extract `stanzaId`, `participant`, `quotedMessage` proto.
2. Snippet: plaintext from quoted proto (`conversation` / `extendedTextMessage.text` / media
   `caption`) → truncate 200 chars → `encryptText`. `quotedType` from proto key.
3. Persist on the incoming Message create (~line 1335) alongside existing fields.
4. Realtime broadcast payload for new messages carries the same `quoted` shape as REST (§6).
5. contextInfo.participant may be `@lid` → store raw, no resolution (LID mapping happens elsewhere already).

## 5. Outbound (src/routes/chats.js + src/wa/pool.js)

1. `POST /api/chats/:id/reply` accepts optional `replyToMessageId` (ChatBareng Message.id).
   Guards: target must exist, same chatId + tenantId, `purged=false`, and have a real `waMessageId`
   (failed/legacy rows → 400 VALIDATION "message cannot be quoted" — never fake a stanzaId).
2. Build minimal WAMessage and pass as Baileys `quoted`:
   ```js
   const quoted = {
     key: { remoteJid: chat.waJid, fromMe: target.direction === 'out',
            id: target.waMessageId, ...(target.participantJid ? { participant: target.participantJid } : {}) },
     message: protoFromRow(target), // text → { conversation }; media → minimal media proto (+caption)
   }
   ```
   `protoFromRow`: decrypt content; text → `{ conversation: text }`; media → object with the right
   media key + caption if present (WA renders placeholder chip — acceptable & standard).
3. Pool: `sendMessageForTenant(tid, waJid, text, { slot, quoted })` →
   `sock.sendMessage(waJid, { text }, quoted ? { quoted } : undefined)` — third-arg options, verified API.
4. On send: persist outgoing Message with quoted columns (same semantics as §3).
   WA send failure → existing 'failed' pattern, quoted fields still stored.
5. `/:id/media` (media send): quote NOT supported P1 → if `replyToMessageId` provided → 400 VALIDATION (explicit, no silent ignore).
6. `{name}` personalization, auto-reopen, first-response metrics: unchanged, quote is orthogonal.

## 6. Read API

Messages payload (chat detail endpoint + realtime new-message events) per message adds, only when set:
```json
"quoted": { "waMessageId": "…", "participantJid": "…|null", "snippet": "<decrypted ≤200>", "type": "text", "dbMessageId": 123|null }
```
- `dbMessageId` = resolved same-chat row via waMessageId; null when original purged/missing → UI snippet-only chip.

## 7. Frontend (Dashboard.vue — bubbles are inline; extracting a MessageBubble component is Dory's call if it keeps the diff sane)

1. **Chip render:** bubbles with `quoted` show compact preview above the bubble text: author name
   (resolve via dbMessageId → senderName/agent; else group participant name if known; else
   "pelanggan"/"kamu") + snippet + type icon (📷 🎥 🎤 📄 🩹 sticker → 🖼️). Tap chip with
   `dbMessageId` → scroll-to-original + brief highlight; without → no-op.
2. **Reply affordance:** hover (desktop) / long-press (mobile — same interaction family as existing
   favorite/star action) → "Reply" → composer shows quote chip (author + snippet + ✕ cancel).
   One pending reply at a time; new Reply replaces it.
3. **Send:** composer includes `replyToMessageId`; chip clears on success AND on failure (message
   still saved 'failed' — user re-sends without quote, acceptable P1).
4. Templates flyout (`/`), {name} insertion: pending quote persists (it's only text).
5. Reply action hidden on failed bubbles (no waMessageId) and on own-pending states.
6. Scroll math: message list auto-scroll must still land at bottom with chips adding height — verify.
7. Guidebook CS tab: add short "💬 Balas dengan Quote" section (Alita post-merge).

## 8. E2E & regression (scripts/e2e-v3914.cjs — port 5099 DB copy, WA_DISABLED=1)

- Reply + `replyToMessageId` → 200, row has quoted columns, snippet encrypted (verify decrypt roundtrip).
- Cross-chat / cross-tenant / purged / failed target → 400 (no leak).
- Read payload: quoted present with plaintext snippet + dbMessageId link; absent when null.
- Inbound extraction: unit-style test of `extractQuote` on synthetic extendedTextMessage w/ contextInfo (+ media-quote case) → fields correct.
- Media route with replyToMessageId → 400.
- Regressions: v3.9.13 (39/39), v3.9.11, v3.9.4–v3.9.9 suites ALL PASS. Frontend build exit 0.

## 9. Deploy note (Alita)

- Migration ADDITIVE (4 nullable columns) → `npx prisma migrate deploy` safe; no seed change.
- Backup DB pre-deploy (backup/ convention), frontend rebuild + `public-pre-build-*` snapshot, restart, E2E, CHANGELOG entry, commit + tag `v3.9.14`.

## 10. Explicit invariants (locked)

- Quote NEVER touches assignment/queue/PIC semantics (claim philosophy locked 2026-09-25).
- Public API v1 untouched (actor-less).
- No destructive DB ops anywhere (lesson #8); additive migration only.
- Multi-line/encrypted content round-trips MUST be post-verified (lesson #4).