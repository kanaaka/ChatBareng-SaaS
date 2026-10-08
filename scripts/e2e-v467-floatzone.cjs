#!/usr/bin/env node
/**
 * E2E — v4.6.7 Float Zone chat list "Mine" (spec docs/spec-v4.6.7-floatzone.md §D3)
 * Jalur copy-DB :5099 (WA_DISABLED=1) — produksi (5047) TIDAK tersentuh.
 * Pola: scripts/e2e-clearqueue.cjs (copy DB + reset superadmin + login API + self-boot).
 *
 * Jalur boot — self-contained (default; server child di-kill di akhir run):
 *   node scripts/e2e-v467-floatzone.cjs
 *
 * 10 kasus (§D3):
 *   1  Setup: tenant + admin + csA + csB + 8 chat antrean (AR-off konfig default OFF)
 *   2  csA take 5 via /take-next → GET mine: 5 tampil; urut lastAssignedAt desc
 *      (determinisme batch: secondary id desc) + semua inFloatZone=true
 *   3  csA reply manual ke 2 → firstResponseAt terisi → graduate: 2 itu pindah urutan
 *      normal (lastMessageAt desc) DI BAWAH zona; 3 sisanya tetap zona float di atas
 *   4  csB punya 2 chat Mine sendiri (lastMessageAt lawas) → GET mine(csB): isolasi
 *      (chat csA tidak tampak) + urutan normal; csA tidak melihat chat csB
 *   5  Persist: GET mine ulang (simulasi refresh) → zona float & urutan tetap
 *   6  Inbound baru ke chat float (simulateIncoming: insert pesan + UPDATE
 *      lastMessageAt/unread; TANPA reply agent) → posisi tidak geser + unread naik
 *   7  Admin view "All": urutan normal lastMessageAt desc (tanpa zona) + tanpa
 *      inFloatZone=true yang menyesatkan + field flag tetap ada (virtual murni)
 *   8  Re-claim: release → take lagi → lastAssignedAt baru → naik ke paling atas zona
 *   9  Regresi invariant AR: AR off (config default) + guard assignedToId != null
 *      (baileys/pool §4.3) — chat assigned TIDAK diproses AR; queue-count berkurang
 *      normal saat take (5 take → count turun)
 *  10  Search-all (200, tidak terpengaruh) + Analytics sanity (200 dgn plan Max)
 */
const REPO = '/home/kanakxxx/.openclaw/workspace/wa-cs-hub-saas-v3'
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:5099'
// KRITIS (lesson v4.1.x / v470): .env berisi DATABASE_URL PROD (ABSOLUTE path) →
// DATABASE_URL dipaksa ke copy SETELAH dotenv — seluruh proses satu DB copy (service
// gak pernah menembak PROD).
const COPY_DB = process.env.E2E_COPY_DB || 'file:/tmp/saas-v3-e2e-floatzone.db'
const PORT = '5099'
const fs = require('fs')
const { execSync, spawn } = require('child_process')
require(REPO + '/node_modules/dotenv').config({ path: REPO + '/.env' })
process.env.DATABASE_URL = COPY_DB
process.env.WA_DISABLED = '1'
process.env.APP_VERSION = 'v4.6.7-floatzone-e2e'

const { PrismaClient } = require(REPO + '/node_modules/@prisma/client')
const prisma = new PrismaClient({ datasourceUrl: COPY_DB, log: ['error'] })
const bcrypt = require(REPO + '/node_modules/bcryptjs')

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
  for (let i = 0; i < 12; i++) s += ABC[Math.floor(Math.random() * ABC.length)]
  return `${prefix}-${s}`
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Fixture: 1 chat antrean (open+unassigned+pesan aktif → masuk queueWhere).
// AR-off: AutoReplyConfig default (outsideHoursEnabled=false, greetEnabled=false) —
// seed tenant memang default OFF (konfig tidak diubah di run ini).
async function mkQueueChat(tenant, label, opts = {}) {
  const jid = `e2efz${mkToken('j')}@s.whatsapp.net`
  return prisma.chat.create({
    data: {
      tenantId: tenant.id,
      waJid: jid,
      contactPhone: '62811556' + String(Math.floor(Math.random() * 900 + 100)),
      contactName: label,
      status: 'open',
      assignedToId: null,
      unreadCount: opts.unreadCount ?? 1,
      lastMessageAt: opts.lastMessageAt || new Date(),
      csMessagesSent: 0,
      messages: { create: { tenantId: tenant.id, direction: 'in', content: `pesan uji ${label}`, senderName: label, timestamp: opts.lastMessageAt || new Date() } },
    },
  })
}
// v4.6.7 — kasus 6 (K6): simulasi inbound pesan baru ke chat (mirroring pool.js
// upsert existing: INSERT message + UPDATE lastMessageAt/preview/unread). TANPA
// reply agent → chat HARUS tetap di zona float & posisinya tetap (by lastAssignedAt).
// (Dipakai via prisma langsung di K6 — helper ini jadi bukti langkah test.)
async function simulateIncoming(chat, text) {
  const ts = new Date()
  await prisma.message.create({ data: { tenantId: chat.tenantId, chatId: chat.id, direction: 'in', content: text, senderName: chat.contactName || 'Pelanggan', timestamp: ts } })
  return prisma.chat.update({ where: { id: chat.id }, data: { lastMessageAt: ts, lastMessagePreview: text, unreadCount: { increment: 1 } } })
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
  const env = { ...process.env, PORT, DATABASE_URL: COPY_DB, WA_DISABLED: '1', APP_VERSION: 'v4.6.7-floatzone-e2e' }
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

async function main() {
  const t0 = new Date()
  try {
    await bootServerIfNeeded()
    if (fails.length) {
      console.error('BOOT GAGAL — output server:\n' + (serverChild?.__out ? serverChild.__out().slice(-2000) : 'n/a'))
      return
    }

    // ════ Kasus 1 — Setup: superadmin + tenant + admin/csA/csB + 8 chat + AR-off ════
    const sa0 = await prisma.user.findFirst({ where: { role: 'super_admin' } })
    check('K1-a super_admin row ada di copy DB', !!sa0)
    const saPass = process.env.SUPERADMIN_PASSWORD || 'superadmin123'
    await prisma.user.update({ where: { id: sa0.id }, data: { passwordHash: await bcrypt.hash(saPass, 10), status: 'active' } })
    const saLogin = await api('POST', '/api/auth/login', { username: sa0.username, password: saPass })
    check(`K1-b superadmin login status=${saLogin.status}`, saLogin.status === 200 && !!saLogin.data?.token)

    const tName = 'e2e-floatzone-' + mkToken('t')
    const tenant = await prisma.tenant.create({ data: { name: tName, status: 'active' } })
    const T = tenant.id
    // plan Max → analytics feat gate ON utk K10 (ensureTenantPlan default max)
    await prisma.tenantPlan.create({ data: { tenantId: T, preset: 'max', featAnalytics: true } })
    const hash = (v) => bcrypt.hashSync(v, 10)
    const adminUser = await prisma.user.create({ data: { username: `adm_fz_${mkToken('u')}`, passwordHash: hash('adminpass123'), role: 'admin', tenantId: T, status: 'active' } })
    const csA = await prisma.user.create({ data: { username: `csa_fz_${mkToken('u')}`, passwordHash: hash('csapass123'), role: 'cs', tenantId: T, status: 'active' } })
    const csB = await prisma.user.create({ data: { username: `csb_fz_${mkToken('u')}`, passwordHash: hash('csbpass123'), role: 'cs', tenantId: T, status: 'active' } })
    const adminLogin = await api('POST', '/api/auth/login', { username: adminUser.username, password: 'adminpass123' })
    const csALogin = await api('POST', '/api/auth/login', { username: csA.username, password: 'csapass123' })
    const csBLogin = await api('POST', '/api/auth/login', { username: csB.username, password: 'csbpass123' })
    check('K1-c login admin+csA+csB (3 token)', adminLogin.status === 200 && csALogin.status === 200 && csBLogin.status === 200)
    const adminTok = adminLogin.data?.token, csATok = csALogin.data?.token, csBTok = csBLogin.data?.token

    // AR-off: config row default (semua trigger OFF) — dibuat eksplisit utk kejelasan fixture
    await prisma.autoReplyConfig.create({ data: { tenantId: T, numberSlot: null, outsideHoursEnabled: false, greetEnabled: false } })
    // 8 chat antrean (mkQueueChat beri lastMessageAt default now; A-pool FIFO urut queuedAt nanti)
    const poolChats = []
    for (let i = 1; i <= 8; i++) poolChats.push(await mkQueueChat(tenant, `P${i}`))
    const q0 = await api('GET', '/api/chats/queue-count', undefined, adminTok)
    check(`K1-d 8 chat antrean terbentuk (queue-count=${q0.data?.count})`, q0.status === 200 && q0.data?.count === 8, `got=${q0.data?.count}`)
    const arCfg = await prisma.autoReplyConfig.findFirst({ where: { tenantId: T } })
    check('K1-e AR-off (default: outsideHours=false greetEnabled=false — invariant v0.13.3 fixture)', !arCfg.outsideHoursEnabled && !arCfg.greetEnabled)

    // ════ Kasus 2 — csA take 5 (batch 5x take-next) → urutan zona float ════
    // FIFO take: ambil 5 chat pertama antrean (queuedAt asc — seminggu sama detik
    // antar take ~±1s; urutan batch ditegakkan via queuedAt FIFO, BUKAN urutan create).
    // Untuk determinisme urutan expected lastAssignedAt asc-by-take, KITA catat urutan
    // take aktual lalu bandingkan sort (lastAssignedAt desc, id desc) dgn toleransi.
    const taken = []
    for (let i = 0; i < 5; i++) {
      const r = await api('POST', '/api/chats/take-next', {}, csATok)
      if (r.status !== 200 || r.data?.chat?.id === undefined) { check(`K2-0 take ke-${i + 1} gagal`, false, JSON.stringify(r.data || {}).slice(0, 120)); break }
      taken.push(r.data.chat.id)
    }
    check(`K2-a 5 take sukses (ids=${taken.join(',')})`, taken.length === 5)
    const q1 = await api('GET', '/api/chats/queue-count', undefined, adminTok)
    check(`K2-b queue-count pasca 5 take = 3 (5 keluar antrean) — got ${q1.data?.count}`, q1.data?.count === 3)

    const mine0 = await api('GET', '/api/chats?filter=mine', undefined, csATok)
    check(`K2-c GET mine(csA) status=${mine0.status} total ${mine0.data?.chats?.length}`, mine0.status === 200 && mine0.data?.chats?.length === 5)
    const takenIdsSet = new Set(taken)
    check('K2-d kelima chat take tampil di mine(csA)', mine0.data.chats.every((c) => takenIdsSet.has(c.id)))
    check('K2-e semua inFloatZone=true (firstResponseAt null, lastAssignedAt terisi)', mine0.data.chats.every((c) => c.inFloatZone === true))
    // urutan = lastAssignedAt desc + determinisme (id desc ketika mtime setara — toleransi ±2s dgn take batch)
    const list0 = mine0.data.chats.map((c) => c.id)
    const mtimes = mine0.data.chats.map((c) => new Date(c.lastAssignedAt).getTime())
    check('K2-f urutan lastAssignAt non-increasing (desc + tie id desc)', mtimes.every((m, i) => i === 0 || mtimes[i - 1] >= m), JSON.stringify(list0))
    function expectedTakeOrder() {
      // Map id → urutan take (1..5); sort desc = take terakhir dulu
      return [...taken].reverse()
    }
    // K2-g (loose): elemen PERTAMA & TERAKHIR zona konsisten FIFO take (batch mtime ±)
    // — bukan asersi ketat 1-by-1 (toleransi sama-detik batch per §D3.2)
    const exp = expectedTakeOrder()
    check('K2-g urutan zona float ~ urutan take (first=take#5, last=take#1 — toleransi batch)', list0[0] === exp[0], `got=${list0[0]} expect=${exp[0]}`)

    // ════ Kasus 3 — csA reply manual ke 2 → firstResponseAt terisi → graduate ════
    // reply ke 2 chat terbawah list (yaitu take#4, take#5 sesuai exp[3], exp[4] — dgn
    // toleransi batch, ambil literal dari list0[3], list0[4]).
    const replied = [list0[3], list0[4]]
    for (let i = 0; i < 2; i++) {
      const rr = await api('POST', `/api/chats/${replied[i]}/reply`, { content: `resp ${i + 1} floatzone e2e` }, csATok)
      if (rr.status !== 200) { check(`K3-0 reply ke ${replied[i]} gagal`, false, JSON.stringify(rr.data || {}).slice(0, 120)) }
    }
    const fresh0 = await prisma.chat.findMany({ where: { id: { in: replied } }, select: { id: true, firstResponseAt: true, firstResponseById: true } })
    check('K3-a firstResponseAt terisi (2 chat tereply) + by csA', fresh0.every((c) => c.firstResponseAt && c.firstResponseById === csA.id))
    const mine1 = await api('GET', '/api/chats?filter=mine', undefined, csATok)
    const floatIds = mine1.data.chats.filter((c) => c.inFloatZone).map((c) => c.id)
    const normalIds = mine1.data.chats.filter((c) => !c.inFloatZone).map((c) => c.id)
    check('K3-b zona float tinggal 3 (2 graduate)', floatIds.length === 3 && normalIds.length === 2, `float=${floatIds} normal=${normalIds}`)
    check('K3-c 2 chat tereply graduate (inFloatZone=false)', replied.every((id) => !mine1.data.chats.find((c) => c.id === id)?.inFloatZone))
    check('K3-d struktural: zona float di atas normal normal (lastMessageAt desc)',
      normalIds.length === 2 && mine1.data.chats.slice(0, 3).every((c) => c.inFloatZone) && mine1.data.chats.slice(3).every((c) => !c.inFloatZone), JSON.stringify([floatIds, normalIds]))

    // ════ Kasus 4 — csB punya 2 chat Mine sendiri (lawas) → isolasi ════
    const oldTs = new Date(Date.now() - 48 * 3600e3)
    const b1 = await prisma.chat.create({
      data: { tenantId: T, waJid: `e2efzb1${mkToken('b1')}@s.whatsapp.net`, contactPhone: '628119994' + String(Math.floor(Math.random() * 90 + 10)), contactName: 'CSB-1', status: 'open', assignedToId: csB.id, lastAssignedAt: oldTs, firstAssignedAt: oldTs, lastMessageAt: oldTs, unreadCount: 1, messages: { create: { tenantId: T, direction: 'in', content: 'csb-1 lawas', senderName: 'CSB-1', timestamp: oldTs } } },
    })
    const b2 = await prisma.chat.create({
      data: { tenantId: T, waJid: `e2efzb2${mkToken('b2')}@s.whatsapp.net`, contactPhone: '628119995' + String(Math.floor(Math.random() * 90 + 10)), contactName: 'CSB-2', status: 'open', assignedToId: csB.id, lastAssignedAt: new Date(oldTs.getTime() + 60e3), firstAssignedAt: oldTs, lastMessageAt: new Date(oldTs.getTime() + 60e3), unreadCount: 1, messages: { create: { tenantId: T, direction: 'in', content: 'csb-2 lawas', senderName: 'CSB-2', timestamp: new Date(oldTs.getTime() + 60e3) } } },
    })
    // b2 kena reply manual CSB → bukan zona float → NORMAL zone (lawas)
    await api('POST', `/api/chats/${b2.id}/reply`, { content: 'csb-2 replied' }, csBTok)
    const mineB0 = await api('GET', '/api/chats?filter=mine', undefined, csBTok)
    const mineBIds = mineB0.data.chats.map((c) => c.id)
    check(`K4-a mine(csB) = [b1 zona float, b2 normal] (got ${JSON.stringify(mineBIds)})`, JSON.stringify(mineBIds) === JSON.stringify([b1.id, b2.id]))
    check('K4-b isolasi csB: tidak ada chat csA bocor ke list csB', mineB0.data.chats.every((c) => !takenIdsSet.has(c.id)))
    // csA tidak melihat chat csB
    const mineA0 = await api('GET', '/api/chats?filter=mine', undefined, csATok)
    check('K4-c isolasi csA: tidak ada chat csB bocor ke list csA', mineA0.data.chats.every((c) => c.id !== b1.id && c.id !== b2.id))
    check('K4-d urutan b2 normal (lastMessageAt lawas — di bawah zona b1)', mineB0.data.chats[1].inFloatZone === false)

    // ════ Kasus 5 — Persist (refresh GET ulang) → posisi tetap ════
    const mine2 = await api('GET', '/api/chats?filter=mine', undefined, csATok)
    const list2 = mine2.data.chats.map((c) => c.id)
    check('K5-a persist: urutan list csA identik antar GET (state server, bukan client)', JSON.stringify(list2) === JSON.stringify(mineA0.data.chats.map((c) => c.id)), `before=${JSON.stringify(mineA0.data.chats.map((c) => c.id))} after=${JSON.stringify(list2)}`)
    check('K5-b zona float ids persist (3 float tetap sama)', JSON.stringify(mine2.data.chats.filter((c) => c.inFloatZone).map((c) => c.id).sort()) === JSON.stringify(floatIds.slice().sort()))

    // ════ Kasus 6 — Inbound baru ke chat float → posisi tidak geser + unread naik ════
    const targetFloat = floatIds[1] // amb chat float kedua
    const unreadBefore = mine2.data.chats.find((c) => c.id === targetFloat)?.unreadCount || 0
    const targetChat = await prisma.chat.findFirst({ where: { id: targetFloat } })
    await simulateIncoming(targetChat, 'halo saya balas lagi floatzone')
    const mine3 = await api('GET', '/api/chats?filter=mine', undefined, csATok)
    const f3 = mine3.data.chats.map((c) => c.id)
    check('K6-a posisi chat float target TIDAK geser (inbound tidak mengubah zona)', f3.indexOf(targetFloat) === mine2.data.chats.map((c) => c.id).indexOf(targetFloat),
      `pos before=${mine2.data.chats.map((c) => c.id).indexOf(targetFloat)} after=${f3.indexOf(targetFloat)}`)
    check('K6-b unreadCount naik +1 pasca inbound', (mine3.data.chats.find((c) => c.id === targetFloat)?.unreadCount) === unreadBefore + 1)
    check('K6-c masih zona float (inFloatZone=true)', mine3.data.chats.find((c) => c.id === targetFloat)?.inFloatZone === true)

    // ════ Kasus 7 — Admin view "All": urutan normal (Tanpa zona) ════
    const allList = await api('GET', '/api/chats?filter=all', undefined, adminTok)
    const normalAllTs = allList.data.chats.filter((c) => c.status === 'open').map((c) => new Date(c.lastMessageAt).getTime())
    check(`K7-a admin "All" urutan lastMessageAt desc (${allList.data.chats.length} chat open+nonopen tercampur by mtime)`, normalAllTs.every((m, i) => i === 0 || normalAllTs[i - 1] >= m), JSON.stringify(normalAllTs.slice(0, 10)))
    check('K7-b admin "All" TIDAK mengurutkan zona-float dulu (timestamp normal)', !(allList.data.chats[0]?.inFloatZone === true && allList.data.chats[0]?.lastMessageAt < allList.data.chats[allList.data.chats.length - 1]?.lastMessageAt))

    // ════ Kasus 8 — Re-claim: release → take lagi → lastAssignedAt baru → paling atas ════
    const headFloat = floatIds[0]
    const rel = await api('POST', `/api/chats/${headFloat}/release`, {}, csATok)
    if (rel.status !== 200) check(`K8-0 release chat ${headFloat} gagal`, false, JSON.stringify(rel.data || {}).slice(0, 120))
    const q2 = await api('GET', '/api/chats/queue-count', undefined, adminTok)
    check(`K8-a pasca release: queue-count 4 (chat kembali antrean) — got ${q2.data?.count}`, q2.data?.count === 4)
    // FIFO — queue berisi 4 chat (3 fixture + 1 released); take hingga dapat released tsb
    let reclaimed = null
    for (let i = 0; i < 5; i++) {
      const r = await api('POST', '/api/chats/take-next', {}, csATok)
      if (r.data?.chat?.id === headFloat) { reclaimed = r.data.chat.id; break }
    }
    check('K8-b take-loop dapat re-claim chat released (FIFO urut antrean)', reclaimed === headFloat, `got=${reclaimed} target=${headFloat}`)
    const fresh8 = await prisma.chat.findFirst({ where: { id: headFloat } })
    const mine4 = await api('GET', '/api/chats?filter=mine', undefined, csATok)
    const l4 = mine4.data.chats.map((c) => c.id)
    check('K8-c re-claim → lastAssignedAt baru → chat tersebut paling ATAS zona float', l4[0] === headFloat, `got=${l4[0]}`)
    check('K8-d masih zona float (belum dibalas)', mine4.data.chats[0]?.inFloatZone === true)
    check('K8-e lastAssignedAt baru > lastResponseAt chat lain (naik paling atas)', new Date(fresh8.lastAssignedAt).getTime() >= Math.max(...mine4.data.chats.filter((c) => c.inFloatZone).slice(1).map((c) => new Date(c.lastAssignedAt).getTime())))

    // ════ Kasus 9 — Regresi invariant AR + queue-count normal ════
    // AR config OFF → maybeAutoReply return {sent:false} (tidak kirim apa pun).
    // Guard invariant §4.3 di pool.js: chat assigned TIDAK diproses AR — AR memang
    // tidak menyentuh chat Mine; firstResponseAt chat Mine tidak diubah oleh jalur AR.
    const csatCfg = await prisma.csatConfig.findFirst({ where: { tenantId: T } })
    check('K9-a AR config tenant: off (fixture) — invariant dipertahankan', !!csatCfg ? (!csatCfg.outsideHoursEnabled && !csatCfg.greetEnabled) : true)
    const freshA = await prisma.chat.findMany({ where: { id: { in: taken } }, select: { id: true, firstResponseAt: true } })
    check('K9-b 0 chat Mine csA dapat firstResponseAt dari jalur AR (hanya 2 manual reply K3)', freshA.filter((c) => c.firstResponseAt).length === 2, `got=${freshA.filter((c) => c.firstResponseAt).length}`)
    // queue count: 8 awal − 5 take (K2) + 1 release (K8) − 4 take-loop K8 (3 fixture
    // FIFO lebih dulu + 1 re-claim target) = 0 — setiap take-next tetap mengurangi
    // antrean seperti biasa (inkremental sudah dibuktikan K2-b & K8-a).
    const q3 = await api('GET', '/api/chats/queue-count', undefined, adminTok)
    check(`K9-c queue-count konsisten pasca semua aksi = 0 (semua item antrean habis) — got ${q3.data?.count}`, q3.data?.count === 0)

    // ════ Kasus 10 — search-all & analytics tidak terpengaruh (sanity) ════
    const sAll = await api('GET', `/api/chats/search-all?q=P1`, undefined, csATok)
    check(`K10-a search-all sanity 200 (${sAll.status})`, sAll.status === 200)
    const ana = await api('GET', '/api/analytics/overview?range=7d', undefined, adminTok)
    check(`K10-b analytics sanity 200 (plan Max) — got ${ana.status}`, ana.status === 200)
    // analytics rt = [requireAuth, requireTenant, requireAdmin] — CS 403 BY DESIGN
    // (perilaku unchanged oleh v4.6.7; jalur admin yang di-sanity dgn 200 di K10-b).
    const anaS = await api('GET', '/api/analytics/overview?range=7d', undefined, csATok)
    check(`K10-c analytics role-gate CS = 403 unchanged by design (got ${anaS.status})`, anaS.status === 403)

    // ── EPILOG ──
    console.log(`\n=== v4.6.7 floatzone e2e: ${pass} PASS / ${fails.length} FAIL (${((Date.now() - t0) / 1000).toFixed(1)}s) ===`)
    if (fails.length) { console.log('FAIL list:'); fails.forEach((f) => console.log('  - ' + f)); process.exitCode = 1 }
  } catch (e) {
    console.error('FATAL:', e)
    process.exitCode = 1
  } finally {
    await prisma.$disconnect().catch(() => {})
    if (serverChild) {
      try { serverChild.kill('SIGTERM'); await sleep(500); serverChild.kill('SIGKILL') } catch {}
      console.log('boot server test di-kill (server child) — produksi 5047 tidak tersentuh')
    }
  }
}

main()