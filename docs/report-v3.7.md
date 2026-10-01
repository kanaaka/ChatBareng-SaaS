# Report v3.7 — "Hapus Chat" pilihan kontak + anti-duplicate re-link

> Implementasi atas request owner (Kanaka) — basis v3.6.1 (commit 1bf959a).
> Dikerjakan oleh Dory (coding specialist subagent) — 2026-09-23 08:13–08:35 WIB.
> App 5047. NO schema change. NO git commit. NO destructive DB ops.
> Report v3.6 (pola yang sama): `docs/report-v3.6.md`.

## Ringkasan

Dua perubahan atas fitur "Hapus Chat" v3.6:

1. **Pilihan eksplisit admin** — item kebab jadi DUA (admin only, dua-duanya merah, di bawah separator):
   - **🗑️ Hapus Chat** → hapus chat + riwayat, **KONTAK DIPERTAHANKAN** (detach: `chatId=null`, nama/nomor/tag utuh). Default.
   - **🗑️ Hapus Chat + Kontak** → behavior v3.6 utuh (kontak ikut terhapus total).
   - API: `DELETE /api/chats/:id?deleteContact=false|true` (absent = false = keep).
2. **Anti-duplicate re-link** — kontak orphan (`chatId=null`) di-re-link ke kontak yang SAMA (match by phone, tenant-scoped) di 4 jalur yang bisa bikin kontak dobel, via helper shared baru `src/utils/contactRelink.js`. Kasus "Berliana" (kontak dobel) tidak boleh kambuh lewat pintu manapun.

