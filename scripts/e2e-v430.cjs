/**
 * E2E v4.3.0 — Greeting Mode Switch (Teks / CB-AI / Menu) + Fix One-Way Door
 * (spec docs/spec-v4.3.0-greeting-mode-switch.md §5 — S1..S8)
 * Jalur copy-DB :5099 (WA_DISABLED=1 + E2E_OK_SEND=1 + E2E_DEBUG_INBOUND=1) — produksi
 * (5047) TIDAK tersentuh. Pola: scripts/e2e-v421.cjs + v4121 (mock LLM).
 *
 * Setup copy-DB (dari repo root — SEMUA struktur ada sejak v4.2.x, zero-migration):
 *   python3 -c "import shutil; shutil.copy('prisma/data/saas-v3.db','/tmp/saas-v3-e2e.db')"
 *   node prisma/seed-ai-rates.js /tmp/saas-v3-e2e.db
 *   PORT=5099 DATABASE_URL=file:/tmp/saas-v3-e2e.db WA_DISABLED=1 E2E_OK_SEND=1 \
 *     E2E_DEBUG_INBOUND=1 node src/server.js &
 *   node scripts/e2e-reset-superadmin.cjs && set -a && . ./.env && set +a && node scripts/e2e-v430.cjs
 */
const REPO = '/home/kanakxxx/.openclaw/workspace/wa-cs-hub-saas-v3'
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:5099'
// KRITIS (lesson v4.1.x): dotenv .env berisi DATABASE_URL PROD → DATABASE_URL dipaksa
// ke copy SETELAH dotenv — seluruh proses satu DB copy (service tidak menembak PROD).
const COPY_DB = 'file:/tmp/saas-v3-e2e.db'
require(REPO + '/node_modules/dotenv').config({ path: REPO + '/.env' })
process.env.DATABASE_URL = COPY_DB
// v4.3.0 lesson — .env produksi berisi WA_DISABLED=0; suite ini memanggil
// maybeAutoReply IN-PROCESS (runtime asli) → WA stub E2E WAJIB override SETELAH dotenv
process.env.WA_DISABLED = '1'
process.env.E2E_OK_SEND = '1'
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

// Helper awaiting-chat seeder (pola seedChat v4121)
let nSeq = 4300
async function seedChat(name, { slot = 0, awaiting = false, lastAutoGreetDate = null } = {}) {
  let jid
  for (;;) {
    jid = `62899943${String(nSeq++).padStart(4, '0')}@s.whatsapp.net`
    const ex = await prisma.chat.findUnique({ where: { tenantId_numberSlot_waJid: { tenantId: 8, numberSlot: slot, waJid: jid } } })
    if (!ex) break
  }
  const chat = await prisma.chat.create({
    data: {
      tenantId: 8, numberSlot: slot, waJid: jid, contactPhone: jid.slice(0, 12), contactName: name,
      status: 'open', queuedAt: awaiting ? null : new Date(),
      ...(awaiting ? { menuState: 'awaiting', menuRequestedAt: new Date() } : {}),
      ...(lastAutoGreetDate ? { lastAutoGreetDate } : {}),
    },
  })
  await prisma.contact.create({ data: { tenantId: 8, chatId: chat.id, name, phone: jid.slice(0, 12), source: 'chat' } })
  return chat
}

