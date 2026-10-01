#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// v3.5 — Smoke test §6 (spec): routing LID ↔ phone + greeting skip.
// Pakai tenant QA yang dibuat via API superadmin (preset pro) —
// di-purge di akhir. Gak butuh koneksi WA nyata (skenario sintetis).
// ═══════════════════════════════════════════════════════════════════
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const BASE = process.env.BASE_URL || 'http://localhost:5047'
const TOKEN_FILE = '/tmp/wacs_v35_sa_token'

let SA_TOKEN = null
let QA_TENANT_ID = null
let qaAdminUser = null
let adminUser = null
const results = []
const cleanups = []

async function api(method, urlPath, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (SA_TOKEN) headers.Authorization = `Bearer ${SA_TOKEN}`
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, json, text }
}

function pass(name, detail) {
  console.log(`  ✅ PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  results.push({ name, pass: true, detail })
}
function fail(name, detail) {
  console.log(`  ❌ FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  results.push({ name, pass: false, detail })
}

// ─── Skenario (spec §6.3) ───────────────────────────────────────────
async function testRouting() {
  console.log('\n── §6.3 Routing LID ↔ phone (msg sintetis, tenant QA) ──')
  const pool = require('../src/wa/pool')
  const tid = QA_TENANT_ID
  const PHONE = '629988776655'
  const LID = '245126709999777@lid'
  const phoneJid = `${PHONE}@s.whatsapp.net`

  // (a) Chat phone Y sudah ada → pesan LID harus persist ke chat Y + lidJid ke-set
  const chatA = await prisma.chat.create({
    data: { tenantId: tid, waJid: phoneJid, contactPhone: PHONE, phoneJid, contactName: 'Test A' },
  })
  const msgA = {
    key: { remoteJid: LID, remoteJidAlt: phoneJid, fromMe: false, id: 'TESTA1' },
    message: { conversation: 'halo dari LID (skenario a)' },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: 'TestA',
  }
  const rA = await pool.processIncomingMessage(tid, msgA)
  if (rA && rA.chat.id === chatA.id) {
    const after = await prisma.chat.findUnique({ where: { id: chatA.id } })
    if (after.lidJid === LID) {
      const msgCount = await prisma.message.count({ where: { chatId: chatA.id } })
      if (msgCount === 1) pass('(a) pesan LID → chat phone existing, lidJid ke-set, pesan persist', `chat #${chatA.id}, lidJid=${after.lidJid}`)
      else fail('(a) pesan LID → chat phone', `pesan tidak ter-persist (count=${msgCount})`)
    } else fail('(a) pesan LID → chat phone existing', `lidJid tidak ke-set (${after.lidJid})`)
  } else {
    fail('(a) pesan LID → chat phone existing', rA ? `dipersist ke chat #${rA.chat.id} (harusnya #${chatA.id})` : 'null')
  }

  // (b) Chat Y gak ada → chat LID baru dibuat dgn phoneJid = Y@s.whatsapp.net
  const PHONE2 = '629988776600'
  const LID2 = '245126709999888@lid'
  const msgB = {
    key: { remoteJid: LID2, remoteJidAlt: `${PHONE2}@s.whatsapp.net`, fromMe: false, id: 'TESTB1' },
    message: { conversation: 'halo dari LID (skenario b)' },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: 'TestB',
  }
  const rB = await pool.processIncomingMessage(tid, msgB)
  if (rB && rB.chat.waJid === LID2 && rB.chat.phoneJid === `${PHONE2}@s.whatsapp.net`) {
    pass('(b) chat LID baru dibuat dgn phoneJid dari remoteJidAlt', `chat #${rB.chat.id}, phoneJid=${rB.chat.phoneJid}`)
  } else {
    fail('(b) chat LID baru dibuat dgn phoneJid', rB ? `chat=${rB.chat.waJid}, phoneJid=${rB.chat.phoneJid}` : 'null')
  }

  // (c) Chat LID dgn phoneJid ada → pesan phone JID masuk ke chat LID itu
  const msgC = {
    key: { remoteJid: `${PHONE2}@s.whatsapp.net`, remoteJidAlt: LID2, fromMe: false, id: 'TESTC1' },
    message: { conversation: 'balasan dari phone (skenario c)' },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: 'TestB',
  }
  const rC = await pool.processIncomingMessage(tid, msgC)
  if (rC && rC.chat.id === rB.chat.id) {
    const after = await prisma.chat.findUnique({ where: { id: rB.chat.id } })
    const msgCount = await prisma.message.count({ where: { chatId: rB.chat.id } })
    if (msgCount === 2) pass('(c) pesan phone JID → chat LID existing', `chat #${rB.chat.id}, 2 pesan gabung`)
    else fail('(c) pesan phone JID → chat LID existing', `pesan count=${msgCount} (harusnya 2)`)
  } else {
    fail('(c) pesan phone JID → chat LID existing', rC ? `dipersist ke chat #${rC.chat.id} (harusnya #${rB.chat.id})` : 'null')
  }
}

// ─── Skenario (spec §6.4) ───────────────────────────────────────────
async function testGreetingSkip() {
  console.log('\n── §6.4 Greeting skip bila agen sudah nyapa duluan hari itu ──')
  const tid = QA_TENANT_ID
  const autoReply = require('../src/services/autoReply')
  // chat QA dgn contact linked
  const chat = await prisma.chat.create({
    data: { tenantId: tid, waJid: '629988770001@s.whatsapp.net', contactPhone: '629988770001', contactName: 'SkipTest', phoneJid: '629988770001@s.whatsapp.net', status: 'open' },
  })
  await prisma.contact.create({ data: { tenantId: tid, chatId: chat.id, name: 'SkipTest', phone: '629988770001', source: 'chat' } })

  // insert pesan out non-auto HARI INI (senderId dari user admin QA)
  const admin = adminUser && adminUser.id ? adminUser : await prisma.user.findFirst({ where: { tenantId: tid, role: 'admin' } })
  await prisma.message.create({
    data: { tenantId: tid, chatId: chat.id, direction: 'out', content: 'manual agent halo', senderId: admin?.id || null, senderName: admin?.username || 'admin', isAuto: false, timestamp: new Date(), status: 'sent' },
  })

  const msg = { key: { remoteJid: '629988770001@s.whatsapp.net', fromMe: false, id: 'TESTG1' }, messageTimestamp: Math.floor(Date.now() / 1000) }
  chat.contactName = 'SkipTest'
  const r = await autoReply.maybeAutoReply({ ...chat, contact: null }, msg)

  // assert
  const after = await prisma.chat.findUnique({ where: { id: chat.id } })
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  if (!r.sent && after.lastAutoGreetDate === today) {
    const autoMsgs = await prisma.message.count({ where: { chatId: chat.id, isAuto: true } })
    if (autoMsgs === 0) pass('greeting skip — marker ke-set, TIDAK ada auto message terkirim', `lastAutoGreetDate=${after.lastAutoGreetDate}`)
    else fail('greeting skip', `ada ${autoMsgs} pesan isAuto terkirim`)
  } else {
    fail('greeting skip', `sent=${r.sent}, lastAutoGreetDate=${after.lastAutoGreetDate} (harusnya ${today})`)
  }
  return chat
}

async function main() {
  try {
    SA_TOKEN = require('fs').readFileSync(TOKEN_FILE, 'utf8').trim()
  } catch {
    console.error('FATAL: token file tidak ada di', TOKEN_FILE)
    process.exit(1)
  }
  console.log('=== v3.5 Smoke test (tenant QA) ===')

  // 1. Create QA tenant (preset pro)
  const qaName = `QA-LID-${Date.now()}`
  const crt = await api('POST', '/api/sa/tenants', { name: qaName, preset: 'pro' })
  if (crt.status !== 201 || !crt.json?.tenant?.id) {
    console.error('FATAL: create QA tenant gagal', crt.status, crt.json)
    process.exit(1)
  }
  QA_TENANT_ID = crt.json.tenant.id
  console.log(`QA tenant: #${QA_TENANT_ID} (${qaName})`)
  cleanups.push(async () => {
    await api('POST', `/api/sa/tenants/${QA_TENANT_ID}/purge`, { confirmName: qaName })
  })

  // admin user QA (username global unik + password via file-safe route)
  const adminUsername = `qalid${String(Date.now()).slice(-6)}`
  const adminPassword = `QaLid${Date.now()}!x`
  const adminCrt = await api('POST', '/api/sa/tenants/' + QA_TENANT_ID + '/admins', { username: adminUsername, password: adminPassword })
  if (adminCrt.status !== 201) {
    console.error('FATAL: create QA admin gagal', adminCrt.status, adminCrt.json)
    process.exit(1)
  }
  adminUser = adminCrt.json.user || adminCrt.json

  // AutoReply config QA tenant: enable greeting text + outside hours (skenario §6.4)
  // SA token + X-Tenant-ID header (requireTenant super_admin wajib ?tenant=/header)
  const put = await fetch(`${BASE}/api/autoreply?tenant=${QA_TENANT_ID}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SA_TOKEN}`, 'X-Tenant-Id': String(QA_TENANT_ID) },
    body: JSON.stringify({ greetEnabled: true, greetMode: 'text', greetText: 'Hai {name}! (auto greeting test)', outsideHoursEnabled: true, outsideHoursText: 'Away (test)' }),
  }).then((r) => r.json()).catch(() => null)
  if (put && (put.error || put.errors)) console.log('  ⚠ autoreply PUT gagal:', JSON.stringify(put))

  try {
    await testRouting()
    await testGreetingSkip()
  } catch (e) {
    fail('runtime test error', e.message)
    console.error(e)
  }

  // Summary
  console.log('\n=== Summary ===')
  let fails = 0
  for (const r of results) {
    if (!r.pass) fails++
  }
  console.log(`Total: ${results.length}, PASS: ${results.length - fails}, FAIL: ${fails}`)
  for (const r of results.filter((x) => !x.pass)) console.log(`  FAIL: ${r.name} — ${r.detail || ''}`)

  // Purge QA tenant
  console.log('\nCleanup QA tenant...')
  for (const c of cleanups) await c()

  await prisma.$disconnect()
  process.exit(fails > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})