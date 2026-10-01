# Spec v3.5 — LID ↔ Phone Matching (fix chat dobel) + Greeting Skip utk CS-initiated

> Owner request: Kanaka 2026-09-22 19:58 (bug report Berliana, tenant Parahita #4) + 20:14 (GO: "jalankan semua rencanamu" + APPROVE greeting skip).
> Basis: v3.4.2 (commit 35a7669 lokal). App 5047 jalan (PID 54096), 2 tenant live (Parahita #4, Mazaya #8) — WA connected keduanya.
> Backup pra-kerja (Alita, 20:17): `backup/pre-v3.5-20260922-2017/saas-v3.db`. JANGAN dihapus.
> Referensi implementasi hub: `/home/kanakxxx/.openclaw/workspace/wa-cs-hub/src/wa/baileys.js` — fungsi `resolveLidToPhone` (L176-218), `updateChatWithPhone` (L224-236), listener `chats.phoneNumberShare` (L624-640), inline LID resolve di incoming handler (L833-857). Baca untuk dipahami, TAPI tulis versi tenant-scoped sendiri — jangan copy mentah (skema beda: Chat Int id + tenantId + waJid, bukan Chat.id = JID).

## ⛔ HARD CONSTRAINTS (sama dgn spec v3.4, berlaku penuh)

1. Port 5030 MATI (retired) — jangan hidupkan. Port 8770 fisio jangan disentuh. App 5047: kill BY PID SAJA, JANGAN pkill node.
2. DB: `npx prisma db push` HANYA additive (kolom baru `Chat.lidJid String?` + `@@index`). DILARANG `--accept-data-loss` / `--force-reset` / DROP / hapus .db.
3. NO git commit — Alita review dulu.
4. Test pakai tenant QA baru (bikin via API superadmin, preset pro) atau data sintetis via script — JANGAN ubah data Parahita/Mazaya secara permanen. Script repair (§5) jalan SETELAH semua di-deploy dan Alita approve dry-run-nya.
5. Token auth ke file /tmp (bukan inline Bearer — sanitizer).
6. Restart app maksimal 2x (1x utk db push + backend; 1x utk frontend build kalau perlu) — kill by PID.
7. Frontend: sebelum build, `cp -r public public-pre-build-<ts>` (konvensi).

## Konteks masalah (diagnosa Alita, verified dari DB)

- WA modern pakai **LID** (`245126702096412@lid`) sebagai identitas pengirim; app bikin chat dari kontak pakai nomor hape (`6285856435743@s.whatsapp.net`). Balasan klien nyasar ke chat LID baru + kontak dobel + greeting first-of-day.
- Kasus nyata t4: chat 7606 (phone JID, 2 pesan out) vs chat 7607 (LID, semua balasan + greeting isAuto). Kontak dobel: 7593 (linked 7606) + 7594 (linked 7607).
- Baileys rc14 menyediakan `msg.key.remoteJidAlt` (JID alternatif — phone JID saat remoteJid = LID, terlihat di log app) + event `chats.phoneNumberShare` ({lid, jid}).
- Chat model: `waJid String` @@unique([tenantId, waJid]), `phoneJid String?` (dipakai utk grup), TAMBAH: `lidJid String?` (v3.5 — mapping ke LID utk chat yang dibuat dari phone JID).

## §1. Incoming routing — LID ↔ phone match (pool.js `processIncomingMessage`)

Setelah `const chatId = msg?.key?.remoteJid` dan sebelum find-or-create chat, tambah blok **resolveEffectiveJid(tid, msg)**:

```js
async function resolveEffectiveJid(tid, msg, sock) {
  let chatId = msg?.key?.remoteJid
  if (!chatId || chatId === 'status@broadcast' || chatId.endsWith('@g.us')) return chatId
  const altJid = msg?.key?.remoteJidAlt || null // phone JID saat remoteJid LID (rc14), atau sebaliknya
  // Kandidat JID alternatif, urut prioritas
  const candidates = []
  if (chatId.endsWith('@lid')) {
    // Pesan datang dgn LID → cari chat phone-JID milik nomor yang sama
    if (altJid && altJid.endsWith('@s.whatsapp.net')) candidates.push(altJid)
    const phone = (altJid || '').split('@')[0]
    if (phone) candidates.push(`${phone}@s.whatsapp.net`)
  } else if (chatId.endsWith('@s.whatsapp.net')) {
    // Pesan datang dgn phone JID → cari chat LID yang mapping-nya cocok (kolom lidJid)
    const chatByLid = await prisma.chat.findFirst({ where: { tenantId: tid, lidJid: chatId } }) // lihat catatan
    // ^ nanti di balik chat lookup
  }
  ...
}
```

PERINGATAN: jangan terjebak literal pseudocode di atas — **logika final yang diminta**:

1. `chatId` = remoteJid apa adanya. `altJid` = remoteJidAlt (bisa null).
2. Cari chat by `[tenantId, waJid: chatId]` (status quo).
3. Kalau gak ketemu DAN chatId = LID: coba cari chat by `waJid = altJid` (kalau altJid = phone JID), lalu cari by `phoneJid = chatId` ATAU `lidJid = chatId` (chat LID lama yang udah resolved, atau chat phone yang mapping LID-nya tersimpan).
4. Kalau gak ketemu DAN chatId = phone JID: cari by `lidJid` yang = chatId (chat LID yang mapping-nya udah disimpan). Kalau ketemu → PAKAI chat itu (pesan masuk ke chat LID; WA konsisten pakai LID utk device itu — pilih JID yang hidup, bukan buat chat baru).
5. Kalau masih gak ketemu → create chat baru (status quo) TAPI bawa info mapping: kalau chatId LID dan altJid phone → set `phoneJid = altJid`; kalau chatId phone dan kita belajar LID-nya (dari `participantAlt`/`participant` di pesan grup TIDAK berlaku di sini — utk 1:1: altJid saat remoteJid = phone bisa berupa LID juga, simpan `lidJid = altJid`).
6. **Pasang mapping dua arah saat ketemu match**: kalau pesan LID nyambung ke chat phone → `chat.lidJid = chatId` (chat phone belajar LID-nya) + `chat.phoneJid` (chat phone) biar tetap. Kalau pesan phone nyambung ke chat LID → `chat.phoneJid = chatId` kalau masih null (chat LID belajar phone-nya).
7. Gunakan chat hasil routing utk SEMUA operasi downstream (persist pesan, unread, greeting check, auto-reply, push, queue) — jangan pakai `chatId` mentah lagi. (Di kode sekarang `chat.id` dipakai downstream — pastikan routing terjadi sebelum blok find-or-create.)

## §2. Listener `chats.phoneNumberShare` + resolve USync + requestPhoneNumber (port hub)

Di `setupSocket(st)` (pool.js), setelah handler messages.upsert:

- `sock.ev.on('chats.phoneNumberShare', ...)` — port dari hub L624-640, adaptasi tenant: `prisma.chat.updateMany({ where: { tenantId: tid, waJid: normalizedLid }, data: { contactPhone: phone, phoneJid } })`. Normalisasi LID: `lid.split(':')[0] + '@lid'` (strip device suffix).
- Fungsi `resolveLidToPhone(sock, lidJid)` — port hub L176-218 (onWhatsApp → USyncQuery). Import `USyncQuery`/`USyncUser` dari baileys sesuai pola hub (`const { USyncQuery, USyncUser } = require('@whiskeysockets/baileys')` — cek cara hub mengimpornya).
- Inline resolve di processIncomingMessage (port hub L833-857): pesan 1:1 dari LID yang `phoneJid`-nya masih null → fire-and-forget resolve (JANGAN block persist pesan) → kalau dapat phone: update chat LID itu (`phoneJid`, `contactPhone`) + **merge guard** (§4). Kalau gak dapat → kirim `sock.sendMessage(chatId, { requestPhoneNumber: true })` SEKALI per LID (in-memory Set per socket, reset saat reconnect — pola `requestPhoneSentSet` hub).

## §3. Greeting skip kalau agent udah nyapa duluan hari itu (autoReply.js)

- Cari trigger greeting first-of-day di `src/services/autoReply.js` (fungsi yang kirim "Hai kak..." saat `lastAutoGreetDate` beda hari / first-incoming).
- Ubah: SEBELUM kirim greeting, cek apakah ada pesan `direction: 'out', isAuto: false` dari tenant ini di chat yang sama pada **hari WIB yang sama** (query Message by chatId + tenantId, timestamp >= start-of-day WIB, direction out, isAuto false, LIMIT 1). Kalau ADA → SKIP greeting (set lastAutoGreetDate = today biar gak dikirim ulang hari itu juga, log `[AutoReply] greeting skip — agent sudah menyapa duluan hari ini: chat=<id>`).
- Ini juga berlaku utk outside-hours auto-reply (kalau agen balas di luar jam, klien bales → jangan auto-reply dobel). Kualifikasi sama: pesan out non-auto dari agent hari itu.
- JANGAN ubah perilaku menu gateway / CSAT consume / auto-reply keyword — hanya greeting first-of-day + outside-hours greeting.

## §4. Open-chat dari kontak: cek dua arah (contacts.js)

- Route start-chat dari kontak (sekitar L745-760, `const jid = ${phoneNorm.normalized}@s.whatsapp.net`): sebelum create chat baru, cek juga chat LID yang punya `phoneJid = jid` ATAU `lidJid` yang ter-resolve ke nomor itu (`prisma.chat.findFirst({ where: { tenantId, phoneJid: jid } })` + `lidJid` mapping) → kalau ketemu, PAKAI chat itu (return existing), jangan create.
- Helper kecil biar dry: `findChatByAnyJid(tenantId, phoneJidOrLid)` — return chat by waJid, lalu phoneJid, lalu lidJid (order by id asc utk deterministik).

## §5. Script repair data dobel (merge) — DRY-RUN DULU, app jalan boleh

Buat `scripts/fix-lid-dup-chats.cjs` (node, one-shot, arg `--apply` vs default dry-run):

1. Deteksi pasangan dobel per tenant: chat LID (waJid @lid) vs chat phone yang `contactPhone`-nya sama (join via contactPhone). List pasangan + jumlah pesan masing-masing.
2. Merge policy: **chat phone JID = canonical** (UI kontak link ke situ; phoneJid sudah benar). Pindahkan Message rows dari chat LID → chat phone (`updateMany chatId`). Update `lastMessageAt`/`lastMessagePreview` chat phone dari pesan terakhir gabungan (ambil max). Hapus kontak dobel yang chatId-nya chat LID (yang duplicate, bukan yang linked phone chat) — contact LID row-nya hapus SETELAH chatId-nya di-null/dipindah. Hapus chat LID row. Pasang `lidJid` di chat phone = LID yang barusan di-merge (mapping utk §1 routing).
3. ChatTag/ContactTag/FavoriteMessage/ChatNote/ChatEvent/CSAT yang nempel di chat LID → pindah chatId ke chat phone (utk tabel yang punya chatId). ChatNote.userId tetap. Kalau konflik @@unique (mis. ChatTag [chatId,tagId] sudah ada di chat phone) → skip row itu, catat di report.
4. Output report: pasangan yang di-merge, row counts per tabel, skip list. Dry-run default: TANPA tulis DB, cuma print rencana. `--apply` = eksekusi dalam transaksi per pasangan.
5. JANGAN jalankan `--apply` — Alita yang jalanin setelah review dry-run. Kasih output dry-run di laporan.

## §6. Smoke test (tulis output asli di laporan)

1. `npx prisma db push` additive sukses; data 2 tenant utuh (counts before/after: Chat t4, Chat t8, Message, Contact).
2. Boot + health 200; WA t4+t8 reconnect (tunggu max 60s).
3. Unit-ish test routing pakai msg sintetis (node script, gak perlu WA nyata): construct msg `{ key: { remoteJid: 'X@lid', remoteJidAlt: 'Y@s.whatsapp.net', fromMe: false }, ... }` utk skenario: (a) chat phone Y ada → pesan harus persist ke chat Y, `lidJid` ke-set; (b) chat Y gak ada → chat LID baru dibuat dgn `phoneJid: Y@s...`; (c) chat LID dgn phoneJid ada → pesan phone JID masuk ke chat LID itu. Pakai tenant QA (bikin via API SA) — tenant QA purge di akhir.
4. Greeting skip test: chat QA dgn pesan out non-auto hari ini (insert manual) → trigger greeting flow → assert SKIP + lastAutoGreetDate ke-set.
5. Script repair dry-run: output pasangan terdeteksi (harus nemuin chat 7606/7607 t4 + pasangan migrasi Mazaya kalau ada) + rencana merge — TANPA apply.
6. Frontend: build sukses (kalau ada perubahan — seharusnya gak perlu utk fix ini; skip kalau gak ada).
7. Restart by PID → health 200 → WA reconnect → counts data tetap.

## §7. Laporan (format, sama dgn v3.4 §11)

File dibuat/diedit + baris; output asli smoke test 1-5; counts before/after; deviasi spec + alasan; status FAIL apa adanya kalau ada yang gagal.