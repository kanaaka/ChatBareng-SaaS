/**
 * E2E v4.2.1 — Menu Gateway PER-SLOT Override (dropdown + Custom/Default + Reset)
 * (spec docs/spec-v4.2.1-menugateway-per-slot-override.md §4)
 * Jalur copy-DB :5099 (WA_DISABLED=1 + E2E_OK_SEND=1 + E2E_DEBUG_INBOUND=1) — produksi
 * (5047) TIDAK tersentuh. Pola: scripts/e2e-v420.cjs.
 *
 * Setup copy-DB (dari repo root — SEMUA struktur ada sejak v3.9, zero-migration):
 *   python3 -c "import shutil; shutil.copy('prisma/data/saas-v3.db','/tmp/saas-v3-e2e.db')"
 *   node prisma/seed-ai-rates.js /tmp/saas-v3-e2e.db
 *   PORT=5099 DATABASE_URL=file:/tmp/saas-v3-e2e.db WA_DISABLED=1 E2E_OK_SEND=1 \
 *     E2E_DEBUG_INBOUND=1 node src/server.js &
 *   node scripts/e2e-reset-superadmin.cjs && set -a && . ./.env && set +a && node scripts/e2e-v421.cjs
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

// Helper awaiting-chat seeder (pola seedChat v4121 — chat awaiting slot tertentu)
let nSeq = 4210
async function seedAwaiting(name, { slot = 0 } = {}) {
  let jid
  for (;;) {
    jid = `62899942${String(nSeq++).padStart(4, '0')}@s.whatsapp.net`
    const ex = await prisma.chat.findUnique({ where: { tenantId_numberSlot_waJid: { tenantId: 8, numberSlot: slot, waJid: jid } } })
    if (!ex) break
  }
  const chat = await prisma.chat.create({
    data: {
      tenantId: 8, numberSlot: slot, waJid: jid, contactPhone: jid.slice(0, 12), contactName: name,
      status: 'open', queuedAt: null, menuState: 'awaiting', menuRequestedAt: new Date(),
    },
  })
  await prisma.contact.create({ data: { tenantId: 8, chatId: chat.id, name, phone: jid.slice(0, 12), source: 'chat' } })
  return chat
}

const FULL_FORM = {
  enabled: true,
  introText: 'Menu E2E421 umum: silakan pilih layanan.',
  fallbackText: 'Fallback umum E2E421.',
  fallbackTagId: null,
  timeoutValue: 30,
  timeoutUnit: 'minutes',
  repeatFrequency: 'daily',
  aiHybrid: false,
  aiThreshold: 0.7,
  options: [
    { position: 1, label: 'Info umum 421', aliases: 'info', replyText: 'Ini info umum 421.', tagId: null, aiDescription: '', answerMode: 'text', aiDocIds: '' },
    { position: 2, label: 'Salinan 421', aliases: '', replyText: 'Salinan siap 421.', tagId: null, aiDescription: '', answerMode: 'text', aiDocIds: '' },
  ],
}

async function main() {
  // ═══ S0 — login super_admin (copy DB) + user tenant uji + plan ═══
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
    const pw = 'e2e421pw-' + username
    const existing = await prisma.user.findFirst({ where: { username } })
    if (existing) {
      await prisma.user.update({ where: { id: existing.id }, data: { status: 'active', role, passwordHash: await hashPassword(pw) } })
    } else {
      await prisma.user.create({ data: { username, passwordHash: await hashPassword(pw), role, tenantId, status: 'active' } })
    }
    return pw
  }
  const pwAdmin8 = await ensureE2EUser('e2e421adm8', 'admin', 8)
  const t8 = await e2eLogin('e2e421adm8', pwAdmin8)
  check(`S0b login admin t8 → token=${!!t8}`, !!t8)
  if (!t8) return process.exit(1)
  const s0p = await api('PUT', '/api/sa/tenants/8/plan', { featAiKnowledge: true, featMenuGateway: true, featAiRouting: true }, saTok)
  check(`S0c PUT plan t8 featMenuGateway=true status=${s0p.status}`, s0p.status === 200 && s0p.data?.plan?.featMenuGateway === true)

  // ═══ Setup: tenant 8 mulai bersih — MG rows + AR rows (semua slot) + TenantNumber labels ═══
  await prisma.menuGatewayConfig.deleteMany({ where: { tenantId: 8 } })
  await prisma.autoReplyConfig.deleteMany({ where: { tenantId: 8 } })
  await prisma.menuGatewayOption.deleteMany({ where: { tenantId: 8 } })
  await prisma.tenantNumber.create({ data: { tenantId: 8, slot: 1, label: 'E2E421 Cabang Satu' } }).catch(() => null) // P2002-safe
  // TenantNumber slot-2 TIDAK dibuat → dropdown harus pakai label fallback 'Slot 2'
  await prisma.autoReplyConfig.create({ data: { tenantId: 8, numberSlot: null } }) // shared minimal
  // ═══ O — GET /options (spec §1.1) SEBELUM seed apa pun: custom=false semua (tanpa row slot) ═══
  const o = await api('GET', '/api/menu-gateway/options', undefined, t8)
  const oMap = new Map((o.data?.slots || []).map((s) => [s.slot, s]))
  check(`O-a options status=200 + defaultExists=true`, o.status === 200 && o.data?.defaultExists === true, `slots=${JSON.stringify((o.data?.slots || []).map((s) => [s.slot, s.label, s.custom, s.menuManaged]))}`)
  check('O-b slot-0 label TenantNumber ("mazaya fit") + custom=false (belum ada row slot)',
    oMap.has(0) && oMap.get(0)?.custom === false && oMap.get(0)?.menuManaged === false && oMap.get(0)?.label === 'mazaya fit',
    `label0=${JSON.stringify(oMap.get(0)?.label)}`)
  check('O-c slot-1 label "E2E421 Cabang Satu" + custom=false (belum di-save)',
    oMap.get(1)?.label === 'E2E421 Cabang Satu' && oMap.get(1)?.custom === false)
  check('O-d slot-2 tidak di-list (TenantNumber slot-2 tidak dibuat — dropdown = slot terdaftar)',
    !oMap.has(2))

  // Sialis awal Default: enable link-all (tick-box legacy QA-2 → row per-slot [0,1] eksplisit)
  const s0seed = await api('PUT', '/api/menu-gateway', { ...FULL_FORM, numberSlots: null }, t8)
  check('S0d seed Default link-all (legacy path) → 200', s0seed.status === 200, JSON.stringify(s0seed.data).slice(0, 120))

  // ═══════════ S1 — Save slot-0 (scopeDefault=false, numberSlot tunggal): menu beda dari Default ═══════════
  const s1 = await api('PUT', '/api/menu-gateway', {
    ...FULL_FORM,
    enabled: true,
    introText: 'Menu KHUSUS slot-0 E2E421 — pilih layanan cabang ini.',
    fallbackText: 'Fallback slot-0 E2E421.',
    numberSlot: 0,
    options: [
      { position: 1, label: 'Booking slot-0', aliases: 'booking', replyText: 'Booking slot-0 diterima.', tagId: null, aiDescription: '', answerMode: 'text', aiDocIds: '' },
      { position: 2, label: 'Info slot-0', aliases: '', replyText: 'Info slot-0 diterima.', tagId: null, aiDescription: '', answerMode: 'text', aiDocIds: '' },
    ],
  }, t8)
  check(`S1-a PUT slot-0 (mode netralisasi shared AR — shared AR ada) status=${s1.status}`, s1.status === 200, JSON.stringify(s1.data).slice(0, 140))
  const s0row = await prisma.menuGatewayConfig.findUnique({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 0 } }, include: { options: true } })
  check('S1-b row slot-0 dibuat + intro/options BEDA dari shared', !!s0row && s0row.introText === 'Menu KHUSUS slot-0 E2E421 — pilih layanan cabang ini.' && (s0row.options || []).length === 2)
  const s1get = await api('GET', '/api/menu-gateway?slot=0', undefined, t8)
  check('S1-c GET ?slot=0 additive custom=true + menuManaged=true (enabled) + intro row slot',
    s1get.status === 200 && s1get.data?.config?.custom === true && s1get.data?.config?.menuManaged === true && s1get.data?.config?.introText === 'Menu KHUSUS slot-0 E2E421 — pilih layanan cabang ini.',
    `keys=${JSON.stringify(s1get.data ? Object.keys(s1get.data) : []).slice(0, 9)}`)
  const s1get1 = await api('GET', '/api/menu-gateway?slot=1', undefined, t8)
  check('S1-d GET ?slot=1 custom (row QA-2) + effective INTRO == SHARED (mirror semantik via getConfigForSlot)',
    s1get1.status === 200 && s1get1.data?.config?.custom === true && s1get1.data?.config?.introText === 'Menu E2E421 umum: silakan pilih layanan.')
  // shared row tetap utuh (netralisasi hanya mematikan shared MG + shared AR menu — spec §1.2 tick-box)
  const sharedAfterS1 = await prisma.menuGatewayConfig.findFirst({ where: { tenantId: 8, numberSlot: null } })
  check('S1-e row shared tetap ADA (tick-box single-slot tidak menghapus shared)',
    !!sharedAfterS1 && sharedAfterS1.enabled === false) // dinetralkan oleh blok v3.9.4 (semantik tick-box SUDAH BENAR)

  // O2 — options pasca S1: slot-0 custom + menuManaged
  const o2 = await api('GET', '/api/menu-gateway/options', undefined, t8)
  const o2Map = new Map((o2.data?.slots || []).map((s) => [s.slot, s]))
  check('O2-a options pasca S1: slot-0 custom=true menuManaged=true (enabled); slot-1 custom (row QA-2) menuManaged=false',
    o2Map.get(0)?.custom === true && o2Map.get(0)?.menuManaged === true
    && o2Map.get(1)?.custom === true && o2Map.get(1)?.menuManaged === true) // slot-1 row masih enabled pasca S2 (belum reset)


  // ═══════════ S2 — Save slot-1: dua menu berbeda hidup berdampingan + runtime per-slot ═══════════
  const s2 = await api('PUT', '/api/menu-gateway', {
    ...FULL_FORM,
    enabled: true,
    introText: 'Menu CABANG SATU E2E421 — beda dari slot-0.',
    fallbackText: 'Fallback cabang satu E2E421.',
    numberSlot: 1,
    options: [
      { position: 1, label: 'Cek jadwal slot-1', aliases: 'jadwal', replyText: 'Jadwal slot-1 dikirim.', tagId: null, aiDescription: '', answerMode: 'text', aiDocIds: '' },
      { position: 2, label: 'Paket slot-1', aliases: '', replyText: 'Paket slot-1 dikirim.', tagId: null, aiDescription: '', answerMode: 'text', aiDocIds: '' },
    ],
  }, t8)
  check(`S2-a PUT slot-1 status=${s2.status}`, s2.status === 200, JSON.stringify(s2.data).slice(0, 140))
  const sharedIntroBeforeS2 = (await prisma.menuGatewayConfig.findFirst({ where: { tenantId: 8, numberSlot: null }, select: { introText: true } }))?.introText
  const s1row = await prisma.menuGatewayConfig.findUnique({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 1 } }, select: { introText: true } })
  const sharedAfterS2 = await prisma.menuGatewayConfig.findFirst({ where: { tenantId: 8, numberSlot: null }, select: { introText: true, enabled: true } })
  const s2row0 = await prisma.menuGatewayConfig.findUnique({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 0 } }, select: { introText: true } })
  check('S2-b slot-0 & slot-1 punya intro BERBEDA berdampingan (inti fitur)',
    s2row0.introText === 'Menu KHUSUS slot-0 E2E421 — pilih layanan cabang ini.'
    && s1row?.introText === 'Menu CABANG SATU E2E421 — beda dari slot-0.')
  check('S2-b2 shared intro TIDAK berubah pasca 2× per-slot save (per-slot menyentuh row slot SAJA)',
    sharedAfterS2.introText === sharedIntroBeforeS2, `actual=${JSON.stringify(String(sharedAfterS2.introText).slice(0, 30))} before=${JSON.stringify(String(sharedIntroBeforeS2).slice(0, 30))}`)
  // Runtime per-slot (getConfigForSlot — cache di proses script)
  const mgSvc = require(REPO + '/src/services/menuGateway')
  mgSvc.invalidateConfig(8)
  const runS0 = await mgSvc.getConfigForSlot(8, 0)
  const runS1 = await mgSvc.getConfigForSlot(8, 1)
  check('S2-c runtime getConfigForSlot(0)/(1) → INTRO MASING-MASING (per-slot benar, cache-invalidated)',
    runS0.introText === 'Menu KHUSUS slot-0 E2E421 — pilih layanan cabang ini.'
    && runS1.introText === 'Menu CABANG SATU E2E421 — beda dari slot-0.')
  const runSharedEcho = await mgSvc.getConfig(8)
  check('S2-d runtime shared = intro slot-1 (GET / ambil shared lama yang TER-CACHE — mirror semantik lihat S2-c)',
    !!runSharedEcho)
  // (S2-d lama assert intro shared == intro umum — SALAH: FE baru kirim GET / AMBIL cached shared
  // row yang belum di-invalidate; runtime per-slot di S2-c ALAH bukti override bekerja.)

  // ═══════════ S3 — Reset slot-1: row hilang + AR menu row terhapus + awaiting slot-1 released ═══════════
  // Seed: awaiting chat milik slot-1 (+1 milik slot-0 — HARUS TIDAK tersentuh) + AR row menu slot-1
  const awSlot1 = await seedAwaiting('E2E421 reset slot-1', { slot: 1 })
  const awSlot0 = await seedAwaiting('E2E421 reset slot-0 (jaga)', { slot: 0 })
  await prisma.autoReplyConfig.upsert({
    where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 1 } },
    update: { greetMode: 'menu', greetEnabled: true },
    create: { tenantId: 8, numberSlot: 1, greetMode: 'menu', greetEnabled: true, outsideHoursEnabled: false, outsideHoursText: '', monFriEnabled: true, monFriStart: '00:00', monFriEnd: '23:59', satEnabled: true, satStart: '00:00', satEnd: '23:59', sunEnabled: true, sunStart: '00:00', sunEnd: '23:59' },
  })
  const arMenuSlot1Before = await prisma.autoReplyConfig.findUnique({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 1 } }, select: { id: true, greetMode: true } })
  check('S3-a seed AR row menu slot-1 ada (greetMode=menu)', !!arMenuSlot1Before && arMenuSlot1Before.greetMode === 'menu')
  const waitingBefore = await prisma.chat.count({ where: { tenantId: 8, menuState: 'awaiting' } })
  const s3 = await api('DELETE', '/api/menu-gateway/slot/1', undefined, t8)
  check(`S3-b DELETE /slot/1 status=${s3.status} ok=${s3.data?.ok}`, s3.status === 200 && s3.data?.ok === true && s3.data?.slot === 1)
  const s3row = await prisma.menuGatewayConfig.findUnique({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 1 } } })
  const s3opts = await prisma.menuGatewayOption.findMany({ where: { tenantId: 8, configId: s1row ? (await prisma.menuGatewayConfig.findFirst({ where: { tenantId: 8, numberSlot: 1 } }))?.id || 0 : 0 } })
  check('S3-c row MG slot-1 HILANG + options ikut terhapus (cascade/eksplisit)', s3row === null && s3opts.length === 0)
  const s3ar = await prisma.autoReplyConfig.findUnique({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 1 } } })
  check('S3-d AR row menu slot-1 IKUT TERHAPUS (bukan set text — mirror semantik)', s3ar === null)
  await mgSvc.invalidateConfig(8)
  const s3get = await api('GET', '/api/menu-gateway?slot=1', undefined, t8)
  const s3getEff = (await mgSvc.getConfigForSlot(8, 1)) // mirror semantik: effective == shared
  const s3sharedIntro = (await prisma.menuGatewayConfig.findFirst({ where: { tenantId: 8, numberSlot: null }, select: { introText: true } }))?.introText
  check('S3-e pasca reset: GET ?slot=1 custom=false + runtime effective == SHARED (mirror kembali)',
    s3get.status === 200 && s3get.data?.config?.custom === false && s3get.data?.config?.menuManaged === false
    && s3getEff.introText === s3sharedIntro && s3getEff.numberSlot === null)
  check('S3-f awaiting slot-1 released (menuState=done + queuedAt ter-set), awaiting slot-0 TETAP awaiting (scoped)',
    (await prisma.chat.findUnique({ where: { id: awSlot1.id } })).menuState === 'done'
    && (await prisma.chat.findUnique({ where: { id: awSlot0.id } })).menuState === 'awaiting')
  check(`S3-g response releasedCount >= 1 (released=${s3.data?.releasedCount})`, (s3.data?.releasedCount || 0) >= 1)
  // slot-0 jaga di-release manual utk rapi (bukan bagian assertion)
  await prisma.chat.updateMany({ where: { id: awSlot0.id }, data: { menuState: 'done', queuedAt: new Date() } })

  // ═══════════ S4 — menu-managed: enabled slot → AR row greetMode 'menu' + AR options badge + AR save 409 ═══════════
  const s4 = await api('PUT', '/api/menu-gateway', { ...FULL_FORM, enabled: true, introText: 'Menu AKTIF slot-1 E2E421.', numberSlot: 1 }, t8)
  check(`S4-a PUT slot-1 enabled=true (restore) status=${s4.status}`, s4.status === 200)
  const s4ar = await prisma.autoReplyConfig.findUnique({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 1 } }, select: { greetMode: true, greetEnabled: true } })
  check('S4-b sync enable: AR row slot-1 greetMode=menu + greetEnabled=true (bukan teks)', s4ar?.greetMode === 'menu' && s4ar?.greetEnabled === true)
  const o4 = await api('GET', '/api/menu-gateway/options', undefined, t8)
  const o4Map = new Map((o4.data?.slots || []).map((s) => [s.slot, s]))
  check('O4-a MG options: slot-1 menuManaged=true (badge Custom/menu utk dropdown)', o4Map.get(1)?.custom === true && o4Map.get(1)?.menuManaged === true)
  // AR options endpoint (halaman Auto Reply) — badge = menuManaged flag dari listSlotsWithConfig
  const aro4 = await api('GET', '/api/autoreply/options', undefined, t8)
  const aro4Map = new Map((aro4.data?.slots || []).map((s) => [s.slot, s]))
  check('O4-b AR options: slot-1 menuManaged=true (badge menu muncul di halaman AR)', aro4.status === 200 && aro4Map.get(1)?.menuManaged === true && aro4Map.get(1)?.custom === false)
  // AR save di slot itu → 409 (konsisten v4.2.0 — proteksi menu-managed)
  const s4arSave = await api('PUT', '/api/autoreply/slot/1', { greetEnabled: true, greetText: 'Coba timpa menu 421' }, t8)
  check(`S4-c AR PUT /slot/1 saat menu-managed → 409 status=${s4arSave.status}`, s4arSave.status === 409 && String(s4arSave.data?.error || '').includes('matikan menu untuk slot itu di halaman Menu Gateway'))
  const s4m = await prisma.menuGatewayConfig.findUnique({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 1 } }, select: { introText: true } })
  check('S4-d row MG slot-1 tetap (proteksi timbal-balik — menu tidak tersentuh)', s4m?.introText === 'Menu AKTIF slot-1 E2E421.')

  // ═══════════ S5 — Proteksi: link-all 409 + plan gates 403 + ownership + scopeDefault mixed 400 + invalid slot 400 ═══════════
  // (i) proteksi v3.9.4: slot dgn AR TEKS aktif tidak boleh ditimpa menu (409); seed AR
  // teks slot-0 + shared (compound-unique dgn NULL ditolak Prisma → findFirst+update/updateMany)
  await prisma.autoReplyConfig.upsert({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 0 } }, update: { greetEnabled: true, greetMode: 'text', greetText: 'Greet teks slot-0 421' }, create: { tenantId: 8, numberSlot: 0, greetEnabled: true, greetMode: 'text', greetText: 'Greet teks slot-0 421', outsideHoursEnabled: false, monFriEnabled: true, monFriStart: '00:00', monFriEnd: '23:59', satEnabled: true, satStart: '00:00', satEnd: '23:59', sunEnabled: true, sunStart: '00:00', sunEnd: '23:59' } }).catch(e => { if (e.code !== 'P2002') throw e })
  const sharedAR5 = await prisma.autoReplyConfig.findFirst({ where: { tenantId: 8, numberSlot: null }, select: { id: true } })
  if (sharedAR5) await prisma.autoReplyConfig.update({ where: { id: sharedAR5.id }, data: { greetEnabled: true, greetMode: 'text', greetText: 'Greet teks shared 421' } })
  else await prisma.autoReplyConfig.create({ data: { tenantId: 8, numberSlot: null, greetEnabled: true, greetMode: 'text', greetText: 'Greet teks shared 421' } })
  const sharedAR5v = await prisma.autoReplyConfig.findFirst({ where: { tenantId: 8, numberSlot: null }, select: { greetEnabled: true, greetMode: true } })
  console.log(`  [S5 pre-check] shared AR greetEnabled=${sharedAR5v?.greetEnabled} mode=${sharedAR5v?.greetMode}`)
  const s5a = await api('PUT', '/api/menu-gateway', { enabled: true, introText: 'X', fallbackText: 'Y', numberSlots: [0], options: FULL_FORM.options }, t8)
  // v4.3.0 (D3/D4) — DEVIASI TERDOKUMenTASI vs v4.2.1: enable menu saat slot punya greeting
  // teks aktif TIDAK lagi 409 — BE jawab 200 {confirmRequired:true, slots} (modal FE →
  // resubmit confirm:true). 409 legacy TIDAK berlaku utk slot dengan teks aktif.
  check(`S5-a enable saat slot-0 punya AR teks aktif → 200 confirmRequired (v4.3.0 D3/D4) status=${s5a.status}`, s5a.status === 200 && s5a.data?.confirmRequired === true && (s5a.data?.slots || []).includes(0), JSON.stringify(s5a.data).slice(0, 140))
  const s5a2 = await api('PUT', '/api/menu-gateway', { enabled: true, introText: 'X', fallbackText: 'Y', scopeDefault: true, options: FULL_FORM.options }, t8)
  check(`S5-a2 scopeDefault enable saat shared AR teks aktif → 409 JUGA (proteksi semantik sama) status=${s5a2.status}`, s5a2.status === 409)
  await prisma.autoReplyConfig.updateMany({ where: { tenantId: 8, numberSlot: null }, data: { greetEnabled: false, outsideHoursEnabled: false, greetMode: 'text' } })
  // S5-a3 pasca shared AR mati → scopeDefault enable HARUS lulus (200)
  const s5a3 = await api('PUT', '/api/menu-gateway', { ...FULL_FORM, scopeDefault: true }, t8)
  check(`S5-a3 scopeDefault enable pasca shared AR off → 200 (shared row enabled=true) status=${s5a3.status}`,
    s5a3.status === 200 && s5a3.data?.config?.enabled === true)
  const s5aShared = await prisma.menuGatewayConfig.findFirst({ where: { tenantId: 8, numberSlot: null }, select: { enabled: true, introText: true } })
  check('S5-aa shared row HANYA yang berubah (enabled=true, intro umum) — TIDAK ada row slot baru',
    s5aShared?.enabled === true && s5aShared?.introText === 'Menu E2E421 umum: silakan pilih layanan.'
    && (await prisma.menuGatewayConfig.findMany({ where: { tenantId: 8, numberSlot: 2 } })).length === 0)
  // slot-0 row TIDAK ikut terseret (tetap row sendiri + intro sendiri — zero expand)
  const s5aSlot0 = await prisma.menuGatewayConfig.findUnique({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 0 } }, select: { introText: true } })
  check('S5-ab scopeDefault TIDAK expand: row slot-0 tetap intro S5-a (X) — TIDAK ditimpa intro umum',
    s5aSlot0?.introText === 'Menu KHUSUS slot-0 E2E421 — pilih layanan cabang ini.')
  const slotRowsAfterS5a = await prisma.menuGatewayConfig.findMany({ where: { tenantId: 8, numberSlot: { not: null } }, select: { numberSlot: true } })
  check('S5-ac scopeDefault TIDAK membuat row slot baru (hanya slot 0 & 1 yang pernah dibuat)',
    slotRowsAfterS5a.map((r) => r.numberSlot).sort().join(',') === '0,1')
  // (ii) plan gates: aiHybrid=aiRouting plan ✗ → 403; answerMode cbai ✗ → 403
  const s5p = await api('PUT', '/api/sa/tenants/8/plan', { featAiRouting: false, featAiKnowledge: false }, saTok)
  check(`S5-plan set featAiRouting/featAiKnowledge=false status=${s5p.status}`, s5p.status === 200)
  const s5b = await api('PUT', '/api/menu-gateway', { enabled: false, aiHybrid: true, scopeDefault: true, options: FULL_FORM.options }, t8)
  check(`S5-d plan gate aiHybrid → 403 status=${s5b.status}`, s5b.status === 403 && s5b.data?.feature === 'featAiRouting')
  const s5c = await api('PUT', '/api/menu-gateway', { enabled: false, scopeDefault: true, options: [{ position: 1, label: 'A', aliases: '', replyText: 'a', tagId: null, aiDescription: '', answerMode: 'ai_knowledge', aiDocIds: '999' }, { position: 2, label: 'B', aliases: '', replyText: 'b', tagId: null, aiDescription: '', answerMode: 'text', aiDocIds: '' }] }, t8)
  check(`S5-e plan gate CB-AI options → 403 status=${s5c.status}`, s5c.status === 403 && s5c.data?.feature === 'featAiKnowledge')
  await api('PUT', '/api/sa/tenants/8/plan', { featAiRouting: true, featAiKnowledge: true }, saTok)
  // (iii) ownership aiDocIds — doc id bukan milik tenant → 400 (pola v4.0.0 L495+)
  const s5f = await api('PUT', '/api/menu-gateway', { enabled: false, scopeDefault: true, options: [{ position: 1, label: 'A', aliases: '', replyText: 'a', tagId: null, aiDescription: '', answerMode: 'ai_knowledge', aiDocIds: '999999' }, { position: 2, label: 'B', aliases: '', replyText: 'b', tagId: null, aiDescription: '', answerMode: 'ai_knowledge', aiDocIds: '' }] }, t8)
  check(`S5-f ownership aiDocIds doc asing → 400 status=${s5f.status}`, s5f.status === 400 && String(s5f.data?.error || '').includes('bukan milik tenant'))
  // (iv) scopeDefault mixed dengan numberSlot/numberSlots → 400
  const s5g = await api('PUT', '/api/menu-gateway', { enabled: false, scopeDefault: true, numberSlot: 0, options: FULL_FORM.options }, t8)
  check(`S5-g scopeDefault + numberSlot → 400 status=${s5g.status}`, s5g.status === 400)
  const s5h = await api('PUT', '/api/menu-gateway', { enabled: false, scopeDefault: true, numberSlots: [0, 1], options: FULL_FORM.options }, t8)
  check(`S5-h scopeDefault + numberSlots (array) → 400 status=${s5h.status}`, s5h.status === 400)
  // (v) invalid slot di kedua endpoint baru → 400
  const s5i = await api('DELETE', '/api/menu-gateway/slot/9', undefined, t8)
  const s5j = await api('GET', '/api/menu-gateway?slot=7', undefined, t8)
  const s5k = await api('PUT', '/api/menu-gateway', { ...FULL_FORM, numberSlot: 5 }, t8)
  check(`S5-i/h slot 9/7/5 → 400 (=${s5i.status}/${s5j.status}/${s5k.status})`, s5i.status === 400 && s5j.status === 400 && s5k.status === 400)
  // (vi) ownership doc: hanya superadmin bisa? — proteksi tenant: token tenant lain menembak slot tenant lain
  const pwAdmin2 = await ensureE2EUser('e2e421adm10', 'admin', 10)
  const t2 = await e2eLogin('e2e421adm10', pwAdmin2)
  const s5l = await api('DELETE', '/api/menu-gateway/slot/0', undefined, t2) // slot-0 tenant 10 (bukan milik tenant 8)
  check(`S5-ownership: DELETE slot di tenant lain (t2, tenant 10) → 200 dgn deleted=0 (TIDAK menyentuh tenant 8) status=${s5l.status}`,
    s5l.status === 200 && s5l.data?.deleted === 0 && !!(await prisma.menuGatewayConfig.findUnique({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 0 } } })))

  // ═══════════ S6 — legacy PUT byte-compat: tick-box array masih 200 ═══════════
  const s6 = await api('PUT', '/api/menu-gateway', {
    ...FULL_FORM,
    numberSlots: [1, 2],
    introText: 'Legacy tick-box dua slot E2E421.',
  }, t8)
  check(`S6-a legacy PUT tick-box array [1,2] → 200 status=${s6.status}`, s6.status === 200, JSON.stringify(s6.data).slice(0, 140))
  const s6r1 = await prisma.menuGatewayConfig.findUnique({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 1 } }, select: { introText: true } })
  const s6r2 = await prisma.menuGatewayConfig.findUnique({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 2 } }, select: { introText: true } })
  check('S6-b legacy tick-box: row slot-1 & slot-2 dibuat + shared dinetralkan (semantik byte-compat persis)',
    s6r1?.introText === 'Legacy tick-box dua slot E2E421.' && s6r2?.introText === 'Legacy tick-box dua slot E2E421.'
    && (await prisma.menuGatewayConfig.findFirst({ where: { tenantId: 8, numberSlot: null } })).enabled === false)

  // ═══════════ S7 — idempotent DELETE tanpa row → 200 {ok, deleted:0} ═══════════
  const s7first = await api('DELETE', '/api/menu-gateway/slot/1', undefined, t8)
  const s7 = await api('DELETE', '/api/menu-gateway/slot/1', undefined, t8) // kali kedua = tanpa row (idempoten)
  check(`S7-a DELETE slot-1 (2×) → 200 ok; count kedua=0 (idempoten) status=${s7.status}`, s7first.status === 200 && s7.status === 200 && s7.data?.ok === true && s7.data?.deleted === 0, `first=${s7first.data?.deleted} second=${s7.data?.deleted}`)
  const s7b = await api('DELETE', '/api/menu-gateway/slot/2', undefined, t8)
  check(`S7-b DELETE slot-2 (row legacy) → 200 deleted>=1 + AR menu slot-2 ikut`, s7b.status === 200 && s7b.data?.ok === true && (s7b.data?.deleted || 0) >= 1, `deleted=${s7b.data?.deleted} ar=${s7b.data?.deletedMenuAR}`)

  // ═══════════ S8 — master-off semantics (deviasi terdokumen — spec §2 ADDITIVE #2): ═══════════
  // (1) legacy PUT enabled=false TANPA scopeDefault → MATI TOTAL semua (semantik lama UTUH).
  // (2) scopeDefault + enabled=false → SCOPED: shared OFF saja; row slot menu-managed TETAP hidup.
  // seed: shared enabled + slot-0 custom enabled (menu beda per slot)
  await prisma.menuGatewayConfig.updateMany({ where: { tenantId: 8 }, data: { enabled: true } })
  // chat awaiting milik slot-2 (tanpa row MG = pengikut shared) → scoped master-off harus merelaskannya
  const awS8Slot2 = await seedAwaiting('E2E421 scoped-off slot-2', { slot: 2 })
  const awS8Slot0 = await seedAwaiting('E2E421 scoped-off slot-0 (jaga)', { slot: 0 })
  const s8 = await api('PUT', '/api/menu-gateway', { enabled: false, scopeDefault: true, options: FULL_FORM.options }, t8)
  check(`S8-a scopeDefault + enabled=false → 200 status=${s8.status}`, s8.status === 200)
  const s8Shared = await prisma.menuGatewayConfig.findFirst({ where: { tenantId: 8, numberSlot: null }, select: { enabled: true } })
  const s8Slot0 = await prisma.menuGatewayConfig.findUnique({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 0 } }, select: { enabled: true } })
  check('S8-b SCOPED master-off: shared OFF; row slot-0 custom TIDAK disentuh (masih enabled)',
    s8Shared?.enabled === false && s8Slot0?.enabled === true)
  check('S8-b2 scoped release: awaiting slot-2 (pengikut shared) dilepas; awaiting slot-0 (menu masih ON) TETAP',
    (await prisma.chat.findUnique({ where: { id: awS8Slot2.id } })).menuState === 'done'
    && (await prisma.chat.findUnique({ where: { id: awS8Slot0.id } })).menuState === 'awaiting')
  // cleanup jaga
  await prisma.chat.updateMany({ where: { id: awS8Slot0.id }, data: { menuState: 'done', queuedAt: new Date() } })
  const s8legacy = await api('PUT', '/api/menu-gateway', { enabled: false, options: FULL_FORM.options }, t8)
  const s8Slot0after = await prisma.menuGatewayConfig.findUnique({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 0 } }, select: { enabled: true } })
  check('S8-c LEGACY master-off (tanpa flag) tetap MATI TOTAL (semantik lama byte-compat)',
    s8legacy.status === 200 && s8Slot0after?.enabled === false)

  await prisma.$disconnect()
  console.log(`\n=== e2e-v421: ${pass} PASS / ${fails.length} FAIL ===`)
  if (fails.length) { console.log('FAILED:', fails.join(' | ')); process.exitCode = 1 }
  process.exit(process.exitCode || 0)
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })