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
