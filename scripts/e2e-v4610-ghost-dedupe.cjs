#!/usr/bin/env node
/**
 * E2E — v4.6.10 [No content] ghost messages + history-sync dedupe.
 *
 * Origin (lapor Kanaka + investigasi SystemLog prod, 2026-10-10): agent initiate
 * chat ke kontakt tersimpan → kirim 1 pesan teks ("ice cream", 1 bubble OUT) →
 * SEGERA bubble kedua [No content] muncul (padahal agent TIDAK kirim lagi; WA asli
 * juga TIDAK ada balasan) → chat di-close/di-buka lagi → bubble [No content] yang
 * tadinya OUT jadi IN + jumlahnya 1 → 2. SEMUA initiate kena → pelanggan marah.
 *
 * Root cause (verifikasi Baileys 7.0.0-rc14): sendMessage() kirim ke diri sendiri
 * via wrapper { deviceSentMessage: { destinationJid, message } } (isMe path,
 * messages-send.js) → WA meng-ACK stanza itu balik → handleUpsert mem-parsing
 * wrapper penanda sebagai pesan upsert type='notify' dariMe=true tanpa body →
 * pool lama (tanpa filter) menyimpannya sebagai Message row content NULL →
 * bubble [No content]. Saat reopen/history-sync, pesan sama (key.id sama atau
 * pesan berkonten) direplay → dedupe by waMessageId TIDAK ada di pool lama →
 * row dobel + arah bisa terbalik (fromMe flip).
 *
 * Perbaikan v4.6.10 (pool.js + historyImport.js + groups.js):
 *   — GHOST GATE shouldPersistIncomingMessage: protocol events/body kosong non-
 *     media di-skip; dedupe by (tenantId + waMessageId + chat same); anti-flip
 *     fromMe (lokal menang); final race-guard sebelum persist 1:1.
 *   — messages.upsert jalur 'notify' digerbangi filter yang sama; jalur 'append'
 *     (replay history-sync/offline Baileys) TETAP di-drop (perilaku prod lama) —
 *     dedupe/anti-flip utk replay live ditutup di ghost-gate + final race-guard.
 *   — FE [No content] hanya tampil utk row legacy (guard v-if tidak disentuh).
 *
 * Jalur copy-DB :5099 (WA_DISABLED=1 + E2E_OK_SEND=1 + E2E_DEBUG_INBOUND=1) —
 * produksi (5047/5062) TIDAK tersentuh. Pola: scripts/e2e-v469-outside-priority.cjs
 * (copy DB + reset superadmin + login API + self-boot; server child di-kill). Guard
 * dedupe diuji UNIT-LEVEL via pool.shouldPersistIncomingMessage (exported) — jalur
 * runtime asli upsert tetap diuji via /api/wa/inbound (notify path).
 */
const REPO = '/home/kanakxxx/.openclaw/workspace/wa-cs-hub-saas-v3'
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:5099'
const COPY_DB = process.env.E2E_COPY_DB || 'file:/tmp/saas-v3-e2e-v4610.db'
const PORT = '5099'
const fs = require('fs')
const { execSync, spawn } = require('child_process')
require(REPO + '/node_modules/dotenv').config({ path: REPO + '/.env' })
process.env.DATABASE_URL = COPY_DB
process.env.WA_DISABLED = '1'
process.env.E2E_OK_SEND = '1'
process.env.E2E_DEBUG_INBOUND = '1'
process.env.APP_VERSION = 'v4.6.10-ghost-e2e'

const { PrismaClient } = require(REPO + '/node_modules/@prisma/client')
const prisma = new PrismaClient({ datasourceUrl: COPY_DB, log: ['error'] })
const bcrypt = require(REPO + '/node_modules/bcryptjs')
const { decryptTextSafe } = require(REPO + '/src/services/textCrypto')

