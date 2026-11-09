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
