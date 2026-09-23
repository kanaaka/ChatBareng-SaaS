# QA AUDIT v3.9.2 (K1-A) — "Chat Terpisah Beneran per Slot" — Kimi-K3 re-audit

> **Commit yang di-audit:** `4e7fe8d` (deploy 21:21 WIB 2026-09-23)
> **Baseline sebelumnya:** `6b69908` (v3.9.1 hotfix 12 bug).
> **Peran:** Independent QA reviewer (READ-ONLY — tidak edit file, tidak restart 5047, DB cuma SELECT via `mode=ro` + copy di `/tmp`).
> **Tanggal audit:** 2026-09-23 ~21:30 WIB.
> **Sumber kebenaran:** `docs/spec-v3.9-multi-wa.md` + ADDENDUM K1-A (poin A–G, owner locked 20:27), audit sebelumnya (`qa-v3.9-audit-k3.md`, `qa-v3.9-audit.md`), dan report coder (`docs/report-v392-k1a.md`).

---

## RINGKASAN EKSEKUTIF

**Verdict: GO dengan 3 catatan** — 1 bug MEDIUM (blast dobel via 2 slot), 1 regresi terbuka MEDIUM (PUT `/numbers/:slot` upsert tanpa kuota — carry-over dari audit v3.9 BUG-12 yang belum ditutup v3.9.1), 1 LOW (fallback silent slot invalid di `/open`).

Semua 10 checklist utama PASS. Tidak ada CRITICAL. Tidak ada HIGH. Kode sesuai claim di `report-v392-k1a.md`. Zero-change tenant 1-nomor Parahita #4 (39 chat) & Mazaya #8 (2522 chat) terbukti full `numberSlot=0`, dan index unik baru `Chat_tenantId_numberSlot_waJid_key` terpasang di produksi dengan 0 NULL.

| Kategori | Jumlah |
|---|---|
| CRITICAL | 0 |
| HIGH | 0 |
| MEDIUM | 2 |
| LOW | 1 |

---

## CHECKLIST VERIFIKASI (1–10)

### 1. Schema ✅ PASS
- **Claim:** `Chat.numberSlot Int @default(0)` NOT NULL; `@@unique([tenantId, numberSlot, waJid])`; index produksi `Chat_tenantId_numberSlot_waJid_key`, 0 NULL, 2561 chat.
- **Bukti:**
  - `prisma/schema.prisma:152` — `numberSlot Int @default(0)` (NOT NULL, default 0)
  - `prisma/schema.prisma:162` — `@@unique([tenantId, numberSlot, waJid])`
  - Verifikasi live (SELECT-only di copy DB produksi `prisma/data/saas-v3.db?mode=ro`):
    ```
    indexes: [{"name":"Chat_tenantId_numberSlot_waJid_key"}]
    null slots: 0
    total chats: 2561
    per-slot: [{"numberSlot":0,"n":2561}]
    col notnull: [{"name":"numberSlot","notnull":1,"dflt_value":"0"}]
    ```
- **Additive terbukti:** kolom lama tidak hilang, count sama 2561.

### 2. pool.js ✅ PASS
- **Find-or-create by (tenantId, numberSlot, waJid):** `pool.js:1163` `findUnique({ tenantId_numberSlot_waJid })`, lalu `create` dengan `numberSlot: inboxSlot` (line 1174). ✅
- **LID↔phone two-way routing scoped per slot:** semua lookup di `processIncomingMessage` (line 978–1067) pakai `tenantId_numberSlot_waJid` atau `numberSlot: inboxSlot` filter; `mergeLidIntoPhoneChat(tid, slot, ...)` line 852–901 with `numberSlot: s` di WHERE clause; `maybeResolveLidChat` line 909–945 juga `numberSlot: s` scoped. ✅
- **numberSlot TIDAK pernah di-toggle:** blok "set numberSlot bila berubah" memang hilang (line 1199–1201 hanya baca `chat.numberSlot` tidak pernah update ke nilai lain). ✅
- **born-assigned (K2) utuh:** line 1188–1263 — blok `if (route === 'assigned' && chat.assignedToId == null)` masih jalan, `queuedAt: null`, ChatEvent, push notif, `numberSlot: inboxSlot` di broadcast. ✅
- **Media download pakai socket slot inbox:** line 1106 — `const sock = getSocketForTenant(tid, inboxSlot)`. ✅
- **Unread double-increment fix benar:** `firstMessageCounted` flag (line 967, 1181), create dengan `unreadCount: msg.key.fromMe ? 0 : 1`, update final line 1367: `if (!msg.key.fromMe && !firstMessageCounted) chatUpdateFinal.unreadCount = { increment: 1 }`. Pesan pertama cuma dihitung 1x (di create saja). ✅

### 3. Reply no-fallback (K3) ✅ PASS
- **chats reply teks:** `routes/chats.js:913–915` — `replySlot = Number(chat.numberSlot) || 0` + `sendMessageForTenant(..., { slot: replySlot })`. Error → catch → `waSendError` → response `waError`. ✅
- **chats reply media:** `routes/chats.js:1050–1062` — `replySlotMedia` + `sendMediaForTenant(..., { slot: replySlotMedia })`, catch → `waMediaSendError` → response `waError` (line 1141). ✅ Paritas BUG-6.
- **scheduler (v0100Scheduler.js:146):** `{ slot: Number(sm.chat?.numberSlot) || 0 }`. ✅
- **CSAT (services/csat.js:177–185):** `surveySlot = Number(chat.numberSlot) || 0` + `isTenantConnected(tenantId, surveySlot)` + send `{ slot: Number(chat.numberSlot) || 0 }`. ✅
- **autoreply (services/autoReply.js:324):** `{ slot: Number(chat.numberSlot) || 0 }`. ✅
- **menuGateway (services/menuGateway.js:180):** `{ slot: Number(chat.numberSlot) || 0 }`. ✅
- **blast (services/blast.js:228/231):** `{ slot: sendSlotBlast }` (slot dari rotate pool). ✅
- **Slot mati = error jelas, no fallback:** `slotNotConnectedMessage(tenantId, slot)` (pool.js:709) — pesan eksplisit menyebut slot; `throw notConnectedError(...)` tanpa retry ke slot lain. ✅

### 4. Kontak ✅ PASS
- **1 identity per (tenantId, phone):** `Contact.chatId @unique` (line 339 contacts.js lookup), `syncContactFromChat` (pool.js:1443+) patch by-phone tenant-scoped, anti-double via `existingPhone`/`existingChatId` guard + unique-race handle. ✅
- **Contact.chatId = primary (terakhir aktif):** pool.js:1461–1468 — `updateMany` set `chatId: chat.id` saat pesan masuk (race-safe, tangkap unique). ✅
- **`/by-chat` fallback by-phone:** `routes/contacts.js:329–356` — by chatId → tidak ketemu → by phone (lintas slot OK), response `linkedViaPhone: true`, **TIDAK memindahkan primary** (hanya tampilan). ✅
- **`/open` payload numberSlot + default slot-0:** `routes/contacts.js:765–766` — `openSlot = req.body.numberSlot (0..2) || 0`. Existing-linked-chat short-circuit HANYA bila `openSlot === contact.chat.numberSlot` (line 771) — kalau beda → cari/create chat di slot target (line 813–831). ✅
- **contactRelink tidak bikin duplikat:** `relinkOrphanContact` tetap jalan (line 842), fallback updateMany by id dengan unique-race catch. ✅
- **DELETE chat guard sibling:** `findContactAndSiblingChat` (chats.js:102–127) match sibling 1:1 nomor sama via `waJid`/`phoneJid` = `<phone>@s.whatsapp.net` (slot apapun). `deleteContactOnlyIfNotShared` (line 133) skip delete kalau sibling ada. `detachContactKeepIdentity` (line 146) primary pindah ke sibling paling baru aktif; tanpa sibling → orphan (pola v3.7). ✅

### 5. DELETE slot 409 ✅ PASS
- **Tenant-side `DELETE /api/wa/numbers/:slot` (routes/wa.js:258–284):** slot 400 invalid; slot=0 → 400 "Slot-0 tidak bisa dihapus"; cek `chatCount > 0` → 409 dengan `chatCount` di body **SEBELUM** `logoutTenant`; slot tanpa chat → logout dulu, gagal logout → 409, lalu delete row. ✅
- **SA `DELETE /api/sa/tenants/:id/numbers/:slot` (routes/superadmin.js:585–617):** mirror, slot-0 juga dilindungi (line 590), 409 dulu baru logout. ✅
- **Slot-0 selalu dilindungi** di kedua endpoint. ✅

### 6. GET /api/wa/status ✅ PASS
- **Slot-0 sintetis selalu ada:** `routes/wa.js:50–63` — `if (!seenSlots.has(0))` → unshift slot-0 sintetis dengan `_synthetic: true`. ✅
- **chatCount per slot (raw SQL COALESCE benar):** `routes/wa.js:31–34` — `SELECT COALESCE(numberSlot, 0) AS slot, COUNT(*) AS cnt FROM Chat WHERE tenantId = ? GROUP BY COALESCE(numberSlot, 0)`. COALESCE benar (akan handle NULL meski sesudah push sudah NOT NULL — robust). ✅

### 7. groups/historyImport/csat/menuGateway ✅ PASS
- **Grup = 1 baris lintas slot:** `findGroupChatRowAnySlot(tenantId, waJid)` (groups.js:200) pakai `findFirst by (tenantId, waJid)` tanpa filter slot. `handleIncomingGroupMessage` (line 992–995) juga findFirst by `(tenantId, waJid)` (tanpa slot) — pesan grup masuk via slot manapun tetap ke baris yang sama. Create selalu `numberSlot: 0` (groups.js:447). ✅
- **PM participant composite:** `sendGroupInviteLinks` (groups.js:770, 778, 782, 790) dan `pmParticipant` (groups.js:1287, 1295, 1307) — `numberSlot: 0` hardcoded + composite find-or-create. ✅
- **historyImport (services/historyImport.js:248–257):** findFirst slot-0 → fallback slot apapun (merge, tidak dobel baris); create baru `numberSlot: 0` (line 388). ✅
- **CSAT cek connect slot chat:** csat.js:177–181 `surveySlot = Number(chat.numberSlot) || 0; if (!wa.isTenantConnected(tenantId, surveySlot))`. ✅
- **menuGateway.startFlow getConfigForSlot fallback shared:** menuGateway.js:230 `getConfigForSlot(tenantId, chat.numberSlot)` + line 236 `getConfigForSlot` untuk autoCfg juga. `getConfigForSlot` (menuGateway.js:68–82) resolve slot-spesifik → fallback null (link-all shared). ✅

### 8. Zero-change tenant 1-nomor ✅ PASS
- **Verifikasi live (DB produksi read-only):**
  ```
  tenant 4 (Parahita): 39 chat semua numberSlot=0, waMode=pool, 1 TenantNumber slot=0
  tenant 8 (Mazaya):  2522 chat semua numberSlot=0, waMode=pool, 1 TenantNumber slot=0
  ```
- **Perilaku identik:** `findChatByPhone(tenantId, phone, slot=0)` default → slot-0; `/open` default slot-0; reply fallback ke `numberSlot || 0` → slot-0; queue tidak filter slot; CSAT/autoreply/menuGateway pakai `numberSlot || 0` → slot-0. ✅ Perilaku identik.

### 9. Verifikasi fix v3.9.1 tidak regressed ✅ PASS (dengan 1 catatan)
- **logoutTenant/disconnectTenant slot-aware + slotKey:** `pool.js:529–613` — semua pakai `slotKey(tid, s)` dan `s = Number(slot) || 0` konsisten. ✅
- **Compound-NULL findFirst pattern masih ada:** `services/autoReply.js:43–50, 68–82`, `services/menuGateway.js:53–64, 68–82`, `routes/autoreply.js:151–197` — semua autoReplyConfig/menuGatewayConfig lookup `numberSlot: null` via findFirst, tidak findUnique compound. ✅
- **POST/DELETE numbers + kuota masih ada:** `routes/wa.js:229–255` POST dengan `plan.maxNumbers` check 403; DELETE dengan 409 chat-guard. ✅
- **Blast sendSlot hoist masih ada:** `services/blast.js:88–126, 217–231` — round-robin pakai `nextSlot()`, `currentSlot` di-hoist, `sendSlotBlast` per-pesan. ✅
- **⚠️ Catatan:** PUT `/api/wa/numbers/:slot` masih upsert tanpa cek kuota (lihat temuan MEDIUM-2 di bawah). Ini carry-over dari audit v3.9 BUG-12/13 yang belum ditutup v3.9.1; tidak diregress oleh v3.9.2 (kode ini tidak disentuh di v3.9.2).

### 10. Edge proaktif ✅ PASS (dengan temuan)
- **Chat backfilled slot-0 di-reply pas slot-0 disconnect → error jelas:** `sendMessageForTenant(0)` → `notConnectedError(WA_NOT_CONNECTED_MSG)` → catch di chats.js:915–920 → `waSendError` → response include `waError` (chats.js:992). Tidak crash. ✅
- **Pesan grup masuk via slot-1 → tetap 1 baris grup:** groups.js findFirst by `(tenantId, waJid)` tanpa slot. ✅
- **`/open` ke kontak yang primary chat-nya di slot-1 dengan payload default → slot-0 chat baru:** contacts.js:771 short-circuit hanya bila slot match — slot beda → skip → `findChatByAnyJid(openSlot=0)` → create baru slot-0. Tidak nyasar ke slot-1 ✅.
- **Badge UI hanya nampil bila >1 slot:** ChatListPane.vue:150 `v-if="waSlots.length > 1"` + ChatDetail.vue:50 `v-if="!groupChat && waSlots.length > 1"`. ✅
- **Blast rotate antar slot connected dengan chat per-slot:** ✅ rotate skip slot mati (blast.js:92–104). **TAPI** lihat temuan MEDIUM-1 di bawah — dedup by-phone.

---

## TEMUAN BUG

### 🟡 MEDIUM-1 — Blast bisa kirim dobel ke orang yang sama via 2 nomor berbeda

**File:line:** `src/routes/blast.js:315–395` + `frontend/src/views/BlastComposer.vue:505–514`.

Setelah K1-A, kontak X bisa punya 2 chat berbeda (slot-0 + slot-1). Blast target dibangun dari **Set of chatIds**. Kalau user pilih kedua chat (atau tag mencakup keduanya, atau UI menampilkan dua-duanya), `allChatIds` memuat **dua chat dengan `contactPhone` sama** → dibuat 2 BlastLog → orang yang sama menerima pesan blast 2x dari 2 nomor berbeda tenant.

CSV path punya dedup by phone (`existingChatPhones` line 322–338), **tapi chat-vs-chat tidak**. Tidak ada dedup silang by phone antar chatIds.

**Skenario repro:**
1. Tenant punya slot-0 & slot-1 connected.
2. Kontak Budi (0812xxx) chat duluan ke slot-0, lalu chat lagi ke slot-1 → tercipta 2 baris Chat, phone sama.
3. Admin buka Blast Composer, pilih "Semua chat aktif" → dua chat Budi ikut karena filter pakai chatIds.
4. Blast rotate 2 slot ON → BlastLog 2 baris untuk Budi, satu kirim via slot-0, satu via slot-1.

**Dampak:** Pelanggan kena spam dari 2 nomor; risiko banned WA (repeated message from different numbers); statistik blast terdistorsi.

**Severity MEDIUM bukan HIGH** karena:
- Memerlukan aksi manual user (tidak otomatis);
- Hanya terjadi bila tenant sudah multi-nomor + kontak punya 2 chat + user pilih kedua;
- Workaround mudah: user sadar tidak pilih dua-duanya.

**Rekomendasi fix (backend, blast.js route create):**

```diff
--- a/wa-cs-hub-saas-v3/src/routes/blast.js
+++ b/wa-cs-hub-saas-v3/src/routes/blast.js
@@ -315,11 +315,25 @@
     // Fetch chat details for personalization (tenant-scoped)
     const uniqueChatIds = [...allChatIds]
     const chats = await prisma.chat.findMany({
       where: { tenantId: req.tenantId, id: { in: uniqueChatIds } },
-      select: { id: true, contactName: true, contactPhone: true },
+      select: { id: true, contactName: true, contactPhone: true, numberSlot: true },
     })
+
+    // v3.9.2 K1-A — DEDUP BY PHONE antar chatIds: kontak sama (phone sama) yang
+    // kebetulan punya ≥2 chat (slot beda) HANYA dikirim SEKALI (pakai chat dengan
+    // lastMessageAt terbaru; tie → id terkecil = deterministik). Cegah blast dobel
+    // lintas nomor.
+    const seenChatPhones = new Map() // normalizedPhone → chat
+    const dedupedChats = []
+    for (const c of chats) {
+      if (!c.contactPhone) { dedupedChats.push(c); continue } // LID-only: no phone → unik
+      const norm = normalizePhone(c.contactPhone)
+      if (!norm.valid) { dedupedChats.push(c); continue }
+      const prev = seenChatPhones.get(norm.normalized)
+      if (!prev) { seenChatPhones.set(norm.normalized, c); dedupedChats.push(c); continue }
+      // Pilih yang lebih baru aktif; tie → id lebih kecil (deterministik)
+      const prevKey = (prev.lastMessageAt?.getTime?.() || 0) * 1e6 - prev.id
+      const curKey = (c.lastMessageAt?.getTime?.() || 0) * 1e6 - c.id
+      if (curKey > prevKey) {
+        dedupedChats.splice(dedupedChats.indexOf(prev), 1, c)
+        seenChatPhones.set(norm.normalized, c)
+      }
+      // yang kalah: skip (dedup)
+    }
 
     // Build a set of normalized phones from existing chats for dedup
     const existingChatPhones = new Map()
-    for (const c of chats) {
+    for (const c of dedupedChats) {
       if (c.contactPhone) {
         const norm = normalizePhone(c.contactPhone)
         if (norm.valid) existingChatPhones.set(norm.normalized, c)
       }
     }
   ...
-    const totalRecipients = chats.length + csvRecipients.length
+    const totalRecipients = dedupedChats.length + csvRecipients.length
   ...
         logs: {
           create: [
-            ...chats.map((c) => ({ ... chatId: c.id ... })),
+            ...dedupedChats.map((c) => ({ ... chatId: c.id ... })),
             ...
           ]
         }
```

Atau lebih sederhana (1 baris): pakai `prisma.chat.groupBy({ by: ['contactPhone'] })` terlebih dahulu sebelum final list. Tapi tetap perlu deterministic pick.

**Juga perlu:** `lastMessageAt` perlu di-`select` (lihat diff di atas — tambah kolom).

---

### 🟡 MEDIUM-2 — PUT `/api/wa/numbers/:slot` masih upsert-create tanpa cek kuota plan.maxNumbers (regresi terbuka dari v3.9 BUG-13)

**File:line:** `src/routes/wa.js:186–228`.

Audit v3.9 (qa-v3.9-audit.md:195 dan qa-v3.9-audit-k3.md:215–223) sudah menandai ini:
> PUT `/api/wa/numbers/:slot` melakukan **upsert** — tenant admin bisa MENAMBAH baris slot 1/2 sendiri tanpa cek `plan.maxNumbers`. Bypass K4.

v3.9.1 (commit 6b69908) hanya menambah POST `/numbers` dengan guard kuota — **PUT tetap tanpa guard kuota.** v3.9.2 (4e7fe8d) tidak menyentuh blok ini sama sekali.

**Dampak:** Tenant admin bisa `PUT /api/wa/numbers/2` dengan body apa saja → baris `TenantNumber` slot=2 dibuat (kalau belum ada) tanpa cek apakah plan mengizinkan 3 nomor. Setelah baris ada, tenant boleh `connectTenant` slot itu.

**Severity MEDIUM (bukan HIGH/CRITICAL):**
- UI tidak menyediakan jalur ini (button "Tambah Slot" memanggil POST dengan guard kuota);
- Hanya via API direct (curl);
- `MAX_SLOT = 2` tetap cap hard di 3 slot;
- Tapi ini **bypass eksplisit rencana bisnis** (monetisasi per-slot kuota).

**Rekomendasi fix (diff kecil):**

```diff
--- a/wa-cs-hub-saas-v3/src/routes/wa.js
+++ b/wa-cs-hub-saas-v3/src/routes/wa.js
@@ -186,6 +186,19 @@
 // PUT /api/wa/numbers/:slot — update label / routeMode / assignedAgentId / reassignOffline
 router.put('/numbers/:slot', ...rt, requireAdmin, async (req, res) => {
   try {
     const slot = parseInt(req.params.slot, 10)
     if (!Number.isFinite(slot) || slot < 0 || slot > wa.MAX_SLOT) {
       return res.status(400).json({ error: `Slot tidak valid (0..${wa.MAX_SLOT})` })
     }
+    // v3.9.2-fix — guard kuota saat UPSERT create (bila row belum ada).
+    const prismaRef = require('../prisma')
+    const existingRow = await prismaRef.tenantNumber.findUnique({ where: { tenantId_slot: { tenantId: req.tenantId, slot } } })
+    if (!existingRow) {
+      const plans = require('../services/plans')
+      const plan = await plans.getPlan(req.tenantId)
+      const maxN = (plan?.maxNumbers == null || !Number.isFinite(Number(plan.maxNumbers))) ? 1 : Math.max(0, Math.trunc(Number(plan.maxNumbers)))
+      const effMax = Math.min(maxN, wa.MAX_SLOT + 1)
+      const used = await prismaRef.tenantNumber.count({ where: { tenantId: req.tenantId } })
+      if (used >= effMax) {
+        return res.status(403).json({ error: `Kuota nomor penuh (${used}/${effMax}). Hubungi superadmin untuk upgrade plan.` })
+      }
+    }
     const data = {}
     ...
```

---

### 🟢 LOW-1 — `/open` dengan `numberSlot` invalid jatuh diam-diam ke 0

**File:line:** `src/routes/contacts.js:765–766`.

```js
const reqSlotRaw = Number(req.body?.numberSlot)
const openSlot = Number.isFinite(reqSlotRaw) && reqSlotRaw >= 0 && reqSlotRaw <= 2 ? Math.trunc(reqSlotRaw) : 0
```

Kirim `numberSlot: 99` atau `"abc"` → slot-0 dipakai diam-diam. Tidak ada 400 error.

**Severity LOW:** kompatibel dengan UX forgiving; caller jarang kirim invalid; tapi bisa confusing saat debugging ("aku kirim 2 kok chatnya di slot 0?").

**Rekomendasi (opsional, 2 baris):**
```diff
-    const openSlot = Number.isFinite(reqSlotRaw) && reqSlotRaw >= 0 && reqSlotRaw <= 2 ? Math.trunc(reqSlotRaw) : 0
+    const openSlot = Number.isFinite(reqSlotRaw) && reqSlotRaw >= 0 && reqSlotRaw <= 2 ? Math.trunc(reqSlotRaw) : 0
+    if (req.body?.numberSlot !== undefined && (!Number.isFinite(reqSlotRaw) || reqSlotRaw < 0 || reqSlotRaw > 2)) {
+      return res.status(400).json({ error: 'numberSlot harus 0..2 (atau kosong utk default slot-0)' })
+    }
```

---

## VERIFIKASI SILANG TERHADAP CLAIM CODER (`report-v392-k1a.md`)

