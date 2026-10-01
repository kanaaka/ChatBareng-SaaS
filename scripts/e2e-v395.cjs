/**
 * E2E v3.9.5 — verifikasi fix gateway runtime (QA Kanaka 09:38)
 * Fokus: (A) menuGatewayConfigSafe slot-aware; (B) master-off full-off;
 * (C) "Semua nomor" = expand ke row per-slot eksplisit. DB COPY, port 5099.
 */
const REPO = '/home/kanakxxx/.openclaw/workspace/wa-cs-hub-saas-v3'
require(REPO + '/node_modules/dotenv').config({ path: REPO + '/.env' })
process.env.DATABASE_URL = 'file:/tmp/saas-v3-e2e.db'
const BASE = 'http://127.0.0.1:5099'
const { PrismaClient } = require(REPO + '/node_modules/@prisma/client')
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
  const sa = await api('POST', '/api/auth/login', { username: process.env.SUPERADMIN_USERNAME, password: process.env.SUPERADMIN_PASSWORD })
  check('A0 login superadmin', sa.status === 200, 'status=' + sa.status)
  const imp = await api('POST', '/api/sa/impersonate/4', {}, sa.data?.token)
  check('A1 impersonate t4', imp.status === 200, 'status=' + imp.status)
  const tok = imp.data?.token
  if (!tok) return

  const opts = [
    { position: 1, label: 'Info', aliases: '', replyText: 'Berikut info {name}' },
    { position: 2, label: 'CS', aliases: '', replyText: 'Menghubungkan ke CS' },
  ]

  // S0 — mirror aksi admin: matikan trigger AR slot-0 dulu (biar expand tidak 409)
  const s0 = await api('PUT', '/api/autoreply', {
    outsideHoursEnabled: false, greetEnabled: false, greetMode: 'text',
    numberAll: false, numberSlots: [0],
  }, tok)
  check('S0 AR slot-0 triggers off → 200', s0.status === 200, 'status=' + s0.status)

  // T1 — "Semua nomor" (numberSlots null EKSPLISIT) + enabled → EXPAND ke row per-slot
  const t1 = await api('PUT', '/api/menu-gateway', {
    enabled: true, numberSlots: null, introText: 'Halo {name}, pilih:', fallbackText: 'Oke',
    timeoutValue: 30, timeoutUnit: 'minutes', repeatFrequency: 'per_chat',
    options: [
      { position: 1, label: 'Info', aliases: '', replyText: 'Berikut info {name}' },
      { position: 2, label: 'CS', aliases: '', replyText: 'Menghubungkan ke CS' },
    ],
  }, tok)
  check('T1 PUT Semua nomor → 200', t1.status === 200, JSON.stringify(t1.data || {}).slice(0, 100))
  const mgRows = await prisma.menuGatewayConfig.findMany({ where: { tenantId: 4 } })
  const nums = await prisma.tenantNumber.findMany({ where: { tenantId: 4 }, select: { slot: true } })
  const allSlots = nums.map(n => Number(n.slot)).sort((a, b) => a - b)
  const explicit = allSlots.filter(s => { const r = mgRows.find(x => x.numberSlot !== null && Number(x.numberSlot) === s); return !!(r && r.enabled) })
  check('T1b semua slot punya row MG eksplisit enabled', JSON.stringify(explicit) === JSON.stringify(allSlots), `all=${JSON.stringify(allSlots)} got=${JSON.stringify(explicit)}`)
  const shared = mgRows.find(r => r.numberSlot === null)
  check('T1c shared MG row tidak ikut enabled (anti-bocor)', !shared || !shared.enabled, 'shared.enabled=' + (shared && shared.enabled))

  // T2 — AR rows slot tercentang → mode menu (scoped sync runtime gate)
  const arMenu = await prisma.autoReplyConfig.findMany({ where: { tenantId: 4, greetMode: 'menu', greetEnabled: true, numberSlot: { not: null } } })
  check('T2 AR rows slot → menu', arMenu.map(r => Number(r.numberSlot)).sort((a, b) => a - b).join() === allSlots.join(), JSON.stringify(arMenu.map(r => r.numberSlot)))

  // T3 — RUNTIME: menuGatewayConfigSafe(tenant, slot) → config per-slot enabled
  // (akar QA-2: dulu helper ini SELALU baca shared → menu per-slot tak terbaca)
  const { menuGatewayConfigSafe } = require(REPO + '/src/services/autoReply')
  const c0 = await menuGatewayConfigSafe(4, 0)
  const c1 = await menuGatewayConfigSafe(4, 1)
  check('T3 configSafe(slot=0) enabled', !!c0 && c0.enabled === true && Number(c0.numberSlot) === 0, 'ns=' + (c0 && c0.numberSlot))
  check('T3b configSafe(slot=1) enabled', !!c1 && c1.enabled === true && Number(c1.numberSlot) === 1, 'ns=' + (c1 && c1.numberSlot))

  // T4 — master OFF (enabled=false) → FULL-OFF: SEMUA row MG OFF + AR menu rows mati
  const t4 = await api('PUT', '/api/menu-gateway', { enabled: false }, tok)
  check('T4 master OFF → 200', t4.status === 200, 'status=' + t4.status)
  const mgAfter = await prisma.menuGatewayConfig.findMany({ where: { tenantId: 4 } })
  check('T4b semua row MG enabled=false', mgAfter.every(r => !r.enabled), JSON.stringify(mgAfter.map(r => [r.numberSlot, r.enabled])))
  const arMenuAfter = await prisma.autoReplyConfig.findMany({ where: { tenantId: 4, greetMode: 'menu' } })
  check('T4c tidak ada AR row tersisa mode menu', arMenuAfter.length === 0, JSON.stringify(arMenuAfter.map(r => r.numberSlot)))

  // T5 — master OFF + payload TANPA numberSlots → valid (tidak dipaksa pilih)
  const t5 = await api('PUT', '/api/menu-gateway', {
    enabled: false, introText: 'Intro off', fallbackText: 'Fb off',
    options: [
      { position: 1, label: 'A', aliases: '', replyText: 'ra' },
      { position: 2, label: 'B', aliases: '', replyText: 'rb' },
    ],
  }, tok)
  check('T5 save master-OFF tanpa tick-box → 200', t5.status === 200, 'status=' + t5.status)

  console.log('\n=== RINGKASAN v3.9.5 ===')
  console.log(fails.length === 0 ? 'SEMUA PASS ✅' : `FAIL: ${fails.join(', ')} ❌`)
}

main().finally(() => prisma.$disconnect())