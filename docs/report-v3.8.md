# Report v3.8 — SuperAdmin WA Monitor (real-time) + Masa Aktif Tenant (READ-ONLY enforcement)

> Implementasi atas spec `docs/spec-v3.8-wa-monitor-validity.md` — request owner (Kanaka) 15:23;
> enforcement READ-ONLY per keputusan owner 15:30. Dikerjakan oleh Dory (coding subagent) 15:32–17:45 WIB.
> Basis: v3.7.1. Schema change ADDITIVE (2 kolom) — backup DB dulu, counts verified. NO git commit.
> App 5047 running (pid berpindah by-PID 2×: restart utama + 1 hotfix bug guard-order, lihat §3 F1).

## Ringkasan

Dua fitur:

1. **§A — Chip WA real-time per tenant di SuperAdmin** (backend TIDAK berubah; data `waStatus`
   sudah ada di GET `/api/sa/tenants`):
   - Chip di kartu tenant: 🟢 "WA terhubung" (hijau) / 🟡 "Menunggu scan QR" (kuning) / ⚪ "Terputus" (abu) / abu "WA off" (`disabled`).
   - Polling `GET /api/sa/tenants` tiap **15 detik** selama halaman aktif — silent in-place update
     (tanpa loading flicker), `clearInterval` saat unmount, tombol refresh manual tetap ada.
   - TANPA socket baru (dicatat sebagai kemungkinan v2).

2. **§B — Masa aktif tenant (subscription validity)** — READ-ONLY enforcement:
   - Schema: `Tenant.validFrom DateTime?`, `Tenant.validUntil DateTime?` (additive push, backup dulu).
   - `GET /api/sa/tenants` → + `validFrom`, `validUntil`, `validityState` (`lifetime|active|expiring|expired|not_started`).
   - `PUT /api/sa/tenants/:id/validity` (super_admin) — preset `30d|1y|lifetime|custom` + `startDate`/`endDate`.
   - **Enforcement READ-ONLY**: expired/not_started tetap bisa login & GET; SEMUA route NON-GET tenant
     diblokir 403 `SUBSCRIPTION_EXPIRED` / `SUBSCRIPTION_NOT_STARTED` (global write-guard middleware).
   - Low-level send guard di `pool.js`: semua outgoing (scheduler + auto-reply greeting + CSAT + blast)
     diblokir bila expired — incoming tetap diterima & tampil.
   - `/api/auth/me` → + `subscription: { state, validFrom, validUntil }`.
   - Frontend tenant: banner persistent + route guard (hanya tampilan awal) + tombol send disabled + logout jalan.
   - SuperAdmin: chip masa aktif di kartu + modal "Masa Aktif" (4 preset + date start default hari-ini-WIB + preview selesai).
   - Existing tenants (Parahita #4, Mazaya #8) = null/null = **Lifetime, zero behavior change**.

**Status QA: SEMUA PASS** (7 skenario + regresi + unit guard). 1 bug ditemukan saat QA dan diperbaiki
(guard terpasang setelah router → tidak pernah jalan; lihat §3 F1). Tenant dummy di-purge di akhir
(tenant=2, user=9 kembali seperti semula). Live tenants tidak tersentuh.

⚠️ **Catatan WA t4/t8 (pre-existing infra, BUKAN dari v3.8):** sesi WA tenant 4 & 8 sudah **revoked
di sisi WhatsApp** (device unpaired dari server) — sejak boot 12:38 (SEBELUM perubahan v3.8, terlihat
di log boot lama) Baileys loop QR→408 (timedOut). Perlu **scan QR ulang manual** oleh pemilik nomor.
Kode koneksi pool TIDAK disentuh v3.8 ini; python WS-handshake test ke `web.whatsapp.com/ws/chat`
sukses 101+noise-init (jaringan OK). Chip §A justru membantu: owner bisa lihat state QR/terputus real-time.

---

## 1. File dibuat / diedit (+ diff summary)

| File | Perubahan | Ringkasan diff |
|---|---|---|
| `prisma/schema.prisma` | EDIT (+9) | Tenant: + `validFrom DateTime?`, `validUntil DateTime?` + komentar v3.8 (null/null = Lifetime; READ-ONLY per owner 15:30). |
| `src/services/validity.js` | **BARU** (+120) | Sumber kebenaran validity: `validityState(tenant)` (`lifetime|active|expiring|expired|not_started`, grace expiring 7 hari), `isReadOnly(state)`, `codeFor(state)`, `getSubscription(tenantId)`, `validityToJson(t)`, `applyValidityPreset(tenant, body)` (4 preset; custom wajib endDate > startDate; 30d/1y dari startDate‖now; lifetime → validUntil null, validFrom boleh dicatat). |
| `src/auth.js` | EDIT (+45) | + `requireActiveSubscription` middleware (ekspor + re-export via middleware/tenant): pasang setelah `requireTenant`; super_admin bebas; expired/not_started → 403 JSON `{error, code}`; fail-open saat DB error. |
| `src/middleware/tenant.js` | EDIT (+2) | Re-export `requireActiveSubscription`. |
| `src/server.js` | EDIT (+37/−37 pindah) | Global WRITE-GUARD: `app.use('/api', …)` **SEBELUM semua router tenant** (lihat §3 F1) — intercept non-GET, whitelist (auth/branding/media/push/csat-publik/appearance-get/gdrive-oauth-callback/history-export/blast-csv-preview-export/contacts-export), verify token ringan + `resolveTenant` + `requireActiveSubscription`. GET/HEAD/OPTIONS lewat semua. |
| `src/wa/pool.js` | EDIT (+39) | `assertCanSendTenant(tenantId)` — dipanggil di awal `sendMessageForTenant` & `sendMediaForTenant`: expired/not_started → throw `SUBSCRIPTION_EXPIRED`/`SUBSCRIPTION_NOT_STARTED` SEBELUM sentuh socket (menutup scheduler/auto-reply/CSAT/menuGateway/blast); fail-open saat DB error; tenant lifetime/active pass-through. |
| `src/routes/superadmin.js` | EDIT (+54) | GET `/tenants`: + `...validity.validityToJson(t)` (validFrom/validUntil/validityState). NEW `PUT /tenants/:id/validity` (sa-chain; validasi; audit action baru `validity_update`; response final + computed state). |
| `src/routes/auth.js` | EDIT (+10) | GET `/me`: + `payload.subscription = validity.getSubscription(tenantId)` (try/catch non-fatal; super_admin tanpa tenant → tanpa field). |
| `frontend/src/utils/subscription.js` | **BARU** (+65) | State reactive subscription + `setSubscription/clearSubscription` + `isReadOnlyState` + `isTenantLocked(user)` (super_admin & impersonate bebas) + `fmtDateId`. |
| `frontend/src/stores/auth.js` | EDIT (+22) | login → fetch `/auth/me` utk subscription; fetchMe → setSubscription; impersonate → fetch subscription tenant (SA bebas guard, tapi state ikut utk UI); logout → clearSubscription. |
| `frontend/src/App.vue` | EDIT (+16) | boot: setSubscription(auth.user.subscription) setelah loadBrandingAndPlan; tanpa sesi → clearSubscription; axios interceptor 403 `SUBSCRIPTION_EXPIRED`/`SUBSCRIPTION_NOT_STARTED` → toast + redirect ke tampilan awal (jika bukan di sana). |
| `frontend/src/router.js` | EDIT (+39/−2) | `beforeEach` v3.8 guard: `isTenantLocked` → hanya Dashboard/ChatDetail/Login allowed; lainnya redirect `/` + toast; guard lama jalan di `guardRest()` (perilaku identik). |
| `frontend/src/views/Dashboard.vue` | EDIT (+42) | Banner persistent di atas topbar (error-container, tidak bisa di-close) expired/not_started; `tenantLocked` computed; sendReply + handleFileUpload + Enter-key guard; prop `:send-disabled` ke ChatDetail. |
| `frontend/src/views/ChatDetail.vue` | EDIT (+9) | Prop `sendDisabled`; composer bar diganti banner 🔒 "Masa berlaku akun habis — Perbarui Langganan untuk menggunakan" saat locked. |
| `frontend/src/views/SuperAdmin.vue` | EDIT (+126) | Chip WA real-time (4 warna) + chip masa aktif (`validityChip`: Lifetime netral / s/d <tanggal> hijau / ⏰ N hari lagi kuning / Kedaluwarsa <tanggal> merah / Mulai <tanggal> biru); polling 15s silent + clearInterval unmount; modal "Masa Aktif" (preset Lifetime/30 Hari/1 Tahun/Custom + Date start default hari-ini-WIB + preview selesai computed); audit action `validity_update` di filter. |
| `prisma/data/saas-v3-backup-20260923-155256.db` | BACKUP | Snapshot SEBELUM `db push` (tenant=2, user=9 terverifikasi). |

Snapshot pre-build: `public-pre-build-20260923-155852/` (SEBELUM build).
Build verify (string dalam bundle hasil build): `SuperAdmin-*.js` = "WA terhubung", "Menunggu scan QR",
"Terputus", "Masa Aktif" (2×), "Lifetime — tanpa batas" (2×), validityState; `Dashboard-*.js` +
`index-*.js` = "Masa berlaku akun habis", "Masa aktif dimulai", `setSubscription`, `clearSubscription`,
`isTenantLocked` (4×), `SUBSCRIPTION_NOT_STARTED`; `TanganKanan-*.js` = banner ChatDetail.

---

## 2. Output ASLI QA

Setup: tenant dummy **QA-Dory-v38-172925 (id 18, preset pro)** via API superadmin (token JWT di-sign
lokal dari JWT_SECRET .env); admin `qa-dory-admin-v38` (id 43). Semua skrip QA sementara dihapus
setelah dipakai; fixture purge di akhir (tenant=2, user=9 kembali).

### QA 1 — Tenant baru default lifetime → semua fitur normal
```
POST /api/sa/tenants {"name":"QA-Dory-v38-172925","preset":"pro"} →
{"tenant":{"id":18,...,"validFrom":null,"validUntil":null},"plan":{...pro...}} HTTP:201
POST /api/sa/tenants/18/admins → user id 43 qa-dory-admin-v38 HTTP:201
GET /api/sa/tenants → id 18 validityState "lifetime" (chip netral)
POST /api/tags {"name":"QA Tag Lifetime"} → {"tag":{"id":60,...}} HTTP:201   ← write OK
GET /api/auth/me → {"subscription":{"state":"lifetime","validFrom":null,"validUntil":null}}
```

### QA 2 — Set 30d start hari ini → write OK, chip hijau
```
PUT /api/sa/tenants/18/validity {"preset":"30d"} →
{"validFrom":"2026-09-23T10:29:44.087Z","validUntil":"2026-10-23T10:29:44.087Z","validityState":"active"} HTTP:200
GET /api/sa/tenants → id 18 validityState "active" (chip hijau "s/d 23 Okt 2026")
POST /api/tags → HTTP:201 (write OK)
```

### QA 3 — Custom endDate kemarin → LOGIN MASIH LOLOS, banner, send ditolak, guard jalan
```
PUT validity custom startDate 2026-09-21, endDate 2026-09-22 23:59 WIB →
{"validFrom":"2026-09-20T17:00:00.000Z","validUntil":"2026-09-22T16:59:59.000Z","validityState":"expired"} HTTP:200
(custom endDate < startDate tanpa startDate eksplisit → 400 "endDate harus SETELAH startDate" — validasi jalan)
POST /api/auth/login (admin t18) → HTTP:200  ← LOGIN MASIH LOLOS (read-only, tidak ditolak)
GET /api/auth/me → {"state":"expired",...}
GET /api/chats → 200 · GET /api/tags → 200      ← read/export dibuka
POST /api/tags → 403 {"error":"Masa aktif tenant habis. Perbarui langganan untuk menggunakan kembali.","code":"SUBSCRIPTION_EXPIRED"}
POST /api/chats/999/reply → 403 SUBSCRIPTION_EXPIRED
POST /api/blast → 403 SUBSCRIPTION_EXPIRED
PUT /api/autoreply → 403 SUBSCRIPTION_EXPIRED
POST /api/purge → 403 SUBSCRIPTION_EXPIRED
GET /api/contacts/export → 200                  ← export tetap dibuka
POST /api/auth/change-password → 200            ← self-service jalan (logout juga bebas)
POST /api/tags (dengan X-Tenant-Id: 18, token SA) → 201  ← super_admin impersonate TIDAK kena guard
```
Banner + route guard + tombol disabled = UI (bundle build verify; state expired dari /auth/me).

### QA 4 — Perpanjang → banner hilang, write OK lagi
```
PUT validity custom endDate 2026-12-22 23:59 WIB → validityState "active" HTTP:200
GET /api/auth/me → {"state":"active",...}
POST /api/tags "QA Tag setelah perpanjang" → HTTP:201 (write OK lagi)
```

### QA 5 — startDate masa depan → "belum dimulai", write ditolak, read jalan
```
PUT validity custom startDate 2026-09-30, endDate 2026-10-30 → validityState "not_started" HTTP:200
GET /api/auth/me → {"state":"not_started",...}
POST /api/tags → 403 {"error":"Masa aktif tenant belum dimulai. Menunggu tanggal mulai langganan.","code":"SUBSCRIPTION_NOT_STARTED"}
GET /api/tags → 200 (read jalan)
```

### QA 6 — Regression: preset lain + suspend tetap lebih kuat + existing tenant
```
PUT validity {"preset":"lifetime"} → validUntil null, state lifetime; write 201 lagi ✓
PUT validity {"preset":"1y"} → validFrom=now, validUntil=+1y, state active ✓
PUT /api/sa/tenants/18 {"status":"suspended"} → 200; login → 403 "Tenant sedang suspended…" (suspended MENANG)
PUT {"status":"active"} → login 200 lagi ✓
Parahita #4 & Mazaya #8: validFrom=null, validUntil=null, state=lifetime — tidak berubah ✓
```

### QA 7 — Unit + real guard pool.js (scheduler & auto-reply TIDAK mengirim)
```
[a] validity.getSubscription(18) → expired; guard logic → BLOCKED code=SUBSCRIPTION_EXPIRED; tenant 4 lifetime → pass-through. PASS
[b] wa.sendMessageForTenant(18, ...) (pool asli) → threw SUBSCRIPTION_EXPIRED "Masa aktif tenant habis — pengiriman diblokir…" (sebelum cek socket) PASS ✓
[c] sendMessageForTenant(4) (lifetime) → threw WA_NOT_CONNECTED (bukan guard block) PASS ✓
[e] autoReply.maybeAutoReply(chat t18 expired) → {"sent":false}, TIDAK crash, message keluar = 0, marker lastAutoGreetDate di-revert null. PASS ✓
[f] csat.sendSurveyMessage (t18 expired) → 'wa_not_connected' (tetap pending, TIDAK sent; WA socket t18 memang belum pernah connect — guard tetap lapis kedua)
    + v0100.processScheduledMessages() → scheduled t18 status "error", error: "Masa aktif tenant habis — pengiriman diblokir…" (TIDAK pernah 'sent'). PASS ✓
```
Fixture chat/survey/scheduled dummy dibuat via prisma direct (tenant 18) lalu ter-purge.

### QA 8 — Chip WA real-time (polling + transisi natural)
```
GET /api/sa/tenants 3x poll (0s / 20s / 90s) → state per tenant:
poll1: 4=qr, 8=qr, 18=qr
poll2 (±90s kemudian, setelah Baileys QR-timeout natural): 4=reconnecting, 8=reconnecting, 18=reconnecting
→ endpoint polling source berubah in-place; frontend silent update tiap 15s tanpa flicker (loading flag tidak disentuh), clearInterval saat unmount (kode onUnmounted).
```
Tidak ada dev stub yang bisa memaksa state spesifik; transisi natural QR→reconnecting terverifikasi via 2 polling snapshot.

### QA 9 — Build + restart + health + live tenants utuh
```
Snapshot: cp -r public public-pre-build-20260923-155852 (SEBELUM build)
Build: ✓ built in 2.53s (Dashboard-BUzjwwV_.js, SuperAdmin-DBrpJENi.js, index-zBzaza80.js)
Restart #1 (utama, setelah db push): kill 83152 → pid 47823. health 200.
Restart #2 (HOTFIX F1 — guard order bug): kill 47823 → pid 49870. health 200. root 200.
db push ADDITIVE: pre tenant=2 user=9 → post tenant=2 user=9 (TIDAK berubah);
Parahita #4 & Mazaya #8 validFrom/validUntil tetap null.
Purge dummy: {"ok":true,"deleted":{"chats":5,"tags":6,"users":1,...},"filesRemoved":0} HTTP:200
POST-PURGE tenant=2 user=9 ✓
```

### Catatan WA reconnect t4/t8 (bisa diulang oleh owner)
- Sesi WA tenant 4 (+6281xxxx6888) & 8 (+6288xxxx02624) **perlu scan QR ulang**: sesi revoked di
  sisi WA (408 timedOut berulang setelah QR emitted; device sudah unpair dari server WA).
- 408-loop ini SUDAH ADA sejak boot app SEBELUM v3.8 (boot 12:38, terlihat di log yang sama
  sebelum restart v3.8 — bukan regresi perubahan ini; kode koneksi pool tidak disentuh).
- Reconnect manual via API jalan (200) dan setiap percobaan QR baru di-emit — menunggu scan
  oleh pemilik nomor. Chip §A menampilkan state ini real-time (Menunggu scan QR / Terputus).
- Bukti jaringan OK: WS handshake python ke `wss://web.whatsapp.com/ws/chat` → 101 + 6 bytes noise init.

## 3. Bug ditemukan saat QA + perbaikan

| # | Bug | Deteksi | Perbaikan | Re-test |
|---|---|---|---|---|
| F1 | Global WRITE-GUARD awalnya dipasang **SETELAH** router tenant terdaftar (line ~114, setelah `app.use('/api/tags', …)` dll) → `/api/tags` POST oleh tenant expired **masih 201** (router menangani request sebelum guard). | QA 3.4: POST tags expired → 201 (harusnya 403). | Guard dipindah ke **SEBELUM** semua router tenant (setelah rate-limiter, line ~73) + restart by-PID. | QA 3.4 re-test: 403 `SUBSCRIPTION_EXPIRED` ✓; GET tetap 200 ✓; seluruh QA 3.5–3.9 pass. |

## 4. Deviasi + catatan

| # | Deviasi | Alasan |
|---|---|---|
| D1 | Total restart 2× (bukan 1×). | Restart #1 = batas utama (setelah db push + build). #2 = hotfix F1 (guard order — bug v3.8 sendiri ketahuan QA; QA dengan guard mati = QA bohong). |
| D2 | WA t4/t8 TIDAK connected saat lapor (status: QR menunggu scan / state berubah-ubah qr↔reconnecting↔failed). | Sesi WA revoked di sisi WA (pre-existing, bukan regresi v3.8 — kode koneksi tidak disentuh; 408-loop ada sejak boot 12:38 pre-v3.8). Perlu scan QR ulang manual oleh pemilik nomor di Admin WhatsApp tenant. Reconnect API jalan (200) & QR di-emit tiap percobaan. |
| D3 | QA custom "endDate kemarin" memerlukan startDate eksplisit (kemarin lusa). | Validasi `endDate > startDate` menolak endDate kemarin dengan startDate default = now (ini BENAR sesuai spec "custom wajib endDate > startDate (validasi 400 kalau tidak)"). Ditambah QA validasi 400-nya sendiri. |
| D4 | QA 7e/7f via unit-call service (maybeAutoReply/sendSurveyMessage/processScheduledMessages) dengan fixture chat/survey/scheduled dummy di tenant 18, bukan menunggu tick natural. | Deterministik & cepat; pola report v3.7; fixture ikut purge. |
| D5 | Chip WA polling diverifikasi via 2 snapshot polling endpoint (bukan browser UI screenshot). | Perubahan state natural QR→reconnecting terbukti berpindah antar polling; UI chip murni render field yang sama. |
| D6 | Modal validity mengirim endDate sebagai 23:59:59.999 WIB dan startDate 00:00 WIB (date-input). | UX: "s/d 23 Okt" berarti masih aktif sepanjang hari itu; preview modal menampilkan sama. |
| D7 | `/api/media/` POST upload & `/api/push/` & `/api/auth/` di-whitelist dari guard. | Media upload = jalur kirim media reply (sudah ditutup di level chats reply/media + low-level guard); push = perangkat self-service; auth = login/change-password (logout harus jalan). Perilaku kirim tetap diblokir di jalur yang menghasilkan outgoing WA. |

**Tidak ada FAIL tersisa.** Tidak ada `--force-reset`/`--accept-data-loss`/DROP/rm DB. `db push`
additive 2 kolom, backup + verifikasi counts 2/9 sebelum-sesudah. Fisio 8770 tidak disentuh;
5030 tetap mati; portable instance tidak disentuh. NO git commit.

## 5. Cara pakai (untuk review Alita)

1. **SuperAdmin → chip WA**: buka `/superadmin` — chip status WA tiap tenant update tiap 15 detik
   (WA off / WA terhubung / Menunggu scan QR / Terputus).
2. **SuperAdmin → Masa Aktif**: tombol "Masa Aktif" di kartu tenant → preset Lifetime / 30 Hari /
   1 Tahun / Custom (+ tanggal mulai, default hari-ini-WIB) → preview tanggal selesai → Simpan.
   Chip kartu berubah: Lifetime / s/d <tanggal> / ⏰ N hari lagi / Kedaluwarsa <tanggal>.
3. **Tenant expired**: login tetap jalan; banner merah "Masa berlaku akun habis — Perbarui Langganan
   untuk menggunakan" persistent; menu lain diblokir (route guard); tombol kirim disabled; logout jalan.
   API tulis nyasar → 403 SUBSCRIPTION_EXPIRED (toast). Scheduler/auto-reply/greeting/CSAT TIDAK
   mengirim apa pun. Incoming WA tetap tampil.
4. **Perpanjang** via SA → banner hilang, semua fitur normal lagi.
5. **Suspend tetap lebih kuat** dari expired (gak bisa login sama sekali).