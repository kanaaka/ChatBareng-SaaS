#!/usr/bin/env node
/**
 * E2E — v4.6.7 Float Zone chat list "Mine" — ❗DIREVISI v4.6.8 (spec
 * docs/spec-v4.6.8-floatzone-v2.md §K5): logic dua-zona v4.6.7 DIHAPUS —
 * urutan Mine sekarang SATU formula (kandidat timestamp terbaru per chat:
 * MAX(lastMessageAt, lastAssignedAt, firstAssignedAt, createdAt) DESC —
 * "take lifts once, activity wins"). Field inFloatZone TIDAK ADA lagi.
 * Kasus-kasus di bawah dipertahankan bentuknya (pola harness lama) tapi
 * ekspektasinya DIREVISI ke formula baru; yang murni zona dihapus/ganti.
 *
 * Jalur copy-DB :5099 (WA_DISABLED=1) — produksi (5047) TIDAK tersentuh.
 * Pola: scripts/e2e-clearqueue.cjs (copy DB + reset superadmin + login API
 * + self-boot; server child di-kill di akhir run). SUPERSEDE diri sendiri:
 * versi lama file ini menguji zona float v4.6.7 (sudah tidak berlaku).
 *
 * 8 kasus (revisi):
 *  1  Setup: tenant + admin + csA + csB + 8 chat antrean (AR-off konfig default OFF)
 *  2  csA take 5 via /take-next (FIFO queuedAt) → GET mine: 5 tampil; urutan =
 *     take terbaru di atas (P5..P1 — dulu: "semua inFloatZone=true"); TANPA
 *     field inFloatZone (kontrak v2)
 *  3  csA reply manual ke 2 → DULU: graduate ke bawah zona; SEKARANG (v2):
 *     reply = lastMessageAt terbaru → 2 chat itu naik ke ATAS di atas take
 *     yang belum dibalas (urut aktivitas); 3 tak-dibalas urut lastAssignedAt
 *  4  csB punya 2 chat Mine sendiri (lastMessageAt lawas) → GET mine(csB):
 *     isolasi + urutan aktivitas miliknya (b2 tereply → di atas b1 — dulu
 *     [b1,b2] by zona); csA tidak melihat chat csB & sebaliknya
 *  5  Persist: GET mine ulang (simulasi refresh) → urutan identik
 *  6  Inbound baru ke chat take-belum-dibalas → DULU: posisi tidak geser;
 *     SEKARANG (v2): chat naik ke PALING ATAS (lastMessageAt menang)
 *  7  Admin view "All": urutan normal lastMessageAt desc + tanpa inFloatZone
 *  8  Re-claim: release → take lagi → lastAssignedAt baru → naik paling atas
 *  9  Regresi invariant AR (v0.13.3) + queue-count konsisten
 *  10 Search-all (200) + Analytics sanity + kontrak bersih (tanpa inFloatZone)
 */
const REPO = '/home/kanakxxx/.openclaw/workspace/wa-cs-hub-saas-v3'
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:5099'
const COPY_DB = process.env.E2E_COPY_DB || 'file:/tmp/saas-v3-e2e-floatzone-rev.db'
const PORT = '5099'
const fs = require('fs')
const { execSync, spawn } = require('child_process')
require(REPO + '/node_modules/dotenv').config({ path: REPO + '/.env' })
process.env.DATABASE_URL = COPY_DB
process.env.WA_DISABLED = '1'
process.env.APP_VERSION = 'v4.6.8-floatzone-rev-e2e'

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

// Fixture: 1 chat antrean (open+unassigned+pesan aktif → masuk queueWhere);
// queuedAt diset per index — FIFO take deterministik.
// AR-off: AutoReplyConfig default OFF (fixture invariant v0.13.3).
async function mkQueueChat(tenant, label, lastMessageAt, seqIdx) {
  const jid = `e2efz${mkToken('j')}@s.whatsapp.net`
  return prisma.chat.create({
    data: {
      tenantId: tenant.id,
      waJid: jid,
      contactPhone: '62811556' + String(Math.floor(Math.random() * 900 + 100)),
      contactName: label,
      status: 'open',
      assignedToId: null,
      unreadCount: 1,
      lastMessageAt,
      queuedAt: new Date(Date.now() + (seqIdx ?? 0) * 1000), // FIFO key deterministik
      messages: { create: { tenantId: tenant.id, direction: 'in', content: `pesan uji ${label}`, senderName: label, timestamp: lastMessageAt } },
    },
  })
}
// Simulasi inbound pelanggan (INSERT message + UPDATE lastMessageAt/preview/unread)
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
  const copyPath = COPY_DB.replace('file:', '')
  for (const p of [copyPath, copyPath + '-wal', copyPath + '-shm']) { try { fs.unlinkSync(p) } catch {} }
  fs.copyFileSync(REPO + '/prisma/data/saas-v3.db', copyPath)
  const env = { ...process.env, PORT, DATABASE_URL: COPY_DB, WA_DISABLED: '1', APP_VERSION: 'v4.6.8-floatzone-rev-e2e' }
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

    // ════ Kasus 1 — Setup ════
    const sa0 = await prisma.user.findFirst({ where: { role: 'super_admin' } })
    check('K1-a super_admin row ada di copy DB', !!sa0)
    const saPass = process.env.SUPERADMIN_PASSWORD || 'superadmin123'
    await prisma.user.update({ where: { id: sa0.id }, data: { passwordHash: await bcrypt.hash(saPass, 10), status: 'active' } })
    const saLogin = await api('POST', '/api/auth/login', { username: sa0.username, password: saPass })
    check(`K1-b superadmin login status=${saLogin.status}`, saLogin.status === 200 && !!saLogin.data?.token)

    const tName = 'e2e-floatzone-rev-' + mkToken('t')
    const tenant = await prisma.tenant.create({ data: { name: tName, status: 'active' } })
    const T = tenant.id
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

    await prisma.autoReplyConfig.create({ data: { tenantId: T, numberSlot: null, outsideHoursEnabled: false, greetEnabled: false } })
    // 8 chat antrean lawas, FIFO queuedAt berurutan
    const poolChats = []
    for (let i = 1; i <= 8; i++) poolChats.push(await mkQueueChat(tenant, `P${i}`, new Date(Date.now() - i * 3600e3), i - 1))
    const q0 = await api('GET', '/api/chats/queue-count', undefined, adminTok)
    check(`K1-d 8 chat antrean terbentuk (queue-count=${q0.data?.count})`, q0.status === 200 && q0.data?.count === 8, `got=${q0.data?.count}`)
    const arCfg = await prisma.autoReplyConfig.findFirst({ where: { tenantId: T } })
    check('K1-e AR-off (default: outsideHours=false greetEnabled=false — invariant v0.13.3 fixture)', !arCfg.outsideHoursEnabled && !arCfg.greetEnabled)

    // ════ Kasus 2 — csA take 5 → urutan take terbaru di atas; tanpa inFloatZone ════
    const taken = []
    for (let i = 0; i < 5; i++) {
      const r = await api('POST', '/api/chats/take-next', {}, csATok)
      if (r.status !== 200 || r.data?.chat?.id === undefined) { check(`K2-0 take ke-${i + 1} gagal`, false, JSON.stringify(r.data || {}).slice(0, 120)); break }
      taken.push(r.data.chat.id)
    }
    check(`K2-a 5 take sukses FIFO (ids=${taken.join(',')})`, taken.length === 5 && JSON.stringify(taken) === JSON.stringify(poolChats.slice(0, 5).map((c) => c.id)))
    const q1 = await api('GET', '/api/chats/queue-count', undefined, adminTok)
    check(`K2-b queue-count pasca 5 take = 3 — got ${q1.data?.count}`, q1.data?.count === 3)

    const mine0 = await api('GET', '/api/chats?filter=mine', undefined, csATok)
    check(`K2-c GET mine(csA) status=${mine0.status} total ${mine0.data?.chats?.length}`, mine0.status === 200 && mine0.data?.chats?.length === 5)
    const takenIdsSet = new Set(taken)
    check('K2-d kelima chat take tampil di mine(csA)', mine0.data.chats.every((c) => takenIdsSet.has(c.id)))
    check('K2-e TANPA inFloatZone di response (v2 — kontrak bersih; dulu: semua true)', !JSON.stringify(mine0.data.chats).includes('inFloatZone'))
    const list0 = mine0.data.chats.map((c) => c.id)
    const exp0 = [...taken].reverse() // FIFO take → di atas = take#5 (P5)
    check('K2-f urutan = take terbaru di atas (revisi v2)', JSON.stringify(list0) === JSON.stringify(exp0), `got=${JSON.stringify(list0)} expect=${JSON.stringify(exp0)}`)
    const mtimes = mine0.data.chats.map((c) => new Date(c.lastAssignedAt).getTime())
    check('K2-g lastAssignedAt non-increasing (desc + tie id desc)', mtimes.every((m, i) => i === 0 || mtimes[i - 1] >= m))

    // ════ Kasus 3 — reply 2 terbawah → v2: 2 chat itu naik ke ATAS ════
    // Dulu (v4.6.7): replied graduate ke zona normal (di bawah). Sekarang: reply
    // = aktivitas terbaru → melompat ke atas (urutan antar keduanya = urutan reply).
    const replied = [list0[3], list0[4]] // P2, P1 (urutan list)
    for (let i = 0; i < 2; i++) {
      const rr = await api('POST', `/api/chats/${replied[i]}/reply`, { content: `resp ${i + 1} floatzone e2e` }, csATok)
      if (rr.status !== 200) { check(`K3-0 reply ke ${replied[i]} gagal`, false, JSON.stringify(rr.data || {}).slice(0, 120)) }
    }
    const fresh0 = await prisma.chat.findMany({ where: { id: { in: replied } }, select: { id: true, firstResponseAt: true, firstResponseById: true } })
    check('K3-a firstResponseAt terisi (2 chat tereply) + by csA', fresh0.every((c) => c.firstResponseAt && c.firstResponseById === csA.id))
    const mine1 = await api('GET', '/api/chats?filter=mine', undefined, csATok)
    const list1 = mine1.data.chats.map((c) => c.id)
    const exp1 = [replied[1], replied[0], ...exp0.filter((id) => !replied.includes(id))]
    check('K3-b 2 chat tereply naik ke ATAS (urut reply terbaru; 3 sisanya urut take)', JSON.stringify(list1) === JSON.stringify(exp1), `got=${JSON.stringify(list1)} expect=${JSON.stringify(exp1)}`)
    check('K3-c TANPA inFloatZone selepas reply (dulu: graduate → false)', !JSON.stringify(mine1.data.chats).includes('inFloatZone'))

    // ════ Kasus 4 — csB isolasi (b1, b2) ════
    const oldTs = new Date(Date.now() - 48 * 3600e3)
    const b1 = await prisma.chat.create({
      data: { tenantId: T, waJid: `e2efzb1${mkToken('b1')}@s.whatsapp.net`, contactPhone: '628119994' + String(Math.floor(Math.random() * 90 + 10)), contactName: 'CSB-1', status: 'open', assignedToId: csB.id, lastAssignedAt: oldTs, firstAssignedAt: oldTs, lastMessageAt: oldTs, unreadCount: 1, messages: { create: { tenantId: T, direction: 'in', content: 'csb-1 lawas', senderName: 'CSB-1', timestamp: oldTs } } },
    })
    const b2 = await prisma.chat.create({
      data: { tenantId: T, waJid: `e2efzb2${mkToken('b2')}@s.whatsapp.net`, contactPhone: '628119995' + String(Math.floor(Math.random() * 90 + 10)), contactName: 'CSB-2', status: 'open', assignedToId: csB.id, lastAssignedAt: new Date(oldTs.getTime() + 60e3), firstAssignedAt: oldTs, lastMessageAt: new Date(oldTs.getTime() + 60e3), unreadCount: 1, messages: { create: { tenantId: T, direction: 'in', content: 'csb-2 lawas', senderName: 'CSB-2', timestamp: new Date(oldTs.getTime() + 60e3) } } },
    })
    await api('POST', `/api/chats/${b2.id}/reply`, { content: 'csb-2 replied' }, csBTok)
    const mineB0 = await api('GET', '/api/chats?filter=mine', undefined, csBTok)
    const mineBIds = mineB0.data.chats.map((c) => c.id)
    // v2: b2 tereply → lastMessageAt terbaru → di atas b1 (DULU: [b1 zona, b2 normal])
    check(`K4-a mine(csB) = [b2 tereply, b1 lawas] urutan aktivitas (got ${JSON.stringify(mineBIds)})`, JSON.stringify(mineBIds) === JSON.stringify([b2.id, b1.id]))
    check('K4-b isolasi csB: tidak ada chat csA bocor ke list csB', mineB0.data.chats.every((c) => !takenIdsSet.has(c.id)))
    const mineA0 = await api('GET', '/api/chats?filter=mine', undefined, csATok)
    check('K4-c isolasi csA: tidak ada chat csB bocor ke list csA', mineA0.data.chats.every((c) => c.id !== b1.id && c.id !== b2.id))

    // ════ Kasus 5 — Persist (refresh GET ulang) → urutan tetap ════
    const mine2 = await api('GET', '/api/chats?filter=mine', undefined, csATok)
    check('K5-a persist: urutan list csA identik antar GET (state server, bukan client)', JSON.stringify(mine2.data.chats.map((c) => c.id)) === JSON.stringify(list1))
    check('K5-b persist: mine(csB) identik antar GET', JSON.stringify((await api('GET', '/api/chats?filter=mine', undefined, csBTok)).data.chats.map((c) => c.id)) === JSON.stringify([b2.id, b1.id]))

    // ════ Kasus 6 — Inbound ke chat take-belum-dibalas → v2: naik PALING ATAS ════
    // Dulu (v4.6.7): posisi tidak geser (zona by lastAssignedAt). Sekarang: aktivitas
    // pelanggan = timestamp terbaru → melompat ke atas semua take lain.
    const targetFloat = exp1.find((id) => !replied.includes(id)) // chat tak-dibalas teratas (P5)
    const unreadBefore = mine2.data.chats.find((c) => c.id === targetFloat)?.unreadCount || 0
    const targetChat = await prisma.chat.findFirst({ where: { id: targetFloat } })
    await simulateIncoming(targetChat, 'halo saya balas lagi floatzone')
    const mine3 = await api('GET', '/api/chats?filter=mine', undefined, csATok)
    const f3 = mine3.data.chats.map((c) => c.id)
    check('K6-a inbound ke chat take-belum-dibalas → naik PALING ATAS (revisi v2)', f3[0] === targetFloat, `got=${f3[0]} expect=${targetFloat} list=${JSON.stringify(f3)}`)
    check('K6-b unreadCount naik +1 pasca inbound', (mine3.data.chats.find((c) => c.id === targetFloat)?.unreadCount) === unreadBefore + 1)

    // ════ Kasus 7 — Admin view "All": urutan normal, tanpa inFloatZone ════
    const allList = await api('GET', '/api/chats?filter=all', undefined, adminTok)
    const normalAllTs = allList.data.chats.filter((c) => c.status === 'open').map((c) => new Date(c.lastMessageAt).getTime())
    check(`K7-a admin "All" urutan lastMessageAt desc (${allList.data.chats.length} chat)`, normalAllTs.every((m, i) => i === 0 || normalAllTs[i - 1] >= m), JSON.stringify(normalAllTs.slice(0, 10)))
    check('K7-b admin "All" TANPA inFloatZone (regresi kontrak v2)', !JSON.stringify(allList.data.chats).includes('inFloatZone'))

    // ════ Kasus 8 — Re-claim: release → take lagi → lastAssignedAt baru → paling atas ════
    const headFloat = f3[0] // targetFloat (top saat ini)
    const rel = await api('POST', `/api/chats/${headFloat}/release`, {}, csATok)
    if (rel.status !== 200) check(`K8-0 release chat ${headFloat} gagal`, false, JSON.stringify(rel.data || {}).slice(0, 120))
    const q2 = await api('GET', '/api/chats/queue-count', undefined, adminTok)
    check(`K8-a pasca release: queue-count 4 (chat kembali antrean) — got ${q2.data?.count}`, q2.data?.count === 4)
    // FIFO — queue berisi 4 chat (fixture P6..P8 + released; released FIFO pertama —
    // queuedAt=release-now < queuedAt fixture yang sengaja berimbang +1s/index);
    // DRAIN penuh (tanpa break): habiskan 4, catat reclaimed di antara take.
    let reclaimed = null
    const drainTakes = []
    for (let i = 0; i < 6; i++) {
      const r = await api('POST', '/api/chats/take-next', {}, csATok)
      if (r.status !== 200 || !r.data?.chat?.id) break
      if (r.data.chat.id === headFloat) reclaimed = r.data.chat.id
      else drainTakes.push(r.data.chat.id)
    }
    check('K8-b take-loop re-claim chat released (di antara take FIFO)', reclaimed === headFloat, `got=${reclaimed} target=${headFloat}`)
    const fresh8 = await prisma.chat.findFirst({ where: { id: headFloat } })
    const mine4 = await api('GET', '/api/chats?filter=mine', undefined, csATok)
    const l4 = mine4.data.chats.map((c) => c.id)
    // v2: setelah DRAIN, 3 take baru (P6..P8) urut teratas (lastAssignedAt terbaru —
    // activity wins); chat re-claim (P5) TEPAT di bawahnya, di atas SEMUA chat
    // aktivitas lebih lama (dulu v4.6.7: re-claim selalu paling atas zona).
    const iHead = l4.indexOf(headFloat)
    check(`K8-c re-claim → lastAssignedAt baru: tepat di bawah ${drainTakes.length} take drain, di atas semua chat lama`, iHead === drainTakes.length, `got idx=${iHead} expect=${drainTakes.length} list=${JSON.stringify(l4)}`)
    check('K8-c2 tiga di atasnya = hasil take drain (urut take terbalik)', JSON.stringify(l4.slice(0, drainTakes.length)) === JSON.stringify(drainTakes.slice().reverse()), `got=${JSON.stringify(l4.slice(0, drainTakes.length))} drain=${JSON.stringify(drainTakes)}`)
    const drainSet = new Set(drainTakes)
    const headKey = Math.max(new Date(fresh8.lastMessageAt || 0).getTime(), new Date(fresh8.lastAssignedAt).getTime())
    const others = mine4.data.chats.filter((c) => !drainSet.has(c.id) && c.id !== headFloat)
    const othersMax = Math.max(...others.map((c) => Math.max(new Date(c.lastMessageAt || 0).getTime(), new Date(c.lastAssignedAt || 0).getTime())))
    check('K8-d lastAssignedAt re-claim >= aktivitas semua chat lama (kecuali take drain yang lebih baru)', headKey >= othersMax, `head=${headKey} othersMax=${othersMax}`)

    // ════ Kasus 9 — Regresi invariant AR + queue-count konsisten ════
    const arCfg2 = await prisma.autoReplyConfig.findFirst({ where: { tenantId: T } })
    check('K9-a AR config tenant: off (fixture) — invariant dipertahankan', !arCfg2.outsideHoursEnabled && !arCfg2.greetEnabled)
    const freshA = await prisma.chat.findMany({ where: { id: { in: taken } }, select: { id: true, firstResponseAt: true } })
    check('K9-b 0 chat Mine csA dapat firstResponseAt dari jalur AR (hanya 2 manual reply K3)', freshA.filter((c) => c.firstResponseAt).length === 2, `got=${freshA.filter((c) => c.firstResponseAt).length}`)
    // queue count: 8 − 5 take (K2) + 1 release (K8) − 4 take DRAIN K8 = 0
    const q3 = await api('GET', '/api/chats/queue-count', undefined, adminTok)
    check(`K9-c queue-count konsisten pasca semua aksi = 0 — got ${q3.data?.count}`, q3.data?.count === 0)

    // ════ Kasus 10 — search-all & analytics sanity + kontrak bersih ════
    const sAll = await api('GET', `/api/chats/search-all?q=P1`, undefined, csATok)
    check(`K10-a search-all sanity 200 (${sAll.status})`, sAll.status === 200)
    const ana = await api('GET', '/api/analytics/overview?range=7d', undefined, adminTok)
    check(`K10-b analytics sanity 200 (plan Max) — got ${ana.status}`, ana.status === 200)
    const anaS = await api('GET', '/api/analytics/overview?range=7d', undefined, csATok)
    check(`K10-c analytics role-gate CS = 403 unchanged by design (got ${anaS.status})`, anaS.status === 403)

    // ── EPILOG ──
    console.log(`\n=== v4.6.8 floatzone-rev e2e (revisi v467): ${pass} PASS / ${fails.length} FAIL (${((Date.now() - t0) / 1000).toFixed(1)}s) ===`)
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