# QA AUDIT v3.9 (Kimi-K3) — Multi-Nomor WA per Tenant

- **Commit di-audit:** `cb356fc` (18 file, +1342/−462) — baseline `810dd24` (v3.8)
- **Auditor:** Kimi-K3 (independent, READ-ONLY) — tidak ada file kode/DB/server yang diubah. Verifikasi DB dilakukan SELECT-only via Prisma client ke `prisma/data/saas-v3.db`.
- **Sumber kebenaran:** `docs/spec-v3.9-multi-wa.md` + keputusan owner K1–K5 (LOCKED 18:24).
- **Tanggal audit:** 2026-09-23 WIB.

---

## VERDICT: 🔴 NO-GO (harus fix sebelum merge/deploy)

**6 CRITICAL · 5 HIGH · 4 MEDIUM · 3 LOW = 18 temuan.**

Fitur inti (reply-per-slot, born-assigned, blast multi-slot, kuota SA) dirancang sesuai spec — tapi implementasi **rusak di titik-titik paling dasar**: setiap panggilan `logoutTenant` melempar `ReferenceError` (variabel `s` tidak pernah didefinisikan), halaman **Admin Menu Gateway white-screen** (`waSlots`/`applySlot` dipakai tapi tidak pernah dideklarasikan), dan perubahan kunci unik `AutoReplyConfig`/`MenuGatewayConfig` (`tenantId @unique` → `@@unique([tenantId, numberSlot])`) **memecah semua `findUnique/update/upsert({ where: { tenantId } })` lama** di services/routes/seed — auto-reply, menu gateway, dan seeding tenant baru semuanya 500. Zero-change regression **GAGAL** untuk Parahita #4 & Mazaya #8.

---

## Ringkasan per Checklist

