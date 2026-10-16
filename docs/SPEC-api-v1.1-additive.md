# SPEC — ChatBareng Public API v1.1 (additive) + Reopen Consistency Fix

> Status: DRAFT — menunggu approval Kanaka. Penulis Alita (2026-10-17, hasil diskusi feedback 05:32–06:16).
> **Shipping:** ini rilis patch aplikasi CB berikutnya (v4.6.x — prod sekarang v4.6.11) lewat jalur
> release standar ke GitHub IT (build → smoke → audit Kimi → PR → merge → deploy). "v1.1" di judul
> = versi KONTRAK Public API, bukan versi aplikasi. Endpoint TIDAK berubah URL; semua tambahan
> bersifat additive + optional → backward compatible 100%.
> Semua keputusan desain sudah di-settle di diskusi feedback dengan Kanaka (tidak ada open question).

## 0. Ringkasan

Tiga hal dalam satu bundel rilis:
1. **API v1.1 (additive):** scope baru `choose_slot` + `assign_agent`, params opsional
   `numberSlot` & `assignTo` di `POST /api/v1/messages`, endpoint baru `GET /api/v1/users`.
2. **Reopen consistency fix:** initiate start-chat dari kontak ke chat resolved → unbind
   assignment lama (konsisten dengan auto-reopen inbound `src/wa/pool.js:1758-1769`).
3. **Key creation UI:** 2 checkbox baru (choose slot / choose agent) di form API key.

## 1. Scopes baru (model udah mendukung — `prisma/schema.prisma:826-845`, `scopes` CSV)

- Tambah 2 scope token: **`choose_slot`**, **`assign_agent`** (CSV di kolom `scopes` — tanpa
  migration DB, cuma nilai baru yang valid).
- **`services/apiKeys.parseScopes`** + validasi whitelist scope di `routes/apiKeys.js` +
  superadmin create-key path (`src/routes/superadmin.js:1365-1395`) → tambahkan 2 token ini.
- **UI key creation/share** (AdminApiKeys panel + superadmin): tambah 2 checkbox
  "Pilih nomor slot" dan "Pilih agent (auto-assign)" — label jelas: tanpa centang = behaviour
  v1.0 (slot-0, chat masuk queue, bebas di-take).
- Scope TIDAK mengubah behavior per se — capability saja. Behaviour per-request ditentukan
  param yang dikirim (lihat §2). Key tanpa scope baru + request bawa param → `403 SCOPE_MISSING`
  (loud, konsisten dengan existing `requireScope`).
- Existing keys (mis. notifier `send`) — ZERO impact: tanpa param baru = byte-per-byte v1.0.

## 2. `POST /api/v1/messages` — params opsional baru (`src/routes/apiV1.js:114+`)

Semua additive; TIDAK ada perubahan behaviour bila params tidak dikirim.

### 2.1 `numberSlot` (opsional, int 0..2)
- Hanya dihormati bila key punya scope `choose_slot`; tanpa scope → `403 SCOPE_MISSING`
  (pesan: "Key tidak punya scope choose_slot").
- Validasi: integer 0..2 (pattern v3.9.3 fix LOW-1 di contacts.js:778 — invalid eksplisit
  400, JANGAN silent-fallback ke slot-0).
- Tidak dikirim → slot-0 (persis `resolveTarget` v1.0 sekarang, `src/routes/apiV1.js:190+`).
- Slot memilih chat terpisah per slot (chat per slot = pattern v3.9.2 K1-A).

### 2.2 `assignTo` (opsional, int userId agent tenant)
- Hanya dihormati bila key punya scope `assign_agent`; tanpa scope → `403 SCOPE_MISSING`.
- Validasi (400 VALIDATION bila gagal): userId exists + **tenant sama** + role CS aktif +
  status akun active. (Agent list didapat klien dari endpoint §3.)
- **TIDAK dikirim → behaviour v1.0 penuh** (chat dibuat open+unassigned; existing-chat
  assignment UNTOUCHED; resolved tetap resolved). Ini kontrak "masuk queue, bebas di-take".

### 2.3 Behaviour matrix (KONTRAK — semua terverifikasi dari source, file:line)

| Chat state saat API send | Tanpa `assignTo` (v1.0) | Dengan `assignTo` (v1.1) |
|---|---|---|
| **Belum ada chat/kontak baru** | create open + **unassigned** (quickstart:40-49) | create open + **assigned ke agent** |
| **Open + unassigned** | untouched → tetap di queue | **assign ke agent** (keluar dari queue-eligible) |
| **Open + assigned CS X, X ≠ assignTo** | untouched | **KIRIM SAJA, assignment TIDAK ditimpa** (keputusan Kanaka Edge 1 06:05: "tetap kirim nggak apa-apa, ada catatan") — response bawa field `chatState` (§2.4) supaya client bisa menampilkan catatan "chat lagi di-handle CS X" + opsi pakai slot lain (chat per slot!) |
| **Open + assigned = assignTo** | untouched | kirim normal (no-op assignment) |
| **Resolved** | **tetap resolved** (status untouched — verified quickstart:40 + apiV1 handler) | **reopen + assign ke agent**: `status:'open', resolvedAt:null, reopenedCount+1, assignedToId=assignTo` + ChatEvent `reopened` (source api) — KEMUDIAN pesan dikirim (urutan: reopen dulu, send kemudian, biar pesan masuk thread yang open) |

Rasional edge "open+assigned CS lain → jangan timpa": chat aktif = pekerjaan aktif CS itu
(mencuri assignment = breaking flow CS); Kreatr Edge-1 flow sudah dirancang: client lihat
`chatState`, tampilkan catatan, dan bisa pilih **numberSlot lain** via param §2.1 → chat slot
lain biasanya unassigned → assignTo bekerja di sana. Resolved = bebas (keputusan Kanaka
06:12: "chat resolved adalah chat bebas") — assignTo di situ selalu boleh + reopen.

### 2.4 Response `POST /messages` (v1.1)
- Sukses tetap `200 {ok:true, waMessageId?}` + **field baru `chatState`** (selalu include —
  murah dan bikin client konsisten): `{chatId, status, numberSlot, assignedTo:{id,username}|null,
  reopened:bool}`. Client (Kreatr) menampilkan catatan bila `status==='open'` dan
  `assignedTo.id ≠ assignTo yang diminta`.
- Error codes BARU: tidak ada — pakai existing (400 VALIDATION / 403 SCOPE_MISSING /
  503 WA_BELUM_TERHUBUNG / 429 / 401). Tidak ada silent-ignore di jalur manapun.

### 2.5 Audit trail
- Bila terjadi assign/reopen via param: ChatEvent baru type `'assigned_api'` (userId=null,
  source api — pattern `logApiEvent` `src/routes/apiV1.js:160-166`) dengan
  `metaJson: {assignedToId, before: assignedToId|null, reopened: bool}` — history jejak.
- Reopen via API ikut increment `reopenedCount` (kolom sudah ada).

## 3. Endpoint baru: `GET /api/v1/users`

- **Scope gate: `assign_agent`** (bukan read — key yang bisa assign harus bisa milih agent,
  meski tidak punya scope read chat).
- Response: hanya user tenant yang sama, `role IN ('CS','admin')`… — sesuaikan dengan enum
  role CB sebenarnya (verify di source: User model) yang `status='active'`; kolom minimal:
  `{id, username, name, role}`. TANPA email/phone/hash.
- Paginasi sederhana `?limit=100&offset=0` (pattern /chats).
- Tujuan: dropdown pilih agent di Kreatr (spec Kreatr C1 §2).

## 4. Reopen consistency fix (initiate start-chat dari kontak — `src/routes/contacts.js:791-803`)

