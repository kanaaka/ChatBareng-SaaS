# WA CS Hub (ChatBareng) — v0.11.0 Spec: Enkripsi At-Rest untuk Isi Pesan Chat

**Status:** ✅ APPROVED Kanaka ("gas yaa!", 2026-09-09 21:26) — eksekusi: Dory (dev) + Alita (migrasi data, QA comprehensive, deploy)
**Penulis spec:** Alita | **Tanggal:** 2026-09-09
**Motivasi:** isi chat saat ini plaintext di SQLite. Media sudah AES-256-GCM; TEKS belum. Kanaka minta dienkripsi + search/export tetap berfungsi + test dummy comprehensive.

---

## 0. Tujuan & Non-goals

**Tujuan:** isi pesan teks (dan preview chat list) tersimpan sebagai ciphertext di DB. Siapapun yang hanya mendapat file `wa-cs-hub.db` TIDAK bisa membaca isi chat tanpa kunci dari `.env`.

**Non-goals:**
- Bukan end-to-end encryption (server tetap bisa baca — dibutuhkan untuk tampilan/search/export)
- Tidak mengenkripsi kolom lain (contactName, contactPhone, senderName) — fase 2 jika diminta
- Tidak mengubah UI sama sekali

## 1. Skema Enkripsi

- **Algoritma:** AES-256-GCM (pola existing `media.js` — satu util dipakai ulang)
- **Kunci:** env `MSG_ENCRYPTION_KEY` (base64, 32-byte). ALITA yang generate & isi sebelum deploy. WAJIB beda dari `MEDIA_ENCRYPTION_KEY` (rotasi independen).
- **Format tersimpan di kolom `Message.content` & `Chat.lastMessagePreview`:**
  `enc:v1:<base64-iv>:<base64-authTag>:<base64-ciphertext>`
  - Prefix `enc:v1:` = penanda; dekrip otomatis hanya untuk ber-prefiks ini
  - Tanpa prefix = plaintext legacy (data lama) → dibaca apa adanya (backward compat, migrasi bertahap aman)
- Kolom `content` Message & `lastMessagePreview` Chat dibolehkan NULL (media-only message tetap tanpa content)

## 2. Util Terpusat — `src/services/textCrypto.js`

```js
encryptText(plain) → 'enc:v1:...'   // null/undefined/'' → return apa adanya
decryptText(stored) → plain          // tanpa prefix → return apa adanya (legacy)
isEncrypted(stored) → bool
```
- Kunci dari `process.env.MSG_ENCRYPTION_KEY`; env kosong → THROW jelas saat boot (JANGAN silent-fallback ke plaintext: keamanan silent-off = bahaya). Server gagal start dengan pesan jelas kalau kunci tidak ada/korup — deploy notes: Alita isi env dulu.
- Cipher text TIDAK boleh leak kunci; key derivation tidak perlu (kunci langsung 32 byte).

## 3. Titik Tulis (enkripsi saat simpan)

Semua `prisma.message.create/update` yang menyimpan isi:
1. `src/wa/baileys.js` — pesan masuk (inbound) & media caption
2. `src/services/autoReply.js` — pesan auto greeting/outside-hours (v0.7.0)
3. `src/services/csat.js` — pesan survey (v0.10.0)
4. `src/services/v0100Scheduler.js` — pesan terjadwal terkirim (v0.10.0)
5. `src/routes/chats.js` — reply CS manual + scheduled flow
6. `Chat.lastMessagePreview` — enkripsi juga (update setiap pesan baru)

## 4. Titik Baca (dekrip on-the-fly)

1. `GET /api/chats/:id/messages` — dekrip sebelum response
2. **Global search** (chat list sidebar + in-chat search): SQL LIKE tidak bisa di ciphertext →
   strategi: fetch kandidat pesan (batas 5000 terbaru + filter chatId), **dekrip in-memory, filter di aplikasi**. Skala SQLite saat ini (ribuan, bukan jutaan) = acceptable. Catat di report: kalau nanti jutaan, butuh FTS terenkripsi (fase 2).
