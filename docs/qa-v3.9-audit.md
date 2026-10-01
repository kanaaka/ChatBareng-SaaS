# QA Audit v3.9 — Multi-Nomor WA per Tenant

> **Commit yang di-audit:** `cb356fc` (v3.9 — 18 file, +1342/−462). Baseline: `810dd24` (v3.8).
> **Reviewer:** Independent QA (subagent) — REVIEW KODE, READ-ONLY (tidak ada file yang diubah; DB hanya SELECT read-only; server 5047 tidak disentuh).
> **Tanggal audit:** 2026-09-23 19:50–20:10 WIB.
> **Sumber kebenaran:** `docs/spec-v3.9-multi-wa.md` (LOCKED owner 18:24) + 5 keputusan owner K1–K5.

---

## Verdict: 🔴 NO-GO

3 bug CRITICAL (2 crash runtime + 1 frontend-backend mismatch) dan 2 bug HIGH. Fitur autoreply & menu gateway **mati di runtime** (Prisma validation error pada `findUnique({tenantId})` — unique sudah jadi composite). Logout/reconnect WA **500 di semua slot**. Tombol tambah/hapus nomor di Admin WA **404**. Fitur routing assigned/mix **tidak dapat dikonfigurasi dari UI**.

---

## 1. Checklist per-Verifikasi

### 1.1 Schema (prisma/schema.prisma) — ✅ PASS

| Item | Bukti | Status |
|---|---|---|
| `TenantNumber` (slot 0–2, label, waSessionDir, routeMode, assignedAgentId, reassignOffline) | schema.prisma L697–713, `@@unique([tenantId, slot])`, `onDelete: Cascade` ke Tenant | PASS |
| `Tenant.waMode` default `pool` | schema.prisma L37 (`waMode String @default("pool")`) | PASS |
| `TenantPlan.maxNumbers Int?` (null=1) | schema.prisma `maxNumbers Int?` + komentar | PASS |
| `MenuGatewayConfig.numberSlot` / `AutoReplyConfig.numberSlot` (null=link-all) | `@@unique([tenantId, numberSlot])` keduanya | PASS |
| `Blast.numberSlots` / `rotateEvery` | schema.prisma (String? JSON + Int?) | PASS |
| `Chat.numberSlot` | schema.prisma + index `@@index([tenantId, numberSlot])` | PASS |
| `BlastLog.senderSlot` | schema.prisma | PASS |
| **ADDITIVE** — kolom lama tidak berubah/dihapus | git diff 810dd24..cb356fc: hanya komentar & 2 baris `tenantId @unique` di AutoReply/MenuGateway (diganti composite — itu memang target spec) | PASS |
| DB sudah ter-push & sinkron | `TenantNumber`, `waMode`, `numberSlot` ada di `prisma/data/saas-v3.db`; generated client schema = schema.prisma (diff = whitespace only) | PASS |

⚠️ Catatan: mengubah `@@unique` AutoReplyConfig/MenuGatewayConfig dari `tenantId` → composite **adalah perubahan perilaku Prisma** (bukan murni additive di level API client) — memicu bug HIGH #4 di bawah. Kolom DB tetap additive, tapi kode pemanggil lama tidak ikut di-update.

### 1.2 pool.js — ⚠️ PASS dengan 2 CRITICAL

