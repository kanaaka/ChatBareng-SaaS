# WA CS Hub (ChatBareng) — v0.12.0 Spec: Halaman Guidebook (Panduan Penggunaan)

**Status:** ✅ APPROVED Kanaka ("Okee betul opsi di pengaturan sama di publik login", 2026-09-10 00:36) — eksekusi: Dory (build) + Alita (verifikasi konten & visual)
**Penulis spec:** Alita | **Tanggal:** 2026-09-10

---

## 0. Tujuan

Satu halaman **Guidebook** berisi cara penggunaan + skenario semua fitur ChatBareng, dikelompokkan per role (Admin / CS / Cabang). Konten statis (di komponen, bukan DB). **Publik** (tanpa login) agar CS baru bisa membaca sebelum akun aktif; link dari Pengaturan & Login.

## 1. Halaman

- Route: `/guidebook` — **public** (TANPA meta auth — satu-satunya route non-login selain `/login`)
- Komponen: `views/Guidebook.vue` (statis, ikut design system M3 v0.9.0 — token, card, dark mode otomatis)
- **3 tab role di atas** (chip M3): 🛡️ Admin · 💬 CS · 🏪 Cabang — default **💬 CS**
- Tiap section: heading M3 + paragraf singkat + daftar langkah (step-by-step) + tips callout (`surface-variant`)
- Topbar ringkas: kembali (←) ke tempat asal (login / pengaturan), judul "📖 Panduan ChatBareng"
- Mobile: tab scrollable, konten satu kolom, touch target ≥44px

## 2. Link Menuju Guidebook (3 titik)

1. **Pengaturan (Settings.vue)** — kartu/list item baru "📖 Panduan Penggunaan" → navigasi `/guidebook`
2. **Login.vue** — link di bawah form: "📖 Panduan Penggunaan" (publik, tanpa login)
3. **Admin.vue** — kartu launcher "📖 Panduan" (mengikuti pola kartu admin existing)

## 3. Konten (wajib diimplement, prose Indonesia santai-profesional)

### 3.1 Tab 💬 CS (default)
- **Mulai**: login → homerow (Obrolan/Kontak/Blast/Pengaturan) → arti tiap tab
- **Alur harian chat**: pesan pelanggan masuk → antrean (banner + Take Next FIFO) → balas (teks/media/template `/`/Tangan Kanan) → favorite/star → **resolve** → CSAT otomatis keluar ke pelanggan (rating masuk Analytics)
- **Skenario: chat masuk pertama kali** — step-by-step
- **Skenario: pindahkan chat** — Transfer (pilih agent, hanya yang online untuk CS) / Release ke antrean / bedanya keduanya
- **Skenario chat gak bisa dibalas sekarang** — Snooze (preset/custom; pesan pelanggan membatalkan snooze)
- **Catatan internal** — toggle ✏️ di header chat; shared antar tim; TIDAK terkirim ke pelanggan
- **Pesan terjadwal** — ⏰ di composer, jadwal +2 menit minimal, cancel sebelum terkirim
- **Template pesan** — ketik `/` di composer, cari, insert; personalisasi {name}
- **Tangan Kanan** — shared file/folder; upload, insert ke chat, download
- **Search** — global (di chat list) & in-chat (Ctrl+F / ikon)
- **Kontak** — tab Kontak: daftar, edit nama, claim chat
- **Blast** — Kirim (CSV, personalisasi, rate limit) & Riwayat
- **Pengaturan** — profil, notifikasi, tema light/dark/system, logout

### 3.2 Tab 🛡️ Admin
- Semua kemampuan CS + tambahan:
- **Admin Panel (8 halaman)**: Pengguna (buat/hapus/reset pw), WhatsApp (sesi/QR), Purge (bersih-bersih riwayat + backup), Template, Tag, Pengumuman (broadcast + read stats), Analytics (chat, response time, CSAT per-CS), Backup Drive
- **Manual take & antrean** — admin bisa ambil manual; FIFO tetap
- **Auto Reply** — ON/OFF, teks greeting & outside hours, jam operasional per hari
- **CSAT Survey** — ON/OFF, teks survey, anti-spam (mode per_chat/per_agent/hybrid + jam cooldown)
- **Backup Google Drive** — hubungkan akun, jadwal, retensi (menunggu domain — status)
- **Export/Import history** — backup CSV, restore
- **Purge** — bersih-bersih chat lama (log tercatat)
- **Pengumuman** — broadcast + read stats
- **Tips**: gunakan Analytics untuk monitoring respon CS & kepuasan pelanggan

### 3.3 Tab 🏪 Cabang (relay)
- Apa itu akun Cabang: **menerima chat transfer** dari CS/Admin — TIDAK bisa take dari antrean
- Menerima chat → balas seperti CS (teks/media/template/catatan)
- Transfer-back hanya ke CS/Admin (bukan cabang lain)
- Chat masuk ke tab Mine; resolved milik sendiri
- Online status: chat hanya bisa di-transfer ke cabang yang online

## 4. Acceptance Criteria

- [ ] `/guidebook` bisa diakses TANPA login (dan tetap bisa dari dalam app)
- [ ] 3 tab role berfungsi; default CS; konten tiap role lengkap sesuai §3
- [ ] Link dari Pengaturan, Login (bawah form), Admin Panel → semua navigasi benar
- [ ] Mobile responsive + dark mode konsisten (token M3)
- [ ] Tidak ada regresi: login, chat flow, admin page tetap normal
- [ ] Konten akurat dengan perilaku v0.11.0 (CSAT ON/OFF, snooze cancel oleh pesan pelanggan, dll.)

## 5. Estimasi & Eksekusi

- 1 task Dory kecil-menengah (frontend only, konten dari spec) + verifikasi Alita (visual mobile/desktop, semua link)
- Deploy: rebuild frontend saja, tanpa restart

---
*Spec by Alita, approved Kanaka 2026-09-10 00:36.*