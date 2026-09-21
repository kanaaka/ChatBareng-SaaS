# WA CS Hub — v0.2.0 Spec: Mobile-First UI Restructure

**Status:** ✅ IMPLEMENTED & USER-VERIFIED — 2026-09-09, Kanaka: "tampilan mobile nya sudah bagus, semua yang kamu tulis sudah ter-apply" (Homerow/KebabMenu/ChatDetail/Blast tab/Settings terverifikasi ada di kode)
**Penulis spec:** Alita | **Eksekusi:** selesai (sebelum 2026-09-09)
**Tanggal spec:** 2026-09-01

---

## 0. Konteks & Tujuan

Kanaka melakukan mobile testing (iPhone, 2026-09-01) dan menemukan bahwa UI saat ini
adalah desktop-first yang "cukup jalan" di HP tapi tidak dirancang untuk HP.

**Target v0.2.0 — mobile experience yang benar:**
1. Bottom homerow navigasi (CS & Admin) menggantikan sidebar/topbar
2. List penuh → detail penuh (bukan split panel) di mobile
3. Chat view: header khusus + composer yang naik di atas keyboard
4. Konsolidasi menu: Blast History merge ke Blast; menu admin jadi satu halaman bertab
5. Desktop TETAP layout sekarang (split panel) — mobile view terpisah, responsif, bukan responsive-collapse dari desktop markup

**Prinsip:**
- Mobile & desktop share logic (stores, socket handlers, API), berbeda layout template
- Breakpoint: `md` (768px) — di bawah = mobile layout, di atas = desktop layout
- TIDAK mengubah backend/API sama sekali (kecuali tidak terhindarkan; catat di changelog)

---

## 1. Homerow (Bottom Navigation)

### 1.1 Struktur
Fixed bottom bar, `position: fixed; bottom: 0`, background putih, border-top tipis.
Ikon + label di bawah ikon. Active state = warna parahita purple.

**Homerow CS (4 ikon):**
| Ikon | Label | Route |
|------|-------|-------|
| 💬 | Obrolan | `/` (list chat) |
| 👥 | Kontak | `/contacts` |
| 📣 | Blast | `/blast` |
| ⚙️ | Pengaturan | `/settings` |

**Homerow Admin (5 ikon):**
| Ikon | Label | Route |
|------|-------|-------|
| 💬 | Obrolan | `/` |
| 👥 | Kontak | `/contacts` |
| 📣 | Blast | `/blast` |
| 🛠️ | Admin | `/admin` |
| ⚙️ | Pengaturan | `/settings` |

### 1.2 Perilaku
- Homerow hanya muncul di **list-level routes** (Obrolan/Kontak/Blast/Admin/Pengaturan).
- **TIDAK muncul di chat detail** (v0.2.0 memakai full-screen detail — lihat §3).
- Unread badge (angka) di ikon Obrolan = total unread chat milikku (CS) / semua (admin).
  Ambil dari existing `queueCount`? TIDAK — queue count ≠ unread. Badge = jumlah chat
  dengan `unreadCount > 0` di list milikku. Sudah ada datanya dari `GET /api/chats`.
- Safe-area: `padding-bottom: env(safe-area-inset-bottom)` (iPhone home indicator).
- Browser tab yang aktif: `router-link-active` styling.

### 1.3 Pengaturan page (baru, isi konsolidasi)
- Info akun: nama, username, role, cabang (untuk CS)
- Toggle notifikasi (existing `notif_enabled` + browser notif permission)
- **Logout** (pindah dari tempat sekarang ke sini)
- Status koneksi WA (untuk admin, ringkas — link ke Admin jika perlu)
- Yang TIDAK masuk sini: pengaturan sistem admin (tetap di Admin page)

### 1.4 Admin page (baru, konsolidasi)
Satu route `/admin`, tab di atas (horizontal scrollable chip): 
Pengguna · Template · Tag · Pengumuman · Purge · Sesi WA · Analytics
- Konten tiap tab = refactored dari komponen yang SUDAH ADA (Admin.vue saat ini
  berisi semuanya dalam satu halaman panjang — pecah jadi tab-komponen).
- Analytics jadi tab di dalam Admin (keputusan Kanaka 2026-09-01).
- Purge log, Sesi WA (QR pair) tinggal dipindah, tidak diubah logikanya.
- Desktop: Admin page juga memakai tab layout ini (satu struktur untuk kedua viewport).

