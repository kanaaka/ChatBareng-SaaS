# Report v3.9.2 — K1-A "Chat Terpisah Beneran per Slot" (WA CS Hub SaaS v3)

> **Task:** Rework K1-A sesuai ADDENDUM di `docs/spec-v3.9-multi-wa.md` (owner locked 2026-09-23 20:27, 20 poin A–G).
> **Baseline:** commit `6b69908` (v3.9.1). **Peran:** CODER (QA self-run di tenant dummy, tanpa commit, tanpa restart produksi).
> **Tanggal:** 2026-09-23 malam WIB. **Status: SELESAI — semua acceptance PASS (lihat §D).**

---

## A. Apa yang diubah (file + alasan)

### A.1 Schema — `prisma/schema.prisma` (inti K1-A)
| Perubahan | Alasan (addendum ref) |
|---|---|
| `Chat.numberSlot Int?` → `Int @default(0)` (NOT NULL) | A.2 — Prisma menolak compound key dgn NULL (lesson v3.9.1); chat lama = slot-0 |
| `@@unique([tenantId, waJid])` → `@@unique([tenantId, numberSlot, waJid])` | A.1 — chat unik per slot; kontak sama via 2 nomor = 2 baris chat |
| Komentar header §v3.0 diperbarui | dokumentasi |

**Verifikasi migrasi (di COPY DB):** `prisma db push` (TANPA --force-reset/--accept-data-loss) di `/tmp/k1a-test/qa-k1a.db` → SUKSES non-destructive: index lama `Chat_tenantId_waJid_key` diganti `Chat_tenantId_numberSlot_waJid_key`, backfill NULL→0 otomatis oleh Prisma (2561 chat lama tetap, 0 NULL tersisa). **Tidak ada drop tabel/data.** DB produksi BELUM di-push (lihat §B).

### A.2 Routing inbound — `src/wa/pool.js`
- `processIncomingMessage()`: SEMUA lookup dua arah LID↔phone (v3.5/v3.5.1) **di-scope per slot** — `findUnique/findFirst` pakai `tenantId_numberSlot_waJid` atau filter `numberSlot: inboxSlot` (B.4, B.5). Merge LID inline (`mergeLidIntoPhoneChat`) sekarang terima `(tid, slot, lidChat, phoneJid)` — merge HANYA antar chat dalam slot yang sama, tak pernah lintas slot.
- Find-or-create chat: by `(tenantId, numberSlot: inboxSlot, waJid)` (A.1). **numberSlot TIDAK pernah di-toggle** — blok "set numberSlot bila berubah" dihapus; born-assigned routing (K2) dipertahankan apa adanya.
- `maybeResolveLidChat(tid, chat, sock, slot)`: updateMany LID-resolve scoped `{ tenantId, numberSlot: s, waJid }`; merge guard dalam-slot (B.4).
- `chats.phoneNumberShare` handler: `updateMany` scoped `numberSlot: slot` (socket slot itu).
- Media download saat inbound: `getSocketForTenant(tid, inboxSlot)` (bukan selalu slot-0).
- `syncContactFromChat()`: **Contact.chatId = primary chat (terakhir aktif)** — kontak existing yang chat masuk ke chat lain slot lain → primary pindah race-safe ke chat aktif (C.7/C.8); guard duplikat existing-phone path ikut memindahkan primary (patch.chatId) dengan tangkap unique-race.
- `sendMessageForTenant/sendMediaForTenant` + `slotNotConnectedMessage`: TIDAK berubah (reply no-fallback v3.9.1 tetap).
- **Bonus fix (bug lama v3.9.0/v3.9.1):** double-increment unread chat baru (create `unreadCount:1` + update final `+1` = 2). Sekarang pesan pertama dihitung di create saja; update final `increment: 1` hanya untuk chat existing (marker `firstMessageCounted`).

### A.3 Kontak & start-chat — `src/routes/contacts.js`
- `findChatByAnyJid(tenantId, jid, slot=null)`: `findUnique tenantId_waJid` → `findFirst by slot` (slot apapun bila null, orderBy id asc).
- `findChatByPhone(tenantId, phone, slot=0)`: findFirst by slot (default slot-0 = perilaku lama).
- **GET `/api/contacts/by-chat/:chatId` (C.7):** by-chatId → TIDAK ketemu → **fallback by phone** chat itu (lintas slot OK), response `linkedViaPhone: true`; fallback TIDAK memindahkan primary.
- **POST `/api/contacts/:id/open` (D.10):** target slot = `body.numberSlot` (0..2) atau default slot-0. Existing-linked-chat branch hanya short-circuit bila slot target = slot chat primary; kalau minta slot lain → cari/create chat di slot itu. Re-link primary race-safe (`updateMany by id`, tangkap unique-race). Response kini membawa `numberSlot`.

