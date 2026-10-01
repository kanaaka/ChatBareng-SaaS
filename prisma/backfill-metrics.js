const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()

async function main() {
  const chats = await prisma.chat.findMany({
    include: {
      messages: { orderBy: { timestamp: 'asc' } },
    },
  })

  let updated = 0

  for (const chat of chats) {
    const incoming = chat.messages.filter(m => m.direction === 'in')
    const outgoing = chat.messages.filter(m => m.direction === 'out')

    const firstIncoming = incoming.length > 0 ? incoming[0].timestamp : null
    const firstResponse = outgoing.length > 0 ? outgoing[0] : null
    const csMessagesSent = outgoing.length

    if (!firstIncoming && !firstResponse && csMessagesSent === 0) {
      continue
    }

    const data = {
      firstIncomingAt: firstIncoming,
      firstResponseAt: firstResponse ? firstResponse.timestamp : chat.firstResponseAt,
      firstResponseById: firstResponse ? firstResponse.senderId : chat.firstResponseById,
      csMessagesSent,
    }

    await prisma.chat.update({
      where: { id: chat.id },
      data,
    })

    // Backfill event log for first incoming and first response
    if (firstIncoming) {
      const existingFirstIncoming = await prisma.chatEvent.findFirst({
        where: { chatId: chat.id, type: 'first_incoming' },
      })
      if (!existingFirstIncoming) {
        await prisma.chatEvent.create({
          data: {
            chatId: chat.id,
            userId: null,
            type: 'first_incoming',
            createdAt: firstIncoming,
          },
        })
      }
    }

    if (firstResponse) {
      const existingFirstResponse = await prisma.chatEvent.findFirst({
        where: { chatId: chat.id, type: 'first_response' },
      })
      if (!existingFirstResponse) {
        await prisma.chatEvent.create({
          data: {
            chatId: chat.id,
            userId: firstResponse.senderId,
            type: 'first_response',
            createdAt: firstResponse.timestamp,
          },
        })
      }
    }

    updated++
  }

  console.log(`[Backfill] Updated ${updated} chat(s)`)
}

main()
  .then(async () => {
    await prisma.$disconnect()
    process.exit(0)
  })
  .catch(async (e) => {
    console.error('[Backfill] Error:', e)
    await prisma.$disconnect()
    process.exit(1)
  })