**Masalah (verified):** resolved chat + agent B initiate → reopen TAPI `assignedTo` lama
nyangkut (`claimIfUnassigned` hanya klaim bila kosong) → corner case "open tapi label CS
lama" — inkonsisten dengan auto-reopen inbound (`src/wa/pool.js:1758-1769` yang sudah
unbind + `assignedToId:null` + masuk queue).

**Fix (keputusan Kanaka 06:12 — "resolved = chat bebas, initiate = pindah agent"):**
- Start-chat flow: reopen resolved → **unbind dulu** (`assignedToId: null`,
  `resolvedAt: null`, `reopenedCount+1`, event `reopened` + optionally meta
  `previousAssigneeId` untuk jejak audit — murah, disarankan) → kemudian
  `claimIfUnassigned` yang sudah ada otomatis meng-claim ke initiator B (bila B role CS;
  admin/supervisor initiate → tetap open unassigned — behaviour klaim role v0.1.25 UNCHANGED).
- Berlaku di KEDUA branch start-chat (linked chat `contacts.js:790` dan branch
  findChatByAnyJid `contacts.js:871`) — sama pattern.
- Net effect: 3 jalur reopen konsisten deterministic —
  (1) inbound resolve → queue unassigned; (2) CS initiate → open milik initiator;
  (3) API assignTo → open milik agent preset.

## 5. Yang TIDAK berubah (regression lock)

- Endpoint URLs, auth header, rate limit 60/min per key, error-code shapes.
- Key existing + request tanpa param baru → **byte-per-byte v1.0** (smoke harus membuktikan).
- `resolveTarget` normalize JID/phone (v3.9.18 lid handling dst.) — hanya
  slot resolution yang terpengaruh param numberSlot.
- Kalkulator/kalkulasi chat per slot (v3.9.2 K1-A) — dipakai apa adanya.
- Superadmin create-key flow (hanya menambah opsi scopes di UI).

## 6. Acceptance (Alita — E2E prod-standar + regression)

1. Key v1.0 (scope `send` saja, mis. notifier): kirim → behaviour + response shape IDENTIK
   v1.0 (snapshot diff). Param baru dikirim paksa → 403 SCOPE_MISSING.
2. Key v1.1 full-scope: (a) send kontak baru tanpa assignTo → chat unassigned (b) dengan
   assignTo → chat assigned + terverifikasi di UI CB (c) kontak resolved + assignTo →
   reopened + assigned + pesan masuk thread (d) open+assigned CS lain + assignTo beda →
   kirim sukses + assignment TIDAK berubah + response chatState menyebut holder.
3. GET /users: hanya tenant sendiri, kolom minimal, scope gate benar (key `send` → 403).
4. UI: create key dengan 2 checkbox baru → scopes tersimpan benar (DB check via prefix).
5. Reopen fix (manual UI): chat resolved assigned A → agent B start-chat dari kontak →
   chat open **milik B** (A cuma di history ChatEvent) — verify via impersonate GET.
6. Regression: queue take flow, auto-reopen inbound (pool.js), group send — unit + smoke lulus.
7. SystemLog: tidak ada error/warn baru selain yang expected; audit event shape benar.

## 7. Release path (standar — chatbareng-it-release skill)

- Bump patch CB berikutnya (v4.6.12 atau sesuai urutan rilis IT — jangan di-hardcode di
  kode, hanya di CHANGELOG/PR). CHANGELOG entry: "API v1.1 (choose_slot/assign_agent:
  numberSlot+assignTo users endpoint; reopen consistency fix; key-creation UI checkboxes)".
- Docs update: `docs/API-CONSUMER-QUICKSTART.md` + `docs/spec-api-keys-v1.md` (scopes baru
  + params + behaviour matrix table §2.3 — copy-paste ready).
- Workflow: Dory coding → audit Kimi 2 ronde → Alita smoke + E2E → release path (PR ke IT).

## 8. Estimasi

API + fix + UI: ~3-4 jam Dory. Audit Kimi 2 ronde. Smoke/E2E 1-2 jam Alita. Satu rilis patch.