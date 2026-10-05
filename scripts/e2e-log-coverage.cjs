#!/usr/bin/env node
/**
 * E2E — Log Coverage Upgrade (spec docs/spec-log-coverage-upgrade.md §E)
 * Jalur copy-DB :5099 (WA_DISABLED=1) — produksi (5047) TIDAK tersentuh.
 * Pola: scripts/e2e-v470-systemlogs.mjs (copy DB + reset superadmin + login API).
 *
 * Setup copy-DB (dari repo root):
 *   cp prisma/data/saas-v3.db /tmp/saas-v3-e2e-logcov.db
 *   DATABASE_URL=file:/tmp/saas-v3-e2e-logcov.db npx prisma db push --skip-generate
 *   PORT=5099 DATABASE_URL=file:/tmp/saas-v3-e2e-logcov.db WA_DISABLED=1 node src/server.js &
 *   node scripts/e2e-log-coverage.cjs
 *
 * 12 kasus (§E):
 *   1  Trigger 400 (tag tanpa nama) → warn row: path+status, tenant+user benar
 *   2  409 (tag duplikat) → warn row muncul
 *   3  403 (cs akses endpoint admin) → warn row
 *   4  Health/media-retry/client-log + auth 401/403 → TIDAK log / diredam (ignore list)
 *   5  Import sukses → IMPORT-DONE dgn jumlah rows benar
 *   6  Import rusak → IMPORT-FAIL warn + detail
 *   7  Tag save sukses → TAG-SAVE info (POST + PUT)
 *   8  Pesan WA simulasi masuk → MSG-IN info dgn tenant sesuai (+ isi pesan TIDAK dilog)
 *   9  Claim chat → row module 'chat' (BUKAN 'other') (+ retag LIST-DEBUG, Batch, Snooze)
 *  10  Redaksi: meta/message tidak boleh berisi nomor/email mentah
 *  11  Flood: spam 500 logInfo → ≤300 masuk + warn suppress, server tetap 200 OK
 *  12  Boot regresi: instance kedua, clean boot tanpa error capture-layer, no self-log-storm
 */
const REPO = '/home/kanakxxx/.openclaw/workspace/wa-cs-hub-saas-v3'
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:5099'
// KRITIS (lesson v4.1.x / v470): .env berisi DATABASE_URL PROD (ABSOLUTE path) →
// DATABASE_URL dipaksa ke copy SETELAH dotenv — seluruh proses satu DB copy (service
// gak pernah menembak PROD).
const COPY_DB = process.env.E2E_COPY_DB || 'file:/tmp/saas-v3-e2e-logcov.db'
const fs = require('fs')
const { execSync, spawn } = require('child_process')
require(REPO + '/node_modules/dotenv').config({ path: REPO + '/.env' })
process.env.DATABASE_URL = COPY_DB
process.env.WA_DISABLED = '1'
process.env.APP_VERSION = 'v4.6.4-logcov-e2e'
// Window pendek KHUSUS proses test ini (kasus 11 warn flush ~3s). Server proses
// tetap default 60s — guard state per-proses, tidak saling memengaruhi.
process.env.SYSTEMLOG_FLOOD_WINDOW_MS = '3000'

const { PrismaClient } = require(REPO + '/node_modules/@prisma/client')
const prisma = new PrismaClient({ datasourceUrl: COPY_DB, log: ['error'] })
const bcrypt = require(REPO + '/node_modules/bcryptjs')
const systemLog = require(REPO + '/src/services/systemLog') // unit kasus 4/11 (kode identik dgn server)