async function main() {
  // ═══════════ S0 — login super_admin (copy DB) + user tenant uji + plan ═══════════
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
    const pw = 'e2e430pw-' + username
    const existing = await prisma.user.findFirst({ where: { username } })
    if (existing) {
      await prisma.user.update({ where: { id: existing.id }, data: { status: 'active', role, passwordHash: await hashPassword(pw) } })
    } else {
      await prisma.user.create({ data: { username, passwordHash: await hashPassword(pw), role, tenantId, status: 'active' } })
    }
    return pw
  }
  const pwAdmin8 = await ensureE2EUser('e2e430adm8', 'admin', 8)
  const t8 = await e2eLogin('e2e430adm8', pwAdmin8)
  check(`S0b login admin t8 → token=${!!t8}`, !!t8)
  if (!t8) return process.exit(1)
  const s0p = await api('PUT', '/api/sa/tenants/8/plan', { featAiKnowledge: true, featMenuGateway: true, featAiRouting: true }, saTok)
  check(`S0c PUT plan t8 featMenuGateway/featAiKnowledge=true status=${s0p.status}`, s0p.status === 200 && s0p.data?.plan?.featMenuGateway === true)

  // ═══ Setup: tenant 8 mulai bersih — MG + AR rows (semua slot + shared) + label ═══
  await prisma.menuGatewayConfig.deleteMany({ where: { tenantId: 8 } })
  await prisma.autoReplyConfig.deleteMany({ where: { tenantId: 8 } })
  await prisma.menuGatewayOption.deleteMany({ where: { tenantId: 8 } })
  // v4.3.0 — seed chats kita (prefix 62899943) PUNYA Contact row dgn source='chat' →
  // deleteMany Chat dulu BUKAN kontak (FK) — pola: delete contact child dulu (pola v3911).
  const myChats = await prisma.chat.findMany({ where: { tenantId: 8, waJid: { startsWith: '62899943' } }, select: { id: true } })
  if (myChats.length) {
    // child FK dgn referensi Chat: Message (FK ketat, no-cascade) + Contact + ChatTag/ChatEvent (cascade)
    const ids = myChats.map((c) => c.id)
    await prisma.message.deleteMany({ where: { tenantId: 8, chatId: { in: ids } } })
    await prisma.contact.deleteMany({ where: { tenantId: 8, chatId: { in: ids } } })
    await prisma.chat.deleteMany({ where: { tenantId: 8, id: { in: ids } } })
  }
  await prisma.tenantNumber.create({ data: { tenantId: 8, slot: 1, label: 'E2E430 Cabang Satu' } }).catch(() => null) // P2002-safe
  await prisma.tenantNumber.create({ data: { tenantId: 8, slot: 2, label: 'E2E430 Cabang Dua' } }).catch(() => null) // P2002-safe (v4.3.0 — S5b dropdown flag uji)
  await prisma.autoReplyConfig.create({ data: { tenantId: 8, numberSlot: null } }) // shared minimal

  const FULL_FORM = {
    enabled: true,
    introText: 'Menu E2E430: silakan pilih layanan.',
    fallbackText: 'Fallback E2E430.',
    fallbackTagId: null,
    timeoutValue: 30,
    timeoutUnit: 'minutes',
    repeatFrequency: 'daily',
    aiHybrid: false,
    aiThreshold: 0.7,
    options: [
      { position: 1, label: 'Info 430', aliases: 'info', replyText: 'Info 430 diterima.', tagId: null, aiDescription: '', answerMode: 'text', aiDocIds: '' },
      { position: 2, label: 'Salinan 430', aliases: '', replyText: 'Salinan 430 siap.', tagId: null, aiDescription: '', answerMode: 'text', aiDocIds: '' },
    ],
  }
  const MENU_MINIMAL_ROW = { outsideHoursEnabled: false, outsideHoursText: '', monFriEnabled: true, monFriStart: '00:00', monFriEnd: '23:59', satEnabled: true, satStart: '00:00', satEnd: '23:59', sunEnabled: true, sunStart: '00:00', sunEnd: '23:59' }
  async function arSlotUpsert(slot, data) {
    await prisma.autoReplyConfig.upsert({
      where: { tenantId_numberSlot: { tenantId: 8, numberSlot: slot } },
      update: { ...data },
      create: { tenantId: 8, numberSlot: slot, ...MENU_MINIMAL_ROW, ...data },
    })
  }
  const autoSvc = require(REPO + '/src/services/autoReply')
  const mgSvc = require(REPO + '/src/services/menuGateway')
  autoSvc.invalidateConfig(8); mgSvc.invalidateConfig(8)

  const inHours = (d) => d.getDay() % 6 !== 0 ? d.getUTCHours() + 7 < 17 : false // kasar; dipakai hanya utk konteks
  // WIB helper — jam kerja 00:00–23:59 di semua hari = TIDAK PERNAH outside (runtime slot menu)

  // ═══════════ S1 — teks + outside aktif → switch menu (D2/D3/D4/D6) ═══════════
  await arSlotUpsert(0, { greetEnabled: true, greetMode: 'text', greetText: 'Halo! Ada yang bisa dibantu? (S1)', outsideHoursEnabled: true, outsideHoursText: 'Away text S1 — jam kerja lewat.' })
  autoSvc.invalidateConfig(8); mgSvc.invalidateConfig(8)
  const o1 = await api('GET', '/api/menu-gateway/options', undefined, t8)
  const o1Map = new Map((o1.data?.slots || []).map((s) => [s.slot, s]))
  check('S1-0a D8 flags: slot-0 arTextManaged=true (greeting teks aktif)', o1.status === 200 && o1Map.get(0)?.arTextManaged === true && o1Map.get(0)?.outsideOnly === false, JSON.stringify(o1Map.get(0)))

  // Switch text→menu via Auto Reply segmented control (payload switch-sadar)
  const s1 = await api('PUT', '/api/autoreply/slot/0', { greetMode: 'menu' }, t8)
  check(`S1-a slot teks → menu (200 switched) status=${s1.status}`, s1.status === 200 && s1.data?.switched === true && s1.data?.toMode === 'menu', JSON.stringify(s1.data).slice(0, 120))
  const ar1 = await prisma.autoReplyConfig.findUnique({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 0 } } })
  check('S1-b AR slot-0: greetMode=menu + greetEnabled=true', ar1?.greetMode === 'menu' && ar1?.greetEnabled === true)
  check('S1-c D6: outside-hours slot-0 TIDAK disentuh (masih ON + teks sama)', ar1?.outsideHoursEnabled === true && ar1?.outsideHoursText === 'Away text S1 — jam kerja lewat.')
  const mg1 = await prisma.menuGatewayConfig.findUnique({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 0 } }, include: { options: true } })
  check('S1-d D6: MG row slot-0 on-demand + enabled=true + intro terisi (MG Default tanpa row tenant → schema default v4.3.0)', !!mg1 && mg1.enabled === true && !!mg1.introText && mg1.introText.startsWith('Halo {name}!'), `intro=${JSON.stringify((mg1?.introText || '').slice(0, 60))}`)
  check('S1-e D6: MG options slot-0 KOSONG (admin lengkapi di halaman MG)', (mg1?.options || []).length === 0)
  // MG Default row ada? prefill clone MG Default bila ada — di sini belum ada → runtime default. Seed MG Default sekarang utk uji prefill di slot lain.
  await prisma.autoReplyConfig.updateMany({ where: { tenantId: 8, numberSlot: null }, data: { outsideHoursEnabled: false, greetEnabled: false } })
  autoSvc.invalidateConfig(8); mgSvc.invalidateConfig(8)

  // Runtime koeksistensi (D5 v0.13.0): chat luar jam → away text; chat dalam jam → menu intro.
  // Slot-0 dgn jam kerja PER-DEFCREATE 00:00–23:59 semua hari → tidak pernah outside. Override jam:
  // untuk S1 runtime kita pakai outsideHoursEnabled=true + jam 00:00-00:00 (salah? gunakan jam 09-17 dan simulasi waktu).
  // Runtime time-dependence sulit dikontrol → uji via unit-level maybeAutoReply dengan dbTimestamp manual.
  const chatOut = await seedChat('E2E430 S1 luar-jam', { slot: 0 })
  const chatIn = await seedChat('E2E430 S1 dalam-jam', { slot: 0 })
  const mgSvcSlot = await mgSvc.getConfigForSlot(8, 0)
  check('S1-f runtime MG slot-0 enabled (menu aktif)', !!mgSvcSlot && mgSvcSlot.enabled === true)
  const AR_MIN_HOURS = { monFriEnabled: true, monFriStart: '00:00', monFriEnd: '23:59', satEnabled: true, satStart: '00:00', satEnd: '23:59', sunEnabled: true, sunStart: '00:00', sunEnd: '23:59' }
  // Skenario away: outside = TIDAK dapat menu (guard !outside), away text keluar.
  // Simulasi time-dependence: set jam kerja slot-0 mulai 23:58 → sekarang (≈15:xx WIB) di luar jam → outside=true.
  await prisma.autoReplyConfig.update({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 0 } }, data: { monFriStart: '23:58', monFriEnd: '23:59', satStart: '23:58', satEnd: '23:59', sunStart: '23:58', sunEnd: '23:59' } })
  autoSvc.invalidateConfig(8)
  const out1 = await autoSvc.maybeAutoReply(await prisma.chat.findUnique({ where: { id: chatOut.id }, include: { contact: true } }), { messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: 'halo' } })
  check('S1-g D5 runtime: chat LUAR jam → away text (menu TIDAK menimpa outside)', out1?.sent === true)
  const outMsgs1 = await prisma.message.findMany({ where: { chatId: chatOut.id, direction: 'out', isAuto: true }, orderBy: { id: 'desc' }, take: 2 })
  const { decryptTextSafe } = require(REPO + '/src/services/textCrypto')
  check('S1-h isi away text persis outsideHoursText (outside menang di luar jam)', stringHas(outMsgs1[0]?.content, 'Away text S1'), String(outMsgs1[0] && decryptTextSafe(outMsgs1[0].content)).slice(0, 60))
  // Skenario menu: dalam jam → menu intro (jam 00:00–23:59 = selalu dalam jam)
  await prisma.autoReplyConfig.update({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 0 } }, data: { outHoursReset: undefined, ...MENU_MINIMAL_ROW } })
  autoSvc.invalidateConfig(8)
  const out2 = await autoSvc.maybeAutoReply(await prisma.chat.findUnique({ where: { id: chatIn.id }, include: { contact: true } }), { messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: 'halo' } })
  check('S1-i D5 runtime: chat DALAM jam → menu intro terkirim (menu tetap jalan dgn outside ON)', out2?.sent === true || out2?.msg?.sent === true, JSON.stringify(out2).slice(0, 120))
  const inChatRow = await prisma.chat.findUnique({ where: { id: chatIn.id } })
  check('S1-j menu intro → chat awaiting (dalam jam, menu flow jalan)', inChatRow?.menuState === 'awaiting', `menuState=${inChatRow?.menuState}`)

  // ═══════════ S2 — menu ON → PUT slot outsideHours+jam → 200 (field-scoped D9) ═══════════
  const s2 = await api('PUT', '/api/autoreply/slot/0', { outsideHoursEnabled: true, outsideHoursText: 'Away v4.3 S2.', repeatFrequency: 'daily' }, t8)
  check(`S2-a PUT slot menu-managed field NON-greet → 200 (field-scoped D9) status=${s2.status}`, s2.status === 200 && !s2.data?.switched, JSON.stringify({ s: s2.status, e: s2.data?.error }).slice(0, 120))
  const ar2 = await prisma.autoReplyConfig.findUnique({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 0 } } })
  check('S2-b outsideHours tersimpan + menu row tetap utuh', ar2?.outsideHoursEnabled === true && ar2?.outsideHoursText === 'Away v4.3 S2.' && ar2?.greetMode === 'menu')
  const s2b = await api('PUT', '/api/autoreply/slot/0', { greetText: 'Takeover teks tanpa sadar?' }, t8)
  check(`S2-c takeover greetText TANPA greetMode → tetap 409 (jalur lama) status=${s2b.status}`, s2b.status === 409)

  // ═══════════ S3 — menu→teks: awaiting released + MG row KEEP + outside bisa ON ═══════════
  // Seed: awaiting chats milik slot-0 menu ON + opsi menu + outsideHoursEnabled=false (bersih)
  await prisma.menuGatewayOption.create({ data: { tenantId: 8, configId: mg1.id, position: 1, label: 'Opsi S3', aliases: 's3', replyText: 'Reply S3', aiDescription: '', answerMode: 'text', aiDocIds: '' } })
  autoSvc.invalidateConfig(8); mgSvc.invalidateConfig(8)
  const awS3a = await seedChat('E2E430 S3 awaiting-1', { slot: 0, awaiting: true })
  const awS3b = await seedChat('E2E430 S3 awaiting-2', { slot: 0, awaiting: true })
  const o3 = await api('GET', '/api/menu-gateway/options', undefined, t8)
  const o3Map = new Map((o3.data?.slots || []).map((s) => [s.slot, s]))
  check('S3-0 D8 flags: slot-0 menu ON → arTextManaged=false, managed', o3Map.get(0)?.arTextManaged === false)
  const s3 = await api('PUT', '/api/autoreply/slot/0', { greetMode: 'text' }, t8)
  check(`S3-a menu→teks switch (200 switched) status=${s3.status}`, s3.status === 200 && s3.data?.switched === true && s3.data?.toMode === 'text', JSON.stringify(s3.data).slice(0, 120))
  check(`S3-b releasedCount >= 2 (awaiting slot-0 released, include 2 seeder) released=${s3.data?.releasedCount}`, (s3.data?.releasedCount || 0) >= 2)
  const arS3 = await prisma.autoReplyConfig.findUnique({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 0 } } })
  check('S3-c AR slot-0 → greetMode=text + greetEnabled=true (mode baru aktif)', arS3?.greetMode === 'text' && arS3?.greetEnabled === true)
  const mgS3 = await prisma.menuGatewayConfig.findUnique({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 0 } }, include: { options: true } })
  check('S3-d D5/O2 KEEP: MG row slot-0 masih ADA + enabled=false + options UTUH', !!mgS3 && mgS3.enabled === false && (mgS3.options || []).length === 1)
  check(`S3-e chat awaiting slot-0 → done`, (await prisma.chat.findUnique({ where: { id: awS3a.id } })).menuState === 'done' && (await prisma.chat.findUnique({ where: { id: awS3b.id } })).menuState === 'done')
  // Outside bisa dinyalakan TANPA kunjungi MG (D3 — keluar pintu-satu-arah lama)
  const s3c = await api('PUT', '/api/autoreply/slot/0', { outsideHoursEnabled: false, outsideHoursText: 'Away pasca switch.' }, t8)
  check(`S3-f outside diset di halaman AR pasca menu→teks → 200 (D9) status=${s3c.status}`, s3c.status === 200)

  // ═══════════ S4 — Default scope switch: D7 wajib modal + atomik ═══════════
  // Seed: shared mode menu (default scope) + slot-2 tanpa row (pengikut shared, awaiting)
  await prisma.menuGatewayConfig.deleteMany({ where: { tenantId: 8, numberSlot: 0 } }) // reset slot-0 dulu
  await arSlotUpsert(0, { greetEnabled: false, greetMode: 'text', greetText: '', outsideHoursEnabled: false })
  await prisma.autoReplyConfig.updateMany({ where: { tenantId: 8, numberSlot: null }, data: { greetEnabled: true, greetMode: 'menu', outsideHoursEnabled: false } })
  await prisma.menuGatewayConfig.create({ data: { tenantId: 8, numberSlot: null, enabled: true, introText: 'Menu shared S4.', fallbackText: 'Fallback S4.' } }).catch(async (e) => {
    if (e.code !== 'P2002') throw e
    await prisma.menuGatewayConfig.updateMany({ where: { tenantId: 8, numberSlot: null }, data: { enabled: true, introText: 'Menu shared S4.', fallbackText: 'Fallback S4.' } })
  })
  autoSvc.invalidateConfig(8); mgSvc.invalidateConfig(8)
  const awS4 = await seedChat('E2E430 S4 shared-follower awaiting', { slot: 2, awaiting: true })
  // D7 FE: modal wajib utk scope Default — BE test: payload switch TANPA konfirmasi FE tetap 200 atomik (BE tidak bisa menolak; D7 = FE contract + 409 legacy)
  const s4 = await api('PUT', '/api/autoreply/default', { greetMode: 'cbai' }, t8)
  check(`S4-a default menu→cbai switch (200 switched) status=${s4.status}`, s4.status === 200 && s4.data?.switched === true && s4.data?.scope === 'default' && s4.data?.toMode === 'cbai', JSON.stringify(s4.data).slice(0, 140))
  const shared4 = await prisma.autoReplyConfig.findFirst({ where: { tenantId: 8, numberSlot: null } })
  check('S4-b shared AR → greetMode=cbai (pengikut ikut mode baru)', shared4?.greetMode === 'cbai' && shared4?.greetEnabled === true)
  const sharedRows4 = await prisma.menuGatewayConfig.findMany({ where: { tenantId: 8, numberSlot: null } })
  check('S4-c shared MG → enabled=false KEEP SEMUA row shared (row + intro utuh)', sharedRows4.length >= 1 && sharedRows4.every((r) => r.enabled === false) && sharedRows4.some((r) => r.introText === 'Menu shared S4.'), `rows=${sharedRows4.map((r) => [r.id, r.enabled, String(r.introText).slice(0, 16)])}`)
  check(`S4-d awaiting slot-2 (pengikut shared) released; slot menu sendiri zero-cascade`, (await prisma.chat.findUnique({ where: { id: awS4.id } })).menuState === 'done')
  // Legacy 409 tetap: payload greetText penuh (greetEnabled + greetText) saat shared menu → 409 (byte-compat)
  await prisma.autoReplyConfig.updateMany({ where: { tenantId: 8, numberSlot: null }, data: { greetEnabled: true, greetMode: 'menu' } })
  await prisma.menuGatewayConfig.updateMany({ where: { tenantId: 8, numberSlot: null }, data: { enabled: true } })
  autoSvc.invalidateConfig(8); mgSvc.invalidateConfig(8)
  const s4e = await api('PUT', '/api/autoreply/default', { greetEnabled: true, greetText: 'Takeover teks legacy' }, t8)
  check('S4-e legacy takeover payload (greetText penuh) saat shared menu → tetap 409 (byte-compat)', s4e.status === 409 && String(s4e.data?.error || '').includes('Greeting dikelola Menu Gateway'))

  // ═══════════ S5 — outside-only slot di dropdown MG: selectable + enable 200 TANPA confirm ═══════════
  await prisma.autoReplyConfig.updateMany({ where: { tenantId: 8, numberSlot: null }, data: { greetEnabled: false, greetMode: 'text' } })
  await prisma.menuGatewayConfig.updateMany({ where: { tenantId: 8, numberSlot: null }, data: { enabled: false } })
  await arSlotUpsert(1, { greetEnabled: false, outsideHoursEnabled: true, outsideHoursText: 'Away only S5.' })
  autoSvc.invalidateConfig(8); mgSvc.invalidateConfig(8)
  const o5 = await api('GET', '/api/menu-gateway/options', undefined, t8)
  const o5Map = new Map((o5.data?.slots || []).map((s) => [s.slot, s]))
  check('S5-a D8: slot-1 outside-only → outsideOnly=true (selectable), arTextManaged=false, arManaged back-compat=true', o5Map.get(1)?.outsideOnly === true && o5Map.get(1)?.arTextManaged === false && o5Map.get(1)?.arManaged === true, JSON.stringify(o5Map.get(1)))
  const s5 = await api('PUT', '/api/menu-gateway', { ...FULL_FORM, enabled: true, numberSlot: 1, introText: 'Menu slot-1 S5 (outside coexist).' }, t8)
  check(`S5-b enable menu di slot outside-only → 200 TANPA confirm (D3) status=${s5.status}`, s5.status === 200 && !s5.data?.confirmRequired, JSON.stringify({ s: s5.status, d: s5.data }).slice(0, 140))
  const arS5 = await prisma.autoReplyConfig.findUnique({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 1 } } })
  check('S5-c outside-hours slot-1 TIDAK disentuh (away tetap ON)', arS5?.outsideHoursEnabled === true && arS5?.outsideHoursText === 'Away only S5.')
  const mgS5 = await prisma.menuGatewayConfig.findUnique({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 1 } } })
  check('S5-d MG row slot-1 enabled=true (menu + outside coexist legal)', mgS5?.enabled === true)

  // ═══════════ S5b — slot dgn greeting teks aktif: enable menu → 200 confirmRequired → confirm:true ═══════════
  await arSlotUpsert(2, { greetEnabled: true, greetMode: 'text', greetText: 'Greet teks slot-2 S5b.' , outsideHoursEnabled: false })
  autoSvc.invalidateConfig(8); mgSvc.invalidateConfig(8)
  const o5b = await api('GET', '/api/menu-gateway/options', undefined, t8)
  const o5bMap = new Map((o5b.data?.slots || []).map((s) => [s.slot, s]))
  check('S5b-0 D8: slot-2 arTextManaged=true (dropdown disable + tombol jalan-pintas)', o5bMap.get(2)?.arTextManaged === true, `slot2=${JSON.stringify(o5bMap.get(2))}`)
  const awS5b = await seedChat('E2E430 S5b awaiting teks slot-2', { slot: 2, awaiting: true })
  const s5b1 = await api('PUT', '/api/menu-gateway', { ...FULL_FORM, enabled: true, numberSlot: 2, introText: 'Menu slot-2 S5b.' }, t8)
  check(`S5b-a enable menu slot greeting-teks → 200 {confirmRequired} (BUKAN 409) status=${s5b1.status}`, s5b1.status === 200 && s5b1.data?.confirmRequired === true && Array.isArray(s5b1.data?.slots) && s5b1.data.slots.includes(2), JSON.stringify(s5b1.data).slice(0, 200))
  const ar5bBefore = await prisma.autoReplyConfig.findUnique({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 2 } } })
  check('S5b-b konfirmasi belum dilakukan → greeting teks slot-2 MASIH ON', ar5bBefore?.greetEnabled === true)
  const s5b2 = await api('PUT', '/api/menu-gateway', { ...FULL_FORM, enabled: true, numberSlot: 2, introText: 'Menu slot-2 S5b.', confirm: true }, t8)
  check(`S5b-c re-submit confirm:true → 200 + menu aktif status=${s5b2.status}`, s5b2.status === 200 && !s5b2.data?.confirmRequired, JSON.stringify({ s: s5b2.status, cm: s5b2.data?.confirmRequired, g: s5b2.data?.greetMode }).slice(0, 140))
  const ar5b = await prisma.autoReplyConfig.findUnique({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 2 } } })
  // v4.3.0 D4 semantik: enable menu = greeting milik menu (enableGreetForScope: mode menu +
  // greetEnabled=true utk runtime startFlow) — teks admin DIPERTAHANKAN di greetText (O2 spirit);
  // yang penting greeting teks TIDAK LAGI mengurung menu (arTextManaged=false di options).
  check('S5b-D D4: slot-2 menu owns greeting (mode=menu) + teks admin dipertahankan di greetText', ar5b?.greetMode === 'menu' && (ar5b?.greetText || '').includes('Greet teks slot-2 S5b.'), `mode=${ar5b?.greetMode} text=${JSON.stringify((ar5b?.greetText || '').slice(0, 30))}`)
  check('S5b-e awaiting slot-2 released saat switch-sadar', (await prisma.chat.findUnique({ where: { id: awS5b.id } })).menuState === 'done')

  // ═══════════ S6 — plan ✗ → CB-AI terkunci (pola existing — segmented control) ═══════════
  await api('PUT', '/api/sa/tenants/8/plan', { featAiKnowledge: false }, saTok)
  const s6 = await api('PUT', '/api/autoreply/slot/0', { greetMode: 'cbai' }, t8)
  check(`S6-a slot plan ✗ → CB-AI 403 (plan gate) status=${s6.status}`, s6.status === 403 && String(s6.data?.error || '').includes('ChatBareng AI'))
  const s6b = await api('PUT', '/api/autoreply/default', { greetMode: 'cbai' }, t8)
  check(`S6-b default plan ✗ → CB-AI 403 status=${s6b.status}`, s6b.status === 403)
  await api('PUT', '/api/sa/tenants/8/plan', { featAiKnowledge: true }, saTok)

  // ═══════════ S7 — claim harian: menu pagi → away malam (outside) → tidak dobel ═══════════
  // (pola runtime manual maybeAutoReply — contact.lastMenuShownAt + lastAutoGreetDate marker)
  await prisma.autoReplyConfig.updateMany({ where: { tenantId: 8, numberSlot: null }, data: { greetEnabled: false, greetMode: 'text', outsideHoursEnabled: false } })
  // slot-0: menu aktif + jam 00:00-23:59 (selalu dalam jam) + outside jam 23:58-00:00 (selalu luar)
  await arSlotUpsert(0, { greetEnabled: true, greetMode: 'menu', outsideHoursEnabled: false, ...MENU_MINIMAL_ROW })
  const mg0 = await prisma.menuGatewayConfig.upsert({
    where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 0 } },
    update: {},
    create: { tenantId: 8, numberSlot: 0 },
  })
  await prisma.menuGatewayConfig.update({ where: { id: mg0.id }, data: { enabled: true, introText: 'Menu S7 — pilih 1/2.', fallbackText: 'Fallback S7.' } })
  autoSvc.invalidateConfig(8); mgSvc.invalidateConfig(8)
  const c7 = await seedChat('E2E430 S7 claim', { slot: 0 })
  const m1 = await autoSvc.maybeAutoReply(await prisma.chat.findUnique({ where: { id: c7.id }, include: { contact: true } }), { messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: 'halo pagi' } })
  check('S7-a menu pagi → intro terkirim (sent=true)', m1?.sent === true)
  await prisma.chat.update({ where: { id: c7.id }, data: { menuState: 'done', menuRequestedAt: null, menuOptionId: null } }) // settle menu flow (sudah dijawab)
  // Malam hari yang SAMA → outside → claim marker sudah hari itu → TIDAK dobel.
  // Simulasi "malam hari sama": buat jam kerja lewat (outside) dan force date sama dgn marker.
  const today = new Date(Date.now() + 7 * 3600 * 1000) // WIB today
  const todayStr = new Intl.DateTimeFormat('sv', { timeZone: 'Asia/Jakarta' }).format(today)
  await prisma.autoReplyConfig.update({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 0 } }, data: { monFriStart: '23:58' } })
  autoSvc.invalidateConfig(8)
  const contact7 = await prisma.contact.findUnique({ where: { chatId: c7.id } })
  // marker lastAutoGreetDate sudah ter-set pagi tadi (oleh sendAutoText) — verifikasi:
  const marker7 = (await prisma.chat.findUnique({ where: { id: c7.id } })).lastAutoGreetDate
  check('S7-b claim marker ter-set setelah menu pagi (sumber klaim harian)', marker7 !== null, `marker=${marker7}`)
  const m2 = await autoSvc.maybeAutoReply(await prisma.chat.findUnique({ where: { id: c7.id }, include: { contact: true } }), { messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: 'halo malam' } })
  check('S7-c D10: chat lagi di hari SAMA (marker terpakai) → TIDAK ada auto message kedua', m2?.sent === false)
  const n7 = await prisma.message.count({ where: { chatId: c7.id, direction: 'out', isAuto: true } })
  check(`S7-d total auto message chat-7 = 1 (tidak dobel) count=${n7}`, n7 === 1)
  // claim-harian via lastAutoGreetDate di Chat — cek marker TIDAK di-revert
  const marker7b = (await prisma.chat.findUnique({ where: { id: c7.id } })).lastAutoGreetDate
  check('S7-e marker tetap ter-set (tidak di-reset oleh percobaan kedua)', marker7b === marker7 && marker7 !== null)
  // Reset jam kerja ke penuh (00:00–23:59 — dalam jam) supaya jalur menu aktif lagi.
  // "Besok" disimulasikan dengan chat BARU: state guard startFlow (chat yang pernah
  // diflow tidak pernah dapat menu kedua — invariant §4.2) benar, jadi chat lama tidak
  // akan dapat menu walau marker di-reset. Klaim harian di-uji dgn pelanggan baru.
  await prisma.autoReplyConfig.update({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 0 } }, data: { monFriStart: '00:00', monFriEnd: '23:59', satStart: '00:00', satEnd: '23:59', sunStart: '00:00', sunEnd: '23:59' } })
  autoSvc.invalidateConfig(8)
  const c7b = await seedChat('E2E430 S7 besok (chat baru)', { slot: 0 })
  const m3 = await autoSvc.maybeAutoReply(await prisma.chat.findUnique({ where: { id: c7b.id }, include: { contact: true } }), { messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: 'halo besok' } })
  check('S7-f pelanggan baru besok → dapat menu lagi (klaim per-hari reset 0:00 WIB)', m3?.sent === true)

  // ═══════════ S8 — regresi ringan lokal: legacy jalur + invalid + options flags ═══════════
  // (i) legacy PUT byte-compat (greetMode menu via legacy endpoint masih sync MG)
  await arSlotUpsert(2, { greetEnabled: false, greetMode: 'text', greetText: '', outsideHoursEnabled: false })
  autoSvc.invalidateConfig(8); mgSvc.invalidateConfig(8)
  const s8 = await api('PUT', '/api/autoreply', { numberSlot: 2, greetMode: 'menu' }, t8)
  check(`S8-a legacy PUT slot-2 greetMode=menu → 200 (byte-compat D11) status=${s8.status}`, s8.status === 200, JSON.stringify({ s: s8.status }).slice(0, 100))
  const mgS8 = await prisma.menuGatewayConfig.findUnique({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 2 } } })
  check('S8-b legacy: MG row slot-2 dibuat + enabled=true', !!mgS8 && mgS8.enabled === true)
  // (ii) invalid slot → 400 tetap
  const s8c = await api('PUT', '/api/autoreply/slot/9', { greetMode: 'menu' }, t8)
  check('S8-c slot 9 → 400 tetap', s8c.status === 400)
  // (iii) GET options flags lengkap (D8 + back-compat arManaged)
  const o8 = await api('GET', '/api/menu-gateway/options', undefined, t8)
  const o8Map = new Map((o8.data?.slots || []).map((s) => [s.slot, s]))
  check('S8-d options: arManaged + arTextManaged + outsideOnly di-emit semua slot', o8.status === 200 && [...o8Map.values()].every((s) => 'arManaged' in s && 'arTextManaged' in s && 'outsideOnly' in s))
  // (iv) zero-cascade: slot-1 (menu ON) TIDAK kena switch slot-2
  await prisma.autoReplyConfig.updateMany({ where: { tenantId: 8, numberSlot: 2, greetMode: 'menu' }, data: { greetMode: 'text', greetEnabled: true } })
  autoSvc.invalidateConfig(8)
  const s8e = await api('PUT', '/api/autoreply/slot/2', { greetMode: 'text' }, t8) // bukan menu-managed lagi — upsert biasa
  check(`S8-e slot-2 text save biasa → 200 (custom) status=${s8e.status}`, s8e.status === 200)
  const mgS8e = await prisma.menuGatewayConfig.findUnique({ where: { tenantId_numberSlot: { tenantId: 8, numberSlot: 1 } } })
  check('S8-f zero-cascade: menu slot-1 TIDAK tersentuh (enabled=true)', mgS8e?.enabled === true)

  await prisma.$disconnect()
  console.log(`\n=== e2e-v430: ${pass} PASS / ${fails.length} FAIL ===`)
  if (fails.length) { console.log('FAILED:', fails.join(' | ')); process.exitCode = 1 }
  process.exit(process.exitCode || 0)
}

function stringHas(contentEnc, needle) {
  try {
    const plain = decrypt(contentEnc)
    return plain.includes(needle)
  } catch { return false }
}
function decrypt(contentEnc) {
  return require(REPO + '/src/services/textCrypto').decryptTextSafe(contentEnc)
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })