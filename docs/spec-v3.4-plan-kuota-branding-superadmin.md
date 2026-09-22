# Spec v3.4 — Plan & Kuota + Fitur Toggle + Branding + Superadmin (backup tenant, audit, impersonasi UI)

> Owner request: Kanaka 2026-09-22 15:07 & 15:25 (approved dengan penyesuaian angka).
> Basis: v3.3 (commit e95147a). Port 5047, DB `prisma/data/saas-v3.db` (ABSOLUTE path di .env), NODE_ENV=development, WA_DISABLED=0 (2 tenant live: Parahita #4, Mazaya #8 — JANGAN ganggu koneksi WA lebih dari 1x restart di akhir).
> Backup pra-kerja udah diambil Alita: `backup/pre-v3.4-20260922-1530/saas-v3.db`.

## ⛔ HARD CONSTRAINTS (baca dulu, gak boleh dilanggar)

1. **JANGAN sentuh port 5030 (hub non-SaaS, PID 40348) dan 5046 (SaaS v2)** — jangan kill, jangan edit file repo mereka.
2. **DB: `npx prisma db push` HANYA additive** (model baru TenantPlan + SaAuditLog, kolom baru di Tenant). **DILARANG KERAS: `--accept-data-loss`, `--force-reset`, DROP TABLE, menghapus file `.db` apa pun.** Kalau db push melaporkan possible data loss / destructive → STOP & laporkan, jangan lanjut.
3. **Restart app 5047: kill BY PID saja** (`ss -tlnp | grep :5047` → PID → `kill <PID>`), lalu start ulang `nohup node src/server.js > /tmp/saas_v3_app.log 2>&1 &` dari dir repo. **JANGAN `pkill node` / `pkill -f server`** (bunuh sibling). Maksimal 1x restart di akhir. Verify: tepat 1 listener di 5047.
4. **NO git commit** — Alita review dulu, commit kemudian.
5. Token auth di curl JANGAN di-inline (sanitizer memotong `Bearer ...`). Simpan token ke file `/tmp/*.txt` lalu `curl -H "Authorization: Bearer $(cat /tmp/t.txt)"`.
6. Test pakai tenant BARU (misal "QA Lite") — JANGAN ubah plan/branding/data tenant Parahita #4 & Mazaya #8 secara permanen. Tenant QA boleh dibersihkan dengan purge di akhir (atau dibiarkan untuk review Alita — tulis di laporan).
7. Frontend: sebelum `npm run build`, snapshot `cp -r public public-pre-build-<ts>` (konvensi lama).

## 1. Preset plan (LOCKED, angka final Kanaka 15:25)

| | Lite | Pro | Max |
|---|---|---|---|
| `maxAgents` (semua user tenant) | 3 | 10 | 50 |
| `tkQuotaBytes` (Tangan Kanan) | 2 GB | 5 GB | 10 GB |
| `maxContacts` | 5.000 | 10.000 | 50.000 |
| `featAnalytics` | ✗ | ✓ | ✓ |
| `featBlast` (blast + pengumuman) | ✗ | ✓ | ✓ |
| `featMenuGateway` | ✗ | ✓ | ✓ |
| `featHistoryExport` (export/import riwayat + import Cekat) | ✗ | ✓ | ✓ |
| `featCsat` | ✗ | ✓ | ✓ |
| `featGdriveBackup` | ✗ | ✗ | ✓ |
| Base selalu ON (chat, auto-reply, template, TK, grup, scheduled, push, guidebook) | ✓ | ✓ | ✓ |

Custom: nilai `null` = unlimited; toggle per-fitur bebas. Preset hanya template — setelah apply, semua nilai bisa dioverride individual (field `preset` jadi `"custom"` kalau ada override yang menyimpang dari definisi preset, selain itu menyimpan nama preset terakhir yang di-apply: `"lite"|"pro"|"max"|"custom"`).

## 2. Schema (additive)

```prisma
// Tenant: tambah kolom
brandName String?   // "Mazaya Chat" — kosong = tampil "ChatBareng"
logoPath   String?   // path file logo di disk

model TenantPlan {
  id               Int      @id @default(autoincrement())
  tenantId         Int      @unique
  tenant           Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  preset           String   @default("custom") // lite | pro | max | custom (informational)
  maxAgents        Int?     // null = unlimited
  maxContacts      Int?
  tkQuotaBytes     Int?
  featAnalytics    Boolean  @default(false)
  featBlast        Boolean  @default(false)
  featMenuGateway  Boolean  @default(false)
  featHistoryExport Boolean @default(false)
  featCsat         Boolean  @default(false)
  featGdriveBackup Boolean  @default(false)
  updatedAt        DateTime @updatedAt
  updatedBy        Int?     // plain Int, TANPA FK (hindari urutan purge)
  @@index([tenantId])
}

model SaAuditLog {
  id          Int      @id @default(autoincrement())
  actorId     Int?     // plain, tanpa FK
  actorUsername String
  action      String   // tenant_create | tenant_update | tenant_delete | tenant_purge | plan_update | branding_update | backup_download | impersonate | admin_create
  tenantId    Int?     // plain, tanpa FK — row tetap hidup walau tenant di-purge
  tenantName  String?  // snapshot nama saat aksi
  detailJson  String?  // JSON ringkas (payload/hasil)
  createdAt   DateTime @default(now())
  @@index([tenantId], map: "SaAuditLog_tenantId_idx") // pastikan nama map unik
  @@index([createdAt])
}
```

Catatan mapping purge: `TenantPlan` **WAJIB** ikut terhapus saat purge — onDelete Cascade menangani otomatis (JANGAN tambah op manual kecuali perlu). Tambahkan `tenant.logoPath` ke daftar file yang dihapus dari disk di route purge (branding logo). SaAuditLog TIDAK dihapus saat purge (audit trail permanen).

## 3. Backend — services & presets

**`src/services/plans.js`** (baru):
- `PRESETS = { lite, pro, max }` — angka persis tabel di atas (`tkQuotaBytes` dalam byte).
- `applyPreset(name)` → object field TenantPlan.
- `ensureTenantPlan(tenantId)` — create plan bila belum ada. **Default untuk tenant yang SUDAH ADA (boot / existing) = preset `max`** (safe: fitur yang sebelumnya kebuka tetap kebuka, kuota longgar). Boot: setelah seeding super_admin, loop tenant tanpa plan → ensureTenantPlan dengan max. Log: `[Plan] Tenant #<id> <name> seeded plan=max (existing)`.
- `getPlan(tenantId)` + cache in-memory 30 detik, `invalidatePlanCache(tenantId)` dipanggil saat plan update.
- `requireFeature(featureKey)` — express middleware: ambil plan tenant dari `req.tenantId`; jika tenant tidak ketemu (super_admin tanpa `?tenant=`) → allow; jika plan ada & fitur OFF → **403** `{ error: "<Fitur> tidak tersedia di paket Anda. Hubungi admin platform untuk upgrade." }`. Jika plan belum ada (race) → allow + log warn.
- `checkAgentQuota(tenantId)` → `{ ok, count, max }`; `checkContactQuota`, `checkTkQuota(tenantId, incomingBytes)` → SUM `SharedFile.size` tenant + incoming.

**Pesan error kuota WAJIB ramah + upsell**, contoh:
- Agent: `Kuota agen penuh (3/3). Hubungi admin platform untuk upgrade ke paket Pro/Max.`
- Kontak: `Kuota kontak penuh (10.000/10.000). ...`
- TK: `Kuota penyimpanan Tangan Kanan penuh (4,9/5 GB). Hapus file lama atau upgrade paket.`

## 4. Backend — enforcement wiring

- `users.js` POST create (admin/cs/relay) → `checkAgentQuota` → 403 friendly bila lewat.
- `contacts.js` POST manual create → `checkContactQuota` → 403 friendly.
- Import paths (`history.js` import, `cekatImport.js`) → hitung kontak yang akan dibuat vs sisa kuota → 403 friendly (SEBELUM commit, bukan setengah jalan).
- **Auto-create kontak dari `processIncomingMessage` (WA masuk):** kalau kuota penuh → SKIP pembuatan Contact secara diam (chat & pesan tetap diproses normal, jangan blokir pesan masuk). Log sekali per tenant per jam biar gak spam.
- `tanganKanan.js` upload file → `checkTkQuota(tenantId, fileSize)` → 403 friendly. (Scope sengaja: hanya Tangan Kanan sesuai request owner; media chat & blast TIDAK ikut kuota ini — catat di CHANGELOG.)
- Feature middleware di route files: `analytics.js` (featAnalytics), `blast.js` + `announcements.js` (featBlast), `menuGateway.js` (featMenuGateway), `history.js` export+import (featHistoryExport), `cekatImport.js` (featHistoryExport), `csat.js` (featCsat), `gdrive.js` (featGdriveBackup).
- Impersonasi (token role=admin + tenantId) otomatis kena plan tenant tersebut — konsisten, bagus untuk QA.

## 5. Backend — Superadmin API (`src/routes/superadmin.js`)

- **POST /api/sa/tenants**: terima `preset` (default `"lite"`) → setelah seedTenantDefaults, `ensureTenantPlan` dengan preset itu. Audit `tenant_create`.
- **GET /api/sa/tenants/:id/plan** → plan + usage: `{ plan, usage: { agents, maxAgents, contacts, maxContacts, tkBytes, tkQuotaBytes } }`.
- **PUT /api/sa/tenants/:id/plan** body: `{ preset? , maxAgents?, maxContacts?, tkQuotaBytes?, featAnalytics?, ... }` — kalau `preset` ada → apply preset dulu, lalu field eksplisit menimpa. Field `preset` di-DB disimpan sesuai hasil (nama preset bila persis sama dgn definisinya, `"custom"` bila menyimpang). `null` = unlimited. Invalidate cache. Audit `plan_update`.
- **PUT /api/sa/tenants/:id/branding** body JSON `{ brandName? }` ATAU multipart `logo` (max 1 MB, mime whitelist: png/jpeg/webp — NO svg). Logo disimpan `data/branding/tenant-<id>/logo-<ts>.<ext>`, hapus file lama, update `Tenant.logoPath`. `brandName` string 2-50 char, boleh `""` untuk reset. Audit `branding_update`.
- **GET /api/sa/tenants/:id/backup** → buat arsip tar.gz SATU tenant untuk DR (lihat §7), kirim sebagai download, hapus temp file setelah kirim. Audit `backup_download` (detail: nama file + ukuran + jumlah row per tabel di detailJson).
- **GET /api/sa/audit** → list SaAuditLog, query `?tenantId=&action=&limit=200&before=` (cursor sederhana), urut terbaru. SaAuh only.
- Semua aksi SA yang sudah ada (create/update/delete/purge/impersonate/admin create) ditambah audit log juga (retroaktif ringan — tambahkan di handler yang ada).
- **Impersonate sudah ada backend-nya** (POST /api/sa/impersonate/:tenantId) — pastikan frontend ada tombolnya; tambah audit `impersonate`.

## 6. Backend — branding & plan untuk user tenant

- **GET /auth/me** diperluas: tambah `branding: { brandName, logoUrl }` (logoUrl = `/api/branding/logo` bila logoPath ada, else null) dan `plan: { features: { analytics, blast, menuGateway, historyExport, csat, gdriveBackup }, maxAgents, maxContacts, tkQuotaBytes, usage: { agents, contacts, tkBytes } }`. (usage: count users tenant, count contacts, SUM SharedFile.size — murah di SQLite.)
- **GET /api/branding/logo** — auth flexible (pattern `requireAuthFlexible` dari tanganKanan.js: Bearer header ATAU `?token=`), serve file logo tenant SENDIRI (req.user.tenantId), `Content-Type` sesuai mime, cache no-store. Super_admin tanpa tenant → 404.
- Frontend memakai ini untuk header: **`brandName` + suffix "by ChatBareng"** (suffix = teks kecil muted, HARDCODED frontend, tidak disimpan DB). brandName kosong → tampil "ChatBareng" polos. `document.title = brandName ? "${brandName} — by ChatBareng" : "ChatBareng"`. **Halaman Login TETAP branding ChatBareng** (belum ada context tenant sebelum login — keputusan owner).

## 7. Backup tenant (superadmin, on-demand)

- Implementasi di service baru `src/services/tenantBackup.js` + route §5. Format: **tar.gz** (child_process `tar` BOLEH, atau npm package `archiver` bila sudah ada/silakan `npm install archiver` — lokal repo saja).
- Isi arsip `saas-backup-tenant<id>-<namaslug>-<YYYYMMDD-HHmm>.tar.gz`:
  - `manifest.json`: `{ app: "wa-cs-hub-saas-v3", version: "v3.4", schemaVersion: <string dari prisma>?, tenantId, tenantName, createdAt, note: "Payloads terenkripsi (enc:v1) dengan key platform MSG/MEDIA — restore butuh .env key yang sama.", tables: { <namaTabel>: <rowCount> }, keyFingerprint: sha256(MSG_KEY).slice(0,8) }`
  - `db/<table>.json` — dump SEMUA row tenant per tabel (raw values apa adanya, termasuk payload terenkripsi — JANGAN decrypt). Daftar tabel = sama dengan urutan purge di superadmin.js (semua model tenant-scoped + user-scoped via user.tenantId: messages, blasts, csatSurveys, scheduledMessages, groupActionLogs, chatNotes, chatEvents, chatTags, contactTags, contacts, chats, tags, sharedFiles, sharedFolders, announcements, purgeLogs, messageTemplates, pushSubscriptions, gdriveLinks, backupLogs, favoriteMessages, users, appConfigs, autoReplyConfigs, backupConfigs, appearanceConfigs, csatConfigs, menuGatewayOptions, menuGatewayConfigs) + `tenant.json` (row Tenant + TenantPlan). PENTING: tabel join (chatTags/contactTags) dump row-nya apa adanya (berisi id lama) — cukup untuk DR.
  - `files/` — copy file media byte-for-byte apa adanya (encrypted on disk): message.mediaPath, sharedFile.storagePath, blast.mediaPath, tenant.logoPath (skip yang null/tidak ada di disk). Path di arsip: hash/namafile relatif (hindari path absolut di dalam tar).
- Stream/proses: kumpulkan path dulu (query DB), buat temp di `/tmp/`, `res.download(path)`, `finally` unlink. Jangan simpan arsip permanen di disk (v1 — on-demand service).
- Row besar: Mazaya 5.592 pesan — JSON dump per tabel via `findMany` batch 1000, tulis stream ke file (jangan JSON.stringify sekali jalan kalau bisa).

## 8. Frontend

**SuperAdmin.vue** (diperluas; silakan pecah jadi komponen bila perlu, pola folder views/components):
- Form + Tenant baru: dropdown preset (Lite/Pro/Max) default **Lite**.
- Kartu tenant: badge paket (Lite/Pro/Max/Custom) + usage meter mini: agen `n/m`, kontak `n/m`, TK `x GB/y GB` (human-readable; `∞` bila null) + chip fitur aktif.
- Tombol per tenant: **Edit Paket** (modal: apply preset ATAU override individual — angka & 6 toggle), **Branding** (modal: input brandName + upload logo (preview) + tampilan live "…by ChatBareng"), **Backup** (confirm → download tar.gz), **Impersonate** (kalau belum ada tombolnya → pakai endpoint yang ada, buka tab baru dengan short token), Audit viewer (tab/section di bawah: list dari /api/sa/audit, filter tenant).
- Toast/error tampilkan pesan dari backend apa adanya.

**Branding di app tenant** (header + sidebar layout — cari komponen layout utama):
- Logo (bila ada) + `brandName` + suffix kecil "by ChatBareng" (muted). Fallback "ChatBareng". document.title ikut.
- **Menu gating** pakai `plan.features` dari /auth/me: hide menu Analytics/Blast/Pengumuman/Menu Gateway/Riwayat/CSAT/Backup GDrive bila OFF. Route guard bila URL diakses langsung → redirect + toast pesan 403 backend. Axios interceptor: 403 dari feature middleware → toast pesan backend (jangan swallow).
- Login page: TIDAK berubah.

**Build**: `npm run build` setelah snapshot public (constraint #7).

## 9. Urutan kerja (recommended)

1. Schema + db push (additive) → verify 2 tenant lama utuh (count chat/message Parahita & Mazaya sebelum/sesudah — tulis angkanya di laporan).
2. `src/services/plans.js` + boot ensure → `auth/me` extension → branding logo route.
3. Superadmin routes: preset di create, plan GET/PUT, branding, audit, backup service.
4. Enforcement wiring (users/contacts/import/TK + 6 feature middleware).
5. Audit log di semua aksi SA.
6. Frontend SuperAdmin + branding + menu gating → build.
7. Restart (1x, by PID) → smoke test (§10) → laporan.

## 10. Smoke test WAJIB (tulis output asli di laporan)

1. `npx prisma db push` → sukses tanpa destructive.
2. Boot: log `[Plan] Tenant #4 ... seeded plan=max (existing)` + `#8` (karena belum ada plan). Tenant Parahita/Mazaya count data tetap.
3. Buat tenant "QA Lite" via API preset=lite → plan sesuai tabel Lite.
4. Buat 3 user QA Lite → user ke-4 → **403** dengan pesan upsell (tulis response).
5. Set `maxContacts=2` via PUT plan (override individual) → buat 2 kontak → ke-3 **403**. Pastikan field `preset` jadi `"custom"` di response GET plan.
6. Feature gate: login admin QA Lite → GET /api/analytics → **403**; POST blast → **403**; set plan featAnalytics=true → GET → **200**. (toggles balikin false setelah test)
7. TK quota: update 1 SharedFile.size QA Lite jadi ~2GB via prisma (langsung DB, tulis caranya) → upload file kecil → **403** kuota penuh → revert size.
8. Branding: PUT brandName "QA Test Chat" + upload logo png kecil → GET /auth/me menampilkan branding+plan; GET /api/branding/logo dengan `?token=` → 200 image.
9. Backup: GET /api/sa/tenants/<QA>/backup → 200 tar.gz; `tar -tzf` menampilkan manifest.json + db/*.json + files/; manifest tables row count > 0. (Bonus: jalankan juga untuk tenant #8 Mazaya sekali untuk membuktikan skala — file media ikut; tulis ukuran arsip.)
10. Audit: /api/sa/audit menampilkan aksi plan_update, branding_update, backup_download dari langkah di atas.
11. Build OK; restart 1x; health 200; tepat 1 listener 5047; kedua WA tenant reconnect (cek status WA via SA `?tenant=` atau admin token — tunggu max 60s backoff; tulis status akhir).
12. Cleanup opsional: purge "QA Lite" (audit trail tetap ada — SA audit TIDAK ikut purge; pastikan purge masih sukses SETELAH ada TenantPlan — ini test cascade wajib).

## 11. Laporan (format)

- File yang dibuat/diedit (path + jumlah baris).
- Output asli smoke test 1–12 (tulis response JSON/error persis).
- Angka count Parahita & Mazaya sebelum/sesudah db push.
- Daftar tabel yang masuk backup + row count (QA & Mazaya).
- Halaman/komponen frontend baru.
- Apa yang TIDAK dikerjakan / deviasi dari spec + alasannya.
- JANGAN claim done kalau ada smoke test yang gagal — tulis status apa adanya.