const fails = []
let pass = 0
function check(name, cond, extra = '') {
  const line = `${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`
  console.log(line)
  if (!cond) { process.exitCode = 1; fails.push(name) } else { pass++ }
}
async function api(method, urlPath, body, token, headers = {}) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const contentType = res.headers.get('content-type') || ''
  let data = null; let text = null
  if (contentType.includes('application/json')) { try { data = await res.json() } catch {} }
  else { text = await res.text().catch(() => '') }
  return { status: res.status, data, text, contentType }
}
async function apiForm(urlPath, filename, content, token) {
  const fd = new FormData()
  fd.append('file', new Blob([content], { type: 'application/json' }), filename)
  const res = await fetch(BASE + urlPath, { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: fd })
  let data = null
  try { data = await res.json() } catch {}
  return { status: res.status, data }
}
const ABC = 'abcdefghijklmnopqrstuvwxyz'
function mkTag(prefix) {
  let s = ''
  for (let i = 0; i < 8; i++) s += ABC[Math.floor(Math.random() * ABC.length)]
  return `${prefix}-${s}`
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function countLogs(where) { return prisma.systemLog.count({ where }) }
// Poll: row log muncul async (finish-event + prisma write) → tunggu maks ~8s
async function waitForCount(where, min, timeoutMs = 8000) {
  const t0 = Date.now()
  for (;;) {
    const n = await countLogs(where)
    if (n >= min) return n
    if (Date.now() - t0 > timeoutMs) return n
    await sleep(300)
  }
}

// ── Fixture msg WA utk processIncomingMessage (hanya field yang dibaca handler) ──
function mkWaMsg(jid, text) {
  return { key: { remoteJid: jid, fromMe: false, id: mkTag('wamsgid') }, message: { conversation: text } }
}

async function main() {
  const t0 = new Date()
  try {
    // ── S0 — setup: superadmin password reset (COPY DB saja) + login + tenant uji ──
    const sa0 = await prisma.user.findFirst({ where: { role: 'super_admin' } })
    check('S0-a super_admin row ada di copy DB', !!sa0)
    const saPass = process.env.SUPERADMIN_PASSWORD || 'superadmin123'
    await prisma.user.update({ where: { id: sa0.id }, data: { passwordHash: await bcrypt.hash(saPass, 10), status: 'active' } })
    const saLogin = await api('POST', '/api/auth/login', { username: sa0.username, password: saPass })
    check(`S0-b superadmin login status=${saLogin.status}`, saLogin.status === 200 && !!saLogin.data?.token)
    const saTok = saLogin.data?.token
    if (!saTok) return process.exit(1)

    const tName = 'e2e-logcov-' + mkTag('t')
    const tenant = await prisma.tenant.create({ data: { name: tName, status: 'active' } })
    const T = tenant.id
    // Plan max → gate history import + kuota kontak kebuka
    await require(REPO + '/src/services/plans').ensureTenantPlan(T, 'max')
    const adminHash = await bcrypt.hash('adminpass123', 10)
    const csHash = await bcrypt.hash('cspass123', 10)
    const adminUser = await prisma.user.create({ data: { username: `adm_lgcov_${mkTag('u')}`, passwordHash: adminHash, role: 'admin', tenantId: T, status: 'active' } })
    const csUser = await prisma.user.create({ data: { username: `cs_lgcov_${mkTag('u')}`, passwordHash: csHash, role: 'cs', tenantId: T, status: 'active' } })
    const adminLogin = await api('POST', '/api/auth/login', { username: adminUser.username, password: 'adminpass123' })
    check(`S0-c admin tenant login status=${adminLogin.status}`, adminLogin.status === 200 && !!adminLogin.data?.token)
    const adminTok = adminLogin.data?.token
    const csLogin = await api('POST', '/api/auth/login', { username: csUser.username, password: 'cspass123' })
    check(`S0-d cs login status=${csLogin.status}`, csLogin.status === 200 && !!csLogin.data?.token)
    const csTok = csLogin.data?.token
    console.log(`S0 tenant uji #${T} (${tName}) + admin/cs fixture (copy DB ${COPY_DB})`)
    void saTok

    // ════ Kasus 1 — Trigger 400 (tag tanpa nama) → warn row path+status+tenant+user ════
    {
      const r = await api('POST', '/api/tags', { name: '' }, adminTok)
      check(`K1-a POST tag tanpa nama → 400 (got ${r.status})`, r.status === 400)
      const n = await waitForCount({ level: 'warn', message: { contains: 'POST /api/tags -> 400' } }, 1)
      check(`K1-b warn row middleware muncul (got ${n})`, n >= 1)
      const row = await prisma.systemLog.findFirst({ where: { level: 'warn', message: { contains: 'POST /api/tags -> 400' } }, orderBy: { id: 'desc' } })
      check('K1-c module=chat (mapping /api/tags via guessRequestMapping)', row?.module === 'chat', `got=${row?.module}`)
      check(`K1-d tenantId=${T} di row (token admin tenant)`, row?.tenantId === T, `got=${row?.tenantId}`)
      const meta = row?.metaJson || ''
      check('K1-e metaJson: status 400 + username admin', meta.includes('"status":400') && meta.includes(adminUser.username), meta.slice(0, 100))
      check('K1-f message format "POST /api/tags -> 400"', /^POST \/api\/tags -> 400$/.test(row?.message || ''), (row?.message || '').slice(0, 60))
    }

    // ════ Kasus 7 — Tag save sukses (POST + PUT) → TAG-SAVE info ════
    let tagName, tagId
    {
      tagName = mkTag('tagsave')
      const r = await api('POST', '/api/tags', { name: tagName }, adminTok)
      check(`K7-a POST tag baru → 201 (got ${r.status})`, r.status === 201)
      tagId = r.data?.tag?.id
      const n = await waitForCount({ level: 'info', message: { contains: `TAG-SAVE name="${tagName}" tenant=${T}` } }, 1)
      check(`K7-b TAG-SAVE info row muncul (got ${n})`, n >= 1)
      const row = await prisma.systemLog.findFirst({ where: { level: 'info', message: { contains: `TAG-SAVE name="${tagName}"` } }, orderBy: { id: 'desc' } })
      check('K7-c TAG-SAVE module=chat + tenant benar', row?.module === 'chat' && row?.tenantId === T, `module=${row?.module} tenant=${row?.tenantId}`)
      check('K7-d meta tagId benar', !!row?.metaJson && row.metaJson.includes(`"tagId":${tagId}`), (row?.metaJson || '').slice(0, 80))

      // PUT rename → TAG-SAVE kedua (jalur PUT)
      const renamed = mkTag('tagsaveren')
      const r2 = await api('PUT', `/api/tags/${tagId}`, { name: renamed }, adminTok)
      check(`K7-e PUT rename → 200 (got ${r2.status})`, r2.status === 200)
      const n2 = await waitForCount({ level: 'info', message: { contains: `TAG-SAVE name="${renamed}" tenant=${T}` } }, 1)
      check(`K7-f TAG-SAVE (PUT) info row muncul (got ${n2})`, n2 >= 1)
      tagName = renamed
    }

    // ════ Kasus 2 — 409 (tag duplikat) → warn row ════
    {
      const r = await api('POST', '/api/tags', { name: tagName }, adminTok)
      check(`K2-a POST nama tag duplikat → 409 (got ${r.status})`, r.status === 409)
      const n = await waitForCount({ level: 'warn', message: { contains: 'POST /api/tags -> 409' } }, 1)
      check(`K2-b warn row 409 muncul (got ${n})`, n >= 1)
      const row = await prisma.systemLog.findFirst({ where: { level: 'warn', message: { contains: 'POST /api/tags -> 409' } }, orderBy: { id: 'desc' } })
      check('K2-c module=chat + tenant benar', row?.module === 'chat' && row?.tenantId === T, `module=${row?.module} tenant=${row?.tenantId}`)
    }

    // ════ Kasus 3 — 403 (cs akses endpoint admin) → warn row ════
    {
      const r = await api('GET', '/api/sa/system-logs', undefined, csTok)
      check(`K3-a GET /api/sa/system-logs pakai cs → 403 (got ${r.status})`, r.status === 403)
      const n = await waitForCount({ level: 'warn', message: { contains: 'GET /api/sa/system-logs -> 403' } }, 1)
      check(`K3-b warn row 403 muncul (got ${n})`, n >= 1)
      const row = await prisma.systemLog.findFirst({ where: { level: 'warn', message: { contains: 'GET /api/sa/system-logs -> 403' } }, orderBy: { id: 'desc' } })
      check('K3-c module=tenant (mapping /api/sa) + tenant cs benar', row?.module === 'tenant' && row?.tenantId === T, `module=${row?.module} tenant=${row?.tenantId}`)
    }

    // ════ Kasus 4 — Ignore list: health / media-retry / client-log TIDAK dilog ════
    {
      const m = await api('POST', '/api/media/upload', {}) // tanpa token → 401
      check(`K4-a POST /api/media/upload tanpa token → 401 (got ${m.status})`, m.status === 401)
      const c = await api('POST', '/api/client-log', { message: 'x' }) // tanpa token → 401
      check(`K4-b POST /api/client-log tanpa token → 401 (got ${c.status})`, c.status === 401)
      const h = await api('GET', '/api/health')
      check(`K4-c GET /api/health → 200 (got ${h.status})`, h.status === 200)
      await sleep(1200)
      const rows = await countLogs({ level: 'warn', OR: [
        { message: { contains: '/api/health ->' } },
        { message: { contains: '/api/media/upload ->' } },
        { message: { contains: '/api/client-log ->' } },
      ] })
      check(`K4-d TIDAK ada warn row utk ignored paths (got ${rows})`, rows === 0)
      // Unit service-layer: health 500 pun di-ignore (simulate health gagal)
      check('K4-e shouldLog4xx("/api/health", 500) = false (simulate health gagal)', systemLog.shouldLog4xx('/api/health', 500) === false)
      check('K4-f shouldLog4xx("/api/client-log", 400) = false (self-ignore)', systemLog.shouldLog4xx('/api/client-log', 400) === false)
      check('K4-g shouldLog4xx("/api/media/upload?x=1", 500) = false (media retry noise)', systemLog.shouldLog4xx('/api/media/upload?x=1', 500) === false)
      // Unit rate-limit auth 401/403: 1/menit per (path,code)
      check('K4-h auth 401 pertama → log', systemLog.shouldLog4xx('/api/auth/login', 401) === true)
      check('K4-i auth 401 kedua <=60s → SUPPRESS (1/menit)', systemLog.shouldLog4xx('/api/auth/login', 401) === false)
      check('K4-j auth 403 beda code → log (rate per (path,code))', systemLog.shouldLog4xx('/api/auth/login', 403) === true)
      check('K4-k path lain tetap log (ignore tidak melar)', systemLog.shouldLog4xx('/api/tags', 400) === true)
    }

    // ════ Kasus 5 — Import sukses → IMPORT-DONE dgn jumlah rows benar ════
    {
      const jid = `e2elgcov${Math.random().toString(36).slice(2, 8)}@s.whatsapp.net`
      const payload = {
        format: 'wa-cs-hub-history',
        version: 1,
        chats: [{
          chatId: jid,
          contactPhone: null, contactName: 'E2E LogCov Import',
          messages: [{ direction: 'in', content: `isi pesan ${mkTag('imp')}`, senderName: 'Tester', timestamp: new Date().toISOString() }],
        }],
      }
      const r = await apiForm('/api/history/import', 'backup.json', JSON.stringify(payload), adminTok)
      check(`K5-a import sukses → 200 (got ${r.status})`, r.status === 200, JSON.stringify(r.data || {}).slice(0, 160))
      check(`K5-b result chatsCreated=1 messagesAdded=1 (got chats=${r.data?.chatsCreated} msgs=${r.data?.messagesAdded})`, r.data?.chatsCreated === 1 && r.data?.messagesAdded === 1)
      const n = await waitForCount({ level: 'info', message: { contains: 'IMPORT-DONE' } }, 1)
      check(`K5-c IMPORT-DONE info row muncul (got ${n})`, n >= 1)
      const row = await prisma.systemLog.findFirst({ where: { level: 'info', message: { contains: 'IMPORT-DONE file=backup.json rows=1 chats=' } }, orderBy: { id: 'desc' } })
      check('K5-d IMPORT-DONE module=chat + tenant benar', row?.module === 'chat' && row?.tenantId === T, `module=${row?.module} tenant=${row?.tenantId}`)
      check('K5-e meta rows=1 dryRun=false', !!row?.metaJson && row.metaJson.includes('"rows":1') && row.metaJson.includes('"dryRun":false'), (row?.metaJson || '').slice(0, 120))
      check('K5-f isi pesan import TIDAK ada di row log (privacy)', !(row?.message || '').includes('isi pesan') && !(row?.metaJson || '').includes('isi pesan'))
      const chat = await prisma.chat.findFirst({ where: { tenantId: T, waJid: jid } })
      globalThis.__e2e_importChatId = chat?.id
    }

    // ════ Kasus 6 — Import rusak → IMPORT-FAIL warn + detail ════
    {
      const r = await apiForm('/api/history/import', 'backup.json', 'bukan json {{{', adminTok)
      check(`K6-a import rusak → 400 (got ${r.status})`, r.status === 400, JSON.stringify(r.data || {}).slice(0, 120))
      const n = await waitForCount({ level: 'warn', message: { contains: `IMPORT-FAIL tenant=${T}` } }, 1)
      check(`K6-b IMPORT-FAIL warn row muncul (got ${n})`, n >= 1)
      const row = await prisma.systemLog.findFirst({ where: { level: 'warn', message: { contains: 'IMPORT-FAIL' } }, orderBy: { id: 'desc' } })
      check('K6-c module=chat + tenant + reason detail', row?.module === 'chat' && row?.tenantId === T && (row?.message || '').includes('File bukan JSON yang valid'), (row?.message || '').slice(0, 140))
    }

    // ════ Kasus 8 — Pesan WA simulasi masuk → MSG-IN (isi pesan tidak dilog) ════
    {
      const pool = require(REPO + '/src/wa/pool')
      const jid = `e2elgcov${Math.random().toString(36).slice(2, 8)}@s.whatsapp.net`
      const isi = `rahasia-body ${mkTag('msgin')}`
      const out = await pool.processIncomingMessage(T, mkWaMsg(jid, isi), { slot: 0 })
      check('K8-a processIncomingMessage sukses return {chat,message}', !!out?.chat && !!out?.message, `chatId=${out?.chat?.id}`)
      const chatId = out?.chat?.id
      const n = await waitForCount({ level: 'info', message: { contains: `MSG-IN chat=${chatId} tenant=${T}` } }, 1)
      check(`K8-b MSG-IN info row muncul (got ${n})`, n >= 1)
      const row = await prisma.systemLog.findFirst({ where: { level: 'info', message: { contains: `MSG-IN chat=${chatId} tenant=${T}` } }, orderBy: { id: 'desc' } })
      check('K8-c MSG-IN module=chat + tenant benar', row?.module === 'chat' && row?.tenantId === T, `module=${row?.module} tenant=${row?.tenantId}`)
      check('K8-d meta: fromMe false + chatId', !!row?.metaJson && row.metaJson.includes('"fromMe":false') && row.metaJson.includes(`"chatId":${chatId}`), (row?.metaJson || '').slice(0, 120))
      check('K8-e meta waJid tersimpan TANPA raw penuh (redaksi saat ingest)', !!row?.metaJson && !row.metaJson.includes(jid) && /(\*\*\*|"waJid")/.test(row.metaJson), (row?.metaJson || '').slice(0, 140))
      check('K8-f PRIVACY: isi pesan TIDAK ada di message/meta/stack', !(row?.message || '').includes('rahasia-body') && !(row?.metaJson || '').includes('rahasia-body') && !row?.stack)
      // Dedup 10s: pesan kedua JID sama <10s → row MSG-IN TIDAK bertambah
      await pool.processIncomingMessage(T, mkWaMsg(jid, isi + ' kedua'), { slot: 0 })
      await sleep(700)
      const n2 = await countLogs({ level: 'info', message: { contains: `MSG-IN chat=${chatId} tenant=${T}` } })
      check(`K8-g dedup 10s MSG-IN: tetap 1 row (got ${n2})`, n2 === 1)
      // QUEUE-EMIT §B2 — dipanggil natural oleh pesan masuk (queue update)
      const q = await waitForCount({ level: 'info', message: { contains: `QUEUE-EMIT tenant=${T}` } }, 1)
      check(`K8-h QUEUE-EMIT info row muncul (emisi antrean terlog, got ${q})`, q >= 1)
      const qrow = await prisma.systemLog.findFirst({ where: { level: 'info', message: { contains: `QUEUE-EMIT tenant=${T}` } }, orderBy: { id: 'desc' } })
      check('K8-i QUEUE-EMIT module=chat + format count', qrow?.module === 'chat' && /^QUEUE-EMIT tenant=\d+ count=\d+$/.test(qrow?.message || ''), (qrow?.message || '').slice(0, 80))
      globalThis.__e2e_k8ChatId = chatId
    }

    // ════ Kasus 9 — Claim chat → row module 'chat' (+ retag LIST-DEBUG/Batch/Snooze) ════
    {
      const pool = require(REPO + '/src/wa/pool')
      // Prime kandidat antrean + paksa FIFO paling depan (queuedAt tua) — deterministik:
      const pr = await pool.processIncomingMessage(T, mkWaMsg(`e2elgcov${Math.random().toString(36).slice(2, 8)}@s.whatsapp.net`, 'pesan kandidat queue'), { slot: 0 })
      const primeChatId = pr.chat.id
      await prisma.chat.update({ where: { id: primeChatId }, data: { queuedAt: new Date('2000-01-01T00:00:00.000Z'), assignedToId: null, status: 'open' } })
      // FIFO loop: chat lama lain (nulls-first / queuedAt lebih tua) diambil lebih dulu —
      // loop sampai kandidat UTAMA yang ter-claim (maks 15 iterasi, cadangan aman).
      let claimed = null; let attempts = 0
      for (let i = 0; i < 15; i++) {
        const r = await api('POST', '/api/chats/take-next', {}, adminTok)
        attempts++
        if (r.status !== 200) break
        claimed = r.data?.chat?.id
        if (claimed === primeChatId) break
      }
      check('K9-a claim sukses (FIFO loop, kandidat utama ter-claim)', claimed === primeChatId, `claimed=${claimed} target=${primeChatId} attempts=${attempts}`)
      await waitForCount({ level: 'info', message: { contains: `[Queue] ${adminUser.username}` } }, 1)
      // Diskriminator row STRUCTURED vs row passthrough console: row retag selalu
      // ber-suffix " tenant=N" (row passthrough console.log = teks persis lama).
      const row = await prisma.systemLog.findFirst({ where: { level: 'info', message: { contains: '[Queue]' }, AND: [{ message: { contains: ` tenant=${T}` } }, { metaJson: { contains: '"username":"' } }] }, orderBy: { id: 'desc' } })
      check(`K9-b [Queue] retag: module='chat' (BUKAN 'other', got ${row?.module})`, row?.module === 'chat')
      check(`K9-c [Queue] tenant=${T} eksplisit`, row?.tenantId === T && (row?.message || '').includes(`tenant=${T}`), `${row?.tenantId}`)
      // LIST-DEBUG retag: GET list chats
      const lr = await api('GET', '/api/chats', undefined, adminTok)
      check(`K9-d GET /api/chats → 200 (got ${lr.status})`, lr.status === 200)
      await waitForCount({ level: 'info', message: { contains: '[LIST-DEBUG]' } }, 1)
      const listRow = await prisma.systemLog.findFirst({ where: { level: 'info', message: { contains: '[LIST-DEBUG] ' }, message: { contains: ` tenant=${T}` } }, orderBy: { id: 'desc' } })
      check(`K9-e [LIST-DEBUG] retag module='chat' + tenant (got ${listRow?.module})`, listRow?.module === 'chat' && listRow?.tenantId === T && (listRow?.message || '').includes(`tenant=${T}`))
      // BatchResolve retag: resolve chat yang barusan di-claim
      const br = await api('POST', '/api/chats/batch-resolve', { chatIds: [primeChatId] }, adminTok)
      check(`K9-f batch-resolve → 200 resolved=1 (got ${br.status} resolved=${br.data?.resolved?.length})`, br.status === 200 && br.data?.resolved?.length === 1)
      await waitForCount({ level: 'info', message: { contains: '[BatchResolve]' } }, 1)
      const brRow = await prisma.systemLog.findFirst({ where: { level: 'info', message: { contains: '[BatchResolve] ' }, message: { contains: ` tenant=${T}` } }, orderBy: { id: 'desc' } })
      check(`K9-g [BatchResolve] retag module='chat' (got ${brRow?.module})`, brRow?.module === 'chat' && brRow?.tenantId === T)
      // BatchRead retag: chat kedua via MSG-IN lalu batch-read
      const out2 = await pool.processIncomingMessage(T, mkWaMsg(`e2elgcov${Math.random().toString(36).slice(2, 8)}@s.whatsapp.net`, 'pesan kedua utk batch-read'), { slot: 0 })
      const chat2Id = out2.chat.id
      const brd = await api('POST', '/api/chats/batch-read', { chatIds: [chat2Id] }, adminTok)
      check(`K9-h batch-read → 200 marked=1 (got ${brd.status} marked=${brd.data?.marked?.length})`, brd.status === 200 && brd.data?.marked?.length === 1)
      await waitForCount({ level: 'info', message: { contains: '[BatchRead]' } }, 1)
      const brdRow = await prisma.systemLog.findFirst({ where: { level: 'info', message: { contains: '[BatchRead] ' }, message: { contains: ` tenant=${T}` } }, orderBy: { id: 'desc' } })
      check(`K9-i [BatchRead] retag module='chat' (got ${brdRow?.module})`, brdRow?.module === 'chat' && brdRow?.tenantId === T)
      // [Snooze] retag
      const sn = await api('POST', `/api/chats/${chat2Id}/snooze`, { until: new Date(Date.now() + 3600e3).toISOString() }, adminTok)
      check(`K9-j snooze → 200 (got ${sn.status})`, sn.status === 200)
      await waitForCount({ level: 'info', message: { contains: '[Snooze]' } }, 1)
      const snRow = await prisma.systemLog.findFirst({ where: { level: 'info', message: { contains: '[Snooze] ' }, message: { contains: ` tenant=${T}` } }, orderBy: { id: 'desc' } })
      check(`K9-k [Snooze] retag module='chat' + tenant (got ${snRow?.module})`, snRow?.module === 'chat' && snRow?.tenantId === T && (snRow?.message || '').includes(`tenant=${T}`))
    }

    // ════ Kasus 10 — Redaksi: nomor/email mentah tidak boleh ada di row tenant ════
    {
      const piiNumber = '628111222333'
      const r = await api('POST', '/api/tags', { name: piiNumber }, adminTok)
      check(`K10-a POST tag bernama nomor mentah → 201/409 (got ${r.status})`, r.status === 201 || r.status === 409)
      await sleep(900)
      const row = await prisma.systemLog.findFirst({ where: { message: { contains: 'TAG-SAVE name="62***2333' } }, orderBy: { id: 'desc' } })
      check('K10-b nomor ter-redaksi 62***2333 di TAG-SAVE row', !!row && row.tenantId === T, (row?.message || '').slice(0, 80))
      // Sweep SAAT INGEST: semua row TAG-SAVE baru tenant ini → 0 nomor mentah
      const sweepRaw = await countLogs({ tenantId: T, message: { contains: piiNumber } })
      check(`K10-c 0 row tenant dgn nomor mentah di message (got ${sweepRaw})`, sweepRaw === 0)
      const sweepMeta = await countLogs({ tenantId: T, metaJson: { contains: piiNumber } })
      check(`K10-d 0 row tenant dgn nomor mentah di metaJson (got ${sweepMeta})`, sweepMeta === 0)
    }

    // ════ Kasus 11 — Flood: 500 logInfo → ≤300 masuk + warn suppress + server OK ════
    {
      systemLog.resetInProcessStateForTest()
      const stamp = mkTag('flood')
      for (let i = 0; i < 500; i++) void systemLog.logInfo(`${stamp} pesan ke-${i}`, { module: 'other' })
      await sleep(4500) // window 3s → warn "suppressed" ter-flush via timer
      const rows = await countLogs({ message: { contains: stamp } })
      check(`K11-a hanya ≤305 info masuk dari 500 spam (got ${rows})`, rows <= 305 && rows >= 1)
      const warns = await prisma.systemLog.findMany({ where: { level: 'warn', message: { contains: 'flood suppressed' } }, orderBy: { id: 'desc' } })
      check(`K11-b warn "info flood suppressed N" dicatat (got ${warns.length})`, warns.length >= 1)
      const h = await api('GET', '/api/health')
      check('K11-c server tetap 200 OK setelah flood', h.status === 200)
      systemLog.resetInProcessStateForTest()
    }

    // ════ Kasus 12 — Boot regresi: instance kedua, port + copy DB sendiri ════
    {
      const copy2 = '/tmp/saas-v3-e2e-logcov-boot.db'
      try { fs.unlinkSync(copy2) } catch {}
      for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(copy2 + ext) } catch {} }
      fs.copyFileSync(REPO + '/prisma/data/saas-v3.db', copy2)
      const env = {
        ...process.env,
        PORT: '5098',
        DATABASE_URL: 'file:' + copy2,
        WA_DISABLED: '1',
        APP_VERSION: 'v4.6.4-logcov-e2e',
        SYSTEMLOG_RETENTION_DAYS: '30',
      }
      execSync('npx prisma db push --skip-generate', { cwd: REPO, env, stdio: 'ignore', timeout: 120000 })
      const bootStartAt = new Date()
      const child = spawn('node', [REPO + '/src/server.js'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.on('data', (d) => { out += d })
      child.stderr.on('data', (d) => { out += d })
      let healthy = false
      for (let i = 0; i < 40; i++) {
        await sleep(500)
        try {
          const r = await fetch('http://127.0.0.1:5098/api/health')
          if (r.status === 200) { healthy = true; break }
        } catch {}
      }
      check('K12-a instance kedua boot + /api/health 200 (port 5098)', healthy)
      await sleep(1500)
      check('K12-b "[Server] WA CS Hub running on port 5098" muncul', out.includes('[Server] WA CS Hub running on port 5098'))
      check('K12-c capture layer aktif tepat 1 kali (no double-install)', (out.match(/\[SystemLog\] capture aktif/g) || []).length === 1)
      check('K12-d tidak ada "Startup error"', !out.includes('Startup error'))
      const prisma2 = new PrismaClient({ datasourceUrl: 'file:' + copy2, log: ['error'] })
      const selfRows = await prisma2.systemLog.count({ where: { message: { contains: '[SystemLog]' }, ts: { gte: bootStartAt } } })
      check(`K12-e no self-log-storm pasca boot (row [SystemLog] sejak boot: got ${selfRows})`, selfRows <= 3)
      for (let i = 0; i < 5; i++) { try { await fetch('http://127.0.0.1:5098/api/health') } catch {} }
      await sleep(800)
      const healthWarns = await prisma2.systemLog.count({ where: { level: 'warn', message: { contains: 'health' }, ts: { gte: bootStartAt } } })
      check(`K12-f health hits TIDAK menulis row log (got ${healthWarns})`, healthWarns === 0)
      await prisma2.$disconnect()
      child.kill('SIGTERM')
      await sleep(500)
      try { child.kill('SIGKILL') } catch {}
    }

    // ── Sanity global: tidak ada self-log-storm & run hijau ──
    const selfRowsMain = await countLogs({ message: { contains: '[SystemLog]' } })
    check(`Z-a no self-log-storm di DB copy utama (got ${selfRowsMain})`, selfRowsMain <= 5)
    const dur = ((Date.now() - t0.getTime()) / 1000).toFixed(1)
    console.log(`\n=== e2e-log-coverage: ${pass} PASS / ${fails.length} FAIL (${dur}s) ===`)
    if (fails.length) { console.log('FAILED:', fails.join(' | ')); process.exitCode = 1 }
  } catch (e) {
    console.error('HARNESS ERROR:', e)
    process.exitCode = 1
  } finally {
    try { await prisma.$disconnect() } catch {}
  }
  process.exit(process.exitCode || 0)
}

main()