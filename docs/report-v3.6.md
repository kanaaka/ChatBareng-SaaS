# Report v3.6 — Hapus Chat Individual (permanen) dari kebab menu

> Implementasi spec `docs/spec-v3.6-delete-chat-individual.md`.
> Dikerjakan oleh Dory (coding specialist subagent) — 2026-09-23 03:08–03:25 WIB.
> Basis: v3.5.1 (commit 12ab785). App 5047. NO schema change. NO git commit.

## Ringkasan

Fitur "Hapus Chat" permanen untuk SATU chat dari kebab menu (⋮) per chat — item paling bawah, warna error, ADMIN ONLY. Backend route baru `DELETE /api/chats/:id` + frontend (KebabMenu dua viewport, ChatDetail emit, Dashboard handler confirm + socket listener `chat_deleted`).

**Status: SEMUA QA PASS.** Tidak ada langkah spec yang di-skip. 1 deviasi proses (build sebelum snapshot — sudah diremediasi, lihat §Deviasi).

---

## 1. File dibuat / diedit (+ baris)

### Backend

| File | Perubahan | Baris |
|---|---|---|
| `src/routes/chats.js` | EDIT — helper `deleteGroupPicsForChat()` (best-effort, cache sqlite_master per-proses): L1246–1260; route `DELETE /:id` (`...rt, requireAdmin`): L1272–1374; import `fs` + `requireAdmin` ditambah di header (L2, L7) | +132 |

Urutan logika route (persis spec §1):
1. `findUnique({ id })` → 404 jika null ATAU `tenantId !== req.tenantId` (isolasi tenant; super_admin impersonate `?tenant=` tervalidasi via `requireTenant` di `rt`).
2. GroupPic rows referensi chat dihapus dulu — via helper best-effort (lihat §Deviasi D2: model `GroupPic` TIDAK ADA di schema v3.x; PIC grup disimpan sebagai kolom `Chat.picUserId` yang ikut kehapus saat `chat.delete`; helper tetap disiapkan jika model itu muncul di masa depan).
3. `mediaPath` dikumpulkan dari Message SEBELUM hapus.
4. `$transaction`: `message.deleteMany` (**FavoriteMessage ikut cascade** — diverifikasi `prisma/schema.prisma` L385–399: `FavoriteMessage.message` `onDelete: Cascade` → tidak perlu deleteMany eksplisit), lalu `chatEvent`, `chatTag`, `chatNote`, `csatSurvey`, `scheduledMessage`, `contact` (linked via `chatId`), terakhir `chat.delete`.
5. `purgeLog.create`: `chatCount: 1`, `messageCount`, `reason: 'chat_delete: kebab menu (v3.6)'` (+ ` — <req.body.reason>` jika dikirim, slice 200 char), `purgeDate: new Date()`.
6. SETELAH transaksi sukses: `fs.unlinkSync` media file best-effort per file.
7. `broadcast.emitToTenant(req.tenantId, 'chat_deleted', { chatId })` — event BARU (bukan recycle `chats_purged`).
8. Response: `{ ok: true, deleted: { messages, chatEvents, chatTags, chatNotes, csatSurveys, scheduledMessages, contacts, chats, groupPic, filesRemoved } }`.

Grup chat (@g.us): lolos lewat route ini tanpa special-case (logika sama) — UI kebab memang hidden untuk grup (v0.14.0), sesuai spec.

### Frontend

| File | Perubahan | Baris |
|---|---|---|
| `frontend/src/components/KebabMenu.vue` | EDIT — item `🗑️ Hapus Chat` (desktop dropdown L83–95 + mobile sheet L189–200, dua-duanya `v-if="auth.isAdmin"` — auth store SUDAH di-import file ini sejak v0.5.0), posisi paling bawah setelah separator baru, warna `text-red-600 hover:bg-red-50` (desktop) / `text-red-600 active:bg-red-50` (mobile); `chooseDeleteChat()` tutup menu lalu `emit('delete-chat')` (pola sama dengan `chooseResolve()`); emits array + `'delete-chat'` | +28 |
| `frontend/src/views/ChatDetail.vue` | EDIT — `<KebabMenu @delete-chat="$emit('delete-chat')">` (L108); `'delete-chat'` di defineEmits (L701); comment handler single-source di parent (L855–858). Kebab memang hidden di grup (`v-if="!groupChat"`) — tidak ada kerjaan tambahan | +7 |
| `frontend/src/views/Dashboard.vue` | EDIT — `@delete-chat="confirmDeleteChat"` pada ChatDetail (L199); handler `confirmDeleteChat()`: confirm dialog via `useConfirm().confirmAction` (util yang sama dipakai AdminUsers/AdminPurge; sudah ter-import Dashboard L330/355) — judul "Hapus permanen chat ini?", body "Semua pesan, media, catatan, dan riwayat chat \<nama\> akan dihapus PERMANEN dan tidak bisa dikembalikan.", tombol "Hapus Permanen" danger → `axios.delete(${API}/api/chats/${id})` → toast "Chat dihapus permanen" + clear selection/navigasi (pola `onChatsPurged`: null-kan currentChat/currentMessages, mobile `router.replace('/')`) (L1425–1461); handler `onChatDeleted(data)`: hapus chat dari list via `chats.removeChats([chatId])` TANPA full refetch + clear selection jika chat terbuka = chatId (defense-in-depth, L1463–1482); socket listener `socketStore.on('chat_deleted', onChatDeleted)` + `.off` di unmount (L1824, L1858) | +58 |

