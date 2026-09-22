#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// v3.5 — scripts/fix-lid-dup-chats.cjs (spec §5)
// Repair data dobel akibat bug LID vs phone (chat dobel per kontak).
//
// Mode:
//   node scripts/fix-lid-dup-chats.cjs           → DRY-RUN (default, TANPA tulis DB)
//   node scripts/fix-lid-dup-chats.cjs --apply   → eksekusi (transaksi per pasangan)
//
// Deteksi: pasangan chat LID (waJid @lid) vs chat phone (@s.whatsapp.net)
// dengan contactPhone sama (scope tenant). Chat phone = CANONICAL.
//
// Merge policy (spec §5):
//   1. Message rows chat LID → chat phone (updateMany chatId).
//   2. lastMessageAt/lastMessagePreview chat phone = dari pesan terakhir gabungan.
//   3. Contact dobel yang chatId-nya = chat LID → dihapus (setelah chatId di-clear
//      via delete — yang linked ke chat phone tetap hidup).
//   4. Chat LID row dihapus.
//   5. lidJid chat phone = LID yang di-merge (mapping utk routing §1).
//   6. ChatTag/ChatEvent/ChatNote/CsatSurvey/ScheduledMessage yang nempel chat LID
//      → chatId dipindah ke chat phone; konflik @@unique → skip + dicatat.
//
// DILARANG dijalankan --apply tanpa review dry-run oleh Alita (spec v3.5 §5).
// ═══════════════════════════════════════════════════════════════════
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const APPLY = process.argv.includes('--apply')

function esc(s) {
  return String(s == null ? '' : s)
}

async function findDupPairs() {
  const tenants = await prisma.tenant.findMany({ where: { status: 'active' }, orderBy: { id: 'asc' }, select: { id: true, name: true } })
  const pairs = []
  for (const t of tenants) {
    const chats = await prisma.chat.findMany({
      where: { tenantId: t.id },
      select: { id: true, waJid: true, contactPhone: true, phoneJid: true, contactName: true, lastMessageAt: true, lastAutoGreetDate: true },
      orderBy: { id: 'asc' },
    })
    const lidChats = chats.filter((c) => c.waJid.endsWith('@lid'))
    // Nama sudah “dipakai” oleh pasangan phone lain → LID berikutnya dgn nama sama
    // diperlakukan sebagai duplikat tambahan dgn phone chat yang SAMA (bukan pasangan baru).
    const claimedNames = new Set()
    const claimedPhoneChatIds = new Set()
    for (const lid of lidChats) {
      const lidPhone = lid.contactPhone || lid.waJid.split('@')[0]
      if (!lidPhone) continue
      // Chat phone dengan contactPhone sama (canonical candidate)
      // CATATAN v3.5: contactPhone chat LID bisa jadi LID-digits (belum resolved)
      // — kasus nyata t4: chat 7607 contactPhone=245126702096412 (LID raw).
      // Kandidat dipasangkan via Contact row: phone contact (row linked chat
      // phone) vs LID contact dengan name sama. Deteksi:
      //   (a) contactPhone cocok langsung (LID sudah resolved), ATAU
      //   (b) Contact name sama: contact LID (chat LID) + contact phone (chat phone)
      //       dgn nama sama & phone terisi → pasangan dobel.
      let phoneChat = await prisma.chat.findFirst({
        where: {
          tenantId: t.id,
          waJid: { endsWith: '@s.whatsapp.net' },
          OR: [{ contactPhone: lidPhone }, { contactPhone: { endsWith: lidPhone } }],
          id: { not: lid.id },
        },
        orderBy: { id: 'asc' },
      })
      if (phoneChat) {
        // double-check: digits phone JID harus cocok contactPhone LID (jarinhan benar)
        const phoneChatDigits = phoneChat.waJid.split('@')[0]
        if (phoneChatDigits !== lidPhone && !phoneChatDigits.endsWith(lidPhone)) phoneChat = null
      }
      if (!phoneChat) {
        // (b) Contact-name join: contact LID (chatId = chat LID, phone null/LID) +
        // contact phone (chatId = chat phone, phone terisi) dengan nama sama.
        const lidContact = await prisma.contact.findFirst({ where: { chatId: lid.id }, orderBy: { id: 'asc' } })
        if (lidContact && lidContact.name && !claimedNames.has(lidContact.name)) {
          const phoneContacts = await prisma.contact.findMany({
            where: { tenantId: t.id, phone: { not: null }, name: lidContact.name, chatId: { not: null } },
            include: { chat: true },
            orderBy: { id: 'asc' },
          })
          for (const pc of phoneContacts) {
            if (pc.chat && pc.chat.waJid.endsWith('@s.whatsapp.net') && pc.chat.id !== lid.id && !claimedPhoneChatIds.has(pc.chat.id)) {
              const digits = pc.chat.waJid.split('@')[0]
              // nomor kontak harus konsisten dgn chat phone-nya
              if (pc.phone === digits || (pc.phone && digits.endsWith(pc.phone)) || (digits.startsWith(pc.phone))) {
                phoneChat = pc.chat
                break
              }
            }
          }
        }
      }
      if (!phoneChat) continue
      // tandai nama & phone chat sudah dipakai pasangan ini (blokir pairing kedua)
      const lidContactClaim = await prisma.contact.findFirst({ where: { chatId: lid.id }, orderBy: { id: 'asc' } })
      if (lidContactClaim && lidContactClaim.name) claimedNames.add(lidContactClaim.name)
      claimedPhoneChatIds.add(phoneChat.id)
      pairs.push({ tenant: t, lidChat: lid, phoneChat })
    }
  }
  return pairs
}

async function countMessages(chatId) {
  return prisma.message.count({ where: { chatId } })
}

async function dryRun(pairs) {
  console.log(`\n=== DRY-RUN (tanpa tulis DB) — ${pairs.length} pasangan terdeteksi ===\n`)
  for (const p of pairs) {
    const lidMsgs = await countMessages(p.lidChat.id)
    const phoneMsgs = await countMessages(p.phoneChat.id)
    console.log(`[tenant #${p.tenant.id} ${p.tenant.name}]`)
    console.log(`  chat LID   #${p.lidChat.id}  ${p.lidChat.waJid}  msgs=${lidMsgs}  name=${p.lidChat.contactName || '-'}`)
    console.log(`  chat PHONE #${p.phoneChat.id}  ${p.phoneChat.waJid}  msgs=${phoneMsgs}  name=${p.phoneChat.contactName || '-'}`)
    console.log(`  → MERGE: LID #${p.lidChat.id} → PHONE #${p.phoneChat.id} (canonical), lidJid=${p.lidChat.waJid.split(':')[0]} dipasang di chat phone`)
    // affected child tables
    const lidChildren = {}
    lidChildren.chatTags = await prisma.chatTag.count({ where: { chatId: p.lidChat.id } })
    lidChildren.chatEvents = await prisma.chatEvent.count({ where: { chatId: p.lidChat.id } })
    lidChildren.chatNotes = await prisma.chatNote.count({ where: { chatId: p.lidChat.id } })
    lidChildren.csatSurveys = await prisma.csatSurvey.count({ where: { chatId: p.lidChat.id } })
    lidChildren.scheduledMessages = await prisma.scheduledMessage.count({ where: { chatId: p.lidChat.id } })
    lidChildren.contacts = await prisma.contact.count({ where: { chatId: p.lidChat.id } })
    console.log(`  → child rows chat LID: ${JSON.stringify(lidChildren)}`)
    // konflik unique preview (ChatTag [chatId,tagId] exists on phone chat)
    const phoneTags = await prisma.chatTag.findMany({ where: { chatId: p.phoneChat.id }, select: { tagId: true } })
    const lidTags = await prisma.chatTag.findMany({ where: { chatId: p.lidChat.id }, select: { tagId: true } })
    const conflicts = lidTags.filter((lt) => phoneTags.some((pt) => pt.tagId === lt.tagId))
    if (conflicts.length > 0) console.log(`  ⚠ ChatTag conflict (skip): tagIds=${conflicts.map((c) => c.tagId).join(',')}`)
    console.log('')
  }
  if (pairs.length === 0) console.log('Tidak ada pasangan dobel LID vs phone yang terdeteksi.\n')
}

async function apply(pairs) {
  console.log(`\n=== APPLY — ${pairs.length} pasangan akan di-merge (transaksi per pasangan) ===\n`)
  const report = []
  for (const p of pairs) {
    const lidMsgs = await countMessages(p.lidChat.id)
    const skipped = []
    try {
      const res = await prisma.$transaction(async (tx) => {
        // 1. Messages → canonical
        const movedMsgs = await tx.message.updateMany({ where: { chatId: p.lidChat.id }, data: { chatId: p.phoneChat.id } })
        // 2. lastMessage dari gabungan
        const lastMsg = await tx.message.findFirst({ where: { chatId: p.phoneChat.id }, orderBy: [{ timestamp: 'desc' }, { id: 'desc' }] })
        // 3. Child tables (konflik unique → skip)
        let movedTags = 0
        const lidTags = await tx.chatTag.findMany({ where: { chatId: p.lidChat.id } })
        for (const lt of lidTags) {
          const exists = await tx.chatTag.findUnique({ where: { chatId_tagId: { chatId: p.phoneChat.id, tagId: lt.tagId } } })
          if (exists) {
            skipped.push(`ChatTag tagId=${lt.tagId} (sudah ada di chat phone)`)
          } else {
            await tx.chatTag.update({ where: { chatId_tagId: { chatId: p.lidChat.id, tagId: lt.tagId } }, data: { chatId: p.phoneChat.id } })
            movedTags++
          }
        }
        const movedEvents = await tx.chatEvent.updateMany({ where: { chatId: p.lidChat.id }, data: { chatId: p.phoneChat.id } })
        const movedNotes = await tx.chatNote.updateMany({ where: { chatId: p.lidChat.id }, data: { chatId: p.phoneChat.id } })
        // CsatSurvey.chatId tak ada unique constraint selain token (token ikut row)
        const movedCsat = await tx.csatSurvey.updateMany({ where: { chatId: p.lidChat.id }, data: { chatId: p.phoneChat.id } })
        const movedSched = await tx.scheduledMessage.updateMany({ where: { chatId: p.lidChat.id }, data: { chatId: p.phoneChat.id } })
        // 4. Contact dobel yang menempel chat LID:
        //    - chat phone SUDAH punya contact → hapus dobel (status quo lama)
        //    - chat phone BELUM punya contact (kasus Kolonel t8: contact hanya di LID
        //      side, punya name+phone) → RELOCATE contact LID ke chat phone (jangan
        //      buang identitas kontak). Review Alita 20:35.
        const phoneContact = await tx.contact.findFirst({ where: { chatId: p.phoneChat.id } })
        let delContacts = { count: 0 }
        if (phoneContact) {
          delContacts = await tx.contact.deleteMany({ where: { chatId: p.lidChat.id } })
        } else {
          const movedContacts = await tx.contact.updateMany({ where: { chatId: p.lidChat.id }, data: { chatId: p.phoneChat.id } })
          delContacts = { count: 0, relocated: movedContacts.count }
        }
        // 5. Update canonical chat: lidJid + lastMessage
        await tx.chat.update({
          where: { id: p.phoneChat.id },
          data: {
            lidJid: p.lidChat.waJid.split(':')[0],
            phoneJid: p.phoneChat.phoneJid || p.phoneChat.waJid,
            contactPhone: p.phoneChat.contactPhone || p.lidChat.contactPhone || p.lidChat.waJid.split('@')[0],
            contactName: p.phoneChat.contactName || p.lidChat.contactName || null,
            lastMessageAt: lastMsg ? lastMsg.timestamp : p.lidChat.lastMessageAt,
            lastMessagePreview: lastMsg ? lastMsg.content : p.lidChat.lastMessagePreview,
          },
        })
        // 6. Hapus chat LID
        await tx.chat.delete({ where: { id: p.lidChat.id } })
        return { movedMsgs: movedMsgs.count, movedTags, movedEvents: movedEvents.count, movedNotes: movedNotes.count, movedCsat: movedCsat.count, movedSched: movedSched.count, delContacts: delContacts.count }
      })
      console.log(`[tenant #${p.tenant.id} ${p.tenant.name}] LID #${p.lidChat.id} (${lidMsgs} msgs) → PHONE #${p.phoneChat.id}: msgs=${res.movedMsgs} tags=${res.movedTags} events=${res.movedEvents} notes=${res.movedNotes} csat=${res.movedCsat} sched=${res.movedSched} contactsDel=${res.delContacts}${skipped.length ? ' SKIPPED: ' + skipped.join('; ') : ''}`)
      report.push({ pair: p, res, skipped })
    } catch (e) {
      console.error(`[tenant #${p.tenant.id}] MERGE GAGAL LID #${p.lidChat.id} → PHONE #${p.phoneChat.id}:`, e.message)
      report.push({ pair: p, error: e.message })
    }
  }
  console.log(`\nSelesai. ${report.filter((r) => !r.error).length}/${pairs.length} pasangan sukses.\n`)
}

async function main() {
  const pairs = await findDupPairs()
  if (APPLY) {
    await apply(pairs)
  } else {
    await dryRun(pairs)
    console.log('(dry-run — tidak ada perubahan DB. Jalankan dengan --apply untuk eksekusi.)')
  }
}

main()
  .catch((e) => {
    console.error('FATAL:', e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())