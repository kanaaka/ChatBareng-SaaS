/**
 * E2E v4.2.0 — Auto Reply Per-Slot Override (-dropdown scope + Custom/Default + Reset)
 * (spec docs/spec-v4.2.0-autoreply-per-slot-override.md §4.2)
 * Jalur copy-DB :5099 (WA_DISABLED=1 + E2E_OK_SEND=1 + E2E_DEBUG_INBOUND=1) — produksi
 * (5047) TIDAK tersentuh. Pola: scripts/e2e-v4121.cjs.
 *
 * Setup copy-DB (dari repo root — cek kolom dulu: SEMUA kolom v4.2.0 SUDAH ADA, zero-migration):
 *   python3 -c "import shutil; shutil.copy('prisma/data/saas-v3.db','/tmp/saas-v3-e2e.db')"
 *   (PRAGMA cek cbaiEndText — kolom sudah ada → prisma db execute DI-LEWATI)
 *   node prisma/seed-ai-rates.js /tmp/saas-v3-e2e.db
 *   PORT=5099 DATABASE_URL=file:/tmp/saas-v3-e2e.db WA_DISABLED=1 E2E_OK_SEND=1 \
 *     E2E_DEBUG_INBOUND=1 node src/server.js &
 *   node scripts/e2e-reset-superadmin.cjs && set -a && . ./.env && set +a && node scripts/e2e-v420.cjs
 */
const REPO = '/home/kanakxxx/.openclaw/workspace/wa-cs-hub-saas-v3'
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:5099'
// KRITIS (lesson v4.1.x): dotenv .env berisi DATABASE_URL PROD → DATABASE_URL dipaksa
// ke copy SETELAH dotenv — seluruh proses satu DB copy (service tidak menembak PROD).
const COPY_DB = 'file:/tmp/saas-v3-e2e.db'
require(REPO + '/node_modules/dotenv').config({ path: REPO + '/.env' })
process.env.DATABASE_URL = COPY_DB
const { PrismaClient } = require(REPO + '/node_modules/@prisma/client')
// WAJIB: tunjuk DB COPY — jangan pernah sentuh DB produksi dari script test ini
const prisma = new PrismaClient({ datasourceUrl: COPY_DB, log: ['error'] })

const fails = []
let pass = 0
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
  if (!cond) { process.exitCode = 1; fails.push(name) } else { pass++ }
}
async function api(method, path, body, token, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let data = null
  try { data = await res.json() } catch {}
  return { status: res.status, data }
}

const { encryptText, decryptTextSafe } = require(REPO + '/src/services/textCrypto')
const autoReplySvc = require(REPO + '/src/services/autoReply')

