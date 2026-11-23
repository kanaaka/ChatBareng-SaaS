// Idempotensi re-import (merge path) — offline, TANPA DB:
// payload Cekat di-run 2x lewat runHistoryImport dengan prisma FAKE yang
// mensimulasikan dedup engine: chat findUnique hit → merge branch;
// message dedup key dibandingkan terhadap "pesan yang sudah ada di DB"
// (simulasi: key dari pesan yang di-insert run pertama).
//
// Ekspektasi (spec): chatsMerged≈2509, messagesSkipped≈2509, chatsCreated=0,
// messagesAdded=0.
//
// Run: node scripts/test-cekat-idempotent.js

const { parseCekatCsv } = require('../src/services/cekatCsv')
const { convertCekatRows, buildCekatPayload } = require('../src/services/cekatConverter')
const { runHistoryImport, dedupKey } = require('../src/services/historyImport')
const fs = require('fs')

const SRC =
  '/home/kanakxxx/.openclaw/workspace/media/inbound/openclaw-staged-3ba36d68-e701-434a-b29f-0222dd90ccd0/conversations_export_1789961471429---ac120c8e-a649-4224-bde6-084e1346b4b2.csv'

const rows = parseCekatCsv(fs.readFileSync(SRC))
const users = [
  { id: 26, username: 'desta' },
  { id: 27, username: 'shieva' },
  { id: 28, username: 'Huzaimah' },
  { id: 29, username: 'Zahrina' },
  { id: 30, username: 'Yesa' },
]
const userMap = new Map(users.map((u) => [u.username, u.id]))
const userMapLower = new Map(users.map((u) => [String(u.username).toLowerCase(), u.username]))

async function main() {
  const { chats } = convertCekatRows(rows, { userMapLower })
  const payload = buildCekatPayload(chats)

  const dbChats = new Map() // chatId → { lastMessageAt }
  const dbMsgKeys = new Map() // chatId → Set(dedupKey)
  const dbMsgRows = new Map() // chatId → [message rows]
  const dbTags = new Set() // `${chatId}|${tagName}`
  const dbContacts = new Map() // chatId → { id }
  const dbTagsCache = new Map() // tagName → id
  const dbChatTags = new Set() // `${chatId}|${tagId}`

  let contactSeq = 0

  function makeTx() {
    return {
      chat: {
        findUnique: async ({ where }) => {
          const c = dbChats.get(where.id)
          return c ? { id: c.id, lastMessageAt: c.lastMessageAt } : null
        },
        create: async ({ data }) => {
          dbChats.set(data.id, { id: data.id, lastMessageAt: data.lastMessageAt })
          if (data.assignedToId != null && !userMap.has(Array.from(userMap.keys()).find((k) => userMap.get(k) === data.assignedToId))) {
            throw new Error('assignedToId not in userMap — should never happen')
          }
        },
        update: async () => {},
      },
      message: {
        findMany: async ({ where }) => {
          // Simulasi pesan AKTIF di DB (purged:false) — kembalikan bentuk sama dgn select engine
          const keys = dbMsgKeys.get(where.chatId) || new Set()
          // Kita perlu field asli utk hitung key di engine — simpan juga pesan mentah
          return (dbMsgRows.get(where.chatId) || []).filter((m) => !m.purged)
        },
        createMany: async ({ data }) => {
          for (const m of data) {
            if (!dbMsgRows.has(m.chatId)) dbMsgRows.set(m.chatId, [])
            dbMsgRows.get(m.chatId).push(m)
            if (!dbMsgKeys.has(m.chatId)) dbMsgKeys.set(m.chatId, new Set())
            dbMsgKeys.get(m.chatId).add(dedupKey(m.chatId, m.timestamp, m.direction, m.senderName, decryptSim(m.content)))
          }
        },
      },
      contact: {
        findUnique: async ({ where }) => {
          const c = dbContacts.get(where.chatId)
          return c ? { id: c.id, chatId: c.chatId, phone: c.phone, name: c.name, birthDate: null, gender: null, city: null, note: c.note } : null
        },
        findFirst: async () => null,
        create: async ({ data }) => {
          dbContacts.set(data.chatId, { id: ++contactSeq, chatId: data.chatId, phone: data.phone, name: data.name, note: data.note })
        },
        update: async () => {},
      },
      tag: {
        findUnique: async ({ where }) => (dbTagsCache.has(where.name) ? { id: dbTagsCache.get(where.name), name: where.name } : null),
        create: async ({ data }) => {
          const id = dbTagsCache.size + 1
          dbTagsCache.set(data.name, id)
          return { id, name: data.name }
        },
      },
      chatTag: {
        findUnique: async ({ where }) => (dbChatTags.has(`${where.chatId_tagId.chatId}|${where.chatId_tagId.tagId}`) ? {} : null),
        create: async ({ data }) => {
          dbChatTags.add(`${data.chatId}|${data.tagId}`)
        },
      },
    }
  }

  // dedup key dari ciphertext harus dihitung dari plaintext (engine pakai decryptTextSafe)
  const { decryptTextSafe } = require('../src/services/textCrypto')
  function decryptSim(content) {
    return decryptTextSafe(content)
  }

  // prisma fake: transaction(fn) → fn(tx)
  const fakePrisma = {
    $transaction: async (fn) => fn(makeTx()),
  }

  // ── RUN 1 (fresh) ──
  const r1 = await runHistoryImport(fakePrisma, payload, userMap, false)

  // ── RUN 2 (re-import file yang sama) ──
  const r2 = await runHistoryImport(fakePrisma, payload, userMap, false)

  console.log('run1:', JSON.stringify({ chatsCreated: r1.chatsCreated, chatsMerged: r1.chatsMerged, messagesAdded: r1.messagesAdded, messagesSkipped: r1.messagesSkipped, contactsUpdated: r1.contactsUpdated, errors: r1.errors.length }))
  console.log('run2:', JSON.stringify({ chatsCreated: r2.chatsCreated, chatsMerged: r2.chatsMerged, messagesAdded: r2.messagesAdded, messagesSkipped: r2.messagesSkipped, contactsUpdated: r2.contactsUpdated, errors: r2.errors.length }))

  let ok = true
  const expect = (name, got, want) => {
    const pass = got === want
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name}: got=${got} want=${want}`)
    if (!pass) ok = false
  }
  expect('run1.chatsCreated', r1.chatsCreated, 2509)
  expect('run1.messagesAdded', r1.messagesAdded, 2509)
  expect('run1.errors', r1.errors.length, 0)
  expect('run2.chatsCreated', r2.chatsCreated, 0)
  expect('run2.chatsMerged', r2.chatsMerged, 2509)
  expect('run2.messagesSkipped', r2.messagesSkipped, 2509)
  expect('run2.messagesAdded', r2.messagesAdded, 0)
  expect('run2.errors', r2.errors.length, 0)

  console.log(ok ? '\nIDEMPOTENCY PASS' : '\nIDEMPOTENCY FAIL')
  process.exit(ok ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})