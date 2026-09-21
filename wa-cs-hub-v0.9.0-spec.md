# WA CS Hub — v0.9.0 Spec: UI Revamp — Material 3 Expressive

**Status:** ✅ APPROVED Kanaka ("gas", 2026-09-09 14:06) — eksekusi 2 fase: Fase 1 fondasi, Fase 2 penerapan. Logo: BELUM ADA → wordmark teks (§5b).
**Penulis spec:** Alita | **Eksekusi (nanti):** Dory
**Tanggal:** 2026-09-09
**Sumber keputusan:** Telegram Kanaka 2026-09-09 13:30–13:35
(keempat fitur Snooze/CSAT/Catatan/Pesan terjadwal = v0.10.0 SETELAH ini — UI dulu supaya fitur nanti tinggal nancep ke design system baru)

---

## 0. Konteks & Tujuan

Kanaka mau tampilan hub lebih modern. Keputusan terkunci:
1. **Bahasa desain: Material 3 Expressive** (pernah diriset untuk LocaSpark 2026-09-04 — catatan: MWC
   (Material Web Components) maintenance mode sejak 2024, jadi KITA PAKAI POLA HYBRID yang sama
   dengan LocaSpark: **M3 Design Tokens sebagai fondasi CSS + komponen buatan sendiri mengikuti
   spesifikasi M3**, BUKAN library web components MWC)
2. **Dark mode:** toggle manual + opsi "ikut sistem" (default follow `prefers-color-scheme`)
3. **Font:** boleh ganti → **Plus Jakarta Sans** (UI) + fallback system stack
4. **Layout: TETAP SAMA** — struktur sidebar/homerow/split-panel tidak diubah. Hanya bahasa visual
   (warna, radius, elevation, spacing, tipografi, komponen) yang dirombak.
5. **Accent color configurable oleh Admin** — warna aksen gak terkunci (bukan melulu ungu/ijo):
   admin pilih preset atau custom hex → skema light+dark diregenerasi global (lihat §1a)
6. **Login page di-revamp gaya Kreatr** — dual-layout: kiri panel brand + tagline, kanan form putih
   minimalis (§5a). Referensi: Kreatr 2026-08-25 (yang dulu di-verify Kanaka "mantap sih inii")
7. **Rename aplikasi: "WA CS Hub" → "ChatBareng — Aplikasi Agent Hub untuk WhatsApp"**
   (user-facing only — folder/repo/identifer teknis tetap, lihat §5b)

**Prinsip besar:**
- **Reskin, bukan restructure.** Semua route, logic, stores, socket, API nihil berubah.
- Desain harus menyediakan **slot** untuk fitur v0.10.0 (Snooze/CSAT/Catatan/Pesan terjadwal) —
  artinya komponen yang dibangun (menu, card, chip, dialog) cukup generik untuk menampung itu nanti.
- Mobile layout v0.2.0 (homerow, full-screen detail) TETAP berlaku — di-reskin dengan token baru.

---

## 1. Design Tokens (fondasi — `frontend/src/styles/tokens.css`)

CSS custom properties mengikuti skema M3 (`--md-sys-color-*`), dengan **palet brand Parahita**
(ungu — sejalan dengan identitas yang sudah ada):

```css
/* Light scheme (seed: Parahita purple) */
--md-sys-color-primary, --md-sys-color-on-primary,
--md-sys-color-primary-container, --md-sys-color-on-primary-container,
--md-sys-color-secondary(-container), --md-sys-color-tertiary(-container),
--md-sys-color-surface, --md-sys-color-surface-variant,
--md-sys-color-surface-container(-high|-highest),
--md-sys-color-on-surface(-variant), --md-sys-color-outline(-variant),
--md-sys-color-error(-container), --md-sys-color-success (= semantic extension)
/* Dark scheme: pasangan nilai masing-masing di bawah [data-theme="dark"] */

/* Shape scale */
--md-sys-shape-corner-none/-s/-m/-l/-xl  (4/8/12/16/28px)

/* Elevation (M3 level 0–5): shadow + surface tint */

/* Type scale (Plus Jakarta Sans) */
--md-sys-typescale-display/-headline/-title/-body/-label (large/medium/small)
```

