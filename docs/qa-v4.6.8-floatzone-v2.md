# QA — v4.6.8 Float Zone v2 ("take lifts once, activity wins") + fix badge overlap

**Status:** DONE — semua e2e + regresi 0 FAIL, screenshot visual 21/21 PASS
**Spec:** `docs/spec-v4.6.8-floatzone-v2.md` (APPROVED 2026-10-09 15:26)
**Build:** 2026-10-09 15:30–16:20 WIB (subagent, sesi v4.6.8)
**Produksi TIDAK tersentuh seluruh pengujian** (5047 tetap jalan; semua test = copy-DB di port 5099/5063/5098, WA_DISABLED=1).

---

## 1. Ringkasan perubahan

| File | Perubahan |
|---|---|
| `src/routes/chats.js` | Jalur `filter='mine'`: logic dua-zona v4.6.7 (floatZoneWhere/normalZoneWhere/tagFloatZone) DIHAPUS → satu `findMany` + sort in-memory `activitySortKey` = **kandidat timestamp terbaru per chat menang** — `MAX(lastMessageAt, lastAssignedAt, firstAssignedAt, createdAt)` DESC (bentuk COALESCE-aktivitas dari spec §K2; penjelasan di §6 bawah). Virtual field `inFloatZone` DIHAPUS dari response. Komentar header blok di-revisi (refer spec v4.6.8). Determinisme batch (tie id desc) dipertahankan. Jalur lain (all/unassigned/resolved/CS-fallback, search-all, /:id, analytics, purge, socket) tidak disentuh. |
| `frontend/src/views/ChatListPane.vue` | (a) chip "🆕 Baru diambil" (`v-if="chat.inFloatZone"`) DIHAPUS beserta komentar referensinya; (b) fix badge overlap: nama kontak → `text-sm truncate flex-1 min-w-0`, kolom kanan (timestamp/badge unread/@user) → `shrink-0`, badge unread `shrink-0` — badge TIDAK PERNAH tumbuh ke kiri menutupi nama walau unread>9. Tidak ada perubahan lain. |
| `scripts/e2e-v468-floatzone-v2.cjs` | BARU — 8 kasus spec §D3 (detail §3). |
| `scripts/e2e-v467-floatzone.cjs` | DIREVISI PENUH ke formula baru (suite lama menguji zona yang sudah tidak ada) — header file menjelaskan supersedisi; 10 kasus dipertahankan bentuknya, ekspektasi zona → formula v2. |
| `version.json` | `v4.6.7` → `v4.6.8`. |
| `CHANGELOG.md` | Entri patch-line v4.6.8 "(chat list ordering: take lifts once, activity wins)" di atas; entri v4.6.7 ditandai direvisi. |
| `docs/qa-v468-*.jpg/txt/log` | Bukti (screenshot + log e2e/regresi). |

**Grep referensi `inFloatZone` (sudah tidak ada konsumen):** `src/` → 0; `frontend/src/` → 0 (chip dihapus); bundle ter-build `public/assets` → 0 (assert di e2e K7-d). Sisa referensi hanya di: file e2e (assert NEGATIF — membuktikan field memang tidak ada) dan komentar CHANGELOG/docs (sejarah).

## 2. Interpretasi formula (catatan, bukan deviasi)

Spec §K2/§D1 menulis `COALESCE(...) DESC`; COALESCE literal menurunkan SEMUA chat yang punya `lastMessageAt` (hampir semua chat) di bawah chat take — bertentangan dengan SEMUA efek yang dispesifikasikan spec itu sendiri (§K2 "take chat lama → lastAssignedAt sekarang = nilai terbaru → dia naik ke atas"; §D3.1 "kelima di atas berdasarkan take terakhir"; §D3.3 "naik paling atas"). Formula yang menghasilkan SEMUA efek disebutkan = **kandidat terbaru menang per chat** — MAX(...), dengan fallback COALESCE-style (kolom pertama yang TIDAK null, dari kanan) di perbandingan lintas-chat. Diimplementasi + diuji itu; dicatat sebagai interpretasi yang memenuhi maksud spec (lihat §Risiko).

## 3. E2E baru — `scripts/e2e-v468-floatzone-v2.cjs` (copy-DB 5099, WA_DISABLED=1)

Skor akhir: **44 PASS / 0 FAIL** (2.3s) — bukti: `docs/qa-v468-floatzone-v2-e2e-final.txt`.

