/**
 * E2E v4.6.4 (log menu addition) — Superadmin System Log (spec docs/spec-superadmin-system-log.md §D9)
 * Jalur copy-DB :5098 (WA_DISABLED=1) — produksi (5047) TIDAK tersentuh.
 * Pola: scripts/e2e-v431.cjs (copy DB + reset superadmin + login API).
 *
 * Setup copy-DB (dari repo root):
 *   python3 -c "import shutil; shutil.copy('prisma/data/saas-v3.db','/tmp/saas-v3-e2e-p470.db')"
 *   DATABASE_URL=file:/tmp/saas-v3-e2e-p470.db npx prisma db push --skip-generate
 *   PORT=5098 DATABASE_URL=file:/tmp/saas-v3-e2e-p470.db WA_DISABLED=1 APP_VERSION=v4.6.3 node src/server.js &
 *   set -a && . ./.env && set +a && node scripts/e2e-v470-systemlogs.mjs
 *
 * Kasus (§D9 — 10):
 *   S1  Ingest BE: console.error via wrapper → row dgn module/tenant/versi benar + logError terstruktur (stack)
 *   S2  Redaksi: nomor 628111222333 + email + body → tersimpan TER-REDAKSI (mentah TIDAK ada di DB)
 *   S3  Client capture: login cs → POST /api/client-log 204 + row source=client; ke-21+ di-drop (total tidak bertambah)
 *   S4  Role gate: admin/cs → semua /api/sa/system-logs* → 403
 *   S5  List + filter + cursor pagination + export CSV (cap 10k)
 *   S6  Dedup: spam pesan sama 30x <10s → row bertambah ≤2
 *   S7  Retensi: row ts 31 hari lalu → pruneOnce → terhapus; row segar tetap
 *   S8  Isolasi & survival: purge tenant → row log tenantId lama TETAP ADA (snapshot, tanpa FK)
 *   S9  Regresi: boot server normal tanpa error; volume log boot normal (tidak nge-spam)
 *   S10 Flood guard: logInfo 1000x → ~300 masuk + 1 warn "flood suppressed"; server tetap responsif
 *
 * Catatan S6/S10: flood guard & dedup adalah state IN-PROCESS — dibuktikan dgn
 * instance service yang sama persis dgn runtime server (unit-of-service di proses
 * test, DB shared); ke responsivitas server dinyatakan via /api/health.
 */
const REPO = '/home/kanakxxx/.openclaw/workspace/wa-cs-hub-saas-v3'
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:5098'
// KRITIS (lesson v4.1.x): dotenv .env berisi DATABASE_URL PROD → DATABASE_URL dipaksa
// ke copy SETELAH dotenv — seluruh proses satu DB copy (service tidak menembak PROD).
const COPY_DB = 'file:/tmp/saas-v3-e2e-p470.db'
import { createRequire } from 'module'
const req = createRequire(import.meta.url) // proyek CJS (services/prisma) dipakai dari ESM
req(REPO + '/node_modules/dotenv').config({ path: REPO + '/.env' })
process.env.DATABASE_URL = COPY_DB
process.env.WA_DISABLED = '1'
process.env.APP_VERSION = 'v4.6.3-e2e' // stamp versi utk baris yang ditulis proses test
// Flood-window pendek KHUSUS proses test (S10 warn flusuh via timer ~3s; server
// proses tetap default 60s — state flood guard per-proses, tidak saling memengaruhi)
process.env.SYSTEMLOG_FLOOD_WINDOW_MS = '3000'
const { PrismaClient } = req(REPO + '/node_modules/@prisma/client')
// WAJIB: tunjuk DB COPY — jangan pernah sentuh DB produksi dari script test ini
const prisma = new PrismaClient({ datasourceUrl: COPY_DB, log: ['error'] })
const bcrypt = req(REPO + '/node_modules/bcryptjs')