const fails = []
let pass = 0
let serverChild = null
function check(name, cond, extra = '') {
  const line = `${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`
  console.log(line)
  if (!cond) { process.exitCode = 1; fails.push(name) } else { pass++ }
}
async function api(method, urlPath, body, token) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let data = null
  try { data = await res.json() } catch {}
  return { status: res.status, data }
}
const ABC = 'abcdefghijklmnopqrstuvwxyz'
function mkToken(prefix) {
  let s = ''
  for (let i = 0; i < 10; i++) s += ABC[Math.floor(Math.random() * ABC.length)]
  return `${prefix}-${s}`
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let nSeq = 46100

async function seedContactWithChat(tenantId, name, { slot = 0 } = {}) {
  // Kontak tersimpan + chat kosong (kondisi awal sebelum agent initiate).
  let jid
  for (;;) {
    jid = `62899146${String(nSeq++).padStart(4, '0')}@s.whatsapp.net`
    const ex = await prisma.chat.findUnique({ where: { tenantId_numberSlot_waJid: { tenantId, numberSlot: slot, waJid: jid } } })
    if (!ex) break
  }
  const chat = await prisma.chat.create({
    data: {
      tenantId, numberSlot: slot, waJid: jid, contactPhone: jid.slice(0, 12), contactName: name,
      status: 'open', assignedToId: null, unreadCount: 0,
    },
  })
  await prisma.contact.create({ data: { tenantId, chatId: chat.id, name, phone: jid.slice(0, 12), source: 'chat' } })
  return chat
}

async function bootServerIfNeeded() {
  try {
    const r = await fetch(BASE + '/api/health')
    if (r.status === 200) { console.log('boot: server 5099 sudah hidup → pakai instance existing'); return }
  } catch {}
  const copyPath = COPY_DB.replace('file:', '')
  for (const p of [copyPath, copyPath + '-wal', copyPath + '-shm']) { try { fs.unlinkSync(p) } catch {} }
  fs.copyFileSync(REPO + '/prisma/data/saas-v3.db', copyPath)
  const env = { ...process.env, PORT, DATABASE_URL: COPY_DB, WA_DISABLED: '1', E2E_OK_SEND: '1', E2E_DEBUG_INBOUND: '1', APP_VERSION: 'v4.6.10-ghost-e2e' }
  execSync('npx prisma db push --skip-generate', { cwd: REPO, env, stdio: 'ignore', timeout: 120000 })
  serverChild = spawn('node', [REPO + '/src/server.js'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  serverChild.stdout.on('data', (d) => { out += d })
  serverChild.stderr.on('data', (d) => { out += d })
  serverChild.__out = () => out
  let healthy = false
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    try {
      const r = await fetch(BASE + '/api/health')
      if (r.status === 200) { healthy = true; break }
    } catch {}
  }
  check('S0-a server test boot di 5099 (copy DB, WA_DISABLED=1)', healthy, healthy ? '' : (serverChild.__out ? serverChild.__out().slice(-500) : 'n/a'))
}

async function main() {
  const t0 = new Date()
  try {
    await bootServerIfNeeded()
    if (fails.length) {
      console.error('BOOT GAGAL — output server:\n' + (serverChild?.__out ? serverChild.__out().slice(-2000) : 'n/a'))
      return
    }

    // ════ Setup: superadmin + tenant fixture + agent (CS) ════
    const sa0 = await prisma.user.findFirst({ where: { role: 'super_admin' } })
    check('S0-b super_admin row ada di copy DB', !!sa0)
    const saPass = process.env.SUPERADMIN_PASSWORD || 'superadmin123'
    await prisma.user.update({ where: { id: sa0.id }, data: { passwordHash: await bcrypt.hash(saPass, 10), status: 'active' } })
    const saLogin = await api('POST', '/api/auth/login', { username: sa0.username, password: saPass })
    check(`S0-c superadmin login status=${saLogin.status}`, saLogin.status === 200 && !!saLogin.data?.token)
    const saTok = saLogin.data?.token

    const tName = 'e2e-v4610-' + mkToken('t')
    const tenant = await prisma.tenant.create({ data: { name: tName, status: 'active' } })
    const T = tenant.id
    await prisma.tenantPlan.create({ data: { tenantId: T, preset: 'max' } })
    const hash = (v) => bcrypt.hashSync(v, 10)
    const csUser = await prisma.user.create({ data: { username: `cs_4610_${mkToken('u')}`, passwordHash: hash('cspass123'), role: 'cs', tenantId: T, status: 'active' } })
    const admUser = await prisma.user.create({ data: { username: `adm_4610_${mkToken('u')}`, passwordHash: hash('admpass123'), role: 'admin', tenantId: T, status: 'active' } })
    const admLogin = await api('POST', '/api/auth/login', { username: admUser.username, password: 'admpass123' })
    check('S0-d admin tenant fixture login (utk take + initiate)', admLogin.status === 200 && !!admLogin.data?.token)
    const admTok = admLogin.data?.token

    // ═══════════ UNIT-LEVEL: shouldPersistIncomingMessage (gerbang murni) ═══════════
    const pool = require(REPO + '/src/wa/pool')

    // ── U1 — §1a: protocol events TIDAK jadi row ──
    const g1 = await pool.shouldPersistIncomingMessage(T, {
      key: { remoteJid: '628111111111@s.whatsapp.net', fromMe: true, id: 'PROTO-ECHO-1' },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { protocolMessage: { type: 'EPHEMERAL_SYNC_RESPONSE' } },
    }, 0)
    check('U1-a protocolMessage (EPHEMERAL_SYNC_RESPONSE, echo self-send) → SKIP (null)', g1 === null)

    const g1b = await pool.shouldPersistIncomingMessage(T, {
      key: { remoteJid: '628111111111@s.whatsapp.net', fromMe: true, id: 'PROTO-SKDM' },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { senderKeyDistributionMessage: { groupId: 'x@g.us' } },
    }, 0)
    check('U1-b senderKeyDistributionMessage → SKIP', g1b === null)

    const g1c = await pool.shouldPersistIncomingMessage(T, {
      key: { remoteJid: '628111111111@s.whatsapp.net', fromMe: false, id: 'PROTO-REACT' },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { reactionMessage: { key: { remoteJid: 'x@s.whatsapp.net', id: 'abc' }, text: '👍' } },
    }, 0)
    check('U1-c reactionMessage → SKIP (tidak pernah jadi bubble [No content])', g1c === null)

    const g1d = await pool.shouldPersistIncomingMessage(T, {
      key: { remoteJid: '628111111111@s.whatsapp.net', fromMe: true, id: 'PROTO-EMPTY' },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: {},
    }, 0)
    check('U1-d message={} (echo upload tanpa body) → SKIP', g1d === null)

    const g1e = await pool.shouldPersistIncomingMessage(T, {
      key: { remoteJid: '628111111111@s.whatsapp.net', fromMe: true, id: 'PROTO-NULL' },
      messageTimestamp: Math.floor(Date.now() / 1000),
    }, 0)
    check('U1-e message undefined (wrapper kosong) → SKIP', g1e === null)

    // ── U2 — pesan nyata LOLOS gate (in + out) ──
    const g2a = await pool.shouldPersistIncomingMessage(T, {
      key: { remoteJid: '628222222222@s.whatsapp.net', fromMe: false, id: 'REAL-IN-1' },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { conversation: 'halo ada?' },
    }, 0)
    check('U2-a pesan teks nyata IN → lolos (persist)', g2a !== null && g2a.message?.conversation === 'halo ada?')

    const g2b = await pool.shouldPersistIncomingMessage(T, {
      key: { remoteJid: '628222222222@s.whatsapp.net', fromMe: true, id: 'REAL-OUT-1' },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { conversation: 'ice cream' },
    }, 0)
    check('U2-b pesan teks nyata OUT (initiate pertama) → lolos (persist)', g2b !== null)

    const g2c = await pool.shouldPersistIncomingMessage(T, {
      key: { remoteJid: '628333333333@s.whatsapp.net', fromMe: true, id: 'REAL-MEDIA-1' },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { imageMessage: { mimetype: 'image/jpeg', caption: 'foto' } },
    }, 0)
    check('U2-c media (image + caption) → lolos (bukan ghost)', g2c !== null)

    // ═══════════ E2E CASE 1 — initiate: 1 bubble OUT saja (bukan 2) ═══════════
    // Replika kasus Kanaka: agent initiate chat ke kontakt tersimpan → take (route
    // assign asli) → kirim "ice cream" (route reply asli persist OUT dgn waMessageId
    // WA) → SEGERA echo upload ACK masuk via jalur upsert asli (notify, fromMe=true,
    // tanpa body/protocol).
    const chatA = await seedContactWithChat(T, 'Kontak Initiate e2e4610')
    const rAssign = await api('POST', `/api/chats/${chatA.id}/assign`, { user_id: csUser.id }, admTok)
    check(`C1-0a take chat via route assign asli (${rAssign.status})`, rAssign.status === 200, `body=${JSON.stringify(rAssign.data).slice(0, 120)}`)
    const waResult = await api('POST', `/api/chats/${chatA.id}/reply`, { content: 'ice cream' }, admTok)
    check(`C1-a initiate kirim "ice cream" via route reply asli sukses (${waResult.status})`, waResult.status === 200, `body=${JSON.stringify(waResult.data).slice(0, 160)}`)
    const outRows = await prisma.message.findMany({ where: { chatId: chatA.id }, orderBy: { id: 'asc' } })
    check('C1-b pasca-initiate: PERSIS 1 row pesan', outRows.length === 1, `rows=${outRows.length}`)
    const initRow = outRows[0]
    check('C1-c row ts direction OUT + status sent + PUNYA waMessageId (E2E mock)', initRow.direction === 'out' && initRow.status === 'sent' && !!initRow.waMessageId, `waMessageId=${initRow.waMessageId}`)
    check('C1-d row ts content = "ice cream" (bukan [No content])', decryptTextSafe(initRow.content) === 'ice cream')

    // Echo upload ACK self-send datang SEGERA via jalur runtime asli (E2E_DEBUG_INBOUND).
    const echoKey = String(initRow.waMessageId || 'E2E-OK-SEND-UNKNOWN')
    const rEcho = await api('POST', '/api/wa/inbound', {
      tenantId: T, slot: 0,
      messages: {
        key: { remoteJid: chatA.waJid, fromMe: true, id: echoKey },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { protocolMessage: { type: 'EPHEMERAL_SYNC_RESPONSE' } },
      },
    }, saTok)
    check(`C1-e echo upload (protocol, fromMe=true, id SAMA ${echoKey.slice(0, 24)}…) lewat jalur runtime asli → TIDAK jadi bubble (${rEcho.status})`, rEcho.status === 200 && rEcho.data?.savedMessageId == null, JSON.stringify(rEcho.data))
    const afterEcho = await prisma.message.findMany({ where: { chatId: chatA.id }, orderBy: { id: 'asc' } })
    check('C1-f MASIH 1 row saja setelah echo (TIDAK dobel, TIDAK [No content] OUT kedua)', afterEcho.length === 1 && afterEcho[0].id === initRow.id, `rows=${afterEcho.length}`)

    // Echo kosong generic (id beda, dariMe=true, tanpa body) → juga di-skip.
    const rEcho2 = await api('POST', '/api/wa/inbound', {
      tenantId: T, slot: 0,
      messages: {
        key: { remoteJid: chatA.waJid, fromMe: true, id: 'GHOST-EMPTY-' + mkToken('g') },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {},
      },
    }, saTok)
    check('C1-g ghost empty-body lain (id beda, no body) via runtime → skip', rEcho2.status === 200 && rEcho2.data?.savedMessageId == null, JSON.stringify(rEcho2.data))
    const afterEcho2 = await prisma.message.findMany({ where: { chatId: chatA.id }, orderBy: { id: 'asc' } })
    check('C1-h chat tetap 1 pesan (ghost tidak pernah muncul / bikin chat unread)', afterEcho2.length === 1, `rows=${afterEcho2.length}`)

    // ═══════════ E2E CASE 2 — history-sync flip/dedupe pada reopen ═══════════
    // Pesan OUT yang sama direplay oleh WA saat sync dengan konten (device echo
    // berisi body — variasi nyata rc14: wrapper normalize → extendedTextMessage).
    // Perilaku benar v4.6.10: skip (dedupe by waMessageId) — TIDAK row kedua.
    const histMsgId = initRow.waMessageId
    const rHist1 = await api('POST', '/api/wa/inbound', {
      tenantId: T, slot: 0,
      messages: {
        key: { remoteJid: chatA.waJid, fromMe: true, id: histMsgId },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { extendedTextMessage: { text: 'ice cream' } },
      },
    }, saTok)
    check('C2-a history-sync replay OUT (konten sama, fromMe=true) via runtime → skip', rHist1.status === 200 && rHist1.data?.savedMessageId == null, JSON.stringify(rHist1.data))

    // Variasi flip: WA mengirim versi fromMe=false (participant view) untuk pesan
    // OUT lokal yang sama → TIDAK boleh flip + TIDAK duplikat (lokal menang).
    const rFlip = await api('POST', '/api/wa/inbound', {
      tenantId: T, slot: 0,
      messages: {
        key: { remoteJid: chatA.waJid, fromMe: false, id: histMsgId },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { extendedTextMessage: { text: 'ice cream' } },
      },
    }, saTok)
    check('C2-b participant-view (fromMe=false) utk row OUT lokal → TIDAK flip/jadi IN', rFlip.status === 200 && rFlip.data?.savedMessageId == null, JSON.stringify(rFlip.data))
    const afterFlip = await prisma.message.findMany({ where: { chatId: chatA.id }, orderBy: { id: 'asc' } })
    check('C2-c JUMLAH tetap 1 (close→open tidak menggandakan)', afterFlip.length === 1, `rows=${afterFlip.length}`)
    check('C2-d arah tetap OUT (tidak ter-flip jadi IN)', afterFlip[0].direction === 'out', `direction=${afterFlip[0].direction}`)
    check('C2-e konten row asli tetap utuh "ice cream"', decryptTextSafe(afterFlip[0].content) === 'ice cream')

    // ═══════════ E2E CASE 3 — IN duplikat (double-notify/history re-sync) ═══════════
    const chatB = await seedContactWithChat(T, 'Kontak Inbound e2e4610')
    const inKey = 'E2E4610-IN-' + mkToken('m')
    const rIn1 = await api('POST', '/api/wa/inbound', {
      tenantId: T, slot: 0,
      messages: {
        key: { remoteJid: chatB.waJid, fromMe: false, id: inKey },
        pushName: 'Kontak Inbound e2e4610',
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { conversation: 'halo kak, boleh tanya?' },
      },
    }, saTok)
    check('C3-a pesan IN nyata masuk via runtime (persist normal)', rIn1.status === 200 && !!rIn1.data?.savedMessageId, JSON.stringify(rIn1.data))
    // REPLAY persis: key.id sama + chat sama → skip (dedupe).
    const rIn2 = await api('POST', '/api/wa/inbound', {
      tenantId: T, slot: 0,
      messages: {
        key: { remoteJid: chatB.waJid, fromMe: false, id: inKey },
        pushName: 'Kontak Inbound e2e4610',
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { conversation: 'halo kak, boleh tanya?' },
      },
    }, saTok)
    check('C3-b replay IN (key.id + chat sama) → skip (tidak dobel)', rIn2.status === 200 && rIn2.data?.savedMessageId == null, JSON.stringify(rIn2.data))
    const bRows = await prisma.message.findMany({ where: { chatId: chatB.id }, orderBy: { id: 'asc' } })
    check('C3-c chat B tetap 1 pesan IN', bRows.length === 1 && bRows[0].direction === 'in', `rows=${bRows.length}`)

    // ═══════════ E2E CASE 4 — race guard + anti-spam unread ═══════════
    // Ghost TIDAK boleh membuat chat baru / naikkan unread. Simulasi: kirim ghost
    // ke JID chat yang SUDAH ada → count chat utk JID itu tetap 1 baris.
    const chatCntBefore = await prisma.chat.count({ where: { tenantId: T, waJid: chatA.waJid } })
    await api('POST', '/api/wa/inbound', {
      tenantId: T, slot: 0,
      messages: {
        key: { remoteJid: chatA.waJid, fromMe: true, id: 'GHOST-NOCHAT-' + mkToken('g') },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { protocolMessage: { type: 'HISTORY_SYNC_NOTIFICATION' } },
      },
    }, saTok)
    const chatCntAfter = await prisma.chat.count({ where: { tenantId: T, waJid: chatA.waJid } })
    check('C4-a ghost TIDAK membuat chat baru (count sama)', chatCntBefore === chatCntAfter, `${chatCntBefore} → ${chatCntAfter}`)

    // ═══════════ E2E CASE 5 — [No content] legacy backfill (participant-view) ═══════════
    // Row legacy dari bug lama: OUT + content NULL. Sync peserta dengan teks nyata
    // → backfill isi row (lokal menang arah; konten sync melengkapi) — perbaikan
    // data lama pelanggan.
    const chatC = await seedContactWithChat(T, 'Kontak Legacy e2e4610')
    const legacyRow = await prisma.message.create({
      data: { tenantId: T, chatId: chatC.id, direction: 'out', content: null, senderName: 'cs', waMessageId: 'LEGACY-4610-' + mkToken('l'), status: 'sent' },
    })
    const rLegacy = await api('POST', '/api/wa/inbound', {
      tenantId: T, slot: 0,
      messages: {
        key: { remoteJid: chatC.waJid, fromMe: false, id: legacyRow.waMessageId },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { extendedTextMessage: { text: 'isi yang benar dari sync' } },
      },
    }, saTok)
    const legacyFresh = await prisma.message.findUnique({ where: { id: legacyRow.id } })
    check('C5-a legacy [No content] OUT + participant sync bawa teks → backfill konten', rLegacy.status === 200 && decryptTextSafe(legacyFresh.content) === 'isi yang benar dari sync', `content=${decryptTextSafe(legacyFresh.content)}`)
    check('C5-b legacy backfill TIDAK menambah row (tetap 1 di chat C)', (await prisma.message.count({ where: { chatId: chatC.id } })) === 1)
    check('C5-c arah legacy tetap OUT (tidak flip)', legacyFresh.direction === 'out')

    // ═══════════ E2E CASE 6 — upsert 'append' (history-sync replay) gate ═══════════
    // Unit-level: replay 'append' berkonten + duplikat → skip; berkonten + baru → persist.
    const g6a = await pool.shouldPersistIncomingMessage(T, {
      key: { remoteJid: chatB.waJid, fromMe: false, id: inKey },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { conversation: 'halo kak, boleh tanya?' },
    }, 0, { historySync: true })
    check('C6-a replay historySync dgn konten yang sudah ada → skip (null)', g6a === null)
    const g6b = await pool.shouldPersistIncomingMessage(T, {
      key: { remoteJid: chatB.waJid, fromMe: false, id: 'REPLAY-BARU-4610' },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { conversation: 'konten replay yang belum tersimpan' },
    }, 0, { historySync: true })
    check('C6-b replay historySync dgn konten BARU → persist (lolos)', g6b !== null)
    const g6c = await pool.shouldPersistIncomingMessage(T, {
      key: { remoteJid: chatB.waJid, fromMe: true, id: 'REPLAY-GHOST-4610' },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: {},
    }, 0, { historySync: true })
    check('C6-c replay historySync kosong (ghost offline) → skip', g6c === null)

    // ═══════════ E2E CASE 7 — JID beda dengan waMessageId sama TIDAK salah-skip ═══════════
    // (dedupe scope: tenant + chat sama; JID beda = pesan nyata berbeda → lolos).
    const g7 = await pool.shouldPersistIncomingMessage(T, {
      key: { remoteJid: '628999999999@s.whatsapp.net', fromMe: true, id: histMsgId },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { conversation: 'pesanan baru utk kontak lain' },
    }, 0)
    check('C7-a waMessageId sama tapi JID/chat berbeda → lolos (bukan duplikat)', g7 !== null)

    // ═══════════ EPILOG ═══════════
    console.log(`\n=== v4.6.10 ghost/dedupe e2e: ${pass} PASS / ${fails.length} FAIL (${((Date.now() - t0) / 1000).toFixed(1)}s) ===`)
    if (fails.length) { console.log('FAIL list:'); fails.forEach((f) => console.log('  - ' + f)); process.exitCode = 1 }
  } catch (e) {
    console.error('FATAL:', e)
    process.exitCode = 1
  } finally {
    await prisma.$disconnect().catch(() => {})
    if (serverChild) {
      try { serverChild.kill('SIGTERM'); await sleep(500); serverChild.kill('SIGKILL') } catch {}
      console.log('boot server test di-kill (server child) — produksi 5047/5062 tidak tersentuh')
    }
  }
}

main()