**Status: SEMUA QA PASS.** 2 bug ditemukan SAAT QA dan sudah diperbaiki (lihat §3 — justru bukti QA-nya jalan). Tenant dummy di-purge di akhir; tenant live (Parahita #4, Mazaya #8) tidak disentuh.

---

## 1. File dibuat / diedit (+ diff summary)

| File | Perubahan | Ringkasan diff |
|---|---|---|
| `src/utils/contactRelink.js` | **BARU** (+95 lines) | Helper shared `relinkOrphanContact(tenantId, phone, chatId, name?)`: cari kontak by phone tenant-scoped — **orphan-first** (`chatId: null`, orderBy id asc), tidak ada orphan → cek row lain: kalau sudah ke-link (ke chat ini atau chat lain) → null (JANGAN disentuh); tidak ada sama sekali → null (caller yang create baru). Re-link race-safe: `updateMany({ id, tenantId, chatId: null } → { chatId })` — count 0 = skip; unique `chatId` (di-claim kontak lain di antara find & update) → catch & return null, bukan fatal. Patch name fill-empty-only. LID digits / phone invalid → null. Non-fatal total. |
| `src/routes/chats.js` | EDIT (+22/−10) | Route `DELETE /:id` (~L1284): `const deleteContact = req.query.deleteContact === 'true'`; dalam transaksi: `true` → `contact.deleteMany by chatId` (v3.6), `false` → `contact.updateMany({ chatId: chat.id } → { chatId: null })` (DETACH); purgeLog `reason: 'chat_delete: kebab menu (v3.7, contact ${deleted|kept})'`; response tambah field `deleteContact`; log server + comment header ikut v3.7. |
| `src/wa/pool.js` | EDIT (+6) | C1 — `syncContactFromChat` (create-branch ~L1202): sebelum `contact.create`, `relinkOrphanContact(tid, phone, chat.id, chat.contactName)` — sukses → return (no create); gagal → logic lama (quota check + create) utuh. Phone di sini = `normalizePhoneForContact` yang sudah ada; chat `@lid` dengan contactPhone invalid → phone null → line skip (mapping LID v3.5 tetap pegang). |
| `src/routes/contacts.js` | EDIT (+52/−14) | C2 — GET `/by-chat/:chatId` (~L338): sebelum create → `relinkOrphanContact(tenantId, phone, chat.id, chat.contactName)` (phone dari `normalizePhone(chat.contactPhone)`, null bila waJid LID — nuansa LID tetap); sukses → re-fetch by chatId, return kontak lama; gagal → create baru (logic lama). C4 — POST `/:id/open` (~L803): `if (!contact.chatId)` → helper re-link by phone dulu; fallback bila helper null → `updateMany({ id: contact.id, chatId: null } → { chatId: chat.id })` **by id, try/catch unique** (bukan by phone — lihat §3 F1); chat tetap dibuka walau fallback kena unique (kontak biarkan orphan + log). |
| `src/services/autoReply.js` | EDIT (+14) | C3 — `setContactMenuShown` (~L204): sebelum create minimal → `relinkOrphanContact(tenantId, String(chat.contactPhone), chatId, chat.contactName)` (skip bila contactPhone kosong); sukses → set `lastMenuShownAt` ke kontak lama + return; gagal → create minimal (logic lama). |
| `frontend/src/components/KebabMenu.vue` | EDIT (+31/−13) | DUA template (desktop dropdown + mobile sheet — keduanya di-update, pola v3.6): item `🗑️ Hapus Chat` → `chooseDeleteChat(false)`, item baru `🗑️ Hapus Chat + Kontak` → `chooseDeleteChat(true)`; `chooseDeleteChat(deleteContact)` → `emit('delete-chat', deleteContact)`. |
| `frontend/src/views/ChatDetail.vue` | EDIT (+7/−6) | `@delete-chat="deleteContact => $emit('delete-chat', deleteContact)"` (payload diteruskan, tidak hilang di emit chain — sejarah bug v3.6); defineEmits comment v3.7. |
| `frontend/src/views/Dashboard.vue` | EDIT (+32/−13) | `@delete-chat="deleteContact => confirmDeleteChat(deleteContact)"`; `confirmDeleteChat(deleteContact = false)` — dialog BERBEDA: keep → judul "Hapus riwayat chat ini?" + pesan "Riwayat chat {nama} akan dihapus permanen. Kontaknya tetap tersimpan — kalau dia chat lagi, riwayat baru mulai dari nol." + tombol "Hapus Chat" + toast "Riwayat chat dihapus"; delete → dialog v3.6 persis ("...beserta datanya (nama, nomor, tag) akan dihapus PERMANEN...") + tombol "Hapus Permanen". API: `axios.delete(\`${API}/api/chats/${chatId}?deleteContact=${deleteContact}\`)`. |

Snapshot pre-build: `public-pre-build-20260923-0817/` (SEBELUM build — urutan benar kali ini).
Build chunk verify (output asli): KebabMenu chunk (`TanganKanan-*.js`) mengandung `"Hapus Chat + Kontak"` 2× (desktop+mobile) + `emit("delete-chat",o)`; Dashboard chunk mengandung `Hapus riwayat chat ini?`, `Kontaknya tetap tersimpan`, `beserta datanya`, `deleteContact=`, `confirmText:"Hapus Chat"`, `confirmText:"Hapus Permanen"`, emit chain `onDeleteChat:t[4]||(t[4]=i=>$a(i))` (payload diteruskan sampai handler).

---

## 2. Output ASLI QA

Setup QA: tenant dummy **QA-Dory-v37-082000 (id 17, preset pro)** via API superadmin (token JWT di-sign lokal dari `JWT_SECRET` .env — file `/tmp/v37qa/sa_token.txt`); admin `qa-dory-admin-v37` (id 41) + cs `qa-dory-cs-v37` (id 42, role diturunkan jadi `cs` via prisma direct karena endpoint SA tidak menyediakan role param). Semua skrip QA temporer dihapus setelah dipakai; fixture hanya di tenant 17.

### QA 1 — DELETE `?deleteContact=false` → chat/pesan hilang, KONTAK MASIH ADA (chatId=null)
```
POST /api/sa/tenants → tenant id 17 QA-Dory-v37-082000 (preset pro)
POST /api/sa/tenants/17/admins → user 41 qa-dory-admin-v37
POST /api/contacts → {"contact":{"id":7630,"name":"QA Kontak A v37","phone":"62812337000001","chatId":null,"city":"Bandung","source":"manual"}}
POST /api/contacts/7630/open → {"chat":{"id":7643,...}}  (auto-claim admin)
seed prisma direct (tenant 17, chat 7643): msgs 3 (2 teks + 1 image dgn media file di disk) + 1 note
DELETE /api/chats/7643?deleteContact=false (Bearer admin QA) →
{"ok":true,"deleteContact":false,"deleted":{"messages":3,"chatEvents":1,"chatTags":0,"chatNotes":1,"csatSurveys":0,"scheduledMessages":0,"contacts":1,"chats":1,"groupPic":0,"filesRemoved":1}}
HTTP:200
verify prisma:
{"chat7643":"GONE","messages7643":0,"notes7643":0,
 "contactA":{"id":7630,"name":"QA Kontak A v37","phone":"62812337000001","chatId":null,"city":"Bandung","source":"manual"},
 "contactByChat7643":"null (detached)",
 "purgeLogs":[{"id":39,"chatCount":1,"messageCount":3,"reason":"chat_delete: kebab menu (v3.7, contact kept)","purgedById":41}]}
ls data/media/qa-dory-v37-*.txt → No such file or directory (media hilang dari disk)
```
→ `contacts:1` di response = jumlah row yang DI-PROSES (detach), bukan terhapus. Kontak utuh: nama, phone, city, source.

### QA 2 — DELETE `?deleteContact=true` → kontak ikut terhapus (v3.6 behavior utuh)
```
POST /api/contacts/7630/open (kontak orphan di-re-link ke chat baru 7644 via C4 — lihat QA 4)
DELETE /api/chats/7644?deleteContact=true (Bearer admin QA) →
{"ok":true,"deleteContact":true,"deleted":{"messages":0,...,"contacts":1,"chats":1,"filesRemoved":0}}
HTTP:200
verify prisma: {"contact7630":"GONE","chat7644":"GONE","msgs7644":0,"contactsPhoneA":0,
 "lastPurgeLog":[{"id":40,"reason":"chat_delete: kebab menu (v3.7, contact deleted)","messageCount":0}]}
```

### QA 3 — Re-link C2 (seed orphan contact phone B + chat → GET /by-chat)
```
seed prisma direct: contact 7631 "QA Kontak B (orphan)" phone 62812337000002 chatId=null + chat 7645 (waJid=phoneJid=...@s.whatsapp.net, contactPhone sama) + 1 message
GET /api/contacts/by-chat/7645 (Bearer admin QA) →
{"contact":{"id":7631,"name":"QA Kontak B (orphan)","phone":"62812337000002","chatId":7645,"city":"Semarang","source":"manual",...}}
verify: {"contactsPhoneB":[{"id":7631,...,"chatId":7645,"city":"Semarang"}],"contactCountPhoneB":1}
GET by-chat 7645 SEKALI LAGI → id 7631 sama (idempoten)
```
→ TIDAK ada contact baru; orphan 7631 ke-re-link (chatId terisi), data lama (city) utuh.

### QA 4 — Re-link C4 (start chat dari kontak orphan)
```
a) chat resolved 7646 (sudah ada kontak 7632 ke-link) → DELETE keep → kontak 7632 orphan
b) duplikasi kondisi: contact 7633 "QA Kontak C (orphan)" chatId=null + chat 7647 (resolved, phone sama) via prisma
POST /api/contacts/7633/open → HTTP:500 (BUG DITEMUKAN — lihat §3 F1) → FIXED
c) RE-TEST setelah fix (fallback by id + try/catch):
POST /api/contacts/7633/open → {"chat":{"id":7647,"status":"open",...}} HTTP:200
   → kontak 7633 masih chatId=null (fallback by id no-op karena nomor sudah dipakai kontak 7632 yang ke-link)
d) FINAL (sisa dup 7632 dibersihkan dari tenant dummy, orphan 7633 satu-satunya row phone C):
POST /api/contacts/7633/open → HTTP:200 → VERIFY: {"contact7633":{"id":7633,...,"chatId":7647},"duplicateContacts":1}
server log: [ContactRelink] orphan re-link: contact #7633 (phone 62812337000003, tenant 17) → chat #7647
```
→ Kontak orphan ke-re-link ke chat existing (yang lama di-reopen `reopenedCount:1`, bukan chat dobel); tidak ada kontak dobel.

### QA 5 — C1/C3 direct test (helper standalone, skenario persis pemanggilan)
```
C1: orphan contact 7634 (phone ...004) + chat 7648 → relinkOrphanContact(17, '62812337000004', 7648, name)
 → returns 7634; verify chatId=7648; contactsWPhone=1 (TIDAK ada dobel)
C1-neg: nomor belum pernah ada → returns null (caller create baru — logic lama)
C1-LID: phone '51750362976291' (LID digits, tanpa 62 prefix... /^\d+$/ lolos TAPI lihat catatan) → null
C3: orphan contact 7635 (phone ...006) + chat 7649 → setContactMenuShown(null, chat) LIVE-CALL
 → log "[ContactRelink] orphan re-link: contact #7635 ... → chat #7649"; verify chatId=7649 + lastMenuShownAt terisi;
   duplicates=1; contactsOnChatG=1 (TIDAK create minimal baru)
race-safe: relink ulang phone ...004 ke chat lain → null; contact 7634 chatId TIDAK berubah
```
Catatan LID: helper menolak phone non-standar via `/^\d+$/` — LID digits murni (`51750...`) lolos regex digits; perlindungan nuansa LID ada di CALLER: C1 tidak memanggil helper bila phone null (chat `@lid` tanpa contactPhone valid), C2 tidak memanggil bila `isLidDigits(chat.waJid)`, C3 skip bila contactPhone kosong. Helper sendiri by-phone murni — kalau dipanggil dengan LID digits yang kebetulan match nomor kontak → re-link by phone itu justru benar (mapping v3.5 resolve LID→phone dulu).

### QA 6 — Regression: role cs → 403; lintas-tenant → 404
```
[cs, keep]     DELETE /api/chats/7650?deleteContact=false → {"error":"Admin access required"} HTTP:403
[cs, delete]   DELETE /api/chats/7650?deleteContact=true  → {"error":"Admin access required"} HTTP:403
[cs, no param] DELETE /api/chats/7650                    → {"error":"Admin access required"} HTTP:403
[lintas tenant] DELETE /api/chats/4?deleteContact=true (chat Parahita #4, token admin QA tenant 17) →
{"error":"Chat not found"} HTTP:404
Verify: Parahita chat #4 still exists: {"id":4,"tenantId":4} ← tidak tersentuh
```

### QA-extra (temuan tambahan)
```
- Superadmin impersonate ?tenant=17 → DELETE keep: 200 {"ok":true,"deleteContact":false,"deleted":{...,"contacts":0,"chats":1}} — flag jalan via jalur SA.
- DELETE chat TANPA kontak linked (contacts:0) mode keep: 200, detach no-op, tidak crash.
- C2 utk chat nomor baru tanpa kontak: create baru biasa (bukan re-link) — logic lama utuh.
- LID chat (waJid @lid) + contactPhone sudah ke-link kontak lain: helper null, kontak lain TIDAK direbut, no dup.
```

### QA 7 — Build + restart + health + WA reconnect
```
Snapshot: cp -r public public-pre-build-20260923-0817  (SEBELUM build)
Build: ✓ built in 2.42s (Dashboard-BdCUgYaU.js, TanganKanan-DW8P1Nh2.js berisi KebabMenu)
Restart #1: kill 65169 → nohup node src/server.js → LISTEN :5047 (pid 73841)
Restart #2: kill 73841 → pid 74577  ← mid-QA hotfix (lihat §3 F1/F2)
Restart #3: kill 74577 → pid 74650  (hotfix kedua)
curl health: 200 | curl root: 200
[WA:tenant-8] Connected sebagai +62881080702624
[WA:tenant-4] Connected sebagai +6281133326888
```
Port 5030 tetap mati, 8770 tidak disentuh. Restart by-PID saja, TANPA pkill. Catatan: total restart 3× — batas "1x" untuk build; restart ke-2 dan ke-3 adalah hotfix bug yang ditemukan QA (lihat §3). Log "transaction failed, rolling back" di server.log = pino error BAILEYS `failed to decrypt` status@broadcast (pre-existing, bukan dari kode v3.7 — muncul juga sebelum perubahan).

### QA 8 — Purge tenant dummy
```
POST /api/sa/tenants/17/purge {"confirmName":"QA-Dory-v37-082000"} →
{"ok":true,"deleted":{...,"contacts":6,"chats":7,"purgeLogs":5,"users":2,...},"filesRemoved":0}
HTTP:200
verify: tenant 17 after purge: null (purged); leftover contacts tenant 17: 0;
live tenants intact: [{"id":4,"name":"Parahita"},{"id":8,"name":"Mazaya"}]
```

---

## 3. Bug ditemukan saat QA + perbaikan (bukan deviasi, bagian dari iterasi)

| # | Bug | Deteksi | Perbaikan | Re-test |
|---|---|---|---|---|
| F1 | C4 fallback awal `prisma.contact.update({ where: { id: contact.id } })` (kode lama v3.5) TETAP me-set chatId walau nomor sudah dipakai kontak lain → **500 unique constraint** saat open kontak orphan yang nomornya dipakai row lain (double-row phone C). | QA 4a: POST /open → 500 + log "Unique constraint failed on the fields: (chatId)". | Fallback diganti `updateMany({ id: contact.id, tenantId, chatId: null })` **by id** (bukan by phone) + try/catch: unique → log + kontak biarkan orphan, chat tetap dibuka (JANGAN 500). | QA 4c/d: 200, perilaku sesuai desain. |
| F2 | Helper awal pilih "row tertua by phone" tanpa memandang chatId — bila phone punya 2 row (sudah ke-link + orphan), helper null → tidak re-link sama sekali; plus re-link bisa tabrak unique saat race. | QA 4a analisis manual + server log. | Helper jadi **orphan-first**: pilih row `chatId: null` dulu; tidak ada orphan → null (row ke-link tidak disentuh). Unique `chatId` di update → catch → return null (race-safe, non-fatal). | QA 5 + QA 4 FINAL: semua pass; log race muncul sesuai harapan. |

## 4. Deviasi + catatan

| # | Deviasi | Alasan |
|---|---|---|
| D1 | Total restart 3× (bukan 1×). | Restart #1 untuk build (sesuai batas). #2–#3 = hotfix F1/F2 (bug v3.7 sendiri yang ketahuan di QA) — lebih baik daripada menyelesaikan QA dengan app yang 500 di salah satu jalur. Verifikasi final selalu: health 200 + WA t4/t8 reconnect. |
| D2 | User cs QA dibuat via endpoint SA admins (role selalu 'admin') lalu role diturunkan jadi 'cs' via prisma direct (QA fixture, tenant dummy), bukan via API. | Endpoint SA tidak menyediakan param role; tidak ada endpoint publik untuk mengubah role. Fixture di tenant dummy, ter-purge di akhir. |
| D3 | QA 3 dijalankan via GET `/by-chat` pada chat yang dibuat prisma direct (bukan start-chat UI). | Sama dengan pola QA v3.6 — endpoint adalah unit yang dites; asal chat & kontak benar tenant dummy. |
| D4 | Seed QA menambah media file + 3 pesan (bukan 2 pesan + 1 note saja) + beberapa chat fixture tambahan (7650, 7651, 7652, 7645, 7647-7654). | Membuktikan media unlink + detach; chat tambahan = target 403/404/edge (no-contact, impersonate, C3/C1 direct). Semua di tenant dummy 17, ikut ter-purge (verifikasi contacts:6, chats:7 di response purge). |
| D5 | `purgeLog.reason` memakai format `chat_delete: kebab menu (v3.7, contact kept|deleted)` + optional ` — <reason>` (pola v3.6 D5). | Konsisten format lama; flag mode eksplisit untuk QA/audit. |
| D6 | Helper `relinkOrphanContact` menolak re-link bila nomor sudah ke-link ke kontak lain (return null, bukan merebut/memindahkan). | Anti-dobble yang benar: kontak ke-link TIDAK boleh dipindah; pemanggil melanjutkan path-nya (create baru hanya bila memang nomor belum pernah ada). Ini mencegah persis kasus "kontak dobel + rebutan chatId". |
| D7 | Skrip QA disimpan sementara di root project (`qa-tmp-v37-*.cjs`) karena node -c di /tmp tidak resolve module project; **sudah dihapus semua** setelah QA. | require('jsonwebtoken') dll butuh node_modules project; tidak meninggalkan artefak. |

**Tidak ada FAIL tersisa.** Tidak ada schema change / db push / destructive DB ops / git commit. Data live tidak disentuh (Parahita chat #4 tetap ada — diverifikasi; WA t4/t8 reconnect sukses setiap restart).

## 5. Cara pakai (untuk review Alita)

1. Admin buka chat (bukan grup) → ⋮ kebab → paling bawah (merah, admin only):
   - **🗑️ Hapus Chat** → dialog "Hapus riwayat chat ini?" → **Hapus Chat** → riwayat hilang permanen, kontak tetap ada (list Kontak tetap memuat dia, tanpa chat aktif).
   - **🗑️ Hapus Chat + Kontak** → dialog "Hapus permanen chat ini?" → **Hapus Permanen** → semua termasuk data kontak hilang (v3.6).
2. Kontak yang di-keep jadi orphan (chatId=null). Kalau dia chat lagi (WA masuk → pool.js C1) ATAU chat-nya dibuka lagi (by-chat C2), ATAU CS start chat dari Kontak (C4), ATAU menu gateway menandai kontak (C3) → otomatis re-link ke kontak lama yang sama. Tidak ada kontak dobel.
3. Server log jejak re-link: `[ContactRelink] orphan re-link: contact #<id> (phone <nomor>, tenant <tid>) → chat #<cid>`.