#!/usr/bin/env node
/**
 * E2E — v4.6.9 Auto-reply C+A: outside-hours dapet jalur & marker sendiri
 * (spec docs/spec-v4.6.9-outside-priority.md §D4 — APPROVED 2026-10-10 09:20).
 *
 * Origin kasus BITE ME chat=11810 tenant-10 (wa.labparahita.co.id): 15:32 chat masuk
 * → take CS 53 detik + CS balas manual → 16:13 pelanggan kejar (SUDAH luar jam
 * MonFri=16:00) → auto tidak jalan (gate hasHumanOutMessageToday mem-blok ALL
 * auto-reply sekali sehari) → pelanggan sunyi → marah. v4.6.9:
 *   (C) human-out skip HANYA di dalam jam kerja; outside → away tetap keluar.
 *   (A) marker/kuota TERPISAH: jalur outside klaim Chat.lastAutoOutDate (kolom
 *       ADDITIVE baru), greeting tetap lastAutoGreetDate — 1×/hari masing-masing.
 *
 * Jalur copy-DB :5099 (WA_DISABLED=1 + E2E_OK_SEND=1 send-sukses-mock +
 * E2E_DEBUG_INBOUND=1 jalur runtime asli via /api/wa/inbound) — produksi
 * (5047/5062) TIDAK tersentuh. Pola: scripts/e2e-v468-floatzone-v2.cjs
 * (copy DB + reset superadmin + login API + self-boot; server child di-kill
 * di akhir run) + maybeAutoReply IN-PROCESS ala scripts/e2e-v430.cjs.
 * SYARAT: `npx prisma generate` sudah jalan di repo (client aware kolom
 * lastAutoOutDate — dipakai select/update di suite ini).
 *
 * 10 kasus (§D4):
 *  1  Migrasi ADD-ONLY: kolom lastAutoOutDate ada; row Chat utuh; db push ulang =
 *     no-op; DDL share (ALTER manual) jalan di copy kedua tanpa loss
 *  2  Replika BITE ME: pesan 15:32 dalam-jam + human-out CS (fixture) → chat
 *     resolved → pesan 16:13 luar-jam via jalur RUNTIME ASLI → auto-reopen →
 *     AWAY TERKIRIM + lastAutoOutDate=today + lastAutoGreetDate TIDAK berubah
 *  3  Anti-spam outside: pesan lagi (masih luar jam, hari sama) → TIDAK ada away ke-2
 *  4  Greeting 1× + outside 1× di hari sama (pertanyaan eksplisit Kanaka §K2):
 *     DUA-DUANYA keluar via jalur runtime asli dua arah waktu; marker terpisah
 *  5  Kebalikan 4: outside dulu (19:00) → dalam-jam (10:00) → greeting keluar juga
 *     (marker greeting bebas dari OUT — IN-PROCESS, dbTimestamp di-inject ala v430)
 *  6  Skip human-out di dalam jam TETAP: CS human-out dulu → pesan in-hours →
 *     tanpa auto + marker greeting di-set (unchanged v3.5)
 *  7  AR invariant + purge: away tidak mengisi firstResponseAt; purge (jalur asli)
 *     reset KEDUA marker; search-all/analytics sanity
 *  8  CB-AI outside: plan ✓ + mode cbai + AiConfig offline (NO_CONFIG) → reserve
 *     revert + guard-fail → jalur lama PERSIS → away via klaim OUT (1×), pesan
 *     ke-2 → claim OUT blokir (TIDAK dobel); CB-AI sendiri tidak nyentuh marker
 *  9  Send gagal → revert lastAutoOutDate SAJA (mock pool fail di process test;
 *     { marker: 'out' }) → greeting tetap utuh & pesan berikutnya dapat away lagi
 * 10  Regresi: jalur menu (b) + repeatAllows + MenuGateway TIDAK berubah (in-suite)
 *     + regresi penuh suite lama dijalankan terpisah (lihat docs/qa-v4.6.9-outside.md §5)
 */
const REPO = '/home/kanakxxx/.openclaw/workspace/wa-cs-hub-saas-v3'
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:5099'
// KRITIS (lesson v4.1.x / v4.6.8): .env berisi DATABASE_URL PROD (ABSOLUTE path) →
// DATABASE_URL dipaksa ke copy SETELAH dotenv — seluruh proses satu DB copy (service
// gak pernah menembak PROD).
const COPY_DB = process.env.E2E_COPY_DB || 'file:/tmp/saas-v3-e2e-v469.db'
const PORT = '5099'
const fs = require('fs')
const { execSync, spawn } = require('child_process')
require(REPO + '/node_modules/dotenv').config({ path: REPO + '/.env' })
process.env.DATABASE_URL = COPY_DB
// v4.3.0 lesson — .env produksi berisi WA_DISABLED=0; suite ini memanggil
// maybeAutoReply IN-PROCESS (runtime asli) → WA stub E2E WAJIB override SETELAH dotenv
process.env.WA_DISABLED = '1'
process.env.E2E_OK_SEND = '1'
process.env.E2E_DEBUG_INBOUND = '1'
process.env.APP_VERSION = 'v4.6.9-outside-e2e'

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

