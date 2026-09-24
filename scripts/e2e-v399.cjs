/**
 * E2E v3.9.9 — fallbackText terkirim saat TIMEOUT release (lapor Kanaka 24 Sep 12:00)
 * Dulu: timeout = silent release (fallbackText cuma kepakai jalur D2 jawaban ngaco).
 * Kini: sweep klaim atomik per-chat + kirim fallbackText sebelum masuk antrean.
 * Jalan terhadap DB COPY di port 5099 (WA_DISABLED=1) — produksi tidak tersentuh.
 * Catatan: send WA selalu gagal di E2E (WA_DISABLED) → log "[MenuGateway] send
 * gagal untuk chat=…" JUSTRU bukti jalur fallback tereksekusi (non-fatal by design).
 * Isolasi per-slot (slot lain gak ke-release) sudah tercover e2e-v394 T9 — tidak
 * diulang di sini (chat kontrol bisa ke-release oleh sync jalur lain → flaky).
 */
const REPO = '/home/kanakxxx/.openclaw/workspace/wa-cs-hub-saas-v3'
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:5099'
const LOG = '/tmp/saas_v3_e2e.log'
require(REPO + '/node_modules/dotenv').config({ path: REPO + '/.env' })
const fs = require('fs')
const { PrismaClient } = require(REPO + '/node_modules/@prisma/client')
// WAJIB: tunjuk DB COPY — jangan pernah sentuh DB produksi dari script test ini
const prisma = new PrismaClient({ datasourceUrl: 'file:/tmp/saas-v3-e2e.db' })

const fails = []
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${extra ? ' | ' + extra : ''}`)
  if (!cond) { process.exitCode = 1; fails.push(name) }
}
async function api(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let data = null
  try { data = await res.json() } catch {}
  return { status: res.status, data }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  // A0 — superadmin login + impersonate tenant 4
  const sa = await api('POST', '/api/auth/login', { username: process.env.SUPERADMIN_USERNAME, password: process.env.SUPERADMIN_PASSWORD })
  check('A0 superadmin login', sa.status === 200 && !!sa.data?.token, `status=${sa.status}`)
  const imp = sa.data?.token ? await api('POST', '/api/sa/impersonate/4', {}, sa.data.token) : null
  check('A1 impersonate tenant-4', !!imp && imp.status === 200 && !!imp.data?.token, `status=${imp?.status}`)
  const tok = imp?.data?.token
  if (!tok) return

  // T1 — config gateway slot-1: timeout 10 DETIK (clamp min efektif 10s), fallback khas
  const FB = 'FbTimeout-E2E-7788'
  const put = await api('PUT', '/api/menu-gateway', {
    enabled: true, introText: 'Intro v399 {name}', fallbackText: FB,
    timeoutValue: 10, timeoutUnit: 'seconds', repeatFrequency: 'daily',
    numberSlots: [1],
  }, tok)
  check('T1 PUT menu-gateway slot[1] timeout-10s → 200', put.status === 200, JSON.stringify(put.data || {}).slice(0, 140))

  // T2 — seed chat awaiting slot-1, umur 90 detik (sudah lewat timeout 10s)
  const src = await prisma.chat.findFirst({ where: { tenantId: 4 } })
  check('T2 pre: ada chat tenant-4 utk clone', !!src)
  let c1 = null
  if (src) {
    const { id, ...rest } = src
    c1 = await prisma.chat.create({
      data: { ...rest, numberSlot: 1, waJid: 'e2e-timeout-fb@s.whatsapp.net', menuState: 'awaiting', menuRequestedAt: new Date(Date.now() - 90 * 1000), menuOptionId: null, status: 'open', queuedAt: null, assignedToId: null },
    })
    check('T2 seed slot-1 awaiting (umur 90s)', !!c1)
  }
  if (!c1) return

  // T3 — tunggu tick sweep (interval 30s): polling BENAR (break HANYA saat done)
  let done = null
  for (let i = 0; i < 34; i++) {
    await sleep(3000)
    const row = await prisma.chat.findUnique({ where: { id: c1.id } })
    if (row?.menuState === 'done') { done = row; break }
  }
  check('T3 timeout release slot-1 → done', done?.menuState === 'done', `menuState=${done?.menuState ?? 'timeout-100s'}`)
  check('T3b queuedAt terisi', !!done?.queuedAt, `queuedAt=${done?.queuedAt ?? '-'}`)

  // T4 — bukti jalur timeout-fallback tereksekusi di log E2E server
  await sleep(1500)
  let log = ''
  try { log = fs.readFileSync(LOG, 'utf8') } catch {}
  const relLine = (log.match(/releaseAwaiting\(timeout, tenant 4\): \d+ chat[^\n]*/) || [])[0]
  check('T4 sweep timeout nge-claim (log releaseAwaiting timeout)', !!relLine, relLine || '-')
  const sendFail = (log.match(new RegExp(`send gagal untuk chat=${c1.id}[^\n]*`)) || [])[0]
  check('T4b fallback timeout diattempt utk chat slot-1 (send-gagal = WA_DISABLED, non-fatal)', !!sendFail, sendFail || '-')

  // T4c — graceful: send gagal TIDAK bikin row message palsu
  const msgCount = await prisma.message.count({ where: { chatId: c1.id } })
  check('T4c tanpa row message palsu saat send gagal', msgCount === 0, 'n=' + msgCount)

  console.log(fails.length ? `\n=== GAGAL: ${fails.length} ===` : '\n=== RINGKASAN v3.9.9 ===\nSEMUA PASS ✅')
}

main().finally(() => prisma.$disconnect())