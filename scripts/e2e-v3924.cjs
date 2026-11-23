/**
 * E2E v3.9.24 — AI Usage: cost metering + panel dashboard + rate tabel per-model
 * (spec docs/spec-v3.9.24-ai-usage.md §9). Jalan terhadap DB COPY di port 5099
 * (WA_DISABLED=1) — produksi (5047) tidak tersentuh. Pola: scripts/e2e-v3919.cjs.
 *
 * Mock LLM 127.0.0.1:11435 WAJIB return token fields (spec §9):
 *   prompt_eval_count / eval_count / prompt_eval_cached_count.
 * Server copy diboot TERPISAH dgn env PORT=5099 DATABASE_URL=file:/tmp/saas-v3-e2e.db
 * WA_DISABLED=1 (lihat CHANGELOG v3.9.24 / cara jalan di bawah).
 *
 * Checks: N1 cost metering summary (angka persis, snapshot rate seed glm-5.3-flash),
 * N2 preview + test-connection rows, N3 model tanpa rate → costUsd null + untracked,
 * N4 snapshot semantics (PUT rate baru → call baru pakai rate baru; row lama utuh),
 * N5 fallback → costUsd 0 + wouldCostUsd > 0 + fallbackSavedUsd, N6 error path 500,
 * N7 range stats lintas hari + perTenant, N8 DELETE rate → untracked, N9 validasi PUT,
 * N10 SA-only guard. ZERO destructive op — semua INSERT/UPSERT di COPY db.
 *
 * Cara jalan (dari repo root):
 *   cp prisma/data/saas-v3.db /tmp/saas-v3-e2e.db && apply migration additive ke copy
 *   && node prisma/seed-ai-rates.js /tmp/saas-v3-e2e.db
 *   && PORT=5099 DATABASE_URL=file:/tmp/saas-v3-e2e.db WA_DISABLED=1 node src/server.js &
 *   node scripts/e2e-reset-superadmin.cjs && node scripts/e2e-v3924.cjs
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

// ── WIB util (mirror backend v3.9.20) ──
const wibTodayStr = () => new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10)
function wibDaysAgoStr(n) {
  const t = new Date(Date.now() + 7 * 60 * 60 * 1000)
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - n * 86400000)
    .toISOString().slice(0, 10)
}
// Timestamp epoch ms dgn tanggal-WIB = N hari lalu (jam 10:00 WIB biar jelas lintas hari)
function wibDaysAgoMs(n) {
  const dayStr = wibDaysAgoStr(n)
  return Date.UTC(Number(dayStr.slice(0, 4)), Number(dayStr.slice(5, 7)) - 1, Number(dayStr.slice(8, 10)), 10, 0, 0)
}

async function main() {
  // ═══ Setup: SA login + user tenant (pola v3919) ═══
  const sa = await api('POST', '/api/auth/login', { username: process.env.SUPERADMIN_USERNAME, password: process.env.SUPERADMIN_PASSWORD })
  check('S0 superadmin login (copy db)', sa.status === 200 && !!sa.data?.token, `status=${sa.status}`)
  const saTok = sa.data?.token
  if (!saTok) return process.exit(1)

  async function e2eLogin(username, password) {
    const r = await api('POST', '/api/auth/login', { username, password })
    return r.status === 200 ? r.data?.token : null
  }
  const { hashPassword } = require(REPO + '/src/auth')
  const { encryptText, decryptTextSafe } = require(REPO + '/src/services/textCrypto')
  async function ensureE2EUser(username, role, tenantId) {
    const pw = 'e2e24pw-' + username
    const existing = await prisma.user.findFirst({ where: { username } })
    if (existing) {
      await prisma.user.update({ where: { id: existing.id }, data: { status: 'active', role, passwordHash: await hashPassword(pw) } })
    } else {
      await prisma.user.create({ data: { username, passwordHash: await hashPassword(pw), role, tenantId, status: 'active' } })
    }
    return pw
  }
  const pwAdmin8 = await ensureE2EUser('e2e24adm8', 'admin', 8)
  const pwCs8 = await ensureE2EUser('e2e24cs8', 'cs', 8)
  const t8AdminTok = await e2eLogin('e2e24adm8', pwAdmin8)
  const t8CsTok = await e2eLogin('e2e24cs8', pwCs8)
  check('S1 login admin t8 + cs t8 → token', !!t8AdminTok && !!t8CsTok, `adm8=${!!t8AdminTok} cs8=${!!t8CsTok}`)
  if (!t8AdminTok) return process.exit(1)

  // ═══ Mock LLM 127.0.0.1:11435 — WAJIB return token fields (spec §9) ═══
  const http = require('http')
  let mockMode = 'ok' // ok | err500
  let mockCalls = 0
  const mockServer = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      mockCalls++
      if (req.method === 'GET' && req.url.startsWith('/api/tags')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ models: [
          { name: 'mock-model-a', size: 40458027008 },
          { name: 'mock-model-b', size: 2019490656 },
        ] }))
      }
      if (req.method === 'POST' && req.url.startsWith('/api/chat')) {
        let parsed = {}
        try { parsed = JSON.parse(body || '{}') } catch {}
        if (mockMode === 'err500') {
          res.writeHead(500, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ error: 'mock upstream 500' }))
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        // Token fields DETERMINISTIK (spec N1: costUsd dihitung dari angka ini)
        return res.end(JSON.stringify({
          model: parsed.model || 'mock-model-a',
          message: { content: 'MOCK siap' },
          prompt_eval_count: 700,       // prompt
          prompt_eval_cached_count: 100, // cached subset (prompt termasuk cached)
          eval_count: 50,               // output
        }))
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'mock: not found' }))
    })
  })
  await new Promise((resolve) => mockServer.listen(11435, '127.0.0.1', resolve))
  check('S2 mock LLM listen 127.0.0.1:11435 (token fields 700/100/50)', mockServer.listening, '')
  const MOCK_URL = 'http://127.0.0.1:11435'

  // Idempoten re-run: bersihkan state AI (COPY db only)
  await prisma.aiUsageLog.deleteMany({})
  await prisma.aiConfig.deleteMany({})
  // restore seed rates (idempoten; N4/N8 di bawah mutasi lalu kembalikan)
  const { execSync } = require('child_process')
  execSync('node prisma/seed-ai-rates.js /tmp/saas-v3-e2e.db', { cwd: REPO, stdio: 'pipe' })
  const n0rates = await prisma.aiModelRate.findMany()
  check('S3 seed rates 17 model (idempoten)', n0rates.length === 17, `n=${n0rates.length}`)

  // Config: mock baseUrl + model glm-5.3-flash (punya rate seed)
  const cfgPut = await api('PUT', '/api/sa/ai-config', { cloudBaseUrl: MOCK_URL, apiKey: 'test-key-123456-2345', cloudModel: 'glm-5.3-flash' }, saTok)
  check('S4 PUT ai-config (mock + glm-5.3-flash) → 200', cfgPut.status === 200, `status=${cfgPut.status}`)

  let nSeq = 300
  async function seedOneMsgChat() {
    let jid
    for (;;) {
      jid = `62899924${String(nSeq++).padStart(4, '0')}@s.whatsapp.net`
      const ex = await prisma.chat.findUnique({ where: { tenantId_numberSlot_waJid: { tenantId: 8, numberSlot: 0, waJid: jid } } })
      if (!ex) break
    }
    const chat = await prisma.chat.create({
      data: { tenantId: 8, waJid: jid, contactPhone: jid.slice(0, 12), contactName: 'E2E24 ' + jid.slice(-4), status: 'open' },
    })
    await prisma.message.create({ data: { tenantId: 8, chatId: chat.id, direction: 'in', content: encryptText('pesan ' + jid.slice(0, 12)), senderName: 'Customer', timestamp: new Date() } })
    return chat
  }
  async function lastUsageRow() {
    return prisma.aiUsageLog.findFirst({ orderBy: { id: 'desc' } })
  }

  // ═══ N1 — Summary → row AiUsageLog: tokens benar + costUsd hitungan persis ═══
  const n1c = await seedOneMsgChat()
  const n1 = await api('POST', `/api/chats/${n1c.id}/summary`, {}, t8AdminTok)
  check('N1 summary → 200', n1.status === 200, `status=${n1.status} ${JSON.stringify(n1.data).slice(0, 100)}`)
  const n1row = await lastUsageRow()
  check('N1b row AiUsageLog dibuat (source=summary, tenant+chat id)', !!n1row && n1row.source === 'summary' && n1row.tenantId === 8 && n1row.chatId === n1c.id,
    `id=${n1row?.id} source=${n1row?.source} tenant=${n1row?.tenantId} chat=${n1row?.chatId}`)
  check('N1c tokens benar (700/100/50 dari mock)', n1row?.promptTokens === 700 && n1row?.cachedTokens === 100 && n1row?.outputTokens === 50,
    `p=${n1row?.promptTokens} c=${n1row?.cachedTokens} o=${n1row?.outputTokens}`)
  // Cost persis (toleransi 1e-9): uncached=600, cached=100, out=50 dgn rate seed
  // glm-5.3-flash in 0.15 / cached 0.03 / out 0.50 per 1M
  // = (600×0.15 + 100×0.03 + 50×0.50)/1e6 = (90 + 3 + 25)/1e6 = 0.000118
  const EXPECT_N1 = (600 * 0.15 + 100 * 0.03 + 50 * 0.5) / 1e6
  check('N1d costUsd = hitungan persis (0.000118, tol 1e-9)',
    n1row?.costUsd != null && Math.abs(n1row.costUsd - EXPECT_N1) <= 1e-9,
    `costUsd=${n1row?.costUsd} expect=${EXPECT_N1} diff=${n1row?.costUsd != null ? Math.abs(n1row.costUsd - EXPECT_N1) : 'null'}`)
  check('N1e snapshot rate = seed glm-5.3-flash (0.15/0.03/0.5)',
    n1row?.rateInput === 0.15 && n1row?.rateCached === 0.03 && n1row?.rateOutput === 0.5,
    `in=${n1row?.rateInput} cached=${n1row?.rateCached} out=${n1row?.rateOutput}`)
  check('N1f ok=true + errorCode null + viaFallback=false', n1row?.ok === true && n1row?.errorCode == null && n1row?.viaFallback === false, '')

  // ═══ N2 — Preview + test-connection → row source 'preview' / 'test' ═══
  const n2p = await api('POST', '/api/chats/summary-preview', { presetKey: 'standard' }, t8AdminTok)
  check('N2 preview → 200', n2p.status === 200, `status=${n2p.status}`)
  const n2prow = await lastUsageRow()
  check('N2b row source=preview (tenantId ada, chatId null)', n2prow?.source === 'preview' && n2prow?.tenantId === 8 && n2prow?.chatId == null,
    `source=${n2prow?.source} tenant=${n2prow?.tenantId} chat=${n2prow?.chatId}`)
  const n2t = await api('POST', '/api/sa/ai-config/test', {}, saTok)
  check('N2c test-connection → 200 ok', n2t.status === 200 && n2t.data?.ok === true, `status=${n2t.status}`)
  const n2trow = await lastUsageRow()
  check('N2d row source=test (tenantId null — platform-level)', n2trow?.source === 'test' && n2trow?.tenantId == null,
    `source=${n2trow?.source} tenant=${n2trow?.tenantId}`)
  check('N2e test row tokens tercatat + costUsd ≥ 0', n2trow?.ok === true && n2trow?.promptTokens > 0 && (n2trow?.costUsd == null || n2trow.costUsd >= 0),
    `p=${n2trow?.promptTokens} cost=${n2trow?.costUsd}`)

  // ═══ N3 — Model tanpa rate → costUsd null + tokens tercatat + untrackedModels ═══
  const UNTRACKED = 'model-tanpa-rate'
  const n3put = await api('PUT', '/api/sa/ai-config', { cloudModel: UNTRACKED }, saTok)
  check('N3 PUT cloudModel model-tanpa-rate → 200', n3put.status === 200, `status=${n3put.status}`)
  const n3c = await seedOneMsgChat()
  const n3 = await api('POST', `/api/chats/${n3c.id}/summary`, {}, t8AdminTok)
  check('N3b summary model tanpa rate → 200', n3.status === 200, `status=${n3.status}`)
  const n3row = await lastUsageRow()
  check('N3c costUsd NULL (model tanpa rate, D4) + tokens tetap tercatat',
    n3row?.costUsd == null && n3row?.promptTokens === 700 && n3row?.outputTokens === 50,
    `cost=${JSON.stringify(n3row?.costUsd)} p=${n3row?.promptTokens}`)
  check('N3d rate snapshot semua null (rate tidak ada)', n3row?.rateInput == null && n3row?.rateCached == null && n3row?.rateOutput == null, '')
  const n3usage = await api('GET', '/api/sa/ai-usage?range=all', undefined, saTok)
  check('N3e untrackedModels berisi model-tanpa-rate', Array.isArray(n3usage.data?.untrackedModels) && n3usage.data.untrackedModels.includes(UNTRACKED),
    JSON.stringify(n3usage.data?.untrackedModels))

  // ═══ N4 — Snapshot semantics: PUT rate baru → call baru pakai rate baru; row lama utuh ═══
  const n1CostBefore = n1row.costUsd
  // kembalikan cloudModel ke glm-5.3-flash (N3 menggantinya jadi model-tanpa-rate)
  await api('PUT', '/api/sa/ai-config', { cloudModel: 'glm-5.3-flash' }, saTok)
  const n4put = await api('PUT', '/api/sa/ai-rates', { rates: [{ model: 'glm-5.3-flash', inputPerM: 0.15, cachedPerM: 0.03, outputPerM: 1.0 }] }, saTok)
  check('N4 PUT rate glm-5.3-flash output=1.00 → 200', n4put.status === 200, `status=${n4put.status}`)
  const n4c = await seedOneMsgChat()
  const n4s = await api('POST', `/api/chats/${n4c.id}/summary`, {}, t8AdminTok)
  check('N4b call baru → 200', n4s.status === 200, `status=${n4s.status}`)
  const n4row = await lastUsageRow()
  // rate baru: (600×0.15 + 100×0.03 + 50×1.00)/1e6 = (90 + 3 + 50)/1e6 = 0.000143
  const EXPECT_N4 = (600 * 0.15 + 100 * 0.03 + 50 * 1.0) / 1e6
  check('N4c call BARU pakai rate baru (0.000143, tol 1e-9)',
    n4row?.costUsd != null && Math.abs(n4row.costUsd - EXPECT_N4) <= 1e-9,
    `cost=${n4row?.costUsd} expect=${EXPECT_N4}`)
  check('N4d snapshot rate baru tercatat (out=1.0)', n4row?.rateOutput === 1.0, `out=${n4row?.rateOutput}`)
  const n1rowAfter = await prisma.aiUsageLog.findUnique({ where: { id: n1row.id } })
  check('N4e row LAMA costUsd TIDAK berubah (snapshot per-call, D3)',
    Math.abs(n1rowAfter.costUsd - n1CostBefore) <= 1e-12 && n1rowAfter.rateOutput === 0.5,
    `old=${n1rowAfter.costUsd} before=${n1CostBefore} rateOut=${n1rowAfter.rateOutput}`)
  // kembalikan rate seed PENUH via seed script (PUT = replace-all — satu-satunya row
  // di N4 menghapus 16 rate lain; seed idempoten memulihkan semua 17)
  execSync('node prisma/seed-ai-rates.js /tmp/saas-v3-e2e.db', { cwd: REPO, stdio: 'pipe' })
  const n4res = await api('GET', '/api/sa/ai-rates', undefined, saTok)
  const n4g = n4res.data?.rates?.find((r) => r.model === 'glm-5.3-flash')
  check('N4f rate dikembalikan ke seed (out=0.5) + 17 model', n4res.status === 200 && n4g?.outputPerM === 0.5 && n4res.data.rates.length === 17, `status=${n4res.status} out=${n4g?.outputPerM} n=${n4res.data?.rates?.length}`)

  // ═══ N5 — Fallback (primary down + local up): costUsd=0, wouldCostUsd>0, hemat ═══
  await api('PUT', '/api/sa/ai-config', { cloudModel: 'glm-5.3-flash' }, saTok) // pastikan primary ber-rate
  const n5put = await api('PUT', '/api/sa/ai-config', { cloudBaseUrl: 'http://127.0.0.1:19191', fallbackEnabled: true, localBaseUrl: MOCK_URL, localModel: 'mock-model-b' }, saTok)
  check('N5 PUT fallback config → 200 (key keep)', n5put.status === 200 && n5put.data?.fallbackEnabled === true, `status=${n5put.status}`)
  const n5c = await seedOneMsgChat()
  const n5 = await api('POST', `/api/chats/${n5c.id}/summary`, {}, t8AdminTok)
  check('N5b summary via fallback lokal → 200 + viaFallback true', n5.status === 200 && n5.data?.viaFallback === true, `status=${n5.status} fb=${n5.data?.viaFallback}`)
  const n5row = await lastUsageRow()
  check('N5c row fallback: costUsd=0 + viaFallback=true + model=mock-model-b + primaryModel=glm-5.3-flash',
    n5row?.costUsd === 0 && n5row?.viaFallback === true && n5row?.model === 'mock-model-b' && n5row?.primaryModel === 'glm-5.3-flash',
    `cost=${n5row?.costUsd} model=${n5row?.model} primary=${n5row?.primaryModel}`)
  // wouldCostUsd = estimasi rate primary glm-5.3-flash = 0.000118 (>0, D5)
  check('N5d wouldCostUsd > 0 (est. via rate primary cloud)',
    n5row?.wouldCostUsd != null && n5row.wouldCostUsd > 0 && Math.abs(n5row.wouldCostUsd - EXPECT_N1) <= 1e-9,
    `would=${n5row?.wouldCostUsd}`)
  const n5u = await api('GET', '/api/sa/ai-usage?range=all', undefined, saTok)
  check('N5e totals.fallbackSavedUsd > 0 (SUM wouldCostUsd baris fallback)',
    n5u.data?.totals?.fallbackSavedUsd > 0, `saved=${n5u.data?.totals?.fallbackSavedUsd}`)
  check('N5f totals.fallbacks ≥ 1', (n5u.data?.totals?.fallbacks || 0) >= 1, `fb=${n5u.data?.totals?.fallbacks}`)
  await api('PUT', '/api/sa/ai-config', { cloudBaseUrl: MOCK_URL, fallbackEnabled: false }, saTok)

  // ═══ N6 — Error path (mock 500): ok=false, UPSTREAM_5XX, tokens 0, costUsd 0 ═══
  mockMode = 'err500'
  const n6c = await seedOneMsgChat()
  const n6 = await api('POST', `/api/chats/${n6c.id}/summary`, {}, t8AdminTok)
  check('N6 summary mock 500 → 502', n6.status === 502, `status=${n6.status}`)
  mockMode = 'ok'
  const n6row = await lastUsageRow()
  check('N6b row error: ok=false + errorCode=UPSTREAM_5XX', n6row?.ok === false && n6row?.errorCode === 'UPSTREAM_5XX',
    `ok=${n6row?.ok} code=${n6row?.errorCode}`)
  check('N6c row error: tokens 0 + costUsd 0', n6row?.promptTokens === 0 && n6row?.cachedTokens === 0 && n6row?.outputTokens === 0 && n6row?.costUsd === 0,
    `p=${n6row?.promptTokens} cost=${JSON.stringify(n6row?.costUsd)}`)
  const n6u = await api('GET', '/api/sa/ai-usage?range=all', undefined, saTok)
  check('N6d totals.errors ≥ 1', (n6u.data?.totals?.errors || 0) >= 1, `errors=${n6u.data?.totals?.errors}`)

  // ═══ N7 — Range stats: seed rows lintas hari → totals/perDay/perTenant benar ═══
  // Seed row sintetis lintas hari (COPY db only): 2 hari lalu t8+summary, 40 hari lalu t10.
  const t8SeedCost = 0.0025
  const t10SeedCost = 0.0075
  await prisma.aiUsageLog.create({ data: {
    tenantId: 8, chatId: null, source: 'summary', model: 'glm-5.3-flash', viaFallback: false,
    promptTokens: 1000, cachedTokens: 0, outputTokens: 100, latencyMs: 900, ok: true,
    rateInput: 0.15, rateCached: 0.03, rateOutput: 0.5, costUsd: t8SeedCost,
    createdAt: new Date(wibDaysAgoMs(2)),
  } })
  await prisma.aiUsageLog.create({ data: {
    tenantId: 10, chatId: null, source: 'summary', model: 'kimi-k3', viaFallback: false,
    promptTokens: 500, cachedTokens: 0, outputTokens: 100, latencyMs: 1200, ok: true,
    rateInput: 3, rateCached: 0.3, rateOutput: 15, costUsd: t10SeedCost,
    createdAt: new Date(wibDaysAgoMs(40)),
  } })
  const uToday = await api('GET', '/api/sa/ai-usage?range=today', undefined, saTok)
  check('N7a usage today → 200 + perDay 1 elemen (hari ini WIB)',
    uToday.status === 200 && uToday.data?.perDay?.length === 1 && uToday.data.perDay[0].date === wibTodayStr(),
    `status=${uToday.status} n=${uToday.data?.perDay?.length} d=${uToday.data?.perDay?.[0]?.date}`)
  const u7 = await api('GET', '/api/sa/ai-usage?range=7d', undefined, saTok)
  check('N7b usage 7d → perDay 7 elemen + dates penuh (last = today)',
    u7.status === 200 && u7.data?.perDay?.length === 7 && u7.data.perDay[6].date === wibTodayStr(),
    `n=${u7.data?.perDay?.length}`)
  check('N7c 7d perDay: 2 hari lalu = 1 call (seed t8), hari ini = call N1..N6',
    u7.data?.perDay?.[4]?.calls === 1 && (u7.data?.perDay?.[6]?.calls || 0) >= 6,
    `d-2=${u7.data?.perDay?.[4]?.calls} today=${u7.data?.perDay?.[6]?.calls}`)
  check('N7d 7d totals.calls = sum perDay (konsisten)',
    u7.data?.totals?.calls === u7.data?.perDay?.reduce((a, d) => a + d.calls, 0),
    `totals=${u7.data?.totals?.calls}`)
  check('N7e 7d costUsd = sum perDay cost (tol 1e-9)',
    Math.abs(u7.data?.totals?.costUsd - u7.data?.perDay?.reduce((a, d) => a + d.costUsd, 0)) <= 1e-9,
    `totals=${u7.data?.totals?.costUsd}`)
  // 2 hari lalu cost = t8SeedCost + (row fallback N5 kalau jatuh hari itu — fallback hari ini)
  check('N7f perDay d-2 costUsd = t8 seed (0.0025)', Math.abs(u7.data.perDay[4].costUsd - t8SeedCost) <= 1e-9, `cost=${u7.data?.perDay?.[4]?.costUsd}`)
  const u30 = await api('GET', '/api/sa/ai-usage?range=30d', undefined, saTok)
  check('N7g 30d → perDay 30 elemen; row 40-hari-lalu TIDAK masuk',
    u30.status === 200 && u30.data?.perDay?.length === 30 && u30.data.totals.calls === u7.data.totals.calls,
    `n=${u30.data?.perDay?.length} calls30=${u30.data?.totals?.calls} calls7=${u7.data?.totals?.calls}`)
  const uAll = await api('GET', '/api/sa/ai-usage?range=all', undefined, saTok)
  check('N7h all → row 40-hari-lalu masuk (kimi-k3 tenant 10)',
    uAll.status === 200 && uAll.data.totals.calls === u7.data.totals.calls + 1,
    `all=${uAll.data?.totals?.calls} 7d=${u7.data?.totals?.calls}`)
  check('N7i all totals.costUsd = 7d + t10 seed (tol 1e-9)',
    Math.abs(uAll.data.totals.costUsd - (u7.data.totals.costUsd + t10SeedCost)) <= 1e-9,
    `all=${uAll.data?.totals?.costUsd} expect=${u7.data.totals.costUsd + t10SeedCost}`)
  const pt7 = u7.data?.perTenant || []
  check('N7j perTenant: t8 ada + t10 TIDAK di 7d (row t10 = 40 hari lalu)',
    pt7.some((t) => t.tenantId === 8) && !pt7.some((t) => t.tenantId === 10),
    `ids=${pt7.map((t) => t.tenantId).join(',')}`)
  check('N7k perTenant t8: calls 7d = 1 seed + call N-hari-ini (tanpa source test/preview)',
    pt7.find((t) => t.tenantId === 8)?.calls >= 2,
    `calls=${pt7.find((t) => t.tenantId === 8)?.calls}`)
  const ptAll = uAll.data?.perTenant || []
  check('N7l perTenant all: t10 muncul (kimi-k3) terpisah dari t8',
    ptAll.some((t) => t.tenantId === 10) && ptAll.some((t) => t.tenantId === 8) && ptAll.find((t) => t.tenantId === 10)?.calls === 1,
    `t10=${JSON.stringify(ptAll.find((t) => t.tenantId === 10))}`)
  check('N7m perTenant row shape (name dari Tenant, lastUsedAt ISO)',
    ptAll.every((t) => typeof t.name === 'string' && t.lastUsedAt == null || !Number.isNaN(Date.parse(t.lastUsedAt))),
    `t8name=${ptAll.find((t) => t.tenantId === 8)?.name}`)
  check('N7n usdToIdr default 16000 dari response', u7.data?.usdToIdr === 16000, `kurs=${u7.data?.usdToIdr}`)
  check('N7o avgLatencyMs hanya ok=true + latency ada (number/null)',
    u7.data?.totals?.avgLatencyMs == null || Number.isFinite(u7.data.totals.avgLatencyMs), `avg=${u7.data?.totals?.avgLatencyMs}`)
  const uBad = await api('GET', '/api/sa/ai-usage?range=bogus', undefined, saTok)
  check('N7p range invalid → 400', uBad.status === 400, `status=${uBad.status}`)

  // ═══ N8 — DELETE rate → model jadi untracked ═══
  // untracked = model ok-call dgn costUsd NULL di range (snapshot per-call — row lama
  // dgn rate lama tetap cost-nya). Jadi: DELETE rate kimi-k3 → call BARU kimi-k3
  // (cloudModel diganti) → costUsd NULL → masuk untrackedModels.
  const n8del = await api('DELETE', '/api/sa/ai-rates/kimi-k3', undefined, saTok)
  check('N8 DELETE kimi-k3 → 200', n8del.status === 200 && n8del.data?.deleted === 'kimi-k3', `status=${n8del.status}`)
  await api('PUT', '/api/sa/ai-config', { cloudModel: 'kimi-k3' }, saTok)
  const n8c2 = await seedOneMsgChat()
  const n8call = await api('POST', `/api/chats/${n8c2.id}/summary`, {}, t8AdminTok)
  check('N8b call kimi-k3 tanpa rate → 200', n8call.status === 200 && n8call.data?.model === 'kimi-k3', `status=${n8call.status} model=${n8call.data?.model}`)
  const n8row = await lastUsageRow()
  check('N8c2 row call baru: costUsd NULL + rate null', n8row?.costUsd == null && n8row?.rateInput == null, `cost=${JSON.stringify(n8row?.costUsd)}`)
  const n8b = await api('DELETE', '/api/sa/ai-rates/kimi-k3', undefined, saTok)
  check('N8b2 DELETE lagi → 404 (sudah tidak ada)', n8b.status === 404, `status=${n8b.status}`)
  const n8u = await api('GET', '/api/sa/ai-usage?range=all', undefined, saTok)
  check('N8c kimi-k3 masuk untrackedModels setelah DELETE', n8u.data?.untrackedModels?.includes('kimi-k3') === true,
    JSON.stringify(n8u.data?.untrackedModels))
  const n8audit = await prisma.saAuditLog.findFirst({ where: { action: 'ai_rates_delete' }, orderBy: { id: 'desc' } })
  check('N8d audit ai_rates_delete tercatat', !!n8audit?.id, `id=${n8audit?.id}`)
  await api('PUT', '/api/sa/ai-config', { cloudModel: 'glm-5.3-flash' }, saTok) // restore primary ber-rate

  // ═══ N9 — Validasi PUT rates: 400 utk karakter liar / negatif / kurs ≤ 0 ═══
  const n9a = await api('PUT', '/api/sa/ai-rates', { rates: [{ model: 'mode$l@jah', inputPerM: 0.1, outputPerM: 0.1 }] }, saTok)
  check('N9a model karakter liar → 400', n9a.status === 400, `status=${n9a.status}`)
  const n9b = await api('PUT', '/api/sa/ai-rates', { rates: [{ model: 'ok-model', inputPerM: -0.5, outputPerM: 0.1 }] }, saTok)
  check('N9b angka negatif → 400', n9b.status === 400, `status=${n9b.status}`)
  const n9c = await api('PUT', '/api/sa/ai-rates', { usdToIdr: 0, rates: [] }, saTok)
  check('N9c usdToIdr ≤ 0 → 400', n9c.status === 400, `status=${n9c.status}`)
  const n9d = await api('PUT', '/api/sa/ai-rates', { rates: [{ model: 'x'.repeat(65), inputPerM: 0.1, outputPerM: 0.1 }] }, saTok)
  check('N9d model >64 char → 400', n9d.status === 400, `status=${n9d.status}`)
  const n9e = await api('PUT', '/api/sa/ai-rates', { rates: Array.from({ length: 101 }, (_, i) => ({ model: 'm' + i, inputPerM: 0.1, outputPerM: 0.1 })) }, saTok)
  check('N9e rates >100 row → 400', n9e.status === 400, `status=${n9e.status}`)
  const n9f = await api('PUT', '/api/sa/ai-rates', { usdToIdr: 16000, rates: [{ model: 'glm-5.3-flash', inputPerM: 0.15, cachedPerM: 0.03, outputPerM: 0.5 }, { model: 'kimi-k3', inputPerM: 3, cachedPerM: 0.3, outputPerM: 15 }] }, saTok)
  check('N9f PUT valid → 200 + echo rates', n9f.status === 200 && Array.isArray(n9f.data?.rates) && n9f.data.rates.length === 2, `status=${n9f.status} n=${n9f.data?.rates?.length}`)
  const n9audit = await prisma.saAuditLog.findFirst({ where: { action: 'ai_rates_update' }, orderBy: { id: 'desc' } })
  check('N9g audit ai_rates_update (row count, tanpa key/token)', !!n9audit?.id && (n9audit?.detailJson || '').includes('rateCount') && !String(n9audit?.detailJson || '').includes('test-key'), `id=${n9audit?.id}`)
  // restore seed penuh (17 model) utk konsistensi
  execSync('node prisma/seed-ai-rates.js /tmp/saas-v3-e2e.db', { cwd: REPO, stdio: 'pipe' })
  const n9r = await prisma.aiModelRate.findMany()
  check('N9h restore seed → 17 model lagi', n9r.length === 17, `n=${n9r.length}`)

  // ═══ N10 — SA-only: token CS/admin tenant → 401/403 di ai-usage & ai-rates ═══
  const n10a = await api('GET', '/api/sa/ai-usage', undefined, t8CsTok)
  check('N10a ai-usage dgn token CS → 403', n10a.status === 403, `status=${n10a.status}`)
  const n10b = await api('GET', '/api/sa/ai-rates', undefined, t8AdminTok)
  check('N10b ai-rates dgn token admin tenant → 403', n10b.status === 403, `status=${n10b.status}`)
  const n10c = await api('PUT', '/api/sa/ai-rates', { rates: [] }, t8AdminTok)
  check('N10c PUT ai-rates dgn token admin tenant → 403', n10c.status === 403, `status=${n10c.status}`)
  const n10d = await api('DELETE', '/api/sa/ai-rates/kimi-k3', undefined, t8CsTok)
  check('N10d DELETE ai-rates dgn token CS → 403', n10d.status === 403, `status=${n10d.status}`)
  const n10e = await api('GET', '/api/sa/ai-usage', undefined)
  check('N10e ai-usage tanpa token → 401', n10e.status === 401, `status=${n10e.status}`)

  mockServer.close()
  console.log(`\n=== e2e-v3924: ${pass} PASS / ${fails.length} FAIL ===`)
  if (fails.length) { console.log('FAILED:', fails.join(' | ')); process.exitCode = 1 }
  await prisma.$disconnect()
  process.exit(process.exitCode || 0) // mock sockets keep event loop alive → exit eksplisit
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })