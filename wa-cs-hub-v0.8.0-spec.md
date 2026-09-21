# WA CS Hub — v0.8.0 Spec: Auto Backup Chat ke Google Drive (OAuth per-user)

**Status:** ✅ APPROVED Kanaka ("gas", 2026-09-09 13:14, Drive API sudah di-enable) — eksekusi: Dory (dev) + Alita (deploy produksi)
**Penulis spec:** Alita | **Eksekusi (nanti):** Dory
**Tanggal:** 2026-09-09
**Sumber keputusan:** Telegram Kanaka 2026-09-09 12:48–12:58 (per-user OAuth, admin-only, jadwal customizable daily/weekly/monthly, retensi custom, jalur locaspark-relay sementara)

---

## 0. Konteks & Tujuan

Admin WA CS Hub bisa **menghubungkan akun Google pribadi** → aplikasi otomatis
**export chat ke CSV** (reuse logic export v0.6.0) dan **upload ke Google Drive user**
di folder "WA CS Hub Backups" sesuai jadwal.

**Keputusan Kanaka (terkunci):**
- Bukan service account — **OAuth per-user** ("user login ke Google-nya sendiri")
- **Admin only** yang bisa connect
- Jadwal **customizable**: daily / weekly / monthly (+ jam, + pilihan hari untuk weekly, + tanggal untuk monthly)
- Retensi **custom**: simpan N backup terakhir (sisanya auto-delete dari Drive)

## 1. Arsitektur OAuth — locaspark relay (SEMENTARA, sudah LIVE & tested)

**Masalah:** produksi di quick tunnel (URL berubah tiap restart) → redirect URI OAuth harus domain fix.

**Solusi (sudah dideploy Alita):** `https://locaspark.com/gdrive-oauth.php` = papan lompat statis:
- Menerima callback Google (`?code=&state=`), decode `state` (base64url JSON `{origin}`),
  validasi origin **allowlist**: `*.trycloudflare.com` + `localhost/127.0.0.1` (anti open-redirect),
  lalu **302** ke `{origin}/api/gdrive/oauth/callback?code=...&state=...`
- Tidak menyimpan apa-apa (no token/secret/log). Source: `locaspark-relay/gdrive-oauth.php` (workspace), live di `public_html/`
- **Tested 2026-09-09:** bogus state → 400; state valid → 302 ke origin tujuan; origin di luar allowlist → 400 ✅