| # | Area | Status |
|---|------|--------|
| 1 | Schema (prisma/schema.prisma) | ⚠️ WARN (1 isyu non-blocking) |
| 2 | pool.js (slot map, API per-slot, routing) | ❌ FAIL (3 CRITICAL + 1 HIGH) |
| 3 | Reply path (chats.js + semua service senders) | ✅ PASS dgn 1 MEDIUM |
| 4 | Autoreply & Menu Gateway (services+routes+UI) | ❌ FAIL (1 CRITICAL frontend + 1 CRITICAL backend + 1 MEDIUM) |
| 5 | Blast (service/routes/UI) | ⚠️ WARN (1 MEDIUM round-robin off-by-one) |
| 6 | Superadmin (API kuota + modal + plan field) | ⚠️ WARN (1 HIGH off-by-one cap, 1 HIGH dampak logout rusak) |
| 7 | Zero-change regression (Parahita #4 / Mazaya #8) | ❌ FAIL (findUnique legacy broken) |
| 8 | Interaksi v3.8 (guard expired, super_admin) | ✅ PASS |
| 9 | Edge cases | ⚠️ WARN (beberapa PASS, beberapa terblokir bug di atas) |

---

## 1. Schema — ⚠️ PASS dgn WARN

Bukti (`prisma/schema.prisma` vs v3.8, `git diff 810dd24 cb356fc -- prisma/schema.prisma`):

- `TenantNumber` hadir: `slot` (0..2), `label`, `waSessionDir`, `routeMode`, `assignedAgentId`, `reassignOffline`, `@@unique([tenantId, slot])`. ✅
- `Tenant.waMode String @default("pool")` ✅ (default pool → zero change).
- `TenantPlan.maxNumbers Int?` (null = 1) ✅ — ditempatkan di `TenantPlan` (bukan `Tenant`).
- `AutoReplyConfig`/`MenuGatewayConfig`: kolom baru `numberSlot Int?` + kunci berubah jadi `@@unique([tenantId, numberSlot])`. Menyediakan link-all (NULL) ✅ — **tapi kunci unik inilah yang memecah semua lookup lama** (lihat BUG-1).
- `Blast.numberSlots String?` + `Blast.rotateEvery Int?` ✅; `Chat.numberSlot Int?` ✅.
- ADDITIVE ✅ — tidak ada kolom lama dihapus/diubah tipe.

> **WARN-1 (LOW):** di SQLite, NULL dalam composite unique dianggap berbeda → `@@unique([tenantId, numberSlot])` **tidak melindungi dari duplikasi baris shared (numberSlot NULL)** bila ada dua `create` berurutan (race). Mitigasi praktik ada (seed idempoten via findFirst + update), tapi secara teoretis P2002 tidak akan ter-trigger untuk NULL. Rekomendasi: semua penulisan baris shared lewat `upsert`/`updateMany` by `tenantId_numberSlot { tenantId, numberSlot: null }` — dan jangan pernah `create` tanpa cek dulu. Tidak blocking.

> **WARN-2 (LOW):** spec §1 internal tidak konsisten (menulis `Tenant.maxNumbers` di satu tempat, `TenantPlan.maxNumbers` di tempat lain). Implementasi memilih `TenantPlan` — sudah benar; pertahankan.

Verifikasi DB (SELECT-only, `node -e` dgn Prisma client):
```
TENANTNUMBERS: [#4 slot=0 dir=data/wa-session/tenant-4 routeMode=pool,
                #8 slot=0 dir=data/wa-session/tenant-8 routeMode=pool]
TENANTS: Parahita #4 waMode=pool · Mazaya #8 waMode=pool
AR #4 numberSlot=null · MG #4 numberSlot=null · Chat #4 numberSlot=null
```
→ migrasi dev DB rapi; **dir sesi slot-0 TIDAK dimigrasi** (tetap `tenant-<id>`) ✅ HARD RULE.

## 2. pool.js — ❌ FAIL

Yang BENAR ✅:

- Dual-key pool: `slotKey(tid, slot) = "${tid}:${slot}"` (l.60), `tenantState(tid, slot)` (l.71). Map dibuat per-slot. ✅
- Slot-0 = `Tenant.waSessionDir` (l.285-290 `connectTenant`) — path sesi lama `tenant-<id>` — **tanpa migrasi** ✅ (HARD RULE).
- `connectTenant(tid, { slot })` guard: slot 1/2 WAJIB punya baris `TenantNumber` (l.255-258) ✅; double-connect guard per-slot ✅; `ensureSlot0Row` idempoten (l.170).
- Bootstrap `connectAllTenants` (l.208-231): connect SEMUA slot terdaftar per tenant; tenant tanpa baris → slot-0 saja. ✅
- Inbound routing (`processIncomingMessage`, l.1168-1240): set `Chat.numberSlot = inboxSlot` (hemat write), `resolveRouteForSlot` (l.184-204) — pool SELALU pool (zero change) ✅; assigned → born-assigned (+ ChatEvent `assigned`, broadcast `bornAssigned:true`, `queue.emitQueueUpdate`, push ke agent yang benar via `push.sendToUser(targetAgentId, …)`) ✅ **K1/K2 terpenuhi**; reassignOffline default OFF → personal queue bila agent offline TIDAK di-reassign ✅ **K2**; agent nonaktif → tidak assign ke "hantu" ✅.
- `slotNotConnectedMessage` (l.707) — pesan jelas menyebut slot & instruksi ✅ **K3**.
- `sendMessageForTenant`/`sendMediaForTenant` (l.710-…) `opts.slot`, tanpa fallback ✅; v3.8 `assertCanSendTenant` tetap di dalam path per-slot ✅.

Yang RUSAK ❌:

### 🔴 BUG-2 (CRITICAL) — `pool.get(tid)` tidak pernah match: pool key adalah STRING `"<tid>:<slot>"`

`src/wa/pool.js` l.528-530 (`disconnectTenant`), l.557-559 (`logoutTenant`), l.909 (`maybeResolveLidChat`) semuanya memanggil `pool.get(tid)` dgn **number** `tid`, padahal key tersimpan via `slotKey()` (string). Hasil:

- `disconnectTenant(tenantId)` — **SELALU no-op** untuk SEMUA slot (slot-0 pun!). Socket tidak di-end, `manualDisconnect` tidak di-set, timer reconnect tidak dibersihkan.
- `maybeResolveLidChat` — guard `if (!sock || !st) return` selalu true → **inline LID→phone resolve TIDAK PERNAH jalan untuk siapa pun** (regresi vs v3.8 yang punya resolve ini bekerja untuk slot-0). Konsekuensi: chat `@lid` tidak pernah auto-resolve nomornya; `requestPhoneNumber` fallback juga tak terkirim.

Fix arah: definisikan lookup konsisten, mis. `const st = pool.get(slotKey(tid, s))`, dan `disconnectTenant(tenantId, slot = 0)`.

### 🔴 BUG-3 (CRITICAL) — `logoutTenant` melempar `ReferenceError: s is not defined` di SETIAP panggilan

`src/wa/pool.js` l.557: deklarasi `async function logoutTenant(tenantId)` — **tanpa parameter slot** — sementara body memakai `s` di l.589 (`if (s === 0)`), l.593 (`slot: s` pada query), l.600/604/613 (`log(…, s, …)`). Route `src/routes/wa.js` l.120 sudah mengoper `slot` (`wa.logoutTenant(req.tenantId, slot)`) tapi argumen **dibuang**. Dampak:

- `POST /api/wa/logout` → 500 (setelah socket mungkin sudah di-end sebagian — state setengah jadi).
- Session dir **tidak pernah dihapus**; `Tenant.waPhone` tidak di-clear; broadcast `loggedOut` tidak terkirim.
- `DELETE /api/sa/tenants/:id/numbers/:slot` (superadmin) menangkap error ini sebagai "non-fatal" lalu **menghapus baris DB sementara socket slot masih hidup di pool** → slot "hantu": tetap menerima pesan, menulis `Chat.numberSlot` menggantung, dan tidak pernah reconnect setelah restart (bootstrap hanya slot terdaftar).

Fix arah: `async function logoutTenant(tenantId, slot = 0) { const s = Number(slot)||0; const st = pool.get(slotKey(tid, s)); … }`.

### 🔴 BUG-4 (HIGH) — LID resolve pakai socket slot-0 untuk pesan slot 1/2

`src/wa/pool.js` l.1246: `maybeResolveLidChat(tid, chat, getSocketForTenant(tid))` — argumen slot di-drop. Setelah BUG-2 diperbaiki, ini tetap salah untuk inbound slot≠0 (resolve dikirim lewat nomor yang salah / gagal). Seharusnya `getSocketForTenant(tid, inboxSlot)`.

### 🟠 BUG-5 (HIGH) — `reconnectTenant` tidak pernah membersihkan state lama

`src/wa/pool.js` l.617-…: `reconnectTenant(tenantId, slot)` memanggil `disconnectTenant(tenantId, slot)` — tapi `disconnectTenant` mengabaikan slot (BUG-2) → cleanup no-op → reconnect pada slot yang stuck = connect di atas socket lama tanpa end/end-timers. Rantai perbaikan yang sama dgn BUG-2 (pass slot ke bawah).

## 3. Reply path — ✅ PASS dgn 1 MEDIUM

Bukti:

- `src/routes/chats.js` l.851 (reply teks) & l.987 (reply media): `{ slot: Number(chat.numberSlot) || 0 }` — **K1** ✅ (kontak sama lewat nomor beda = chat terpisah karena slot beda, balas ikut slot penerima).
- Tidak ada jalur fallback di satu pun sender: `autoReply.js l.323`, `menuGateway.js l.180`, `csat.js l.182`, `v0100Scheduler.js l.146`, `blast.js l.225/228` — semua `{ slot: Number(chat.numberSlot) || 0 }` + komentar "JANGAN fallback". **K3** ✅.
- Slot mati → `slotNotConnectedMessage` jelas (slot + instruksi di Admin→WhatsApp) ✅.
- Chat lama `numberSlot=NULL` → `|| 0` → slot-0 (bukan error) ✅ edge case #9 terpenuhi.

### 🟡 BUG-6 (MEDIUM) — error "slot mati" tidak sampai ke UI CS

`chats.js` reply: exception dari send ditangkap generic → pesan tersimpan `status='failed'` + HTTP 200. Teks `slotNotConnectedMessage` ("Nomor pengirim (slot 1) tidak terhubung — …") **hanya ada di log**; response API tidak membawa alasan per-slot → CS di UI cuma melihat "gagal" tanpa tahu nomor mana mati. "Pesan jelas" baru setengah terpenuhi. Rekomendasi: sertakan `err.message` (atau field `waError`) pada payload response/socket event `message_failed`, plus tandai bubble failed di UI.

Catatan kecil: `err._replySlotFailed = true` diset pada objek error lokal yang langsung dibuang — dead code (LOW).

## 4. Autoreply & Menu Gateway — ❌ FAIL

Yang BENAR ✅:

- `services/autoReply.js` & `services/menuGateway.js`: `getConfigForSlot(tid, s)` → cari row per-slot → fallback shared (`numberSlot: null`); `orderBy numberSlot desc` menaruh spesifik di atas NULL (SQLite DESC: 2,1,0,NULL terakhir) ✅; cache key `"${tid}:${s}"` + `invalidateConfig` clear-all ✅. **K5** resolve ✅.
- Routes GET `?slot=` menambah resolusi per-slot tanpa mengubah default ✅.

### 🔴 BUG-1 (CRITICAL, sistemik) — perubahan kunci unik `AutoReplyConfig`/`MenuGatewayConfig` memecah SEMUA lookup lama

Schema mengubah `tenantId @unique` → `@@unique([tenantId, numberSlot])`. Client Prisma 5.10 sudah di-regenerate (terbukti `node_modules/.prisma/client/index.d.ts` punya `tenantId_numberSlot`), dan `*WhereUniqueInput` kini **hanya menerima `id` atau `tenantId_numberSlot`** — `tenantId` sendirian BUKAN lagi argumen where-unik yang sah.

Verifikasi runtime (SELECT terhadap DB dev):
```
p.autoReplyConfig.findUnique({ where: { tenantId: 4 } })
→ PrismaClientValidationError — where memerlukan minimal satu dari
  id / tenantId_numberSlot (tenantId saja DITOLAK).
```

Call-sites yang masih memakai pola lama (semuanya akan throw saat runtime):

| File:line | Konteks | Dampak |
|---|---|---|
| `src/services/autoReply.js:43,47` | `getConfig()` — dipakai `getConfigForSlot` sebagai fallback shared | **AUTO-REPLY MATI TOTAL** untuk semua tenant (setiap perhitungan greeting/outside-hours crash) |
| `src/services/menuGateway.js:41,52` | `getConfig()` — fallback untuk `getConfigForSlot` | **MENU GATEWAY MATI TOTAL** bila tak ada row per-slot |
| `src/services/menuGateway.js:235` | `autoReplyConfig.findUnique` saat startFlow (mode greeting) | startFlow crash |
| `src/services/tenantSeed.js:36,74` | seeding tenant baru | **pembuatan tenant baru 500** (seed gagal) |
| `src/routes/menuGateway.js:258` | GET route baca `autoReplyConfig` (greetEnabled/Mode) | **GET /api/menu-gateway selalu 500** |
| `src/routes/autoreply.js:151,162,169,184` | PUT route (upsert/update/menuGateway sync) | **PUT /api/autoreply selalu 500** (semua mode simpan) |
| `src/routes/menuGateway.js:322,324,342,352` (blok `whereKey` hanya benar utk per-slot) & `356,359` via `updateMany` (aman) | PUT route shared branch pakai `where: { tenantId }` untuk `findUnique`/`update` | **PUT /api/menu-gateway mode link-all 500** |

Ini **melanggar HARD RULE §0** (zero-change regression): Parahita #4 & Mazaya #8 (1 nomor, config shared NULL) tidak bisa memuat/menyimpan AutoReply & Menu Gateway lagi walaupun mereka tidak menyentuh fitur multi-nomor sama sekali. **Ini blocker paling besar — semua where-unik legacy pada dua model ini WAJIB dimigrasikan ke `tenantId_numberSlot: { tenantId, numberSlot: null }` (atau `findFirst`/`updateMany`).**

### 🔴 BUG-7 (CRITICAL, frontend) — AdminMenuGateway.vue memakai `waSlots`/`applySlot` yang tidak pernah dideklarasikan

`frontend/src/views/AdminMenuGateway.vue`:
- Template l.212-216 merender `waSlots.length` dan `v-model="applySlot"`.
- Script `save()` l.394 membaca `applySlot.value`.
- `grep -n "waSlots\|applySlot"` hanya menemukan 4 baris pakai — **tidak ada `const waSlots = ref([])`, tidak ada `const applySlot = ref('all')`, tidak ada fetch `/api/wa/status`** (bandingkan AdminAutoReply.vue yang menambahkannya dengan benar di l.159-161, 194-196, 211-214).

Di `<script setup>` Vue, akses identifier yang tidak terdefinisi saat render → `ReferenceError` → **halaman Menu Gateway admin crash (blank)** untuk semua tenant (termasuk tenant 1-nomor). Fix: tambahkan `const waSlots = ref([]); const applySlot = ref('all');` + fetch `GET /api/wa/status` di `fetchConfig()` (persis pola AdminAutoReply.vue).

### 🟡 BUG-8 (MEDIUM) — UI per-slot tanpa mode "lihat config slot tsb"

AdminAutoReply.vue/AdminMenuGateway.vue: `fetchConfig()` selalu GET shared; dropdown "Terapkan ke" hanya memengaruhi target SIMPAN. Admin yang memilih "Nomor ini saja — slot 1" akan **menimpa row slot-1 mulai dari nilai shared** tanpa pernah melihat nilai slot-1 yang lama (backend mendukung `GET ?slot=1`). Fungsional "default link-all" ✅, tapi editing per-slot buta. Rekomendasi: saat dropdown ≠ "Semua nomor", reload form via `GET ?slot=<n>`.

## 5. Blast — ⚠️ PASS dgn 1 MEDIUM

Yang BENAR ✅:

- `routes/blast.js`: validasi + dedup/sort/clamp `numberSlots` (JSON 0..2); `rotateEvery` hanya bila ≥2 slot, else null. ✅
- `services/blast.js`: state `activeSlots`, rotasi `sinceRotate >= rotateEvery → rrIndex++`, **slot disconnect di-skip + warning** (while `!connected && tries < len`) — bukan crash ✅ edge case #9; bila semua mati → error jelas per pesan (bukan crash) ✅; `BlastLog.senderSlot` dicatat ✅. Fixed path (rotateEvery 0) pakai `fixedSlot` = slot pertama terpilih ✅.
- `BlastComposer.vue`: multi-select dgn status per slot + disabled saat offline, field rotasi hanya bila >1 dipilih, `v-if="waSlots.length > 1"` (nol perubahan UI utk tenant 1-nomor) ✅.

### 🟡 BUG-9 (MEDIUM) — round-robin off-by-one: pesan pertama mulai dari slot KEDUA

`services/blast.js`: setelah init `nextSlot()` dipanggil sekali ("initial resolve") yang **menaikkan `sinceRotate` ke 1**, lalu pesan #1 memanggil `nextSlot()` lagi → `sinceRotate=2 >= rotateEvery` → langsung rotasi ke `activeSlots[1]`. Pola aktual (rotateEvery=2): B,B,A,A,B,B,… — tetap seimbang tapi selalu mulai di slot B dan counter bergeser satu. Fix: jangan panggil `nextSlot()` di init (cukup `currentSlot = activeSlots[0]`), atau reset `sinceRotate` setelahnya.

Catatan (LOW): route tidak memvalidasi slot terpilih terhadap kuota/kepemilikan (blast dgn slot 2 pada tenant 1-nomor → semua pesan gagal dgn pesan jelas — perilaku aman, bisa ditingkatkan jadi 400 di request-time).

## 6. Superadmin — ⚠️ PASS dgn 2 HIGH

Yang BENAR ✅:

- `GET /api/sa/tenants/:id/numbers` (slot + status per-slot + `maxNumbers` efektif + `used`) ✅.
- `POST …/numbers`: cek `used >= maxNumbers → 403` dgn pesan jelas ✅ **K4**; `effectiveMaxNumbers` null→1, clamp ≤3 ✅; audit log `number_upsert`/`number_delete`/`wa_mode` ✅; auto-connect slot baru best-effort ✅.
- `PUT …/wa-mode` (pool|assigned|mix) ✅; plan editor `maxNumbers` kosong→null(=1), clamp 0..3 ✅; frontend SuperAdmin.vue: pill per-slot di kartu tenant, modal "Nomor WA", field plan "Maks. Nomor WA (kosong = 1, max 3)", reuse polling 15s v3.8 ✅.
- Plan JSON + usage modal menyertakan `numbers`/`maxNumbers` ✅.

### 🟠 BUG-10 (HIGH) — off-by-one cap slot: `POST …/numbers` menerima slot=3

`!Number.isFinite(slot) || slot < 0 || slot > SA_MAX_NUMBERS_HARD_CAP` dengan `SA_MAX_NUMBERS_HARD_CAP = 3` → `slot=3` **lolos validasi** (spec §1 + frontend: slot 0..2, maks 3 nomor). Baris `TenantNumber slot=3` dibuat; `connectTenant` menolak slot>2 ("Slot 3 tidak valid") yang ditangkap non-fatal → **slot yatim tak bisa connect, tetap menghitung kuota (K4!)**. Fix: `slot < 0 || slot > 2` (atau `>= HARD_CAP` dgn semantik jumlah=3).

### 🟠 BUG-11 (HIGH, follow-on) — DELETE slot men-delete baris DB walau logout slot GAGAL

Karena BUG-3, `wa.logoutTenant(id, slot)` di `DELETE …/numbers/:slot` (superadmin.js l.590-596) selalu throw → tertangkap "non-fatal" → `prisma.tenantNumber.delete` tetap jalan. Hasil: socket slot masih hidup tak terlacak + sesi dir tak terhapus + `Chat.numberSlot` menggantung (reply chat lama ke slot itu → error "Nomor pengirim (slot N) tidak terhubung" — pesan jelas, tapi socket nyatanya masih connect → inkonsisten). Memperbaiki BUG-3 menyelesaikan akar masalah; tambahan: pertimbangkan tolak DELETE bila logout gagal (409), dan/atau guard "masih ada chat dengan numberSlot=slot" (info, bukan blocker spec).

Catatan: GET `used` menghitung `slots.length` (termasuk slot-0 **sintetis** — 1 walau belum ada baris), sedangkan POST menghitung `prisma.tenantNumber.count` (0 utk tenant baru) → inkonsistensi tampilan kecil (LOW). Rekomendasi hitung dua-duanya dari DB count, atau definisikan "+1 implisit" secara eksplisit.

## 7. Zero-change regression — ❌ FAIL (ter-blokir BUG-1)

- Sesi dir slot-0 **tidak dimigrasi** ✅ (DB: #4/#8 `waSessionDir` tetap `data/wa-session/tenant-<id>`).
- `waMode=pool` default; `resolveRouteForSlot` pool → selalu 'pool' ✅; born-assigned tidak pernah aktif ✅.
- Semua sender default `numberSlot NULL → 0` ✅; UI blast/autoreply tanpa perubahan paksa ✅.
- **NAMUN**: AutoReply & Menu Gateway kedua tenant lama **rusak parah** via BUG-1 (findUnique legacy), dan Menu Gateway page via BUG-7 (frontend). Antrean/CSAT/scheduler aman. → Checklist ini **FAIL** sampai BUG-1 & BUG-7 diperbaiki.

## 8. Interaksi v3.8 — ✅ PASS

- Global write-guard (`server.js` l.74-119, `requireActiveSubscription` setelah `resolveTenant`, whitelist GET/export) berjalan **sebelum** semua router tenant — POST blast (multi-slot), PUT numbers/mode, dst. ikut ter-guard otomatis ✅ ("blast multi-slot ke-guard expired" ✅).
- Low-level `assertCanSendTenant` (pool.js l.683-704) ada di dalam `sendMessageForTenant/sendMediaForTenant` per-slot → scheduler/CSAT/auto-reply/gateway/blast semua terblokir utk tenant expired ✅; fail-open hanya utk error DB non-readonly ✅.
- `requireTenant` l.83+: `super_admin` impersonate bebas (tenant dari query/header) dan write-guard mengizinkan role super_admin (auth.js l.52) ✅.

## 9. Edge cases — ringkasan

| Case spec | Hasil |
|---|---|
| Reply ke chat lama `numberSlot=NULL` | ✅ default slot-0 (`\|\| 0` di SEMUA sender) |
| DELETE slot yang masih punya `Chat.numberSlot` | ⚠️ chat menggantung → reply gagal dgn pesan jelas (by design) — **tapi** sesi/socket slot bocor karena BUG-3 (BUG-11) |
| Blast rotate, slot disconnect di tengah jalan | ✅ skip + warning, bukan crash; semua mati → error jelas per pesan |
| Semantik `routeMode` per-slot HANYA di mode mix | ✅ `resolveRouteForSlot` — mode pool abaikan routeMode; assigned = assigned utk semua slot; mix → per-slot |
| `maxNumbers` NULL → 1; >3 → clamp 3 | ✅ `effectiveMaxNumbers` + PUT plan clamp; ⚠️ cap-validasi POST slot=3 lolos (BUG-10) |
| Broadcast/push per slot di assigned → agent yang benar | ✅ `push.sendToUser(targetAgentId, …)` + `broadcast.emitToTenant` dgn `bornAssigned:true` + numberSlot |
| Tenant admin menaikkan slot sendiri | ⚠️/❌ `PUT /api/wa/numbers/:slot` **upsert** row untuk SEMUA slot 0..2 **tanpa cek kuota plan.maxNumbers** → tenant admin bisa bikin baris slot 1/2 (yang dihitung kuota!) lalu connect — **bypass K4**. Dan AdminWhatsApp.vue memanggil `POST /api/wa/numbers` + `DELETE /api/wa/numbers/:slot` yang **TIDAK ADA** (404) — lihat BUG-12 |

### 🔴 BUG-12 (CRITICAL) — manajemen slot sisi tenant admin: endpoint hilang + bypass kuota

`frontend/src/views/AdminWhatsApp.vue` (tombol "+ Tambah Nomor" / "Hapus") memanggil:
- `POST /api/wa/numbers` — **tidak ada di `src/routes/wa.js`** (hanya `PUT /numbers/:slot` & `PUT /mode`). → 404 selalu.
- `DELETE /api/wa/numbers/:slot` — **tidak ada** (DELETE hanya di SA `/api/sa/tenants/:id/numbers/:slot`). → 404 selalu.

Dan `PUT /api/wa/numbers/:slot` (wa.js l.159-…) melakukan **upsert** — admin tenant bisa MENAMBAH baris slot 1/2 sendiri **tanpa cek `plan.maxNumbers`** (kuota dihitung dari baris yang ADA per K4 → self-service melampaui kuota; connectTenant hanya mensyaratkan baris ada). Dua solusi (pilih satu, keduanya sesuai spec §5 "superadmin kelola"):
1. Hapus tombol tambah/hapus di AdminWhatsApp.vue (slot-management hanya via Superadmin) — PUT tenant dibatasi `update`-only pada baris yang sudah ada (tolak create saat row tidak ada), atau
2. Implement POST/DELETE tenant-side **dengan cek kuota** yang sama seperti SA (403 bila penuh).

---

## Daftar Bug (rangkuman)

| ID | Severity | Lokasi | Ringkasan |
|---|---|---|---|
| BUG-1 | 🔴 CRITICAL | schema + `autoReply.js:43,47` · `menuGateway.js:41,52,235` · `tenantSeed.js:36,74` · routes `autoreply.js:151-191` · `menuGateway.js:258,322-352` | Kunci unik `(tenantId, numberSlot)` memecah semua `findUnique/update/upsert({where:{tenantId}})` lama — auto-reply/menu-gateway/seed/PUT-GET admin 500 untuk semua tenant (termasuk 1-nomor) |
| BUG-2 | 🔴 CRITICAL | `pool.js:528,557,909` | `pool.get(tid)` (number) tak pernah cocok dgn key string `"<tid>:<slot>"` → disconnect no-op total; inline LID-resolve mati total (regresi v3.5) |
| BUG-3 | 🔴 CRITICAL | `pool.js:557-613` | `logoutTenant` merujuk `s` yang tidak ada → ReferenceError tiap panggil; sesi tak terhapus; SA delete slot → socket hantu |
| BUG-7 | 🔴 CRITICAL | `frontend/src/views/AdminMenuGateway.vue:212-214,394` | `waSlots`/`applySlot` tidak dideklarasikan → halaman Menu Gateway crash |
| BUG-12 | 🔴 CRITICAL | `routes/wa.js` (endpoint hilang) + `AdminWhatsApp.vue` + PUT upsert tanpa kuota | Tambah/hapus slot tenant → 404; PUT bisa menambah slot tanpa cek maxNumbers (bypass K4) |
| BUG-10 | 🟠 HIGH | `routes/superadmin.js:~505-509` | Cap `slot > 3` membiarkan slot=3 → baris yatim tak bisa connect, tetap makan kuota |
| BUG-4 | 🟠 HIGH | `pool.js:1246` | LID resolve pakai socket slot-0 utk pesan slot 1/2 |
| BUG-5 | 🟠 HIGH | `pool.js:617+` | reconnect tak membersihkan state lama (slot di-drop oleh disconnect) |
| BUG-11 | 🟠 HIGH | `routes/superadmin.js:~590-596` | DELETE slot tetap menghapus baris walau logout slot gagal |
| BUG-13 | 🟠 HIGH | `routes/wa.js:159-199` | (tergabung BUG-12) PUT `/numbers/:slot` upsert create tanpa validasi slot terhadap hard cap 2/kuota |
| BUG-9 | 🟡 MEDIUM | `services/blast.js` runBlast | Round-robin off-by-one — pesan pertama mulai di slot ke-2 |
| BUG-6 | 🟡 MEDIUM | `routes/chats.js:~860-900` | Alasan kegagalan per-slot tidak dikembalikan ke UI CS |
| BUG-8 | 🟡 MEDIUM | `AdminAutoReply.vue`/`AdminMenuGateway.vue` | Edit per-slot tanpa memuat config slot tsb (menimpa dari nilai shared) |
| BUG-14 | 🟡 MEDIUM | `routes/superadmin.js` GET numbers | `used` hitung sintetis (1) vs POST hitung DB (0) — inkonsisten |
| WARN-1 | 🟢 LOW | `schema.prisma` | Composite unique + SQLite NULL → baris shared (NULL) bisa duplikat pada race create |
| WARN-2 | 🟢 LOW | spec §1 | Inkonsistensi spec maxNumbers Tenant vs TenantPlan (impl sudah benar: TenantPlan) |
| WARN-3 | 🟢 LOW | `chats.js:~845` | `err._replySlotFailed` diset pada objek yang dibuang (dead code) |

## Rekomendasi perbaikan (urutan)

1. **BUG-1** — migrasi semua lookup unik legacy dua model ke `tenantId_numberSlot` (shared = `numberSlot: null`):
   ```js
   // autoReply.getConfig / menuGateway.getConfig / tenantSeed / routes:
   where: { tenantId_numberSlot: { tenantId: tid, numberSlot: null } }
   // atau findFirst({ where: { tenantId: tid, numberSlot: null } })
   ```
   Termasuk `menuGateway.js:322/324/342` (`whereKey` branch shared) dan `autoreply.js` seluruh blok upsert (ganti dgn upsert by compound key).
2. **BUG-2/3/4/5/11** — rantai satu perbaikan di pool.js:
   ```js
   async function disconnectTenant(tenantId, slot = 0) {
     const tid = Number(tenantId); const s = Number(slot) || 0
     const st = pool.get(slotKey(tid, s)); …
   }
   async function logoutTenant(tenantId, slot = 0) { /* const s = …; pool.get(slotKey) */ }
   // l.1246: maybeResolveLidChat(tid, chat, getSocketForTenant(tid, inboxSlot))
   // l.909:  const st = pool.get(slotKey(tid, chat.numberSlot || 0))
   ```
3. **BUG-7** — AdminMenuGateway.vue tambahkan `const waSlots = ref([])`, `const applySlot = ref('all')`, fetch `/api/wa/status` di fetchConfig (salin pola AdminAutoReply.vue).
4. **BUG-12** — pilih: (a) hilangkan add/remove slot dari AdminWhatsApp.vue & jadikan PUT numbers update-only; atau (b) tambahkan POST/DELETE tenant-side **dengan cek kuota** plan.maxNumbers (403). Pastikan juga PUT menolak create slot tanpa cek.
5. **BUG-10** — `slot > 2` (bukan `> SA_MAX_NUMBERS_HARD_CAP`).
6. **BUG-9** — hapus `nextSlot()` init di runBlast (atau reset `sinceRotate` setelahnya) supaya urutan mulai dari `activeSlots[0]`.
7. **BUG-6** — kirim `waError: err.message` pada response/socket saat send gagal.
8. **BUG-8** — `GET ?slot=` saat dropdown ≠ "Semua nomor".
9. Opsional: konsistensi `used` di GET numbers; docs spec §1 dirapikan.

## Catatan positif (implement yang bagus)

- Desain slotKey/per-slot state dan HARD RULE "slot-0 = dir lama, JANGAN migrasi" dipegang teguh — terbukti di kode DAN di DB (#4/#8).
- Born-assigned meniru pola PIC grup dengan rapi (presence check, nonaktif-guard, ChatEvent, push ke agent yang benar, `bornAssigned` di broadcast).
- No-fallback (K3) konsisten di 7 call-site sender; pesan error per-slot informatif.
- v3.8 guard (write-guard global + low-level `assertCanSendTenant`) tersususun rapi di dalam jalur per-slot tanpa perlu diubah.
- Blast: skip+warn saat slot mati mid-run (bukan crash), `senderSlot` tercatat di log — sesuai checklist.
- Frontend zero-change (tenant 1-nomor): blast picker hilang (`waSlots.length > 1`), pill multi-nomor SuperAdmin hanya tampil bila >1 slot.

---

**Verdict akhir: NO-GO.** Lima bug CRITICAL (BUG-1, BUG-2, BUG-3, BUG-7, BUG-12) masing-masing mematikan fitur yang sudah live atau fitur baru di inti; BUG-1 sendirian melanggar HARD RULE §0 untuk tenant produksi. Setelah 1–4 dari urutan rekomendasi di atas diimplementasikan, audit ulang cepat pada jalur: (a) GET/PUT autoreply & menu-gateway shared, (b) logout/reconnect slot 0 dan slot 1, (c) SA delete slot, (d) SA add slot ke tenant penuh kuota (403), (e) render AdminMenuGateway.vue.
