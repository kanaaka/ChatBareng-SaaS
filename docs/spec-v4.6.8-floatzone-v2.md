# Spec v4.6.8 — Float Zone v2: "Lift Sekali" + fix badge overlap di chat list

**Status:** APPROVED 2026-10-09 15:26 (Kanaka — semua keputusan terkunci §K)
**Parent:** spec-v4.6.7-floatzone.md (SHIPPED — PR #8, merged & deployed 8 Okt)
**Origin:** lapor Kanaka 14:46 (plus bug visual badge): v4.6.7 zona float jadi "klub nginep" — chat yang di-TAKE-BARU selalu mengalahkan chat yang dibalas → chat "dibalas" malah tenggelam di bawah daftar → agen tidak menyadari bahwa sebuah pesan telah dibalas. Ditambah: chip "🆕 Baru diambil" + badge tidak dibaca menutupi nama kontak (bug visual — cek di ChatListPane.vue:248-255).

---

## K — Keputusan Terkunci (Kanaka 14:46 + 15:26)

1. **Lift = SEKALI, event-driven (bukan timer):** chat baru di-take → muncul di zona atas SEKALI. Dia kehilangan posisi khusus begitu ada kandidat timestamp lebih baru — dua pemicu:
   (a) `lastMessageAt`-nya sendiri berubah lebih baru dari kandidat lain (mis. **pelanggan membalas ulang/kejar** — chat yang lama masuk lagi dengan pesan baru melewati semua chat tanpa membalas/melakukan take) — K8 lama DIBATALKAN: sekarang pelanggan yang menindaklanjuti (follow-up) = memicu normalisasi urutan seperti chat biasa;
   (b) agent membalas pertama (lulus — behavior v4.6.7 dipertahankan).
   Jadi bukan kedaluwarsa berbasis waktu — berbasis perbandingan timestamp penuh: begitu `lastMessageAt` chat float tidak lagi "terbaru antara semua kandidat", dia turun normal.
2. **Formula urutan "Mine" (baru):**
   - Semua chat milik agent, **diurutkan TIDAK lagi oleh zona** — cukup: sortBy **`coalesce(lastMessageAt, lastAssignedAt, firstAssignedAt, createdAt)`** (aktivitas terakhir PENGUNJUNG/PEMBALASAN dulu = timestamp; take terjadi = lastAssignedAt sebagai nilai dasar) — DESC.
   - Efeknya: take chat lama → `lastAssignedAt` sekarang = nilai terbaru → dia naik ke atas. Pelanggan membalas chat lama → lastMessageAt-nya lebih baru dari take → dia melebihi. Agent membalas → lastMessageAt ter-update (dan mungkin melebihi take yang lain).
   - **Semua aturan v2 dihapus: TIDAK ada zona terpisah, TIDAK ada inFloatZone** — satu urutan, satu formula. (Ini implementasi yang lebih sederhana daripada v4.6.7!)
3. **chip "🆕 Baru diambil":** TIDAK diperlukan lagi (urutan sudah ekspresif tanpa zona) — chip lama dihapus dari ChatListPane (kondisi `chat.inFloatZone` sudah tidak ada — BE field juga dihapus). Bersih-bersih: hapus kelas CSS global `.ticket-urgent` juga jika masih ada sisa dari sebelumnya (tidak ada kaitannya, hindari kebingungan). Ini adalah jalan keluar yang bersih.
4. **Bug visual (mengatasi tumpang tindih badge):** nama kontak harus terlihat di SEMUA kondisi: (a) markup daftar obrolan: badge tidak dibaca & indikator lain TIDAK PERNAH menutupi nama — cek overflow/width/kurungan; (b) fix yang dilakukan di ChatListPane.vue (baris 244-260 area) — layout baris kontak: nama kiri (flex-1, min-width, ellipsis), badge kanan (flex-shrink-0) — TIDAK BISA tumbuh ke arah kiri; (c) screenshot verifikasi visual via Chrome 18801 (akun admin) sebelum commit — wajib.
5. **Regresi:** semua e2e v4.6.7 DIREVISI sesuai formula baru (zona tidak ada lagi); e2e lama lainnya (isolasi/paging/take-FIFO) tetap harus lulus.

## D1 — BE (src/routes/chats.js — jalur "Mine"))

- Hapus zona-dua (logika v4.6.7) di handler list `filter==='mine'` — satu query:
  `'mine'` → semua chat assignedToId=user.id, sort via orderBy computed: SQLite: `COALESCE(lastMessageAt, lastAssignedAt, firstAssignedAt, createdAt) DESC` (pakai `prisma.$queryRaw` bila orderBy field bawaan Prisma tidak mendukung COALESCE pada kolom nullable — atau alternatif: fetch + sort in-memory (data volume kecil per agent) — pilih paling minimal-diff TANPA mengubah kontrak paging; pastikan pagination/search di ujung tersebut tetap berjalan normal).
- Hapus virtual field `inFloatZone` dari respons (TIDAK dibutuhkan lagi).
- Komentar kode update (menghapus referensi float-zone lama — tetap menyebut spec ini).

## D2 — FE (frontend/src/views/ChatListPane.vue)

- Hapus chip v-if="chat.inFloatZone" (blok 248-255) + referensi CSS-nya.
- **Fix visual nama ketutupan:** baris kontak (nama + badge tidak dibaca + chip lain) — struktur: `nama (flex-1 min-w-0 truncate)` + `badge/indikator (shrink-0 ml-auto)` — uji dengan: nama panjang + unread>9 + baru-take; screenshot verifikasi.
- Tidak ada perubahan lain (toast/badge lain tetap).

## D3 — E2E (scripts/e2e-v468-floatzone-v2.cjs — pola harness existing, copy-DB + port test)

1. Ambil 5 chat lama (lawas) oleh csA → urutan: kelima di atas berdasarkan take terakhir (terbaru di atas).
2. csA membalas chat take #1 → dia tetap di area atas (lastMessageAt jadi terbaru) & TANPA kejanggalan; chat take lain tetap di posisi sebelumnya (urut lastAssignedAt).
3. Pelanggan menindaklanjuti chat lama BELUM di-take (chat baru inbound → lastMessageAt lebih baru dari semua lastAssignedAt) → chat tadi naik ke paling atas (K1a — normalisasi menang).
4. Pelanggan menindaklanjuti CHAT FLOAT (sudah di-take, belum dibalas) → lastMessageAt-nya lebih baru dari lastAssignedAt-nya sendiri → dia tetap di atas, tetapi **pemeriksaan penting**: dibandingkan dengan chat yang di-take lebih baru → jika lastMessageAt float-chat > lastAssignedAt chat take-lain → dia tetap di atas; jika tidak → turun. (Periksa kedua sisi).
5. csB isolasi (list milik csB tetap normal & tidak terkena dampak csA).
6. Admin "All": tetap timestamp normal (periksa regresi).
7. **Badge overlap visual:** HTML card: nama node + badge node → layout properti: `flex-1 min-w-0 truncate` pada nama, `shrink-0` pada badge — assert dari DOM (bukan screenshot) + screenshot manual.
8. Regresi: take-FIFO queue + batch-take + AR invariant + search-all + analytics — all PASS.

## D4 — Acceptance

- [ ] e2e 8 kasus PASS + regresi penuh (semua suite) PASS
- [ ] Screenshot visual via Chrome 18801 (akun admin, daftar obrolan dengan chat panjang + unread) — nama terlihat penuh — dibuktikan di docs/qa (lampiran)
- [ ] CHANGELOG entri patch-line v4.6.8 "(chat list ordering: take lifts once, activity wins)" + docs/qa-v4.6.8-floatzone-v2.md
- [ ] commit lokal 1: `feat(v4.6.8): chat list take lifts once — single COALESCE ordering + badge layout fix` — NO push (Alita yang kirim)
- [ ] NO migration; NO destructive; prod 5047 tidak tersentuh

## Catatan build

- Estimasi: build terkecil minggu ini (murni logika sortir + pembersihan chip + perbaikan tata letak CSS) — target < 20 menit.
- Catatan penting: penghapusan inFloatZone = PERUBAHAN KONTRAK API kecil — pastikan tidak ADA konsumen lain (cari sekali semua referensi sebelum menghapus).
- versi.json → v4.6.8 sekalian.