3. `Chat.lastMessagePreview` di chat list — dekrip di API response (bukan di SQL)
4. **Export CSV v0.6.0 (`history.js`)** — dekrip on-the-fly saat generate CSV
5. **Backup Google Drive v0.8.0** — pakai generator CSV yang sama (sudah lewat dekrip otomatis)
6. **Favorites panel** — content terenkripsi juga, dekrip saat render data
7. **Analytics** — tidak membaca isi pesan (hanya metadata) → nihil berubah (PASTIKAN: tidak ada query yang memfilter by content)
8. **Purge** — purge menghapus pesan (delete row) → tidak terpengaruh

## 5. Migrasi Data Lama — `src/scripts/migrate-encrypt-messages.js`

- Backup DB otomatis sebelum jalan (copy ke `backup/pre-v0.11.0/` + md5)
- Batch 500 pesan: baca rows tanpa prefix `enc:v1:` → enkripsi → update; loop sampai 0; **idempotent** (prefix check)
- Mode `--dry-run`: hitung & tampilkan sample, tanpa tulis
- Progress log per batch; total waktu diukur
- Chat.lastMessagePreview ikut dienkripsi (query rows yang tidak ber-prefix)
- DILARANG: --force-reset, data loss apapun. Kalau tool minta reset → STOP.
- Setelah migrasi: post-verify count = 0 plaintext tersisa + sample dekrip cocok dengan backup

## 6. Env & Key Management

- `.env`: `MSG_ENCRYPTION_KEY=<base64 32-byte>` (Alita generate: `crypto.randomBytes(32).toString('base64')`)
- Backup kunci: `workspace/credentials/wa-cs-hub-msg-key.txt` (chmod 600) + catatan di parahita-credentials.md
- Server start: kunci tidak ada → **exit dengan pesan jelas** (`[TEXT-CRYPTO] MSG_ENCRYPTION_KEY missing — refusing to start`)
- Jangan log plaintext/ciphertext ke console (kecuali error umum tanpa isi)

## 7. Acceptance Criteria (QA comprehensive — Alita dengan chat dummy)

- [ ] DB raw: pesan baru tersimpan sebagai `enc:v1:...` (bukan plaintext) — cek via sqlite3/Prisma raw
- [ ] Migrasi data lama: semua pesan lama terenkripsi (count plaintext = 0), sample dekrip cocok asli
- [ ] Chat tampil normal di UI (CS/admin tidak sadar ada enkripsi) — desktop + mobile screenshot
- [ ] Global search masih menemukan pesan (query plaintext → hasil benar)
- [ ] In-chat search masih berfungsi
- [ ] Export CSV: isi kolom content = plaintext asli (bukan ciphertext)
- [ ] Google Drive backup: CSV sama benar (kalau link aktif; kalau tidak, cukup CSV lokal)
- [ ] Favorites menampilkan isi pesan normal
- [ ] Auto greeting/scheduled/CSAT message tersimpan terenkripsi & tampil normal
- [ ] Media + caption terenkripsi; preview chat list terenkripsi & tampil normal
- [ ] Restart server → semuanya tetap terbaca (kunci dari .env)
- [ ] Kunci salah/missing → server exit dengan pesan jelas (bukan pesan rusak di DB)
- [ ] Regression: chat flow, autoreply, CSAT, scheduled, blast, analytics, backup
- [ ] Performance: GET messages halaman 50 pesan < 500ms; global search < 2s pada 10k pesan dummy

## 8. Rencana Eksekusi (Dory) & QA (Alita)

- Dory: util textCrypto + titik tulis/baca (§2-§4) + skrip migrasi (§5) — TANPA menjalankan migrasi produksi (Alita yang jalankan dengan backup)
- QA dummy comprehensive (Alita, di dev 5041 + verifikasi produksi setelah migrasi):
  1. DB raw check: 0 plaintext, format enc:v1 benar
  2. Dekrip round-trip: semua pesan dummy cocok asli
  3. Search: global + in-chat menemukan keyword dari pesan terenkripsi
  4. Export CSV: content benar, jumlah baris benar
  5. Regression penuh + performa
- Deploy: env key → push schema (tidak ada perubahan schema! hanya env) → restart by PID → jalankan migrasi produksi → verify → QA Kanaka
- Rollback plan: kunci salah/hilang → restore backup DB + env lama (kunci lama disimpan); data tetap ada karena prefix membedakan terenkripsi vs belum

---
*Spec by Alita, approved Kanaka 2026-09-09 21:26. Jangan eksekusi sebelum Alita review hasil Dory.*