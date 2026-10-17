# ChatBareng API v1 — Consumer Quickstart (for integrating apps)

> Everything below is the FINAL interface. Trial and production use the same code.
>
> **API v1.1 (additive, app v4.6.12 pending):** two new optional scopes
> (`choose_slot`, `assign_agent`), two new optional params on `POST /messages`
> (`numberSlot`, `assignTo`), and one new endpoint `GET /api/v1/users`.
> Your existing v1.0 integration keeps working UNCHANGED — the new params are
> optional and keys without the new scopes behave exactly like v1.0.

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
Success → `200 {"ok": true, "waMessageId": "...", "chatState": {...}}`
(`waMessageId` omitted when WhatsApp returns no id; `chatState` present since v1.1 — see below.)

**You never pick which WhatsApp number does the sending** — ChatBareng resolves the right connected number internally (person or group).
_Unless your key has the `choose_slot` scope and you pass `numberSlot` — see "Choose the sender slot"._

## Choose the sender slot (scope `choose_slot`, optional param `numberSlot`)

```bash
curl -X POST "$BASE/api/v1/messages" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"target": "08123456789", "text": "Antrian #12, silakan datang", "numberSlot": 1}'
```

- `numberSlot` = integer **0..2** (each slot is a separate connected WhatsApp number / chat lane).
- Requires the `choose_slot` scope on your key; without it the request fails with `403 SCOPE_MISSING`.
- Invalid values (negative, non-integer, > 2) fail with `400 VALIDATION` — there is **no silent fallback to slot 0**.
- Omitted → sender resolution is exactly the v1.0 behaviour (slot-0 for persons).

## Assign the chat to a CS agent (scope `assign_agent`, optional param `assignTo`)

```bash
curl -X POST "$BASE/api/v1/messages" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"target": "08123456789", "text": "Pesanan #77 dikonfirmasi", "assignTo": 42}'
```

`assignTo` must be a **CS user id of the same tenant** (active account) — get candidates from
`GET /api/v1/users` below. Validation failure → `400 VALIDATION`; key without the `assign_agent`
scope → `403 SCOPE_MISSING`.

Behaviour matrix (current chat state at send time):

| Chat state when you send | Without `assignTo` (v1.0) | With `assignTo` (v1.1) |
|---|---|---|
| **No chat yet / new contact** | chat created `open` + **unassigned** (enters queue when customer replies) | chat created `open` + **assigned to the agent** |
| **Open + unassigned** | untouched → stays in queue | **assigned to the agent** (leaves the queue) |
| **Open + assigned to CS X, X ≠ assignTo** | untouched | **message is sent, assignment is NOT overwritten** — read `chatState` in the response and show a note ("chat is being handled by CS X"); alternatively pick another `numberSlot` (each slot lane is a separate chat, usually unassigned — `assignTo` works there) |
| **Open + assigned = assignTo** | untouched | normal send (assignment is a no-op) |
| **Resolved** | **stays resolved** | **reopen + assign**: `status:'open'`, `resolvedAt:null`, `reopenedCount+1`, `assignedToId=assignTo` — THEN the message is sent (reopen first, send second, so the message lands in an open thread) |

Resolved chats are "free" — `assignTo` always applies there (reopen + assign).

### Response `chatState` (every successful send, since v1.1)

```json
{
  "ok": true,
  "waMessageId": "3EB0...",
  "chatState": { "chatId": 123, "status": "open", "numberSlot": 0,
                 "assignedTo": { "id": 42, "username": "budi" }, "reopened": false }
}
```

- `assignedTo` = the **actual** holder after the send (`null` = unassigned). If you requested
  `assignTo` but `assignedTo.id` differs, the chat was already being handled by another CS —
  the message went out but the assignment was preserved.
- `reopened: true` = a resolved chat was reopened by this send.
- Chats created for groups carry no state (no per-group assignment) → `chatId: null`, `status: null`.

Every assign/reopen through the API is audited as a ChatEvent `assigned_api` (source `api`, `userId: null`).

## List assignable agents

```bash
curl "$BASE/api/v1/users?limit=100&offset=0" -H "Authorization: Bearer $KEY"
```

Requires the `assign_agent` scope (not `read` — a key that can assign must be able to list agents
even without read). Returns only users of the key's own tenant with role `cs`/`admin` and an
active account; columns are minimal: `{"users": [{ "id", "username", "name", "role" }]}`.
No emails, no phone numbers, no hashes. Pagination: `?limit=1..100` (default 100), `?offset>=0`.

## Read chats (conversation history)
```bash
curl "$BASE/api/v1/chats?limit=20" -H "Authorization: Bearer $KEY"
```

## Claim semantics — who "owns" the chats the API touches?

The API is **actor-less**: a key acts *for the tenant*, not as any user. Sending never claims a chat, never changes assignments, never auto-queues.
_(v1.1 exception: when your key holds the `assign_agent` scope AND you pass `assignTo`, the assignment behaviours of the matrix above apply — that is the only path where an API send touches assignment.)_

- **1:1, contact already exists** → assignment/status untouched. Whoever owns the chat keeps it; queued stays queued. _(v1.1: see the assignTo matrix above — with `assign_agent` scope + `assignTo` param, new-assignment/reopen behaviours apply per the matrix.)_
- **1:1, brand-new contact** → a chat row is created (`open`, unassigned, NOT queued — **unless** `assignTo` is passed: then `open` + assigned). It enters the take-queue only when the customer replies — then normal FIFO applies and any CS can take it.
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
| 400 | VALIDATION | bad target/text/numberSlot/assignTo | check formats (numberSlot = int 0..2; assignTo = CS id of same tenant) |

## Integration notes for devs
- Rate limit default: 60 requests/min per key (429 + `Retry-After` on breach)
- The key is tenant-scoped: it can only see/act on THAT tenant's chats, contacts & groups
- Revoke is instant: a revoked key fails on its very next request
- Never hardcode keys in public repos; env vars or config files outside VCS