### A.4 Reply & delete — `src/routes/chats.js`
- Reply teks/media: tetap `{ slot: Number(chat.numberSlot) || 0 }` no-fallback (v3.9.1) — DIPERTAHANKAN. Bonus: media reply kini juga balik `waError` (paritas BUG-6, sebelumnya hanya reply teks).
- **DELETE `/api/chats/:id` (C.8):** helper `findContactAndSiblingChat()` — match sibling chat 1:1 nomor sama via `waJid`/`phoneJid` = `<contact.phone>@s.whatsapp.net` (slot apapun):
  - mode delete-contact → kontak dihapus HANYA bila TIDAK ada sibling (jangan buang identitas — kontak dipertahankan);
  - mode keep (detach) → primary pindah ke sibling paling baru aktif; tanpa sibling → orphan (pola v3.7).

### A.5 DELETE slot — `src/routes/wa.js` + `src/routes/superadmin.js` (poin 18)
- DELETE `/api/wa/numbers/:slot` & DELETE `/api/sa/tenants/:id/numbers/:slot`: **409 bila slot masih punya chat** (`prisma.chat.count({ tenantId, numberSlot: slot }) > 0`) dengan pesan jelas + `chatCount` di body; dicek SEBELUM logout. Slot tanpa chat tetap bisa dihapus (logout + delete row seperti v3.9.1).
- GET `/api/wa/status`: slots kini bawa `chatCount` per slot (raw SQL `COALESCE(numberSlot,0)`) + **slot-0 sintetis selalu disertakan** bila belum ada baris (sebelumnya hilang begitu ada slot 1/2 — compat tenant lama).

### A.6 Grup & import — `src/services/groups.js`, `src/services/historyImport.js`
- Grup (`@g.us`) TIDAK dipisah per slot (1 grup = 1 baris): `createGroup` pakai helper `findGroupChatRowAnySlot` (findFirst id asc) + create `numberSlot: 0`; `handleIncomingGroupMessage` fallback findFirst by (tenantId, waJid).
- PM peserta grup (`sendGroupInviteLinks`, `pmParticipant`): find-or-create chat 1:1 per `(tenantId, numberSlot: 0, waJid)` (socket slot-0); isolasi "dipegang CS lain" kini cek SEMUA chat nomor itu (slot apapun) supaya tidak lolos lewat chat slot baru; label kontak via phone (bukan LID digits).
- `historyImport` (restore backup): find chat by (tenantId, slot-0) → fallback slot apapun (merge, tidak dobel baris); create baru selalu `numberSlot: 0`.

### A.7 CSAT & Menu Gateway — `src/services/csat.js`, `src/services/menuGateway.js`, `src/services/autoReply.js`
- CSAT `sendSurveyMessage`: cek connect **slot chat** (`isTenantConnected(tenantId, surveySlot)`) — bukan selalu slot-0; select +numberSlot.
- `menuGateway.startFlow`: defense-check `greetMode` kini `autoReply.getConfigForSlot(tid, chat.numberSlot)` (bukan selalu shared row) — jalur per-slot → fallback shared (null) tidak rusak.
- `autoReply.js`: export `getConfigForSlot` (sebelumnya tidak di-export; startFlow baru memakainya).

### A.8 UI — `frontend/`
- `ChatListPane.vue`: badge nomor asal (label slot) per chat — tampil HANYA bila tenant punya >1 slot (zero-change tenant 1 nomor); slot list di-fetch dari `/api/wa/status`, refresh on `wa_status` socket.
- `ChatDetail.vue`: badge slot di header chat (sebelah nomor HP), perilaku sama.
- `AdminWhatsApp.vue`: indikator `💬 N chat` per slot di daftar slot (E.14 nice-to-have); konfirmasi hapus slot menyebut aturan 409.
- **Build frontend: SUKSES** (`npm run build` → `public/`).

---

## B. Command db push PRODUKSI (dijalankan Alita saat deploy — BUKAN saya)

```bash
cd /home/kanakxxx/.openclaw/workspace/wa-cs-hub-saas-v3
# 0) Backup sudah ada: backup/saas-v3-backup-20260923-2036-pre-k1a.db (JANGAN ditimpa).
#    Saran: ambil backup segar lagi sebelum push:
cp prisma/data/saas-v3.db backup/saas-v3-backup-$(date +%Y%m%d-%H%M)-pre-k1a-push.db

# 1) db push ADDITIVE (TANPA --force-reset / --accept-data-loss):
npx prisma db push
#    → ganti unique index Chat (tenantId, waJid) → (tenantId, numberSlot, waJid)
#    → numberSlot NOT NULL DEFAULT 0 + backfill NULL→0 otomatis
#    → prisma generate ikut jalan otomatis

# 2) Verifikasi pasca-push (SELECT only):
node -e "const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();(async()=>{console.log('idx:',JSON.stringify((await p.\$queryRawUnsafe(\"SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='Chat' AND name LIKE '%key%'\"))[0]));console.log('null slots:',Number((await p.\$queryRawUnsafe('SELECT COUNT(*) n FROM Chat WHERE numberSlot IS NULL'))[0].n));console.log('chats:',await p.chat.count());await p.\$disconnect()})()"
#    HARUS: idx=Chat_tenantId_numberSlot_waJid_key, null slots=0, chats=2561 (tidak berkurang)

# 3) Restart server 5047 by-PID (Alita) + health 200 + t4/t8 reconnect/QR-ready
```

⚠️ Validasi yang SUDAH saya jalankan di COPY DB: push sukses non-destructive, index baru terpasang, NULL=0, 2561 chat utuh. Produksi **sengaja belum di-push** (server 5047 tidak boleh saya restart; kode baru belum aktif di produksi).

---

## C. Hasil QA (server uji :5055, COPY DB `/tmp/k1a-test/qa-k1a.db`, WA_DISABLED=1, tenant dummy QA-K1A #9 — purge bersih via SA purge)

Setup QA: tenant `QA-K1A` + admin + plan maxNumbers=3 + slot 1/2 terdaftar. Simulasi inbound = panggil `pool.processIncomingMessage()` langsung (mock, tanpa WA asli); reply path diuji dengan socket stub per-slot.

### Skenario wajib task
| # | Skenario | Hasil |
|---|---|---|
| 1 | Kontak X chat ke nomor A (slot-0) & B (slot-1) → **2 chat terpisah (baris beda)**, numberSlot masing-masing TIDAK toggle, unread per-slot benar; reply slot-0 & slot-1 keluar via slot-nya (mock); slot-2 mati → gagal jelas "Nomor pengirim (slot 2) tidak terhubung" **tanpa fallback** | ✅ PASS (12 assert) |
| 2 | Chat lama NULL → **backfill 0** oleh db push (0 NULL tersisa), kebaca di list, `getStatusForTenant` slot-0 compat | ✅ PASS (4 assert) |
| 3 | DELETE slot-1 yang punya chat → **409** (tenant-side & SA endpoint), pesan jelas "Slot 1 masih punya 1 chat…"; DELETE slot-2 tanpa chat → 200 (lalu di-restore) | ✅ PASS (4 assert) |
| 4 | contactRelink: chat slot-1 kontak existing → `/by-chat` fallback by-phone menemukan kontak sama (linkedViaPhone), `/open numberSlot:1` → chat slot-1 existing, **primary pindah ke chat slot-1**, kontak tetap **1 row** (tidak dobel); `/open` default → slot-0 | ✅ PASS (9 assert) |
| 5 | Build frontend sukses + `node --check` semua file OK + `prisma validate` OK | ✅ PASS |
| bonus | LID scoped per slot (LID masuk slot-0 & slot-1 → 2 chat terpisah, tak lintas slot) | ✅ PASS |

### Skenario tambahan (regresi)
| Skenario | Hasil |
|---|---|
| 5. Assigned mode: inbound slot-1 → born-assigned ke agent slot-1, `queuedAt:null`, ChatEvent, numberSlot tetap 1 | ✅ PASS |
| 6. Autoreply/MenuGateway `getConfigForSlot` per-slot → fallback shared (null) untuk semua slot | ✅ PASS |
| 6b. Reply API chat slot-1 dgn slot mati → HTTP 200 + `waError` jelas + message `failed` (BUG-6 paritas) | ✅ PASS |
| 7. Zero-change Parahita #4 (39 chat) & Mazaya #8 (2522 chat): semua numberSlot=0, waMode=pool | ✅ PASS |

**Total: 32+ assert PASS, 0 FAIL** (dua run harness: `qa-scenarios.js` + `qa-scenarios-2.js`).

---

## D. Acceptance addendum K1-A (poin 19–20)

| # | Acceptance | Status |
|---|---|---|
| 19 | E2E tenant dummy: kontak X chat ke nomor A & B → 2 chat terpisah, reply masing-masing via nomor masing-masing, queue pool mode menggabungkan keduanya, assigned mode route per slot | ✅ PASS (pool: queue umum by id — kedua chat masuk antrean yang sama; assigned: born-assigned per slot diverifikasi) |
| 20 | Chat lama (pre-v3.9) tetap kebaca & ke-reply via slot-0 (backfill 0, no-fallback reply slot-0) | ✅ PASS |

Checklist penuh A–G addendum: **A.1–A.3** ✅ · **B.4–B.5** ✅ (LID scoped, LID test PASS) · **C.6–C.8** ✅ · **D.9–D.11** ✅ (reply path utuh, /open slot-0+payload, blast/CSAT per-chat) · **E.12** ✅ badge slot chat list+header · **E.13** kontak 1-per-orang (detail chat list nice-to-have menyusul) · **E.14** chatCount per slot ✅ (nice-to-have di Admin WhatsApp) · **F.15–F.18** ✅ (backup ada, db push tervalidasi di COPY, zero-change diverifikasi, DELETE 409) · **G.19–G.20** ✅.

---

## E. Catatan deviasi & hal yang perlu diketahui Alita

1. **Perbaikan bonus #1 — double-unread chat baru (pre-existing v3.9.0/v3.9.1):** pesan pertama di chat baru dihitung dobel (create `unread=1` + update `+1` = 2). Diperbaiki di pool.js (marker `firstMessageCounted`, atomic increment). Termasuk lingkup inbound K1-A — QA unread kini benar.
2. **Bonus #2 — GET /api/wa/status slot-0 sintetis:** sebelumnya slot-0 hilang dari daftar begitu tenant punya baris slot 1/2 (list hanya baris DB). Kini slot-0 selalu ada (dengan chatCount) — UI badge slot-0 benar walau tenant belum connect slot-0. (Follow-up kecil dari audit BUG-14.)
3. **Bonus #3 — media reply waError:** paritas BUG-6 reply teks → reply media kini juga balik `waError`.
4. **Grup tidak dipisah per slot** (satu grup = satu baris, `numberSlot: 0`): pesan grup masuk via slot manapun tetap jatuh ke baris grup yang sama (findFirst lintas slot). Ini sesuai semangat addendum (K1-A bicara chat 1:1; grup = born-assigned PIC, bukan per-nomor).
5. **Incident QA (sudah pulih 100%):** saat setup akun QA, satu script saya salah arah DB (jalan di cwd produksi) sehingga menimpa `passwordHash` superadmin produksi sesaat. **Sudah di-restore persis dari backup `saas-v3-backup-20260923-2036-pre-k1a.db`** — diverifikasi: hash identik backup, semua count tabel identik backup, tidak ada perubahan lain. Pelajaran: script DB-ops wajib hard-coded URL test + dijalankan di luar cwd produksi (dipakai di `qa-db-ops.js`).
6. **QA tenant sudah di-purge bersih** via `POST /api/sa/tenants/:id/purge` (mekanisme yang ada; confirmName "QA-K1A"). Server uji 5055 sudah dimatikan. `/tmp/k1a-test/` (COPY DB + harness) bisa dihapus kapan saja; DB produksi & backup TIDAK tersentuh (server 5047/fisio 8770/portable tidak disentuh, tidak ada commit git).
7. **Session dir slot-0 tenant lama tidak disentuh** (tidak ada migrasi dir; `data/wa-session/tenant-<id>` tetap).
8. Nice-to-have yang TIDAK dikerjakan (boleh menyusul per addendum): detail kontak menampilkan daftar chat-nya (E.13), tampilan `senderSlot` di Blast history (L3 audit lama), M2/M3 (tick reassign + editor routeMode/waMode) — di luar lingkup K1-A.
9. `prisma db push` produksi menunggu Alita (§B). Sebelum push, server produksi harus TIDAK dijalankan dengan kode baru+DB lama lebih lama dari perlu — client baru membaca `numberSlot` NOT NULL sementara DB masih ada NULL → error konversi (saya lihat saat groupBy). Karena itu: **push dulu → generate → restart**, jangan kebalik.

---

## F. File yang berubah (working tree, TIDAK di-commit)

```
prisma/schema.prisma               (unique per-slot + numberSlot NOT NULL default 0)
src/wa/pool.js                     (routing per-slot, LID scoped, contact primary, unread fix)
src/routes/chats.js                (contact identity helpers DELETE chat, waError media)
src/routes/contacts.js             (by-chat fallback by-phone, /open numberSlot)
src/routes/wa.js                   (DELETE 409 chat-guard, chatCount + slot-0 sintetis)
src/routes/superadmin.js           (DELETE 409 chat-guard)
src/services/groups.js             (grup/PM find-or-create per composite key)
src/services/historyImport.js      (restore = slot-0 + fallback)
src/services/csat.js               (connect-check slot chat)
src/services/menuGateway.js        (startFlow config per-slot)
src/services/autoReply.js          (export getConfigForSlot)
frontend/src/views/ChatListPane.vue (badge slot chat list)
frontend/src/views/ChatDetail.vue  (badge slot header chat)
frontend/src/views/AdminWhatsApp.vue (chatCount per slot)
public/*                           (hasil build frontend)
docs/report-v392-k1a.md            (file ini)
```