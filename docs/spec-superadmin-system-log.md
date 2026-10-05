# Spec — Superadmin System Log (viewer log lintas-tenant + export + client capture)

**Status:** APPROVED 2026-10-05 14:35 (Kanaka jawab 4 keputusan terbuka — lihat §Keputusan Terkunci) → spawn Dory saat itu juga
**Tipe:** BE + FE (fitur baru; migrasi ADDITIVE murni)
**Origin:** lapor Kanaka 2026-10-05 14:21 — dalam alur rilis vendor→IT, tim IT TIDAK punya akses server (`logs/server-*.log` tidak terlihat dari app). Yang dibutuhkan: menu log di UI superadmin sehingga error per fitur/per-tenant bisa di-triage & di-fix — sebagian self-serve oleh IT (config/reset lokal), sebagian di-eskalasi ke kita dengan export yang data-datanya lengkap.
**Prinsip dasar:** log = alat diagnostik untuk SUPERADMIN saja. Tenant (admin/cs/relay) TIDAK pernah melihat log ini — privasi antar-tenant mutlak.

---

## D0 — Karakter & Non-goals

**Ya:**
- Satu tabel `SystemLog` mengumpulkan error/warn dari: server process (console wrapper + crash handlers), client frontend (window error → POST), dan call-site penting yang diberi konten terstruktur (module/tenant).
- Menu baru di SuperAdmin (`/superadmin/logs`) + filter + detail + export CSV.
- Redaksi PII dilakukan SAAT INGEST (bukan saat baca) → DB & export aman by construction.
- Versi aplikasi tercatat per entry → IT langsung tahu "error ini sejak merge vX".

**Non-goals (eksplisit):**
- ❌ TIDAK refactor ~912 call-site `console.error/warn` satu-satu — ditangkap lewat wrapper.
- ❌ TIDAK ada realtime socket streaming (triage, bukan ops realtime; refresh manual + polling opsional).
- ❌ TIDAK ada UI/log bagi tenant; TIDAK ada edit/delete entri per-baris dari UI (hanya auto-prune).
- ❌ TIDAK meneruskan log ke layanan eksternal (grafana/SaaS log) — tetap on-prem DB.
- ❌ Level `debug` tidak diimplement.

## D1 — Model DB (additive murni, prisma/schema.prisma)

```prisma
model SystemLog {
  id          Int      @id @default(autoincrement()) // Int cukup (2.1B); hindari pain BigInt di JSON API
  ts          DateTime @default(now())
  level       String   // "error" | "warn" | "info"
  source      String   // "server" | "client"
  module      String   // konstanta list: auto-reply|blast|scheduler|wa|chat|media|api-keys|auth|tenant|database|frontend|other
  tenantId    Int?     // plain TANPA FK (pola SaAuditLog) → row tetap hidup setelah tenant di-purge
  tenantName  String?  // snapshot nama saat write (tenant bisa terdelete belakangan)
  appVersion  String?  // snapshot versi app saat entry dibuat (lihat D6)
  message     String   // TER-REDAKSI + dibatasi 1000 chars
  stack       String?  // dibatasi 4000 chars (bila ada Error object)
  metaJson    String?  // JSON konteks tambahan, dibatasi 4000 chars
  createdAt   DateTime @default(now())

  @@index([ts])
  @@index([level, ts])
  @@index([module, ts])
  @@index([tenantId, ts])
}
```

Keputusan penting (jangan digoyang):
- `tenantId` plain tanpa FK + `tenantName` snapshot — **persis pola `SaAuditLog`** (survive purge; konsisten kodebase).
- Redaksi TERJADI SEBELUM write (D7) — jadi DB, UI, dan CSV semuanya sudah bersih.
- Index mengikuti pola filter utama UI (level/modul/tenant + rentang waktu).

## D2 — Capture layer server (`src/services/systemLog.js` baru)

