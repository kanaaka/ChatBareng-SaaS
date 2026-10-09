#!/usr/bin/env node
/**
 * E2E — v4.6.8 Float Zone v2: satu formula urutan "Mine" (spec
 * docs/spec-v4.6.8-floatzone-v2.md §D3). Semua zona v4.6.7 DIHAPUS:
 * urutan Mine = aktivitas terbaru menang — key chat = MAX(lastMessageAt,
 * lastAssignedAt, firstAssignedAt, createdAt) (bentuk COALESCE-aktivitas dari
 * spec §K2), DESC — "take lifts once, activity wins".
 *
 * Jalur copy-DB :5099 (WA_DISABLED=1) — produksi (5047/5062) TIDAK tersentuh.
 * Pola: scripts/e2e-v467-floatzone.cjs (copy DB + reset superadmin + login API
 * + self-boot; server child di-kill di akhir run).
 * NOTE: script ini SUPERSEDE scripts/e2e-v467-floatzone.cjs (formula lama
 * dua-zona sudah dihapus — suite v467 tidak lagi relevan).
 *
 * 8 kasus (§D3):
 *  1  csA take 5 chat lawas → urutan = take terbaru di atas; field inFloatZone
 *     TIDAK ADA lagi di response (kontrak bersih)
 *  2  csA reply #1 (teratas) → lastMessageAt jadi terbaru → tetap paling atas;
 *     4 take lain tetap urutan take
 *  3  Pelanggan follow-up chat LAMA (aktivitas lawas di bawah semua take) →
 *     naik ke PALING ATAS (normalisasi/aktivitas menang — K1a)
 *  4  Pelanggan follow-up chat FLOAT (take belum dibalas): lastMessageAt >
 *     lastAssignedAt sendiri → naik; take chat lain (lastAssignedAt lebih baru)
 *     → float turun di bawahnya; follow-up SEKARANG → naik paling atas
 *     (dua sisi diperiksa — "siapa lebih baru menang")
 *  5  csB isolasi (list milik csB normal; tidak ada bocor csA/csB)
 *  6  Admin "All" normal (lastMessageAt desc; tanpa field inFloatZone)
 *  7  Badge overlap: markup FE — nama `flex-1 min-w-0 truncate`, badge
 *     `shrink-0`; chip inFloatZone tidak ada (source + bundle ter-build)
 *  8  Regresi: take-FIFO (queue habis) + AR invariant (firstResponseAt hanya
 *     via reply manual) + search-all + analytics
 */