| Claim di report | Hasil audit | Bukti |
|---|---|---|
| Schema numberSlot NOT NULL + @@unique composite | ✅ Benar | schema.prisma:152,162; index produksi sudah `Chat_tenantId_numberSlot_waJid_key` |
| Backfill null→0, 2561 chat utuh | ✅ Benar | live check: null=0, total=2561, semua slot=0 |
| LID↔phone two-way scoped per slot | ✅ Benar | pool.js:978–1067 semua WHERE bawa numberSlot=inboxSlot |
| Merge LID TIDAK lintas slot | ✅ Benar | mergeLidIntoPhoneChat:857 `numberSlot: s` |
| Contact.chatId = primary, race-safe | ✅ Benar | pool.js:1461–1468 updateMany + catch unique |
| `/by-chat` fallback by-phone | ✅ Benar | contacts.js:329–356 |
| `/open` payload numberSlot + default 0 | ✅ Benar | contacts.js:765–766,771,813 |
| DELETE slot 409 (tenant + SA) | ✅ Benar | wa.js:268–276, superadmin.js:595–603 |
| Slot-0 sintetis + chatCount | ✅ Benar | wa.js:31–63 (raw SQL COALESCE benar) |
| Grup 1 baris, PM composite | ✅ Benar | groups.js:200,447,992; pmParticipant:1287 |
| CSAT cek slot chat | ✅ Benar | csat.js:177–181 |
| menuGateway getConfigForSlot | ✅ Benar | menuGateway.js:230,236 |
| Zero-change tenant 1-nomor (Parahita #4 = 39 chat, Mazaya #8 = 2522 chat) | ✅ Benar | live check DB: semua numberSlot=0 |
| Fix v3.9.1 tidak regressed | ✅ Benar (kecuali PUT upsert tanpa kuota = carry-over dari v3.9, tidak di-fix v3.9.1 — tapi juga tidak diregress v3.9.2) | logout/disconnect slot-aware ✓; compound-NULL findFirst ✓; POST/DELETE ada ✓; blast sendSlot hoist ✓ |
| Double-unread fix (bonus) | ✅ Benar | pool.js:967,1181,1367,1374 — `firstMessageCounted` flag benar hanya increment chat existing |
| Media reply waError (bonus) | ✅ Benar | chats.js:1141 |

---

## VERDICT AKHIR

### ✅ **GO untuk QA owner** — dengan catatan

**Alasan GO:**
1. Semua 20 poin ADDENDUM K1-A (A–G) terpenuhi secara fungsional dan terverifikasi.
2. Claim coder per-item terbukti di kode dan DB.
3. Zero-change tenant 1-nomor Parahita #4 dan Mazaya #8 terkonfirmasi full slot-0, tidak ada breakage (2561 chat utuh, index baru benar).
4. Tidak ada bug CRITICAL atau HIGH baru.
5. Reply no-fallback (K3), LID-scoped routing (B), Contact primary + fallback (C), DELETE slot 409 (F.18), grup 1-baris (E), CSAT per-slot, menuGateway fallback — semua benar.

**Catatan sebelum owner QA / sebelum deploy tenant multi-nomor beneran:**
- 🟡 **MEDIUM-1 (blast dobel)** sebaiknya di-fix sebelum ada tenant multi-nomor produksi yang pakai blast — terutama kalau blast jadi fitur andalan. Fix ±20 baris di `routes/blast.js`, tidak perlu restart fisio/portable, bisa jadi v3.9.3 patch kecil.
- 🟡 **MEDIUM-2 (PUT upsert tanpa kuota)** — carry-over dari v3.9 bukan regresi v3.9.2. Fix ±15 baris di `routes/wa.js`. Boleh digabung v3.9.3.
- 🟢 **LOW-1 (`/open` fallback silent)** — nice-to-have, bisa v3.9.3 juga.

**Tidak perlu rollback** — v3.9.2 layak dipakai. Tenant 1-nomor (Parahita, Mazaya) aman 100%. Tenant multi-nomor aman untuk semua jalur kecuali dua catatan di atas.

---

**Lampiran bukti lingkungan:**
- Server 5047 hidup, `/api/health` 200 OK (saat audit).
- DB produksi read-only verified via `node:sqlite` di copy `/tmp` (file asli tidak disentuh).
- `node --check` semua file service & route: ALL SYNTAX OK.
- Tidak ada edit file; tidak ada restart; tidak ada git command mutating.

**Disusun oleh:** Kimi-K3 (qa-reviewer subagent) — 2026-09-23 ~21:32 WIB.
