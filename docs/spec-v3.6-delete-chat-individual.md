# Spec v3.6 — Hapus Chat Individual (permanen) dari kebab menu

> Owner request: Kanaka 2026-09-23 03:06 — "tambahin fitur delete chat individual, tempat paling cocok di kebab menu tiap individual chat (bareng resolve dll), fokus delete permanen cuma satu chat itu."
> Basis: v3.5.1 (commit 12ab785). App 5047 jalan, 2 tenant live (Parahita #4, Mazaya #8) — WA connected.
> TANPA perubahan skema (pure route + UI). Jangan ganggu data live; QA pakai tenant dummy.

## ⛔ HARD CONSTRAINTS

1. Port 5030 MATI, 8770 jangan disentuh. App 5047: kill BY PID saja, max 1x restart (utk build frontend).
2. DB: TIDAK ADA schema change — JANGAN `db push` apa pun. DILARANG destructive DB ops.
3. NO git commit (Alita review + commit).
4. Token/password QA ke file /tmp (sanitizer); body via `-d @/tmp/xx.json`.
5. Frontend: sebelum build `cp -r public public-pre-build-<ts>`.
6. QA tenant dummy via API superadmin (preset pro) — purge di akhir. JANGAN hapus chat di tenant live.

## §1. Backend — DELETE /api/chats/:id (chats.js)

- Chain: `...rt, requireAdmin` (ADMIN ONLY — CS gak boleh hapus chat permanen; super_admin via impersonation/`?tenant=` boleh).
- Logika hapus = PORT dari one-off script yang SUDAH TERUJI (Alita, chat #7635, 02:52). Urutan:
  1. `findUnique({ id, tenantId: req.tenantId })` → 404 kalau bukan milik tenant ini.
  2. **GroupPic rows yang nge-refer chat ini dihapus dulu** (`groupPic.deleteMany({ where: { chatId } })` — cek nama model di schema, relasi "groupPics") supaya FK gak nge-block kalau chat ini PIC grup.
  3. Kumpulkan `mediaPath` dari Message SEBELUM hapus (path cuma ada di DB).
  4. Transaksi: `favoriteMessage` ikut cascade saat message delete (VERIFIKASI dulu di schema — kalau TIDAK cascade, deleteMany dulu by message list), lalu `message`, `chatEvent`, `chatTag`, `chatNote`, `csatSurvey`, `scheduledMessage`, `contact` (linked via chatId) — semua by `{ chatId }`, lalu `chat.delete`.
  5. `purgeLog.create` (tenantId, purgedById: req.user.id, chatCount: 1, messageCount, reason: 'chat_delete: kebab menu (v3.6)' + req.body.reason? kalau dikirim, purgeDate: new Date()).
  6. SETELAH transaksi sukses: unlink file media dari disk (best-effort per file).
  7. Broadcast: `broadcast.emitToTenant(req.tenantId, 'chat_deleted', { chatId: id })` — event BARU (jangan recycle chats_purged).
  8. Response: `{ ok: true, deleted: { messages, chatEvents, ... } }`.
- Grup chat (@g.us): boleh dihapus lewat route ini kalau ada aja (logika sama), tapi UI kebab grup memang hidden — gak perlu special-case.
- Rate limit: gak perlu tambahan (admin-only, apiLimiter global sudah ada).

## §2. Frontend — KebabMenu + ChatDetail

**KebabMenu.vue** (BOTH viewport: desktop dropdown + mobile sheet — cari dua-duanya):
- Item baru `🗑️ Hapus Chat` — warna error/red (pattern: `text-red-600 hover:bg-red-50`), `v-if="auth.isAdmin"` (import auth store — cek pola yang dipakai file ini utk `auth.isAdmin`).
- Posisi: PALING BAWAH, setelah separator baru — jauhkan dari aksi harian (resolve/release) biar gak kepencet gak sengaja.
- Click → emit `('delete-chat')` (pattern sama kayak item lain: chooseResolve → emit('resolve')). Tutup menu setelah emit.

**ChatDetail.vue** (parent handler):
- Handler `handleDeleteChat()`:
  1. Confirm dialog — pakai util confirm yang sudah ada di app (cari `confirmAction` di frontend/src, dipakai AdminUsers.vue; kalau ChatDetail belum import, import util yang sama). Copy: judul "Hapus permanen chat ini?", body "Semua pesan, media, catatan, dan riwayat chat <nama> akan dihapus PERMANEN dan tidak bisa dikembalikan.", tombol konfirmasi "Hapus Permanen" (error color).
  2. Konfirm → `axios.delete(${API}/api/chats/${chat.id})` (pakai axios instance pattern yang dipakai file ini).
  3. Sukses → toast `Chat dihapus permanen` (pattern toast yang dipakai file ini) + **clear selection / navigasi**: cari mekanisme existing utk close chat aktif (mis. emit ke parent, router push, atau set selectedChat null — ikuti pola yang dipakai pas resolve/transfer yang bikin list refresh). Chat row bakal hilang dari list via event socket §3.
- Grup chat: kebab hidden di grup (v0.14.0) — otomatis gak muncul, gak perlu kerjaan.

**Socket listener 'chat_deleted':**
- Cari di mana event socket chat diterima di frontend (handler socket global — kemungkinan App.vue / composable / store; grep `chat_update` / `chats_purged` utk nemu tempatnya).
- Tambah handler `chat_deleted`: hapus chat itu dari list lokal (ChatListPane/store) tanpa full refetch; kalau chat yang sedang TERBUKA = chatId itu → clear selection juga (defense-in-depth, kalo user lain yang ngehapus).

## §3. QA (wajib, tulis output asli di laporan)

1. Bikin tenant QA (preset pro) + admin QA via API superadmin (token via file /tmp).
2. Bikin chat di tenant QA: bikin kontak (POST /api/contacts, body via file) → start chat (route open-chat dari kontak, contacts.js) → chat id dicatat.
3. Insert 2 message row + 1 chatNote via script node kecil (prisma direct, tenant QA) — biar ada yang dihapus.
4. DELETE /api/chats/:id sebagai admin QA → 200 `{ok}`; verify via prisma: chat 0, pesan 0, note 0, contact linked 0, purgeLog +1, media file (kalau ada) hilang dari disk.
5. Non-admin (role cs) → DELETE → 403.
6. Chat tenant LAIN (Parahita) → DELETE dari admin QA → 404 (isolasi tenant — WAJIB lolos).
7. Socket event: manual check (curl gak bisa denger socket — cukup verify kode emit ada + unit-style call; atau skip dengan catatan).
8. Frontend: build sukses (snapshot public dulu). Restart app (1x, by PID) → health 200 + WA t4/t8 reconnect.
9. Purge tenant QA di akhir.

## §4. Laporan

File dibuat/diedit + baris; output asli QA 1-9; deviasi + alasan; FAIL apa adanya. Simpan `docs/report-v3.6.md`.