async function main() {
  // ═══ S0 — login super_admin (copy DB) + user tenant uji ═══
  const sa = await api('POST', '/api/auth/login', { username: process.env.SUPERADMIN_USERNAME, password: process.env.SUPERADMIN_PASSWORD })
  check(`S0 superadmin login (copy db) status=${sa.status} tok=${!!sa.data?.token}`, sa.status === 200 && !!sa.data?.token)
  const saTok = sa.data?.token
  if (!saTok) return process.exit(1)

  async function e2eLogin(username, password) {
    const r = await api('POST', '/api/auth/login', { username, password })
    return r.status === 200 ? r.data?.token : null
  }
  const { hashPassword } = require(REPO + '/src/auth')
  async function ensureE2EUser(username, role, tenantId) {
    const pw = 'e2e420pw-' + username
    const existing = await prisma.user.findFirst({ where: { username } })
    if (existing) {
      await prisma.user.update({ where: { id: existing.id }, data: { status: 'active', role, passwordHash: await hashPassword(pw) } })
    } else {
      await prisma.user.create({ data: { username, passwordHash: await hashPassword(pw), role, tenantId, status: 'active' } })
    }
    return pw
  }
  const pwAdmin8 = await ensureE2EUser('e2e420adm8', 'admin', 8)
  const t8 = await e2eLogin('e2e420adm8', pwAdmin8)
  check(`S0b login admin t8 → token=${!!t8}`, !!t8)
  if (!t8) return process.exit(1)
  // plan ✓ untuk tenant 8 (pola v4000) — cbai mode dipakai S2/S5/S6
  const s1put = await api('PUT', '/api/sa/tenants/8/plan', { featAiKnowledge: true, featMenuGateway: true, featAiRouting: true }, saTok)
  check(`S0c PUT plan t8 featAiKnowledge=true status=${s1put.status}`, s1put.status === 200 && s1put.data?.plan?.featAiKnowledge === true)

  // ═══ Setup: tenant 8 mulai bersih — shared (null) + TenantNumber slot dgn label ═══
  // Slot uji: 0 (label "mazaya fit"), 1 (TenantNumber BUKAN menu, TANPA row), 2 (menuManaged).
  await prisma.menuGatewayConfig.deleteMany({ where: { tenantId: 8 } })
  await prisma.autoReplyConfig.deleteMany({ where: { tenantId: 8 } })
  const tn = await prisma.tenantNumber.findMany({ where: { tenantId: 8 }, orderBy: { slot: 'asc' } })
  if (!tn.some((r) => r.slot === 1)) {
    await prisma.tenantNumber.create({ data: { tenantId: 8, slot: 1, label: 'E2E Nomor Dua' } })
  }
  const slot2Num = tn.find((n) => n.slot === 2)
  if (!slot2Num) {
    await prisma.tenantNumber.create({ data: { tenantId: 8, slot: 2, label: null } })
  }
  await prisma.autoReplyConfig.createMany({ data: [
    { tenantId: 8, numberSlot: null, greetEnabled: false, outsideHoursEnabled: false, greetMode: 'text', outsideHoursMode: 'text' },
    { tenantId: 8, numberSlot: 2, greetEnabled: true, greetMode: 'menu', greetText: 'Menu slot 2', updatedById: null }, // menuManaged seed (S4)
  ] })
  const slot2before = await prisma.autoReplyConfig.findUnique({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 2 } }, select: { id: true, greetText: true } })
  check(`S0d seed tenant 8: shared + slot2 menuManaged (row id=${slot2before?.id})`, !!slot2before)

  // ═══ O — GET /options (spec §2.1): label + custom/menuManaged flags ═══
  // (verifikasi flag penuh di O2 setelah S1/S2 menghasilkan row custom.)
  const o0 = await api('GET', '/api/autoreply/options', undefined, t8)
  const o0s2 = (o0.data?.slots || []).find((s) => s.slot === 2)
  check(`O-a options status=200, slots ada, slot-2 menuManaged=true, defaultExists=true`,
    o0.status === 200 && o0.data?.slots?.length >= 3 && o0s2?.menuManaged === true && o0.data?.defaultExists === true,
    `slots=${JSON.stringify((o0.data?.slots || []).map((s) => [s.slot, s.label, s.custom, s.menuManaged]))}`)

  // ═══════════ S1 — Save Default: HANYA shared row (ZERO cascade) ═══════════
  const s1 = await api('PUT', '/api/autoreply/default', {
    greetEnabled: true, greetMode: 'text', greetText: 'Halo! Default E2E420 siap membantu 🙏',
    outsideHoursEnabled: true, outsideHoursMode: 'text', outsideHoursText: 'Default E2E420 sedang istirahat 🙏',
    monFriEnabled: true, monFriStart: '07:00', monFriEnd: '18:00',
    satEnabled: true, satStart: '07:00', satEnd: '18:00',
    sunEnabled: true, sunStart: '07:00', sunEnd: '18:00',
    repeatFrequency: 'daily',
  }, t8)
  check(`S1-a PUT /default status=${s1.status} mode=${s1.data?.config?.greetMode}`, s1.status === 200 && s1.data?.config?.greetText === 'Halo! Default E2E420 siap membantu 🙏')
  const sharedRow = await prisma.autoReplyConfig.findFirst({ where: { tenantId: 8, numberSlot: null } })
  const slotRowsAfterS1 = await prisma.autoReplyConfig.findMany({ where: { tenantId: 8, numberSlot: { not: null } }, select: { numberSlot: true } })
  const slot2AfterS1 = await prisma.autoReplyConfig.findUnique({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 2 } }, select: { greetText: true, updatedById: true } })
  check('S1-b ZERO cascade: shared berubah greetText + jam 07:00; slot-2 utuh (menu row tidak tersentuh); TIDAK ada row slot baru',
    sharedRow?.greetText === 'Halo! Default E2E420 siap membantu 🙏' && sharedRow?.monFriStart === '07:00'
    && slot2AfterS1?.greetText === 'Menu slot 2' && slotRowsAfterS1.map((r) => r.numberSlot).sort().join(',') === '2')

  // ═══════════ S2 — Save Slot: upsert row per-slot, 2 template hidup berdampingan ═══════════
  const s2 = await api('PUT', '/api/autoreply/slot/0', {
    greetEnabled: true, greetMode: 'text', greetText: 'Selamat datang di SLOT-0 E2E420!',
    outsideHoursEnabled: true, outsideHoursMode: 'text', outsideHoursText: 'Slot-0 E2E420 istirahat sekarang.',
    monFriEnabled: true, monFriStart: '09:00', monFriEnd: '16:00',
  }, t8)
  check(`S2-a PUT /slot/0 status=${s2.status} custom=${s2.data?.custom}`, s2.status === 200 && s2.data?.custom === true)
  const s2b = await api('PUT', '/api/autoreply/slot/1', {
    greetEnabled: true, greetMode: 'text', greetText: 'CS SLOT-1 E2E420 di sini 🙏',
    outsideHoursEnabled: true, outsideHoursText: 'SLOT-1 E2E420 di luar jam kerja.',
    sunEnabled: false,
  }, t8)
  check(`S2-b PUT /slot/1 status=${s2b.status} custom=${s2b.data?.custom}`, s2b.status === 200 && s2b.data?.custom === true)
  const s0row = await prisma.autoReplyConfig.findUnique({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 0 } } })
  const s1row = await prisma.autoReplyConfig.findUnique({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 1 } } })
  check('S2-c dua row per-slot TERPISAH dgn konten sendiri (INTI FITUR), shared tidak tersentuh',
    s0row?.greetText === 'Selamat datang di SLOT-0 E2E420!' && s0row?.monFriStart === '09:00'
    && s1row?.greetText === 'CS SLOT-1 E2E420 di sini 🙏' && s1row?.sunEnabled === false
    && sharedRow?.greetText === (await prisma.autoReplyConfig.findFirst({ where: { tenantId: 8, numberSlot: null } }))?.greetText)
  // GET ?slot=0 additive: custom:true + menuManaged:false + isi row slot
  const s2get = await api('GET', '/api/autoreply?slot=0', undefined, t8)
  check('S2-d GET ?slot=0 custom=true + menuManaged=false + greetText row slot',
    s2get.status === 200 && s2get.data?.custom === true && s2get.data?.menuManaged === false && s2get.data?.config?.greetText === 'Selamat datang di SLOT-0 E2E420!')

  // ═══ O2 — options setelah save: custom flags benar + label TenantNumber ═══
  const o2 = await api('GET', '/api/autoreply/options', undefined, t8)
  const o2map = new Map((o2.data?.slots || []).map((s) => [s.slot, s]))
  check('O2-b options: slot0/1 custom=true, slot2 menuManaged, label "E2E Nomor Dua", slot1 sekarang custom',
    o2.status === 200 && o2map.get(0)?.custom === true && o2map.get(1)?.custom === true
    && o2map.get(2)?.menuManaged === true && o2map.get(2)?.custom === false && o2map.get(1)?.label === 'E2E Nomor Dua')

  // ═══════════ S3 — Reset: DELETE row slot → kembali mirror Default ═══════════
  const s3 = await api('DELETE', '/api/autoreply/slot/1', undefined, t8)
  check(`S3-a DELETE /slot/1 status=${s3.status} ok=${s3.data?.ok}`, s3.status === 200 && s3.data?.ok === true && s3.data?.slot === 1)
  const s1rowAfter = await prisma.autoReplyConfig.findUnique({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 1 } } })
  check('S3-b row slot-1 HILANG (kembali mirror)', s1rowAfter === null)
  const s3get = await api('GET', '/api/autoreply?slot=1', undefined, t8)
  check('S3-c GET ?slot=1 custom=false + effective greetText = SHARED (mirror kembali)',
    s3get.status === 200 && s3get.data?.custom === false && s3get.data?.config?.greetText === 'Halo! Default E2E420 siap membantu 🙏')
  // Reset row yang memang belum ada → 200 ok (idempoten — hasil = sudah default; lihat report)
  const s3d = await api('DELETE', '/api/autoreply/slot/1', undefined, t8)
  check('S3-d DELETE row tanpa row → tetap 200 (reset idempoten)', s3d.status === 200 && s3d.data?.ok === true && s3d.data?.deleted === 0)

  // ═══════════ S4 — menu-managed: PUT + DELETE slot-2 → 409 (teks persis) ═══════════
  const s4 = await api('PUT', '/api/autoreply/slot/2', { greetEnabled: true, greetText: 'Coba timpa menu' }, t8)
  check(`S4-a PUT /slot/2 (menu-managed) → 409 status=${s4.status}`, s4.status === 409 && String(s4.data?.error || '').includes('matikan menu untuk slot itu di halaman Menu Gateway'))
  const s4b = await api('DELETE', '/api/autoreply/slot/2', undefined, t8)
  check(`S4-b DELETE /slot/2 (menu-managed) → 409 status=${s4b.status}`, s4b.status === 409 && String(s4b.data?.error || '').includes('matikan menu untuk slot itu di halaman Menu Gateway dulu'))
  const slot2after4 = await prisma.autoReplyConfig.findUnique({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 2 } } })
  check('S4-c row slot-2 tidak berubah (terproteksi)', slot2after4?.greetText === 'Menu slot 2' && slot2after4?.greetMode === 'menu')

  // ═══════════ S5 — CB-AI guard: field shared di PUT /slot → 400; valid di PUT /default ═══════════
  const s5 = await api('PUT', '/api/autoreply/slot/0', { cbaiBotName: 'Sinta' }, t8)
  check(`S5-a PUT /slot/0 dgn cbaiBotName → 400 status=${s5.status}`, s5.status === 400 && String(s5.data?.error || '').includes('diatur di Default (Semua nomor) — KB & persona tetap tenant-wide'))
  const s5b = await api('PUT', '/api/autoreply/slot/0', { cbaiLimit: 5 }, t8)
  check(`S5-b PUT /slot/0 dgn cbaiLimit → 400 status=${s5b.status}`, s5b.status === 400 && String(s5b.data?.error || '').includes('diatur di Default'))
  const s5c = await api('PUT', '/api/autoreply/default', { cbaiBotName: 'Sinta E2E420', cbaiBotRole: 'Asistan Mazaya', cbaiLimit: 4, cbaiEndText: 'AI E2E420 selesai. {label} lanjut ya.' }, t8)
  check(`S5-c PUT /default dgn CB-AI fields valid → 200 status=${s5c.status}`, s5c.status === 200 && s5c.data?.config?.cbaiBotName === 'Sinta E2E420' && s5c.data?.config?.cbaiLimit === 4)
  const s5shared = await prisma.autoReplyConfig.findFirst({ where: { tenantId: 8, numberSlot: null } })
  const s5slotRow = await prisma.autoReplyConfig.findUnique({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 0 } } })
  check('S5-d CB-AI tertulis di SHARED row (bukan row slot)', s5shared?.cbaiBotName === 'Sinta E2E420' && s5shared?.cbaiLimit === 4 && s5slotRow?.cbaiBotName === '' && s5slotRow?.cbaiLimit === 3)

  // ═══════════ S6 — plan gate: cbai mode di PUT /slot + /default → 403 (Lite ✗) ═══════════
  const s6off = await api('PUT', '/api/sa/tenants/8/plan', { featAiKnowledge: false }, saTok)
  check(`S6-a PUT plan featAiKnowledge=false → 200`, s6off.status === 200)
  const s6 = await api('PUT', '/api/autoreply/slot/0', { outsideHoursMode: 'cbai' }, t8)
  check(`S6-b PUT /slot/0 mode cbai plan ✗ → 403 status=${s6.status}`, s6.status === 403 && s6.data?.feature === 'featAiKnowledge')
  const s6b = await api('PUT', '/api/autoreply/default', { greetMode: 'cbai' }, t8)
  check(`S6-c PUT /default mode cbai plan ✗ → 403 status=${s6b.status}`, s6b.status === 403 && s6b.data?.feature === 'featAiKnowledge')
  const s6sa = await api('PUT', '/api/autoreply/slot/1?tenant=8', { greetMode: 'cbai' }, saTok)
  check(`S6-d SA ?tenant=8 plan ✗ PUT cbai → 403 JUGA (no backdoor) status=${s6sa.status}`, s6sa.status === 403)
  await api('PUT', '/api/sa/tenants/8/plan', { featAiKnowledge: true }, saTok)

  // ═══════════ S7 — invalid input: slot ngawur / jam ngawur / field asing ═══════════
  const s7a = await api('PUT', '/api/autoreply/slot/3', { greetText: 'x' }, t8)
  const s7a2 = await api('DELETE', '/api/autoreply/slot/9', undefined, t8)
  check(`S7-a slot=3/9 → 400 status=${s7a.status}/${s7a2.status}`, s7a.status === 400 && s7a2.status === 400)
  const s7b = await api('PUT', '/api/autoreply/slot/0', { monFriEnabled: true, monFriStart: '25:99', monFriEnd: '23:00' }, t8)
  check(`S7-b TIME_RE jam ngawur → 400 status=${s7b.status}`, s7b.status === 400 && String(s7b.data?.error || '').includes('tidak valid (format HH:mm)'))
  const s7c = await api('PUT', '/api/autoreply/default', { fieldAsing420: true }, t8)
  check(`S7-c field asing → 400 status=${s7c.status}`, s7c.status === 400 && String(s7c.data?.error || '').includes('Field tidak dikenal: fieldAsing420'))
  const s7d = await api('PUT', '/api/autoreply/slot/0', { numberSlots: [0, 1] }, t8)
  check(`S7-d scope-field (numberSlots) di PUT slot → 400 status=${s7d.status}`, s7d.status === 400)

  // ═══════════ S8 — runtime getConfigForSlot mirror roundtrip (+ cache-invalidation) ═══════════
  // Bypass cache dulu (script memegang cache prosesnya sendiri):
  autoReplySvc.invalidateConfig(8)
  const effBefore = await autoReplySvc.getConfigForSlot(8, 1)
  check('S8-a SLOT-1 (tanpa row, pasca reset) → effective = shared (greetText Default)',
    effBefore?.greetText === 'Halo! Default E2E420 siap membantu 🙏' && effBefore?.numberSlot === null,
    `slotNull=${effBefore?.numberSlot} text=${JSON.stringify(String(effBefore?.greetText || '').slice(0, 40))}`)
  // Save slot lagi (via API — cache di PROSES SERVER invalidasi; proses script di-invalidate manual)
  const s8 = await api('PUT', '/api/autoreply/slot/1', { greetText: 'SLOT-1 override SEKALI LAGI E2E420' }, t8)
  check(`S8-b PUT /slot/1 ulang (upsert, bukan duplikat) → 200 status=${s8.status}`, s8.status === 200)
  autoReplySvc.invalidateConfig(8)
  const effMid = await autoReplySvc.getConfigForSlot(8, 1)
  check('S8-c runtime slot-1 pakai row CUSTOM (teks override)', effMid?.greetText === 'SLOT-1 override SEKALI LAGI E2E420' && effMid?.numberSlot === 1)
  // Reset → mirror lagi (cache invalidation terbukti di kedua arah)
  const s8c = await api('DELETE', '/api/autoreply/slot/1', undefined, t8)
  check(`S8-c2 DELETE /slot/1 → 200 status=${s8c.status}`, s8c.status === 200)
  autoReplySvc.invalidateConfig(8)
  const effAfter = await autoReplySvc.getConfigForSlot(8, 1)
  check('S8-d pasca reset → mirror kembali ke shared (cache invalidation terbukti)',
    effBefore?.greetText === 'Halo! Default E2E420 siap membantu 🙏' && effMid?.numberSlot === 1
    && effMid?.greetText === 'SLOT-1 override SEKALI LAGI E2E420' && !!(await prisma.autoReplyConfig.findFirst({ where: { tenantId: 8, numberSlot: 1 } })) === false
    && (await autoReplySvc.getConfigForSlot(8, 1)).greetText === 'Halo! Default E2E420 siap membantu 🙏')

  // CB-AI overlay (spec §0, Kanaka #2): slot-1 custom → effective persona/limit dari SHARED
  const effOverlaid = await autoReplySvc.getConfigForSlot(8, 0)
  check('S8-e CB-AI SHARED overlay di runtime slot custom (persona/limit milik Default)',
    effOverlaid?.cbaiBotName === 'Sinta E2E420' && effOverlaid?.cbaiLimit === 4 && effOverlaid?.greetText === 'Selamat datang di SLOT-0 E2E420!')

  // ═══════════ S9 — kompat LEGACY: shared dinetralkan + 2 slot rows (bekas tick-box) ═══════════
  // Bentuk data persis hasil PUT legacy v3.9.4: shared trigger OFF + rows slot mode text.
  await prisma.autoReplyConfig.deleteMany({ where: { tenantId: 8 } })
  await prisma.autoReplyConfig.createMany({ data: [
    { tenantId: 8, numberSlot: null, outsideHoursEnabled: false, outsideHoursText: 'AWAY SHARED', greetEnabled: false, greetMode: 'text', greetText: 'GREET SHARED' },
    { tenantId: 8, numberSlot: 0, outsideHoursEnabled: true, outsideHoursText: 'AWAY SLOT-0 LEGACY', greetEnabled: true, greetMode: 'text', greetText: 'GREET SLOT-0 LEGACY' },
    { tenantId: 8, numberSlot: 2, outsideHoursEnabled: true, outsideHoursText: 'AWAY SLOT-2 LEGACY', greetEnabled: true, greetMode: 'text', greetText: 'GREET SLOT-2 LEGACY' },
  ] })
  const s9o = await api('GET', '/api/autoreply/options', undefined, t8)
  const s9map = new Map((s9o.data?.slots || []).map((s) => [s.slot, s]))
  check('S9-a options pasca legacy: custom=2 (slot 0 & 2), defaultExists=true',
    s9o.status === 200 && s9map.get(0)?.custom === true && s9map.get(2)?.custom === true
    && s9o.data?.defaultExists === true)
  autoReplySvc.invalidateConfig(8)
  const s9slot1 = await autoReplySvc.getConfigForSlot(8, 1)
  check('S9-b runtime slot TANPA row = trigger OFF (netral shared — jalur legacy utuh)',
    s9slot1?.outsideHoursEnabled === false && s9slot1?.greetEnabled === false && s9slot1?.greetText === 'GREET SHARED')
  await api('DELETE', '/api/autoreply/slot/0', undefined, t8) // bersih — jalur BARU bekerja pada legacy state
  await api('DELETE', '/api/autoreply/slot/2', undefined, t8)
  check('S9-c reset (DELETE) bekerja pada state legacy: rows slot terhapus, shared utuh',
    (await prisma.autoReplyConfig.findUnique({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 0 } } })) === null
    && (await prisma.autoReplyConfig.findUnique({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 2 } } })) === null
    && !!(await prisma.autoReplyConfig.findFirst({ where: { tenantId: 8, numberSlot: null } })))

  // ═══════════ S10 — CB-AI overlay API-level (Kanaka #2 — KB & persona SHARED) ═══════════
  // shared cbaiEndText (dari S5c) + persona → GET ?slot=0 HARUS echo milik shared
  await prisma.autoReplyConfig.update({ where: { id: (await prisma.autoReplyConfig.findFirst({ where: { tenantId: 8, numberSlot: null } })).id }, data: { cbaiBotName: 'Persona Default 420', cbaiEndText: null } })
  await api('PUT', '/api/autoreply/slot/0', { greetText: 'SLOT-0 tenks E2E420!' }, t8)
  autoReplySvc.invalidateConfig(8)
  const s10 = await api('GET', '/api/autoreply?slot=0', undefined, t8)
  check('S10-a GET ?slot=0: persona SHARED dipertahankan di effective slot (overlay D1)',
    s10.status === 200 && s10.data?.config?.cbaiBotName === 'Persona Default 420' && s10.data?.config?.greetText === 'SLOT-0 tenks E2E420!')

  // ═══════════ S11 — regresi in-file: legacy PUT masih 200 + cbaiEndText 501 → 400 ═══════════
  const s11a1 = await api('PUT', '/api/autoreply/default', { cbaiEndText: 'X'.repeat(501) }, t8)
  check(`S11-a cbaiEndText 501 char di /default → 400 status=${s11a1.status}`, s11a1.status === 400 && String(s11a1.data?.error || '').includes('maksimal 500'))
  const s11a2 = await api('PUT', '/api/autoreply/default', { cbaiEndText: 'X'.repeat(500) }, t8)
  check(`S11-b cbaiEndText 500 char → 200 (pas cap) status=${s11a2.status}`, s11a2.status === 200)
  // LEGACY PUT path — numberSlots array (tick-box) MASIH JALAN 200 (byte-compat)
  const s11c = await api('PUT', '/api/autoreply', {
    numberSlots: [1],
    greetEnabled: true, greetMode: 'text', greetText: 'Legacy tick-box masih jalan E2E420',
    outsideHoursEnabled: true, outsideHoursText: 'Away legacy 420',
    monFriEnabled: true, monFriStart: '08:00', monFriEnd: '17:00',
    satEnabled: true, satStart: '08:00', satEnd: '17:00',
    sunEnabled: true, sunStart: '08:00', sunEnd: '17:00',
  }, t8)
  check(`S11-c LEGACY PUT /autoreply (tick-box) → 200 status=${s11c.status}`, s11c.status === 200)
  const s11legacyRow = await prisma.autoReplyConfig.findUnique({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 1 } } })
  check('S11-d legacy tick-box: row slot-1 dibuat + shared NETRAL (legacy semantik persis)',
    s11legacyRow?.greetText === 'Legacy tick-box masih jalan E2E420'
    && !!(await prisma.autoReplyConfig.findFirst({ where: { tenantId: 8, numberSlot: null } })))
  // bersihkan state akhir (kembali clean — legacy row jangan tertinggal utk run berikutnya)
  await prisma.autoReplyConfig.deleteMany({ where: { tenantId: 8 } })
  await prisma.autoReplyConfig.create({ data: { tenantId: 8, numberSlot: null } })

  // ═══════════ S12 — AUDIT Kimi K3 R1 BUG#1: greetMode='menu' DITOLAK (400) di endpoint BARU ═══════════
  // Opsi A: tanpa row orphan menu → tanpa senyap total, tanpa soft-lock 409.
  const s12a = await api('PUT', '/api/autoreply/slot/1', { greetMode: 'menu', greetEnabled: true, greetText: 'coba menu 420' }, t8)
  check(`S12-a PUT /slot/1 greetMode=menu → 400 status=${s12a.status}`, s12a.status === 400 && String(s12a.data?.error || '').includes('Mode menu diatur di halaman Menu Gateway'))
  const s12b = await api('PUT', '/api/autoreply/default', { greetMode: 'menu', greetEnabled: true, greetText: 'coba menu default 420' }, t8)
  check(`S12-b PUT /default greetMode=menu → 400 status=${s12b.status}`, s12b.status === 400 && String(s12b.data?.error || '').includes('Mode menu diatur di halaman Menu Gateway'))
  check('S12-c TIDAK ada row dibuat/diubah oleh penolakan (slot-1 tetap tanpa row; shared greetMode tetap text)',
    (await prisma.autoReplyConfig.findUnique({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 1 } } })) === null
    && (await prisma.autoReplyConfig.findFirst({ where: { tenantId: 8, numberSlot: null } }))?.greetMode === 'text')
  // Tidak soft-lock: slot-1 masih bisa di-save normal (tanpa row menu orphan yang mengunci 409)
  const s12d = await api('PUT', '/api/autoreply/slot/1', { greetText: 'Slot-1 masih bisa disimpan pasca penolakan menu' }, t8)
  check(`S12-d tidak soft-lock: PUT /slot/1 normal → 200 status=${s12d.status}`, s12d.status === 200)
  await api('DELETE', '/api/autoreply/slot/1', undefined, t8)

  // ═══════════ O3 — AUDIT N1: slot-0 SINTETIS di /options bila TenantNumber hanya slot 1/2 ═══════════
  // Simulasi persis kasus eksotik: baris TenantNumber slot-1 & slot-2 ADA, slot-0 tidak pernah connect.
  // (hapus baris slot-0 sementara — restore persis setelahnya; hanya DB COPY.)
  const keptSlot0 = await prisma.tenantNumber.findUnique({ where: { tenantId_slot: { tenantId: 8, slot: 0 } } })
  await prisma.tenantNumber.delete({ where: { tenantId_slot: { tenantId: 8, slot: 0 } } }).catch(() => null)
  const o3 = await api('GET', '/api/autoreply/options', undefined, t8)
  if (keptSlot0) await prisma.tenantNumber.create({ data: { tenantId: 8, slot: 0, label: keptSlot0.label, waSessionDir: keptSlot0.waSessionDir } }).catch(() => null)
  check('O3-a options tetap punya slot-0 (sintetis, label null) + slot-1 & slot-2 tetap ada (pola /wa/status)',
    o3.status === 200 && (o3.data?.slots || []).some((s) => s.slot === 0 && s.label === null)
    && (o3.data?.slots || []).some((s) => s.slot === 1) && (o3.data?.slots || []).some((s) => s.slot === 2))

  // ═══════════ S13 — AUDIT R3 N5: shared menu-managed dgn FIELD GREET* → 409; non-greet tetap 200 ═══════════
  // Greeting milik halaman Menu Gateway sampai menu-nya dimatikan (sync MG lengkap +
  // releaseAwaiting HANYA di jalur MG/legacy). Field non-greet = independent → 200.
  const s13shared = await prisma.autoReplyConfig.findFirst({ where: { tenantId: 8, numberSlot: null } })
  await prisma.autoReplyConfig.update({ where: { id: s13shared.id }, data: { greetMode: 'menu', greetEnabled: true } })
  // (i) greet* apapun → 409 "Greeting dikelola Menu Gateway…"
  const s13a = await api('PUT', '/api/autoreply/default', { greetMode: 'text', greetText: 'coba takeover 420' }, t8)
  const s13a2 = await api('PUT', '/api/autoreply/default', { greetEnabled: false }, t8)
  const s13a3 = await api('PUT', '/api/autoreply/default', { greetText: 'ganti teks greet 420' }, t8)
  check(`S13-a PUT /default greet* (mode/toggle/teks) saat shared menu → 409 = ${s13a.status}/${s13a2.status}/${s13a3.status}`,
    s13a.status === 409 && s13a2.status === 409 && s13a3.status === 409
    && String(s13a.data?.error || '').includes('Greeting dikelola Menu Gateway — matikan menunya di halaman Menu Gateway dulu'))
  const s13row = await prisma.autoReplyConfig.findFirst({ where: { tenantId: 8, numberSlot: null } })
  check('S13-b shared row TIDAK berubah (greetMode tetap menu)', s13row?.greetMode === 'menu')
  // (ii) field NON-greet → 200 + greetMode row TETAP 'menu' (independen)
  const s13b = await api('PUT', '/api/autoreply/default', { outsideHoursText: 'Away tetap bisa diedit 420' }, t8)
  const s13bRow = await prisma.autoReplyConfig.findFirst({ where: { tenantId: 8, numberSlot: null } })
  check(`S13-c PUT /default outsideHoursText only saat shared menu → 200 + greetMode tetap menu status=${s13b.status} mode=${s13bRow?.greetMode}`,
    s13b.status === 200 && s13bRow?.greetMode === 'menu' && s13bRow?.outsideHoursText === 'Away tetap bisa diedit 420')
  // (iii) payload greet* DI-OMIT penuh → 200 normal (greeting tak disentuh — jalur edit umum hidup)
  const s13c = await api('PUT', '/api/autoreply/default', { outsideHoursEnabled: true, outsideHoursMode: 'text', outsideHoursText: 'Away umum 420', repeatFrequency: 'daily' }, t8)
  check(`S13-d PUT /default tanpa greet* sama sekali → 200 status=${s13c.status}`, s13c.status === 200)
  // PEMULIHAN: jalur legacy (PUT link-all text → sync MG lengkap + releaseAwaiting) →
  // setelahnya endpoint baru bebas greet* lagi (endpoint baru konsisten 409 selama menu).
  const s13d2 = await api('PUT', '/api/autoreply/default', { greetMode: 'text', greetText: 'masih 409 420' }, t8)
  check(`S13-e PUT /default ganti mode (masih menu) → tetap 409 (konsisten) status=${s13d2.status}`, s13d2.status === 409)
  const s13e = await api('PUT', '/api/autoreply', { numberSlots: null, greetMode: 'text', greetText: 'Pemulihan via jalur legacy E2E420' }, t8)
  check(`S13-f pemulihan via PUT legacy (link-all text → sync MG lengkap) → 200 status=${s13e.status}`, s13e.status === 200)
  const s13f = await api('GET', '/api/autoreply', undefined, t8)
  check('S13-g pasca pemulihan legacy: shared mode text (endpoint baru tidak soft-lock)',
    s13f.status === 200 && s13f.data?.config?.greetMode === 'text')

  await prisma.$disconnect()
  console.log(`\n=== e2e-v420: ${pass} PASS / ${fails.length} FAIL ===`)
  if (fails.length) { console.log('FAILED:', fails.join(' | ')); process.exitCode = 1 }
  process.exit(process.exitCode || 0)
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })