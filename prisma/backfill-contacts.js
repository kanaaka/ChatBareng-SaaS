// Backfill Contact rows from existing Chat records.
// Run: node prisma/backfill-contacts.js
// Additive only — never drops/truncates existing data.

const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()

function normalizePhone(raw) {
  if (!raw) return null
  let phone = String(raw).replace(/[\s\-().]/g, '')
  if (phone.startsWith('+')) phone = phone.slice(1)
  if (phone.startsWith('0')) phone = '62' + phone.slice(1)
  if (phone.startsWith('8') && phone.length >= 8 && !phone.startsWith('62')) {
    phone = '62' + phone
  }
  if (!/^\d+$/.test(phone)) return null
  if (!phone.startsWith('62') && phone.length < 8) return null
  if (phone.startsWith('62') && phone.length < 10) return null
  if (phone.length > 15) return null
  return phone
}

async function main() {
  const chats = await prisma.chat.findMany({
    include: { contact: true },
    orderBy: { createdAt: 'asc' },
  })

  let created = 0
  let linked = 0
  let skipped = 0
  let lidSkipped = 0
  let errors = 0

  for (const chat of chats) {
    try {
      const isLid = chat.id.endsWith('@lid')
      // LID chat: pakai contactPhone jika itu nomor beneran (bukan LID digits), jangan pakai LID sebagai phone
      let phone
      if (isLid) {
        phone = chat.contactPhone && /^\d+$/.test(chat.contactPhone) && chat.contactPhone !== chat.id.split('@')[0]
          ? normalizePhone(chat.contactPhone)
          : null
      } else {
        phone = normalizePhone(chat.contactPhone || chat.id.split('@')[0])
      }
      const name = chat.contactName || null

      // Skip early if a contact is already linked to this chat and complete
      if (chat.contact && chat.contact.phone && chat.contact.name) {
        skipped++
        continue
      }

      if (chat.contact) {
        const patch = {}
        if (phone && !chat.contact.phone) patch.phone = phone
        if (name && !chat.contact.name) patch.name = name
        if (Object.keys(patch).length > 0) {
          await prisma.contact.update({ where: { id: chat.contact.id }, data: patch })
          linked++
        } else {
          skipped++
        }
        continue
      }

      // For LID-only chats, create a placeholder contact with no phone
      if (isLid && !phone && !name) {
        lidSkipped++
        continue
      }

      // Guard against phone duplicate or chatId duplicate races
      const existingPhone = phone ? await prisma.contact.findFirst({ where: { phone } }) : null
      const existingChatId = await prisma.contact.findUnique({ where: { chatId: chat.id } })
      const existing = existingChatId || existingPhone

      if (existing) {
        const patch = {}
        if (phone && !existing.phone) patch.phone = phone
        if (name && !existing.name) patch.name = name
        if (!existing.chatId) patch.chatId = chat.id
        if (Object.keys(patch).length > 0) {
          await prisma.contact.update({ where: { id: existing.id }, data: patch })
          linked++
        } else {
          skipped++
        }
        continue
      }

      await prisma.contact.create({
        data: {
          chatId: chat.id,
          phone,
          name,
          source: 'chat',
        },
      })
      created++
    } catch (e) {
      errors++
      console.error(`[Backfill] Error for chat ${chat.id}:`, e.message)
    }
  }

  console.log('[Backfill] done:')
  console.log(`  chats scanned: ${chats.length}`)
  console.log(`  contacts created: ${created}`)
  console.log(`  contacts linked/updated: ${linked}`)
  console.log(`  skipped (already complete): ${skipped}`)
  console.log(`  LID-only skipped: ${lidSkipped}`)
  console.log(`  errors: ${errors}`)
}

main()
  .then(async () => {
    await prisma.$disconnect()
    process.exit(0)
  })
  .catch(async (e) => {
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  })
