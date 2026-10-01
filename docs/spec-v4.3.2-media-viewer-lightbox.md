# Spec v4.3.2 — Media Viewer (Lightbox + Zoom Controls)

> Origin: Kanaka lapor 2026-10-01 11:55 — "di ChatBareng ternyata kita gabisa buka media yang dikirim dari pelanggan. Jadi gambarnya di klik ga muncul tampilan apa apa. kasih fitur itu dong jadi bisa kebuka, terus bisa ada tombol zoom in dan zoom out nya"
>
> Tipe: CODE-ONLY frontend fix + feature. NO schema change, NO backend change, NO new npm dep.

## Root cause (verified via recon, 2026-10-01)

1. `frontend/src/views/ChatDetail.vue` baris 460 (image) & 479 (sticker) memanggil
   `@click="openLightbox(msg)"` — **fungsi `openLightbox` TIDAK PERNAH didefinisi**.
   Klik gambar → runtime TypeError → tidak terjadi apa-apa. Ini bug-nya.
2. `frontend/src/views/Dashboard.vue` baris 296-304: ada lightbox modal (backdrop
   hitam + X + img) dengan ref `lightboxImage` (baris 414) — **dead code**: tidak ada
   satu pun assignment selain `null`. Modal unreachable.

## Scope

### D1 — Komponen baru `frontend/src/components/MediaViewer.vue`

Fullscreen image viewer, Teleport ke `body`. Props: `src` (String, wajib),
`caption` (String, optional), `alt` (String, optional), `downloadUrl` (String,
optional — default = `src`). Emit: `close`.

Fitur WAJIB (permintaan eksplisit Kanaka):
- Backdrop fullscreen gelap (pola `Dashboard.vue` existing: `fixed inset-0 bg-black/80 z-50`).
- **Tombol Zoom In (➕) dan Zoom Out (➖)** di toolbar overlay.
  - Zoom in: step ×1.25 per klik, clamp max 8×.
  - Zoom out: step ÷1.25 per klik, clamp min 1× (clamp ke 1, jangan biar lebih kecil).
  - Klik zoom-out saat sudah 1× = no-op (tidak disable, cukup no-op + tombol tetap tampil).
- Indikator persentase zoom (mis. "150%") di toolbar.
- Tombol Reset (1×) + tombol Tutup (✕).
- `Esc` = close. Klik backdrop = close. Klik gambar sendiri = TIDAK close (biar bisa pan).
- Download: teruskan prop `downloadUrl` → reuse pola download existing (endpoint
  `/api/media/:id?token=` sama persis).
- Caption (`msg.content`) tampil di bawah gambar kalau ada — styling aman dibaca di
  backdrop gelap (text-white/80, max-width, break-words).

Zoom & pan implementation (vanilla, tidak ada dep):
- `<img>` di-wrap container dengan `overflow: hidden`; transform:
  `translate(x px, y px) scale(s)` pada img; `transform-origin: 0 0`.
- Pan: pointer events — drag ketika `scale > 1` (pointerdown/move/up pada img);
  kalau scale == 1, drag tidak aktif.
- Zoom on wheel di atas viewer: step kecil (×1.1 / ÷1.1), zoom ke arah posisi kursor.
- Zoom-to-cursor saat tombol klik: zoom relatif terhadap pusat viewport (cukup baik),
  P2 (boleh defer): zoom-to-point kursor presisi.
- P2 (boleh ditunda tanpa melanggar scope): pinch-zoom 2 jari di mobile.
  Kalau implementasi touch 2 jari simpel sekali jalan — gabung; kalau ribet — jangan,
  tombol saja sudah memenuhi permintaan.
- Keyboard: `+`/`=` zoom in, `-` zoom out, `0` reset, `Esc` close.

A11y kecil: tombol punya `title` + `aria-label`; viewer set `role="dialog"`.

### D2 — Wire ChatDetail.vue (memperbaiki bug utama)

- Import `MediaViewer`.
- Tambah state `const viewerMsg = ref(null)`.
- **Definisikan `function openLightbox(msg) { viewerMsg.value = msg }`** — inilah
  fix root cause (fungsi dipanggil template tapi belum ada definisi).
- Render `<MediaViewer v-if="viewerMsg" :src="mediaUrl(viewerMsg)"
  :caption="viewerMsg.content" :download-url="mediaUrl(viewerMsg)"
  @close="viewerMsg = null" />` di root ChatDetail.
- Ekstrak helper `mediaUrl(msg)` kecil: `` `/api/media/${msg.id}?token=${auth.token}` ``
  dan gunakan ulang di branch image/sticker (jangan duplikat string token 4x lagi).
- Branch yang memanggil viewer: `image` (baris ~460) dan `sticker` (baris ~479) —
  `@click="openLightbox(msg)"` tetap, sekarang berfungsi.
- Video/audio/document TIDAK diubah (sudah native controls / link download).
- REKON TAMBAHAN (verified 11:56): satu-satunya tempat yang render media pesan adalah
  ChatDetail.vue — TanganKanan.vue tidak punya `<img>` message-media (hanya
  uploadPreview), komponen lain tidak memakai `/api/media/:id` GET. Scope wiring
  beres di ChatDetail. Route mobile `/chat/:id` (router.js:48) render Dashboard.vue
  yng memuat ChatDetail sebagai sheet — karena viewer pakai Teleport ke body, case
  mobile fullscreen otomatis ke-cover, tidak perlu wiring terpisah.

### D3 — Bersihkan dead code lightbox Dashboard.vue

- Hapus blok modal lightbox (baris ~296-304) + ref `lightboxImage` (baris ~414)
  yang tidak pernah ter-set. Modal ini unreachable (0 assignment non-null).
- KONFIRMASI DULU via grep sebelum delete: `lightboxImage` hanya dipakai di 2 baris
  itu + ref. Kalau ternyata ada pemakaian lain, STOP dan laporkan (jangan hapus).

### D4 — Build & regresi

- `npm run build:frontend` → output `public/`.
- Pastikan bundle berisi MediaViewer (grep nama file chunk di `public/assets/`).
- Sanity regresi: `node scripts/e2e-v431.cjs` (baseline 53/53 — backend tidak
  tersentuh; jika ada fail, diff dulu vs baseline sebelum klaim regresi).
- Git: JANGAN commit/tag/push — job lain (meta-ads-suite-finish) sedang berjalan di
  repo yang sama; git dilakukan oleh Alita setelah kedua job tuntas (mencegah race
  index lock). Lapor hasil build + e2e saja.

## QA plan (aku, setelah Dory selesai)

1. Prod/lokal: buka chat Parahita yang ada gambar pelanggan → klik gambar → viewer
   terbuka (sebelumnya: klik mati).
2. Zoom in 3× → 250% → zoom out balik → 100% → reset.
3. Esc + klik backdrop close. Download button masih jalan.
4. Sticker juga kebuka di viewer.
5. Video/audio/document: perilaku tidak berubah.
6. Mobile sheet (ChatDetail fullscreen mobile): viewer tetap overlay penuh (Teleport
   body) — cek di viewport seluler Chrome devtools.
7. e2e-v431 sanity 53/53.

## Deploy checklist (aku)

1. Backup DB (VACUUM INTO — walau code-only, tetap sesuai pipeline).
2. Deploy `public/` hasil build + restart app by-PID.
3. Smoke: GET /health 200; buka dashboard, klik media pelanggan → viewer jalan.
4. Tag `v4.3.2` + push + release notes (changelog entry).
5. Commit message pola repo: `feat(v4.3.2): media viewer lightbox + zoom (openLightbox undefined fix)`.

## Batasan

- NO schema change, NO backend code change, NO npm dep baru.
- Jangan sentuh SaaS backend JS sama sekali (frontend + build saja).
- Jangan sentuh pipeline lain (Meta Ads suite = repo sama beda area; tunggu job
  meta-ads-suite-finish tuntas SEBELUM commit/tag supaya git history tidak saling
  tabrakan — koordinasi oleh Alita).