---

## 2. Blast (merge + tab dalam)

- Route `/blast` — halaman dengan 2 tab dalam: **Kirim** & **Riwayat**.
- Kirim = `BlastComposer.vue` (existing, 753 lines) — dipakai apa adanya, bungkus tab.
- Riwayat = `BlastHistory.vue` + `BlastProgress.vue` (existing) — jadi tab kedua.
- Route lama `/blast/history`, `/blast/progress` → redirect ke `/blast?tab=riwayat`
  (preserve deep-link behavior).
- Nav item "Announcements"? → lihat §2.2.

---

## 2. Routing & Nav Restructure

### 2.1 Router changes (`frontend/src/router.js`)
```
/                → ChatList (mobile: list penuh; desktop: list+detail split)
/chat/:id        → ChatDetail (mobile: full screen; desktop: scroll-to dalam split)
/contacts        → Contacts (existing, tinggal bottom-nav chrome)
/blast           → Blast (tab Kirim/Riwayat)
/admin           → Admin (tabbed konsolidasi)
/settings        → Settings (rewrite, isi §1.3)
/login           → Login (existing)
```

### 2.2 Pengumuman & Templates & Analytics — KE MANA?
- **Pengumuman (announcements):** buka via ikon 🔔 di top bar (sudah ada
  AnnouncementBell). Gak perlu nav item. Halaman tetap ada (route `/announcements`),
  diakses dari bell → dropdown → "Lihat semua".
- **Templates:** hanya relevan untuk CS composer & admin manage. 
  - CS: akses template = di composer (quick message) — sudah ada fitur flyout "/" template.
  - Admin: tab Template di Admin page. 
  - Tidak ada nav item tersendiri.
- **Analytics:** tab dalam Admin (keputusan Kanaka).

### 2.3 Top bar list view (mobile)
Minimalis, sticky top:
- Kiri: nama app "WA CS Hub" (kecil, semibold)
- Kanan: 🔔 (announcements, dengan dot kalau ada unread) + tab filter aktif info
- **Queue banner** ("X chat baru di antrean" + tombol Take): tetap bottom-fixed,
  **di atas homerow** (bukan di top bar) — keputusan Kanaka eksplisit 2026-09-01 18:41.
  Z-index & spacing: di atas safe-area, di bawah homerow tidak menutup item list
  terakhir (list punya padding-bottom ekstra sebesar tinggi banner).

### 2.4 Filter chips (Mine/All/Unassigned/Resolved)
Horizontal scrollable chips row, sticky di bawah top bar. Same behavior as today.

---

## 3. Chat Detail (Mobile) — full screen

### 3.1 Header chat
```
← | Nama Kontak            | ⋮
  | status: open/resolved  |
```
- **← (back):** selalu ada, universal (untuk iOS yang tak punya tombol back).
  `router.back()` — kalau history kosong (direct link), fallback `router.push('/')`.
- **⋮ kebab menu** (kanan) — LIHAT §4. Tidak ada floating button.
- Header tinggi tetap ~56px, white bg, border-bottom. **Selalu di atas keyboard**
  (keyboard hanya mengangkat composer — §3.2 — header tetap top-fixed).

### 3.2 Composer (text field di atas keyboard)
- Composer fixed bottom dari viewport visual (bukan layout viewport).
- **WAJIB:** `viewport-fit=cover` + `interactive-widget=resizes-content` di meta
  viewport (index.html), PLUS JS `visualViewport` handler:
  ```js
  visualViewport.addEventListener('resize', () => {
    composer.style.bottom = `${window.innerHeight - visualViewport.height + visualViewport.offsetTop}px`
  })
  ```
  (Ini pola yang dipake WhatsApp Web mobile — tanpa ini, composer kepotong keyboard iOS.)
- Safe-area bottom di composer juga (iPhone keyboard atasnya ada gesture bar area).
- Isi composer tetap sama: text field + tombol attachment (📎) + quick message/template
  (flyout "/") + tombol kirim.
- **Tangan Kanan:** tombol di composer (di samping 📎) — buka sebagai full-screen sheet
  (slide-up), bukan panel samping. Sheet punya drag-handle bar di atas + tombol ✕.
  Existing TanganKanan.vue dipakai ulang, mode fullscreen mobile.

