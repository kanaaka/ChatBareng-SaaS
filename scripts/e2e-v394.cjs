/**
 * E2E v3.9.4 — verifikasi 6 fix QA Kanaka 24 Sep
 * Jalan terhadap DB COPY di port 5099 (WA_DISABLED=1) — produksi tidak tersentuh.
 */
const REPO = '/home/kanakxxx/.openclaw/workspace/wa-cs-hub-saas-v3'
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:5099'
// Kredensial superadmin dari .env repo (HANYA untuk login di E2E server copy)
require(REPO + '/node_modules/dotenv').config({ path: REPO + '/.env' })
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

async function main() {
  // A0 — superadmin login
  const sa = await api('POST', '/api/auth/login', { username: process.env.SUPERADMIN_USERNAME, password: process.env.SUPERADMIN_PASSWORD })
  check('A0 superadmin login', sa.status === 200 && !!sa.data?.token, `status=${sa.status}`)
  const saTok = sa.data?.token
  if (!saTok) return

  // A1 — impersonate tenant 4
  const imp = await api('POST', '/api/sa/impersonate/4', {}, saTok)
  check('A1 impersonate tenant-4', imp.status === 200 && !!imp.data?.token, `status=${imp.status}`)
  const tok = imp.data?.token
  if (!tok) return

  // T1 — GET autoreply: arrays tick-box ada (basis persistensi QA #5)
  const ar0 = await api('GET', '/api/autoreply', undefined, tok)
  check('T1 GET autoreply 200 + numberSlots/menuManagedSlots', ar0.status === 200 && Array.isArray(ar0.data?.numberSlots) && Array.isArray(ar0.data?.menuManagedSlots), JSON.stringify({ n: ar0.data?.numberSlots, m: ar0.data?.menuManagedSlots }))

  // T2 — mixed Semua+slot → 400
  const t2 = await api('PUT', '/api/autoreply', { numberAll: true, numberSlots: [0] }, tok)
  check('T2 mixed Semua+slot → 400', t2.status === 400, JSON.stringify(t2.data || {}).slice(0, 120))

  // T2b — tick-box kosong → 400
  const t2b = await api('PUT', '/api/autoreply', { outsideHoursEnabled: true, numberSlots: [] }, tok)
  check('T2b tick-box kosong → 400', t2b.status === 400, JSON.stringify(t2b.data || {}).slice(0, 120))

  // T3 — save per-slot [0] + persist
  const t3 = await api('PUT', '/api/autoreply', {
    outsideHoursEnabled: true, outsideHoursText: 'Away E2E',
    greetEnabled: false, greetText: '', greetMode: 'text',
    monFriEnabled: true, monFriStart: '08:00', monFriEnd: '17:00',
    satEnabled: false, sunEnabled: false,
    numberAll: false, numberSlots: [0],
  }, tok)
  check('T3 PUT per-slot [0] → 200', t3.status === 200, JSON.stringify(t3.data || {}).slice(0, 150))
  const ar1 = await api('GET', '/api/autoreply', undefined, tok)
  check('T3b persist numberSlots=[0]', JSON.stringify(ar1.data?.numberSlots || []) === '[0]', JSON.stringify(ar1.data?.numberSlots))

  // T4 — menu-gateway per-slot [1]
  const mg = await api('PUT', '/api/menu-gateway', {
    enabled: true, introText: 'Intro E2E {name}', fallbackText: 'Fb E2E',
    timeoutValue: 30, timeoutUnit: 'minutes', repeatFrequency: 'daily',
    numberSlots: [1],
    options: [
      { position: 1, label: 'A', aliases: '', replyText: 'ra' },
      { position: 2, label: 'B', aliases: '', replyText: 'rb' },
    ],
  }, tok)
  check('T4 menu-gw per-slot [1] → 200', mg.status === 200, JSON.stringify(mg.data || {}).slice(0, 150))
  const mg1 = await api('GET', '/api/menu-gateway?slot=1', undefined, tok)
  check('T4b GET ?slot=1 enabled=true', mg1.status === 200 && mg1.data?.config?.enabled === true && mg1.data?.numberSlot === 1, JSON.stringify({ e: mg1.data?.config?.enabled, s: mg1.data?.numberSlot }))
  const mgS = await api('GET', '/api/menu-gateway', undefined, tok)
  check('T4c menuManagedSlots=[1]', (mgS.data?.menuManagedSlots || []).includes(1), JSON.stringify(mgS.data?.menuManagedSlots))
  const ar2 = await api('GET', '/api/autoreply', undefined, tok)
  check('T4d autoreply menuManagedSlots=[1]', (ar2.data?.menuManagedSlots || []).includes(1), JSON.stringify(ar2.data?.menuManagedSlots))

  // T5 — autoreply save ke slot menu-managed → 409 (proteksi hybrid QA #6)
  const t5 = await api('PUT', '/api/autoreply', { outsideHoursEnabled: true, numberSlots: [1] }, tok)
  check('T5 autoreply slot menu-managed → 409', t5.status === 409, JSON.stringify(t5.data || {}).slice(0, 150))

  // T6 — logout WA guard: tanpa confirm → 400 (QA #1 endpoint)
  const t6 = await api('POST', '/api/wa/logout', { slot: 0 }, tok)
  check('T6 logout tanpa confirm → 400', t6.status === 400, JSON.stringify(t6.data || {}).slice(0, 120))

  // T7 — mode routing + assign per slot (QA #2)
  const m1 = await api('PUT', '/api/wa/mode', { mode: 'mix' }, tok)
  check('T7 waMode mix → 200', m1.status === 200 && m1.data?.waMode === 'mix', JSON.stringify(m1.data || {}).slice(0, 80))
  const badAgent = await api('PUT', '/api/wa/numbers/1', { assignedAgentId: 999999 }, tok)
  check('T7b assigned agent invalid → 400', badAgent.status === 400, JSON.stringify(badAgent.data || {}).slice(0, 120))
  const users = await api('GET', '/api/users', undefined, tok)
  const agent = (users.data?.users || []).find((u) => ['cs', 'admin'].includes(u.role) && u.status === 'active')
  check('T7c ada agent cs/admin utk assign', !!agent)
  if (agent) {
    const good = await api('PUT', '/api/wa/numbers/1', { routeMode: 'assigned', assignedAgentId: agent.id, reassignOffline: true }, tok)
    check('T7d routing assigned → 200', good.status === 200 && good.data?.number?.assignedAgentId === agent.id, JSON.stringify(good.data?.number || {}).slice(0, 140))
  }

  // T9 — v3.9.6: semantik master-off (QA round-2 24 Sep): enabled=false = MATI
  // TOTAL semua slot walau ada tick-box → awaiting SEMUA slot ke-release.
  try {
    const src = await prisma.chat.findFirst({ where: { tenantId: 4 } })
    check('T9 pre: ada chat tenant-4 utk clone', !!src)
    if (src) {
      const mk = async (slot, jid) => {
        const { id, ...rest } = src
        return prisma.chat.create({
          data: { ...rest, numberSlot: slot, waJid: jid, menuState: 'awaiting', menuRequestedAt: new Date(), status: 'open', queuedAt: null, assignedToId: null },
        })
      }
      const cA = await mk(0, 'e2e-slot0-test@s.whatsapp.net')
      const cB = await mk(1, 'e2e-slot1-test@s.whatsapp.net')
      const off = await api('PUT', '/api/menu-gateway', { enabled: false, numberSlots: [1] }, tok)
      check('T9 menu-gw disable slot1 → 200', off.status === 200, JSON.stringify(off.data || {}).slice(0, 120))
      const a = await prisma.chat.findUnique({ where: { id: cA.id } })
      const b = await prisma.chat.findUnique({ where: { id: cB.id } })
      check('T9b master-off → slot-0 awaiting ke-release (full-off)', a?.menuState === 'done', 'menuState=' + a?.menuState)
      check('T9c master-off → slot-1 awaiting ke-release (full-off)', b?.menuState === 'done', 'menuState=' + b?.menuState)
      await prisma.chat.deleteMany({ where: { id: { in: [cA.id, cB.id] } } })
    }
  } catch (e) {
    check('T9 slot-scoped release', false, String(e.message).slice(0, 200))
  }

  // T8 — login limiter (dijalankan TERAKHIR: bakar bucket login ±1 menit)
  // v3.9.6 — T8 pakai X-Forwarded-For dummy (trust proxy loopback) supaya bucket
  // login IP test utama TIDAK kebakar (dulu rerun E2E selalu 429 di A0 run berikut).
  let last = null
  for (let i = 0; i < 18; i++) {
    const res = await fetch(BASE + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.7' },
      body: JSON.stringify({ username: 'e2e-nope', password: 'x' }),
    })
    last = { status: res.status, data: await res.json().catch(() => null) }
  }
  check('T8 login ke-18 → 429 (limiter login terpisah)', last?.status === 429, 'status=' + last?.status)

  console.log('\n=== RINGKASAN ===')
  console.log(fails.length === 0 ? 'SEMUA PASS ✅' : `FAIL: ${fails.join(', ')} ❌`)
}

main().finally(() => prisma.$disconnect())