**Flow lengkap:**
1. Admin klik "Hubungkan Google Drive" → `GET /api/gdrive/oauth/start` (admin auth)
2. Hub deteksi **origin sendiri dari request** (`req.headers.host` + proto — TANPA config, otomatis ikut URL tunnel aktif) → bikin URL consent Google:
   - `client_id`/`client_secret` dari env `GDRIVE_CLIENT_ID` / `GDRIVE_CLIENT_SECRET`
   - `redirect_uri=https://locaspark.com/gdrive-oauth.php` (fix)
   - `scope=https://www.googleapis.com/auth/drive.file` (CUMA file yang app bikin — bukan Drive penuh)
   - `access_type=offline&prompt=consent` (agar selalu dapat refresh token)
   - `state` = base64url(JSON `{origin, nonce})` — nonce disimpan in-memory 10 menit (anti-CSRF)
3. User login+setuju → Google → locaspark relay → 302 balik ke Hub `/api/gdrive/oauth/callback`
4. Hub validasi nonce, tukar `code` → token (server-side), simpan:
   - `refresh_token` **dienkripsi AES-256-GCM** (kunci: turunan `MEDIA_ENCRYPTION_KEY` — pola existing, JANGAN simpan plaintext)
   - email akun (`userinfo.email` scope tambahan untuk tampilan "Terhubung sebagai …")
5. Halaman admin menampilkan status + email + riwayat backup

**Catatan consent screen:** app internal, status Production; first login menampilkan warning
"unverified app" → user klik Advanced → proceed. Normal, tidak perlu verifikasi Google.

## 2. Data Model (additive only — zero data loss)

```prisma
model GDriveLink {
  id             Int      @id @default(autoincrement())
  userId         Int      @unique
  user           User     @relation(fields: [userId], references: [id])
  email          String           // akun Google yang terhubung
  refreshTokenEnc String          // AES-256-GCM (iv:tag terenkripsi, pola media.js)
  linkedAt       DateTime @default(now())
  lastBackupAt   DateTime?
  lastBackupStatus String? // success | error
  lastBackupError  String?
}

model BackupLog {
  id         Int      @id @default(autoincrement())
  userId     Int
  user       User     @relation(fields: [userId], references: [id])
  fileName   String           // wa-cs-hub-backup-YYYY-MM-DD-HHmm.csv
  sizeBytes  Int
  status     String           // success | error
  error      String?
  uploadedAt DateTime @default(now())
}

model BackupConfig {
  id            Int    @id @default(1)   // singleton
  frequency     String @default("daily") // daily | weekly | monthly
  hour          Int    @default(23)      // 0–23 WIB
  dayOfWeek     Int    @default(1)       // 0=Minggu..6=Sabtu (untuk weekly)
  dayOfMonth    Int    @default(1)       // 1–28 (untuk monthly, aman untuk bulan pendek)
  retentionCount Int   @default(30)      // simpan N file terakhir
  enabled       Boolean @default(true)
}
```
- Seed idempotent `BackupConfig` id=1 saat start (pola AutoReplyConfig v0.7.0)
- Kredensial OAuth via `.env`: `GDRIVE_CLIENT_ID`, `GDRIVE_CLIENT_SECRET` (Alita yang isi sebelum deploy)

## 3. API (admin only — `requireAuth, requireAdmin`; mount `/api/gdrive`)

| Endpoint | Fungsi |
|---|---|
| `GET /api/gdrive/status` | linked? email? config? riwayat backup 20 terakhir |
| `GET /api/gdrive/oauth/start` | generate URL consent (origin dari request, nonce in-memory 10m) |
| `GET /api/gdrive/oauth/callback` | validasi nonce → exchange token → encrypt + simpan → redirect ke halaman admin (`#/admin/backup?linked=1`) |
| `DELETE /api/gdrive/disconnect` | revoke token ke Google + hapus GDriveLink |
| `PUT /api/gdrive/config` | update jadwal/retensi (validasi: freq enum, hour 0–23, dow 0–6, dom 1–28, retention ≥1) |
| `POST /api/gdrive/backup-now` | jalankan job backup manual (async, return 202) |

## 4. Backup Job (`src/services/gdriveBackup.js`)

Dipicu scheduler in-process (pola watchdog: `setInterval` cek menit WIB, bukan cron eksternal):
1. Cek config: `enabled` + cocokkan jadwal (daily: jam; weekly: jam+dow; monthly: jam+dom) — **WIB eksplisit** (pola `wibDateString` v0.7.0)
2. Reuse **logic export CSV v0.6.0** (`src/routes/history.js`) → stream/Buffer CSV
   `wa-cs-hub-backup-YYYY-MM-DD-HHmm.csv`
3. Upload ke Drive v3 (multipart simple upload) — folder **"WA CS Hub Backups"** find-or-create
   (dengan `drive.file` app hanya melihat folder yang dia bikin sendiri — aman)
4. Sukses → `BackupLog` success + `GDriveLink.lastBackupAt/Status`
5. **Retensi:** list file di folder (orderBy createdTime desc) → delete di luar N terakhir
6. Gagal (401/invalid_grant) → coba refresh token sekali; tetap gagal → `BackupLog` error +
   `lastBackupStatus=error` + pesan jelas di UI ("Hubungkan ulang Google Drive")
7. Tidak ada link → skip senyap (log saja)
8. Anti double-run: in-memory lock `isRunning` (daily job + manual bersamaan)

## 5. Frontend — `AdminBackup.vue` (route `/admin/backup`, admin)

Ikuti pola page admin existing (PageShell, kartu, toast):
- **Kartu status koneksi:** belum terhubung → tombol "🔗 Hubungkan Google Drive" (buka URL consent, same-tab);
  terhubung → "✅ Terhubung sebagai <email> · backup terakhir <tgl> (sukses/error)" + tombol
  "🔌 Putuskan" (confirm dialog) + "⬆️ Backup sekarang" (toast progres → refresh status)
- **Kartu pengaturan:** frekuensi (daily/weekly/monthly) + input jam; weekly → pilihan hari;
  monthly → tanggal 1–28; retensi (angka N); toggle aktif; tombol Simpan
- **Kartu riwayat:** tabel 20 backup terakhir (waktu, nama file, ukuran, status + error message kalau gagal)
- Nav item "☁️ Backup Drive" di menu admin + router entry (`meta: { auth: true, admin: true }`)
- **Mobile-friendly** — perhatikan pola v0.7.1: grup input yang saling terkait dibungkus 1 kontainer flex, bukan per-input

## 6. Keamanan

- Scope minimum `drive.file` + `userinfo.email` — TIDAK full drive
- Refresh token terenkripsi di-rest (AES-256-GCM); tidak pernah dikirim ke frontend
- Anti open-redirect: relay allowlist + Hub validasi nonce
- Disconnect = revoke ke Google (`/oauth2/revoke`) + hapus row
- Callback HANYA menerima state dengan nonce yang sah (sekali pakai)

## 7. Non-goals (explicit)

- Restore dari Drive (backup one-way saja)
- Multi-account per user (1 user = 1 akun Google; relink menimpa)
- Backup media/foto (CSV text saja — sama dengan export v0.6.0)
- Service account (opsi lama dibuang — keputusan Kanaka)

## 8. Acceptance Criteria

- [ ] Admin click connect → consent Google → balik ke hub → status "Terhubung sebagai <email>"
- [ ] Folder "WA CS Hub Backups" terbentuk otomatis di Drive user saat backup pertama
- [ ] "Backup sekarang" → CSV muncul di Drive + log sukses + muncul di riwayat
- [ ] CSV isinya = hasil export manual v0.6.0 (spot-check baris & header identik pola)
- [ ] Jadwal daily jam X → terkirim otomatis di jam X WIB (bukti via log + file di Drive)
- [ ] Retensi N=3 → setelah 4 backup sukses, file tertua hilang dari Drive
- [ ] Disconnect → token revoked (Google side) + row terhapus + status balik "belum terhubung"
- [ ] Restart server → scheduler jalan lagi, tidak ada backup dobel, link tetap ada (token terenkripsi persist)
- [ ] CS login → TIDAK ada menu/endpoint backup (403 di API)
- [ ] Origin tunnel baru (setelah restart cloudflared) → connect ulang tetap jalan (origin dari request, bukan config)
- [ ] Regression: fitur lain normal (chat, blast, autoreply, analytics)

## 9. Rencana Eksekusi (Dory) & Verifikasi (Alita)

- Backend: schema push additive (backup + md5 dulu!), service gdriveBackup, routes, scheduler, .env keys (Alita isi)
- Frontend: AdminBackup.vue + router + nav + rebuild
- Smoke dev 5041: config persist, callback flow pakai state palsu (401/400 path), job manual dengan fake token → error path rapi, anti double-run
- Verifikasi E2E asli (Alita + Kanaka): link akun Kanaka → backup manual → cek file di Drive → set retensi → hapus otomatis
- Deploy prod: restart by PID (jangan pkill pattern!), config default: enabled=false (Kanaka ON manual setelah QA)
- Estimasi: 1 sesi Dory + QA Kanaka

---
*Spec by Alita, decisions from Kanaka 2026-09-09 (Telegram). Jangan eksekusi sebelum Kanaka approve.*