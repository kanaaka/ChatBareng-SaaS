/**
 * v4.6.4 (log menu addition) — Superadmin System Log capture layer (spec
 * docs/spec-superadmin-system-log.md §D2/D6/D7).
 *
 * Satu pintu log diagnostik untuk SUPERADMIN (tenant TIDAK pernah melihat log ini):
 *  - logError/logWarn/logInfo: call-site terstruktur (module/tenant eksplisit)
 *  - wrapper console.error/warn (level error/warn) + console.log/info (level info,
 *    flood guard ±300/menit — Keputusan Terkunci #2) — dipasang via
 *    installSystemLogCapture() DI PALING ATAS src/server.js sebelum require lain.
 *  - crash handler uncaughtException/unhandledRejection → log saja, JANGAN exit.
 *
 * Aturan KERAS yang dipegang file ini:
 *  1. Best-effort (pola saAudit.audit()): kegagalan write log TIDAK PERNAH
 *     menggagalkan aksi utama yang sedang jalan — semua write try/catch.
 *  2. Anti-rekursi/anti-log-storm: referensi console ASLI disimpan saat startup;
 *     flag inLog guard re-entry sinkron; ERROR logger sendiri selalu lolos ke
 *     stdout via referensi asli (tidak lewat wrapper).
 *  3. Dedup 10 detik: pesan identik dlm window 10s → skip (hindari 1 bug → 50k row).
 *  4. Stdout behavior console lama TIDAK berubah: wrapper SELALU meneruskan ke
 *     console asli dulu (output identik), capture DB add-on di belakangnya.
 *  5. Redaksi PII SAAT INGEST (D7): digit run ≥8, email, blok message/body/payload
 *     → placeholder; caps message 1000 / stack 4000 / metaJson 4000.
 *  6. Retensi 30 hari (env SYSTEMLOG_RETENTION_DAYS override) — prune harian
 *     in-process (pola gdriveBackup anti-cron-eksternal), batch 5000 row.
 */

const prisma = require('../prisma')
const crypto = require('crypto')
const path = require('path')
const fs = require('fs')
const util = require('util')

// ─── Referensi console ASLI — dipakai internal + oleh catch di luar wrapper ───
// KRITIS: di dalam service ini JANGAN panggil console.error lagi (akan masuk
// wrapper kalau terpasang). Selalu pakai ORIGINAL_CONSOLE.
const ORIGINAL_CONSOLE = {
  error: console.error.bind(console),
  warn: console.warn.bind(console),
  log: console.log.bind(console),
  info: console.info.bind(console),
}
let logWriteActive = false // guard re-entry SINKRON (redaksi/format memicu console)

// Konstanta module (D1 + D5 dropdown FE harus senada)
const MODULES = [
  'auto-reply', 'blast', 'scheduler', 'wa', 'chat', 'media',
  'api-keys', 'auth', 'tenant', 'database', 'frontend', 'other',
]

