#!/usr/bin/env node
/**
 * E2E — v4.6.6 Admin Clear Queue (spec docs/spec-v4.6.6-clear-queue.md §B)
 * Jalur copy-DB :5099 (WA_DISABLED=1) — produksi (5047) TIDAK tersentuh.
 * Pola: scripts/e2e-log-coverage.cjs (copy DB + reset superadmin + login API + self-boot).
 *
 * Jalur boot — self-contained (default; server child di-kill di akhir run):
 *   node scripts/e2e-clearqueue.cjs
 * (Script sendiri yang: copy prisma/data/saas-v3.db → /tmp, prisma db push
 *   --skip-generate ke COPY, spawn src/server.js dgn PORT=5099 + WA_DISABLED=1.)
 *
 * Manual boot (mode logcov, alternatif): dari repo root
 *   cp prisma/data/saas-v3.db /tmp/saas-v3-e2e-clearqueue.db
 *   DATABASE_URL=file:/tmp/saas-v3-e2e-clearqueue.db npx prisma db push --skip-generate
 *   PORT=5099 DATABASE_URL=file:/tmp/saas-v3-e2e-clearqueue.db WA_DISABLED=1 node src/server.js &
 *   node scripts/e2e-clearqueue.cjs   (server sudah jalan → script pakai instance itu)
 *
 * 11 kasus (§B):
 *   1  Setup: tenant uji + admin + CS + 30 chat antrean (3 awaiting, 3 snoozed, grup, exclude-tag)
 *   2  POST clear-queue TANPA confirm → 400
 *   3  POST dengan confirm (role cs) → 403
 *   4  POST confirm (admin) → cleared=30; semua resolved + assignedToId=admin + resolvedAt
 *  5  snoozed → snoozedUntil null; awaiting (limbo §4.1) TIDAK tersentuh —
 *     queueWhere bukan miliknya (invariant: set clear = set banner '565'),
 *   6  Queue count pasca = 0
 *   7  CSAT: 0 survey baru (dgn CSAT tenant DIPAKSA ENABLED — kontras dgn K11)
 *   8  Chat grup (@g.us) & kontak excludeFromQueue TIDAK ter-resolved (queueWhere dihormati)
 *   9  SystemLog: row [ClearQueue] module=chat tenant benar; redaksi OK (0 nomor mentah)
 *  10  Cap: 2100 chat → cleared=2000 remaining=100; klik kedua → cleared=100 remaining=0
 *  11  Regresi: take-next + single-resolve + batch-resolve tetap jalan normal
 *      (CSAT hook di jalur manual TETAP hidup — kontras dgn clear-queue yang 0 survey)
 */
const REPO = '/home/kanakxxx/.openclaw/workspace/wa-cs-hub-saas-v3'
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:5099'
// KRITIS (lesson v4.1.x / v470): .env berisi DATABASE_URL PROD (ABSOLUTE path) →
// DATABASE_URL dipaksa ke copy SETELAH dotenv — seluruh proses satu DB copy (service
// gak pernah menembak PROD).
const COPY_DB = process.env.E2E_COPY_DB || 'file:/tmp/saas-v3-e2e-clearqueue.db'
const PORT = '5099'
const fs = require('fs')
const { execSync, spawn } = require('child_process')
require(REPO + '/node_modules/dotenv').config({ path: REPO + '/.env' })
process.env.DATABASE_URL = COPY_DB
process.env.WA_DISABLED = '1'
process.env.APP_VERSION = 'v4.6.6-clearqueue-e2e'

const { PrismaClient } = require(REPO + '/node_modules/@prisma/client')
const prisma = new PrismaClient({ datasourceUrl: COPY_DB, log: ['error'] })
const bcrypt = require(REPO + '/node_modules/bcryptjs')