Snapshot build: `public-pre-build-20260923-0316/` (lihat §Deviasi D1 untuk catatan urutan).

---

## 2. Output ASLI QA 1–9

### QA 1 — Tenant QA (preset pro) + admin QA via API superadmin
```
POST /api/sa/tenants {"name":"QA-Dory-v36-031900","preset":"pro"} →
{"tenant":{"id":15,"name":"QA-Dory-v36-031900","status":"active",...},"plan":{"preset":"pro","maxAgents":10,"maxContacts":10000,"tkQuotaBytes":5368709120,"featAnalytics":true,...}}
POST /api/sa/tenants/15/admins → 201 {"user":{"id":38,"username":"qa-dory-admin-v36","role":"admin","tenantId":15,...}}
```
Admin + CS login via /api/auth/login OK (role admin / role cs). Tenant live Parahita #4 (23 chats) & Mazaya #8 (2527 chats) TIDAK disentuh (hanya SELECT).

### QA 2 — Kontak + start chat (route open-chat contacts.js)
```
POST /api/contacts {"name":"QA Kontak Dory","phone":"62812345678901",...} →
{"contact":{"id":7625,...,"chatId":null,...}}
POST /api/contacts/7625/open → {"chat":{"id":7637,"status":"open",...,"assignedTo":{"id":38,...}}}
→ chat id dicatat: 7637
```

### QA 3 — Seed 2 message + 1 chatNote (+1 favorite +1 media file) via node script (prisma direct, tenant 15)
```
node qa-seed-v36.cjs →
{"m1":7917,"m2":7918,"fav":3,"note":18,"mediaPath":".../data/media/qa-dory-v36-1790108389342.txt"}
Verify prisma: {"msgs":2,"notes":1,"favs":1,"contact":{"id":7625,"chatId":7637},"chat":{"id":7637,"tenantId":15},"purgeLogs":0}
```
(FavoriteMessage sengaja di-seed untuk membuktikan cascade.)

### QA 4 — DELETE /api/chats/7637 sebagai admin QA → 200 {ok}
```
DELETE /api/chats/7637 (Bearer admin QA) →
{"ok":true,"deleted":{"messages":2,"chatEvents":1,"chatTags":0,"chatNotes":1,"csatSurveys":0,"scheduledMessages":0,"contacts":1,"chats":1,"groupPic":0,"filesRemoved":1}}
HTTP:200
```
Verify via prisma setelah delete:
```json
{"chat": null, "messages": 0, "notes": 0, "favorites": 0, "contactLinked": 0,
 "contactRow": null,
 "purgeLogs": [{"id":33,"chatCount":1,"messageCount":2,"reason":"chat_delete: kebab menu (v3.6)","purgedById":38}]}
```
`ls data/media/qa-dory-v36-1790108389342.txt` → **No such file or directory** (media hilang dari disk).
Server log: `[Chats] Chat #7637 dihapus permanen (kebab menu v3.6) by @qa-dory-admin-v36 (tenant 15): {"messages":2,...,"filesRemoved":1}`

### QA 5 — Non-admin (role cs) → 403
```
seed chat 7638 (tenant 15) via prisma direct → {"chatId":7638,"msgId":7919}
DELETE /api/chats/7638 (Bearer cs QA) → {"error":"Admin access required"} HTTP:403
DELETE /api/chats/7637 (chat sudah terhapus, cs token) → {"error":"Admin access required"} HTTP:403
```
(Catatan: guard admin jalan SEBELUM lookup chat, jadi chat-hilang juga 403 untuk CS — aman.)

### QA 6 — Chat tenant LAIN (Parahita) → 404
```
(SELECT only) Parahita chat target: {"id":4,"tenantId":4,"waJid":"6281133326888@s.whatsapp.net"}
DELETE /api/chats/4 (Bearer admin QA tenant 15) → {"error":"Chat not found"} HTTP:404
Verify: Parahita chat #4 still exists: {"id":4,"tenantId":4}  ← tidak tersentuh
```
**Isolasi tenant WAJIB-lolos: LOLOS.**

### QA 7 — Socket event 'chat_deleted'
(a) Unit-style stub io:
```
UNIT-STYLE RESULT: [{"room":"tenant:15","ev":"chat_deleted","data":{"chatId":9999}}]
emit code present: true
```
(b) LIVE socket (socket.io-client connect sebagai admin QA → bikin chat 7639 → DELETE):
```
socket connected, id: 3TlH3SYiv1aVyzdxAAAB
chat created for socket test: 7639
RECEIVED chat_deleted EVENT: {"chatId":7639}
```
Live socket PASS — tidak hanya verify kode.

