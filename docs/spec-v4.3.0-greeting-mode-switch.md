# ChatBareng v4.3.0 — Greeting Mode Switch (Teks / CB-AI / Menu) + Fix One-Way Door — SPEC

> Status: **APPROVED — GO 2026-09-30 14:42 WIB (Kanaka). Builder: Dory.**
> Asal laporan: QA Kanaka 2026-09-30 14:12 & 14:21 WIB (dua temuan, satu akar masalah).
> Builder (setelah GO): Dory • Spec/verifier/deployer: Alita • DB: **NOL kolom baru** — additive code only.

---

## 1. Ringkasan

Slot dengan Auto Reply teks aktif tidak punya jalan langsung untuk pindah ke Menu Gateway, dan begitu Menu Gateway nyala, **Outside-hours tidak bisa dinyalakan lagi** (pintu satu arah). Runtime sebenarnya sudah mendukung koeksistensi menu + outside-hours (D5 v0.13.0: malam = away text, jam kerja = menu) — yang salah hanya guard v3.9.4 + UX. Versi ini: bikin pergantian mode jadi **satu kontrol, satu klik, satu transaksi atomik**, per-slot, tanpa bolak-balik antar-halaman.

## 2. Temuan QA (verifikasi kode, 14:12–14:25 WIB)

| # | Temuan Kanaka | Akar di kode |
|---|---|---|
| 1 | Slot1 greeting = Teks → mau ganti ke Menu; radio "Menu gateway" abu-abu, dropdown slot di halaman Menu Gateway juga disabled | `AdminAutoReply.vue`: radio value `menu` sengaja `disabled` permanen (keputusan audit v4.2.0); `AdminMenuGateway.vue`: option slot `:disabled="s.arManaged"` |
| 2 | Harus untick outside-hours + greeting DUA-DUANYA baru menu bisa aktif — dan kalau menu nyala, outside-hours tidak bisa dinyalakan lagi | `menuGateway.js` v3.9.4 enable-guard: blok bila `greetEnabled OR outsideHoursEnabled` (over-block); `autoreply.js` PUT slot: `409` **seluruh body** bila row menu-managed → toggle outside-hours tak tersentuh dari halaman mana pun |

**Bukti runtime sudah dukung koeksistensi** (`services/autoReply.js` `maybeAutoReply`): cabang (a) `outsideHoursEnabled && outside → away text` dievaluasi **sebelum** cabang (b) `!outside && greetMode==='menu' && MG.enabled → startFlow`. Artinya kombinasi ON+ON legal oleh mesin; hanya guard-nya yang melarang.

## 3. Keputusan desain (PROPOSAL — final saat Kanaka GO)

| # | Keputusan |
|---|---|
| D1 | Mode greeting per-slot = **segmented control 3 pilihan: `Teks \| CB-AI \| Menu gateway`** — satu sumber kebenaran; langsung memetakan `greetMode` (`text`/`cbai`/`menu`) yang sudah ada di DB. CB-AI tetap plan-gated (radio disabled + tooltip bila plan ✗, pola existing). |
| D2 | Pergantian mode = **satu klik → satu transaksi atomik** (AR row + MG slot row + release-awaiting dalam `$transaction` yang sama). Tidak ada lagi jebakan "pergi ke halaman lain dulu". |
| D3 | **Outside-hours TIDAK lagi dianggap blokir** untuk mengaktifkan menu (D5 v0.13.0 tetap berlaku di runtime: outside menang di luar jam, menu hanya dalam jam). Yang "konten teksnya harus sadar dimatikan" hanya greeting `text`/`cbai` yang aktif. |
| D4 | Konfirmasi bukan blokir: bila slot punya greeting teks aktif, pindah mode → **modal konfirmasi** ("greeting teks slot ini akan dimatikan, diganti menu") — 200 dengan `confirm: true`, bukan 409. |
| D5 | Saat menu→teks/CB-AI: MG row slot **enabled=false tapi row+j+options DIPERTAHANKAN** (deviasi sadar vs reset-to-default v4.2.1 yang menghapus row — mode switch bukan reset; options admin harus selamat bolak-balik mode). Chats `awaiting` milik slot itu di-release + sweep (pola D12/master-off). |
| D6 | Saat teks/CB-AI→menu: MG row slot dibuat on-demand bila belum ada (prefill `introText/fallbackText/timeout/repeat` dari MG Default bila ada, else schema default; options kosong → admin lengkapi di halaman MG). AR row: `greetEnabled=true, greetMode='menu'` (sync `enableGreetForScope` pola existing). Outside-hours slot TIDAK disentuh. |
| D7 | **Default-scope** (segmented di view "Default (Semua nomor)") tetap boleh — tapi wajib modal konfirmasi (mengubah SEMUA slot pengikut). Per-slot tanpa konfirmasi penuh (hanya modal D4 bila ada teks aktif yang akan dimatikan). |
| D8 | `arManaged` di GET `/menu-gateway/options` dipecah: `arTextManaged` (greeting teks aktif — blokir→konfirmasi) vs `outsideOnly` (hanya outside-hours — **tetap selectable** + banner info "outside-hours tetap jalan di luar jam kerja"). Dropdown tidak lagi disabled cuma-karena-outside. |
| D9 | PUT `/api/autoreply/slot/:slot` saat menu-managed: field-scoped — `greet*` → 409 (pola v4.2.0 jalur `/default` yang sudah memilah), `outsideHours*`/jam/repeat → **200**. Rute slot sekarang blok seluruh body — diubah mengikuti pola default. |
| D10 | Dokumentasi (Guidebook): **klaim harian shared** — pelanggan yang sudah dapat auto message hari itu (dari jalur mana pun: menu/away/greet/CB-AI degrade) TIDAK dapat auto message kedua di hari sama (throttle 1×/hari v0.7.0; CB-AI active tidak pakai claim). Dicantumkan jelas, BUKAN diubah. |
| D11 | Zero behavior change untuk tenant yang tidak menyentuh UI baru; nilai lama tetap valid. Rute legacy tetap byte-compat. |

## 4. Perubahan teknis

### BE
1. `src/routes/autoreply.js` PUT slot: pecah 409 → hanya `greet*` fields saat menu-managed (D9).
2. `src/routes/autoreply.js` PUT slot/default: terima payload mode-switch; bila `greetMode` berubah ke `menu` → jalankan flip atomik D6 (create-on-demand MG row) dalam satu transaksi; dari `menu` → D5 (disable+keep row, release awaiting scoped).
3. `src/routes/menuGateway.js` enable-guard v3.9.4: hapus `outsideHoursEnabled` dari predikat blokir; sisa teks-aktif → respons `200 {confirmRequired, slots}` modal (bukan 409) untuk slot; scope shared/default tetap konfirmasi wajib (D7).
4. `GET /api/menu-gateway/options`: flag baru `arTextManaged`, `outsideOnly` (D8); `arManaged` tetap di-emit (backward-compat) tapi FE pakai flag baru.
5. Transaksi flip + release-awaiting: pola `releaseAwaiting` scoped existing (slot-scope), invalidasi DUA cache (AR + MG).

### FE
6. `AdminAutoReply.vue`: radio greetMode dinonaktifkan-permanen → **segmented control aktif**; CB-AI disabled bila plan ✗; modal konfirmasi D4/D7; hint menu-managed di-reword sesuai flow baru.
7. `AdminMenuGateway.vue`: dropdown pakai flag `arTextManaged` (disable hanya itu, dengan tombol-jalan-pintas ke switch); banner `outsideOnly` info bukan blokir; banner amber "punya AR teks aktif" → jadi tombol "Ganti lewat switch mode".
8. Guidebook: section baru D10 + cara pakai switch.

## 5. QA scenarios (e2e-v430 baru + regressi)

- S1: slot teks+outside aktif → switch ke menu → 200/konfirmasi → menu ON dan outside tetap ON; chat luar jam → away text; chat dalam jam → menu intro.
- S2: menu ON → PUT slot outsideHours+jam → 200 (field-scoped).
- S3: menu→teks: awaiting slot itu di-release; MG row tetap ada (enabled=false, options utuh); outside bisa dinyalakan tanpa kunjungi MG.
- S4: default scope switch → modal wajib; batal = tidak ada perubahan.
- S5: slot outside-only di dropdown MG → selectable + banner info (tidak disabled).
- S6: plan ✗ → CB-AI terkunci (pola existing).
- S7: repetisi/claim harian — menu pagi → away malam hari sama → tidak dobel.
- S8: regressi penuh e2e-v420 (57) + v421 (54) + v4121 (61) tetap PASS; build OK; visual QA CDP copy-DB.

## 6. Eksekusi (setelah GO)

Dory build (spec ini + e2e) → Kimi K3 audit → Alita verify + deploy (backup pre-build, restart by-PID, visual QA, health) → tag v4.3.0 → changelog.

## 7. Keputusan locked (jawaban Kanaka, 14:37-14:42 WIB)

- **O1 → Segmented control** (bentuk tombol 3-mode `[Teks | CB-AI | Menu gateway]` di kartu First-of-Day Greeting; halaman Menu Gateway menjadi tempat konfigurasi konten saja, bukan gerbang on/off).
- **O2 → KEEP (Opsi A)** — switch menu→teks hanya mengubah `enabled=false` pada row MG slot; row + seluruh options DIPERTAHANKAN. Penghapusan permanen tetap eksklusif lewat tombol "Reset ke Default" yang sudah ada di halaman Menu Gateway.
- **O3 → Cukup di Guidebook.** Info claim harian (D10) ditulis sebagai bagian baru halaman Guidebook; TIDAK ada banner/tooltip tambahan di halaman pengaturan (alasan Kanaka: frekuensi sapaan sendiri sudah diatur admin di pengaturan).