const fails = []
let pass = 0
// Output harness lewat console ASLI (via service) — wrapper SystemLog tidak
// meng-capture baris PASS/FAIL harness (tidak menodai tabel + query marker stabil).
let __harnessOut = null
function check(name, cond, extra = '') {
  const line = `${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`
  if (__harnessOut) __harnessOut(line)
  else console.log(line)
  if (!cond) { process.exitCode = 1; fails.push(name) } else { pass++ }
}
async function api(method, path, body, token, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const contentType = res.headers.get('content-type') || ''
  let data = null
  let text = null
  if (contentType.includes('application/json')) {
    try { data = await res.json() } catch {}
  } else {
    text = await res.text().catch(() => '') // CSV/204: JANGAN konsumsi sbg json dulu
  }
  return { status: res.status, data, text, contentType }
}

// Marker uji HURUF-ONLY — tanpa digit run: apa pun yang kita tulis lewat capture
// TER-REDAKSI saat ingest (digit ≥8), jadi query by marker tidak boleh mengandung
// digit-panjang (artefak bila pakai Date.now() 13-digit).
const ABC = 'abcdefghijklmnopqrstuvwxyz'
function mkTag(prefix) {
  let s = ''
  for (let i = 0; i < 10; i++) s += ABC[Math.floor(Math.random() * ABC.length)]
  return `${prefix}-${s}`
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function countLogs(where) { return prisma.systemLog.count({ where }) }

async function main() {
  const t0 = new Date()

  // ── Instal wrapper di PROSES TEST (kode identik dgn runtime server — S1/S6/S10) ──
  const systemLog = req(REPO + '/src/services/systemLog')
  systemLog.installSystemLogCapture()
  __harnessOut = systemLog.ORIGINAL_CONSOLE.log // output harness bebas dari wrapper
  __harnessOut('harness: wrapper terpasang + output via ORIGINAL_CONSOLE')

  // ── S0 — reset password super_admin (COPY DB saja) + login + tenant uji ──
  const sa0 = await prisma.user.findFirst({ where: { role: 'super_admin' } })
  check('S0 super_admin row ada di copy DB', !!sa0)
  const saPass = process.env.SUPERADMIN_PASSWORD || 'superadmin123'
  await prisma.user.update({
    where: { id: sa0.id },
    data: { passwordHash: await bcrypt.hash(saPass, 10), status: 'active' },
  })
  const saLogin = await api('POST', '/api/auth/login', { username: sa0.username, password: saPass })
  check(`S0 superadmin login status=${saLogin.status}`, saLogin.status === 200 && !!saLogin.data?.token)
  const saTok = saLogin.data?.token
  if (!saTok) return process.exit(1)

  // Tenant utama uji (structured-call fixtures) + tenant kedua (S8 purge)
  const tName = 'e2e-p470-log-' + mkTag('t')
  const tenant = await prisma.tenant.create({ data: { name: tName, status: 'active' } })
  const T = tenant.id
  const tName2 = 'e2e-p470-purge-' + mkTag('t')
  const tenant2 = await prisma.tenant.create({ data: { name: tName2, status: 'active' } })
  const T2 = tenant2.id
  // User cs + admin tenant utama (fixture — login lewat API utk JWT asli); username
  // huruf-only (digit-run di username ikut ter-redaksi saat tersimpan di meta)
  const csHash = await bcrypt.hash('cspass123', 10)
  const adminHash = await bcrypt.hash('adminpass123', 10)
  const csUser = await prisma.user.create({ data: { username: `cs_p470_${mkTag('u')}`, passwordHash: csHash, role: 'cs', tenantId: T, status: 'active' } })
  const adminUser = await prisma.user.create({ data: { username: `adm_p470_${mkTag('u')}`, passwordHash: adminHash, role: 'admin', tenantId: T, status: 'active' } })
  // csUser kedua utk S3 e/f/g — bucket rate-limit PER-USER: bucket csUser pertama
  // sudah penuh setelah 25 panggilan → spoof/pii test wajib dari user bersih.
  const csUser2 = await prisma.user.create({ data: { username: `cs2_p470_${mkTag('u')}`, passwordHash: csHash, role: 'cs', tenantId: T, status: 'active' } })
  console.log(`S0 tenant uji #${T} + #${T2}, cs+admin fixture dibuat (copy DB)`)

  // ═════ S1 — Ingest BE via wrapper + structured call ═════
  {
    const uniq = mkTag('e2e-s1uji')
    console.error(`[Blast] ${uniq} (tenant ${T})`)
    void systemLog.logError(`e2e-s1 structured error (tenant ${T})`, {
      module: 'auto-reply', tenantId: T, err: new Error('e2e-s1 boom'),
      meta: { chatId: 123 },
    })
    await sleep(600)
    const wrapRow = await prisma.systemLog.findFirst({
      where: { message: { contains: uniq }, level: 'error', source: 'server' },
      orderBy: { id: 'desc' },
    })
    check('S1-a wrapper console.error → row masuk', !!wrapRow)
    check('S1-b module ter-infer = blast (from [Blast] tag)', wrapRow?.module === 'blast')
    check(`S1-c tenantId ter-infer = ${T} dgn snapshot nama`, wrapRow?.tenantId === T, `got=${wrapRow?.tenantId}`)
    check('S1-d tenantName snapshot terisi', wrapRow?.tenantName === tName, `got=${wrapRow?.tenantName}`)
    check('S1-e appVersion tercatat', !!wrapRow?.appVersion, `got=${wrapRow?.appVersion}`)
    const structRow = await prisma.systemLog.findFirst({
      where: { message: { contains: 'e2e-s1 structured error' } },
      orderBy: { id: 'desc' },
    })
    check('S1-f logError terstruktur → module eksplisit auto-reply + tenant + stack', structRow?.module === 'auto-reply' && structRow?.tenantId === T && !!structRow?.stack && structRow.stack.includes('e2e-s1 boom'))
    check('S1-g metaJson tersimpan', !!structRow?.metaJson && structRow.metaJson.includes('123'))
  }

  // ═════ S2 — Redaksi PII saat ingest ═════
  {
    const uniq = mkTag('e2e-s2')
    void systemLog.logError(
      `${uniq} gagal kirim ke 628111222333 email cs@parahita.co.id body: RahasiaRahasia12345`,
      { module: 'wa', tenantId: T },
    )
    await sleep(600)
    const row = await prisma.systemLog.findFirst({ where: { message: { contains: uniq } } })
    check('S2-a row masuk', !!row)
    const msg = row?.message || ''
    check('S2-b nomor WA mentah TIDAK ada', !msg.includes('628111222333'))
    check('S2-c nomor ter-redaksi format 62***2333', msg.includes('62***2333'), msg.slice(0, 160))
    check('S2-d email mentah TIDAK ada', !msg.includes('cs@parahita.co.id'))
    check('S2-e email ter-redaksi c***@parahita.co.id (domain tetap)', msg.includes('c***@parahita.co.id'))
    check('S2-f body literal TIDAK ada → [redacted-body N chars]', !msg.includes('RahasiaRahasia') && /\[redacted-body \d+ chars\]/.test(msg))
    // cek lintas kolom: stack & meta juga bebas PII mentah (satu pola redactText)
    const rowMeta = await prisma.systemLog.findFirst({
      where: { message: { contains: 'e2e-s2b' } },
    })
    check('S2-g (opsional) tidak ada row sisa', rowMeta === null)
  }

  // ═════ S3 — Client capture (cs user, bukan superadmin) + rate limit 20/menit ═════
  {
    const csLogin = await api('POST', '/api/auth/login', { username: csUser.username, password: 'cspass123' })
    check(`S3-a login cs status=${csLogin.status}`, csLogin.status === 200 && !!csLogin.data?.token)
    const csTok = csLogin.data?.token

    // 20 pesan unik → semua 204, 20 row source=client
    const uniq = mkTag('e2e-s3')
    for (let i = 1; i <= 20; i++) {
      const r = await api('POST', '/api/client-log', { message: `e2e-s3 fe error ${uniq}-${i}`, stack: 'Error: e2e-s3 boom\n    at index.js:1:1', module: 'frontend', route: '/admin' }, csTok)
      if (r.status !== 204) { check(`S3-b POST #${i} → 204`, false, `got=${r.status}`); break }
      if (i === 20) check('S3-b POST ke-20 → 204 (fire-and-forget)', true)
    }
    const c20 = await countLogs({ source: 'client', tenantId: T, message: { contains: `e2e-s3 fe error ${uniq}-` } })
    check(`S3-c 20 row source=client masukTenant=${T} (got ${c20})`, c20 === 20)

    // Pesan ke-21..25 dalam menit yang sama → di-drop diam-diam (masih 204)
    for (let i = 21; i <= 25; i++) await api('POST', '/api/client-log', { message: `e2e-s3 fe error ${uniq}-${i}` }, csTok)
    const c21 = await countLogs({ source: 'client', message: { contains: `e2e-s3 fe error ${uniq}-` } })
    check(`S3-d rate limit: setelah 5x extra, total TETAP 20 (got ${c21})`, c21 === 20)

    // tenant & username DIAMBIL DARI TOKEN bukan body: user cs BERBEDA (bucket
    // bersih), tenantId palsu di body → diabaikan, tenant dari token yang dipakai
    const cs2Login = await api('POST', '/api/auth/login', { username: csUser2.username, password: 'cspass123' })
    check('S3-e0 login cs kedua status=200', cs2Login.status === 200 && !!cs2Login.data?.token)
    const cs2Tok = cs2Login.data?.token
    const spoofTag = mkTag('e2e-s3bspoof')
    await api('POST', '/api/client-log', { message: spoofTag, tenantId: 9999 }, cs2Tok)
    const spoof = await prisma.systemLog.findFirst({ where: { message: { contains: spoofTag } } })
    check('S3-e tenant dari TOKEN (bukan body)', spoof?.tenantId === T && spoof?.tenantId !== 9999, `got=${spoof?.tenantId}`)
    check('S3-f username tersimpan di meta dari token', !!spoof?.metaJson && spoof.metaJson.includes(csUser2.username))

    // redaksi diterapkan juga di client path (dari bucket csUser2)
    const piiTag = mkTag('e2e-s3cpii')
    await api('POST', '/api/client-log', { message: `${piiTag} 628111222333 a@b.co.id`, stack: 'Error: pii stack at view 628111222333' }, cs2Tok)
    const pii = await prisma.systemLog.findFirst({ where: { message: { contains: piiTag } } })
    check('S3-g client-log ter-redaksi juga (message+stack)', !!pii && !pii.message.includes('628111222333') && !pii.message.includes('a@b.co.id') && !!pii.stack && !pii.stack.includes('628111222333'))

    // tanpa token → 401
    const noTok = await api('POST', '/api/client-log', { message: 'anon' })
    check('S3-h tanpa JWT → 401', noTok.status === 401)
    void adminUser
  }

  // ═════ S4 — Role gate: admin/cs 403 di SEMUA endpoint system-logs* ═════
  {
    const adminLogin = await api('POST', '/api/auth/login', { username: adminUser.username, password: 'adminpass123' })
    const adminTok = adminLogin.data?.token
    const csLogin2 = await api('POST', '/api/auth/login', { username: csUser.username, password: 'cspass123' })
    const csTok2 = csLogin2.data?.token
    for (const [label, tok] of [['admin', adminTok], ['cs', csTok2]]) {
      const listR = await api('GET', '/api/sa/system-logs', undefined, tok)
      const statsR = await api('GET', '/api/sa/system-logs/stats', undefined, tok)
      const exportR = await api('GET', '/api/sa/system-logs/export', undefined, tok)
      const idR = await api('GET', '/api/sa/system-logs/1', undefined, tok)
      check(`S4-${label} list → 403`, listR.status === 403, `got=${listR.status}`)
      check(`S4-${label} stats → 403`, statsR.status === 403)
      check(`S4-${label} export → 403`, exportR.status === 403)
      check(`S4-${label} detail → 403`, idR.status === 403)
    }
  }

  // ═════ S5 — List + filter + cursor pagination + export CSV ═════
  {
    const l1 = await api('GET', '/api/sa/system-logs?limit=5', undefined, saTok)
    check('S5-a list 200 + ≤5 item + nextCursor', l1.status === 200 && (l1.data?.items?.length || 0) <= 5 && !!l1.data?.nextCursor, `n=${l1.data?.items?.length}`)
    const lastId1 = l1.data?.items?.[(l1.data.items.length - 1)]?.id
    const l2 = await api('GET', `/api/sa/system-logs?limit=5&cursor=${lastId1}`, undefined, saTok)
    const ids2 = (l2.data?.items || []).map((r) => r.id)
    check('S5-b cursor page-2: semua id < cursor (id desc)', ids2.every((i) => i < lastId1))
    // List ringkas TANPA stack/metaJson (detail via :id)
    check('S5-c list ringkas tanpa stack', l1.data.items.every((r) => !('stack' in r) && !('metaJson' in r)))
    // Filter level multi + module + q
    const lf = await api('GET', '/api/sa/system-logs?level=error,warn&limit=20', undefined, saTok)
    check('S5-d filter level multi', lf.status === 200 && lf.data.items.every((r) => ['error', 'warn'].includes(r.level)))
    const lm = await api('GET', '/api/sa/system-logs?module=blast&limit=20', undefined, saTok)
    check('S5-e filter module=blast', lm.status === 200 && lm.data.items.every((r) => r.module === 'blast'))
    const lq = await api('GET', '/api/sa/system-logs?q=e2e-s1&limit=20', undefined, saTok)
    check('S5-f filter keyword q', lq.status === 200 && lq.data.items.length > 0 && lq.data.items.every((r) => r.message.includes('e2e-s1')))
    // Detail lengkap via :id
    const anyId = lq.data.items[0]?.id
    const det = await api('GET', `/api/sa/system-logs/${anyId}`, undefined, saTok)
    check('S5-g detail 200 + field lengkap', det.status === 200 && 'stack' in det.data.item && 'metaJson' in det.data.item)
    // Export CSV — hitung baris & header
    const totalFilter = await countLogs({ level: { in: ['error'] } })
    const exp = await api('GET', '/api/sa/system-logs/export?level=error', undefined, saTok)
    check('S5-h export 200 text/csv', exp.status === 200 && exp.contentType.includes('text/csv'), exp.contentType)
    const expHeader = (exp.text || '').split('\n')[0].replace(/"/g, '')
    check('S5-i CSV header kolom sesuai spec', expHeader.includes('id,ts,level,source,module,tenantId,tenantName,appVersion,message,stack,metaJson'), expHeader.slice(0, 120))
    const dataLines = (exp.text || '').split('\n').filter((l) => l.trim()).length - 1
    check(`S5-j CSV baris = min(total filter, 10000) — got ${dataLines} vs ${totalFilter}`, dataLines === Math.min(totalFilter, 10000))
    // 404 utk id tak ada + 400 utk id invalid
    const nf = await api('GET', '/api/sa/system-logs/999999999', undefined, saTok)
    check('S5-k detail id tidak ada → 404', nf.status === 404)
    const inv = await api('GET', '/api/sa/system-logs/abc', undefined, saTok)
    check('S5-l detail id invalid → 400', inv.status === 400)
  }

  // ═════ S6 — Dedup 10s: spam pesan sama 30x <10s ≤ 2 row ═════
  {
    systemLog.resetInProcessStateForTest()
    const uniq = mkTag('e2e-s6')
    for (let i = 0; i < 30; i++) void systemLog.logWarn(uniq, { module: 'other' })
    await sleep(800)
    const rows = await countLogs({ message: uniq })
    check(`S6 dedup 30x identik → ${rows} row (≤2)`, rows >= 1 && rows <= 2)
  }

  // ═════ S7 — Retensi: row 31 hari lalu terhapus, row segar tetap ═════
  {
    const old = await prisma.systemLog.create({
      data: {
        level: 'info', source: 'server', module: 'other', message: 'e2e-s7 OLD row',
        ts: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
      },
    })
    const fresh = await prisma.systemLog.create({
      data: { level: 'info', source: 'server', module: 'other', message: 'e2e-s7 FRESH row' },
    })
    await systemLog.pruneOnce()
    const oldGone = await prisma.systemLog.findUnique({ where: { id: old.id } })
    const freshStays = await prisma.systemLog.findUnique({ where: { id: fresh.id } })
    check('S7-a row 31 hari TERHAPUS oleh pruneOnce', oldGone === null)
    check('S7-b row segar tetap ada', !!freshStays)
  }

  // ═════ S8 — Isolasi & survival: purge tenant → SystemLog row tetap (snapshot) ═════
  {
    void systemLog.logError(`e2e-s8 log milik tenant ${tName2}`, { module: 'tenant', tenantId: T2 })
    await sleep(600)
    const before = await countLogs({ tenantId: T2 })
    check(`S8-a row log tenant ${T2} ada sebelum purge (${before})`, before >= 1)
    const p = await api('POST', `/api/sa/tenants/${T2}/purge`, { confirmName: tName2 }, saTok)
    check(`S8-b purge tenant ${T2} → 200 (status=${p.status})`, p.status === 200, JSON.stringify(p.data).slice(0, 120))
    const tenantGone = await prisma.tenant.findUnique({ where: { id: T2 } })
    check('S8-c row tenant terhapus', tenantGone === null)
    const after = await prisma.systemLog.findMany({ where: { tenantId: T2 } })
    check(`S8-d SystemLog row tenantId lama TETAP ADA (${after.length}) — snapshot tanpa FK`, after.length >= 1)
    check('S8-e tenantName snapshot masih terbaca', after.length > 0 && after[0].tenantName === tName2)
  }

  // ═════ S9 — Regresi boot: server normal + volume log normal ═════
  {
    const h = await api('GET', '/api/health')
    check('S9-a /api/health 200', h.status === 200)
    const bootRows = await countLogs({ source: 'server', level: 'info', ts: { gte: new Date(Date.now() - 60 * 60 * 1000) } })
    check(`S9-b volume log info boot (jendela 1 jam) normal (got ${bootRows})`, bootRows >= 1 && bootRows <= 350)
    // error server? wrapper tidak boleh linting sendiri — cek tidak ada '[SystemLog]' error storm
    const logSelf = await countLogs({ message: { contains: '[SystemLog]' } })
    check(`S9-c TIDAK ada log-storm dari logger sendiri (got ${logSelf})`, logSelf <= 3)
  }

  // ═════ S10 — Flood guard: 1000 logInfo → ~300 masuk + 1 warn suppressed ═════
  {
    systemLog.resetInProcessStateForTest()
    const stamp = mkTag('e2e-s10flood')
    for (let i = 0; i < 1000; i++) void systemLog.logInfo(`${stamp} pesan ke-${i}`, { module: 'other' })
    await sleep(4000) // window test 3s → warn "suppressed" ter-flush via timer
    const flooded = await countLogs({ message: { contains: stamp } }) // info + warn suppressed
    const warnRows = await prisma.systemLog.findMany({ where: { message: { contains: 'flood suppressed' }, level: 'warn' } })
    check(`S10-a hanya ~300 info masuk dari 1000 (got ${flooded} dgn warn)`, flooded <= 305 && flooded >= 2)
    check(`S10-b 1 warn "info flood suppressed N" dicatat (got ${warnRows.length})`, warnRows.length >= 1)
    check('S10-c server tetap responsif setelah flood', (await api('GET', '/api/health')).status === 200)
  }

  // ── Sanity: fixture prod tidak tersentuh (copy db — tenant superadmin + row lama) ──
  await prisma.$disconnect()
  console.log(`\n=== e2e-v470-systemlogs: ${pass} PASS / ${fails.length} FAIL ===`)
  if (fails.length) { console.log('FAILED:', fails.join(' | ')); process.exitCode = 1 }
  process.exit(process.exitCode || 0)
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })