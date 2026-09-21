# WA CS Hub v0.13.4 — Spec: Notifikasi Privacy Fix + Tag Manager + Purge Reset Marker

> Status: APPROVED (Kanaka 2026-09-12 07:24, dgn revisi: unassigned TANPA toast sama sekali)
> → eksekusi via Dory. Base v0.13.3 (commit 954b2c7; hotfix timeout 7c492f0). Tanpa perubahan schema.

## 1. Context — laporan Kanaka 07:12

QA pakai akun CS Oslo: chat baru masuk antrean → muncul toast in-app yang MENAMPILKAN ISI chat.
Kemarin juga: notifikasi sistem PWA (Android/browser) masih menampilkan chat milik user lain
setelah fix toast bocor v0.12.1. Diagnosa Alita (07:17) — 3 lapis:

1. Toast socket unassigned membawa isi pesan (bawaan v0.5.0) — kebijakan lama yang diganti.
2. Server push antrean (baileys.js) kirim body `Nama kontak: isi pesan` ke SEMUA CS+admin — bug privacy.
3. Service worker (`public/sw.js`) mengubah push jadi in-app toast tanpa gate → double toast
   (1 dari socket + 1 dari `push-inapp`).

## 2. A — Notifikasi privacy fix (3 titik)

**Kebijakan final (locked Kanaka):**

| Kondisi | Toast in-app | Notifikasi sistem PWA (app tertutup) |
|---|---|---|
| Chat MINE (assigned ke user tsb) | ✅ dgn isi — HANYA ke agent pemilik | ✅ dgn isi (jalur existing sendToUser) |
| Unassigned (di antrean) | ❌ TANPA TOAST — cukup badge antrean + queue count | ✅ content-free: "Chat baru di antrean" / "Ada chat baru menunggu di antrean" (TANPA nama kontak, TANPA isi pesan) |
| Di-claim CS lain | ❌ (sudah bener) | ❌ (sudah bener) |

### A1 — Hapus toast unassigned (frontend/src/views/Dashboard.vue `onNewMessage`)
- Blok `if (isMine || canTake)` → toast HANYA `isMine`. Jalur `canTake`/`isUnassigned` toast
  dibuang seluruhnya (badge antrean + queue count sudah cukup sebagai sinyal take).
- Hapus juga variabel `canTake` yang jadi tak terpakai (JANGAN sentuh penggunaan
  `auth.canTake` di tempat lain bila ada).

### A2 — Push antrean content-free (src/wa/baileys.js blok push)
- Payload antrean (chat open + unassigned): `title: 'Chat baru di antrean'`,
  `body: 'Ada chat baru menunggu di antrean'` — TANPA contactTitle, TANPA pushBody.
- Tetap dikirim ke role cs+admin aktif (`sendToActiveRole`) — ini sinyal kerja, bukan konten.
- Push chat-mine (assigned) TIDAK berubah (tetap bawa isi, hanya ke pemilik).

### A3 — Bunuh double toast (frontend/src/utils/pushInapp.js)
- Handler `push-inapp`: SKIP bila `payload.kind === 'message'` (jalur socket sudah
  menampilkan toast utk chat-mine saat app visible — SW tidak perlu dobel).
- Toast dari SW tetap jalan untuk kind lain ('test', 'announcement', dst — alasan awal
  v0.12.7 tetap terjaga).

## 3. B — Tag Manager (di dalam tampilan Kontak)

### API
- `GET /api/tags` — tambah `contactCount` per tag (via ContactTag; pertahankan
  `_count.chats` existing). Semua field tambahan additive, response lama utuh.
- `DELETE /api/tags/:id` — sudah ada (admin) → pastikan detach ContactTag/ChatTag terkait
  (cek perilaku existing; cascade bila perlu) + tetap broadcast `tag_deleted`.
- `GET /api/contacts/export?tagId=N` (admin) — filter kontak by tag (via ContactTag).
  Tanpa param → perilaku existing utuh. Header CSV konsisten dgn export existing.

### UI (frontend/src/views/Contacts.vue)
- **Filter chip tag** (SEMUA role): baris chip daftar tag (nama + jumlah kontak),
  single-select ("Semua" = tanpa filter) → daftar kontak terfilter.
- **Panel "Kelola Tag"** (ADMIN ONLY, collapsible di Contacts):
  daftar tag (nama, warna, contactCount), aksi per baris:
  [Lihat kontak] (apply filter), [Export CSV] (download), [Hapus] (konfirmasi pakai
  dialog M3 — BUKAN native confirm), + form tambah tag baru (nama + warna).
- Non-admin: panel kelola disembunyikan; API delete tetap 403 (server-side sudah).
- Realtime: hook listener `tag_created`/`tag_deleted` yang sudah ada → refresh chips.

## 4. C — Purge reset marker auto-reply (src/routes/purge.js)

Blok `chat.updateMany` reset operational state tambahkan:
`lastAutoGreetDate: null, menuState: null, menuRequestedAt: null, menuOptionId: null`.
Plus reset `Contact.lastMenuShownAt → null` untuk contact rows yang chatId-nya
terdampak purge. Alasan: purge = fresh start total (v0.1.24), tapi 3 marker auto-reply
kelewat → QA/operasional terblokir "sudah kirim hari ini" tanpa terlihat.

## 5. Invariant

1. Isi pesan pelanggan TIDAK PERNAH keluar ke user yang bukan pemilik chat
   (toast/push, app visible maupun tertutup).
2. Notifikasi antrean tidak pernah membawa nama kontak/isi pesan.
3. Tidak ada toast ganda untuk satu kejadian yang sama.
4. Tag delete memastikan tidak ada orphan ContactTag/ChatTag.
5. Perilaku existing lain (transfer push, announcements, receipts) tidak tersentuh.

## 6. QA checklist (Kanaka, setelah build)

Setup: 2 browser/akun — Oslo (CS) + admin; nomor pelanggan siap.

1. Chat baru masuk antrean (dalam jam, mode text atau gateway off) → Oslo & admin:
   TIDAK ada toast in-app, TIDAK ada toast dari SW (app visible) — hanya badge antrean naik.
2. App ditutup/di-background + chat antrean baru → notifikasi sistem muncul TANPA isi
   ("Ada chat baru menunggu di antrean"), di Oslo & admin.
3. Chat di-take Oslo → pesan pelanggan berikutnya → toast in-app MUNCUL HANYA di Oslo
   (dengan isi); admin/cs lain: tidak muncul apa pun. PWA push (app closed) juga hanya Oslo.
4. Tidak ada double toast di skenario mana pun.
5. Tag Manager: admin buat tag → chips muncul; filter kontak by tag jalan; delete tag
   (konfirmasi) → kontak kehilangan tag, chips refresh; Export CSV by tag → isi CSV hanya
   kontak bertag tsb; CS non-admin: panel kelola tidak terlihat & API delete → 403.
6. Purge chat yang punya marker auto-reply terisi → setelah purge: lastAutoGreetDate,
   menuState, menuRequestedAt, menuOptionId, Contact.lastMenuShownAt semuanya null
   (bukti DB dari Alita), auto reply bisa trigger lagi.

## 7. Rollout

- Backup DB pre-deploy: `backup/pre-v0.13.4-<ts>.db`.
- Build frontend (Dashboard, Contacts, pushInapp berubah) → restart 5030 (kill PID
  eksplisit) → smoke health 200 + WA Connected.
- Commit lokal + tag v0.13.4. PUSH DITAHAN sampai QA Kanaka USER-VERIFIED (Alita yang push).
- Rollback: git revert + restart. Tanpa perubahan data/schema.