- **Sumber warna:** default seed ungu Parahita — TAPI seed-nya **runtime-configurable** (lihat §1a:
  admin ganti accent → server regenerasi skema light+dark → token override di-serve global).
  Default tokens (ungu) ditulis di tokens.css sebagai fallback; override dimuat setelahnya.
- **Kontras:** semua pasangan on-*/container wajib lolos WCAG AA (cek manual di 2 tema).
- Dark scheme harus dipakai di SEMUA permukaan (bubble chat, drawer, dialog, admin) — bukan
  invert sederhana.

## 1a. Accent Color — Admin Configurable (server-generated runtime theming)

- Model additive: `AppearanceConfig { id @default(1), accentSeed String @default("#6D28D9"), updatedAt, updatedById Int? }` (singleton, seed default = ungu Parahita, samakan dengan tokens.css)
- Dependency BARU (satu-satunya): `@material/material-color-utilities` — library resmi Google untuk generasi tonal palette M3, dipakai **DI SERVER saat save saja** (bukan UI framework)
- Alur: Admin pilih accent (preset: Ungu Parahita / Merah Kreatr #C72C48 / Hijau WA #25D366 / Biru / Teal / Orange + custom hex picker) → `PUT /api/appearance` (admin) → server generate skema lengkap light+dark (semua `--md-sys-color-*`) → simpan JSON di DB → di-serve sebagai `GET /theme.css` (public, no-auth, in-memory cache + invalidate saat PUT)
- `frontend/index.html` memuat `<link rel="stylesheet" href="/theme.css">` SEBELUM bundle app — karena override menyasar variable yang sama dengan tokens.css, SEMUA komponen otomatis ikut tanpa logic per-komponen. Route ini harus resilience: DB error → serve css kosong (fallback ke default), bukan crash
- UI admin: kartu "🎨 Tampilan" di Admin (color swatches preset + custom hex input + preview mini light/dark)

## 2. Theming & Toggle Dark Mode

- **3 mode:** Light / Dark / **System** (default) — key `themeMode` di `localStorage`.
- Implementasi: `data-theme="dark"` di `<html>`; init script inline di `index.html`
  (anti-flash-of-wrong-theme sebelum Vue mount); `matchMedia('(prefers-color-scheme: dark)')`
  listener live-update saat mode=System.
- Toggle 3-segmen di halaman **Pengaturan** (+ ikon cepat di top bar list view — opsional, boleh Fase 2
  kalau mepet). Semua halaman ikut (Dashboard, Blast, Admin, Login, dsb).

## 3. Tipografi & Spasi

- **Font: Plus Jakarta Sans** — self-host via `npm @fontsource/plus-jakarta-sans` (latin subset,
  weights 400/500/600/700/800) — BUKAN CDN runtime (app internal, kadang koneksi jelek).
- Terapkan type scale di semua heading/body/label — ukuran body min 14px, input min 16px
  (anti zoom-iOS, konsisten v0.2.0).
- Spasi 4pt grid: ganti padding/margin acak jadi kelipatan token spacing.

## 4. Komponen (dibuat manual, mengikuti spesifikasi M3 — Tanpa MWC)

Rombak komponen yang SUDAH DIPAKAI (jangan perkenalkan library baru):
- **Button** (filled, tonal, outlined, text + state layers + ripple halus) — utk semua tombol existing
- **Card** (elevated/filled) — halaman admin, kartu pengaturan
- **Chip** — filter chips chat (Mine/Unassigned/All/Resolved), tag di chat list
- **Dialog** — ganti semua `confirm()`/`alert()` native jadi M3 dialog (transfer, release, purge,
  hapus user, dsb. — perilaku handler TIDAK berubah, hanya wadahnya)
- **Snackbar/Toast** — ganti toast stack existing dengan gaya M3 (API sama)
- **Text field (outlined)** — form login, composer, form admin (label mengambang, min 16px)
- **Switch & Checkbox** — toggle pengaturan (autoreply, backup, notif)
- **Menu (dropdown/kebab)** — KebabMenu chat + menu admin, penerbangannya M3 (elevasi 2, radius L)
- **Bottom sheet** (mobile) — Tangan Kanan mode sheet tetap, di-reskin
- **List item** — chat list, kontak, user list (state hover/active/selected konsisten)
- **Badge & status indicator** — unread, online dot (presence), badge "⚙️ Otomatis"

## 5. Penerapan per Halaman (reskin semuanya, layout tetap)

| Halaman | Perubahan visual |
|---|---|
| Login — revamp gaya Kreatr (§5a) | Dual-layout desktop: kiri panel brand accent + tagline, kanan form putih minimalis; text field outlined M3 |
| Dashboard (chat) | Chat list = M3 list item; filter chips; composer = surface-container-high; bubble keluar = primary-container; masuk = surface-container; timestamp/meta pakai on-surface-variant |
| Chat detail (mobile) | Header surface, kebab menu M3, badge otomatis di-reskin |
| Blast (Kirim/Riwayat) | Form card + progress bar M3 (linear) |
| Admin (semua tab) | Kartu, table/list, dialog aksi, switch, badge status |
| Pengaturan | Toggle tema 3 mode + switch notif |
| Kontak / Tangan Kanan | List item + sheet reskin |
| Loading/empty state | Ilustrasi sederhana + teks type scale (opsional skeleton shimmer) |

**Transisi:** halus & bermakna saja (150–250ms, ease standard) — dialog/sheet/menus; JANGAN animasi
berlebihan (performa mobile tetap prioritas).

### 5a. Login Page — gaya Kreatr (dual-layout)

Desktop ≥768px (pola Kreatr yang dulu di-verify Kanaka):
- **Kiri (±55%) panel brand:** permukaan dari accent color (gradient tonal halus + bentuk dekoratif M3 yang lembut), nama **ChatBareng** besar (display type), tagline "Aplikasi Agent Hub untuk WhatsApp"
- **Kanan (±45%): form minimalis** — icon/logo kecil, heading "Masuk", text field outlined (username, password), tombol filled full-width, pesan error inline M3
- Dark mode: kedua sisi ikut token (panel kiri = accent tonal gelap, kanan = surface)
- Mobile <768px: panel kiri disembunyikan → form full-screen + brand header kecil di atas
- **Logika auth TIDAK berubah** — hanya presentation

### 5b. Rebrand: "WA CS Hub" → "ChatBareng"

**Logo: BELUM ADA (keputusan Kanaka 14:06 — jangan buat/generate logo).** Pakai **wordmark teks**:
tulisan "ChatBareng" dengan Plus Jakarta Sans weight 800 (login panel besar, top bar, form header kecil).
Sediakan SLOT logo (1 komponen `BrandLogo.vue`: kalau nanti ada file logo, tinggal swap) —
manifest PWA icons: PAKAI icon existing (jangan dibuat baru), catat sebagai pending item pasca-logo.

- User-facing ONLY: `<title>` ("ChatBareng — Aplikasi Agent Hub untuk WhatsApp"), login page, label di top bar, manifest PWA (name "ChatBareng — Aplikasi Agent Hub untuk WhatsApp", short_name "ChatBareng", theme_color ikut accent), semua teks UI yang nyebut "WA CS Hub"
- TIDAK di-rename: folder repo (`wa-cs-hub/`), package name, prefix log, nama proses, DB, endpoint — zero risiko teknis
- Sweep: grep "WA CS Hub" di frontend/src — semua kemunculan user-facing diganti

## 6. Batasan Teknis

- **Tanpa refactor logic:** tidak menyentuh stores, socket handler, routes, schema. Hanya
  `<template>`/`<style>` + file CSS baru + sedikit script untuk theming (index.html, Pengaturan).
- **Tanpa library UI baru** (tidak menginstal Vuetify/Quasar/MWC) — komponen manual mengikuti M3. SATU pengecualian: `@material/material-color-utilities` untuk generasi palette di server (§1a — utility, bukan UI framework)
- Tailwind tetap ada: utility untuk layout; warna/shadow/radius lewat token (extend config Tailwind
  membaca CSS variables) — hindari hardcode hex di component.
- Bundle: font + tokens menambah ±40–80KB — acceptable; jangan blok render (font-display: swap).
- Browser target: sama dengan v0.2.0 (Chrome/Edge 120+, Firefox 119+, Safari 16.4+).
- Aksesibilitas: focus ring jelas (token), kontras AA, touch target ≥ 44px di mobile.

## 7. Non-goals (explicit)

- Mengubah layout struktur (sidebar/homerow/split) — kecuali perbaikan kecil yang terlihat "rusak"
  di bawah token baru (catat per kasus di report)
- Mengubah fungsi apapun (chat, blast, admin, autoreply, backup)
- Animasi dekoratif berat (parallax/spring), splash screen, dsb.
- Fitur v0.10.0 (snooze/CSAT/catatan/pesan terjadwal) — cukup disiapkan slot-nya

## 8. Acceptance Criteria

- [ ] Semua halaman (login, dashboard, blast, admin 7 tab, pengaturan, kontak) memakai token baru —
      tidak ada warna hardcoded lama yang bentrok
- [ ] Dark mode: toggle 3 mode bekerja, persist setelah reload, mode System mengikuti OS live,
      TIDAK ada flash tema salah saat buka app
- [ ] Font Plus Jakarta Sans termuat (self-hosted), fallback aman tanpa FOUT parah
- [ ] Semua confirm()/alert() native di alur utama sudah jadi M3 dialog (cek transfer/release/purge/delete)
- [ ] Bubble chat, chips, badge otomatis, presence dot — konsisten di light & dark
- [ ] Mobile (iPhone Safari + Android Chrome): homerow, detail penuh, komposer di atas keyboard —
      semua tetap bekerja; target sentuh ≥44px
- [ ] Tidak ada regresi perilaku: kirim/terima chat realtime, transfer/release/resolve, blast,
      autoreply, backup, analytics angka tetap
- [ ] Lighthouse (opsional): tidak turun signifikan dari baseline saat ini
- [ ] **VISUAL M3 CONFORMANCE CHECK (per permintaan Kanaka 14:10) — Alita screenshot + analisa tiap komponen di light+dark × mobile+desktop:** progress bar blast (linear, rounded track+indicator), semua varian button (filled/tonal/outlined/text + state layer), chips, dialog (shape + elevation + scrim), snackbar, text field outlined (label mengambang), switch, badge, kebab menu, bottom sheet, bubble chat. Yang belum sesuai M3 Expressive → catat + revisi Dory, JANGAN di-deploy sebelum lolos
- [ ] Admin ganti accent (preset & custom) → light+dark di SEMUA halaman ikut, persist setelah restart server & reload, tanpa rebuild frontend
- [ ] Login dual-layout gaya Kreatr di desktop (kiri brand panel + tagline, kanan form); mobile = form + header kecil; dark mode konsisten
- [ ] Rebrand: title bar, PWA install prompt (manifest), login, top bar = "ChatBareng"; tidak ada sisa "WA CS Hub" user-facing
- [ ] `/theme.css` tetap jalan (fallback kosong, bukan crash) saat DB bermasalah; route ini tanpa auth tapi hanya-baca

## 9. Rencana Eksekusi (Dory) & Verifikasi (Alita)

- Urutan kerja: tokens.css + theming → komponen inti (button/card/chip/dialog/toast/field) →
  penerapan per halaman (login → dashboard → detail → admin → blast → pengaturan) → dark pass
  menyeluruh → mobile pass → regression QA
- Estimasi: 2 sesi Dory (bundle besar, frontend only) + verifikasi visual Alita per fase
  (pola visual-verify-wa-cs-hub.js: screenshot light+dark × mobile+desktop) + QA Kanaka di HP.
- Regression wajib: daftar v0.1.22–27 + v0.7.x + v0.8.0 (semua fitur yang pernah QA).
- Deploy: frontend build saja, tanpa restart server (static dari disk); commit + push GitHub
  setelah user-verified.

---
*Spec by Alita, decisions from Kanaka 2026-09-09 (Telegram). Jangan eksekusi sebelum Kanaka approve.*