// ─── appVersion snapshot (D2.6): APP_VERSION env → version.json root → fallback ───
let appVersionCache = null
function detectAppVersion() {
  if (appVersionCache) return appVersionCache
  let v = process.env.APP_VERSION || ''
  if (!v) {
    try {
      const p = path.resolve(__dirname, '..', '..', 'version.json')
      if (fs.existsSync(p)) {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'))
        if (j && j.appVersion) v = String(j.appVersion)
      }
    } catch { /* file opsional */ }
  }
  if (!v) {
    const d = new Date()
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`
    v = `dev-${stamp}`
  }
  appVersionCache = v
  return v
}

// ═════════════════════════════ D7 — REDAKSI (saat INGEST) ═════════════════════════════
// Diterapkan SEBELUM write → DB, UI, dan CSV sudah bersih by construction.
// 1) Digit run ≥ 8 (nomor WA, NIK, dsb.) → keep 2 depan + '***' + 4 akhir (62***2333)
// 2) Blok gaya "message/body/payload: …" → [redacted-body N chars] (panjang asli dicatat)
// 3) Email → u***@domain (domain tetap — konteks rekanan masih terbaca)
// 4) Cap panjang field: message 1000, stack 4000, metaJson 4000
const CAP_MESSAGE = 1000
const CAP_STACK = 4000
const CAP_META = 4000

function redactDigitRuns(s) {
  // Digit run BERSIH ≥8 digit (diapit non-digit) → redaksi. Run dgn campuran
  // huruf/hex (UUID/JWT base64) biasanya <8 digit berurutan — aman; kalau kena
  // justru bonus (token tidak boleh ada di log).
  return s.replace(/(^|[^0-9])([0-9]{8,})(?![0-9])/g, (_m, pre, digits) => {
    const keep = digits.length > 6 ? digits.slice(digits.length - 4) : digits.slice(digits.length - 3)
    return `${pre}${digits.slice(0, 2)}***${keep}`
  })
}

function redactEmails(s) {
  // Email → huruf pertama lokal-part + *** + domain tetap
  return s.replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g, (_m, first, domain) => `${first}***@${domain}`)
}

function redactBodyBlobs(s) {
  // Potongan "message: …" / "body: …" / "payload: …" (isi chat/request literal)
  // → placeholder dgn panjang asli (debug ukuran masih mungkin, isi tidak).
  return s.replace(/\b(message|body|payload|pesan)\b(\s*[:=]\s*)([^\n]{1,3000})/gi,
    (_m, word, sep, content) => `[redacted-body ${content.length} chars]`)
}

/** Redaksi lengkap utk satu field teks log (dipakai juga endpoint client-log). */
function redactText(raw) {
  let s = String(raw == null ? '' : raw)
  try {
    s = redactBodyBlobs(s)   // dulu (supaya isi blob tidak ikut digit-redaksi dobel)
    s = redactDigitRuns(s)
    s = redactEmails(s)
  } catch { /* redaksi gagal → sisi aman: string tetap (caps tetap jalan) */ }
  return s
}

/** Helper call-site "tampilkan pesan yang gagal proses": first-40-chars hasil redaksi (D7.5). */
function redactFirst40(raw) {
  const r = redactText(raw)
  return r.length > 40 ? r.slice(0, 40) + '…' : r
}

function capStr(s, cap) {
  if (s == null) return null
  return s.length > cap ? s.slice(0, cap) : s
}

// ═════════════════════════════ DEDUP 10 detik ═════════════════════════════
const DEDUP_MS = 10 * 1000
const dedupMap = new Map() // dedupKey → firstTs
function dedupKey(level, source, module, tenantId, message) {
  // Konteks disertakan: bug sama dari tenant berbeda tetap TERCATAT masing2
  // (baris pertama punya konteks tenant masing2); storm dari satu konteck =
  // yang dibungkam (intent spec: 1 bug → jangan 50k row).
  return crypto.createHash('sha1')
    .update(`${level}|${source}|${module}|${tenantId == null ? 'G' : tenantId}|${message}`)
    .digest('hex')
}
function isDuplicate(key) {
  const now = Date.now()
  const prev = dedupMap.get(key)
  if (prev != null && now - prev < DEDUP_MS) return true
  dedupMap.set(key, now)
  // hygiene: buang entri kadaluarsa kalau map membengkak
  if (dedupMap.size > 1000) {
    for (const [k, ts] of dedupMap) {
      if (now - ts >= DEDUP_MS) dedupMap.delete(k)
    }
  }
  return false
}

// ═══════════════ FLOOD GUARD global info (Keputusan Terkunci #2) ═══════════════
// Default ±300 info/menit (env override utk test/investigasi). Kelebihan → drop;
// 1 warn ringan "info flood suppressed N" per window (N = total ter-drop window itu).
const FLOOD_MAX_INFO_PER_MIN = (() => {
  const n = parseInt(process.env.SYSTEMLOG_FLOOD_MAX_PER_MIN || '300', 10)
  return Number.isFinite(n) && n > 0 ? n : 300
})()
const FLOOD_WINDOW_MS = (() => {
  // default 60s — window penuh 1 menit sesuai spec; env utk kecepatan e2e
  const n = parseInt(process.env.SYSTEMLOG_FLOOD_WINDOW_MS || '60000', 10)
  return Number.isFinite(n) && n >= 1000 ? n : 60000
})()
let floodWindowStart = 0
let floodDropped = 0
let floodPassedCount = 0
let floodWarnTimer = null

function flushFloodWarn() {
  if (floodDropped <= 0) return
  const n = floodDropped
  floodDropped = 0
  try { logWarn(`info flood suppressed ${n}`, { module: 'other' }) } catch { /* best-effort */ }
}

function allowInfo() {
  const now = Date.now()
  if (now - floodWindowStart >= FLOOD_WINDOW_MS) {
    flushFloodWarn() // window lalu sempat drop? catat 1 warn ringan dgn total N
    floodWindowStart = now
    floodPassedCount = 0
  }
  if (floodPassedCount >= FLOOD_MAX_INFO_PER_MIN) {
    floodDropped++
    // jadwalkan flush di ujung window supaya warn tetap tercatat walau storm berhenti
    if (!floodWarnTimer) {
      const wait = Math.max(1000, FLOOD_WINDOW_MS - (now - floodWindowStart))
      floodWarnTimer = setTimeout(() => { floodWarnTimer = null; flushFloodWarn() }, wait)
      if (floodWarnTimer.unref) floodWarnTimer.unref()
    }
    return false
  }
  floodPassedCount++
  return true
}

// ═══════════════ Helper konteks: tebalik-tembak module/tenant dari teks wrapper ═══════════════
// Wrapper menangkap console lama yang cuma punya TEKS. Tag bracket umum → module;
// pola tenant-<id> / (tenant <id>) → tenantId. Heuristik murah, tanpa IO.
const MODULE_TAG_HINTS = [
  [/AutoReply/i, 'auto-reply'],
  [/MenuGateway/i, 'scheduler'], // sweep/startFlow menuguide masuk scheduler (spec D2.5)
  [/Scheduler/i, 'scheduler'],
  [/Blast/i, 'blast'],
  [/\bWA\b|\bPool\b|Baileys/i, 'wa'],
  [/\bSA\b|\bTenant\b/i, 'tenant'],
  [/Auth/i, 'auth'],
  [/API[- ]?Keys?|apiV1/i, 'api-keys'],
  [/Media/i, 'media'],
  [/Receipts?/i, 'chat'],
  [/DB\b|P2002|PrismaClient/i, 'database'],
]
function guessModule(text) {
  for (const [re, module] of MODULE_TAG_HINTS) {
    if (re.test(text)) return module
  }
  return 'other'
}
function guessTenantId(text) {
  const m = text.match(/tenant-(\d+)\b/) || text.match(/\(tenant (\d+)\)/) || text.match(/tenant\s*#?(\d+)\b/i)
  return m ? parseInt(m[1], 10) : null
}

// ── tenantName lookup kecil (best-effort, cache 5 menit — dipakai structured call) ──
const tenantNameCache = new Map() // id → { name, at }
async function tenantNameFor(tenantId) {
  const tid = Number(tenantId)
  if (!Number.isFinite(tid)) return null
  const hit = tenantNameCache.get(tid)
  const now = Date.now()
  if (hit && now - hit.at < 5 * 60 * 1000) return hit.name
  try {
    const t = await prisma.tenant.findUnique({ where: { id: tid }, select: { name: true } })
    tenantNameCache.set(tid, { name: t?.name ?? null, at: now })
    return t?.name ?? null
  } catch {
    return hit ? hit.name : null // DB gagal → pakai cache basi (masih lebih baik dari null)
  }
}

// ═════════════════════════════ WRITE CORE (best-effort) ═════════════════════════════
// Sinkron: redaksi/caps/dedup → then DB create tanpa menyimpan inLog lintas await
// (biar log dari konteks request lain yang jalan paralel tidak ikut tersedot guard).
function buildRow(level, source, module, message, opts = {}) {
  let messageStr = redactText(message)
  if (messageStr.length > CAP_MESSAGE) messageStr = messageStr.slice(0, CAP_MESSAGE)

  let stackStr = null
  if (opts.stack && typeof opts.stack === 'string') {
    // D3 — client capture: stack sudah string mentah dari browser
    stackStr = capStr(redactText(opts.stack), CAP_STACK)
  } else if (opts.err) {
    const rawStack = opts.err instanceof Error ? (opts.err.stack || opts.err.message) : String(opts.err)
    stackStr = capStr(redactText(rawStack), CAP_STACK)
  }

  let metaStr = null
  if (opts.meta != null) {
    let j
    try { j = JSON.stringify(opts.meta) } catch { j = String(opts.meta) }
    metaStr = capStr(redactText(j), CAP_META)
  }

  let tenantId = opts.tenantId == null ? null : Number(opts.tenantId)
  if (tenantId != null && !Number.isFinite(tenantId)) tenantId = null
  let tenantName = opts.tenantName != null ? String(opts.tenantName).slice(0, 191) : null

  const mod = MODULES.includes(module) ? module : 'other'
  return {
    level,
    source,
    module: mod,
    tenantId,
    tenantName,
    appVersion: detectAppVersion(),
    message: messageStr,
    stack: stackStr,
    metaJson: metaStr,
  }
}

async function writeRow(row) {
  // guard runtime: client prisma lama (belum regenerate) → non-fatal, lolos sekali
  if (!prisma.systemLog) return
  try {
    await prisma.systemLog.create({ data: row })
  } catch (e) {
    ORIGINAL_CONSOLE.error('[SystemLog] write error (non-fatal):', e.message)
  }
}

async function emit(level, source, module, message, opts) {
  if (logWriteActive) return // re-entry sinkron fase prepare → skip total
  logWriteActive = true
  let row = null
  try {
    const key = dedupKey(level, source, module, opts?.tenantId ?? null, String(message))
    if (isDuplicate(key)) return null // dedup 10s — skip senyap (stdout tetap sudah terkirim)
    row = buildRow(level, source, module, message, opts)
  } catch (e) {
    ORIGINAL_CONSOLE.error('[SystemLog] prepare error (non-fatal):', e.message)
    return null
  } finally {
    // guard DILEPAS sebelum fase async: dua log tersinkron berurutan HARUS keduanya
    // masuk (bukan dedup — beda konten). Guard sinkron hanya melindungi fase
    // prepare; prisma write memakai ORIGINAL_CONSOLE di catch → tidak bisa self-wrap.
    logWriteActive = false
  }
  try {
    // tenantName snapshot BENAR sejak entry pertama (lookup async, cache 5 menit)
    if (row.tenantId != null && !row.tenantName) {
      row.tenantName = await tenantNameFor(row.tenantId)
    }
  } catch { /* best-effort — snapshot null pun masih sah */ }
  return writeRow(row)
}

// ─── API publik call-site terstruktur (D2) ───
function logError(message, opts) { return emit('error', 'server', opts?.module || 'other', message, opts) }
function logWarn(message, opts) { return emit('warn', 'server', opts?.module || 'other', message, opts) }
// info OPT-IN + flood guard (Keputusan Terkunci #2): maks ±300/menit
function logInfo(message, opts) {
  if (!allowInfo()) return undefined
  return emit('info', 'server', opts?.module || 'other', message, opts)
}

// ─── D3 — client capture (dipanggil POST /api/client-log; tenant & username dari TOKEN) ───
function logClient(opts = {}) {
  const mod = MODULES.includes(opts.module) ? opts.module : 'frontend'
  return emit('error', 'client', mod, opts.message || '', {
    tenantId: opts.tenantId ?? null,
    stack: typeof opts.stack === 'string' ? opts.stack : null,
    meta: {
      username: opts.username ?? null,
      route: opts.route ?? null,
    },
  })
}

// ═════════════════════════════ D2.3 — INSTALL CAPTURE ═════════════════════════════
let captureInstalled = false
function installSystemLogCapture() {
  if (captureInstalled) return
  captureInstalled = true

  // Wrapper error/warn: stdout TIDAK berubah (original dulu), capture add-on.
  const origErr = console.error
  const origWarn = console.warn
  const origLog = console.log
  const origInfo = console.info
  console.error = (...args) => {
    try { origErr(...args) } catch { /* biar tidak pernah lebih buruk dari asli */ }
    void emit('error', 'server', guessModule(args.map(String).join(' ').slice(0, 500)), util.format(...args), {
      tenantId: guessTenantId(util.format(...args)),
    })
  }
  console.warn = (...args) => {
    try { origWarn(...args) } catch {}
    const text = util.format(...args)
    void emit('warn', 'server', guessModule(text.slice(0, 500)), text, { tenantId: guessTenantId(text) })
  }
  const captureInfo = (...args) => {
    const text = util.format(...args)
    // Dev-noise guard: 'prisma:' prefix = prisma query-log literal (NODE_ENV=development)
    // — SQL literal JUGA bisa membawa nilai param → jangan masuk DB; stdout tetap utuh.
    // (Di produksi prisma client tidak log query — jalur ini jarang aktif.)
    if (text.startsWith('prisma:') || text.startsWith('[prisma:')) return
    if (allowInfo()) {
      void emit('info', 'server', guessModule(text.slice(0, 500)), text, { tenantId: guessTenantId(text) })
    }
  }
  console.log = (...args) => {
    try { origLog(...args) } catch {}
    captureInfo(...args)
  }
  console.info = (...args) => {
    try { origInfo(...args) } catch {}
    captureInfo(...args)
  }

  // ── Crash handlers: log saja, JANGAN exit (spec D2.4 — perilaku lain tidak berubah) ──
  process.on('uncaughtException', (err) => {
    const text = `uncaughtException: ${(err && err.message) || String(err)}`
    void logError(text, { module: 'other', err, meta: null })
  })
  process.on('unhandledRejection', (reason) => {
    const text = `unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`
    void logError(text, { module: 'other', err: reason instanceof Error ? reason : null })
  })

  ORIGINAL_CONSOLE.log('[SystemLog] capture aktif (console error/warn/log/info → SystemLog, dedup 10s, flood guard info ±' + FLOOD_MAX_INFO_PER_MIN + '/menit)')
}

// ═════════════════════════════ D6 — RETENSI (prune harian) ═════════════════════════════
const RETENTION_DEFAULT_DAYS = 30
function retentionDays() {
  const n = parseInt(process.env.SYSTEMLOG_RETENTION_DAYS || String(RETENTION_DEFAULT_DAYS), 10)
  return Number.isFinite(n) && n >= 1 ? n : RETENTION_DEFAULT_DAYS
}

async function pruneOnce() {
  if (!prisma.systemLog) return { deleted: 0, skipped: 'client-lama' }
  const cutoff = new Date(Date.now() - retentionDays() * 24 * 60 * 60 * 1000)
  let deleted = 0
  // batch 5000 — jangan lock DB lama
  for (let i = 0; i < 1000; i++) {
    const batch = await prisma.systemLog.findMany({ where: { ts: { lt: cutoff } }, select: { id: true }, take: 5000 })
    if (!batch.length) break
    const res = await prisma.systemLog.deleteMany({ where: { id: { in: batch.map((r) => r.id) } } })
    deleted += res.count
    if (batch.length < 5000) break
  }
  return { deleted, cutoff: cutoff.toISOString() }
}

let pruneTimer = null
function initSystemLogRetention() {
  if (pruneTimer) return
  // prune saat boot (deploy baru = bersih-bersih lama)
  pruneOnce()
    .then((r) => { if (r.deleted > 0) ORIGINAL_CONSOLE.log(`[SystemLog] Retensi boot: ${r.deleted} row > ${retentionDays()} hari dihapus`) })
    .catch((e) => ORIGINAL_CONSOLE.error('[SystemLog] Retensi boot gagal (non-fatal):', e.message))
  // tiap 24 jam di offset acak 1–55 menit (hindari barep dgn backup jam lain)
  const firstDelayMs = (60 + Math.floor(Math.random() * 54 * 60)) * 1000
  const loop = async () => {
    try {
      const r = await pruneOnce()
      if (r.deleted > 0) ORIGINAL_CONSOLE.log(`[SystemLog] Retensi harian: ${r.deleted} row dihapus`)
    } catch (e) {
      ORIGINAL_CONSOLE.error('[SystemLog] Retensi harian gagal (non-fatal):', e.message)
    }
    pruneTimer = setTimeout(loop, 24 * 60 * 60 * 1000)
  }
  pruneTimer = setTimeout(loop, firstDelayMs)
  ORIGINAL_CONSOLE.log(`[SystemLog] Retensi aktif (${retentionDays()} hari, prune harian in-process)`)
}

// ─── Ekspos utk e2e/QA — reset state in-process (HANYA dipakai test) ───
function resetInProcessStateForTest() {
  dedupMap.clear()
  floodWindowStart = 0
  floodDropped = 0
  floodPassedCount = 0
  if (floodWarnTimer) { clearTimeout(floodWarnTimer); floodWarnTimer = null }
}

module.exports = {
  MODULES,
  ORIGINAL_CONSOLE,
  logError,
  logWarn,
  logInfo,
  logClient,
  redactText,
  redactFirst40,
  capStr,
  installSystemLogCapture,
  initSystemLogRetention,
  pruneOnce,
  retentionDays,
  RETENTION_DEFAULT_DAYS,
  FLOOD_MAX_INFO_PER_MIN,
  resetInProcessStateForTest,
}