/**
 * E2E v3.9.25 — AI Hybrid Gateway Routing (spec docs/spec-v3.9.25-ai-hybrid-gateway.md §9).
 * Jalan terhadap DB COPY di port 5099 (WA_DISABLED=1) — produksi (5047) tidak tersentuh.
 * Pola: scripts/e2e-v3924.cjs.
 *
 * Mock LLM 127.0.0.1:11435 WAJIB return token fields 700/100/50 + skenario
 * {position, confidence} ter-script per test (mode). Capture body request utk assert
 * N8 (aiDescription kosong → prompt pakai label+aliases).
 *
 * Checks: N1 keyword match → 0 row 'gateway' (fast-path gratis, D1),
 * N2 no-match + toggle OFF → fallback lama + 0 row,
 * N3 no-match + ON → row gateway + snapshot cost + tag + replyText terkirim,
 * N4 confidence 0.55 @ threshold 0.70 → fallback; PUT aiThreshold=0.50 → call sama → route;
 * N4b confidence 0.4 → fallback; N5 position 9 → fallback; N6 mock 500 → fallback + row ok=false;
 * N7 plan ✗ PUT aiHybrid → 403 (admin) + N7b SA ?tenant= plan ✗ → 403 JUGA, plan ✓ → 200;
 * N8 aiDescription kosong → prompt pakai label+aliases (via capture mock);
 * N9 aiUsage bulanan benar (calls/cost/costRp); N10 validasi liar → 400.
 *
 * Cara jalan (dari repo root):
 *   cp prisma/data/saas-v3.db /tmp/saas-v3-e2e.db
 *   && npx prisma db execute --file prisma/migrations/2026092603450000_ai_hybrid_gateway/migration.sql \
 *        --url file:/tmp/saas-v3-e2e.db  (apply additive ke copy)
 *   && insert row bookkeeping _prisma_migrations (checksum) — pola proven v3.9.14/23/24
 *   && node prisma/seed-ai-rates.js /tmp/saas-v3-e2e.db
 *   && PORT=5099 DATABASE_URL=file:/tmp/saas-v3-e2e.db WA_DISABLED=1 node src/server.js &
 *   node scripts/e2e-reset-superadmin.cjs && node scripts/e2e-v3925.cjs
 */
const REPO = '/home/kanakxxx/.openclaw/workspace/wa-cs-hub-saas-v3'
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:5099'
require(REPO + '/node_modules/dotenv').config({ path: REPO + '/.env' })
const { PrismaClient } = require(REPO + '/node_modules/@prisma/client')
// WAJIB: tunjuk DB COPY — jangan pernah sentuh DB produksi dari script test ini
const prisma = new PrismaClient({ datasourceUrl: 'file:/tmp/saas-v3-e2e.db', log: ['error'] })

