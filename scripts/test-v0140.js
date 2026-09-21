// ═══════════════════════════════════════════════════════════════════════
// v0.14.0 — Regression Guard (spec §7, 8 item) — pola scripts/test-v0133.js
//
// WAJIB dijalankan dengan DB COPY (JANGAN pernah menulis DB produksi):
//   cp prisma/data/wa-cs-hub.db /tmp/db-test-v0140.db
//   DATABASE_URL=file:/tmp/db-test-v0140.db node scripts/test-v0140.js
//
// Strategi: app Express memakai ROUTES ASLI (chats/groups/templates/blast/
// csat/purge) di port acak 127.0.0.1 (BUKAN 5030 — server produksi tidak
// disentuh). WA (baileys) sengaja TIDAK dikoneksikan: getStatus().connected
// = false → jalur grup 503 WA_BELUM_TERHUBUNG (deterministik). Item antrean/
// limbo diuji via prisma + queue (queueWhere tidak diubah — diverifikasi).
// ═══════════════════════════════════════════════════════════════════════
const http = require('http')
const express = require('express')
const prisma = require('../src/prisma')
const authLib = require('../src/auth')
const queue = require('../src/socket/queue')
const { encryptText } = require('../src/services/textCrypto')

let pass = 0, fail = 0
function assert(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name} ${extra}`) }
}

// ─── App: routes ASLI (shape asli) ─────────────────────────────────────
function buildApp() {
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.use('/api/chats', require('../src/routes/chats'))
  app.use('/api/groups', require('../src/routes/groups'))
  app.use('/api/templates', require('../src/routes/templates'))
  app.use('/api/blast', require('../src/routes/blast'))
  app.use('/api/csat', require('../src/routes/csat'))
  app.use('/api/purge', require('../src/routes/purge'))
  app.use((err, req, res, next) => {
    console.error('Unhandled error:', err)
    res.status(500).json({ error: 'Internal server error' })
  })
  return app
}

// ─── HTTP helper (raw http dgn body JSON) ──────────────────────────────
function request(app, method, url, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null
    const options = {
      hostname: '127.0.0.1', port: app._port, method,
      path: url,
      headers: { 'Content-Type': 'application/json' },
    }
    if (token) options.headers.Authorization = `Bearer ${token}`
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload)
    const req = http.request(options, (res) => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }) }
        catch { resolve({ status: res.statusCode, body: data }) }
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

const G = 'gtest' // penanda data test — mudah dibersihkan dari DB copy
async function main() {
  const app = buildApp()

  // Seed data test di DB COPY (idempotent: unique per run via suffix)
  const suffix = Date.now().toString(36).slice(-4)
  const admin = await prisma.user.create({ data: { username: `gtest_admin_${suffix}`, passwordHash: 'x', role: 'admin' } })
  const cs1 = await prisma.user.create({ data: { username: `gtest_cs1_${suffix}`, passwordHash: 'x', role: 'cs' } })
  const cs2 = await prisma.user.create({ data: { username: `gtest_cs2_${suffix}`, passwordHash: 'x', role: 'cs' } })
  const relay = await prisma.user.create({ data: { username: `gtest_relay_${suffix}`, passwordHash: 'x', role: 'relay' } })

  // 1:1 open milik cs1
  const chat1to1 = await prisma.chat.create({
    data: {
      id: `gtest-chat-1to1-${suffix}@s.whatsapp.net`,
      contactPhone: '628000000001',
      contactName: 'Test Customer',
      phoneJid: `gtest-chat-1to1-${suffix}@s.whatsapp.net`,
      assignedToId: cs1.id,
      status: 'open',
    },
  })
  await prisma.message.create({ data: { chatId: chat1to1.id, direction: 'in', content: encryptText('halo'), senderName: 'Test Customer', timestamp: new Date() } })

  // 1:1 unassigned + pesan → masuk antrean (item 4/6)
  const chatUn = await prisma.chat.create({
    data: {
      id: `gtest-chat-un-${suffix}@s.whatsapp.net`,
      contactPhone: '628000000002',
      contactName: 'Test Unassigned',
      phoneJid: `gtest-chat-un-${suffix}@s.whatsapp.net`,
      assignedToId: null,
      status: 'open',
    },
  })
  await prisma.message.create({ data: { chatId: chatUn.id, direction: 'in', content: encryptText('halo'), senderName: 'Test Unassigned', timestamp: new Date() } })

  // Grup: PIC cs1 (born-assigned BOTH picUserId + assignedToId — spec §4)
  const group = await prisma.chat.create({
    data: {
      id: `gtest-grup-1-${suffix}@g.us`,
      contactPhone: '1203456789-0',
      contactName: 'Grup Test QA',
      phoneJid: `gtest-grup-1-${suffix}@g.us`,
      picUserId: cs1.id,
      assignedToId: cs1.id,
      status: 'open',
    },
  })

  const sign = u => authLib.signToken({ id: u.id, username: u.username, role: u.role })
  const tokAdm = sign(admin), tokCs1 = sign(cs1), tokCs2 = sign(cs2), tokRelay = sign(relay)

  await new Promise((resolve) => {
    const server = http.createServer(app)
    server.listen(0, '127.0.0.1', () => { app._port = server.address().port; resolve() })
  })

  console.log('[1] CS filter unassigned → 403; filter=all → 403 (locked chats.js v0.1.21)')
  {
    const r1 = await request(app, 'GET', '/api/chats?filter=unassigned', { token: tokCs1 })
    assert('CS GET /api/chats?filter=unassigned → 403', r1.status === 403, `got ${r1.status}`)
    // CATATAN: spec §7.1 menulis "filter=all → fallback mine", tapi KODE TERKUNCI
    // chats.js v0.1.21 mem-403 non-admin utk 'unassigned' ATAU 'all' SEBELUM blok
    // fallback (fallback-mine hanya safety net unreachable di cabang admin).
    // Regression guard = perilaku existing TIDAK berubah → assert 403 (no code change).
    const r2 = await request(app, 'GET', '/api/chats?filter=all', { token: tokCs1 })
    assert('CS GET /api/chats?filter=all → 403 (perilaku locked, tidak diubah)', r2.status === 403, `got ${r2.status}`)
    // fallback-mine yang benar utk CS: filter=mine → hanya miliknya, tanpa grup
    const r3 = await request(app, 'GET', '/api/chats?filter=mine', { token: tokCs1 })
    assert('CS GET filter=mine → hanya miliknya', r3.status === 200 && r3.body.chats.every(c => c.assignedToId === cs1.id), `status=${r3.status}`)
    assert('filter=mine tidak memuat grup @g.us', r3.body.chats.every(c => !(c.id || '').endsWith('@g.us')))
  }

  console.log('[2] POST balas ke chat unassigned → 403 (admin juga)')
  {
    const rCs = await request(app, 'POST', `/api/chats/${encodeURIComponent(chatUn.id)}/reply`, { token: tokCs2, body: { content: 'test' } })
    assert('CS reply chat unassigned → 403', rCs.status === 403, `got ${rCs.status}`)
    const rAdm = await request(app, 'POST', `/api/chats/${encodeURIComponent(chatUn.id)}/reply`, { token: tokAdm, body: { content: 'test' } })
    assert('ADMIN reply chat unassigned → 403 (reply-lock total)', rAdm.status === 403, `got ${rAdm.status}`)
  }

  console.log('[3] CS buka detail chat orang lain → 403')
  {
    const r = await request(app, 'GET', `/api/chats/${encodeURIComponent(chat1to1.id)}`, { token: tokCs2 })
    assert('CS lain GET /api/chats/:id (chat cs1) → 403', r.status === 403, `got ${r.status}`)
    const rg = await request(app, 'GET', `/api/chats/${encodeURIComponent(group.id)}`, { token: tokCs2 })
    assert('CS lain GET detail grup PIC-nya cs1 → 403 (canAccessChat)', rg.status === 403, `got ${rg.status}`)
  }

  console.log('[4] queue_update tidak berubah — grup tidak masuk hitungan antrean')
  {
    const where = queue.queueWhere()
    // Shape queueWhere TIDAK berubah (invariant v0.13.3)
    const keys = Object.keys(where).sort()
    assert('queueWhere shape utuh (status/assignedToId/messages/OR)', JSON.stringify(keys) === JSON.stringify(['OR', 'assignedToId', 'messages', 'status']), `got ${keys.join(',')}`)
    const groupInQueue = await prisma.chat.count({ where: { AND: [where, { id: { endsWith: '@g.us' } }] } })
    assert('grup @g.us tidak match queueWhere (born-assigned, tak pernah unassigned)', groupInQueue === 0, `got ${groupInQueue}`)
    const count = await queue.getQueueCount()
    assert('getQueueCount jalan normal (>=1: chat unassigned test)', count >= 1, `got ${count}`)
  }

  console.log('[5] Menu Gateway limbo invariant utuh')
  {
    await prisma.chat.create({
      data: {
        id: `gtest-chat-limbo-${suffix}@s.whatsapp.net`,
        contactPhone: '628000000003', contactName: 'Test Limbo',
        phoneJid: `gtest-chat-limbo-${suffix}@s.whatsapp.net`,
        status: 'open', assignedToId: null, menuState: 'awaiting',
      },
    })
    await prisma.message.create({ data: { chatId: `gtest-chat-limbo-${suffix}@s.whatsapp.net`, direction: 'in', content: encryptText('menu'), senderName: 'Test Limbo', timestamp: new Date() } })
    const where = queue.queueWhere()
    const limboInQueue = await prisma.chat.count({ where: { AND: [where, { menuState: 'awaiting' }] } })
    assert('chat menuState=awaiting tidak dihitung antrean (limbo utuh §4.1)', limboInQueue === 0, `got ${limboInQueue}`)
    const r = await request(app, 'GET', '/api/chats?filter=unassigned', { token: tokAdm })
    assert('admin filter=unassigned tidak memuat chat awaiting', r.status === 200 && r.body.chats.every(c => c.menuState !== 'awaiting'), `got ${r.status}`)
  }

  console.log('[6] Take/resolve/templates/blast/CSAT/purge/snooze: no shape change')
  {
    const rTake = await request(app, 'POST', '/api/chats/take-next', { token: tokCs1 })
    assert('take-next → 200 shape { chat } (grup tidak ikut FIFO)', rTake.status === 200 && !!rTake.body.chat && rTake.body.chat.id === chatUn.id, `got ${rTake.status}`)
    const rResolve = await request(app, 'POST', `/api/chats/${encodeURIComponent(chatUn.id)}/resolve`, { token: tokCs1 })
    assert('resolve → 200 shape { chat }', rResolve.status === 200 && !!rResolve.body.chat, `got ${rResolve.status}`)
    const rTpl = await request(app, 'GET', '/api/templates', { token: tokCs1 })
    assert('GET /api/templates → 200 shape { templates: [...] }', rTpl.status === 200 && Array.isArray(rTpl.body.templates), `got ${rTpl.status}`)
    const rBlast = await request(app, 'GET', '/api/blast', { token: tokCs1 })
    assert('GET /api/blast → 200 shape { blasts: [...] }', rBlast.status === 200 && Array.isArray(rBlast.body.blasts), `got ${rBlast.status}`)
    const rCsat = await request(app, 'GET', '/api/csat/config', { token: tokAdm })
    assert('GET /api/csat/config (admin) → 200 shape { config }', rCsat.status === 200 && 'config' in rCsat.body, `got ${rCsat.status}`)
    // PENTING (forensik run 19:05): purge dgn payload invalid-mode TIDAK ditolak
    // validator — dia jalan & me-RELEASE semua chat terdampak (assignedToId→null).
    // Itu perilaku existing terkunci — regression guard TIDAK mengeksekusi purge
    // nyata di sini. Shape guard saja: purge tanpa auth → 401 (route+guard utuh).
    const rPurge = await request(app, 'POST', '/api/purge', { body: { mode: 'soft' } })
    assert('POST /api/purge tanpa auth → 401 (route terpasang, requireAdmin utuh)', rPurge.status === 401, `got ${rPurge.status}`)
    const rSnooze = await request(app, 'POST', `/api/chats/${encodeURIComponent(chat1to1.id)}/snooze`, { token: tokCs1, body: { until: 'bukan-iso' } })
    assert('POST snooze invalid until → 400 (chat masih assigned cs1)', rSnooze.status === 400, `got ${rSnooze.status}`)
  }

  console.log('[7] Endpoint existing tetap lulus dgn payload lama (additive fields only)')
  {
    const r = await request(app, 'GET', '/api/chats?filter=mine', { token: tokCs1 })
    assert('GET /api/chats?filter=mine → 200 shape { chats: [...] }', r.status === 200 && Array.isArray(r.body.chats), `got ${r.status}`)
    // STUB TEST-ONLY: wa.sendMessage distub in-process (rute memanggil via
    // objek module `wa` → reassign property cukup). File produksi TIDAK disentuh.
    // Tanpa stub, reply = 500 'WhatsApp not connected' — perilaku locked, tapi
    // item §7 butuh verifikasi shape { message } saat reply sukses.
    const waMod = require('../src/wa/baileys')
    waMod.sendMessage = async () => ({ key: { id: 'gtest-stub-msg' } })
    const rReply = await request(app, 'POST', `/api/chats/${encodeURIComponent(chat1to1.id)}/reply`, { token: tokCs1, body: { content: 'hai dari regression test' } })
    assert('reply 1:1 milik CS → 200 shape { message }', rReply.status === 200 && !!rReply.body.message, `got ${rReply.status}`)
    const rAssign = await request(app, 'POST', `/api/chats/${encodeURIComponent(chat1to1.id)}/assign`, { token: tokCs1, body: {} })
    assert('assign chat milik diri → 200 shape { chat }', rAssign.status === 200 && !!rAssign.body.chat, `got ${rAssign.status}`)
    const tag = await prisma.tag.create({ data: { name: `gtest-tag-${suffix}`, color: 'blue' } })
    const rTag = await request(app, 'POST', `/api/chats/${encodeURIComponent(chat1to1.id)}/tags`, { token: tokCs1, body: { tagId: tag.id } })
    assert('add tag ke chat → 201 shape { tag }', rTag.status === 201 && !!rTag.body.tag, `got ${rTag.status}`)
    const rGroupsRelay = await request(app, 'GET', '/api/groups', { token: tokRelay })
    assert('relay GET /api/groups → 200 [] (matriks visibility §3)', rGroupsRelay.status === 200 && Array.isArray(rGroupsRelay.body.groups) && rGroupsRelay.body.groups.length === 0, `got ${rGroupsRelay.status}`)
  }

  console.log('[8] Grup TIDAK muncul di tab Unassigned maupun list Mine CS lain')
  {
    const rMine = await request(app, 'GET', '/api/chats?filter=mine', { token: tokCs2 })
    assert('Mine cs2 (bukan PIC) tidak memuat grup', rMine.status === 200 && rMine.body.chats.every(c => !(c.id || '').endsWith('@g.us')), `got ${rMine.status}`)
    const rUn = await request(app, 'GET', '/api/chats?filter=unassigned', { token: tokAdm })
    assert('Unassigned (admin) tidak memuat grup @g.us', rUn.status === 200 && rUn.body.chats.every(c => !(c.id || '').endsWith('@g.us')), `got ${rUn.status}`)
    const rAll = await request(app, 'GET', '/api/chats?filter=all', { token: tokAdm })
    assert('All (admin) tidak memuat grup (additive where phoneJid not endsWith @g.us)', rAll.status === 200 && rAll.body.chats.every(c => !(c.id || '').endsWith('@g.us')), `got ${rAll.status}`)
    const rG1 = await request(app, 'GET', '/api/groups', { token: tokCs1 })
    assert('PIC GET /api/groups → grup miliknya', rG1.status === 200 && rG1.body.groups.some(g => g.id === group.id), `got ${rG1.status}`)
    const rG2 = await request(app, 'GET', '/api/groups', { token: tokCs2 })
    assert('CS lain GET /api/groups → []', rG2.status === 200 && rG2.body.groups.length === 0, `got ${rG2.status}`)
    const rCreate = await request(app, 'POST', '/api/groups', { token: tokRelay, body: { subject: 'X' } })
    assert('relay POST /api/groups → 403 (spec §3)', rCreate.status === 403, `got ${rCreate.status}`)
    // Kontrak error grup (spec §5): WA belum open → 503 WA_BELUM_TERHUBUNG (UI:
    // banner/toast ramah, bukan error mentah). Test deterministik: WA tidak pernah
    // dikoneksikan di proses test ini.
    const rCreateOff = await request(app, 'POST', '/api/groups', { token: tokAdm, body: { subject: 'Grup QA' } })
    assert('POST /api/groups dgn WA off → 503 code=WA_BELUM_TERHUBUNG', rCreateOff.status === 503 && rCreateOff.body.code === 'WA_BELUM_TERHUBUNG', `got ${rCreateOff.status} ${JSON.stringify(rCreateOff.body).slice(0,80)}`)
    const rDetailOff = await request(app, 'GET', `/api/groups/${encodeURIComponent(group.id)}`, { token: tokCs1 })
    assert('GET /api/groups/:id dgn WA off → 503 WA_BELUM_TERHUBUNG', rDetailOff.status === 503 && rDetailOff.body.code === 'WA_BELUM_TERHUBUNG', `got ${rDetailOff.status}`)
  }

  console.log(`\nHasil: ${pass} pass, ${fail} fail`)
  await prisma.$disconnect()
  process.exit(fail > 0 ? 1 : 0)
}

main().catch(async (e) => {
  console.error('Test fatal:', e)
  try { await prisma.$disconnect() } catch {}
  process.exit(1)
})