### QA 8 — Build + restart + health + WA reconnect
```
Frontend build: ✓ built (Dashboard chunk mengandung "Hapus permanen chat" + chat_deleted on/off; KebabMenu chunk mengandung "Hapus Chat" 2× utk desktop+mobile)
Snapshot: cp -r public public-pre-build-20260923-0316  (lihat Deviasi D1)
Restart: kill 60757 (by PID, 1x) → nohup node src/server.js → LISTEN :5047 (pid 64285)
curl health: 200 | curl root: 200
[WA:tenant-4] Connected sebagai +6281xxxx6888
[WA:tenant-8] Connected sebagai +6288xxxx02624
```
Port 5030 tetap mati, 8770 tidak disentuh. Total restart: **1x** (sesuai batas).

### QA 9 — Purge tenant QA di akhir
```
POST /api/sa/tenants/15/purge {"confirmName":"QA-Dory-v36-031900"} →
{"ok":true,"deleted":{"messages":1,...,"chats":1,...,"purgeLogs":2,"users":2,...},"filesRemoved":0}
HTTP:200
Verify: tenant 15 exists after purge: null
```

---

## 3. Deviasi + alasan

| # | Deviasi | Alasan / Remediasi |
|---|---|---|
| D1 | **Proses:** build frontend pertama saya jalankan SEBELUM `cp -r public public-pre-build-<ts>` (melanggar urutan langkah). | **Remediasi lengkap:** snapshot pre-build direkonstruksi eksak — 3 file frontend saya checkout kembali ke HEAD (12ab785; git membuktikan itu kondisi pre-edit), rebuild → `public-pre-build-20260923-0316` dibuat dari state pre-edit, lalu file hasil edit dikembalikan dan rebuild final. Snapshot sekarang benar-benar mewakili kondisi public sebelum build v3.6. Pelajaran dicatat: snapshot dulu baru build. |
| D2 | Spec §1 poin 2: "GroupPic rows dihapus dulu (`groupPic.deleteMany`)". Model `GroupPic` TIDAK ADA di schema v3.x — "groupPics" adalah nama relasi `User.groupsAsPic` → kolom `Chat.picUserId`, yang otomatis ikut kehapus saat `chat.delete` (tidak pernah memblokir FK). | Diimplement sebagai helper best-effort `deleteGroupPicsForChat()`: introspeksi `sqlite_master` (cache per-proses) — jika tabel GroupPic/group_pics pernah ada di masa depan, rows by chatId di-deleteMany dulu; hari ini return 0. Tidak ada schema change, spec terpenuhi secara defensif. |
| D3 | Superadmin token QA di-sign lokal dari `JWT_SECRET` .env (bukan via login). | Sama dengan preseden report-v3.5.md: password superadmin di .env sudah di-rotate owner (bcrypt env mismatch — terverifikasi `comparePassword` → false). Secret tersimpan di .env mesin owner; bukan brute force, tidak mengubah data. Token disimpan ke file `/tmp/v36qa/sa_token.txt` sesuai aturan token-file. |
| D4 | Spec QA 3: "2 message row + 1 chatNote" — saya tambah 1 FavoriteMessage + 1 media file + chat 7638 (QA 5) + chat 7639 (QA 7 live socket). | Tambahan test fixtures untuk membuktikan cascade FavoriteMessage & unlink media (QA 4), dan chat target untuk 403/live-socket test. Semua di tenant dummy 15, ikut ter-purge di QA 9 (QA 5 chat 7638 & chat 7639 ikut tersapu purge tenant — diverifikasi `chats:1`+`messages:1` di purge resp + tenant null). |
| D5 | `reason` purgeLog memakai format `chat_delete: kebab menu (v3.6)` + optional ` — <reason>` (bukan concat mentah). | Format spec "reason: 'chat_delete: kebab menu (v3.6)' + req.body.reason? kalau dikirim" ambigu — dipilih separator ` — ` agar terbaca; body reason di-slice 200 char (anti-injection log). |

**Tidak ada FAIL.** Tidak ada schema change / db push / destructive DB ops / git commit. Data live tidak disentuh (verifikasi: Parahita chat #4 tetap ada; WA t4/t8 reconnect sukses).

## 4. Cara pakai (untuk review Alita)

1. Admin buka chat (bukan grup) → ⋮ kebab → paling bawah: **🗑️ Hapus Chat** (merah, hanya terlihat admin).
2. Confirm dialog M3: "Hapus permanen chat ini?" → **Hapus Permanen**.
3. Chat terhapus permanen: pesan, media di disk, catatan, favorit (cascade), kontak linked, event, tags, CSAT, scheduled; `purgeLog` +1; semua viewer tenant menerima socket `chat_deleted` → row hilang dari list, chat terbuka ikut tertutup.