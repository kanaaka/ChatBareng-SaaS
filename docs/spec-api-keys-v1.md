# ChatBareng Public API v1 — Spec (draft for Kanaka approval, 2026-09-24)

## Goal
External apps (queue systems, CRMs, custom programs) read/write WhatsApp through ChatBareng
using **tenant-scoped API keys**. Trial = same code path as production.

## 1. Schema (Prisma, additive-only — no existing table touched)
```prisma
model ApiKey {
  id           Int      @id @default(autoincrement())
  tenantId     Int
  name         String                     // "Queue App", "CRM Import"
  keyHash      String   @unique           // sha256(key) — raw key NEVER stored
  prefix       String                     // "cbk_live_a1b2" (last 4 shown in UI)
  scopes       String                     // "send,read,groups,webhook" (subset)
  planGated    Boolean  @default(true)    // requires TenantPlan.featApiAccess
  ratePerMin   Int      @default(60)      // per-key limiter
  lastUsedAt   DateTime?
  expiresAt    DateTime?                  // optional
  revokedAt    DateTime?
  createdByUserId Int
  createdAt    DateTime @default(now())
  @@index([tenantId])
}
model ApiWebhook {
  id        Int @id @default(autoincrement())
  tenantId  Int
  apiKeyId  Int
  url       String                     // HTTPS required
  secret    String                     // HMAC key for signing events
  events    String                     // "message.received,message.sent"
  active    Boolean @default(true)
  @@index([tenantId])
}
```

## 2. Auth flow (how an external app uses a key — the universal pattern)
1. App stores key in its config/env (e.g., `CHATBARENG_API_KEY=cbk_live_xxx…`)
2. Every request: `Authorization: Bearer cbk_live_xxx…` header (accept `X-API-Key` too)
3. Middleware `requireApiKey`:
   - sha256(key) → lookup `ApiKey` (miss → 401)
   - revoked/expired → 401 (revokedAt set = dead instantly, no restart)
   - tenant plan lacks `featApiAccess` → 403 `UPGRADE_REQUIRED`
   - scope missing for endpoint → 403 `SCOPE_MISSING`
   - per-key rate limit → 429 with `Retry-After`
   - sets `req.tenantId` + `req.apiKey` → handlers reuse existing tenant scoping untouched
4. Response: JSON. Errors: `{ error, code }` consistent with existing routes.

## 2b. Key generation
- Raw key: `cbk_live_` + 32 bytes base64url (~43 chars) via crypto.randomBytes
- Show ONCE at creation (copy button + warning); store hash only; UI shows prefix + lastUsedAt

## 3. Endpoints (base: /api/v1 — new router, does NOT touch existing routes)
| Method | Path | Scope | Notes |
|---|---|---|---|
| POST | /api/v1/messages | send | `{ target: "62812…" | "12036…@g.us" | group name, text, mediaPath? }` — slot resolved internally (slotOfRow); rate-limited per key; reuses `sendMessageForTenant` |
| GET | /api/v1/messages/:waMessageId | read | status/delivery info |
| GET | /api/v1/chats | read | list w/ pagination (`limit`, `cursor`) — reuses existing chat list query |
| GET | /api/v1/chats/:id/messages | read | history paging |
| GET | /api/v1/groups | groups | tenant groups across all slots (post-v3.9.6 rows), `{adopted}` filter, `viaSlot` |
| POST | /api/v1/webhooks | webhook | register URL + events (+ `POST /webhooks/test`) |
| GET | /api/v1/health | none | public liveness for consumer apps |

## 4. Scopes
`send`, `read`, `groups`, `webhook` — granular; key creation UI = checkboxes.

## 5. Webhooks (outbound events)
- Events: `message.received` (from customers), `message.sent` (by API/CS), `chat.assigned` (later phase)
- Delivery: POST JSON → tenant URL; header `X-ChatBareng-Signature: sha256=HMAC(body, secret)`; retry x5 backoff (1m/5m/15m/1h/6h) then drop + mark stale in UI
- Payload: `{ event, tenantId, data: { waJid, pushName?, text|mediaPath, waMessageId, timestamp } }` — never raw keys

## 6. Plan gating
- `TenantPlan.featApiAccess` (new flag; max=true, pro/lite=false → 403 + upgrade hint)
- Superadmin UI: create/revoke key for any tenant (onboarding help); tenant admin UI: self-service keys page

## 7. Safety rails
- Target validation: JID regex + must match `^\d+@(s.whatsapp.net|g.us)$`; unknown-number send = allowed (new convo born-assigned — same as CS send today) but logged
- Per-key ratePerMin (default 60) + existing global limiter untouched
- Audit: log every API send to ChatEvent (`source: 'api'`) — CS dashboard shows "via API" tag later
- Baileys hygiene: transactional volume patterns; bulk promo blast through API = ToS violation → key revocation policy in ToS

## 8. Phasing
- **P1 (trial-ready, ~1 day):** ApiKey schema + requireApiKey middleware + POST /messages + GET /chats + keys UI (create/revoke/list) + E2E v3.9.13 (key lifecycle: create→use→scope-deny→revoke→401)
- **P2 (+0.5–1 day):** webhooks (register + HMAC + retry queue + message.received/sent) + groups endpoint + audit "via API" tag
- **P3 (later):** member-level group detail, per-key analytics page, volume allowances

## 9. Test plan
- E2E: key CRUD + auth deny paths + scope matrix + tenant isolation (key A cannot read tenant B — 404 not 403) + rate limit 429 + revoke-immediate
- Manual: curl examples for docs; queue-app simulation script