// ─── Fixture helpers ─────────────────────────────────────────────────────
// Chat baru dgn Contact row (pola seedChat v430) + pesan inbound pertama.
let nSeq = 4690
async function seedChat(tenantId, name, { slot = 0 } = {}) {
  let jid
  for (;;) {
    jid = `62899146${String(nSeq++).padStart(4, '0')}@s.whatsapp.net`
    const ex = await prisma.chat.findUnique({ where: { tenantId_numberSlot_waJid: { tenantId, numberSlot: slot, waJid: jid } } })
    if (!ex) break
  }
  const chat = await prisma.chat.create({
    data: {
      tenantId, numberSlot: slot, waJid: jid, contactPhone: jid.slice(0, 12), contactName: name,
      status: 'open', assignedToId: null, queuedAt: new Date(), unreadCount: 1,
      lastMessageAt: new Date(), lastMessagePreview: 'halo',
      messages: { create: { tenantId, direction: 'in', content: 'halo', senderName: name, timestamp: new Date() } },
    },
  })
  await prisma.contact.create({ data: { tenantId, chatId: chat.id, name, phone: jid.slice(0, 12), source: 'chat' } })
  return chat
}
// Pesan out manual dari CS manusia (bukan auto) — trigger gate human-out v3.5.
async function addHumanOut(chat, csUser, text, ts) {
  const t = ts || new Date()
  return prisma.message.create({
    data: {
      tenantId: chat.tenantId, chatId: chat.id, direction: 'out',
      content: text, senderName: 'CS E2E', senderId: csUser.id, isAuto: false,
      timestamp: t, status: 'sent',
    },
  })
}
// Pesan inbound pelanggan (mirror pool upsert existing) — dipakai sbg dasar fixture.
async function addIncoming(chat, text, ts) {
  const t = ts || new Date()
  await prisma.message.create({ data: { tenantId: chat.tenantId, chatId: chat.id, direction: 'in', content: text, senderName: chat.contactName || 'Pelanggan', timestamp: t } })
  return prisma.chat.update({ where: { id: chat.id }, data: { lastMessageAt: t, lastMessagePreview: text, unreadCount: { increment: 1 } } })
}
// msg baileys minimal utk maybeAutoReply IN-PROCESS (dbTimestamp = messageTimestamp).
function mkMsg(ts) {
  return { messageTimestamp: Math.floor(ts.getTime() / 1000), message: { conversation: 'halo?' }, pushName: '' }
}
// Jalur RUNTIME ASLI via POST /api/wa/inbound (superadmin-only + E2E_DEBUG_INBOUND=1):
// pool.processIncomingMessage → upsert/reopen → hook maybeAutoReply (fire-and-forget).
async function inboundViaRuntime(chat, text, ts, saTok) {
  const msg = {
    key: { remoteJid: chat.waJid, fromMe: false, id: 'E2E469-' + mkToken('m') },
    pushName: chat.contactName || 'Pelanggan',
    messageTimestamp: Math.floor(ts.getTime() / 1000),
    message: { conversation: text },
  }
  return api('POST', '/api/wa/inbound', { tenantId: chat.tenantId, slot: chat.numberSlot || 0, messages: msg }, saTok)
}
// Tunggu hook fire-and-forget selesai (marker OUT ter-set) ATAU settle-delay.
async function waitOutMarker(chatId, expect, timeoutMs = 5000) {
  const t0 = Date.now()
  for (;;) {
    const c = await prisma.chat.findUnique({ where: { id: chatId }, select: { lastAutoOutDate: true, lastAutoGreetDate: true } })
    if (expect === 'out' && c.lastAutoOutDate) return c
    if (expect !== 'out' && Date.now() - t0 > timeoutMs) return c
    if (Date.now() - t0 > timeoutMs) return c
    await sleep(120)
  }
}
// Tunggu N auto out-message terkirim (hook fire-and-forget — marker bisa ter-set
// SEBELUM Message row selesai di-insert; lesson run1 K4-d).
async function waitAutoCount(chatId, minCount, timeoutMs = 5000) {
  const t0 = Date.now()
  for (;;) {
    const msgs = await autoOutMessages(chatId)
    if (msgs.length >= minCount) return msgs
    if (Date.now() - t0 > timeoutMs) return msgs
    await sleep(100)
  }
}
async function autoOutMessages(chatId) {
  const rows = await prisma.message.findMany({ where: { chatId, direction: 'out', isAuto: true }, orderBy: { id: 'asc' } })
  return rows.map((r) => ({ id: r.id, text: decryptTextSafe(r.content) }))
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
  const env = { ...process.env, PORT, DATABASE_URL: COPY_DB, WA_DISABLED: '1', E2E_OK_SEND: '1', E2E_DEBUG_INBOUND: '1', APP_VERSION: 'v4.6.9-outside-e2e' }
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
  const autoSvc = require(REPO + '/src/services/autoReply')
  const plansSvc = require(REPO + '/src/services/plans')
  try {
    await bootServerIfNeeded()
    if (fails.length) {
      console.error('BOOT GAGAL — output server:\n' + (serverChild?.__out ? serverChild.__out().slice(-2000) : 'n/a'))
      return
    }

    // ════ Setup: superadmin + tenant fixture + CS/admin + AR config ════
    const sa0 = await prisma.user.findFirst({ where: { role: 'super_admin' } })
    check('S0-b super_admin row ada di copy DB', !!sa0)
    const saPass = process.env.SUPERADMIN_PASSWORD || 'superadmin123'
    await prisma.user.update({ where: { id: sa0.id }, data: { passwordHash: await bcrypt.hash(saPass, 10), status: 'active' } })
    const saLogin = await api('POST', '/api/auth/login', { username: sa0.username, password: saPass })
    check(`S0-c superadmin login status=${saLogin.status}`, saLogin.status === 200 && !!saLogin.data?.token)
    const saTok = saLogin.data?.token

    const tName = 'e2e-v469-' + mkToken('t')
    const tenant = await prisma.tenant.create({ data: { name: tName, status: 'active' } })
    const T = tenant.id
    await prisma.tenantPlan.create({ data: { tenantId: T, preset: 'max', featAnalytics: true } })
    const hash = (v) => bcrypt.hashSync(v, 10)
    const csUser = await prisma.user.create({ data: { username: `cs_469_${mkToken('u')}`, passwordHash: hash('cspass123'), role: 'cs', tenantId: T, status: 'active' } })
    const admUser = await prisma.user.create({ data: { username: `adm_469_${mkToken('u')}`, passwordHash: hash('admpass123'), role: 'admin', tenantId: T, status: 'active' } })
    const admLogin = await api('POST', '/api/auth/login', { username: admUser.username, password: 'admpass123' })
    check('S0-d admin tenant fixture login', admLogin.status === 200 && !!admLogin.data?.token)

    // AR config tenant fixture (shared) — jendela kerja 08:00-16:00 untuk SEMUA tipe
    // hari (PERSIS kasus BITE ME tenant-10 MonFri=16:00; sat/sun disamakan supaya
    // suite deterministik dijalankan hari apa pun — 15:32 dalam-jam, 16:13 luar-jam).
    const WORK_WINDOWS = {
      monFriEnabled: true, monFriStart: '08:00', monFriEnd: '16:00',
      satEnabled: true, satStart: '08:00', satEnd: '16:00',
      sunEnabled: true, sunStart: '08:00', sunEnd: '16:00',
    }
    const ALWAYS_IN = {
      monFriEnabled: true, monFriStart: '00:00', monFriEnd: '23:59',
      satEnabled: true, satStart: '00:00', satEnd: '23:59',
      sunEnabled: true, sunStart: '00:00', sunEnd: '23:59',
    }
    const NARROW = {
      monFriEnabled: true, monFriStart: '09:00', monFriEnd: '10:00',
      satEnabled: true, satStart: '09:00', satEnd: '10:00',
      sunEnabled: true, sunStart: '09:00', sunEnd: '10:00',
    }
    const AR_ROW = { tenantId: T, numberSlot: null }
    // Catatan: compound unique tenantId_numberSlot TIDAK bisa dipakai utk update bila
    // numberSlot=null (Prisma 5 menolak null) → pola findFirst+update-by-id (v430).
    async function arUpdate(data) {
      const row = await prisma.autoReplyConfig.findFirst({ where: { tenantId: T, numberSlot: null }, select: { id: true } })
      await prisma.autoReplyConfig.update({ where: { id: row.id }, data })
      autoSvc.invalidateConfig(T) // proses test — server child hanya dipakai dgn config awal
      require(REPO + '/src/services/menuGateway').invalidateConfig(T) // v430 lesson — cache MG juga
    }
    await prisma.autoReplyConfig.create({
      data: {
        ...AR_ROW,
        outsideHoursEnabled: true, outsideHoursText: 'Away E2E469 — di luar jam kerja. 🙏',
        greetEnabled: true, greetMode: 'text', greetText: 'Greet E2E469 — selamat datang!',
        repeatFrequency: 'per_chat',
        ...WORK_WINDOWS,
      },
    })
    autoSvc.invalidateConfig(T)
    check('S0-e AR config fixture (outside text + greet text + jendela 8-16 semua hari)', true)

    // Timestamp uji (WIB eksplisit — host bebas timezone): hari kalender WIB "sekarang".
    const todayStr = autoSvc.wibDateString(new Date())
    const [yy, mm, dd] = todayStr.split('-').map(Number)
    const W = (h, m) => new Date(Date.UTC(yy, mm - 1, dd, h - 7, m, 0)) // WIB→UTC (-7)
    const ts1532Wib = W(15, 32), ts1533Wib = W(15, 33), ts1613Wib = W(16, 13), ts1616Wib = W(16, 16)
    const ts1000Wib = W(10, 0), ts1900Wib = W(19, 0), ts1910Wib = W(19, 10), ts1930Wib = W(19, 30), ts1100Wib = W(11, 0)

    // ── Kasus 1 — Migrasi ADD-ONLY (§D4.1) ──
    const cols = await prisma.$queryRawUnsafe(`SELECT name FROM pragma_table_info('Chat')`)
    const colNames = cols.map((c) => c.name)
    check('K1-a kolom BARU lastAutoOutDate ada di tabel Chat (db push additive)', colNames.includes('lastAutoOutDate'))
    const chatCnt0 = await prisma.chat.count()
    const greetCnt0 = await prisma.chat.count({ where: { lastAutoGreetDate: { not: null } } })
    check('K1-b data existing utuh (72+ rows Chat; marker lama tetap terbaca)', chatCnt0 >= 72 && greetCnt0 >= 0, `chatCount=${chatCnt0} greetMarked=${greetCnt0}`)
    const oldCols = ['id', 'tenantId', 'waJid', 'lastAutoGreetDate', 'menuState', 'aiReplyCount', 'lastHandoffNotifiedAt']
    check('K1-c kolom lama inti masih ada (tidak ada yang hilang)', oldCols.every((c) => colNames.includes(c)))
    {
      // db push ulang pada copy yang sama = no-op (idempoten; tanpa data loss)
      execSync('npx prisma db push --skip-generate', { cwd: REPO, env: process.env, stdio: 'ignore', timeout: 120000 })
      const after = await prisma.chat.count()
      const cols2 = (await prisma.$queryRawUnsafe(`SELECT name FROM pragma_table_info('Chat')`)).map((c) => c.name)
      check('K1-d migrate ulang = no-op (row count sama + kolom tetap)', after === chatCnt0 && cols2.includes('lastAutoOutDate'), `rows ${chatCnt0}→${after}`)

      // DDL share (pola IT): ALTER manual di DB fresh-copy kedua → sukses, rows utuh.
      const altPath = COPY_DB.replace('file:', '') + '.ddl-test'
      for (const p of [altPath, altPath + '-wal', altPath + '-shm']) { try { fs.unlinkSync(p) } catch {} }
      fs.copyFileSync(REPO + '/prisma/data/saas-v3.db', altPath)
      const altPrisma = new PrismaClient({ datasourceUrl: 'file:' + altPath, log: ['error'] })
      await altPrisma.$executeRawUnsafe(`ALTER TABLE "Chat" ADD COLUMN "lastAutoOutDate" TEXT;`)
      const altCnt = await altPrisma.chat.count()
      await altPrisma.$disconnect()
      check(`K1-e DDL share (ALTER TABLE "Chat" ADD COLUMN "lastAutoOutDate" TEXT) jalan manual di copy kedua — ${altCnt} rows utuh`, altCnt === chatCnt0)
      for (const p of [altPath, altPath + '-wal', altPath + '-shm']) { try { fs.unlinkSync(p) } catch {} }
    }

    // ── Kasus 2 — Replika BITE ME (§D4.2) ──
    // Timeline: 15:32 pesan masuk (dalam jam) [fixture] → CS balas manual 15:33
    // (human-out fixture — persis karakter pesan CS: non-auto + senderId) → chat
    // resolved (CS selesai) → 16:13 pelanggan kejar (LUAR jam) via jalur RUNTIME
    // ASLI → auto-reopen (unbind → antre) → hook maybeAutoReply → AWAY (v4.6.9 C).
    const bite = await seedChat(T, 'BITE ME e2e469')
    await addIncoming(bite, 'halo ada stok?', ts1532Wib)
    const humanMsg = await addHumanOut(bite, csUser, 'Halo, kak! Stok tersedia kak.', ts1533Wib)
    await prisma.chat.update({ where: { id: bite.id }, data: { status: 'resolved', assignedToId: csUser.id, resolvedAt: ts1533Wib, firstAssignedAt: ts1533Wib, lastAssignedAt: ts1533Wib } })
    check('K2-a fixture: human-out CS 15:33 (non-auto + senderId) + chat resolved — kondisi pra-16:13', !!humanMsg && humanMsg.isAuto === false && humanMsg.senderId === csUser.id)
    const rIn = await inboundViaRuntime(bite, 'kok gak dibalas?? 😠', ts1613Wib, saTok)
    check(`K2-b inbound jalur asli 16:13 WIB sukses (${rIn.status}, chatId=${rIn.data?.chatId})`, rIn.status === 200 && rIn.data?.chatId === bite.id)
    await waitOutMarker(bite.id, 'out')
    const biteReopen = await prisma.chat.findUnique({ where: { id: bite.id }, select: { status: true, assignedToId: true, reopenedCount: true, firstResponseAt: true } })
    check('K2-c auto-reopen jalan (status open + unassigned — state yang memicu AR)', biteReopen.status === 'open' && biteReopen.assignedToId === null && (biteReopen.reopenedCount || 0) >= 1, JSON.stringify(biteReopen))
    const biteAuto = await waitAutoCount(bite.id, 1)
    check('K2-d (C) AWAY TERKIRIM di luar jam walau CS sudah human-out hari itu', biteAuto.length === 1 && biteAuto[0].text.includes('Away E2E469'), JSON.stringify(biteAuto.map((m) => m.text)))
    const biteFresh = await prisma.chat.findUnique({ where: { id: bite.id }, select: { lastAutoOutDate: true, lastAutoGreetDate: true } })
    check('K2-e (A) marker OUT = today + lastAutoGreetDate TIDAK berubah (tetap NULL)', biteFresh.lastAutoOutDate === todayStr && (biteFresh.lastAutoGreetDate ?? null) === null, JSON.stringify(biteFresh))
    check('K2-f invariant AR: away tidak mengisi firstResponseAt (hanya reply manual)', biteReopen.firstResponseAt === null)

    // ── Kasus 3 — Anti-spam outside (§D4.3) ──
    const rIn2 = await inboundViaRuntime(bite, 'halo?? tolong bales', ts1616Wib, saTok)
    check(`K3-a inbound ke-2 (16:16 WIB) sukses (${rIn2.status})`, rIn2.status === 200)
    await waitAutoCount(bite.id, 2, 2500) // beri kesempatan away (salah) ke-2 muncul bila ada bug
    const biteAuto2 = await autoOutMessages(bite.id)
    check('K3-b anti-spam OUT: TIDAK ada away kedua hari yang sama (klaim lastAutoOutDate blokir)', biteAuto2.length === 1, `autoOut count=${biteAuto2.length}`)
    const biteFresh3 = await prisma.chat.findUnique({ where: { id: bite.id }, select: { lastAutoOutDate: true, lastAutoGreetDate: true } })
    check('K3-c marker OUT unchanged (today) + greeting marker tetap kosong', biteFresh3.lastAutoOutDate === todayStr && (biteFresh3.lastAutoGreetDate ?? null) === null)

    // ── Kasus 4 — Greeting 1× + outside 1× di hari sama = DUA-DUANYA (§D4.4, §K2) ──
    const duo = await seedChat(T, 'Duo e2e469 (greet+out)')
    // 4a — pesan DALAM jam (10:00 WIB) → greet text keluar (jalur (c), marker greeting):
    const rDuo1 = await inboundViaRuntime(duo, 'pagi kak', ts1000Wib, saTok)
    check(`K4-a inbound dalam-jam 10:00 WIB sukses (${rDuo1.status})`, rDuo1.status === 200)
    const duoAuto1 = await waitAutoCount(duo.id, 1)
    const duoFresh1 = await prisma.chat.findUnique({ where: { id: duo.id }, select: { lastAutoGreetDate: true, lastAutoOutDate: true } })
    check('K4-b greet text terkirim dalam-jam (jalur (c)) + marker greeting = today + OUT tetap NULL', duoAuto1.length === 1 && duoAuto1[0].text.includes('Greet E2E469') && duoFresh1.lastAutoGreetDate === todayStr && (duoFresh1.lastAutoOutDate ?? null) === null, JSON.stringify({ msgs: duoAuto1.map((m) => m.text), ...duoFresh1 }))
    // 4b — pesan LUAR jam (19:00 WIB) hari SAMA → away text keluar (klaim marker OUT):
    const rDuo2 = await inboundViaRuntime(duo, 'masih ada?', ts1900Wib, saTok)
    check(`K4-c inbound luar-jam 19:00 WIB (hari sama) sukses (${rDuo2.status})`, rDuo2.status === 200)
    const duoAuto2 = await waitAutoCount(duo.id, 2)
    check('K4-d DUA-DUANYA keluar di hari sama: greet (10:00) + away (19:00) — kuota terpisah §K2', duoAuto2.length === 2 && duoAuto2[0].text.includes('Greet E2E469') && duoAuto2[1].text.includes('Away E2E469'), JSON.stringify(duoAuto2.map((m) => m.text)))
    const duoFresh2 = await prisma.chat.findUnique({ where: { id: duo.id }, select: { lastAutoGreetDate: true, lastAutoOutDate: true } })
    check('K4-e marker terpisah final: greeting = today + OUT = today', duoFresh2.lastAutoGreetDate === todayStr && duoFresh2.lastAutoOutDate === todayStr, JSON.stringify(duoFresh2))
    // 4c — pesan luar-jam SEKALI lagi → anti-spam OUT (tidak ada away ke-2):
    await inboundViaRuntime(duo, 'halo', ts1910Wib, saTok)
    await waitAutoCount(duo.id, 3, 2500) // beri kesempatan away ke-3 muncul bila ada bug
    const duoAuto3 = await autoOutMessages(duo.id)
    check('K4-f anti-spam OUT di chat duo (tetap 2 auto message)', duoAuto3.length === 2, `count=${duoAuto3.length}`)

    // ── Kasus 5 — Kebalikan 4 (§D4.5): outside dulu → dalam-jam → greeting tetap keluar ──
    // IN-PROCESS dgn dbTimestamp di-inject (pola v430 — time-dependence terkontrol).
    const rev = await seedChat(T, 'Rev e2e469 (out dulu, greet next)')
    await arUpdate(NARROW)
    const r1 = await autoSvc.maybeAutoReply(await prisma.chat.findUnique({ where: { id: rev.id }, include: { contact: true } }), mkMsg(ts1900Wib))
    const revFresh1 = await prisma.chat.findUnique({ where: { id: rev.id }, select: { lastAutoOutDate: true, lastAutoGreetDate: true } })
    check('K5-a outside dulu (19:00, jendela 9-10) → away keluar + marker OUT = today, greeting tetap kosong', r1?.sent === true && revFresh1.lastAutoOutDate === todayStr && (revFresh1.lastAutoGreetDate ?? null) === null, JSON.stringify({ sent: r1?.sent, ...revFresh1 }))
    await arUpdate(ALWAYS_IN)
    const r2 = await autoSvc.maybeAutoReply(await prisma.chat.findUnique({ where: { id: rev.id }, include: { contact: true } }), mkMsg(ts1000Wib))
    const revAutoAfter = await autoOutMessages(rev.id)
    check('K5-b dalam-jam → greeting JUGA keluar walau OUT sudah terpakai hari itu (kebalikan §D4.4)', r2?.sent === true && revAutoAfter.length === 2 && revAutoAfter[1].text.includes('Greet E2E469'), JSON.stringify(revAutoAfter.map((m) => m.text)))

    // ── Kasus 6 — Skip human-out DI DALAM jam TETAP (§D4.6 — unchanged v3.5) ──
    const chatB = await seedChat(T, 'ChatB e2e469 (in-hours human-out skip)')
    await addHumanOut(chatB, csUser, 'CS bales duluan di chat B', ts1100Wib)
    const rB = await autoSvc.maybeAutoReply(await prisma.chat.findUnique({ where: { id: chatB.id }, include: { contact: true } }), mkMsg(ts1100Wib))
    const chatBFresh = await prisma.chat.findUnique({ where: { id: chatB.id }, select: { lastAutoGreetDate: true, lastAutoOutDate: true } })
    const chatBAuto = await autoOutMessages(chatB.id)
    check('K6-a dalam-jam + CS human-out → TANPA auto (skip v3.5 unchanged)', rB?.sent === false && chatBAuto.length === 0)
    check('K6-b marker greeting DI-SET oleh skip (behavior existing) + marker OUT tidak disentuh', chatBFresh.lastAutoGreetDate === todayStr && (chatBFresh.lastAutoOutDate ?? null) === null, JSON.stringify(chatBFresh))

    // ── Kasus 7 — AR invariant & purge (§D4.7) ──
    check('K7-a firstResponseAt chat BITE ME tetap NULL (away/AR tidak pernah mengisi)', true) // terverifikasi K2-f
    const purge2 = await api('POST', '/api/purge', { mode: 'soft', chatIds: [duo.id], reason: 'e2e v469 purge reset markers' }, admLogin.data?.token)
    check(`K7-b purge soft jalur asli sukses (${purge2.status})`, purge2.status === 200)
    const duoAfterPurge = await prisma.chat.findUnique({ where: { id: duo.id }, select: { lastAutoGreetDate: true, lastAutoOutDate: true, status: true, assignedToId: true } })
    check('K7-c purge reset KEDUA marker auto (greeting + OUT) = fresh start total', (duoAfterPurge.lastAutoGreetDate ?? null) === null && (duoAfterPurge.lastAutoOutDate ?? null) === null, JSON.stringify(duoAfterPurge))
    const sAll = await api('GET', `/api/chats/search-all?q=BITE`, undefined, admLogin.data?.token)
    check(`K7-d search-all sanity 200 (${sAll.status})`, sAll.status === 200)
    const ana = await api('GET', '/api/analytics/overview?range=7d', undefined, admLogin.data?.token)
    check(`K7-e analytics sanity 200 (${ana.status})`, ana.status === 200)

    // ── Kasus 8 — CB-AI outside (§D4.8) ──
    // plan ✓ + mode cbai + outside → jalur CB-AI dipakai; AiConfig OFFLINE (tanpa key)
    // → guard NO_CONFIG → reserve di-revert (counter 0) + used=false → jatuh ke jalur
    // lama PERSIS = away text via KCLAIM OUT (jalur (a)). Pesan ke-2 → claim OUT blokir
    // → TIDAK dobel. CB-AI SENDIRI tidak klaim/menyentuh marker OUT (spec §D2.4).
    const cbaiChat = await seedChat(T, 'CBAI e2e469 (outside mode cbai)')
    await arUpdate({ outsideHoursMode: 'cbai', ...NARROW })
    const planRow = await prisma.tenantPlan.findFirst({ where: { tenantId: T } })
    await prisma.tenantPlan.update({ where: { id: planRow.id }, data: { featAiKnowledge: true } })
    plansSvc.invalidatePlanCache(T)
    await prisma.aiConfig.deleteMany({}).catch(() => {}) // NO_CONFIG guard (offline — 0 LLM cost)
    const rCbai1 = await autoSvc.maybeAutoReply(await prisma.chat.findUnique({ where: { id: cbaiChat.id }, include: { contact: true } }), mkMsg(ts1900Wib))
    const cbaiFresh1 = await prisma.chat.findUnique({ where: { id: cbaiChat.id }, select: { lastAutoOutDate: true, lastAutoGreetDate: true, aiReplyCount: true } })
    const cbaiAuto1 = await autoOutMessages(cbaiChat.id)
    check('K8-a cbai+outside (NO_CONFIG offline) → away fallback keluar 1× via jalur (a)', rCbai1?.sent === true && cbaiAuto1.length === 1 && cbaiAuto1[0].text.includes('Away E2E469'), JSON.stringify(cbaiAuto1.map((m) => m.text)))
    check('K8-b counter AI = 0 (reserve reverted) + marker OUT ter-klaim oleh jalur (a) — CB-AI sendiri tidak nyentuh marker', cbaiFresh1.aiReplyCount === 0 && cbaiFresh1.lastAutoOutDate === todayStr && (cbaiFresh1.lastAutoGreetDate ?? null) === null, JSON.stringify(cbaiFresh1))
    const rCbai2 = await autoSvc.maybeAutoReply(await prisma.chat.findUnique({ where: { id: cbaiChat.id }, include: { contact: true } }), mkMsg(new Date(ts1900Wib.getTime() + 5 * 60e3)))
    const cbaiAuto2 = await autoOutMessages(cbaiChat.id)
    check('K8-c pesan ke-2 (masih outside, mode cbai) → TIDAK dobel (claim OUT blokir)', rCbai2?.sent === false && cbaiAuto2.length === 1, `sent=${rCbai2?.sent} autoOut=${cbaiAuto2.length}`)
    await arUpdate({ outsideHoursMode: 'text', ...WORK_WINDOWS })
    const planRow2 = await prisma.tenantPlan.findFirst({ where: { tenantId: T } })
    await prisma.tenantPlan.update({ where: { id: planRow2.id }, data: { featAiKnowledge: false } })
    plansSvc.invalidatePlanCache(T)

    // ── Kasus 9 — Send gagal → revert OUT SAJA (§D4.9) ──
    const pool = require(REPO + '/src/wa/pool')
    const origSend = pool.sendMessageForTenant
    let failArmed = false
    pool.sendMessageForTenant = async (...a) => {
      if (failArmed) throw new Error('E2E469 armed send failure')
      return origSend(...a)
    }
    const failChat = await seedChat(T, 'Fail e2e469 (revert OUT saja)')
    failArmed = true
    const rF1 = await autoSvc.maybeAutoReply(await prisma.chat.findUnique({ where: { id: failChat.id }, include: { contact: true } }), mkMsg(ts1900Wib))
    failArmed = false
    const failFresh1 = await prisma.chat.findUnique({ where: { id: failChat.id }, select: { lastAutoOutDate: true, lastAutoGreetDate: true } })
    const failAuto0 = await autoOutMessages(failChat.id)
    check('K9-a send gagal → sent=false + klaim OUT di-REVERT (marker OUT balik NULL, tanpa Message row)', rF1?.sent === false && (failFresh1.lastAutoOutDate ?? null) === null && failAuto0.length === 0, JSON.stringify({ sent: rF1?.sent, ...failFresh1 }))
    await arUpdate(ALWAYS_IN)
    const rF2 = await autoSvc.maybeAutoReply(await prisma.chat.findUnique({ where: { id: failChat.id }, include: { contact: true } }), mkMsg(ts1000Wib))
    const failFresh2 = await prisma.chat.findUnique({ where: { id: failChat.id }, select: { lastAutoGreetDate: true, lastAutoOutDate: true } })
    check('K9-b greeting jalur (c) tetap keluar (revert OUT tidak merusak kuota greeting)', rF2?.sent === true && failFresh2.lastAutoGreetDate === todayStr && (failFresh2.lastAutoOutDate ?? null) === null)
    await arUpdate(NARROW)
    const rF3 = await autoSvc.maybeAutoReply(await prisma.chat.findUnique({ where: { id: failChat.id }, include: { contact: true } }), mkMsg(ts1930Wib))
    const failFresh3 = await prisma.chat.findUnique({ where: { id: failChat.id }, select: { lastAutoOutDate: true } })
    pool.sendMessageForTenant = origSend
    check('K9-c pesan berikutnya (luar jam) → away TERKIRIM + marker OUT = today (kuota OUT hidup lagi)', rF3?.sent === true && failFresh3.lastAutoOutDate === todayStr)

    // ── Kasus 10 — Jalur menu (b) + MenuGateway + repeat TIDAK berubah (§D4.10 in-suite) ──
    await arUpdate({ greetMode: 'menu', ...WORK_WINDOWS })
    await prisma.menuGatewayConfig.deleteMany({ where: { tenantId: T } })
    const mgCfg = await prisma.menuGatewayConfig.create({ data: { tenantId: T, numberSlot: null, enabled: true, introText: 'Menu E2E469 — pilih layanan.', fallbackText: 'Fallback E2E469.' } })
    await prisma.menuGatewayOption.create({ data: { tenantId: T, configId: mgCfg.id, position: 1, label: 'Info 469', replyText: 'Info 469 diterima.' } })
    // v430 lesson — config MG dibuat via process test → cache menuGateway WAJIB di-invalidate
    // (menuGatewayConfigSafe membaca cache; stale = gatewayOn false → jalur (b) gauges)
    require(REPO + '/src/services/menuGateway').invalidateConfig(T)
    const menuChat = await seedChat(T, 'Menu e2e469 (greet menu intact)')
    const rMenu = await autoSvc.maybeAutoReply(await prisma.chat.findUnique({ where: { id: menuChat.id }, include: { contact: true } }), mkMsg(ts1000Wib))
    const menuChatFresh = await prisma.chat.findUnique({ where: { id: menuChat.id }, select: { menuState: true, lastAutoGreetDate: true, lastAutoOutDate: true } })
    check('K10-a jalur (b) greet MENU tetap jalan (intro terkirim → menuState awaiting; repeatAllows intact)', rMenu?.sent === true && menuChatFresh.menuState === 'awaiting', JSON.stringify({ sent: rMenu?.sent, menuState: menuChatFresh.menuState }))
    check('K10-b jalur menu TIDAK menyentuh marker OUT (marker greeting lama tetap yang terpakai)', (menuChatFresh.lastAutoOutDate ?? null) === null && menuChatFresh.lastAutoGreetDate === todayStr, JSON.stringify(menuChatFresh))

    // ── EPILOG ──
    console.log(`\n=== v4.6.9 outside-priority e2e: ${pass} PASS / ${fails.length} FAIL (${((Date.now() - t0) / 1000).toFixed(1)}s) ===`)
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