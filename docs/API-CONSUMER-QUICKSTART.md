# ChatBareng API v1 — Consumer Quickstart (for integrating apps)

> Everything below is the FINAL interface. Trial and production use the same code.

## What you need (3 things)
1. **API key** — issued by the ChatBareng admin, format `cbk_live_...` (store it in your app's config/env; treat like a password)
2. **Base URL** — e.g. `https://<tunnel-or-domain>` (trial period uses a tunnel URL; will change once when production hosting goes live)
3. Any HTTP client — every language works, no SDK needed

## Authentication
Send the key on EVERY request:
```
Authorization: Bearer cbk_live_...
```
(`X-API-Key: cbk_live_...` header is also accepted.)

## Send a WhatsApp message
To a person (any of these target formats work: `0812…`, `62812…`, `+62812…`):
```bash
curl -X POST "$BASE/api/v1/messages" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"target": "08123456789", "text": "Antrian #12, silakan datang"}'
```
To a group — by exact group name (easier) or JID:
```bash
curl -X POST "$BASE/api/v1/messages" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"target": "Komunitas UMKM Palembang", "text": "Pengumuman: ..."}'
```
Success → `200 {"ok": true, "waMessageId": "..."}`

**You never pick which WhatsApp number does the sending** — ChatBareng resolves the right connected number internally (person or group).

## Read chats (conversation history)
```bash
curl "$BASE/api/v1/chats?limit=20" -H "Authorization: Bearer $KEY"
```

## Claim semantics — who "owns" the chats the API touches?

The API is **actor-less**: a key acts *for the tenant*, not as any user. Sending never claims a chat, never changes assignments, never auto-queues:

- **1:1, contact already exists** → assignment/status untouched. Whoever owns the chat keeps it; queued stays queued.
- **1:1, brand-new contact** → a chat row is created (`open`, unassigned, NOT queued). It enters the take-queue only when the customer replies — then normal FIFO applies and any CS can take it.
- **Group** → only tenant-owned groups (exact name or `@g.us` JID) can receive sends. The PIC is set at group creation/adoption and is never changed by API sends. Orphan groups (no PIC) accept sends; their replies stay admin-only until an admin assigns a PIC.
- **Sender identity** → the customer sees the connected WhatsApp number of the resolved slot (slot-0 for person targets) — not an "admin account".

Every API send is audited as a ChatEvent with `source: 'api'`, `userId: null`.

## Error codes you may see
| HTTP | code | meaning | what to do |
|---|---|---|---|
| 401 | UNAUTHORIZED | key wrong/missing | check header |
| 401 | KEY_REVOKED / KEY_EXPIRED | key dead | ask owner for new key |
| 403 | SCOPE_MISSING | key lacks the scope for this endpoint | key owner adds scope |
| 403 | UPGRADE_REQUIRED | tenant plan lacks API access | contact ChatBareng admin |
| 429 | RATE_LIMITED | too many requests | respect `Retry-After` header |
| 503 | WA_BELUM_TERHUBUNG | WhatsApp slot offline (QR not scanned) | retry later; not your bug |
| 400 | VALIDATION | bad target/text | check target format |

## Integration notes for devs
- Rate limit default: 60 requests/min per key (429 + `Retry-After` on breach)
- The key is tenant-scoped: it can only see/act on THAT tenant's chats, contacts & groups
- Revoke is instant: a revoked key fails on its very next request
- Never hardcode keys in public repos; env vars or config files outside VCS