Service satu pintu dengan API:
```js
logError(message, { module, tenantId, tenantName, err, meta })
logWarn(message, { ... })   // dipakai eksplisit di call-site penting
logInfo(message, { ... })   // OPT-IN saja — jangan spam
```
Aturan implementasi:
1. **Best-effort, TIDAK PERNAH fatal** (pola `saAudit.audit()`): semua write dibungkus try/catch; kegagalan write tidak menggagalkan aksi utama yang sedang jalan.
2. **Anti-rekursi/anti-log-storm:** simpan referensi `console.error` ASLI saat startup; di dalam catch internal pakai referensi asli + flag `inLog` biar error logger sendiri tidak di-wrap lagi. Dedup sederhana: hash(message) identik dalam window 10 detik → skip (hindari banjir 1 bug → 50k row).
3. **Wrapper `console.error`/`console.warn`** dipasang TERLUAR DULU di `src/server.js` (paling atas, sebelum require route/service lain): call lama tetap tampil di stdout seperti biasa, sekaligus masuk `SystemLog` (source=server, module default `other`).
   3b. **Wrapper `console.log`/`console.info` juga aktif** → level `info`, module default `other` *(Kanaka: "semua informasi yang bisa tercatat")*. WAJIB pakai **flood guard global**: maks ±300 info/menit (counter in-memory; kelebihan di-drop + 1 warn ringan dicatat "info flood suppressed N") supaya log request-literal tidak membanjiri tabel. Dedup 10 detik tetap berlaku.
4. **Crash handler:** `process.on('uncaughtException')` & `process.on('unhandledRejection')` → logError module=`other`/module sesuai kalau bisa disimpulkan → JANGAN exit; perilaku proses lain tidak berubah (log saja).
5. **Call-site terstruktur (diberi module+tenant):** tambahkan pemanggilan eksplisit di titik-titik ini (cukup titik error utama, bukan seluruh file):
   - `src/services/autoReply.js` (module `auto-reply`, tenant dari payload)
   - `src/services/blast.js` + blast runner (module `blast`)
   - `src/services/v0100Scheduler.js` + `menuGateway.js` sweep (module `scheduler`)
   - `src/wa/pool.js` event koneksi/error + `assertWaReady*` gagal (module `wa`)
   - `src/routes/superadmin.js` impersonate gagal / purge error (module `tenant`)
   - middleware error API terakhir di `src/server.js` (module `api-keys` bila path `/api/v1/…`, selain itu `other`) — tetap log ke file/stdout seperti sebelumnya TIDAK diubah perilakunya.
6. `appVersion` dibaca dari `APP_VERSION` env; fallback file `version.json` di root (file 1-line `{"appVersion":"v4.6.3"}`) — file opsional: kalau tidak ada, fallback `"-"+stamp waktu boot`/`"dev"` (keputusan no-bump version — lihat §Keputusan Terkunci).

## D3 — Capture layer client (frontend)

- `frontend/src/main.js`: `app.config.errorHandler` + `window.addEventListener('error'|'unhandledrejection')` → kirim ringkas ke baru `POST /api/client-log` (di server.js sebelum authed routes):
  - **WAJIB ter-autentikasi** (JWT user apa pun role-nya — error frontend user tenant penting buat diagnosa); `tenantId` & `username` DIAMBIL DARI TOKEN (bukan body) → source=`client`, module=`frontend`.
  - Payload dibatasi: message ≤ 500, stack ≤ 2000, module hint dari route name.
  - **Rate limit per user: 20 pesan/menit** (counter in-memory; kelebihan = drop diam-diam). Bodi yang identik dalam 10 detik di-dedup (pola sama dgn D2).
  - Endpoint ini TIDAK mengembalikan detail DB (fire-and-forget 204) — dipakai tidak untuk menebak isi log.

## D4 — API superadmin (naikkan di `src/routes/superadmin.js` dengan `sa` middleware yang sudah ada)

| Method & path | Fungsi |
|---|---|
| `GET /superadmin/system-logs` | List + filter `level` (multi, comma-sel), `module`, `tenantId`, `q` (keyword LIKE di message), `from`/`to` (ISO), `limit` (default 100, max 500), `cursor` (id desc) — response ringkas tanpa stack/meta (detail via :id) |
| `GET /superadmin/system-logs/:id` | Detail lengkap: stack + metaJson |
| `GET /superadmin/system-logs/export` | CSV, filter identik dgn list; **cap 10.000 row** terbaru sesuai filter; header kolom: id,ts,level,source,module,tenantId,tenantName,appVersion,message,stack,metaJson (stack/meta JSON-stringify + escape); filename `system-log-YYYYMMDD-HHmm.csv` |
| `GET /superadmin/system-logs/stats` | (bonus, murah) count per level & per module & top 5 tenant — window 24 jam terakhir; untuk strip ringkasan di atas UI |