const fails = []
let pass = 0
let serverChild = null // boot sendiri (bila 5099 belum hidup); di-kill di finally
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
function mkTag(prefix) {
  let s = ''
  for (let i = 0; i < 10; i++) s += ABC[Math.floor(Math.random() * ABC.length)]
  return `${prefix}-${s}`
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function countLogs(where) { return prisma.systemLog.count({ where }) }
// Row log muncul async (prisma write) → tunggu maks ~8s (pola logcov)
async function waitForCount(where, min, timeoutMs = 8000) {
  const t0 = Date.now()
  for (;;) {
    const n = await countLogs(where)
    if (n >= min) return n
    if (Date.now() - t0 > timeoutMs) return n
    await sleep(300)
  }
}
// Poll CSAT (row survey dibuat fire-and-forget setelah resolve manual)
async function waitForCsat(where, min, timeoutMs = 8000) {
  const t0 = Date.now()
  for (;;) {
    const n = await prisma.csatSurvey.count({ where })
    if (n >= min) return n
    if (Date.now() - t0 > timeoutMs) return n
    await sleep(300)
  }
}
async function qCount(token, tenantQuery) {
  return api('GET', '/api/chats/queue-count' + (tenantQuery ? `?tenant=${tenantQuery}` : ''), undefined, token)
}
// Sintetis 1 chat antrean (status open + unassigned + pesan aktif) — masuk queueWhere
async function mkQueueChat(tenant, jidSuffix, opts = {}) {
  const jid = jidSuffix || `e2ecq${mkTag('j')}@s.whatsapp.net`
  return prisma.chat.create({
    data: {
      tenantId: tenant.id,
      waJid: jid,
      contactPhone: '628112233' + String(Math.floor(Math.random() * 900 + 100)),
      contactName: 'E2E ClearQueue',
      status: 'open',
      assignedToId: null,
      lastMessageAt: opts.lastMessageAt || new Date(),
      csMessagesSent: opts.csMessagesSent ?? 1,
      ...(opts.menuState ? { menuState: opts.menuState, menuRequestedAt: new Date() } : {}),
      ...(opts.snoozedUntil ? { snoozedUntil: opts.snoozedUntil, snoozedBy: opts.snoozedBy } : {}),
      messages: { create: { tenantId: tenant.id, direction: 'in', content: `pesan uji ${mkTag('m')}`, senderName: 'Pengirim Uji', timestamp: new Date() } },
    },
  })
}

async function bootServerIfNeeded() {
  try {
    const r = await fetch(BASE + '/api/health')
    if (r.status === 200) { console.log('boot: server 5099 sudah hidup → pakai instance existing'); return }
  } catch {}
  // Copy DB FRESH (hapus sisa + wal/shm) — DB copy saja, produksi tidak disentuh
  const copyPath = COPY_DB.replace('file:', '')
  for (const p of [copyPath, copyPath + '-wal', copyPath + '-shm']) { try { fs.unlinkSync(p) } catch {} }
  fs.copyFileSync(REPO + '/prisma/data/saas-v3.db', copyPath)
  const env = { ...process.env, PORT, DATABASE_URL: COPY_DB, WA_DISABLED: '1', APP_VERSION: 'v4.6.6-clearqueue-e2e' }
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
  check('S0-a server test boot di 5099 (copy DB, WA_DISABLED=1)', healthy, healthy ? '' : out.slice(-400))
}

// ── Body: 11 kasus sesuai spec ──
async function main() {
  const t0 = new Date()
  try {
    await bootServerIfNeeded()
    if (fails.length) { // boot gagal → jangan lancang; dump output server utk diagnosa
      console.error('BOOT GAGAL — output server:\n' + (serverChild?.__out ? serverChild.__out().slice(-2000) : 'n/a'))
      return
    }

    // ── S0 — setup: reset superadmin (COPY saja) + tenant uji + admin/cs + 30 chat ──
    const sa0 = await prisma.user.findFirst({ where: { role: 'super_admin' } })
    check('S0-b super_admin row ada di copy DB', !!sa0)
    const saPass = process.env.SUPERADMIN_PASSWORD || 'superadmin123'
    await prisma.user.update({ where: { id: sa0.id }, data: { passwordHash: await bcrypt.hash(saPass, 10), status: 'active' } })
    const saLogin = await api('POST', '/api/auth/login', { username: sa0.username, password: saPass })
    check(`S0-c superadmin login status=${saLogin.status}`, saLogin.status === 200 && !!saLogin.data?.token)
    const saTok = saLogin.data?.token

    const tName = 'e2e-clearqueue-' + mkTag('t')
    const tenant = await prisma.tenant.create({ data: { name: tName, status: 'active' } })
    const T = tenant.id
    const adminUser = await prisma.user.create({ data: { username: `adm_cq_${mkTag('u')}`, passwordHash: await bcrypt.hash('adminpass123', 10), role: 'admin', tenantId: T, status: 'active' } })
    const csUser = await prisma.user.create({ data: { username: `cs_cq_${mkTag('u')}`, passwordHash: await bcrypt.hash('cspass123', 10), role: 'cs', tenantId: T, status: 'active' } })
    const adminLogin = await api('POST', '/api/auth/login', { username: adminUser.username, password: 'adminpass123' })
    check(`S0-d admin tenant login status=${adminLogin.status}`, adminLogin.status === 200 && !!adminLogin.data?.token)
    const adminTok = adminLogin.data?.token
    const csLogin = await api('POST', '/api/auth/login', { username: csUser.username, password: 'cspass123' })
    check(`S0-e cs login status=${csLogin.status}`, csLogin.status === 200 && !!csLogin.data?.token)
    const csTok = csLogin.data?.token

    // 30 chat antrean: 27 polos + 3 snoozed (1 polos dgn csMessagesSent=2)
    // CATATAN INVARIANT §4.1: chat menuState='awaiting' (limbo Menu Gateway) TIDAK
    // masuk antrean (queueWhere mengecualikannya) — bukan milik clear-queue. 3 chat
    // awaiting dibuat sbg fixture invarian: HARUS tetap open/unassigned/awaiting.
    // csMessagesSent: 1 chat polos pertama = 2 (utk cek messagesBeforeResolve), sisanya 1
    const plainChats = []
    for (let i = 0; i < 27; i++) {
      plainChats.push(await mkQueueChat(tenant, null, { lastMessageAt: new Date(Date.now() - (i + 1) * 1000), csMessagesSent: i === 0 ? 2 : 1 }))
    }
    const snoozedChats = []
    for (let i = 0; i < 3; i++) snoozedChats.push(await mkQueueChat(tenant, null, { snoozedUntil: new Date(Date.now() + 3600e3), snoozedBy: adminUser.id }))
    // Fixture invarian (di luar set antrean): tidak boleh tersentuh clear-queue
    const awaitingChats = []
    for (let i = 0; i < 3; i++) awaitingChats.push(await mkQueueChat(tenant, null, { menuState: 'awaiting' }))
    const allQueueChats = [...plainChats, ...snoozedChats]
    // K8 fixture: 1 grup + 1 chat kontak ber-tag excludeFromQueue (TIDAK boleh ke-clear)
    const groupChat = await mkQueueChat(tenant, `e2ecq${mkTag('g')}@g.us`)
    const exclChat = await mkQueueChat(tenant, null)
    const exclTag = await prisma.tag.create({ data: { tenantId: T, name: 'cqexcl-' + mkTag('x'), excludeFromQueue: true, createdBy: adminUser.id } })
    const exclContact = await prisma.contact.create({ data: { tenantId: T, chatId: exclChat.id, phone: exclChat.contactPhone, name: 'E2E Excluded' } })
    await prisma.contactTag.create({ data: { tenantId: T, contactId: exclContact.id, tagId: exclTag.id, source: 'manual' } })
    const q0 = await qCount(adminTok)
    check(`S0-f 30 chat antrean terbentuk (queue-count=${q0.data?.count})`, q0.status === 200 && q0.data?.count === 30, `got=${q0.data?.count}`)
    // CSAT tenant DIPAKSA ENABLED — jika clear-queue keliru memanggil CSAT hook,
    // survey AKAN terbentuk → zero-check pun bermakna (kontras K11: resolve manual buat survey)
    await prisma.csatConfig.upsert({ where: { tenantId: T }, update: { enabled: true }, create: { tenantId: T, enabled: true, updatedById: adminUser.id } })
    const csatBefore = await prisma.csatSurvey.count({ where: { tenantId: T } })
    check('S0-g CSAT tenant paksa ENABLED (guard zero-check) + 0 survey sebelum aksi', csatBefore === 0, `got=${csatBefore}`)

    // ════ Kasus 2 — POST TANPA confirm → 400 ════
    {
      const r1 = await api('POST', '/api/chats/clear-queue', {}, adminTok)
      check(`K2-a POST tanpa confirm → 400 (got ${r1.status})`, r1.status === 400, JSON.stringify(r1.data || {}).slice(0, 100))
      const r2 = await api('POST', '/api/chats/clear-queue', { confirm: false }, adminTok)
      check(`K2-b POST confirm:false → 400 (got ${r2.status})`, r2.status === 400)
      const r3 = await api('POST', '/api/chats/clear-queue', { confirm: 'true' }, adminTok)
      check(`K2-c POST confirm:"true" (string) → 400 (got ${r3.status})`, r3.status === 400)
      const q = await qCount(adminTok)
      check('K2-d antrean tidak berubah setelah 400', q.data?.count === 30, `got=${q.data?.count}`)
    }

    // ════ Kasus 3 — POST confirm (role cs) → 403 ════
    {
      const r = await api('POST', '/api/chats/clear-queue', { confirm: true }, csTok)
      check(`K3-a POST clear-queue dgn role cs → 403 (got ${r.status})`, r.status === 403, JSON.stringify(r.data || {}).slice(0, 100))
      const q = await qCount(adminTok)
      check('K3-b antrean tidak berubah setelah 403 (cs)', q.data?.count === 30, `got=${q.data?.count}`)
    }

    // ════ Kasus 4 — POST confirm (admin) → cleared=30 ════
    let clearedIds = []
    {
      const r = await api('POST', '/api/chats/clear-queue', { confirm: true }, adminTok)
      check(`K4-a POST confirm (admin) → 200 (got ${r.status})`, r.status === 200, JSON.stringify(r.data || {}).slice(0, 140))
      check(`K4-b cleared=30 skipped=[] remaining=0 (got ${r.data?.cleared}/${JSON.stringify(r.data?.skipped)}/${r.data?.remaining})`, r.data?.cleared === 30 && Array.isArray(r.data?.skipped) && r.data.skipped.length === 0 && r.data?.remaining === 0)

      const resolved = await prisma.chat.findMany({ where: { tenantId: T, status: 'resolved' } })
      check(`K4-c 30 chat status=resolved (got ${resolved.length})`, resolved.length === 30)
      check('K4-d semua assignedToId=admin.id (yang klik tombol)', resolved.every((c) => c.assignedToId === adminUser.id), `nonmatch=${resolved.filter((c) => c.assignedToId !== adminUser.id).length}`)
      check('K4-e semua resolvedById=admin.id + resolvedAt terisi', resolved.every((c) => c.resolvedById === adminUser.id && !!c.resolvedAt))
      const special = resolved.find((c) => c.id === plainChats[0].id)
      check('K4-f messagesBeforeResolve = csMessagesSent (chat khusus = 2)', special?.messagesBeforeResolve === 2, `got=${special?.messagesBeforeResolve}`)
      check('K4-g messagesBeforeResolve chat lain = 1', resolved.filter((c) => c.id !== plainChats[0].id).every((c) => c.messagesBeforeResolve === 1))
      clearedIds = resolved.map((c) => c.id)
      // K7 — 0 CSAT baru setelah clear
      const csatAfter = await prisma.csatSurvey.count({ where: { tenantId: T } })
      check(`K7-a CSAT: 0 survey baru dibuat (before=0 after got ${csatAfter})`, csatAfter === 0)
      const csatCleared = await prisma.csatSurvey.count({ where: { tenantId: T, chatId: { in: clearedIds } } })
      check('K7-b 0 survey utk chat yang di-clear', csatCleared === 0)
    }

    // ════ Kasus 5 — snooze dibersihkan; limbo awaiting TIDAK tersentuh (invariant §4.1) ════
    {
      const after = await prisma.chat.findMany({ where: { tenantId: T, status: 'resolved' } })
      // Fixture invarian: 3 chat awaiting (limbo, di luar antrean) HARUS tetap utuh
      const awaitingAfter = await prisma.chat.findMany({ where: { tenantId: T, id: { in: awaitingChats.map((a) => a.id) } } })
      check(`K5-a 3 chat awaiting TIDAK tersentuh: masih open+unassigned+awaiting (got ${awaitingAfter.filter((c) => c.status === 'open' && c.assignedToId == null && c.menuState === 'awaiting').length}/3)`, awaitingAfter.length === 3 && awaitingAfter.every((c) => c.status === 'open' && c.assignedToId == null && c.menuState === 'awaiting' && c.resolvedAt == null))
      check('K5-b menuRequestedAt fixture awaiting tetap terisi (tidak dibersihkan)', awaitingAfter.every((c) => c.menuRequestedAt != null))
      const snoozedAfter = after.filter((c) => snoozedChats.some((s) => s.id === c.id))
      check(`K5-c 3 chat snoozed → snoozedUntil null (got ${snoozedAfter.filter((c) => c.snoozedUntil == null).length}/3)`, snoozedAfter.length === 3 && snoozedAfter.every((c) => c.snoozedUntil == null))
      check('K5-d snoozedBy dibersihkan (null)', snoozedAfter.every((c) => c.snoozedBy == null))
      check('K5-e chat polos tidak berubah menuState (tetap null)', after.filter((c) => plainChats.some((p) => p.id === c.id)).every((c) => c.menuState == null))
    }

    // ════ Kasus 6 — Queue count pasca = 0 ════
    {
      const q = await qCount(adminTok)
      check(`K6-a queue-count pasca clear = 0 (got ${q.data?.count})`, q.status === 200 && q.data?.count === 0)
      // Paritas DB via SATU SUMBER KEBENARAN yang sama (queueWhere) — 5 chat
      // open+unassigned yang tersisa adalah fixture di-luar-antrean (grup,
      // exclude-tag, 3 awaiting limbo §4.1): K8 membuktikannya utuh.
      const qhelper = require(REPO + '/src/socket/queue')
      const countQ = await prisma.chat.count({ where: qhelper.queueWhere(T) })
      check(`K6-b DB paritas via queueWhere: 0 chat antrean tersisa tenant uji (got ${countQ})`, countQ === 0)
    }

    // ════ Kasus 8 — grup & excludeFromQueue TIDAK ter-resolved (queueWhere dihormati) ════
    {
      const g = await prisma.chat.findUnique({ where: { tenantId_numberSlot_waJid: { tenantId: T, numberSlot: 0, waJid: groupChat.waJid } } })
      check(`K8-a chat grup @g.us TIDAK ter-resolved (status=${g?.status})`, g?.status === 'open' && g?.assignedToId == null)
      const e = await prisma.chat.findUnique({ where: { id: exclChat.id } })
      check(`K8-b kontak excludeFromQueue TIDAK ter-resolved (status=${e?.status})`, e?.status === 'open' && e?.assignedToId == null)
      check('K8-c keduanya tidak masuk daftar cleared', !clearedIds.includes(groupChat.id) && !clearedIds.includes(exclChat.id))
    }

    // ════ Kasus 9 — SystemLog breadcrumb [ClearQueue] + redaksi ════
    // POLA LOGCOV K9: per breadcrumb ada 2 row by-design v4.6.4/v4.6.5 — row
    // STRUCTURED (sysLog.logInfo: module/tenant/metaJson) + row PASSTHROUGH
    // console capture (teks persis, tanpa meta). Discriminator row structured:
    // metaJson berisi '{"cleared":'.
    {
      const n = await waitForCount({ level: 'info', message: { contains: '[ClearQueue]' }, metaJson: { contains: '"cleared":' } }, 1)
      check(`K9-a row [ClearQueue] structured muncul (got ${n})`, n >= 1)
      const row = await prisma.systemLog.findFirst({ where: { message: { contains: '[ClearQueue]' }, AND: [{ message: { contains: ` tenant=${T}` } }, { metaJson: { contains: '"cleared":' } }] }, orderBy: { id: 'desc' } })
      check(`K9-b module='chat' (got ${row?.module}) + level info`, row?.module === 'chat' && row?.level === 'info')
      check(`K9-c tenantId=${T} di row`, row?.tenantId === T, `got=${row?.tenantId}`)
      check('K9-d format user/cleared/remaining benar', /\[ClearQueue\] user=\S+ cleared=30 tenant=\d+ remaining=0$/.test(row?.message || ''), (row?.message || '').slice(0, 90))
      check('K9-e metaJson cleared=30 remaining=0 skipped=0', !!row?.metaJson && row.metaJson.includes('"cleared":30') && row.metaJson.includes('"remaining":0') && row.metaJson.includes('"skipped":0'), (row?.metaJson || '').slice(0, 100))
      // Row passthrough console capture juga tercatat (by-design: stdout behavior tidak berubah)
      const passRow = await prisma.systemLog.findFirst({ where: { message: { contains: '[ClearQueue]' }, AND: [{ message: { contains: ` tenant=${T}` } }, { metaJson: null }] }, orderBy: { id: 'desc' } })
      check('K9-g row passthrough console (capture v4.6.4) juga ada (by design)', !!passRow, (passRow?.message || '').slice(0, 80))
      // Redaksi: TIDAK ada nomor pelanggan fixture mentah di message/meta
      const phone = allQueueChats[0]?.contactPhone || ''
      check('K9-f redaksi OK: 0 nomor pelanggan mentah di row', !(row?.message || '').includes(phone) && !(row?.metaJson || '').includes(phone), `phone=${phone ? phone.slice(0, 5) + '***' : 'n/a'}`)
    }

    // ════ Kasus 10 — Cap 2100 → 2000 + remaining 100; klik kedua → 100 ════
    {
      const t2 = await prisma.tenant.create({ data: { name: 'e2e-clearqueue-cap-' + mkTag('t'), status: 'active' } })
      const t2Admin = await prisma.user.create({ data: { username: `adm_cap_${mkTag('u')}`, passwordHash: await bcrypt.hash('adminpass123', 10), role: 'admin', tenantId: t2.id, status: 'active' } })
      const t2Login = await api('POST', '/api/auth/login', { username: t2Admin.username, password: 'adminpass123' })
      const t2Tok = t2Login.data?.token
      // Bulk insert 2100 chat + pesan (createMany — cepat; pesan aktif dibutuhkan queueWhere)
      const base = Date.now() - 2100 * 1000
      const chatsData = []
      for (let i = 0; i < 2100; i++) {
        chatsData.push({
          tenantId: t2.id,
          waJid: `e2ecap${i}@s.whatsapp.net`,
          contactPhone: '628990000' + String(1000 + i),
          contactName: 'E2E Cap',
          status: 'open',
          numberSlot: 0,
          lastMessageAt: new Date(base + i * 1000), // i besar = lebih baru
          csMessagesSent: 1,
        })
      }
      await prisma.chat.createMany({ data: chatsData })
      const created = await prisma.chat.findMany({ where: { tenantId: t2.id }, select: { id: true, lastMessageAt: true } })
      await prisma.message.createMany({ data: created.map((c) => ({ tenantId: t2.id, chatId: c.id, direction: 'in', content: 'pesan cap', senderName: 'Pengirim', timestamp: new Date() })) })
      const q = await qCount(t2Tok)
      check(`K10-a 2100 chat terbentuk + queue-count=2100 (got ${q.data?.count})`, q.status === 200 && q.data?.count === 2100, `got=${q.data?.count}`)
      const csatT2Before = await prisma.csatSurvey.count({ where: { tenantId: t2.id } })

      const r1 = await api('POST', '/api/chats/clear-queue', { confirm: true }, t2Tok)
      check(`K10-b clear #1 → 200 (got ${r1.status})`, r1.status === 200)
      check(`K10-c cleared=2000 remaining=100 (got ${r1.data?.cleared}/${r1.data?.remaining})`, r1.data?.cleared === 2000 && r1.data?.remaining === 100)
      // TERBARU dulu: 100 tersisa = yang paling tua (lastMessageAt terkecil)
      const remainingRows = await prisma.chat.findMany({ where: { tenantId: t2.id, status: 'open' }, select: { id: true } })
      const oldest100 = [...created].sort((a, b) => new Date(a.lastMessageAt) - new Date(b.lastMessageAt)).slice(0, 100).map((c) => c.id)
      const matchCount = remainingRows.filter((c) => oldest100.includes(c.id)).length
      check(`K10-d 100 tersisa = terlama (open got ${remainingRows.length}, match ${matchCount}/100)`, remainingRows.length === 100 && matchCount === 100)
      // Gate: superadmin impersonate (?tenant=) juga diizinkan requireAdmin (spec §A1)
      const rImp = await api('POST', '/api/chats/clear-queue?tenant=' + t2.id, { confirm: true }, saTok)
      check(`K10-e clear #2 via superadmin impersonate → cleared=100 remaining=0 (got ${rImp.data?.cleared}/${rImp.data?.remaining})`, rImp.status === 200 && rImp.data?.cleared === 100 && rImp.data?.remaining === 0)
      const qAfter = await qCount(t2Tok)
      check(`K10-f queue-count T2 pasca = 0 (got ${qAfter.data?.count})`, qAfter.data?.count === 0)
      const csatT2After = await prisma.csatSurvey.count({ where: { tenantId: t2.id } })
      check(`K10-g CSAT T2 tetap 0 (before got ${csatT2Before}, after ${csatT2After})`, csatT2Before === 0 && csatT2After === 0)
      const capRow = await waitForCount({ level: 'info', message: { contains: '[ClearQueue]' }, AND: [{ message: { contains: ` tenant=${t2.id}` } }, { metaJson: { contains: '"cleared":' } }] }, 2)
      check(`K10-h 2 row [ClearQueue] structured cap-clear tercatat (got ${capRow})`, capRow >= 2)
    }

    // ════ Kasus 11 — Regresi: take-next + single-resolve + batch-resolve tetap normal ════
    {
      const c1 = await mkQueueChat(tenant, null, { lastMessageAt: new Date(Date.now() - 5000) })
      const c2 = await mkQueueChat(tenant, null, { lastMessageAt: new Date(Date.now() - 4000) })
      const tn = await api('POST', '/api/chats/take-next', {}, adminTok)
      check(`K11-a take-next → 200 + chat benar (claimed=${tn.data?.chat?.id} target=${c1.id})`, tn.status === 200 && tn.data?.chat?.id === c1.id)
      const qr = await api('GET', `/api/chats/${c1.id}`, undefined, adminTok)
      check('K11-b chat claimed: assignedTo=admin', qr.data?.chat?.assignedToId === adminUser.id && qr.data?.chat?.status === 'open')
      const rs = await api('POST', `/api/chats/${c1.id}/resolve`, {}, adminTok)
      check(`K11-c single-resolve → 200 (got ${rs.status})`, rs.status === 200)
      const rAfter = await prisma.chat.findUnique({ where: { id: c1.id } })
      check('K11-d hasil single-resolve benar (resolved + resolvedById=admin)', rAfter.status === 'resolved' && rAfter.resolvedById === adminUser.id)
      // CSAT hook jalur manual TETAP hidup (fire-and-forget) — kontras dgn clear-queue (0)
      const csat1 = await waitForCsat({ tenantId: T }, 1, 8000)
      check(`K11-e CSAT 1 survey dibuat oleh single-resolve (kontras: clear-queue 0) (got ${csat1})`, csat1 === 1, `got=${csat1}`)
      const br = await api('POST', '/api/chats/batch-resolve', { chatIds: [c2.id] }, adminTok)
      check(`K11-f batch-resolve → 200 resolved=1 (got ${br.status}/${br.data?.resolved?.length})`, br.status === 200 && br.data?.resolved?.length === 1)
      const c2After = await prisma.chat.findUnique({ where: { id: c2.id } })
      check('K11-g batch-resolve: chat di-resolve normal', c2After.status === 'resolved')
      const q = await qCount(adminTok)
      check(`K11-h queue-count = 0 pasca regresi (got ${q.data?.count})`, q.data?.count === 0)
      const brRowN = await waitForCount({ level: 'info', message: { contains: '[BatchResolve]' }, AND: [{ message: { contains: ` tenant=${T}` } }, { metaJson: { contains: '"resolved":' } }] }, 1)
      const brRow = await prisma.systemLog.findFirst({ where: { message: { contains: '[BatchResolve]' }, AND: [{ message: { contains: ` tenant=${T}` } }, { metaJson: { contains: '"resolved":' } }] }, orderBy: { id: 'desc' } })
      check(`K11-i [BatchResolve] breadcrumb tetap jalan (module chat, row structured got ${brRowN})`, brRow?.module === 'chat')
    }

    // ── Sanity akhir run ──
    const dur = ((Date.now() - t0.getTime()) / 1000).toFixed(1)
    console.log(`\n=== e2e-clearqueue: ${pass} PASS / ${fails.length} FAIL (${dur}s) ===`)
    if (fails.length) { console.log('FAILED:', fails.join(' | ')); process.exitCode = 1 }
  } catch (e) {
    console.error('HARNESS ERROR:', e)
    process.exitCode = 1
    if (serverChild) {
      try { console.error('SERVER OUTPUT (tail):\n' + (serverChild.__out ? serverChild.__out().slice(-2000) : '')) } catch {}
    }
  } finally {
    if (serverChild) {
      try { serverChild.kill('SIGTERM') } catch {}
      await sleep(500)
      try { serverChild.kill('SIGKILL') } catch {}
    }
    try { await prisma.$disconnect() } catch {}
    process.exit(process.exitCode || 0)
  }
}

main()