const REPO = '/home/kanakxxx/.openclaw/workspace/wa-cs-hub-saas-v3'
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:5099'
// KRITIS (lesson v4.1.x / v470): .env berisi DATABASE_URL PROD (ABSOLUTE path) →
// DATABASE_URL dipaksa ke copy SETELAH dotenv — seluruh proses satu DB copy (service
// gak pernah menembak PROD).
const COPY_DB = process.env.E2E_COPY_DB || 'file:/tmp/saas-v3-e2e-floatzone-v2.db'
const PORT = '5099'
const fs = require('fs')
const { execSync, spawn } = require('child_process')
require(REPO + '/node_modules/dotenv').config({ path: REPO + '/.env' })
process.env.DATABASE_URL = COPY_DB
process.env.WA_DISABLED = '1'
process.env.APP_VERSION = 'v4.6.8-floatzone-v2-e2e'

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
// queuedAt diset eksplisit (urutan seq — determinisme FIFO take-next: orderBy
// queuedAt asc, fallback lastMessageAt asc).
// AR-off: AutoReplyConfig default (outsideHoursEnabled=false, greetEnabled=false) —
// seed tenant memang default OFF.
async function mkQueueChat(tenant, label, lastMessageAt, seqIdx) {
  const jid = `e2efz2${mkToken('j')}@s.whatsapp.net`
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
      queuedAt: new Date(Date.now() + (seqIdx ?? 0)), // FIFO key deterministik per fixture
      messages: { create: { tenantId: tenant.id, direction: 'in', content: `pesan uji ${label}`, senderName: label, timestamp: lastMessageAt } },
    },
  })
}
// Simulasi inbound pesan pelanggan (mirroring pool.js upsert existing:
// INSERT message + UPDATE lastMessageAt/preview/unread).
async function simulateIncoming(chat, text, ts) {
  const t = ts || new Date()
  await prisma.message.create({ data: { tenantId: chat.tenantId, chatId: chat.id, direction: 'in', content: text, senderName: chat.contactName || 'Pelanggan', timestamp: t } })
  return prisma.chat.update({ where: { id: chat.id }, data: { lastMessageAt: t, lastMessagePreview: text, unreadCount: { increment: 1 } } })
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
  const env = { ...process.env, PORT, DATABASE_URL: COPY_DB, WA_DISABLED: '1', APP_VERSION: 'v4.6.8-floatzone-v2-e2e' }
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

    // ════ Setup: superadmin + tenant + admin/csA/csB + 10 chat antrean lawas ════
    const sa0 = await prisma.user.findFirst({ where: { role: 'super_admin' } })
    check('K0-a super_admin row ada di copy DB', !!sa0)
    const saPass = process.env.SUPERADMIN_PASSWORD || 'superadmin123'
    await prisma.user.update({ where: { id: sa0.id }, data: { passwordHash: await bcrypt.hash(saPass, 10), status: 'active' } })
    const saLogin = await api('POST', '/api/auth/login', { username: sa0.username, password: saPass })
    check(`K0-b superadmin login status=${saLogin.status}`, saLogin.status === 200 && !!saLogin.data?.token)

    const tName = 'e2e-floatzone2-' + mkToken('t')
    const tenant = await prisma.tenant.create({ data: { name: tName, status: 'active' } })
    const T = tenant.id
    await prisma.tenantPlan.create({ data: { tenantId: T, preset: 'max', featAnalytics: true } })
    const hash = (v) => bcrypt.hashSync(v, 10)
    const adminUser = await prisma.user.create({ data: { username: `adm_fz2_${mkToken('u')}`, passwordHash: hash('adminpass123'), role: 'admin', tenantId: T, status: 'active' } })
    const csA = await prisma.user.create({ data: { username: `csa_fz2_${mkToken('u')}`, passwordHash: hash('csapass123'), role: 'cs', tenantId: T, status: 'active' } })
    const csB = await prisma.user.create({ data: { username: `csb_fz2_${mkToken('u')}`, passwordHash: hash('csbpass123'), role: 'cs', tenantId: T, status: 'active' } })
    const adminLogin = await api('POST', '/api/auth/login', { username: adminUser.username, password: 'adminpass123' })
    const csALogin = await api('POST', '/api/auth/login', { username: csA.username, password: 'csapass123' })
    const csBLogin = await api('POST', '/api/auth/login', { username: csB.username, password: 'csbpass123' })
    check('K0-c login admin+csA+csB (3 token)', adminLogin.status === 200 && csALogin.status === 200 && csBLogin.status === 200)
    const adminTok = adminLogin.data?.token, csATok = csALogin.data?.token, csBTok = csBLogin.data?.token

    // AR-off eksplisit (fixture invariant v0.13.3)
    await prisma.autoReplyConfig.create({ data: { tenantId: T, numberSlot: null, outsideHoursEnabled: false, greetEnabled: false } })
    // 10 chat antrean lawas: P1 (1 jam lalu) … P10 (10 jam lalu) — lawas dgn sengaja,
    // supaya "take naik" terukur vs aktivitas lama (bukan noise same-second).
    const poolChats = []
    for (let i = 1; i <= 10; i++) poolChats.push(await mkQueueChat(tenant, `P${i}`, new Date(Date.now() - i * 3600e3), i - 1))
    const idByName = new Map(poolChats.map((c) => [c.contactName, c.id]))
    const q0 = await api('GET', '/api/chats/queue-count', undefined, adminTok)
    check(`K0-d 10 chat antrean terbentuk (queue-count=${q0.data?.count})`, q0.status === 200 && q0.data?.count === 10, `got=${q0.data?.count}`)

    // ════ Kasus 1 — csA take 5 lawas (FIFO: P1..P5) → take terbaru di atas ════
    const taken = []
    for (let i = 0; i < 5; i++) {
      const r = await api('POST', '/api/chats/take-next', {}, csATok)
      if (r.status !== 200 || r.data?.chat?.id === undefined) { check(`K1-0 take ke-${i + 1} gagal`, false, JSON.stringify(r.data || {}).slice(0, 120)); break }
      taken.push(r.data.chat.id)
    }
    check(`K1-a 5 take sukses FIFO (ids=${taken.join(',')})`, taken.length === 5 && JSON.stringify(taken) === JSON.stringify(poolChats.slice(0, 5).map((c) => c.id)))
    const q1 = await api('GET', '/api/chats/queue-count', undefined, adminTok)
    check(`K1-b queue-count pasca 5 take = 5 — got ${q1.data?.count}`, q1.data?.count === 5)

    const mine0 = await api('GET', '/api/chats?filter=mine', undefined, csATok)
    check(`K1-c GET mine(csA) status=${mine0.status} total ${mine0.data?.chats?.length}`, mine0.status === 200 && mine0.data?.chats?.length === 5)
    const takenIdsSet = new Set(taken)
    check('K1-d kelima chat take tampil di mine(csA)', mine0.data.chats.every((c) => takenIdsSet.has(c.id)))
    check('K1-e field inFloatZone TIDAK ADA lagi di response (v2 clean contract)', !JSON.stringify(mine0.data.chats).includes('inFloatZone'))

    const list0 = mine0.data.chats.map((c) => c.id)
    // urutan = aktivitas terbaru dulu: key tiap chat = take ts (lastMessageAt lawas kalah
    // vs lastAssignedAt) → FIFO take dibalik: take#5 (P5) paling atas.
    const exp0 = [...taken].reverse()
    check('K1-f urutan = take terbaru di atas (P5..P1)', JSON.stringify(list0) === JSON.stringify(exp0), `got=${JSON.stringify(list0)} expect=${JSON.stringify(exp0)}`)
    const mtimes0 = mine0.data.chats.map((c) => new Date(c.lastAssignedAt).getTime())
    check('K1-g lastAssignedAt non-increasing (determinisme batch, tie id desc)', mtimes0.every((m, i) => i === 0 || mtimes0[i - 1] >= m))

    // ════ Kasus 2 — csA reply chat teratas (take#5) → tetap paling atas ════
    const repTarget = list0[0]
    const rr = await api('POST', `/api/chats/${repTarget}/reply`, { content: 'v2 reply take-atas' }, csATok)
    check(`K2-a reply ke take teratas sukses (${rr.status})`, rr.status === 200)
    const fresh2 = await prisma.chat.findUnique({ where: { id: repTarget }, select: { firstResponseAt: true, lastMessageAt: true, lastAssignedAt: true } })
    check('K2-b firstResponseAt terisi (reply manual — invariant v0.13.3: AR gak menyentuh)', !!fresh2.firstResponseAt)
    check('K2-c lastMessageAt reply >= lastAssignedAt (aktivitas = kandidat terbaru)', new Date(fresh2.lastMessageAt).getTime() >= new Date(fresh2.lastAssignedAt).getTime())
    const mine1 = await api('GET', '/api/chats?filter=mine', undefined, csATok)
    const list1 = mine1.data.chats.map((c) => c.id)
    check('K2-d chat tereply TETAP paling atas (lastMessageAt terbaru; tanpa zona)', list1[0] === repTarget, `got=${list1[0]} expect=${repTarget}`)
    const rest1 = list1.slice(1)
    check('K2-e 4 take lain tetap urutan take (regresi: reply gak mengubah posisi relatif lain)', JSON.stringify(rest1) === JSON.stringify(exp0.filter((id) => id !== repTarget)), `got=${JSON.stringify(rest1)}`)
    const mine1Ts = mine1.data.chats.map((c) => Math.max(new Date(c.lastMessageAt).getTime(), new Date(c.lastAssignedAt).getTime()))
    check('K2-f key aktivitas non-increasing sepanjang list (formula tunggal)', mine1Ts.every((m, i) => i === 0 || mine1Ts[i - 1] >= m))

    // ════ Kasus 3 — pelanggan follow-up chat LAMA → naik PALING ATAS (aktivitas menang) ════
    // Target: P1 — take pertama (lastAssignedAt paling tua) + lastMessageAt lawas (-1h)
    // → sebelum follow-up dia di PALING BAWAH list. Follow-up pelanggan (ts sekarang)
    // > semua kandidat take lain → naik ke atas.
    const oldTarget = list1[list1.length - 1]
    const oldChat = await prisma.chat.findUnique({ where: { id: oldTarget }, select: { id: true, tenantId: true, lastAssignedAt: true } })
    const lastAssignOld = new Date(oldChat.lastAssignedAt).getTime()
    await simulateIncoming(oldChat, 'follow-up pelanggan — chat lama bangkit (K1a)')
    const mine2 = await api('GET', '/api/chats?filter=mine', undefined, csATok)
    const list2 = mine2.data.chats.map((c) => c.id)
    check('K3-a follow-up chat LAMA → naik ke PALING ATAS (normalisasi menang atas semua take)', list2[0] === oldTarget, `got=${list2[0]} expect=${oldTarget} list=${JSON.stringify(list2)}`)
    check('K3-b chat tereply K2 tetap tepat di belakangnya (aktivitas #2 terbaru)', list2[1] === repTarget, `got[1]=${list2[1]} expect=${repTarget}`)
    check('K3-c lastAssignedAt chat itu TIDAK berubah (follow-up pelanggan bukan take)', new Date((mine2.data.chats.find((c) => c.id === oldTarget) || {}).lastAssignedAt || 0).getTime() === lastAssignOld)
    check('K3-d unreadCount tercatat naik (badge jalan normal)', (mine2.data.chats.find((c) => c.id === oldTarget) || {}).unreadCount >= 1)

    // ════ Kasus 4 — pelanggan follow-up chat FLOAT (take belum dibalas) — dua sisi ════
    // Float target = chat take yang BELUM dibalas (list2[2] — P5 sudah dibalas K2,
    // P1 sudah difollow-up K3). Sisi 4a: follow-up pelanggan (lastMessageAt >
    // lastAssignedAt-nya sendiri → naik ke paling atas); LALU agent take chat
    // antrean lain → lastAssignedAtnya lebih baru → take menang, float-chat turun
    // di bawahnya. Sisi 4b: follow-up SEKARANG → lebih baru dari semua kandidat →
    // naik paling atas lagi. (Formula menang-terbaru diuji dua arah.)
    const floatTarget = list2[2] // chat take belum dibalas (paling atas di antara float)
    const fpos0 = list2.indexOf(floatTarget)
    const ft = await prisma.chat.findUnique({ where: { id: floatTarget }, select: { id: true, tenantId: true, contactName: true } })
    // 4a-1 — follow-up float (ts sekarang) → lastMessageAt > semua kandidat saat ini
    await simulateIncoming(ft, 'follow-up float — kejar pelanggan')
    const minePre = await api('GET', '/api/chats?filter=mine', undefined, csATok)
    const listPre = minePre.data.chats.map((c) => c.id)
    check('K4-pre float follow-up (lastMessageAt > lastAssignedAt-nya sendiri & semua kandidat) → PALING ATAS', listPre[0] === floatTarget, `got=${listPre[0]} expect=${floatTarget} list=${JSON.stringify(listPre)}`)
    // 4a-2 — take chat antrean lain (lastAssignedAt lebih baru dari follow-up ts)
    await sleep(150) // jaminan timestamp take > timestamp follow-up ts
    const takeR = await api('POST', '/api/chats/take-next', {}, csATok)
    const takenNew = takeR.data?.chat?.id
    check(`K4-a-take take chat antrean sukses (${takeR.status}, id=${takenNew})`, takeR.status === 200 && !!takenNew && !takenIdsSet.has(takenNew))
    const mine3 = await api('GET', '/api/chats?filter=mine', undefined, csATok)
    const list3 = mine3.data.chats.map((c) => c.id)
    const iNew = list3.indexOf(takenNew)
    const iFloat = list3.indexOf(floatTarget)
    check('K4-a take terbaru (lastAssignedAt lebih baru dari lastMessageAt float) menang — float-chat turun di bawahnya', iNew > -1 && iNew < iFloat, `idx take=${iNew} idx float=${iFloat} list=${JSON.stringify(list3)}`)
    // 4b — follow-up SEKARANG → paling baru dari semua kandidat → naik paling atas
    await sleep(150) // jaminan timestamp follow-up > timestamp take ts
    await simulateIncoming(ft, 'follow-up float — sekarang (paling baru)')
    const mine3b = await api('GET', '/api/chats?filter=mine', undefined, csATok)
    const list3b = mine3b.data.chats.map((c) => c.id)
    check('K4-b float follow-up (lastMessageAt > semua kandidat) naik PALING ATAS (dua sisi)', list3b[0] === floatTarget, `got=${list3b[0]} expect=${floatTarget} list=${JSON.stringify(list3b)}`)

    // ════ Kasus 5 — csB isolasi ════
    const oldTs = new Date(Date.now() - 48 * 3600e3)
    const b1 = await prisma.chat.create({
      data: { tenantId: T, waJid: `e2efz2b1${mkToken('b1')}@s.whatsapp.net`, contactPhone: '628119994' + String(Math.floor(Math.random() * 90 + 10)), contactName: 'CSB-1', status: 'open', assignedToId: csB.id, lastAssignedAt: oldTs, firstAssignedAt: oldTs, lastMessageAt: oldTs, unreadCount: 1, messages: { create: { tenantId: T, direction: 'in', content: 'csb-1 lawas', senderName: 'CSB-1', timestamp: oldTs } } },
    })
    const b2 = await prisma.chat.create({
      data: { tenantId: T, waJid: `e2efz2b2${mkToken('b2')}@s.whatsapp.net`, contactPhone: '628119995' + String(Math.floor(Math.random() * 90 + 10)), contactName: 'CSB-2', status: 'open', assignedToId: csB.id, lastAssignedAt: new Date(oldTs.getTime() + 60e3), firstAssignedAt: oldTs, lastMessageAt: new Date(oldTs.getTime() + 60e3), unreadCount: 1, messages: { create: { tenantId: T, direction: 'in', content: 'csb-2 lawas', senderName: 'CSB-2', timestamp: new Date(oldTs.getTime() + 60e3) } } },
    })
    await api('POST', `/api/chats/${b2.id}/reply`, { content: 'csb-2 replied' }, csBTok)
    const mineB0 = await api('GET', '/api/chats?filter=mine', undefined, csBTok)
    const mineBIds = mineB0.data.chats.map((c) => c.id)
    // csB: b2 tereply (lastMessageAt baru) → di atas; b1 lawas di bawah (lastMessageAt desc)
    const expB = new Date(b2.lastMessageAt).getTime() > new Date(b1.lastMessageAt).getTime() ? [b2.id, b1.id] : [b1.id, b2.id]
    check(`K5-a mine(csB) = urutan aktivitas sendiri (got ${JSON.stringify(mineBIds)})`, JSON.stringify(mineBIds) === JSON.stringify(expB))
    check('K5-b isolasi csB: tidak ada chat csA bocor ke list csB', mineB0.data.chats.every((c) => !takenIdsSet.has(c.id)))
    const mineA0 = await api('GET', '/api/chats?filter=mine', undefined, csATok)
    check('K5-c isolasi csA: tidak ada chat csB bocor ke list csA', mineA0.data.chats.every((c) => c.id !== b1.id && c.id !== b2.id))
    check('K5-d response csB juga tanpa inFloatZone', !JSON.stringify(mineB0.data.chats).includes('inFloatZone'))

    // ════ Kasus 6 — Admin "All" normal (regresi) ════
    const allList = await api('GET', '/api/chats?filter=all', undefined, adminTok)
    const normalAllTs = allList.data.chats.filter((c) => c.status === 'open').map((c) => new Date(c.lastMessageAt).getTime())
    check(`K6-a admin "All" urutan lastMessageAt desc (${allList.data.chats.length} chat)`, normalAllTs.every((m, i) => i === 0 || normalAllTs[i - 1] >= m), JSON.stringify(normalAllTs.slice(0, 10)))
    check('K6-b admin "All" tanpa inFloatZone (regresi kontrak)', !JSON.stringify(allList.data.chats).includes('inFloatZone'))

    // ════ Kasus 7 — Badge overlap (markup FE): nama flex-1 min-w-0 truncate + badge shrink-0 ════
    // Assert dari source + bundle ter-build (screenshot visual manual via Chrome 18801,
    // disimpan di docs/qa-v4.6.8-*.jpg — lihat docs/qa-v4.6.8-floatzone-v2.md).
    const paneSrc = fs.readFileSync(REPO + '/frontend/src/views/ChatListPane.vue', 'utf8')
    check('K7-a ChatListPane: nama kontak = flex-1 min-w-0 truncate', /'text-sm truncate flex-1 min-w-0'/.test(paneSrc) && !paneSrc.includes('inFloatZone'))
    check('K7-b ChatListPane: badge unread ada di kolom kanan shrink-0', /chat\.unreadCount > 0" class="[^"]*shrink-0/.test(paneSrc))
    check('K7-c ChatListPane: kolom kanan (timestamp/badge) shrink-0 (tidak pernah tumbuh ke kiri)', /class="flex flex-col items-end gap-1 ml-2 shrink-0"/.test(paneSrc))
    // Bundle ter-build (public/assets) — chip lama harus sudah hilang dari produksi build
    const distAssets = fs.existsSync(REPO + '/public/assets') ? fs.readdirSync(REPO + '/public/assets').filter((f) => f.endsWith('.js')) : []
    let builtHasFloat = false
    for (const f of distAssets) {
      const content = fs.readFileSync(REPO + '/public/assets/' + f, 'utf8')
      if (content.includes('inFloatZone')) { builtHasFloat = true; break }
    }
    check('K7-d bundle ter-build (public/assets) TIDAK mengandung inFloatZone', distAssets.length > 0 && !builtHasFloat, distAssets.length > 0 ? 'assets found' : 'assets kosong — build FE belum dijalankan')
    check('K7-e bundle ter-build membawa layout fix (nama shrinkable + badge non-shrink)', distAssets.length > 0 && distAssets.some((f) => { const s = fs.readFileSync(REPO + '/public/assets/' + f, 'utf8'); return s.includes('truncate flex-1 min-w-0') || s.includes('flex-1 min-w-0'); }))

    // ════ Kasus 8 — Regresi: FIFO take + AR invariant + search-all + analytics ════
    // queue sisa: P7..P10 (4 — P6 sudah di-take K4a) → habiskan via take-next
    // (FIFO urut queuedAt asc = urutan fixture).
    const fifoIds = []
    for (;;) {
      const r = await api('POST', '/api/chats/take-next', {}, csATok)
      if (r.status !== 200 || !r.data?.chat?.id) break
      fifoIds.push(r.data.chat.id)
    }
    const q2 = await api('GET', '/api/chats/queue-count', undefined, adminTok)
    check(`K8-a take-FIFO habis (queue-count=0) — got ${q2.data?.count}`, q2.data?.count === 0 && fifoIds.length === 4, `fifoIds=${JSON.stringify(fifoIds)}`)
    check('K8-b FIFO order = P7..P10 (urutan antrean dipertahankan)', JSON.stringify(fifoIds) === JSON.stringify(poolChats.slice(6).map((c) => c.id)), `got=${JSON.stringify(fifoIds)}`)
    // invariant AR (v0.13.3): firstResponseAt HANYA dari reply manual — di list csA
    // sekarang 10 chat; yang punya firstResponseAt hanya take#5 (K2) — AR take gak
    // pernah set firstResponseAt/lastMessageAt.
    const mineAr = await api('GET', '/api/chats?filter=mine', undefined, csATok)
    const withFirstResp = mineAr.data.chats.filter((c) => c.firstResponseAt)
    check('K8-c invariant AR: firstResponseAt hanya 1 (reply manual K2; take/AR tidak mengisi)', withFirstResp.length === 1 && withFirstResp[0].id === repTarget, `got=${withFirstResp.map((c) => c.id).join(',')}`)
    // search-all sanity (jalur non-mine — tidak terpengaruh)
    const sAll = await api('GET', `/api/chats/search-all?q=P1`, undefined, csATok)
    check(`K8-d search-all sanity 200 (${sAll.status})`, sAll.status === 200)
    const sMine = await api('GET', `/api/chats/search-all?q=CSB-1`, undefined, csATok)
    check('K8-e search-all CS TIDAK bocor chat tenant lain/CS lain (CSB-1 gak muncul)', sMine.status === 200 && !JSON.stringify(sMine.data).includes('CSB-1'))
    const ana = await api('GET', '/api/analytics/overview?range=7d', undefined, adminTok)
    check(`K8-f analytics sanity 200 (plan Max) — got ${ana.status}`, ana.status === 200)
    const anaS = await api('GET', '/api/analytics/overview?range=7d', undefined, csATok)
    check(`K8-g analytics role-gate CS = 403 unchanged by design (got ${anaS.status})`, anaS.status === 403)

    // ── EPILOG ──
    console.log(`\n=== v4.6.8 floatzone-v2 e2e: ${pass} PASS / ${fails.length} FAIL (${((Date.now() - t0) / 1000).toFixed(1)}s) ===`)
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