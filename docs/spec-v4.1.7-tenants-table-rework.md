# Spec v4.1.7 — SaTenants Table Rework (desktop table + mobile cards + detail drawer)

> **Request Kanaka 10:26 2026-09-29 (GO 10:36):** Superadmin → Tenants tampilannya "nggak rapi banget" — mau dibikin tabel rapi di desktop (referensi: dashboard Transactions), mobile jadi card. Tombol "Keluar" mobile sudah difix Alita di `SaSidebar.vue` — **JANGAN sentuh file itu**.
> **Rilis ini FE-ONLY: 0 backend, 0 route, 0 prisma, 0 migration.** Satu file view utama: `frontend/src/views/SaTenants.vue` (1,162 baris — baca SEMUA dulu sebelum edit). Boleh buat file baru `frontend/src/components/SaTenantDetailDrawer.vue` kalau memisah lebih bersih.

## 1. Kolom tabel desktop (≥768px) — urut sesuai request Kanaka

1. **Status** — chip: `active` hijau, `suspended` abu/merah muda (pakai token M3, konsisten chip existing).
2. **Nama Tenant** — nama + `brandName` kecil muted di bawah bila beda (kolom `brandName` sudah dikirim API).
3. **Users** — angka (`userCount`).
4. **Kontak** — angka (`usage.contacts`).
5. **TanganKanan** — `usage.tkBytes / plan.tkQuotaBytes`: teks `used/quota` + mini progress bar CSS murni (bar width %; kuota `null` = tampil `used/∞` tanpa bar; 0 quota → guard divide-by-zero).
6. **Masa Berlaku** — chip berdasar `validityState` (API sudah mengirim): `lifetime` abu "Lifetime"; `active` hijau "s/d {validUntil}"; `expiring` kuning "{n} hari"; `expired` merah "Kedaluwarsa {tgl}". Reuse format `fmt()` + style chip existing (baris validChip ~L256) — JANGAN tulis ulang logic, pindah/pakai ulang.
7. **Paket** — chip dari `plan.preset` (lite/pro/max/custom) — helper `planPreset` existing ~L311.
8. **Aksi** — 3 tombol: **Suspend/Resume** (toggle sesuai status sekarang, panggil endpoint suspend resume yang SUDAH ADA — jangan buat endpoint baru), **Hapus** (buka purge flow EXISTING — konfirmasi ketik nama dsb. TIDAK diubah), **👁 Lihat Detail**.

- Referensi visual: screenshot dashboard tabel Kanaka (header, baris renggang, chip status berwarna, aksi kanan). Gaya M3: pakai token warna existing (`--md-sys-color-*`) — JANGAN hardcode hex baru selain yang sudah ada di file.
- Tabel: `<table>` semantik, header sticky di kontainer scroll-x bila sempit, `min-width` per kolom supaya gak gepeng; zebra/hover baris ringan.

## 2. Mobile (<768px)

- Tabel diganti **card list**: Nama + chip Paket + chip Status (+ Masa Berlaku singkat bila bukan lifetime). **Tidak ada tombol aksi selain "👁 Lihat Detail".**
- Card tap → buka drawer detail yang SAMA dengan desktop.

## 3. "Lihat Detail" — drawer (inti rework)

- Semua editor yang SEKARANG hidup di baris/kolom PINDAH ke drawer per-tenant (pindah, bukan hapus — must-preserve list di bawah): Paket & Kuota (planForm preset + tkQuotaGb), Masa Berlaku (validityForm lifetime/30d/1y/custom), Nomor WA/slots (+ delete slot), API keys (list/create/revoke), Branding (brandName/logo), Purge/Hapus tenant flow, dan apapun editor lain yang ditemukan di file — **audit total sebelum refactor: grep semua fungsi & tombol**.
- Drawer: slide dari kanan desktop (lebar ~480-560px, overlay + backdrop klik tutup); mobile full-screen.
- State & toast existing (success/error per aksi) harus tetap jalan dari dalam drawer.
- Drawer buka = fetch data terkini tenant (existing load pattern OK; tidak boleh buat endpoint baru).

## 4. Tetap ada (tidak berubah perilaku)

- Search box, chip filter status (all|active|suspended), pagination client-side, tombol "+ Tenant" (+ create modal), tombol "Muat ulang".
- Loading / empty state.

## 5. Verifikasi (GATES — wajib semua hijau)

1. `cd frontend && npx vite build --outDir /tmp/v417-verify --emptyOutDir` → **exit 0** (PROD `public/` JANGAN di-build/overwrite — deploy final adalah tugas Alita).
2. Regresi e2e: copy-DB dance lalu `node scripts/e2e-v4121.cjs` → **61/61 PASS** (server test di port 5099, copy-DB `/tmp/saas-v3-e2e.db`; kill PID yang kamu spawn sendiri setelah selesai; JANGAN sentuh server 5047).
   - Copy-DB: `python3 -c "import shutil; shutil.copy('prisma/data/saas-v3.db','/tmp/saas-v3-e2e.db')"` — cek dulu kolom `cbaiEndText` sudah ada di copy (pake `node:sqlite` PRAGMA) → kalau sudah ada, SKIP langkah `prisma db execute` migration; jalankan `node prisma/seed-ai-rates.js /tmp/saas-v3-e2e.db`, start server `PORT=5099 DATABASE_URL=file:/tmp/saas-v3-e2e.db WA_DISABLED=1 E2E_OK_SEND=1 E2E_DEBUG_INBOUND=1 node src/server.js` (background), `node scripts/e2e-reset-superadmin.cjs`, dotenv ala header script e2e (`set -a; . ./.env; set +a` lalu run), lalu kill PID sendiri.
3. Node syntax check semua file yang diedit (`node --check` tidak applicable ke .vue → minimal build sudah cover; tambahan: `npx vue-tsc --noEmit` kalau ada config — kalau tidak ada, skip dengan catatan).

## 6. HARD PROHIBITIONS (pelanggaran = langsung berhenti & lapor)

1. **NEVER** pakai `--force-reset`, `--accept-data-loss`, `DROP`, `TRUNCATE`, atau `rm` pada DB/data apa pun — baik DB produksi MAUPUN copy. Kalau tool meminta reset → **STOP & lapor**.
2. TIDAK boleh restart/app server prod 5047, TIDAK boleh kill PID selain yang kamu spawn sendiri; jangan sentuh `.env`, `src/routes/**`, `prisma/**`, `CHANGELOG.md`.
3. TIDAK boleh `git commit/tag/push` — commit & tag oleh Alita.
4. TIDAK boleh pakai browser / Chrome 18801 (visual QA oleh Alita).
5. TIDAK boleh edit `SaSidebar.vue`, `Admin.vue`, `AdminShell.vue` (baru rilis v4.1.6).
6. TIDAK boleh menambah dependency baru.

## 7. Deliverable (report balik ke Alita)

- Daftar file yang diubah/dibuat + ringkasan struktur baru (table → drawer)
- Hasil build (exit code) + e2e-v4121 hasil akhir (PASS/FAIL total)
- Daftar semua fungsi/tombol lama beserta lokasi barunya (bukti must-preserve lengkap)
- Catatan deviasi dari spec (kalau ada + alasan)