# ChatBareng MSI build (Windows x64)

Alat build installer Windows dijalankan di LINUX (wixl/msitools).

## Resep (urutan)
1. `npx prisma generate` — schema WAJIB punya `binaryTargets = ["native","windows"]`
   (diproduksi query_engine-windows.dll.node; kolom DateTime SQLite = INTEGER ms).
2. Siapkan payload (mirror dari repo root):
   `src prisma scripts public package.json version.json node_modules`
   + `data/` berisi **DB pre-migrated kosong** (45 tabel, dibuat via
   `npx prisma db push --skip-generate` pada build time — install fresh
   TIDAK lewat `migrate deploy` karena ordered-migration bisa gagal no-such-table
   untuk DB mutlak baru).
   + `node/` = portable Node win-x64 (nodejs.org zip, di-extract).
   + `start.bat`, `PANDUAN-INSTALL-WINDOWS.txt`, `scripts/cb-first-run.js`.
3. `python3 scripts/msi-build/gen_wxs.py` (sesuaikan ROOT ke payload) → ChatBareng.wxs.
4. `wixl -a x64 -o ChatBareng-Setup.msi ChatBareng.wxs` (apt: msitools + wixl).
5. Verify: `msiinfo suminfo` + `msiextract` → hitung file + cek node.exe/
   DB/dll/start.bat.

## Catatan desain
- Per-user install: `ALLUSERS=2` + `MSIINSTALLPERUSER=1` → `%LOCALAPPDATA%\Programs\ChatBareng`
  (data DB/media ditulis runtime = butuh dir writable; ProgramFiles = GAGAL di runtime).
- Shortcut Start Menu: `cmd /c start.bat` (server console + auto-open browser +5s).
- First-run: `cb-first-run.js` menulis .env (JWT/kunci AES-GCM/password superadmin
  acak per-PC + KREDENSIAL-ADMIN.txt).
- Belum: code signing (SmartScreen warning saat pertama jalan — "More info → Run anyway").

## Revision History v2 (2026-11-09)
- **BUG 2704 (root directory undefined)**: struktur lama `LocalAppDataFolder\Programs\INSTALLDIR` tidak
  konvensional untuk wixl per-user dual-mode; shortcut target double-bracket `[[SystemFolder]cmd.exe]`
  + RegistryValue Key double-backslash ikut disangka penyebab. **Fix v2**:
  - Directory root = **ProgramFilesFolder** langsung → INSTALLDIR (ALLUSERS=2 + MSIINSTALLPERUSER=1
    otomatis redirect ke `%LOCALAPPDATA%\Programs\ChatBareng` per-user, tetap ProgramFiles per-machine)
  - Shortcut Target bracket TUNGGAL `[SystemFolder]cmd.exe`, args `/c "[INSTALLDIR]start.bat"`
  - Registry `Key="Software\ChatBareng"` satu backslash
- 🔴 **PURGE RULE (wajib): JANGAN pernah cp -r folder `prisma/` utuh — `prisma/data/*.db`
  berisi DB dev nyata (PII pelanggan: nama + no HP). Payload prisma/ = schema + migrations SAJA.
  data/ = WAJIB kosong selain data/wa-cs-hub.db schema kosong (db push build-time).
  Verify: `find <extract> -name "*.db"` → HARUS 1 file saja.
- Migrate deploy GAGAL untuk DB mutlak baru (ordered-migration no-such-table TenantPlan) →
  fresh install = DB pre-pushed bundling + start server LANGSUNG (tanpa prestart-migrate).
- uninstall: menghapus seluruh folder app termasuk data\ (PANDUAN sudah menyatakan backup folder data dulu kalau mau menyimpan chat).

## Revision v4 (FINAL shape — 2026-11-10)
- **2704 root cause (bukti):** dual-mode per-user (ALLUSERS=2 + MSIINSTALLPERUSER=1)
  = di Windows asli selalu ERROR 2704 "Root directory property undefined"
  (di Wine diabaikan → install sukses; jangan harapkan Wine merepro).
- **Shape FINAL:** per-machine murni (**ALLUSERS=1**, tanpa MSIINSTALLPERUSER) +
  data (DB/media/sesi/.env/credential) di **CommonAppDataFolder\ChatBareng**
  (ProgramData — writable untuk semua user saat runtime, TIDAK di Program Files:
  runtime non-admin tak berhak menulis PF).
- config.js ADDITIVE: `dotenv.config({ path: process.env.CHATBARENG_ENV_FILE || undefined })`
  → start.bat set CHATBARENG_ENV_FILE=%ALLUSERSPROFILE%\ChatBareng\.env.
  Tanpa env var = perilaku lama persis (aman utk IT prod).
- DB pre-migrated = CommonAppData component (payload-predata/wa-cs-hub.db, 45 tabel).
- cb-first-run.js: mkdir ProgramData data dirs + .env ABSOLUTE path + KREDENSIAL-ADMIN.txt di ProgramData.
- Uninstall = app+shortcut hilang; ProgramData\ChatBareng TETAP (data aman) — hapus manual kalau total.

## EXE route (FINAL pilihan, teruji Wine): NSIS
- **Riwayat:** MSI selalu 2704 di Windows asli (v3 LocalAppData-shape, v4 per-machine + ProgramData) — walau Wine install sukses dua-duanya. Kandungan MSI valid; ENGINE Windows Installer menolak sesuatu yang wine lenient. Jangan habiskan waktu — **pakai NSIS (.exe)**.
- **NSIS (apt nsis; makensis):** per-user, RequestExecutionLevel user (TANPA admin/UAC), install ke `$LOCALAPPDATA\ChatBareng`, data di `$INSTDIR\data` (writable), .env first-run di ROOT app (cb-first-run default — CB_DATA_DIR tak diset = root app), MUI2 (Welcome/Directory/InstFiles/Finish-run=start.bat + ShowREADME panduan), Start Menu 2 shortcut, uninstall entry HKCU + Uninstaller: prompt "hapus juga data?" (NO = data aman).
- Build: `makensis -DROOT=/tmp/cb-msi/payload -DOUTFILE=/tmp/cb-msi/ChatBareng-Install.exe chb.nsi` → 70MB (LZMA dari 319MB).
- Wine verify: install /S → AppData\Local\ChatBareng penuh (node/db/bat/Uninstall.exe ✓).
- cb-first-run.js versi terakhir: CB_DATA_DIR-aware (NSIS/dev = root app; MSI v4 = ProgramData).
