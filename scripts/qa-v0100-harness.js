#!/usr/bin/env node
/* QA Harness v0.10.0 — Multi-akun + chat dummy untuk ChatBareng
 * Dibuat 2026-09-09 (request Kanaka: QA simulasi sendiri, multi akun, chat dummy).
 *
 * Pemakaian (dari folder wa-cs-hub):
 *   node scripts/qa-v0100-harness.js setup        → buat 3 akun QA + 3 chat dummy + pesan
 *   node scripts/qa-v0100-harness.js verify       → dump state DB utk verifikasi cepat
 *   node scripts/qa-v0100-harness.js cleanup      → hapus SEMUA data TEST-QA-* + akun QA
 *
 * CATATAN:
 * - Jalankan dengan DATABASE_URL mengarah ke DB DEV (5041), BUKAN produksi.
 *   Contoh: DATABASE_URL="file:/tmp/qa-dev.db" node scripts/qa-v0100-harness.js setup
 * - Semua artefak bertanda: username qa_*, chat id TEST-QA-*@*, contactName "TEST QA *".
 * - Browser multi-sesi (Playwright) dikerjakan di script QA terpisah yang memakai
 *   helper createQaContexts() di bawah — 1 Chrome 18801, banyak context (cookie terpisah).
 */

const path = require('path')
const crypto = require('crypto')

const HUB = path.resolve(__dirname, '..')
// Prisma client dari hub (bukan cwd) — aman dijalankan dari mana pun
const { PrismaClient } = require(path.join(HUB, 'node_modules/@prisma/client'))

const QA_ACCOUNTS = [
  { username: 'qa_admin', password: 'Qa!' + crypto.randomBytes(6).toString('hex'), role: 'admin' },
  { username: 'qa_cs1', password: 'Qa!' + crypto.randomBytes(6).toString('hex'), role: 'cs' },
  { username: 'qa_cs2', password: 'Qa!' + crypto.randomBytes(6).toString('hex'), role: 'cs' },
]

const QA_CHATS = [
  { id: 'TEST-QA-A@s.whatsapp.net', contactName: 'TEST QA A (snooze)', messages: ['Halo kak', 'Mau tanya produk', 'Test QA A 3'] },
  { id: 'TEST-QA-B@s.whatsapp.net', contactName: 'TEST QA B (catatan)', messages: ['Kak, order saya bagaimana?', 'Test QA B 2'] },
  { id: 'TEST-QA-C@s.whatsapp.net', contactName: 'TEST QA C (csat+scheduled)', messages: ['Test QA C 1'] },
]

async function getPrisma() {
  const p = new PrismaClient()
  await p.$connect()
  return p
}

async function ensureAccounts(p) {
  const bcrypt = require(path.join(HUB, 'node_modules/bcryptjs'))
  const out = []
  for (const acc of QA_ACCOUNTS) {
    let u = await p.user.findUnique({ where: { username: acc.username } })
    if (!u) {
      const hash = bcrypt.hashSync(acc.password, 10)
      u = await p.user.create({ data: { username: acc.username, passwordHash: hash, role: acc.role, status: 'active' } })
    }
    out.push({ id: u.id, username: u.username, role: u.role, password: acc.password })
  }
  return out
}

async function ensureDummyChats(p) {
  const now = Date.now()
  for (const c of QA_CHATS) {
    let chat = await p.chat.findUnique({ where: { id: c.id } })
    if (!chat) {
      chat = await p.chat.create({
        data: {
          id: c.id,
          contactName: c.contactName,
          contactPhone: c.id.split('@')[0].replace('TEST-QA-', ''),
          status: 'open',
          queuedAt: new Date(now - 3600e3),
          unreadCount: 0,
        },
      })
    }
    let seq = 0
    for (const body of c.messages) {
      seq++
      const exists = await p.message.findFirst({ where: { chatId: c.id, content: body } })
      if (!exists) {
        await p.message.create({
          data: {
            chatId: c.id,
            direction: 'in',
            content: body,
            senderName: c.contactName,
            senderId: null,
            timestamp: new Date(now - 3600e3 + seq * 60000),
            status: 'delivered',
            waMessageId: `TESTQA-${c.id.slice(8, 14)}-${seq}-${crypto.randomBytes(3).toString('hex')}`,
          },
        })
      }
    }
  }
}

async function setup() {
  const p = await getPrisma()
  const accounts = await ensureAccounts(p)
  await ensureDummyChats(p)
  console.log('[SETUP] akun QA:', JSON.stringify(accounts, null, 1))
  console.log('[SETUP] chat dummy:', QA_CHATS.map(c => c.id).join(', '))
  console.log('[POST-VERIFY]')
  const users = await p.user.count({ where: { username: { startsWith: 'qa_' } } })
  const chats = await p.chat.count({ where: { id: { startsWith: 'TEST-QA-' } } })
  const msgs = await p.message.count({ where: { waMessageId: { startsWith: 'TESTQA-' } } })
  console.log(`  users=${users}/3 chats=${chats}/3 dummyMsgs=${msgs}`)
  await p.$disconnect()
}

async function verify() {
  const p = await getPrisma()
  const dump = {
    users: await p.user.findMany({ where: { username: { startsWith: 'qa_' } }, select: { id: true, username: true, role: true } }),
    chats: await p.chat.findMany({ where: { id: { startsWith: 'TEST-QA-' } }, select: { id: true, snoozedUntil: true, status: true, queuedAt: true, unreadCount: true } }),
    notes: await p.chatNote.count().catch(() => 'n/a (model belum ada)'),
    csat: await p.csatSurvey.count().catch(() => 'n/a'),
    scheduled: await p.scheduledMessage.count().catch(() => 'n/a'),
  }
  console.log(JSON.stringify(dump, null, 1))
  await p.$disconnect()
}

async function cleanup() {
  const p = await getPrisma()
  const ids = QA_CHATS.map(c => c.id)
  // urutan aman: child dulu
  for (const model of ['chatNote', 'csatSurvey', 'scheduledMessage']) {
    if (p[model]) {
      const userIds = await p.user.findMany({ where: { username: { startsWith: 'qa_' } } }).then(us => us.map(u => u.id))
      await p[model].deleteMany({ where: { OR: [{ chatId: { in: ids } }, { userId: { in: userIds } }] } }).catch(e => console.log(`skip ${model}:`, e.message.slice(0, 60)))
    }
  }
  for (const model of ['chatEvent', 'message']) {
    if (model === 'message') await p.message.deleteMany({ where: { chatId: { in: ids } } })
    else if (p.chatEvent) await p.chatEvent.deleteMany({ where: { chatId: { in: ids } } })
  }
  await p.chat.deleteMany({ where: { id: { in: ids } } })
  await p.user.deleteMany({ where: { username: { startsWith: 'qa_' } } })
  console.log('[CLEANUP] selesai — post-verify:')
  const users = await p.user.count({ where: { username: { startsWith: 'qa_' } } })
  const chats = await p.chat.count({ where: { id: { startsWith: 'TEST-QA-' } } })
  console.log(`  residual users=${users} chats=${chats} (harus 0/0)`)
  await p.$disconnect()
}

const cmd = process.argv[2]
const fn = { setup, verify, cleanup }[cmd]
if (!fn) {
  console.log('Pemakaian: node qa-v0100-harness.js <setup|verify|cleanup>')
  process.exit(1)
}
fn().catch(e => { console.error('ERR:', e.message); process.exit(1) })