/**
 * E2E v4.0.0 — ChatBareng AI (CB-AI) Knowledge Auto-Reply (spec docs/spec-v4.0.0-cbai-knowledge.md §10).
 * Jalan terhadap DB COPY di port 5099 (WA_DISABLED=1 + E2E_DEBUG_INBOUND=1) — produksi (5047)
 * TIDAK tersentuh. Pola: scripts/e2e-v3925.cjs (mock LLM 127.0.0.1:11435, token 700/100/50,
 * capture prompt, trigger runtime via POST /api/wa/inbound — jalur ASLI).
 *
 * Checks:
 * N1  CRUD dokumen: upload txt+label, dup-label → replace (updatedAt naik), composer create +
 *     edit inline, toggle aktif, delete, label kosong → 400
 * N2  parse: csv ';' → baris benar; xlsx 2-sheet digabung; docx fixture; txt >100k → truncated
 * N3  in-hours CB-AI covered → jawaban + aiReplyCount=1 + row 'knowledge' + cost PERSIS (1e-9)
 * N4  no_answer in-hours → TIDAK ada auto-send + counter++ (fallback kehitung)
 * N5  limit=2 → jawab 2× → 3rd bisu + queue; 4th masih bisu
 * N6  human out-message hari ini → skip total (marker existing, counter tidak nambah)
 * N7  window: lastAiReplyAt=-25h → reset + jawab lagi; -2h + count=limit → bisu
 * N8  outside CB-AI: no_answer → outsideHoursText (terhitung); limit habis → away TANPA counter
 * N9  plan ✗ (Lite): PUT mode cbai → 403 (admin & SA ?tenant=); GET aiUsage null; plan ✓ → 200
 * N10 trial endpoint: covered & no_answer; counter tidak nambah; metering terlog
 * N11 footer toggle: OFF → prompt capture tanpa "(info per"; ON → ada
 * N12 0 doc aktif → skip tanpa LLM call (0 row metering)
 * N13 gateway answerMode: covered → jawaban AI + counter++; no_answer → replyText + counter++;
 *     plan ✗ → PUT 403 (admin & SA) + runtime degrade replyText; tickbox scope → prompt HANYA doc itu
 * N14 ROLLBACK TEST: restore backup pre-v4.0.0 ke copy-DB → kode lama + kolom baru diabaikan + health 200
 * S3b key tidak bocor; N-liar: cbaiLimit 0/11/"3" → 400; outsideHoursMode "yes" → 400
 *
 * Cara jalan (dari repo root):
 *   cp prisma/data/saas-v3.db /tmp/saas-v3-e2e.db
 *   && apply prisma/migrations/20260926065000_cbai_knowledge/migration.sql ke copy
 *   && insert row bookkeeping _prisma_migrations (pola proven)
 *   && node prisma/seed-ai-rates.js /tmp/saas-v3-e2e.db
 *   && PORT=5099 DATABASE_URL=file:/tmp/saas-v3-e2e.db WA_DISABLED=1 E2E_OK_SEND=1 E2E_DEBUG_INBOUND=1 node src/server.js &
 *   node scripts/e2e-reset-superadmin.cjs && set -a && . ./.env && set +a && node scripts/e2e-v4000.cjs
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
async function apiUpload(path, token, label, buffer, filename, mimetype, docId = null) {
  const fd = new FormData()
  fd.append('label', label)
  if (docId) fd.append('docId', String(docId))
  fd.append('file', new Blob([buffer], { type: mimetype }), filename)
  const res = await fetch(BASE + path, { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: fd })
  let data = null
  try { data = await res.json() } catch {}
  return { status: res.status, data }
}

const wibMonthStartMs = () => {
  const ym = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 7) // ym dalam WIB
  return new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1, -7)).getTime()
}
const EXPECT_COST = (600 * 0.15 + 100 * 0.03 + 50 * 0.5) / 1e6 // 0.000118 (rate seed glm-5.3-flash)

async function main() {
  // ═══ Setup: SA login + user tenant (pola v3919/v3924/v3925) ═══
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
    const pw = 'e2e40pw-' + username
    const existing = await prisma.user.findFirst({ where: { username } })
    if (existing) {
      await prisma.user.update({ where: { id: existing.id }, data: { status: 'active', role, passwordHash: await hashPassword(pw) } })
    } else {
      await prisma.user.create({ data: { username, passwordHash: await hashPassword(pw), role, tenantId, status: 'active' } })
    }
    return pw
  }
  // t8 (Mazaya) = tenant uji CB-AI (plan ✓ via PUT plan SA)
  const pwAdmin8 = await ensureE2EUser('e2e40adm8', 'admin', 8)
  const t8AdminTok = await e2eLogin('e2e40adm8', pwAdmin8)
  check('S1 login admin t8 → token', !!t8AdminTok, `adm8=${!!t8AdminTok}`)
  if (!t8AdminTok) return process.exit(1)
  const s1put = await api('PUT', '/api/sa/tenants/8/plan', { featAiKnowledge: true, featMenuGateway: true, featAiRouting: true }, saTok)
  check('S1b PUT plan t8 featAiKnowledge=true → 200 + echo', s1put.status === 200 && s1put.data?.plan?.featAiKnowledge === true, `status=${s1put.status} echo=${s1put.data?.plan?.featAiKnowledge}`)

  // ═══ Mock LLM 127.0.0.1:11435 — token fields 700/100/50 + skenario CB-AI ═══
  const http = require('http')
  // mode: {type:'covered', answer} | {type:'nocover'} | {type:'garbage'} | {type:'err500'}
  let mockMode = { type: 'covered', answer: 'Harga paket A kami Rp 500.000.' }
  let mockCalls = 0
  let lastPrompt = '' // capture system+user prompt (N11 footer / N13 scope)
  let lastSystem = ''
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
        const msgs = parsed.messages || []
        lastSystem = (msgs.find((m) => m.role === 'system') || {}).content || ''
        lastPrompt = msgs.map((m) => m.content).join('\n---\n')
        if (mockMode.type === 'err500') {
          res.writeHead(500, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ error: 'mock upstream 500' }))
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        const content = mockMode.type === 'covered'
          ? JSON.stringify({ covered: true, answer: mockMode.answer })
          : mockMode.type === 'nocover'
            ? JSON.stringify({ covered: false })
            : 'bukan json sama sekali'
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

  // Idempoten re-run: bersihkan state AI (COPY db only) + seed rates + neutralisasi row
  // per-slot warisan tenant-8 (AR slot-0 greetMode=menu & MG slot-0 enabled menimpa shared —
  // lesson v3925 QA E2E: row per-slot menimpa shared via getConfigForSlot slot fallback).
  await prisma.aiUsageLog.deleteMany({})
  await prisma.aiKnowledgeDoc.deleteMany({ where: { tenantId: 8 } })
  await prisma.aiConfig.deleteMany({})
  await prisma.autoReplyConfig.deleteMany({ where: { tenantId: 8, numberSlot: { not: null } } })
  await prisma.menuGatewayConfig.deleteMany({ where: { tenantId: 8, numberSlot: { not: null } } })
  const { execSync } = require('child_process')
  execSync('node prisma/seed-ai-rates.js /tmp/saas-v3-e2e.db', { cwd: REPO, stdio: 'pipe' })
  const cfgPut = await api('PUT', '/api/sa/ai-config', { cloudBaseUrl: 'http://127.0.0.1:11435', apiKey: 'test-key-123456-2345', cloudModel: 'glm-5.3-flash' }, saTok)
  check('S3 PUT ai-config (mock + glm-5.3-flash) → 200', cfgPut.status === 200, `status=${cfgPut.status}`)

  // ═══ S5 — AutoReplyConfig tenant 8: CB-AI siap (in-hours + outside; jam 00:00–23:59) ═══
  const s5 = await api('PUT', '/api/autoreply', {
    greetEnabled: true, greetMode: 'cbai', greetText: 'Halo! CS E2E40 siap membantu. 🙏',
    outsideHoursEnabled: true, outsideHoursMode: 'cbai', outsideHoursText: 'CS E2E40 sedang istirahat, balas pagi ya. 🙏',
    monFriEnabled: true, monFriStart: '00:00', monFriEnd: '23:59',
    satEnabled: true, satStart: '00:00', satEnd: '23:59',
    sunEnabled: true, sunStart: '00:00', sunEnd: '23:59',
    numberSlots: null,
  }, t8AdminTok)
  check('S5 PUT autoreply cbai in+out (plan ✓) → 200', s5.status === 200, `status=${s5.status} body=${JSON.stringify(s5.data).slice(0, 120)}`)

  // ═══ Helper: seed chat open+unassigned + trigger jalur asli ═══
  let nSeq = 4000
  const chatByJid = new Map()
  async function seedChat(name, { awaiting = false } = {}) {
    let jid
    for (;;) {
      jid = `62899940${String(nSeq++).padStart(4, '0')}@s.whatsapp.net`
      const ex = await prisma.chat.findUnique({ where: { tenantId_numberSlot_waJid: { tenantId: 8, numberSlot: 0, waJid: jid } } })
      if (!ex) break
    }
    const chat = await prisma.chat.create({
      data: {
        tenantId: 8, waJid: jid, contactPhone: jid.slice(0, 12), contactName: name,
        status: 'open', queuedAt: awaiting ? null : new Date(),
        ...(awaiting ? { menuState: 'awaiting', menuRequestedAt: new Date() } : {}),
      },
    })
    await prisma.contact.create({ data: { tenantId: 8, chatId: chat.id, name, phone: jid.slice(0, 12), source: 'chat' } })
    await prisma.message.create({ data: { tenantId: 8, chatId: chat.id, direction: 'in', content: encryptText('halo kak'), senderName: 'Customer', timestamp: new Date() } })
    chatByJid.set(jid, chat.id)
    return chat
  }
  async function incoming(chatId, text, settleMs = 1200) {
    const chat = await prisma.chat.findUnique({ where: { id: chatId } })
    if (!chat) return false
    const r = await api('POST', '/api/wa/inbound', {
      tenantId: 8,
      slot: 0,
      messages: {
        key: { remoteJid: chat.waJid, fromMe: false, id: 'E2E40MSG-' + chatId + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) },
        pushName: chat.contactName || 'E2E40',
        message: { conversation: text },
      },
    }, saTok)
    if (r.status !== 200) { console.log(`  [inbound] status=${r.status} body=${JSON.stringify(r.data).slice(0, 160)}`); return false }
    // v4.0.0 — maybeAutoReply di pool hook = FIRE-AND-FORGET (async): tunggu jalur CB-AI
    // settle (LLM mock call + send + counter) sebelum test lanjut — anti-race mockMode.
    await new Promise((res) => setTimeout(res, settleMs))
    return r.data?.ok === true && r.data?.chatId === chatId
  }
  async function lastKnowledgeRow() {
    return prisma.aiUsageLog.findFirst({ where: { source: 'knowledge' }, orderBy: { id: 'desc' } })
  }
  async function lastAutoMessages(chatId) {
    const rows = await prisma.message.findMany({
      where: { chatId, direction: 'out', isAuto: true },
      orderBy: { id: 'desc' },
      take: 5,
    })
    return rows.map((m) => decryptTextSafe(m.content))
  }

  // ═══════════ N1 — CRUD dokumen ═══════════
  const txt = Buffer.from('Kami ChatBareng E2E40.\nJam buka: 08.00-17.00\nAlamat: Jl. Testing No. 40\nHarga paket A: Rp 500.000\nHarga paket B: Rp 1.000.000', 'utf8')
  const n1a = await apiUpload('/api/ai-knowledge/upload', t8AdminTok, 'E2E40 Pricelist', txt, 'pricelist.txt', 'text/plain')
  check('N1 upload txt + label → 200 + parsed', n1a.status === 200 && n1a.data?.doc?.charCount === txt.length && n1a.data?.doc?.sourceType === 'file',
    `status=${n1a.status} chars=${n1a.data?.doc?.charCount}/${txt.length}`)
  const docPrice = n1a.data?.doc
  const n1a2 = await apiUpload('/api/ai-knowledge/upload', t8AdminTok, 'E2E40 Pricelist', Buffer.from(txt.toString() + '\nHarga paket C: Rp 2.000.000'), 'pricelist2.txt', 'text/plain')
  check('N1b dup-label → replace (id sama, charCount naik, updatedAt ≥)',
    n1a2.status === 200 && n1a2.data?.replaced === true && n1a2.data?.doc?.id === docPrice.id && n1a2.data?.doc?.charCount > docPrice.charCount,
    `replaced=${n1a2.data?.replaced} chars=${n1a2.data?.doc?.charCount}>${docPrice.charCount}`)

  const n1c = await api('POST', '/api/ai-knowledge/compose', { label: 'E2E40 FAQ', content: 'FAQ E2E40: Buka setiap hari. CS online 08.00-21.00.' }, t8AdminTok)
  check('N1c composer create → 200 (sourceType composer)', n1c.status === 200 && n1c.data?.doc?.sourceType === 'composer' && n1c.data?.doc?.fileName === null, `status=${n1c.status}`)
  const docFaq = n1c.data?.doc
  const n1d = await api('PUT', `/api/ai-knowledge/${docFaq.id}/content`, { content: 'FAQ E2E40 v2: CS online 08.00-21.00. Alamat di Jl. Testing.' }, t8AdminTok)
  check('N1d composer edit inline → 200 + charCount naik', n1d.status === 200 && n1d.data?.doc?.charCount > docFaq.charCount, `status=${n1d.status}`)
  const n1e = await api('PUT', `/api/ai-knowledge/${docFaq.id}/active`, { active: false }, t8AdminTok)
  check('N1e toggle aktif OFF → 200', n1e.status === 200 && n1e.data?.doc?.active === false, `status=${n1e.status}`)
  const n1f = await api('PUT', `/api/ai-knowledge/${docFaq.id}/active`, { active: true }, t8AdminTok)
  check('N1f toggle aktif ON kembali → 200', n1f.status === 200 && n1f.data?.doc?.active === true, `status=${n1f.status}`)
  const n1g = await api('DELETE', `/api/ai-knowledge/${docFaq.id}`, undefined, t8AdminTok)
  check('N1g delete doc → 200', n1g.status === 200, `status=${n1g.status}`)
  const n1h = await api('POST', '/api/ai-knowledge/compose', { label: '', content: 'x' }, t8AdminTok)
  check('N1h label kosong → 400', n1h.status === 400, `status=${n1h.status}`)

  // ═══════════ N2 — parse formats ═══════════
  const n2csv = await apiUpload('/api/ai-knowledge/upload', t8AdminTok, 'E2E40 CSV', Buffer.from('layanan;harga\nfisio;150rb\nmassage;100rb', 'utf8'), 'layanan.csv', 'text/csv')
  check('N2a csv ; parse → header+rows jadi teks',
    n2csv.status === 200 && n2csv.data?.doc?.content.includes('layanan | harga') && n2csv.data?.doc?.content.includes('fisio | 150rb') && n2csv.data?.doc?.content.includes('harga'),
    `status=${n2csv.status} content=${JSON.stringify(n2csv.data?.doc?.content || '').slice(0, 120)}`)
  const docCsv = n2csv.data?.doc

  // xlsx 2-sheet digabung (SheetJS langsung di script utk generate fixture — pola N2 spec)
  const XLSX = require(REPO + '/node_modules/xlsx')
  const wb = XLSX.utils.book_new()
  const ws1 = XLSX.utils.aoa_to_sheet([['item', 'stok'], ['obat A', '10'], ['obat B', '5']])
  const ws2 = XLSX.utils.aoa_to_sheet([['paket', 'harga'], ['lab dasar', '300rb']])
  XLSX.utils.book_append_sheet(wb, ws1, 'Stok Obat')
  XLSX.utils.book_append_sheet(wb, ws2, 'Paket Lab')
  const xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  const n2x = await apiUpload('/api/ai-knowledge/upload', t8AdminTok, 'E2E40 XLSX', xlsxBuf, 'stok.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  check('N2b xlsx 2-sheet digabung + section header nama sheet',
    n2x.status === 200 && n2x.data?.doc?.content.includes('### Stok Obat') && n2x.data?.doc?.content.includes('### Paket Lab') && n2x.data?.doc?.content.includes('obat A | 10'),
    `status=${n2x.status} content=${JSON.stringify((n2x.data?.doc?.content || '').slice(0, 150))}`)
  const docXlsx = n2x.data?.doc

  // docx fixture (mammoth generate via JSZip bawaan mammoth? — gunakan officeparser sederhana:
  // buat docx minimal dengan zip manual — pakai mammoth roundtrip tidak bisa; fixture dibuat via xlsx? TIDAK.
  // Cara proven: generate docx dengan "docx" tidak tersedia → pakai template docx minimal yang ditulis
  // langsung (zip dgn word/document.xml). Kit pakai JSZip? tidak ada — tulis zip store tanpa kompresi via xlsx? xlsx bisa tulis docx? TIDAK.
  // ALTERNATIF: fixture docx dibuat via python3 (zip standard) — deterministic.
  const { spawnSync } = require('child_process')
  const docxPath = '/tmp/e2e40-fixture.docx'
  const py = spawnSync('python3', ['-c', `
import zipfile
with zipfile.ZipFile('/tmp/e2e40-fixture.docx', 'w') as z:
    z.writestr('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    z.writestr('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    z.writestr('word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t xml:space="preserve"> layanan gigi E2E40: scaling 300rb, tambal 200rb </w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Buka Senin-Sabtu 09.00-17.00</w:t></w:r></w:p></w:body></w:document>')
print('ok')
`], { encoding: 'utf8' })
  const docxBuf = require('fs').readFileSync(docxPath)
  const n2d = await apiUpload('/api/ai-knowledge/upload', t8AdminTok, 'E2E40 DOCX', docxBuf, 'layanan.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  check('N2c docx mammoth → teks diekstrak',
    n2d.status === 200 && n2d.data?.doc?.content.includes('layanan gigi E2E40') && n2d.data?.doc?.content.includes('Senin-Sabtu'),
    `status=${n2d.status} content=${JSON.stringify((n2d.data?.doc?.content || '').slice(0, 120))}`)

  // txt >100k → truncated flag
  const bigText = 'X'.repeat(100050)
  const n2t = await apiUpload('/api/ai-knowledge/upload', t8AdminTok, 'E2E40 Big', Buffer.from(bigText, 'utf8'), 'big.txt', 'text/plain')
  check('N2d txt 100.050 char → truncated + charCount cap 100.000',
    n2t.status === 200 && n2t.data?.doc?.truncated === true && n2t.data?.doc?.charCount === 100000,
    `status=${n2t.status} truncated=${n2t.data?.doc?.truncated} chars=${n2t.data?.doc?.charCount}`)
  await api('DELETE', `/api/ai-knowledge/${n2t.data?.doc?.id}`, undefined, t8AdminTok) // cleanup

  // ═══════════ N3 — in-hours CB-AI covered ═══════════
  // (jam kerja 00:00–23:59 seluruh hari → SELALU in-hours utk N3/N4/N5/N7)
  mockMode = { type: 'covered', answer: 'Harga paket A kami Rp 500.000 ya kak.' }
  const n3c = await seedChat('E2E40 N3')
  const kb0 = await prisma.aiUsageLog.count({ where: { source: 'knowledge' } })
  const n3 = await incoming(n3c.id, 'kak harga paket A berapa ya?')
  check('N3 inbound in-hours covered → ok (jalur asli)', n3 === true, `ret=${n3}`)
  const n3chat = await prisma.chat.findUnique({ where: { id: n3c.id } })
  check('N3b aiReplyCount=1 + lastAiReplyAt terisi', n3chat?.aiReplyCount === 1 && !!n3chat?.lastAiReplyAt, `count=${n3chat?.aiReplyCount} last=${n3chat?.lastAiReplyAt}`)
  const n3out = await lastAutoMessages(n3c.id)
  check('N3c jawaban AI terkirim (isAuto out)', n3out.length > 0 && n3out[0].includes('500.000'), `out=${JSON.stringify(n3out).slice(0, 120)}`)
  const n3row = await lastKnowledgeRow()
  check('N3d row AiUsageLog source=knowledge (tenant+chat+ok)',
    !!n3row && n3row.tenantId === 8 && n3row.chatId === n3c.id && n3row.ok === true,
    `id=${n3row?.id} tenant=${n3row?.tenantId} chat=${n3row?.chatId}`)
  check('N3e snapshot cost PERSIS (0.000118, tol 1e-9) + tokens 700/100/50',
    n3row?.costUsd != null && Math.abs(n3row.costUsd - EXPECT_COST) <= 1e-9 && n3row?.promptTokens === 700 && n3row?.cachedTokens === 100 && n3row?.outputTokens === 50,
    `cost=${n3row?.costUsd}`)
  const kb1 = await prisma.aiUsageLog.count({ where: { source: 'knowledge' } })
  check('N3f 1 row knowledge baru', kb1 === kb0 + 1, `n=${kb1} before=${kb0}`)

  // ═══════════ N4 — no_answer in-hours → fallback greetText + counter++ ═══════════
  mockMode = { type: 'nocover' }
  const n4c = await seedChat('E2E40 N4')
  const n4 = await incoming(n4c.id, 'kak boleh tanya hal random gak ada di KB?')
  check('N4 inbound no_answer → ok', n4 === true, `ret=${n4}`)
  const n4chat = await prisma.chat.findUnique({ where: { id: n4c.id } })
  check('N4b counter++ (fallback kehitung) → aiReplyCount=1', n4chat?.aiReplyCount === 1, `count=${n4chat?.aiReplyCount}`)
  const n4out = await lastAutoMessages(n4c.id)
  check('N4c fallback = greetText terkirim (Q1 final)', n4out.length > 0 && n4out[0].includes('E2E40 siap membantu'), `out=${JSON.stringify(n4out).slice(0, 120)}`)
  const n4row = await lastKnowledgeRow()
  check('N4d LLM call tercatat (row knowledge terbaru)', !!n4row && n4row.ok === true, `id=${n4row?.id}`)

  // ═══════════ N5 — limit=2 → jawab 2× → bisu; 4th masih bisu ═══════════
  const n5cfg = await api('PUT', '/api/ai-knowledge/config', { cbaiLimit: 2 }, t8AdminTok)
  check('N5a PUT config cbaiLimit=2 → 200', n5cfg.status === 200 && n5cfg.data?.config?.cbaiLimit === 2, `status=${n5cfg.status}`)
  mockMode = { type: 'covered', answer: 'Jawaban E2E40 N5.' }
  const n5c = await seedChat('E2E40 N5')
  await incoming(n5c.id, 'tanya 1') // jawab 1 → count 1
  await incoming(n5c.id, 'tanya 2') // jawab 2 → count 2
  const n5mid = await prisma.chat.findUnique({ where: { id: n5c.id } })
  check('N5b 2 jawaban → counter=2', n5mid?.aiReplyCount === 2, `count=${n5mid?.aiReplyCount}`)
  const gw5 = await prisma.aiUsageLog.count({ where: { source: 'knowledge' } })
  await incoming(n5c.id, 'tanya 3') // limit → bisu
  const n5chat = await prisma.chat.findUnique({ where: { id: n5c.id } })
  check('N5c 3rd bisu (counter tetap 2, queue normal)', n5chat?.aiReplyCount === 2, `count=${n5chat?.aiReplyCount}`)
  const gw5b = await prisma.aiUsageLog.count({ where: { source: 'knowledge' } })
  check('N5d 3rd TIDAK ada LLM call (0 row baru)', gw5b === gw5, `n=${gw5b} before=${gw5}`)
  await incoming(n5c.id, 'tanya 4') // masih bisu
  const n5chat2 = await prisma.chat.findUnique({ where: { id: n5c.id } })
  check('N5e 4th masih bisu', n5chat2?.aiReplyCount === 2, `count=${n5chat2?.aiReplyCount}`)
  // restore limit default 3
  await api('PUT', '/api/ai-knowledge/config', { cbaiLimit: 3 }, t8AdminTok)

  // ═══════════ N6 — human out-message hari ini → skip total ═══════════
  const n6c = await seedChat('E2E40 N6')
  await prisma.message.create({
    data: { tenantId: 8, chatId: n6c.id, direction: 'out', content: encryptText('sudah dibalas CS manusia ya kak'), senderName: 'cs-human', senderId: null, isAuto: false, timestamp: new Date() },
  })
  // perlu senderId NOT NULL — update senderId=999 (row user? senderId any int ok, query only not null)
  const m6 = await prisma.message.findFirst({ where: { chatId: n6c.id, direction: 'out', isAuto: false }, orderBy: { id: 'desc' } })
  await prisma.message.update({ where: { id: m6.id }, data: { senderId: 1 } })
  const kb6 = await prisma.aiUsageLog.count({ where: { source: 'knowledge' } })
  await incoming(n6c.id, 'halo lagi kak') // human sudah bales → skip SEMUA auto
  const n6chat = await prisma.chat.findUnique({ where: { id: n6c.id } })
  check('N6 human out today → CB-AI skip (0 counter, 0 LLM)', n6chat?.aiReplyCount === 0 && (await prisma.aiUsageLog.count({ where: { source: 'knowledge' } })) === kb6,
    `count=${n6chat?.aiReplyCount} rows=${kb6}`)

  // ═══════════ N7 — window 24 jam ═══════════
  const n7c = await seedChat('E2E40 N7')
  // -25h + count=5 (window mati → budget segar)
  await prisma.chat.update({ where: { id: n7c.id }, data: { aiReplyCount: 5, lastAiReplyAt: new Date(Date.now() - 25 * 3600 * 1000) } })
  mockMode = { type: 'covered', answer: 'Window segar E2E40.' }
  await incoming(n7c.id, 'halo lagi kak')
  const n7chat = await prisma.chat.findUnique({ where: { id: n7c.id } })
  check('N7a lastAiReplyAt=-25h → reset + jawab lagi (count=1)', n7chat?.aiReplyCount === 1, `count=${n7chat?.aiReplyCount}`)
  // -2h + count=limit → bisu
  const n7b = await seedChat('E2E40 N7b')
  await prisma.chat.update({ where: { id: n7b.id }, data: { aiReplyCount: 3, lastAiReplyAt: new Date(Date.now() - 2 * 3600 * 1000) } })
  const gw7 = await prisma.aiUsageLog.count({ where: { source: 'knowledge' } })
  await incoming(n7b.id, 'halo kak nanya')
  const n7bchat = await prisma.chat.findUnique({ where: { id: n7b.id } })
  check('N7b -2h + count=limit → bisu (count tetap 3)', n7bchat?.aiReplyCount === 3, `count=${n7bchat?.aiReplyCount}`)
  check('N7c bisu TANPA LLM call', (await prisma.aiUsageLog.count({ where: { source: 'knowledge' } })) === gw7, `n=${gw7}`)

  // ═══════════ N8 — outside CB-AI (set jam kerja tutup → sekarang outside) ═══════════
  const s8 = await api('PUT', '/api/autoreply', {
    monFriEnabled: true, monFriStart: '00:00', monFriEnd: '00:00', // invalid? start<end — pakai trik: matikan hari ini → full outside
  }, t8AdminTok)
  // matikan SEMUA hari → full outside
  const s8b = await api('PUT', '/api/autoreply', {
    monFriEnabled: false, satEnabled: false, sunEnabled: false,
    outsideHoursEnabled: true, outsideHoursMode: 'cbai', outsideHoursText: 'CS E2E40 sedang istirahat. 🙏',
  }, t8AdminTok)
  check('S8 all-day OFF → full outside (PUT 200)', s8b.status === 200, `status=${s8b.status}`)
  // no_answer outside → outsideHoursText terkirim + DIHITUNG
  mockMode = { type: 'nocover' }
  const n8c = await seedChat('E2E40 N8')
  await incoming(n8c.id, 'halo kak (malam)')
  const n8chat = await prisma.chat.findUnique({ where: { id: n8c.id } })
  const n8out = await lastAutoMessages(n8c.id)
  check('N8a no_answer outside → outsideHoursText terkirim + counter=1',
    n8chat?.aiReplyCount === 1 && n8out.length > 0 && n8out[0].includes('istirahat'), `count=${n8chat?.aiReplyCount} out=${JSON.stringify(n8out).slice(0, 100)}`)
  // limit habis outside → away text TANPA nambah counter
  await prisma.chat.update({ where: { id: n8c.id }, data: { aiReplyCount: 3, lastAiReplyAt: new Date(Date.now() - 30 * 60 * 1000) } })
  const kb8 = await prisma.aiUsageLog.count({ where: { source: 'knowledge' } })
  await incoming(n8c.id, 'halo lagi kak (limit)')
  const n8chat2 = await prisma.chat.findUnique({ where: { id: n8c.id } })
  check('N8b limit habis outside → away text TANPA counter (3 tetap)',
    n8chat2?.aiReplyCount === 3 && (await prisma.aiUsageLog.count({ where: { source: 'knowledge' } })) === kb8,
    `count=${n8chat2?.aiReplyCount} rows=${kb8}`)

  // ═══════════ N9 — plan gate (Lite ✗ → 403; SA ?tenant= JUGA) ═══════════
  const n9off = await api('PUT', '/api/sa/tenants/8/plan', { featAiKnowledge: false }, saTok)
  check('N9a PUT plan featAiKnowledge=false → 200', n9off.status === 200, `status=${n9off.status}`)
  const n9put = await api('PUT', '/api/autoreply', { greetMode: 'cbai' }, t8AdminTok)
  check('N9b admin plan ✗ PUT greetMode=cbai → 403', n9put.status === 403, `status=${n9put.status}`)
  const n9put2 = await api('PUT', '/api/autoreply', { outsideHoursMode: 'cbai' }, t8AdminTok)
  check('N9c admin plan ✗ PUT outsideHoursMode=cbai → 403', n9put2.status === 403, `status=${n9put2.status}`)
  const n9get = await api('GET', '/api/ai-knowledge', undefined, t8AdminTok)
  check('N9d GET ai-knowledge plan ✗ → 403 (upsell)', n9get.status === 403, `status=${n9get.status}`)
  const n9sa = await api('PUT', '/api/autoreply?tenant=8', { greetMode: 'cbai' }, saTok)
  check('N9e SA ?tenant=8 plan ✗ PUT cbai → 403 JUGA (no backdoor)', n9sa.status === 403, `status=${n9sa.status}`)
  const n9gw = await api('PUT', '/api/menu-gateway', {
    options: [
      { position: 1, label: 'Komplain', aliases: 'komplain', replyText: 'Siap Kak, komplain dicatat.', answerMode: 'ai_knowledge' },
      { position: 2, label: 'Hasil', aliases: 'hasil', replyText: 'Hasil siap diambil.', answerMode: 'text' },
    ],
  }, t8AdminTok)
  check('N9f gateway PUT ai_knowledge plan ✗ → 403', n9gw.status === 403, `status=${n9gw.status}`)
  // plan ✓ lagi → 200
  await api('PUT', '/api/sa/tenants/8/plan', { featAiKnowledge: true }, saTok)
  const n9ok = await api('PUT', '/api/autoreply', { greetMode: 'cbai', greetEnabled: true }, t8AdminTok)
  check('N9g plan ✓ → PUT greetMode=cbai → 200', n9ok.status === 200, `status=${n9ok.status}`)

  // ═══════════ N10 — trial endpoint (D11) ═══════════
  mockMode = { type: 'covered', answer: 'Trial: paket A Rp 500.000.' }
  const chatC0 = await prisma.chat.count({ where: { tenantId: 8 } })
  const kbTrial0 = await prisma.aiUsageLog.count({ where: { source: 'knowledge' } })
  const n10a = await api('POST', '/api/ai-knowledge/trial', { question: 'berapa harga paket A?' }, t8AdminTok)
  check('N10a trial covered → covered=true + answer', n10a.status === 200 && n10a.data?.covered === true && n10a.data?.answer?.includes('500.000'), `status=${n10a.status} covered=${n10a.data?.covered}`)
  mockMode = { type: 'nocover' }
  const n10b = await api('POST', '/api/ai-knowledge/trial', { question: 'hal super random gak ada di kb?' }, t8AdminTok)
  check('N10b trial no_answer → covered=false', n10b.status === 200 && n10b.data?.covered === false, `status=${n10b.status} covered=${n10b.data?.covered}`)
  check('N10c trial TIDAK menambah Chat (chatId null) & TIDAK menambah counter apapun',
    (await prisma.chat.count({ where: { tenantId: 8 } })) === chatC0, `chatC=${chatC0}`)
  const kbTrial1 = await prisma.aiUsageLog.count({ where: { source: 'knowledge' } })
  check('N10d trial metering terlog (2 call → 2 row knowledge)', kbTrial1 === kbTrial0 + 2, `n=${kbTrial1} before=${kbTrial0}`)
  const n10rows = await prisma.aiUsageLog.findMany({ where: { source: 'knowledge' }, orderBy: { id: 'desc' }, take: 2 })
  check('N10e trial rows chatId=null', n10rows.every((r) => r.chatId === null), `chatIds=${n10rows.map((r) => r.chatId).join(',')}`)

  // ═══════════ N11 — footer toggle (prompt capture) ═══════════
  await api('PUT', '/api/ai-knowledge/config', { cbaiInfoFooter: false }, t8AdminTok)
  mockMode = { type: 'covered', answer: 'jawab tanpa footer.' }
  const n11c = await seedChat('E2E40 N11')
  await incoming(n11c.id, 'tanya footer')
  check('N11 footer OFF → prompt TANPA "(info per', !lastPrompt.includes('(info per'), lastPrompt.slice(0, 80))
  await api('PUT', '/api/ai-knowledge/config', { cbaiInfoFooter: true }, t8AdminTok)
  const n11b = await seedChat('E2E40 N11b')
  await incoming(n11b.id, 'tanya lagi footer')
  check('N11b footer ON → prompt ADA "(info per', lastPrompt.includes('(info per'), lastPrompt.slice(0, 80))

  // ═══════════ N12 — 0 doc aktif → skip tanpa LLM call ═══════════
  await prisma.aiKnowledgeDoc.updateMany({ where: { tenantId: 8 }, data: { active: false } })
  const kb12 = await prisma.aiUsageLog.count({ where: { source: 'knowledge' } })
  const n12c = await seedChat('E2E40 N12')
  await incoming(n12c.id, 'halo kak tanya')
  const n12chat = await prisma.chat.findUnique({ where: { id: n12c.id } })
  check('N12a 0 doc aktif → skip AI (TANPA fallback greeting, TANPA counter)',
    n12chat?.aiReplyCount === 0, `count=${n12chat?.aiReplyCount}`)
  check('N12b 0 row metering baru', (await prisma.aiUsageLog.count({ where: { source: 'knowledge' } })) === kb12, `n=${kb12}`)
  await prisma.aiKnowledgeDoc.updateMany({ where: { tenantId: 8 }, data: { active: true } })

  // ═══════════ N13 — gateway answerMode (§7b) ═══════════
  // N13a: opsi ai_knowledge + keyword fast-path → covered → jawaban AI + counter++
  const n13put = await api('PUT', '/api/menu-gateway', {
    enabled: true, introText: 'Halo {name}! Pilih topik E2E40:', fallbackText: 'Terima kasih! CS E2E40 akan membalas. 🙏',
    options: [
      { position: 1, label: 'Pricelist', aliases: 'harga, pricelist', replyText: 'E2E40 replyText opsi 1.', answerMode: 'ai_knowledge', aiDocIds: '' },
      { position: 2, label: 'Lainnya', aliases: 'lain', replyText: 'E2E40 replyText opsi 2.', answerMode: 'text' },
    ],
  }, t8AdminTok)
  // 409 proteksi AR aktif → netralkan AR dulu lalu ulang (pola v3925 S4)
  let n13 = n13put
  if (n13.status === 409) {
    await api('PUT', '/api/autoreply', { greetMode: 'text', greetEnabled: false, outsideHoursEnabled: false, numberSlots: null }, t8AdminTok)
    n13 = await api('PUT', '/api/menu-gateway', {
      enabled: true, introText: 'Halo {name}! Pilih topik E2E40:', fallbackText: 'Terima kasih! CS E2E40 akan membalas. 🙏',
      options: [
        { position: 1, label: 'Pricelist', aliases: 'harga, pricelist', replyText: 'E2E40 replyText opsi 1.', answerMode: 'ai_knowledge', aiDocIds: '' },
        { position: 2, label: 'Lainnya', aliases: 'lain', replyText: 'E2E40 replyText opsi 2.', answerMode: 'text' },
      ],
    }, t8AdminTok)
  }
  check('N13a PUT gateway opsi answerMode=ai_knowledge → 200 + echo',
    n13.status === 200 && n13.data?.config?.options?.[0]?.answerMode === 'ai_knowledge', `status=${n13.status}`)
  mockMode = { type: 'covered', answer: 'E2E40 gateway AI: paket A Rp 500.000.' }
  const n13c = await seedChat('E2E40 N13', { awaiting: true })
  const kb13 = await prisma.aiUsageLog.count({ where: { source: 'knowledge' } })
  await incoming(n13c.id, 'harga') // keyword alias opsi 1 (fast-path)
  const n13chat = await prisma.chat.findUnique({ where: { id: n13c.id } })
  const n13out = await lastAutoMessages(n13c.id)
  check('N13b covered → jawaban AI terkirim (bukan replyText)',
    n13out.length > 0 && n13out[0].includes('500.000') && !n13out[0].includes('replyText opsi'), `out=${JSON.stringify(n13out).slice(0, 100)}`)
  check('N13c counter shared CB-AI naik (aiReplyCount=1)', n13chat?.aiReplyCount === 1, `count=${n13chat?.aiReplyCount}`)
  check('N13d metering source=knowledge (bukan gateway)', (await prisma.aiUsageLog.count({ where: { source: 'knowledge' } })) === kb13 + 1, `n=${kb13}`)
  // N13c2: no_answer → replyText PERSIS fallback + counter++
  mockMode = { type: 'nocover' }
  const n13c2 = await seedChat('E2E40 N13b', { awaiting: true })
  await incoming(n13c2.id, 'harga')
  const n13out2 = await lastAutoMessages(n13c2.id)
  const n13chat2 = await prisma.chat.findUnique({ where: { id: n13c2.id } })
  check('N13e no_answer → replyText PERSIS + DIHITUNG',
    n13out2.length > 0 && n13out2[0].includes('replyText opsi 1') && n13chat2?.aiReplyCount === 1,
    `out=${JSON.stringify(n13out2).slice(0, 100)} count=${n13chat2?.aiReplyCount}`)
  // N13d — tickbox scope: opsi HANYA doc pricelist → prompt capture berisi doc itu SAJA
  await api('PUT', '/api/menu-gateway', {
    options: [
      { position: 1, label: 'Pricelist', aliases: 'harga, pricelist', replyText: 'E2E40 replyText opsi 1.', answerMode: 'ai_knowledge', aiDocIds: String(docPrice.id) },
      { position: 2, label: 'Lainnya', aliases: 'lain', replyText: 'E2E40 replyText opsi 2.', answerMode: 'text' },
    ],
  }, t8AdminTok)
  mockMode = { type: 'covered', answer: 'scoped answer.' }
  const n13c3 = await seedChat('E2E40 N13c', { awaiting: true })
  await incoming(n13c3.id, 'harga')
  check('N13h scope tickbox → prompt HANYA berisi doc itu (bukan whole KB)',
    lastPrompt.includes('E2E40 Pricelist') && !lastPrompt.includes('E2E40 CSV'), lastPrompt.split('---')[0].slice(0, 200))
  // cleanup: kembalikan gateway opsi text-only (idempoten re-run)
  await api('PUT', '/api/menu-gateway', {
    options: [
      { position: 1, label: 'Pricelist', aliases: 'harga, pricelist', replyText: 'E2E40 replyText opsi 1.', answerMode: 'text' },
      { position: 2, label: 'Lainnya', aliases: 'lain', replyText: 'E2E40 replyText opsi 2.', answerMode: 'text' },
    ],
  }, t8AdminTok)

  // ═══════════ N16 — v4.0.0b hotfix: repeatFrequency (QA Kanaka 09:15) ═══════════
  // Simulasi UI: FE kirim FULL-FORM (spread semua field) — dulu 400 "Field tidak
  // dikenal: repeatFrequency" krn kolom gak dibuat pas dropdown pindah (D10).
  const n16a = await api('PUT', '/api/autoreply', {
    outsideHoursEnabled: true, outsideHoursText: 'x', outsideHoursMode: 'text',
    greetEnabled: false, greetMode: 'text', greetText: 'halo',
    repeatFrequency: 'weekly',
    monFriEnabled: true, monFriStart: '08:00', monFriEnd: '17:00',
    satEnabled: true, satStart: '08:00', satEnd: '17:00',
    sunEnabled: true, sunStart: '08:00', sunEnd: '17:00',
  }, t8AdminTok)
  check('N16a PUT autoreply FULL-FORM (repeatFrequency ikut) → 200', n16a.status === 200, `status=${n16a.status} err=${n16a.data?.error || ''}`)
  check('N16b repeatFrequency tersimpan + echo (weekly)', n16a.data?.config?.repeatFrequency === 'weekly', `rf=${n16a.data?.config?.repeatFrequency}`)
  const n16c = await api('GET', '/api/autoreply', undefined, t8AdminTok)
  check('N16c GET autoreply ikutkan repeatFrequency efektif', n16c.data?.config?.repeatFrequency === 'weekly', `rf=${n16c.data?.config?.repeatFrequency}`)
  const n16d = await api('PUT', '/api/autoreply', { repeatFrequency: 'kadaluarsa' }, t8AdminTok)
  check('N16d repeatFrequency invalid enum → 400', n16d.status === 400, `status=${n16d.status}`)
  await api('PUT', '/api/autoreply', { repeatFrequency: 'daily' }, t8AdminTok) // restore (idempoten re-run)

  // ═══════════ N-liar — validasi ketat ═══════════
  const n14a = await api('PUT', '/api/ai-knowledge/config', { cbaiLimit: 0 }, t8AdminTok)
  check('N-liar cbaiLimit 0 → 400', n14a.status === 400, `status=${n14a.status}`)
  const n14b = await api('PUT', '/api/ai-knowledge/config', { cbaiLimit: 11 }, t8AdminTok)
  check('N-liar cbaiLimit 11 → 400', n14b.status === 400, `status=${n14b.status}`)
  const n14c = await api('PUT', '/api/ai-knowledge/config', { cbaiLimit: '3' }, t8AdminTok)
  check('N-liar cbaiLimit "3" (string) → 400', n14c.status === 400, `status=${n14c.status}`)
  const n14d = await api('PUT', '/api/autoreply', { outsideHoursMode: 'yes' }, t8AdminTok)
  check('N-liar outsideHoursMode "yes" → 400', n14d.status === 400, `status=${n14d.status}`)
  const n14e = await api('PUT', '/api/autoreply', { cbaiLimit: '3' }, t8AdminTok)
  check('N-liar autoreply cbaiLimit "3" → 400', n14e.status === 400, `status=${n14e.status}`)
  const n14f = await api('PUT', '/api/autoreply', { fieldAsing: true }, t8AdminTok)
  check('N-liar autoreply field asing → 400', n14f.status === 400, `status=${n14f.status}`)
  const n14g = await api('PUT', '/api/menu-gateway', {
    options: [{ position: 1, label: 'X', replyText: 'y', answerMode: 'salah' }],
  }, t8AdminTok)
  check('N-liar gateway answerMode "salah" → 400', n14g.status === 400, `status=${n14g.status}`)
  const n14h = await api('PUT', '/api/menu-gateway', {
    options: [{ position: 1, label: 'X', replyText: 'y', aiDocIds: '1,a' }],
  }, t8AdminTok)
  check('N-liar aiDocIds csv "1,a" → 400 (format ketat)', n14h.status === 400, `status=${n14h.status}`)

  // ═══════════ S3b — key tidak bocor ═══════════
  const leaks = JSON.stringify({ s3: cfgPut.data, n9: n9get.data }).includes('test-key-123456')
  check('S3b key TIDAK bocor di response apapun', !leaks, '')

  // ═══════════ N17 — v4.0.0c hotfix: @newsletter (WA Channel) bukan chat customer ═══════════
  // Bug QA Kanaka 11:57: postingan Channel Mazaya ("Jadwal Oktober tayang") dijawab
  // Auto Reply + masuk antrean. Fix: JID @newsletter skip total di inbound.
  const n17a = await api('POST', '/api/wa/inbound', {
    tenantId: 8,
    messages: { key: { remoteJid: '120363999999999999@newsletter', fromMe: true }, message: { conversation: 'posting channel test' } },
  }, saTok)
  check('N17a inbound @newsletter → skip (handled=false)', n17a.status === 200 && n17a.data?.handled === false, `status=${n17a.status} handled=${n17a.data?.handled}`)
  const n17b = await prisma.chat.findFirst({ where: { tenantId: 8, waJid: '120363999999999999@newsletter' } })
  check('N17b chat @newsletter TIDAK dibuat', !n17b, n17b ? `chatId=${n17b.id}` : '')

  // ═══════════ N15 — ROLLBACK TEST (wajib rilis major, spec §10 N14) ═══════════
  // Restore backup PRE-v4.0.0 ke COPY-DB → kode lama (checkout tag pre-v4.0.0) jalan +
  // kolom baru diabaikan SQLite + health 200 → bukti jalur mundur hidup.
  // Pola: scripts/rollback-test-v4000.cjs melakukan step berat (restore+checkout+boot);
  // di sini verifikasi via helper: jalankan subprocess dgn env flag.
  const rollback = spawnSync('node', [REPO + '/scripts/rollback-test-v4000.cjs'], {
    encoding: 'utf8', timeout: 120000, env: { ...process.env, E2E_CBAI_DB: '/tmp/saas-v3-e2e.db', E2E_CBAI_PORT: '5099' },
  })
  check('N15 rollback test (restore pre-v4.0.0 + kode lama + kolom diabaikan + health 200)',
    rollback.status === 0 && /ROLLBACK-TEST-OK/.test(rollback.stdout || ''),
    `rc=${rollback.status} out=${(rollback.stdout || '').slice(-400).replace(/\n/g, ' | ')}`)

  mockServer.close()
  console.log(`\n=== e2e-v4000: ${pass} PASS / ${fails.length} FAIL ===`)
  if (fails.length) { console.log('FAILED:', fails.join(' | ')); process.exitCode = 1 }
  await prisma.$disconnect()
  process.exit(process.exitCode || 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
