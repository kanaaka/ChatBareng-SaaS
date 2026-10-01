# Spec v4.4.0 — Blue Ticks + Take-Without-Open + Tag Exclude-Queue + Resolve Button

> 4 fitur dari Kanaka (2026-10-01 13:27–13:31, disetujui "langsung semua fitur").
> Semua recon di bawah SUDAH diverifikasi di kode (baris/file nyata, berasal dari sesi Kerja 2026-10-01).
> **DORORY: tulis kode; JANGAN commit/push/tag (identitas git salah + itu tugas Alita). JANGAN sentuh DB prod/port 5047/tunnel/config.**

## Repo & build
- App root: `/home/kanakxxx/.openclaw/workspace/wa-cs-hub-saas-v3`
- FE build: `cd frontend && npm run build` (output → `../public/`) — HARUS PASS di akhir.
- Migration: `npx prisma migrate dev --name <nama>` HANYA tambahan (ADD COLUMN). **DILARANG KERAS: `--force-reset`, `--accept-data-loss`, DROP, TRUNCATE, atau perubahan data apa pun.**
- CHANGELOG: tambah `## [4.4.0] — 2026-10-01` di atas dengan 4 poin fitur (bahasa sama seperti entri sebelumnya).

---

## F1 — Centang biru (baca-kembali WhatsApp)

**Fakta (sudah diverifikasi):**
- `Message.waMessageId String?` TERISI untuk pesan outbound kita (schema.prisma, diindeks).
- UI bubble SUDAH mengalihkan status: `ChatDetail.vue:497-499` — `msg.status==='read'`→✓✓, `'delivered'`→✓✓, selainnya ✓. Status `'read'` tidak pernah diterapkan sejauh ini, jadi belum biru.
- `Message.status String @default("sent")`; pengiriman outbound dari pool.js:1497 mengatur `'sent'`.
- Penghubung Baileys: `src/wa/pool.js` — `sock.ev.on('messages.upsert', ...)` di :457. **BELUM ADA `messages.update`.**

**Kerjakan:**
1. `src/wa/pool.js`: tambahkan handler `sock.ev.on('messages.update', ...)` dekat upsert handler (:457).
   - Payload: array `{ key:{ id, remoteJid, fromMe, participant? }, update:{ status?, ... } }`.
   - Konstanta status Baileys: 3 = ACK DELIVERY, 4/5 = READ/PLAYED. Anggap 3 → `delivered`, ≥4 → `read`. Abaikan <3. **Lingkup v4.4.0: hanya `key.fromMe === true` DAN remoteJid TIDAK berakhiran `@g.us`** (chat 1:1 pelanggan — kasus utama Kanaka). Terimaan grup → komentar TODO, jangan buang waktu.
   - Guard pesanan: jangan menurunkan status (sent → delivered → read monotonic). Terapkan via `updateMany`: `where: { waMessageId: ids-in-batch, status: { in: ['sent'] } }` set data `delivered`; lalu `where: { waMessageId: ids-in-batch, status: { in: ['sent','delivered'] } }` set `read`. (waMessageId TIDAK unik-constrained — gunakan `updateMany`, jangan `update` unik.)
   - Batch proses: proses dalam kelompok (halaman), jangan per-baris menunggu; tangani error per-baris agar satu id buruk tidak mematikan handler. Log `[v4.4.0] receipts:` hanya debug/fail-fast yang bermakna — bukan log yang bisa membanjiri per pesan.
   - Setelah menyimpan: kumpulkan tenantIds dari chat terdampak (select id, chatId + chat.tenantId DULULAH updateMany, lalu dedupe) dan `broadcast.emitToTenant(tid, 'message_status', { waMessageId, status })` — mengikuti pola broadcast yang dipakai socket/queue.js (`emitToTenant`). (Atau kirim chat_update jika pola menyimpan status di level-chat — pilih yang paling sedikit mengubah; nyatakan pilihanmu dalam laporan.)
2. FE: 
   - ChatDetail.vue tick: saat `msg.status==='read'` → warnai ✓✓ menjadi BIRU (kontras terlihat melawan abu-abu delivered, cukup gunakan text-blue-500/sama dengan styling palet WA). Delivered/terkirim tetap abu-abu.
   - Listener soket untuk `message_status` (atau event yang kamu pakai) di chats store — perbarui array/objek pesan secara in-place (cocokkan dengan `waMessageId`); jangan me-refetch seluruh chat. Optimis dan murah.
3. TIDAK diubah: sisi pengiriman, appConfig v0.12.9 terimaan ke pelanggan, semua sisi masuk.

**Pemeriksaan sendiri (laporkan FAIL/PASS):**
- [x] grep tidak ada penghapusan `status:` untuk inbound (inbound tetap `delivered` di atas kaca pool:1497)
- [x] tidak ada penurunan status lintas update
- [x] handler grup tidak menyentuh 1:1 logika (cabang jelas)
- [x] tidak ada refetch penuh pada event tick

---

## F2 — Take → TANPA membuka chat (masuk ke Mine + mark-as-unread)

**Fakta:**
- Sumber kelip: `Dashboard.vue:1161 handleTakeNext()` — memanggil `await selectChat(data.chat)` → memaksa membuka.
- Util manual-unread SUDAH ADA: `frontend/src/utils/manualUnread.js` (fungsional `add/remove/list`, kunci localStorage `cb_manual_unread`, petunjuk: lihat file untuk kunci string vs angka).
- Titik ambil lain: `ChatDetail.vue:536` tombol admin `@click="$emit('take')"` → Dashboard `@take="handleAssign"` (:1111) — chat SUDAH terbuka di sana; **biarkan apa adanya**.
- ChatListPane sudah menerapkan manualUnread (bold + titik biru) + tombol mark-unread di baris (:272-284).

**Kerjakan:**
1. `Dashboard.vue handleTakeNext()`: HAPUS `await selectChat(data.chat)`. Sebaliknya, setelah take sukses: `manualUnreadAdd(<String chat id>)` mengikuti kunci yang ChatListPane gunakan (periksa isManualUnread :351 untuk kunci tipe) → tambahkan impor `add` di samping `remove` yang ada (:346).
2. Toast: ubah agar mencerminkan perilaku baru, mis. icon `📥`, judul `Chat diambil`, pesan `Masuk daftar Mine — ditandai belum dibaca` (tanpa menyebut nama agar tidak membingungkan, atau pertahankan nama jika kamu ingin — pilih dan sebutkan). 
3. Setelah take: tetap `chats.fetchChats(chats.filterParams)` + `fetchQueueCount` (jeda sudah berperilaku baik). Jika chat yang di-ambil adalah chat TERBUKA saat ini sebelumnya (mis. agent mengambil ulang sendiri) → guard tak diperlukan; perilaku open hanya menghilang untuk take dari banner antrean.
4. Audit SEMUA call-site emit take (`grep -rn "emit('take')" frontend/src`): hanya jalur `take-next` (QueueBanner) berubah. Terapkan F2 HANYA pada banner antrean `take-next`.

**Pemeriksaan sendiri:**
- [x] tidak ada selectChat yang tersisa di handleTakeNext
- [x] kunci manualUnread mencocokkan ChatListPane isManualUnread (kunci tipe identik)
- [x] handleAssign (ChatDetail) tidak tersentuh
- [x] toast baru mencerminkan perilaku

---

## F3 — Tag kontak "Kecualikan dari antrean" (blokir senyap)

**Fakta:**
- `Tag { id, tenantId, name, color, ... chats ChatTag[], contacts ContactTag[] }` (schema.prisma). `ContactTag { contactId, tagId, @@unique([contactId,tagId]) }`. `Chat.contact Contact?`.
- Definisi antrean SENDIRI SUDAH DIPUSATKAN: `src/socket/queue.js:14 queueWhere(tenantId)` — dipakai oleh kueri list, getQueueCount (:27), take-next (chats.js:706-742). TITIK PERUBAHAN TUNGGAL.

**Kerjakan:**
1. Migrasi tambahan (prisma dev — hanya ADD COLUMN): `model Tag { excludeFromQueue Boolean @default(false) }`. **LILIN ADD-ONLY.**
2. `queueWhere`: tambahkan `NOT: { contact: { tags: { some: { tag: { excludeFromQueue: true } } } } }` — chat tanpa kontak (NULL) tetap DI DALAM (NOT atas kecocokan tanpa-cocok = benar).
3. API toggle PATCH: modul tags yang menyajikan `/api/tags` create/list juga tambahkan ADMIN-ONLY `PATCH /api/tags/:id { excludeFromQueue: true|false }` (gunakan pola middleware isAdmin yang sudah ada). Setelah toggling: hitung ulang + `emitQueueUpdate(tenantId)` (fungsi ada :34) → banner memperbarui segera.
4. FE: temukan UI manajemen tag (grep createTag / `/api/tags` di FE — recon tidak menemukan halaman-tag-admin terdedikasi; tag dibuat inline?). Tempatkan toggle: checkbox "Kecualikan dari antrean" di UI buat tag, + cara admin untuk membalik bendera pada tag yang ada (konteks menu kecil/kelola flyout — penilaian minimal Dory, sebutkan dalam laporan). Badan indikator kecil (mis. chip abu-abu `exclude`) di mana tag terdaftar agar admin melihat status bendera tanpa membuka.
5. Jika kontak dengan tag EXCLUDE memiliki chat yang sudah di-CLAIM oleh seseorang → chat tetap; hanya antrean baru/kembali dikeluarkan. Chat selesai kembali ke antrean? Chat selesai kembali hanya jika status kembali diperiksa dalam queueWhere — catat fakta ini dalam komentar jangan ubah.
6. TIDAK diubah: alur pengiriman/penerimaan pesan; chat dengan kontak ber-tag EXCLUDE tetap tampil di daftar normal (semua daftar/semua), tidak dihapus/senya; hanya tidak masuk antrean untuk klaim.

**Pemeriksaan sendiri:**
- [x] semua penghitungan antrean & take-next membaca kueri TERSARING (grep situs-pemakai queueWhere)
- [x] migrasi = 1 kolom ADD, tidak ada DROP
- [x] PATCH admin-only (tes manual sebagai CS → 403)
- [x] banner antrean diperbarui saat membalik bendera

---

## F4 — Tombol Resolve di header desktop, di sebelah AI Summary

**Fakta:**
- Header desktop `ChatDetail.vue`: tombol AI Summary di :69-72 ("Buka sesi Summary") + baris tombol kedua di :113-122 dengan 🤖 AI Summary (+ SummaryModal :123). 
- Emit `resolve` SUDAH terkabel: ChatDetail emits (:838), sub :142 `@resolve="$emit('resolve')"`, Dashboard `@resolve="handleResolve"`.

**Kerjakan:**
1. Tambahkan tombol `Resolve` DI SAMPING tombol AI Summary (desktop baris :113-122; taruh di KIRI AI Summary — "di depan/antar"). Terlihat hanya saat `chat.status !== 'resolved'` (chat ter-resolved memiliki tampilan nonaktif sendiri :526-527). Emit `resolve` yang sama.
2. Styling: cocok dengan pasangan tombol di baris (ukuran teks-xs/padding/gaya rounded); gunakan gaya warna resolusi yang sudah dipakai di tempat lain (cari tombol resolve yang sudah ada di UI mobile/kebab dan tiru token/kelasnya).
3. Jangan lakukan apa-apa sebaris dengan AI Summary logika (disabled-summary dsb) — tombol terpisah.

**Pemeriksaan sendiri:**
- [x] tombol hanya terlihat saat status !== 'resolved'
- [x] emit resolve → Dashboard handleResolve tanpa wiring baru
- [x] konsistensi visual dengan AI Summary

---

## Kontrak laporan (Dory → Alita)
1. Mengubah file + 1 baris ringkapasan.
2. Daftar pemeriksaan per fitur (A–D di atas) PASS/FAIL.
3. `npm run build` keluaran akhir (pengemasan visual/tail).
4. Hasil status migrasi (`npx prisma migrate status` atau daftar yang diterapkan pada dir dev Anda) — nama + 1 baris SQL ADD.
5. Penyimpangan/jawaban terbuka (maksimal 10 baris). Jika ada sesuatu di spec tidak dapat dicapai tepat — JANGAN diam-diam mengambil jalan keluar; nyatakan di laporan.
6. JANGAN commit/push/tag. JANGAN menyentuh produksi. JANGAN mengedit file selain yang dicitrakan spesifikasi ini (frontend/src/*, src/wa/pool.js, src/socket/queue.js, modul routes tag, prisma/schema.prisma + migrasi, CHANGELOG.md).