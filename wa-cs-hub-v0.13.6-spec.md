# WA CS Hub v0.13.6 — Spec: Admin Sidebar Desktop + Settings Search (Tahap 1+2)

> Status: APPROVED (Kanaka 2026-09-12 10:39, dgn syarat rollback script) → eksekusi via Dory
> Base: v0.13.5 (commit a7cf009 + qol commits). RESTRUKSI **DESKTOP-ONLY** di /admin — mobile 100% unchanged.

## 0. Referensi pola existing (jangan dibuang)

Pola dual-panel desktop vs mobile-single **sudah pernah dilakukan** di halaman chat
(Dashboard.vue: desktop list-pane + detail-pane, mobile list → ChatDetail navigasi).
Ambil pola yang sama: **desktop `md:flex` sidebar + konten, mobile jatuh ke layout lama**.
Semua page admin existing (AdminUsers, AdminWhatsApp, AdminAutoReply, AdminMenuGateway,
AdminCsat, AdminBackup, AdminPurge, AdminHistory, dst) TIDAK di-refactor isinya —
mereka tetap halaman utuh; yang baru hanya SHELL-nya.

## 1. A — Sidebar navigasi desktop di /admin

### Layout (desktop ≥768px)
- `/admin` = **satu shell 2-kolom**:
  - Kiri: sidebar sticky (`position: sticky; top: 0; height: calc(100vh - topbar)`),
    lebar ~280px, list semua modul (ikon + label + deskripsi pendek) — Material 3
    (item aktif: `secondary-container` bg + primary text; hover: on-surface 8%).
  - Kanan: area konten (scroll sendiri) — modul yang aktif.
- Semua 8 modul existing + urutan & deskripsi pendek (ikon sudah ada di modules array):
  Users (kelola CS), WhatsApp (QR & sesi), Auto Reply (greeting & jam kerja),
  Menu Gateway (triage otomatis), Templates (balasan cepat), CSAT (survey),
  Purge (bersih-bersih), Backup (Google Drive).
- **Navigasi TETAP route-based** (`/admin/users`, dst — router-link): deep-link, history
  back/forward, dan halaman langsung (refresh) tetap bekerja. Sidebar hanya mengubah
  PRESENTASI — bukan state global.
- Halaman admin yang sekarang punya header sendiri (`← Dashboard` + title): header itu
  dihaluskan — di dalam shell dual-panel desktop, judul modul cukup di atas konten
  (sidebar sudah menandakan posisi). Link "← Dashboard" pindah ke atas sidebar
  (logo/brand di paling atas sidebar ala Windows).

### Mobile (unchanged — regression gate)
- <768px: /admin tetap launcher grid seperti sekarang + homerow + topbar PageShell.
- TIDAK ada perubahan CSS/behavior mobile sama sekali. Semua styling baru dibungkus
  `@media (min-width: 768px)` atau `hidden md:flex` (pola existing).

### Halaman admin di dalam shell (desktop)
- Bila modul dibuka via sidebar → konten modul dirender di panel kanan shell
  (komponen view yang SAMA — reuse, bukan duplikat).
- Bila diakses via deep-link langsung (refresh di /admin/users) → shell tetap render,
  item sidebar aktif sesuai route.
- ⚠️ Guard: view admin yang membaca route/back (mis. AdminMenuGateway back-to
  /admin/autoreply) harus tetap bekerja — uji back button.

## 2. B — Settings Search

- Search box di atas sidebar (desktop) — placeholder "Cari pengaturan…".
- Index statis di frontend (array JS): tiap entri = { label, keywords, path, sectionHint }.
  Isi minimal (boleh Dory tambah):
  - Users: "cs, agent, user, password, role" → /admin/users
  - WhatsApp: "qr, scan, session, logout wa, centang biru, read receipt" → /admin/whatsapp
  - Auto Reply: "away, greeting, sambutan, jam kerja, jam operasional, luar jam" → /admin/autoreply
  - Menu Gateway: "menu, triage, intro, timeout, frekuensi, tag otomatis" → /admin/menu-gateway
  - Templates: "template, balasan cepat" → /admin/templates
  - CSAT: "bintang, rating, survey, kepuasan, csat" → /admin/csat
  - Purge: "hapus chat, bersih-bersih, purge" → /admin/purge
  - Backup: "backup, google drive" → /admin/backup
- Behavior: ketik → dropdown hasil (icon + label + sectionHint, M3 list); klik →
  navigate; Enter → hasil pertama; Esc/kosong → tutup. Filter contains,
  case-insensitive, skor sederhana (startsWith > contains). TIDAK perlu fuzzy library.
- Hasil kosong → "Tidak ditemukan" + hint. Keyboard: ↑↓ pilih, Enter buka.

## 3. Invariant & regression gates

1. Mobile /admin & semua halaman admin: 0 perubahan (visual + behavior).
2. Deep-link langsung ke semua route admin tetap jalan (refresh aman).
3. Back/forward browser + tombol back di halaman admin tetap benar.
4. Semua endpoint/logic backend: TIDAK tersentuh (frontend-only).
5. Dark mode: semua elemen baru pakai token M3 (bukan warna hardcoded).
6. Homerow/topbar tidak tersentuh (v0.13.5 baru user-verified).

## 4. QA checklist (Kanaka)

1. Desktop: /admin → sidebar; klik tiap modul → konten berganti tanpa reload penuh;
   item aktif ter-highlight; jump cepat antar modul.
2. Refresh di /admin/users (deep-link) → shell + konten + sidebar aktif benar.
3. Back browser dari /admin/users → /admin → tetap konsisten.
4. Mobile (≤767px): /admin identik seperti sekarang (launcher grid) — tidak berubah.
5. Search: "bintang" → CSAT; "qr" → WhatsApp; "jam" → Auto Reply; kosong/hapus →
   tutup; Enter → buka hasil pertama; ↑↓ navigasi.
6. Dark mode: sidebar + search + dropdown semua ikut tema.
7. Semua halaman admin tetap berfungsi normal di dalam shell (coba save config
   Menu Gateway — persist OK — regresi hotfix timeout tidak kembali).

## 5. Rollout & ROLLBACK (syarat Kanaka)

- Backup: (1) git tag `pre-v0.13.6-admin-sidebar` di commit sebelum merge; (2) backup DB
  `backup/pre-v0.13.6-<ts>.db` (prosedural, walau frontend-only).
- **Rollback script** (`scripts/rollback-v0136.sh`): `git checkout pre-v0.13.6-admin-sidebar
  -- wa-cs-hub/frontend/src` → `npm run build:frontend` → verifikasi build + curl health →
  log ke `logs/rollback-v0136.log`. TANPA restart server (frontend static). Idempoten.
- Commit + tag v0.13.6 lokal; PUSH DITAHAN sampai QA Kanaka USER-VERIFIED (Alita yang push).
- Frontend-only: schema/DB tak tersentuh; rollback = murni revert file + rebuild.