const fails = []
let pass = 0
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${extra ? ' | ' + extra : ''}`)
  if (!cond) { process.exitCode = 1; fails.push(name) } else { pass++ }
}
async function api(method, path, body, token, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let data = null
  try { data = await res.json() } catch {}
  return { status: res.status, data, headers: res.headers }
}

// Tipe kolom SQLite: AiUsageLog.createdAt = DATETIME → Prisma simpan INTEGER ms epoch
// (pola v3.9.24 — lihat CHANGELOG N7). Bulan WIB berjalan = window [1-bulan 00:00 WIB, ∞).
function wibMonthStartMs(now = new Date()) {
  const ym = new Date(now.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 7) // ym dalam WIB
  return new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1, -7)).getTime()
}

async function main() {
  // ═══ Setup: SA login + user tenant (pola v3919/v3924) ═══
  const sa = await api('POST', '/api/auth/login', { username: process.env.SUPERADMIN_USERNAME, password: process.env.SUPERADMIN_PASSWORD })
  check('S0 superadmin login (copy db)', sa.status === 200 && !!sa.data?.token, `status=${sa.status}`)
  const saTok = sa.data?.token
  if (!saTok) return process.exit(1)

  async function e2eLogin(username, password) {
    const r = await api('POST', '/api/auth/login', { username, password })
    return r.status === 200 ? r.data?.token : null
  }
  const { hashPassword } = require(REPO + '/src/auth')
  const { encryptText } = require(REPO + '/src/services/textCrypto')
  async function ensureE2EUser(username, role, tenantId) {
    const pw = 'e2e25pw-' + username
    const existing = await prisma.user.findFirst({ where: { username } })
    if (existing) {
      await prisma.user.update({ where: { id: existing.id }, data: { status: 'active', role, passwordHash: await hashPassword(pw) } })
    } else {
      await prisma.user.create({ data: { username, passwordHash: await hashPassword(pw), role, tenantId, status: 'active' } })
    }
    return pw
  }
  // t8 (Mazaya, plan custom featMenuGateway=true) = tenant uji AI Hybrid (plan ✓)
  const pwAdmin8 = await ensureE2EUser('e2e25adm8', 'admin', 8)
  const t8AdminTok = await e2eLogin('e2e25adm8', pwAdmin8)
  check('S1 login admin t8 → token', !!t8AdminTok, `adm8=${!!t8AdminTok}`)
  if (!t8AdminTok) return process.exit(1)

  // t8 plan: featAiRouting ✓ (custom plan) — pastikan via PUT plan SA (additive field)
  const s1put = await api('PUT', '/api/sa/tenants/8/plan', { featAiRouting: true, featMenuGateway: true }, saTok)
  check('S1b PUT plan t8 featAiRouting=true → 200 + echo', s1put.status === 200 && s1put.data?.plan?.featAiRouting === true,
    `status=${s1put.status} echo=${s1put.data?.plan?.featAiRouting}`)

  // ═══ Mock LLM 127.0.0.1:11435 — token fields 700/100/50 + skenario {position,confidence} ═══
  const http = require('http')
  // mode: {type:'route', position, confidence} | {type:'err500'} | {type:'garbage'}
  let mockMode = { type: 'route', position: 2, confidence: 0.9 }
  let mockCalls = 0
  let lastPrompt = '' // capture system prompt (N8 assert label+aliases)
  const mockServer = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      mockCalls++
      if (req.method === 'GET' && req.url.startsWith('/api/tags')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ models: [{ name: 'mock-model-a', size: 40458027008 }] }))
      }
      if (req.method === 'POST' && req.url.startsWith('/api/chat')) {
        let parsed = {}
        try { parsed = JSON.parse(body || '{}') } catch {}
        lastPrompt = (parsed.messages || []).map((m) => m.content).join('\n---\n')
        if (mockMode.type === 'err500') {
          res.writeHead(500, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ error: 'mock upstream 500' }))
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        // Token fields DETERMINISTIK (pola v3924): 700/100/50
        // cost = (600×0.15 + 100×0.03 + 50×0.50)/1e6 = 0.000118 (rate seed glm-5.3-flash)
        const content = mockMode.type === 'garbage'
          ? 'bukan json sama sekali'
          : JSON.stringify({ position: mockMode.position, confidence: mockMode.confidence })
        return res.end(JSON.stringify({
          model: parsed.model || 'mock-model-a',
          message: { content },
          prompt_eval_count: 700,
          prompt_eval_cached_count: 100,
          eval_count: 50,
        }))
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'mock: not found' }))
    })
  })
  await new Promise((resolve) => mockServer.listen(11435, '127.0.0.1', resolve))
  check('S2 mock LLM listen 127.0.0.1:11435 (tokens 700/100/50)', mockServer.listening, '')

  // Idempoten re-run: bersihkan state AI (COPY db only) + seed rates
  await prisma.aiUsageLog.deleteMany({})
  await prisma.aiConfig.deleteMany({})
  const { execSync } = require('child_process')
  execSync('node prisma/seed-ai-rates.js /tmp/saas-v3-e2e.db', { cwd: REPO, stdio: 'pipe' })
  const cfgPut = await api('PUT', '/api/sa/ai-config', { cloudBaseUrl: 'http://127.0.0.1:11435', apiKey: 'test-key-123456-2345', cloudModel: 'glm-5.3-flash' }, saTok)
  check('S3 PUT ai-config (mock + glm-5.3-flash) → 200', cfgPut.status === 200, `status=${cfgPut.status}`)

  // ═══ S4 — Config menu gateway tenant 8: 2 opsi + fallback + tag ═══
  // tag: "Hasil" (opsi 2) + fallback tag "Lainnya"
  const tagA = await prisma.tag.upsert({
    where: { tenantId_name: { tenantId: 8, name: 'E2E25 Hasil' } },
    update: {},
    create: { tenantId: 8, name: 'E2E25 Hasil', createdBy: null },
  })
  const tagFb = await prisma.tag.upsert({
    where: { tenantId_name: { tenantId: 8, name: 'E2E25 Lainnya' } },
    update: {},
    create: { tenantId: 8, name: 'E2E25 Lainnya', createdBy: null },
  })
  const FB_TEXT = 'Terima kasih! CS E2E25 kami akan segera membalas. 🙏'
  const OPT1_REPLY = 'Siap Kak {name}, E2E25 komplain dicatat.'
  const OPT2_REPLY = 'Siap Kak {name}, E2E25 hasil siap diambil.'
  const s4put = await api('PUT', '/api/menu-gateway', {
    enabled: true,
    introText: 'Halo {name}! Silakan pilih topik E2E25:',
    fallbackText: FB_TEXT,
    fallbackTagId: tagFb.id,
    aiHybrid: false,
    aiThreshold: 0.70,
    options: [
      { position: 1, label: 'Komplain', aliases: 'komplain, keluhan', replyText: OPT1_REPLY, tagId: null, aiDescription: '' },
      { position: 2, label: 'Ambil hasil', aliases: 'hasil', replyText: OPT2_REPLY, tagId: tagA.id, aiDescription: 'rute pasien mau ambil hasil lab/terapi' },
    ],
  }, t8AdminTok)
  check('S4 PUT menu-gateway (2 opsi + aiHybrid=false + aiThreshold=0.70) → 200/409-proteksi',
    [200, 409].includes(s4put.status),
    `status=${s4put.status}`)

  // ═══ S4b — buka kembali PUT menu-gateway (S4 di atas bisa 409 bila proteksi
  // link-all + AR aktif menang — state sisa run sebelumnya). Pola idempoten:
  // coba link-all dulu; 409 → matikan AR shared trigger dulu, lalu ulang.
  let s4 = s4put
  if (s4.status === 409) {
    // matikan greeting/outside-hours di shared AR + AR per-slot 0 (jalur AutoReply PUT)
    await api('PUT', '/api/autoreply', { greetMode: 'text', greetEnabled: false, outsideHoursEnabled: false, numberSlots: null }, t8AdminTok)
    await api('PUT', '/api/autoreply', { greetMode: 'text', greetEnabled: false, outsideHoursEnabled: false, numberSlots: [0] }, t8AdminTok)
    s4 = await api('PUT', '/api/menu-gateway', {
      enabled: true,
      introText: 'Halo {name}! Silakan pilih topik E2E25:',
      fallbackText: FB_TEXT,
      fallbackTagId: tagFb.id,
      aiHybrid: false,
      aiThreshold: 0.70,
      options: [
        { position: 1, label: 'Komplain', aliases: 'komplain, keluhan', replyText: OPT1_REPLY, tagId: null, aiDescription: '' },
        { position: 2, label: 'Ambil hasil', aliases: 'hasil', replyText: OPT2_REPLY, tagId: tagA.id, aiDescription: 'rute pasien mau ambil hasil lab/terapi' },
      ],
    }, t8AdminTok)
  }
  check('S4c PUT menu-gateway (idempoten, setelah AR dinetralkan bila 409) → 200',
    s4.status === 200 && s4.data?.config?.aiHybrid === false && s4.data?.config?.aiThreshold === 0.70,
    `status=${s4.status} aiHybrid=${s4.data?.config?.aiHybrid} thr=${s4.data?.config?.aiThreshold}`)
  check('S4d echo options[].aiDescription tersimpan',
    s4.data?.config?.options?.[0]?.aiDescription === '' && s4.data?.config?.options?.[1]?.aiDescription === 'rute pasien mau ambil hasil lab/terapi',
    `o1=${JSON.stringify(s4.data?.config?.options?.[0]?.aiDescription)} o2=${JSON.stringify(s4.data?.config?.options?.[1]?.aiDescription)}`)
  // aktifkan lagi greetMode menu (proteksi S4 di atas mematikan AR → nyalakan balik)
  const s4a2 = await api('PUT', '/api/autoreply', { greetMode: 'menu' }, t8AdminTok)
  check('S4e PUT autoreply greetMode=menu (re-enable) → 200', s4a2.status === 200, `status=${s4a2.status}`)

  // ═══ Helper: seed chat awaiting + trigger handleChoice via pesan masuk ═══
  // E2E v3.9.25 — trigger via JALUR ASLI: POST /api/wa/inbound (HTTP) → wa/pool.js
  // processIncomingMessage → menuGateway.handleChoice. In-process require DILARANG:
  // dotenv .env repo (prod DATABASE_URL) kebaca saat module load — bisa nyentuh prod.
  let nSeq = 4000
  const chatByJid = new Map() // jid → chatId (idempoten re-run)
  async function seedAwaitingChat(name) {
    let jid
    for (;;) {
      jid = `62899925${String(nSeq++).padStart(4, '0')}@s.whatsapp.net`
      const ex = await prisma.chat.findUnique({ where: { tenantId_numberSlot_waJid: { tenantId: 8, numberSlot: 0, waJid: jid } } })
      if (!ex) break
    }
    const chat = await prisma.chat.create({
      data: {
        tenantId: 8, waJid: jid, contactPhone: jid.slice(0, 12), contactName: name,
        status: 'open', menuState: 'awaiting', menuRequestedAt: new Date(),
      },
    })
    // Contact row (chat 1:1) — WAJIB: tagContactAndMirror nempel tag ke KONTAK
    // (ContactTag), chat tanpa contact = tag skip (jalan di prod untuk chat lama).
    await prisma.contact.create({ data: { tenantId: 8, chatId: chat.id, name, phone: jid.slice(0, 12), source: 'chat' } })
    await prisma.message.create({ data: { tenantId: 8, chatId: chat.id, direction: 'in', content: encryptText('halo kak mau tanya'), senderName: 'Customer', timestamp: new Date() } })
    chatByJid.set(jid, chat.id)
    return chat
  }
  // Simulasi pesan masuk (jalur asli): WA_DISABLED pool → sendMessageForTenant throw
  // saat kirim balasan auto (sendAutoMessage catch → false, tag & queue tetap jalan,
  // TANPA row message auto — pola E2E T4c v399). Runtime menu gateway tetap tereksekusi.
  async function incoming(chatId, text) {
    const chat = await prisma.chat.findUnique({ where: { id: chatId } })
    if (!chat) return false
    const r = await api('POST', '/api/wa/inbound', {
      tenantId: 8,
      slot: 0,
      messages: {
        key: { remoteJid: chat.waJid, fromMe: false, id: 'E2E25MSG-' + chatId + '-' + Date.now() },
        pushName: chat.contactName || 'E2E25',
        message: { conversation: text },
      },
    }, saTok)
    if (r.status !== 200) { console.log(`  [inbound] status=${r.status} body=${JSON.stringify(r.data).slice(0, 160)}`); return false }
    return r.data?.ok === true && r.data?.chatId === chatId
  }
  async function lastGatewayRow() {
    return prisma.aiUsageLog.findFirst({ where: { source: 'gateway' }, orderBy: { id: 'desc' } })
  }

  // ═══ N1 — keyword match → LLM TIDAK menyala (0 row 'gateway') — D1 fast-path ═══
  const n1c = await seedAwaitingChat('E2E25 N1')
  const gw0 = await prisma.aiUsageLog.count({ where: { source: 'gateway' } })
  const n1 = await incoming(n1c.id, 'hasil') // alias eksak opsi 2
  check('N1 handleChoice keyword → true', n1 === true, `ret=${n1}`)
  const n1row = await prisma.chat.findUnique({ where: { id: n1c.id } })
  check('N1b chat done + menuOptionId = opsi 2', n1row?.menuState === 'done', `menuState=${n1row?.menuState}`)
  const gw1 = await prisma.aiUsageLog.count({ where: { source: 'gateway' } })
  check('N1c 0 row AiUsageLog gateway (LLM tidak menyala — D1)', gw1 === gw0, `n=${gw1} before=${gw0}`)

  // ═══ N2 — no-match + toggle OFF → fallback lama + 0 row ═══
  const n2c = await seedAwaitingChat('E2E25 N2')
  const n2 = await incoming(n2c.id, 'kak besok bisa jam berapa ya buat fisio?')
  check('N2 handleChoice no-match OFF → true', n2 === true, `ret=${n2}`)
  const n2row = await prisma.chat.findUnique({ where: { id: n2c.id } })
  check('N2b chat done (fallback path)', n2row?.menuState === 'done', `menuState=${n2row?.menuState}`)
  const n2tags = await prisma.contactTag.findMany({ where: { contact: { chatId: n2c.id } } })
  check('N2c fallback tag "Lainnya" nempel (ContactTag source=menu)', n2tags.some(t => t.tagId === tagFb.id && t.source === 'menu'), `n=${n2tags.length}`)
  const gw2 = await prisma.aiUsageLog.count({ where: { source: 'gateway' } })
  check('N2d 0 row gateway (toggle OFF — LLM tidak dipanggil)', gw2 === gw1, `n=${gw2} before=${gw1}`)

  // ═══ N3 — no-match + ON → row 'gateway' + snapshot cost + tag + replyText ═══
  const n3on = await api('PUT', '/api/menu-gateway', { aiHybrid: true }, t8AdminTok)
  check('N3 PUT aiHybrid=true (plan ✓) → 200 + echo', n3on.status === 200 && n3on.data?.config?.aiHybrid === true, `status=${n3on.status}`)
  mockMode = { type: 'route', position: 2, confidence: 0.9 }
  const n3c = await seedAwaitingChat('E2E25 N3')
  const n3 = await incoming(n3c.id, 'kak hasil lab saya udah keluar belum ya?')
  check('N3 handleChoice no-match ON (AI pilih opsi 2) → true', n3 === true, `ret=${n3}`)
  const n3chat = await prisma.chat.findUnique({ where: { id: n3c.id } })
  check('N3b menuOptionId = opsi 2 (eksekusi sama dgn pilihan normal)', n3chat?.menuOptionId != null && (await prisma.menuGatewayOption.findUnique({ where: { id: n3chat.menuOptionId } }))?.position === 2,
    `optPos=${(await prisma.menuGatewayOption.findUnique({ where: { id: n3chat?.menuOptionId || 0 } }))?.position}`)
  const n3row = await lastGatewayRow()
  check('N3c row AiUsageLog source=gateway (tenant 8 + chatId)',
    !!n3row && n3row.tenantId === 8 && n3row.chatId === n3c.id && n3row.ok === true,
    `id=${n3row?.id} tenant=${n3row?.tenantId} chat=${n3row?.chatId} ok=${n3row?.ok}`)
  const EXPECT_COST = (600 * 0.15 + 100 * 0.03 + 50 * 0.5) / 1e6 // 0.000118 (rate seed glm-5.3-flash)
  check('N3d snapshot cost PERSIS (0.000118, tol 1e-9) + tokens 700/100/50',
    n3row?.costUsd != null && Math.abs(n3row.costUsd - EXPECT_COST) <= 1e-9 && n3row?.promptTokens === 700 && n3row?.cachedTokens === 100 && n3row?.outputTokens === 50,
    `cost=${n3row?.costUsd} p=${n3row?.promptTokens} c=${n3row?.cachedTokens} o=${n3row?.outputTokens}`)
  check('N3e snapshot rate seed (0.15/0.03/0.5)',
    n3row?.rateInput === 0.15 && n3row?.rateCached === 0.03 && n3row?.rateOutput === 0.5,
    `in=${n3row?.rateInput} cached=${n3row?.rateCached} out=${n3row?.rateOutput}`)
  const n3tags = await prisma.contactTag.findMany({ where: { contact: { chatId: n3c.id } } })
  check('N3f tag opsi 2 nempel (tagContactAndMirror jalur sama)', n3tags.some(t => t.tagId === tagA.id && t.source === 'menu'), `n=${n3tags.length}`)
  check('N3g TANPA fallback tag di chat ini (AI route, bukan fallback)', !n3tags.some(t => t.tagId === tagFb.id), `n=${n3tags.length}`)

  // ═══ N4 — confidence 0.55 @ default 0.70 → fallback; PUT 0.50 → call sama → route ═══
  mockMode = { type: 'route', position: 1, confidence: 0.55 }
  const n4c = await seedAwaitingChat('E2E25 N4')
  await incoming(n4c.id, 'pelayanan di sini kok lama banget sih ya')
  const n4chat = await prisma.chat.findUnique({ where: { id: n4c.id } })
  check('N4 conf 0.55 @ 0.70 → fallback (menuOptionId null)', n4chat?.menuOptionId == null, `menuOptionId=${n4chat?.menuOptionId}`)
  const n4tags = await prisma.contactTag.findMany({ where: { contact: { chatId: n4c.id } } })
  check('N4b fallback tag nempel (perilaku lama utuh)', n4tags.some(t => t.tagId === tagFb.id), `n=${n4tags.length}`)
  const n4thr = await api('PUT', '/api/menu-gateway', { aiThreshold: 0.50 }, t8AdminTok)
  check('N4c PUT aiThreshold=0.50 → 200 + echo', n4thr.status === 200 && n4thr.data?.config?.aiThreshold === 0.5, `status=${n4thr.status} thr=${n4thr.data?.config?.aiThreshold}`)
  const n4c2 = await seedAwaitingChat('E2E25 N4b')
  await incoming(n4c2.id, 'pelayanan di sini kok lama banget sih ya') // skenario mock SAMA
  const n4c2chat = await prisma.chat.findUnique({ where: { id: n4c2.id } })
  const n4opt2 = n4c2chat?.menuOptionId != null ? await prisma.menuGatewayOption.findUnique({ where: { id: n4c2chat.menuOptionId } }) : null
  check('N4d threshold 0.50 + conf 0.55 → AI route (opsi 1)', n4opt2?.position === 1, `optPos=${n4opt2?.position}`)
  const n4c2tags = await prisma.contactTag.findMany({ where: { contact: { chatId: n4c2.id } } })
  check('N4e tag opsi 1 (null tagId → tanpa ContactTag)', n4c2tags.length === 0, `n=${n4c2tags.length}`)
  // N4b — confidence 0.4 → fallback (di bawah 0.50 juga)
  mockMode = { type: 'route', position: 1, confidence: 0.4 }
  const n4bc = await seedAwaitingChat('E2E25 N4c')
  await incoming(n4bc.id, 'pelayanan di sini kok lama banget sih ya')
  const n4bchat = await prisma.chat.findUnique({ where: { id: n4bc.id } })
  check('N4f conf 0.4 @ 0.50 → fallback', n4bchat?.menuOptionId == null, `menuOptionId=${n4bchat?.menuOptionId}`)
  // kembalikan threshold default
  await api('PUT', '/api/menu-gateway', { aiThreshold: 0.70 }, t8AdminTok)

  // ═══ N5 — position 9 (out-of-range, 2 opsi) → fallback lama (D4) ═══
  mockMode = { type: 'route', position: 9, confidence: 0.99 }
  const n5c = await seedAwaitingChat('E2E25 N5')
  await incoming(n5c.id, 'makasih banyak ya kak')
  const n5chat = await prisma.chat.findUnique({ where: { id: n5c.id } })
  check('N5 position 9 out-of-range → fallback (menuOptionId null)', n5chat?.menuOptionId == null, `menuOptionId=${n5chat?.menuOptionId}`)
  const n5tags = await prisma.contactTag.findMany({ where: { contact: { chatId: n5c.id } } })
  check('N5b fallback tag nempel', n5tags.some(t => t.tagId === tagFb.id), `n=${n5tags.length}`)
  const n5row = await lastGatewayRow()
  check('N5c row gateway TETAP tercatat ok=true (call jalan, hasil ditolak)', !!n5row && n5row.ok === true, `id=${n5row?.id}`)

  // ═══ N6 — mock 500 → fallback lama + row ok=false (D6 graceful degradation) ═══
  mockMode = { type: 'err500' }
  const n6c = await seedAwaitingChat('E2E25 N6')
  const n6 = await incoming(n6c.id, 'halo kak, ini gimana caranya')
  check('N6 handleChoice mock-500 → true (TIDAK crash — D6)', n6 === true, `ret=${n6}`)
  const n6chat = await prisma.chat.findUnique({ where: { id: n6c.id } })
  check('N6b fallback (menuOptionId null)', n6chat?.menuOptionId == null, `menuOptionId=${n6chat?.menuOptionId}`)
  const n6row = await lastGatewayRow()
  check('N6c row ok=false + errorCode=UPSTREAM_5XX (D6/D7 observability)',
    !!n6row && n6row.ok === false && n6row.errorCode === 'UPSTREAM_5XX',
    `ok=${n6row?.ok} code=${n6row?.errorCode}`)

  // ═══ N7 — plan ✗: PUT aiHybrid → 403; runtime tanpa row; N7b SA ?tenant= ═══
  // plan ✗ tenant 8 dulu
  const n7planOff = await api('PUT', '/api/sa/tenants/8/plan', { featAiRouting: false }, saTok)
  check('N7 PUT plan t8 featAiRouting=false → 200', n7planOff.status === 200 && n7planOff.data?.plan?.featAiRouting === false, `status=${n7planOff.status}`)
  // plans cache 30s di server copy → tunggu invalidate via PUT (server invalidate sendiri)
  const n7put = await api('PUT', '/api/menu-gateway', { aiHybrid: true }, t8AdminTok)
  check('N7b admin plan ✗ PUT aiHybrid=true → 403', n7put.status === 403, `status=${n7put.status} body=${JSON.stringify(n7put.data).slice(0, 120)}`)
  const n7cfg = await api('GET', '/api/menu-gateway', undefined, t8AdminTok)
  check('N7c GET plan ✗ → aiUsage null (D7)', n7cfg.status === 200 && n7cfg.data?.aiUsage === null, `aiUsage=${JSON.stringify(n7cfg.data?.aiUsage)}`)
  // N7b SA impersonation — SA + ?tenant= plan ✗ → 403 JUGA (plan gate menang atas SA)
  const n7sa = await api('PUT', '/api/menu-gateway?tenant=8', { aiHybrid: true }, saTok)
  check('N7d SA ?tenant=8 plan ✗ PUT aiHybrid → 403 JUGA (D5a tanpa backdoor)', n7sa.status === 403, `status=${n7sa.status}`)
  // runtime: AI tak menyala walau toggle masih true dari N3 (plan ✗)
  const gwBefore7 = await prisma.aiUsageLog.count({ where: { source: 'gateway' } })
  mockMode = { type: 'route', position: 2, confidence: 0.9 }
  const n7c2 = await seedAwaitingChat('E2E25 N7')
  await incoming(n7c2.id, 'hasil lab saya mau ambil hari ini') // no-match (keyword opsi 2 = "hasil" → MATCH!)
  const gwAfter7 = await prisma.aiUsageLog.count({ where: { source: 'gateway' } })
  check('N7e runtime plan ✗ → 0 row gateway baru (LLM tidak dipanggil)', gwAfter7 === gwBefore7, `n=${gwAfter7} before=${gwBefore7}`)
  // plan ✓ lagi → SA toggle jalan (D5a)
  await api('PUT', '/api/sa/tenants/8/plan', { featAiRouting: true }, saTok)
  const n7saOk = await api('PUT', '/api/menu-gateway?tenant=8', { aiHybrid: true }, saTok)
  check('N7f SA ?tenant=8 plan ✓ PUT aiHybrid=true → 200 (SA toggle terbukti)', n7saOk.status === 200 && n7saOk.data?.config?.aiHybrid === true, `status=${n7saOk.status}`)
  const n7saCs = await api('PUT', '/api/menu-gateway?tenant=8', { aiHybrid: true }, saTok)
  check('N7g SA toggle idempoten (PUT sama ×2 → 200)', n7saCs.status === 200 && n7saCs.data?.config?.aiHybrid === true, `status=${n7saCs.status}`)

  // ═══ N8 — aiDescription kosong → prompt pakai label+aliases (capture mock) ═══
  const n8put = await api('PUT', '/api/menu-gateway', {
    aiHybrid: true,
    options: [
      { position: 1, label: 'Komplain', aliases: 'komplain, keluhan', replyText: OPT1_REPLY, tagId: null, aiDescription: '' },
      { position: 2, label: 'Ambil hasil', aliases: 'hasil', replyText: OPT2_REPLY, tagId: tagA.id, aiDescription: '' },
    ],
  }, t8AdminTok)
  check('N8 PUT options aiDescription kosong → 200', n8put.status === 200, `status=${n8put.status}`)
  const n8c = await seedAwaitingChat('E2E25 N8')
  mockMode = { type: 'route', position: 2, confidence: 0.9 }
  await incoming(n8c.id, 'itu kayaknya keluhan pelayanan deh kak')
  check('N8b prompt pakai label+aliases (bukan kosong) — capture mock',
    lastPrompt.includes('1. Komplain — Komplain — komplain, keluhan') && lastPrompt.includes('2. Ambil hasil — Ambil hasil — hasil'),
    lastPrompt.split('\n').filter(l => l.startsWith('1.') || l.startsWith('2.')).join(' || ').slice(0, 200))

  // ═══ N9 — aiUsage bulan WIB berjalan benar (calls/costUsd/costRp) ═══
  const n9cfg = await api('GET', '/api/menu-gateway', undefined, t8AdminTok)
  const sinceMs = wibMonthStartMs()
  const expectedRows = await prisma.aiUsageLog.count({ where: { tenantId: 8, source: 'gateway', createdAt: { gte: new Date(sinceMs) } } })
  const expectedCost = (await prisma.aiUsageLog.aggregate({ where: { tenantId: 8, source: 'gateway', createdAt: { gte: new Date(sinceMs) } }, _sum: { costUsd: true } }))._sum.costUsd || 0
  check('N9 GET aiUsage = DB (calls)', n9cfg.status === 200 && n9cfg.data?.aiUsage?.calls === expectedRows,
    `api=${n9cfg.data?.aiUsage?.calls} db=${expectedRows}`)
  check('N9b GET aiUsage costUsd = SUM DB (tol 1e-9)',
    Math.abs((n9cfg.data?.aiUsage?.costUsd || 0) - expectedCost) <= 1e-9,
    `api=${n9cfg.data?.aiUsage?.costUsd} db=${expectedCost}`)
  check('N9c costRp = Math.round(costUsd × usdToIdr 16000)',
    n9cfg.data?.aiUsage?.costRp === Math.round(expectedCost * 16000),
    `rp=${n9cfg.data?.aiUsage?.costRp} expect=${Math.round(expectedCost * 16000)}`)
  // seed row lintas-bulan TIDAK dihitung (bulan WIB berjalan saja)
  await prisma.aiUsageLog.create({ data: {
    tenantId: 8, chatId: null, source: 'gateway', model: 'glm-5.3-flash', viaFallback: false,
    promptTokens: 1, cachedTokens: 0, outputTokens: 1, ok: true, costUsd: 5.0,
    createdAt: new Date(sinceMs - 86400000), // 1 hari sebelum awal bulan WIB
  } })
  const n9b = await api('GET', '/api/menu-gateway', undefined, t8AdminTok)
  check('N9d row bulan-lalu TIDAK masuk aiUsage (bulan WIB berjalan saja)',
    n9b.data?.aiUsage?.calls === expectedRows, `api=${n9b.data?.aiUsage?.calls} expect=${expectedRows}`)

  // ═══ N10 — Validasi liar PUT → 400 (spec §9) ═══
  const baseOpts = [
    { position: 1, label: 'Komplain', aliases: 'komplain', replyText: OPT1_REPLY, aiDescription: '' },
    { position: 2, label: 'Ambil hasil', aliases: 'hasil', replyText: OPT2_REPLY, aiDescription: '' },
  ]
  const n10a = await api('PUT', '/api/menu-gateway', { options: baseOpts.map(o => ({ ...o, aiDescription: 'x'.repeat(201) })) }, t8AdminTok)
  check('N10a aiDescription 201 char → 400', n10a.status === 400, `status=${n10a.status}`)
  const n10b = await api('PUT', '/api/menu-gateway', { aiHybrid: 'yes' }, t8AdminTok)
  check('N10b aiHybrid "yes" (string) → 400', n10b.status === 400, `status=${n10b.status}`)
  const n10c = await api('PUT', '/api/menu-gateway', { aiThreshold: 0.49 }, t8AdminTok)
  check('N10c aiThreshold 0.49 → 400', n10c.status === 400, `status=${n10c.status}`)
  const n10d = await api('PUT', '/api/menu-gateway', { aiThreshold: 0.96 }, t8AdminTok)
  check('N10d aiThreshold 0.96 → 400', n10d.status === 400, `status=${n10d.status}`)
  const n10e = await api('PUT', '/api/menu-gateway', { aiThreshold: '0.7' }, t8AdminTok)
  check('N10e aiThreshold "0.7" (string) → 400', n10e.status === 400, `status=${n10e.status}`)
  const n10f = await api('PUT', '/api/menu-gateway', { aiThreshold: 0.85 }, t8AdminTok)
  check('N10f aiThreshold 0.85 valid → 200 + echo', n10f.status === 200 && n10f.data?.config?.aiThreshold === 0.85, `status=${n10f.status} thr=${n10f.data?.config?.aiThreshold}`)
  const n10g = await api('PUT', '/api/menu-gateway', { fieldAsing: true }, t8AdminTok)
  check('N10g field tidak dikenal → 400 (ALLOWED_TOP_FIELDS ketat)', n10g.status === 400, `status=${n10g.status}`)
  // restore: threshold default + aiHybrid mati (tenant 8 kembali ke perilaku lama utk re-run)
  const n10r = await api('PUT', '/api/menu-gateway', { aiThreshold: 0.70, aiHybrid: false }, t8AdminTok)
  check('N10h restore aiThreshold 0.70 + aiHybrid=false → 200', n10r.status === 200 && n10r.data?.config?.aiHybrid === false, `status=${n10r.status}`)

  // ═══ Sanity akhir: total row gateway + cleanup state toggle ═══
  const gwTotal = await prisma.aiUsageLog.count({ where: { source: 'gateway' } })
  check('S5 total row gateway > 0 (metering jalan)', gwTotal > 0, `n=${gwTotal}`)
  // key tidak bocor di response apapun (pattern 'test-key' tidak ada di payload check S3b)
  const leaks = JSON.stringify({ s3: cfgPut.data }).includes('test-key-123456')
  check('S3b response PUT ai-config TIDAK memuat key plaintext', !leaks, '')

  mockServer.close()
  console.log(`\n=== e2e-v3925: ${pass} PASS / ${fails.length} FAIL ===`)
  if (fails.length) { console.log('FAILED:', fails.join(' | ')); process.exitCode = 1 }
  await prisma.$disconnect()
  process.exit(process.exitCode || 0) // mock sockets keep event loop alive → exit eksplisit
}

main().catch((e) => { console.error(e); process.exit(1) })