- TIDAK ADA endpoint create/update/delete manual; data hanya masuk via capture + keluar via auto-prune (D6).
- Semua route di file ini otomatis superadmin-only (middleware `sa`); TIDAK menyentuh data tenant lain selain agregat log (konsisten komentar default-deny di file).

## D5 — UI (`frontend/src/views/SaLogs.vue` baru + mount)

- Router: `/superadmin/logs` (meta.superadmin tetap); menu item baru di `SaSidebar.vue` setelah Audit: **"Log Sistem"** (ikon notepad/journal).
- Tabel kolom: Waktu (id-ID), Level (chip: error=merah, warn=amber, info=abu), Modul, Tenant (nama snapshot; "—" kalau null = server-side global), Pesan (truncated, expand di detail), Versi.
- Filter bar: Level (chips multi), Modul (dropdown dari konstanta yang sama dgn BE), Tenant (dropdown daftar tenant yang sudah ada di SaTenants), Keyword, Rentang tanggal (pola date-range v3.9.20).
- Klik row → drawer/modal detail: message penuh, stack (pre), metaJson pretty-printed, tombol "Copy JSON" (report ke vendor tinggal paste).
- Export button → ikut filter aktif → download CSV.
- Refresh manual + toggle auto-refresh 30s (polling sederhana; tidak perlu socket).
- Mobile: ikuti konvensi shell SuperAdmin (drawer + tabel scroll-horizontal).
- Strip ringkasan di atas pakai `/stats` (error 24 jam terakhir — angka merah kalau > 0).

## D6 — Retensi & housekeeping

- Pemangkas: **in-process `setInterval` harian** (pola anti-cron-eksternal ala `gdriveBackup.js`): `DELETE FROM SystemLog WHERE ts < now() - RETENTION` saat boot + tiap 24 jam di menit kecil acak (hindari barep dengan backup jam lain).
- Retensi default **30 hari** *(Kanaka, 2026-10-05)*, override env `SYSTEMLOG_RETENTION_DAYS` (IT bisa naikin sementara kalau sedang investigasi).
- Hapus batch (chunk 5000) biar tidak lock DB lama.

## D7 — Privacy / redaksi (WAJIB, dieksekusi saat INGEST)

Regex/teknik diterapkan di `systemLog.js` sebelum write (dan client-log endpoint):
1. **Digit run ≥ 8 digit** (nomor WA, NIK) → `62***abc123` (simpan 3-4 digit akhir supaya masih bisa dicocokkan manual).
2. Potongan gaya "message/body/payload: …" → diganti `[redacted-body N chars]` (panjang asli dicatat biar debug ukuran masih mungkin).
3. Email → `u***@domain` (domain tetap — penting ngerti konteks rekanan).
4. Semua field disatukan `message` ≤ 1000, `stack` ≤ 4000, `metaJson` ≤ 4000.
5. `SystemLog` TIDAK boleh berisi isi chat pelanggan secara literal — hanya konteks error (nama operasi, ID numerik chat/tenant, kode modul). Kalau call-site butuh "tampilkan pesan yang gagal proses" cukup first-40-chars hasil redaksi.
6. Audit reviewer (kimia-K3/Kane) nanti WAJIB cek redaksi vs sample log nyata sebelum release.

## D8 — DDL SHARE untuk IT (feedback IT 2026-10-02 v4.6.3 — WAJIB ada di PR & docs/SCHEMA-CHANGES.md)