| Item | Bukti | Status |
|---|---|---|
| pool key `tenantId:slot` | `slotKey()` L52, `tenantState()` L71 | PASS |
| slot-0 = dir sesi lama `tenant-<id>` (TIDAK migrasi) | `defaultSessionDir()` L52–56 + `connectTenant` slot-0 pakai `tenant.waSessionDir`; tidak ada kode pemindahan file | PASS |
| API existing default slot-0 | semua helper lama `slot = 0` default; `opts.slot` additive | PASS |
| QR/pairing/logout per slot | routes/wa.js `?slot=` di qr/reconnect/logout/pairing-code; `slotFrom()` validasi 0..MAX_SLOT | PASS ( tapi logout → CRITICAL #1) |
| inbound routing set `Chat.numberSlot` | pool.js L1179–1182 (set saat `chat.numberSlot !== inboxSlot`); create baru L1155 | PASS |
| born-assigned (pola PIC grup) | pool.js L1192–1240: `route==='assigned' && assignedToId==null` → assign + `queuedAt:null` + chatEvent + broadcast + push. Referensi groups.js L700+ konsisten | PASS |
| mix per-slot | `resolveRouteForSlot()` L187–205: pool→selalu pool; assigned→assigned; mix→`row.routeMode` | PASS |
| fail-open DB error → 'pool' | L199–201 catch → return 'pool' (aman) | PASS |

### 1.3 Reply path — ✅ PASS (K3 terpenuhi, dengan catatan UX)

| Item | Bukti | Status |
|---|---|---|
| keluar via `chat.numberSlot` | chats.js L850 (`replySlot = Number(chat.numberSlot) || 0`), L985 media | PASS |
| TIDAK ada fallback slot lain | grep seluruh reply path — tidak ada pemilihan slot alternatif; error langsung | PASS |
| pesan error jelas | `slotNotConnectedMessage()` pool.js: "Nomor pengirim (slot N) tidak terhubung — balas via nomor yang menerima…" | PASS |
| scheduler & autoreply & CSAT & blast & menuGateway per-slot | v0100Scheduler.js L146, autoReply.js L323, csat.js L182, blast.js L225/228, menuGateway.js L180 — semua `{slot: Number(chat.numberSlot)||0}` | PASS |
| CS bisa baca pesan error? | **WARN**: chats.js menandai `err._replySlotFailed = true` (L853) tapi flag **tidak pernah dipakai** — pesan tersimpan `status:'failed'` pola lama; pesan deskriptif per-slot hanya di console log. Untuk slot-0, CS masih melihat "WhatsApp belum terhubung" generik (bukan pesan spesifik slot). Owner 18:24 #3 minta "pesan jelas ke CS" — sebagian terpenuhi (media path & log), kurang untuk text reply. | WARN |

### 1.4 Autoreply & gateway per-nomor — ⚠️ PASS-WARN (dengan 1 HIGH runtime crash)

| Item | Bukti | Status |
|---|---|---|
| resolve config slot → fallback shared | `getConfigForSlot()` autoReply.js L59–73 & menuGateway.js L67–82: `findFirst(OR: [{numberSlot: s},{numberSlot: null}]) orderBy numberSlot desc` → slot menang | PASS |
| default link-all | row `numberSlot null` = shared; runtime fallback ke shared | PASS |
| runtime resolve per-slot | maybeAutoReply L394, menuGateway startFlow L230 & handleChoice L382 pakai `chat.numberSlot` | PASS |
| UI dropdown "Terapkan ke" | AdminAutoReply.vue L107–115 + save body `numberSlot` L215; AdminMenuGateway.vue L212–218 + payload L394 | PASS |
| **BUG** | `getConfig()` & routes masih `findUnique({where:{tenantId}})` — **PrismaClientValidationError terkonfirmasi runtime** (lihat BUG-4) → `GET/PUT /api/autoreply` = 500, `GET /api/menu-gateway` = 500 (autoCfg L258), greeting menu dead | **FAIL** |

### 1.5 Blast — ✅ PASS dengan 1 HIGH

| Item | Bukti | Status |
|---|---|---|
| multi-select slot | routes/blast.js L356–358 validasi 0..2 + dedup + sort; BlastComposer.vue L223–244 | PASS |
| rotateEvery round-robin antar slot terpilih & connected | blast.js L86–127: `activeSlots` filter connected; `nextSlot()` re-check saat pindah giliran | PASS |
| slot mati di-skip + warning | L96 broadcast `blast_warning` + L116 progress warning; console.warn | PASS |
| BlastLog.senderSlot | L234 (sent) & L243 (failed) | PASS (tapi L243 = CRASH, lihat BUG) |
| no-fallback per-pesan | send gagal → BlastLog `failed` dgn error; TIDAK pindah slot | PASS |

### 1.6 Superadmin — ✅ PASS

| Item | Bukti | Status |
|---|---|---|
| GET/POST/DELETE `/api/sa/tenants/:id/numbers` | superadmin.js L488, L505, L583 | PASS |
| cap `plan.maxNumbers` → 403 | `effectiveMaxNumbers()` L481–485 + guard L527–533 (403 dgn pesan + used/maxNumbers) | PASS |
| slot-0 tidak bisa dihapus | L587: `if (slot === 0) → 400` | PASS |
| maxNumbers NULL=1, >3 clamp 3 | L729–741 (`capped = Math.min(trunc(n),3)` + warn) | PASS |
| modal "Nomor WA" + plan field "Maks. Nomor WA" | SuperAdmin.vue L264–300 + L354 (0–3, kosong=1) | PASS |
| polling per-slot status | `waSlotsFor()` L83 + polling 15s v3.8 (L586) tampilkan `n/m nomor · waMode` | PASS |

### 1.7 Zero-change regression (tenant 1 nomor) — ✅ PASS (verifikasi kode + DB)

- Parahita #4 & Mazaya #8: baris `TenantNumber` slot-0 = dir lama `.../tenant-4` / `.../tenant-8` (DB snapshot read-only), `waMode='pool'`, config shared `numberSlot=null`.
- Session dir **tidak dimigrasi**: `connectTenant(slot-0)` tetap `tenant.waSessionDir`; tidak ada kode yang memindahkan file sesi.
- `waMode` default `pool` → `resolveRouteForSlot()` selalu `'pool'` → alur antrean/CSAT/greeting identik; `opts.slot` selamanya `0`.
- Tenant tanpa baris TenantNumber → `listTenantNumbers()` sintetis slot-0 (zero backfill needed).
- Auto-queue/take-next/queueWhere tidak berubah (tidak ada sentuhan numberSlot di jalur antrean pool mode).

### 1.8 Interaksi fitur v3.8 — ✅ PASS

- `assertCanSendTenant()` dipanggil di `sendMessageForTenant`/`sendMediaForTenant` SEBELUM cek socket → expired tenant tidak bisa kirim apa pun (termasuk blast per-pesan → BlastLog failed dgn pesan "Masa aktif tenant habis").
- Guard read-only incoming & banner tidak disentuh oleh diff v3.9.
- Impersonate: guard low-level per-tenant tetap (tenant normal tetap bisa kirim; expired tetap diblokir meski impersonate — konsisten keputusan v3.8).
- Blast expired guard: per-pesan throw → log failed; blast tetap selesai (bukan hang).

### 1.9 Edge cases

| Edge case | Hasil |
|---|---|
| Reply chat pre-v3.9 (`numberSlot` NULL) | ✅ PASS — `Number(null) \|\| 0` → slot-0 (dir lama), bukan error |
| DELETE slot yang masih punya `Chat.numberSlot` | ⚠️ WARN — baris dihapus + sesi di-logout; Chat.numberSlot TIDAK dibersihkan → chat orphan; reply gagal "not connected slot itu" (error jelas, tidak crash). Tidak ada cleanup keputusan |
| Blast slot disconnect DI TENGAH blast | ⚠️ PASS-WARN — skip+warning hanya dieksekusi saat giliran pindah (rotasi); slot aktif yang mati digiliran sendiri → per-pesan gagal jelas (BlastLog failed). Bukan crash |
| routeMode hanya aktif di mode mix | ✅ PASS — `resolveRouteForSlot`: assigned→assigned (semua slot), pool→pool, mix→per-slot |
| maxNumbers NULL→1; >3→clamp | ✅ PASS (SA + PUT plan + frontend clamp) |
| Push per-slot → notif agent benar (assigned mode) | ✅ PASS — born-assigned `push.sendToUser(targetAgentId)` + push lanjutan ke `chat.assignedToId`; `previewTextForPush` hoisted (runtime OK) |

---

## 2. Daftar Bug

### 🔴 CRITICAL

**C1. `logoutTenant()` — ReferenceError + salah lookup pool → logout 500 di SEMUA slot**
- File: `src/wa/pool.js` L559–603
- Fungsi `logoutTenant(tenantId, slot)` tidak punya deklarasi `slot`/`s` di awal, tapi body memakai `s === 0`, `slot: s`, `defaultSessionDir(tid, s)` → `ReferenceError: s is not defined` (terverifikasi via eval).
- Tambahan: `const st = pool.get(tid)` — pool key kini string `"tid:slot"`; `get(tid)` numeric **selalu undefined** → logout state slot tidak pernah disentuh.
- Efek: `POST /api/wa/logout?confirm=true&slot=N` (routes/wa.js L120) dan `DELETE /api/sa/tenants/:id/numbers/:slot` (superadmin L595) → **500**; slot 1/2 tidak bisa di-logout.
- Fix 1 baris (rekomendasi, tidak dieksekusi):
```diff
 async function logoutTenant(tenantId, slot) {
   const tid = Number(tenantId)
-  const st = pool.get(tid)
+  const s = Number(slot) || 0
+  const st = pool.get(slotKey(tid, s))
```

**C2. `disconnectTenant()` tidak slot-aware + salah key pool → reconnect per-slot no-op**
- File: `src/wa/pool.js` L527–550 + `reconnectTenant` L605–610
- `disconnectTenant(tenantId)` tidak menerima `slot` dan `pool.get(tid)` (numeric key, selalu undefined). `reconnectTenant(tid, slot)` memanggil `disconnectTenant(tid)` → tidak disconnect apa pun → connect slot itu di atas socket lama.
- Efek: tombol Connect/Reconnect per-slot lemah; socket lama bisa tetap hidup saat connect ulang (risiko dobel socket per slot).
- Fix:
```diff
-async function disconnectTenant(tenantId) {
+async function disconnectTenant(tenantId, slot = 0) {
   const tid = Number(tenantId)
-  const st = pool.get(tid)
+  const s = Number(slot) || 0
+  const st = pool.get(slotKey(tid, s))
```
(dan `reconnectTenant`: `await disconnectTenant(tenantId, slot)`)

**C3. Frontend Admin WhatsApp memanggil API yang TIDAK ADA di backend**
- File: `frontend/src/views/AdminWhatsApp.vue` L265 (`POST /api/wa/numbers` untuk "+ Tambah Nomor") dan L284 (`DELETE /api/wa/numbers/:slot` untuk "Hapus Nomor")
- `src/routes/wa.js` hanya punya `PUT /numbers/:slot` (L159) dan `PUT /mode` (L202). **Tidak ada `POST /numbers` atau `DELETE /numbers/:slot`** — keduanya hanya ada di jalur superadmin (`/api/sa/tenants/:id/numbers`).
- Efek: tombol Tambah Nomor & Hapus Nomor di Admin WhatsApp tenant selalu **404 → gagal**. Fitur manajemen nomor tenant-side mati.
- Fix rekomendasi: tambahkan `router.post('/numbers')` + `router.delete('/numbers/:slot')` di `src/routes/wa.js` dengan logika yang sama seperti jalur SA (cap `plan.maxNumbers` → 403, guard slot-0, logout sesi) — atau ubah UI untuk nonaktifkan tombol tersebut dan hanya izinkan via Superadmin.

### 🟠 HIGH

**H1. `findUnique({where:{tenantId}})` pada model yang unique-nya jadi composite → PrismaClientValidationError → Autoreply & Menu Gateway MATI di runtime**
- File & call sites:
  - `src/services/autoReply.js` L43, L47 (`getConfig`), L152 (`PUT` upsert shared), L184 (menuGatewayConfig upsert di route PUT)
  - `src/services/menuGateway.js` L41, L52 (`getConfig`)
  - `src/routes/menuGateway.js` L258 (GET autoCfg)
  - `src/services/menuGateway.js` L235 (`startFlow` autoCfg)
  - `src/services/tenantSeed.js` L36 (`ar`), L74 (`mg`)
- Bukti runtime (dieksekusi terhadap DB read-only): `Invalid prisma.autoReplyConfig.findUnique() invocation ... Unknown arg tenantId` — `PrismaClientValidationError`.
- Efek: `GET/PUT /api/autoreply` = **500** (halaman Admin Auto Reply tidak bisa load/save), `GET /api/menu-gateway` = **500**, greeting mode menu = dead (startFlow crash → return false), seed tenant baru = gagal di bagian config. Ini regresi perilaku yang **menyentuh zero-change rule §0** (tenant lama yang sebelumnya bisa GET/PUT autoreply sekarang 500).
- Fix 1 baris per call site: ganti `findUnique({where:{tenantId: tid}})` → `findFirst({where:{tenantId: tid, numberSlot: null}})` (atau upsert dengan `tenantId_numberSlot: {tenantId, numberSlot: null}`).

**H2. `blast.js` — `sendSlot` di catch = ReferenceError → 1 pesan gagal membuat seluruh blast "failed"**
- File: `src/services/blast.js` L219 (`const sendSlot = ...` di dalam `try{}`) vs L243 (`senderSlot: sendSlot` di dalam `catch{}`)
- Block-scoped: catch tidak bisa melihat `sendSlot` → setiap kali send gagal (slot mati, JID hilang, expired guard) → `ReferenceError: sendSlot is not defined` → error ter-throw keluar dari catch → `runBlast` catch luar → `finishBlast(..., 'failed')` + `blast_error`.
- Efek: satu recipient gagal = status blast keseluruhan "failed" padahal sisa recipients belum dikirim.
- Fix 1 baris:
```diff
-        try {
+        let sendSlot = currentSlot
+        try {
```
(dan hapus `const` di L219 → assignment biasa)

### 🟡 MEDIUM

**M1. K1 tidak diimplement: kontak sama via nomor beda = chat TIDAK terpisah**
- Schema `@@unique([tenantId, waJid])` + `processIncomingMessage` match chat by `waJid` (pool.js L1005+): pesan dari kontak yang sama ke slot berbeda → **satu chat yang sama**, `numberSlot` di-toggle ke slot terakhir yang menerima (L1179–1181).
- Baileys 1:1 `remoteJid` = JID kontak (TIDAK memuat nomor pengirim) → chat tidak bisa terpisah secara natural tanpa komposit key.
- Spec §6.1 eksplisit: "Chat terpisah per nomor untuk kontak yang sama (JID beda per sesi; merge = risiko duplikat 'Berliana' lagi)".
- Konsekuensi praktis: balasan selalu via nomor terakhir yang menerima (K3 ✓), TAPI tidak ada pemisahan percakapan; jika kontak chat bergantian nomor, reply bisa keluar dari nomor yang tidak diharapkan kontak. **Perlu keputusan owner** (ubah schema unique → `[tenantId, waJid, numberSlot]` + migrasi display, atau revisi keputusan K1).

**M2. Tick "reassign ke CS lain kalau agent offline" TIDAK ada di UI**
- Owner 18:24 #2: tick di halaman Admin WhatsApp per-slot, default OFF. Backend lengkap (`reassignOffline` di PUT `/numbers/:slot` + SA POST + logic pool.js), tapi `AdminWhatsApp.vue` tidak merender tick → opsi tidak bisa dinyalakan dari UI.

**M3. Tidak ada UI untuk routeMode / assignedAgentId / waMode**
- `AdminWhatsApp.vue` hanya menampilkan badge assigned; tidak ada kontrol set routeMode/assignedAgentId, dan tidak ada kontrol ganti `waMode` (pool/assigned/mix) di Admin maupun Superadmin. Backend `PUT /api/wa/mode` & `PUT /api/sa/tenants/:id/wa-mode` ada tapi tak terpakai. Fitur inti v3.9 (assigned/mix) hanya bisa dipakai via curl/manual DB.

**M4. Bypass kuota via jalur tenant admin**
- `PUT /api/wa/numbers/:slot` (routes/wa.js L159) melakukan **upsert create** slot 1/2 tanpa cek `plan.maxNumbers` (cap 403 hanya di jalur SA POST). Tenant admin bisa mendaftarkan slot-0..2 melebihi kuota paket. Fix: cek `effectiveMaxNumbers` juga di sini.

**M5. DELETE slot tidak membersihkan dependensi**
- `DELETE /api/sa/tenants/:id/numbers/:slot`: tidak membersihkan `Chat.numberSlot` yang menunjuk slot itu (chat orphan) dan tidak menghapus baris `AutoReplyConfig`/`MenuGatewayConfig` per-slot (config dormant). Tidak crash; perlu keputusan cleanup (clear `numberSlot` chat → set null/re-queue, atau keep+warning).

### 🟢 LOW

- **L1** `menuGateway.startFlow` defense-check `autoCfg` pakai row shared (bukan config resolved slot) — gate greetMode bisa salah bila per-slot beda (ikut dibersihkan saat fix H1).
- **L2** `receipts.markIncomingRead` selalu slot-0 (`getSocketForTenant(tid)`) — chat dari slot 1/2 tidak dapat centang biru (silent no-op; fitur default OFF).
- **L3** `BlastLog.senderSlot` tidak ditampilkan di UI Blast history — audit nomor pengirim tidak terlihat admin.
- **L4** `POST /api/blast` tidak memvalidasi `numberSlots` terhadap slot TERDAFTAR tenant (hanya range 0..2). Aman (skip+warning saat runtime) tapi membingungkan.
- **L5** `AdminAutoReply.vue`/`AdminMenuGateway.vue` selalu load config SHARED; pindah dropdown "Terapkan ke" tidak me-load config slot existing → save menimpa config slot dengan nilai form saat itu (semantik "copy"). Perlu konfirmasi UX ke owner.
- **L6** `PUT autoreply` per-slot: `upsert({where:{tenantId}})` sebelum create per-slot = dead code + invalid (masuk H1).

---

## 3. Kepatuhan Keputusan Owner (K1–K5)

| Keputusan | Status | Bukti/Catatan |
|---|---|---|
| **K1** — chat terpisah per nomor; balas SELALU via nomor penerima (`Chat.numberSlot`) | ⚠️ PARTIAL | Reply-via-numberSlot ✓ (pool.js L1179–1181, chats.js L850/985, semua service). **Chat terpisah TIDAK diimplement** (M1) — `@@unique([tenantId, waJid])` memaksa 1 chat/kontak; slot toggle per pesan |
| **K2** — assigned + agent offline = personal queue (tick opsional default OFF) | ✅ PASS* | pool.js L1192+ : `reassignOffline` default false; agent offline + OFF → tidak assign (personal queue); ON → fallback ke CS/admin aktif. *Tick UI tidak ada (M2) |
| **K3** — slot mati saat reply = GAGAL jelas, JANGAN fallback | ✅ PASS* | Tidak ada jalur fallback di reply/media/CSAT/autoreply/gateway/scheduler/blast. Pesan error per-slot jelas di log & `slotNotConnectedMessage` utk slot>0; text-reply ke CS hanya melihat `status failed` pola lama (WARN UX) |
| **K4** — kuota = slot yang ADA (connected/tidak tetap dihitung), hard cap 3 | ✅ PASS | `effectiveMaxNumbers` + `used = COUNT(TenantNumber)` + 403 + clamp 3 di semua jalur (kecuali M4 bypass PUT tenant) |
| **K5** — autoreply & gateway link-all default; per-slot opt-in; resolve slot → fallback shared | ✅ PASS-WARN | `getConfigForSlot` + orderBy `numberSlot desc` benar; **TAPI** call-sites lama `findUnique({tenantId})` crash runtime (H1) |

---

## 4. Rekomendasi Fix (urutan prioritas)

1. **C1+C2** pool.js: deklarasi `const s = Number(slot) || 0` + `pool.get(slotKey(tid, s))` di `logoutTenant`; `disconnectTenant(tenantId, slot=0)` + panggilan di `reconnectTenant`. (2 baris × 2 fungsi)
2. **H1** ganti semua `findUnique({where:{tenantId}})` pada AutoReplyConfig/MenuGatewayConfig → `findFirst(... numberSlot: null)` atau compound `tenantId_numberSlot`. (7 call sites)
3. **C3** tambah `POST /numbers` + `DELETE /numbers/:slot` di `routes/wa.js` (cap kuota + guard slot-0 + logout sesi) atau ubah frontend ke API SA.
4. **H2** blast.js: `let sendSlot = currentSlot` sebelum `try`.
5. **M1** eskalasi ke owner: K1 (chat terpisah) butuh keputusan schema baru — jangan di-deploy sebagai "sudah sesuai spec".
6. **M2/M3** lengkapi UI (tick reassign + editor routeMode/agent + selector waMode).
7. **M4** cap kuota di PUT tenant `/numbers/:slot`.

---

## 5. Metode & Batas Audit

- Review kode statis commit `cb356fc` vs baseline `810dd24` (git diff per file), grep seluruh call-sites send-path, verifikasi schema vs generated Prisma client (identik), dan DB snapshot read-only (`sqlite3` mode=ro — SELECT only, tidak ada write).
- Verifikasi runtime Prisma validation dilakukan dengan PrismaClient **read-only query** pada `AutoReplyConfig.findUnique({tenantId})` (gagal validasi SEBELUM menyentuh DB) — tidak ada perubahan data, tidak ada restart server.
- Tidak menjalankan `prisma db push`, tidak menyentuh 5047/fisio 8770/portable/5030, tidak ada commit.
- Tidak diuji runtime end-to-end (kirim pesan WA nyata) — sesuai batas task.