### 3.3 Kebab menu (⋮) isi:
```
Transfer ke CS  ▸   (submenu inline: daftar agent, tap = langsung transfer)
──────────────────
Release ke Antrean  (hanya jika assigned, warna orange)
Resolve Chat        (hanya jika open, hijau bold)
──────────────────
📎 Tangan Kanan     (buka media sheet)
```
- Semua handler yang ada sekarang (`handleTransfer`, `handleRelease` + confirm dialog,
  `handleResolve`) TIDAK diubah logikanya — hanya tombol trigger pindah ke kebab.
- Transfer submenu = existing `showTransferMenu` list, dirender dalam kebab sheet.
- Release pakai confirm dialog existing (`releaseConfirmOpen`).
- Setelah aksi sukses → toast existing tetap jalan.

### 3.4 Message list
- Full scroll area antara header dan composer.
- Scroll-to-bottom button melayang kanan-bawah (di atas composer), muncul hanya
  kalau scroll position jauh dari bottom.
- Typing indicator tetap di atas composer.

### 3.5 Desktop (≥768px)
- **Tidak berubah** — split panel list+detail seperti sekarang. Kebab menu di
  desktop juga aktif (konsisten), menggantikan tombol2 inline yang sekarang.

---

## 4. Socket & State — hal yang wajib tetap bekerja

1. `join_chat` / `leave_chat`: pindah list→detail→list harus join/leave dengan benar
   (sekarang ini terjadi di selectChat — pastikan dipanggil di mobile navigation).
2. Unread badge di homerow: recompute dari store saat `chat_update` / `new_message`.
3. `chats_purged`, `queue_update`, `chat_update`: handler existing dipakai ulang —
   HANYA view-layer yang berubah.
4. v0.1.23–27 fixes (counter antrean, TK image, purge real-clean, Kontak claim,
   chatlist refresh, resolve realtime) WAJIB tetap berperilaku sama — ini regression
   test wajib sebelum deploy.

## 5. Yang TIDAK berubah (explicit non-goals)

- Semua API/backend/DB
- Logika antrean, take-next, assign, release, resolve, purge, blast engine
- TanganKanan logic (media picker) — hanya presentation layer
- Notifikasi browser / fcm
- Desktop split-panel layout (≥768px)

## 6. Acceptance Criteria

- [ ] iPhone Safari + Android Chrome: list penuh, tap chat → full screen detail,
      back → kembali ke list dengan scroll position preserved
- [ ] Composer selalu di atas keyboard (iOS Safari + Android Chrome), tidak ada
      zoom-in otomatis (font-size input ≥16px)
- [ ] Homerow: 4/5 ikon sesuai role, unread badge benar, hilang di chat detail
- [ ] Queue banner tetap di atas homerow, tidak menutup item list, hilang di detail
- [ ] Kebab menu: Transfer (submenu), Release (confirm), Resolve, Tangan Kanan — semua
      berfungsi, perilaku sama dengan tombol lama
- [ ] Blast: 2 tab (Kirim/Riwayat), old routes redirect
- [ ] Admin page: 7 tab berfungsi = fungsionalitas Admin.vue + Analytics.vue sekarang
- [ ] Pengaturan: profil, notif toggle, logout
- [ ] Semua regression v0.1.22–27 tetap lolos (manual test script ada di §4)
- [ ] Desktop ≥768px: tidak ada regresi visual

## 7. Estimasi & Rencana Eksekusi (Dory)

- Dashboard.vue (2223 lines) dipecah: ChatList.vue, ChatDetail.vue, ChatHeader.vue,
  ChatComposer.vue, KebabMenu.vue, QueueBanner.vue, FilterChips.vue, Homerow.vue
- Stores & socket logic: tidak berubah, hanya diimport ulang dari komponen baru
- Estimasi: 1 sesi Dory (besar) + review Alita + QA Kanaka di 2 device nyata
- Frontend build saja, tanpa perubahan deploy (static dari disk, restart tidak perlu)

---
*Spec by Alita, decisions from Kanaka 2026-09-01 18:17–18:41 (Telegram).*
*Jangan eksekusi sebelum Kanaka approve spec ini.*