```sql
-- SystemLog (additive, aman dijalankan berulang: IF NOT EXISTS)
CREATE TABLE IF NOT EXISTS `SystemLog` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `ts` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `level` VARCHAR(191) NOT NULL,
  `source` VARCHAR(191) NOT NULL,
  `module` VARCHAR(191) NOT NULL,
  `tenantId` INTEGER NULL,
  `tenantName` VARCHAR(191) NULL,
  `appVersion` VARCHAR(191) NULL,
  `message` TEXT NOT NULL,
  `stack` TEXT NULL,
  `metaJson` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE INDEX `SystemLog_ts_idx` ON `SystemLog`(`ts`);
CREATE INDEX `SystemLog_level_ts_idx` ON `SystemLog`(`level`, `ts`);
CREATE INDEX `SystemLog_module_ts_idx` ON `SystemLog`(`module`, `ts`);
CREATE INDEX `SystemLog_tenantId_ts_idx` ON `SystemLog`(`tenantId`, `ts`);
```
*(Dory: sesuaikan sintaks SQL dengan dialect yang sebenarnya dari `prisma migrate diff` — bentuk ini SQLite/MySQL di pack; yang penting ADA blok DDL siap share di PR.)*
Catatan IT-flow: `npm start` tetap auto-apply lewat `scripts/prestart-migrate.js` v2 (db push idempoten). DDL di-share sebagai referensi + jalan manual kalau IT mau.

## D9 — E2E (file `e2e-v470-systemlogs.mjs`, pola e2e existing)

1. Ingest BE: panggil service dengan `console.error` (via wrapper) → row masuk dengan module/tenant/versi benar.
2. Redaksi: input berisi nomor `628111222333` & email → tersimpan ter-redaksi (nomor/email mentah TIDAK ada di DB).
3. Client capture: login cs user (bukan superadmin) → POST /api/client-log sukses 204 + row source=client; rate limit → pesan ke-21 dalam menit yang sama di-drop (total tidak bertambah).
4. Role gate: admin/cs user → semua endpoint `/superadmin/system-logs*` → 403.
5. List + filter + cursor pagination + export CSV (hitung baris, cap 10k tidak mem-bombak memori).
6. Dedup: spam message sama 30x dalam <10s → row bertambah ≤ 2 (window dedup bekerja).
7. Retensi: sisip row dengan `ts` 30 hari lalu → jalankan sweeps manual → row terhapus, row segar tetap.
8. Isolasi & survival: purge tenant (pattern purge existing di SaTenants) → row log dengan tenantId lama TETAP ADA (snapshot), tidak orphan-FK (sudah plain).
9. Regresi: boot server normal TANPA error; log volume normal di smoke (tidak nge-spam — wrapper tak linting sendiri).
10. Flood guard: spam `console.log` 1000x/menit dari satu titik → hanya ≤~300 masuk + 1 warn "flood suppressed"; server tetap responsif.

## D10 — Acceptance & deploy checklist

- [ ] Semua e2e D9 PASS (+ audit reviewer: fokus redaksi PII, rate limit, anti-rekursi, jangan pecahkan perilaku console existing)
- [ ] `version.json` + `CHANGELOG.md` entri v4.7.0 + `docs/SCHEMA-CHANGES.md` + DDL share
- [ ] Smoke copy-DB + tunnel (pola pipeline rilis v4.5.0/v4.6.x)
- [ ] PR ke repo IT: branch + graft 1 commit dari THEIR current `main` SHA (skill `chatbareng-it-release`) — body PR mention DDL section + "fitur pertama yang dirancang utk IT sebagai user utama"

---

## Keputusan Terkunci (Kanaka 2026-10-05 14:35 — spec APPROVED)

1. **Retensi = 30 hari** default (env `SYSTEMLOG_RETENTION_DAYS` tetap tersedia).
2. **Semua informasi yang bisa tercatat** → level `info` IKUT ditangkap: wrap juga `console.log`/`console.info` (level info, module default `other`) + `logInfo()` opt-in di call-site penting. WAJIB flood guard global ±300 info/menit (counter in-memory, kelebihan di-drop + 1 warn "info flood suppressed N") supaya request-log literal tidak membanjiri tabel. Dedup 10 detik tetap berlaku untuk semua level.
3. **Client capture dari SEMUA role** (super_admin/admin/cs/relay — tetap wajib JWT, tenant dari token).
4. **TANPA bump minor:** bukan v4.7.0 — masuk sebagai penambahan hotfix-style di patch line berikutnya; CHANGELOG beri entri baru bertanda "(log menu addition)" tanpa ganti major/minor; nomor final (default v4.6.4) diputuskan saat ship. Playground dulu → baru PR ke IT.
5. **Keamanan DB (lesson 2026-08-31):** DILARANG `prisma migrate reset` / `db push --accept-data-loss` / `--force-reset` / DROP / rm pada DB apa pun. Migrasi ADDITIVE murni. Tool minta reset → STOP & lapor.