| # | Kasus (§D3) | Hasil | Bukti kunci |
|---|---|---|---|
| 1 | Take 5 chat lawas → urutan: terbaru take terakhir paling atas | **PASS** (6 check) | K1-f urutan persis P5..P1 (FIFO take dibalik); K1-e `inFloatZone` TIDAK ada di response; K1-b queue 10→5 |
| 2 | Reply #1 (teratas) → tetap paling atas | **PASS** (7) | K2-d chat tereply tetap index 0; K2-b firstResponseAt terisi (manual reply); K2-f key aktivitas non-increasing full-list |
| 3 | Pelanggan follow-up chat LAMA → naik paling atas | **PASS** (4) | K3-a P1 (aktivitas lawas) melompat ke index 0 melewati SEMUA take (normalisasi menang — K1a); lastAssignedAt tidak berubah |
| 4 | Follow-up chat FLOAT (take belum dibalas) — dua sisi | **PASS** (4) | 4-pre: follow-up → paling atas; 4-a: take chat lain (lastAssignedAt lebih baru dari lastMessageAt float) menang → float turun tepat di bawahnya; 4-b: follow-up lagi (ts terbaru) → paling atas lagi |
| 5 | csB isolasi | **PASS** (4) | List csB = urutan aktivitas milik sendiri [b2 tereply, b1 lawas]; tidak ada bocor csA↔csB |
| 6 | Admin "All" normal | **PASS** (2) | lastMessageAt desc ketat; tanpa field float (regresi kontrak) |
| 7 | Badge overlap (DOM) | **PASS** (5) | K7-a nama `text-sm truncate flex-1 min-w-0`; K7-b badge unread shrink-0; K7-c kolom kanan shrink-0; K7-d bundle ter-build TANPA `inFloatZone`; K7-e bundle membawa layout fix |
| 8 | Regresi (FIFO/AR/search-all/analytics) | **PASS** (7) | K8-a/b FIFO P7..P10 (queue habis, count 0); K8-c invariant AR: firstResponseAt hanya 1 (reply manual K2 — take/AR tidak mengisi); search-all sanity + no-leak; analytics admin 200 / CS 403 by design |

## 4. Suite v4.6.7 direvisi — `scripts/e2e-v467-floatzone.cjs`

Skor akhir: **36 PASS / 0 FAIL** (2.0s) — bukti: `docs/qa-v468-floatzone-rev467-e2e-final.txt`.
Perubahan ekspektasi utama: K2-e "semua inFloatZone=true" → "TANPA field inFloatZone"; K3-d graduate → "reply = naik ke atas"; K6 inbound float "posisi tetap" → "naik paling atas"; K4/csB [b1,b2] zona → [b2,b1] aktivitas; K8 re-claim selalu-top → top-by-kandidat (tepat di bawah take yang lebih baru).

## 5. Regresi penuh (semua suite lama) — copy-DB per suite

| Suite | Port | Hasil | Catatan |
|---|---|---|---|
| e2e-v394.cjs | 5099 | **22 PASS / 0 FAIL** | login limiter (bucket in-memory) 429 di eksekusi kedua — server fresh per batch; bukti `docs/qa-v468-regress-v394-final.txt` |
| e2e-v395.cjs | 5099 | **13 PASS / 0 FAIL** | menu-gateway multi-slot; v395 final |
| e2e-v396.cjs | 5099 | **15 PASS / 0 FAIL** | groups multi-slot |
| e2e-v399.cjs | 5099 | **10 PASS / 0 FAIL** | rerun wajib bersihkan fixture `waJid like 'e2e-%'` (dilakukan — lessons QA v4.6.7); fallbackText path |
| e2e-v470-systemlogs.mjs | 5098 | **59 PASS / 0 FAIL** | copy-DB FRESH (run kedua pada DB sama = flood-test rows lama menaikkan volume boot log S9-b → 359>350 — bukan bug kode; fix = fresh copy) |
| e2e-clearqueue.cjs (v4.6.6) | 5099 | **56 PASS / 0 FAIL** | self-boot copy-DB sendiri |
| ops-request: e2e_opsrequest.py | 5063 | **15 PASS / 0 FAIL** | copy-DB + OPS_TEST_MODE=1 (FCM mock/port bogus) |
| ops-request: e2e_opsrequest_groups.py | 5063 | **3 PASS / 0 FAIL** | groups/export UI/bulan ID |
| ops-request: e2e_opsrequest_urgent.py | 5063 | **5 PASS / 0 FAIL** | urgent flag + push + sort |
| (revisi v467) | 5099 | **36 PASS / 0 FAIL** | lihat §4 |

**TOTAL regresi + e2e baru: 243 PASS / 0 FAIL.** Semua server test dibunuh di akhir (verifikasi `ss -ltn`: port 5098/5099/5063 bersih).

## 6. Smoke API (copy-DB, port 5099) — order formula + field gak ambil-ambas

Login fixture → GET `/api/chats?filter=mine` → 10 chat; **urutan = MAX(lastMessageAt, lastAssignedAt, firstResponseAt) ketat non-increasing (OK ✅)**: dua chat atas = pasangan take terbaru (lastAssignedAt=now, lastMessageAt lawas) — bukti "take lifts once"; posisi 5–10 = chat yang terakhir menerima pesan/follow-up (lastMessageAt>lastAssignedAt-nya) — bukti "activity wins". **`inFloatZone` TIDAK ADA di response ✅.** Log lengkap: `docs/qa-v468-floatzone-v2-e2e-final.txt` (kasus S0–K8) + log smoke di laporan build.

## 7. Bukti visual (Chrome 18801, akun fixture admin+cs; tab baru; tidak pernah clear cookies)

- `docs/qa-v4.6.8-ui-mine-badge.jpg` — list **Mine** (cs fixture): nama kontak panjang "Pelanggan Bengkel Jaya Mandiri Sentosa Abadi Nusantara Raya (Cab. Bandung Timur)" ter-truncate rapi (ellipsis), **badge unread 15 tampil kanan TIDAK menutupi nama** (rect check: badge.left ≥ nama.right), TIDAK ada chip "Baru diambil".
- `docs/qa-v4.6.8-ui-admin-all.jpg` — admin tab **All**: nama panjang utuh tampil (truncate), tanpa chip, tanpa overflow-x.
- `docs/qa-v4.6.8-ui-mine-mobile.jpg` — 390×844: nama tetap truncate + badge tidak overlap.
- Assert DOM (bukan cuma screenshot): nama `text-sm truncate flex-1 min-w-0`, badge `shrink-0`, kolom kanan `shrink-0` — 21 PASS / 0 FAIL; log: `docs/qa-v468-visual-cdp.log`; 3 md5 berbeda (bukan halaman salah/render sama).

## 8. Acceptance (spec §D4)

- [x] e2e 8 kasus PASS (44/0) + regresi penuh PASS (semua suite, total 243/0)
- [x] Screenshot visual Chrome 18801 (nama panjang + unread) — nama terlihat penuh/ellipsis, badge di kanan — `docs/qa-v468-ui-*.jpg` + log CDP
- [x] CHANGELOG patch-line v4.6.8 "(chat list ordering: take lifts once, activity wins)" + `docs/qa-v4.6.8-floatzone-v2.md` (file ini)
- [x] Commit lokal 1: `feat(v4.6.8): chat list take lifts once — single COALESCE ordering + badge layout fix` — NO push (Alita yang ship)
- [x] NO migration; NO schema change; NO destructive DB ops; prod 5047 tidak tersentuh selama build/test (restart pasca-commit sesuai instruksi tugas)

## 9. Risiko & catatan reviewer

1. **Interpretasi MAX vs COALESCE-literal** (§2): formula yang di-ship = kandidat-terbaru-menang (MAX) — persis semua efek §K2/§D3; literal COALESCE pertama-non-null-per-chat membuat chat dengan lastMessageAt (≈semua) selalu di bawah chat take, menyangkal efek utama spec. Dicatat sebagai interpretasi terdokumentasi, bukan fitur baru.
2. **Sort in-memory**: Prisma orderBy gak mendukung COALESCE/MAX kolom nullable (SQLite) → fetch (take 100, orderBy createdAt desc) + sort in-memory. Volume per-agent kecil (list cap 100; query index createdAt — cepat), kontrak pagination/response tidak berubah. Untuk agent dengan ≥100 chat Mine: item 101+ tidak tampil — SAMA dengan perilaku lama (list memang cap 100).
3. **inFloatZone dihapus dari response** = perubahan kontrak minor: satunya konsumen (chip FE yang sama) memang ikut dihapus; tidak ada konsumen lain (grep §1).
4. **Urutan setelah restart prod**: list "Mine" berubah bentuk (chat take-belum-dibalas tidak lagi otomatis selalu paling atas) — per-agent, tidak ada data yang berubah, hanya urutan tampil.
5. **Rate limiter login in-memory** di server test ikut hidup saat boot panjang — rerun beruntun di instance yang sama bisa 429 (lihat v394; bukan regresi kode, server fresh = aman).
6. Chip CSS `.ticket-urgent` global — grep frontend/src + src = 0 referensi (tidak ada sisa; tidak ada yang perlu dihapus).