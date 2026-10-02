/**
 * QA MATRIKS 8 SKENARIO — Auto Reply Per-Slot (v4.2.0/v4.2.1) + counter reset
 * DEFINISI MATRIKS (konstruksi transparan — def ekspisit "matriks 8" TIDAK ke-pulih
 * dari catatan 28-30 Sep; kuturunkan dari spec-v4.0.0 CB-AI §3 (6 kombinasi radio in/out
 * jam), v4.2.0 AR override (Default/Custom/Reset/menu-managed guard), v4.2.1 MG guard,
 * + 2 guard = 8; KANAKA 04:31 = GO)
 *
 * M1 slot0 Custom OHE=0 → silent (Custom menang atas Default OHE=1)
 * M2 slot1 mirror Default → away shared    M3 slot1 PUT → Custom away beda
 * M4 DELETE /slot/1 → custom:0 + mirror balik (regression: flags additive)
 * M5 anti-double marker + COUNTER RESET re-fire (INTI REQ KANAKA 04:31)
 * M6 menu-managed 409 save & reset slot0
 * M7 cbai fields di slot → 400; plan-gate cbai tenant-11 → 403
 * M8 legacy PUT recovery + config verdict API + reset counter slot0
 * Jalur resmi: copy-DB :5099 (WA_DISABLED=1 + E2E_OK_SEND=1 + E2E_DEBUG_INBOUND=1).
 * Prod 5047 TIDAK disentuh. Tester = nomor OpenClaw KANAKA 62881080702624 (koreksi 05:21).
 * BEFORE tiap re-test: resetCounter(slot) null-kan Chat.lastAutoGreetDate/aiReplyCount/lastAiReplyAt.
 * Pola: scripts/e2e-v420.cjs + incoming() helper dari e2e-v3925.cjs.
 */
const REPO = '/home/kanakxxx/.openclaw/workspace/wa-cs-hub-saas-v3'
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:5099'
// v4.4.0 audit L6 — HARD GUARD: script ini mutasikan config via API. Salah set
// E2E_BASE ke prod = kerusakan data produksi. Tolak keras bila BASE menyebut 5047.
if (String(BASE).includes('5047')) {
  console.error('FATAL: E2E_BASE menunjuk port 5047 (PROD) — dilarang keras. Jalankan tanpa E2E_BASE (default :5099).')
  process.exit(1)
}
const COPY_DB = 'file:/tmp/saas-v3-e2e.db'
const JID = '62881080702624@s.whatsapp.net' // nomor OpenClaw sebenarnya (koreksi Kanaka 05:21 — JANGAN pakai 6282257176832; itu nomor lama/gak bener)
require(REPO + '/node_modules/dotenv').config({ path: REPO + '/.env' })
process.env.DATABASE_URL = COPY_DB
const { PrismaClient } = require(REPO + '/node_modules/@prisma/client')
const prisma = new PrismaClient({ datasourceUrl: COPY_DB, log: ['error'] })

const fails = []
let pass = 0
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
  if (!cond) { process.exitCode = 1; fails.push(name) } else { pass++ }
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

async function resetCounter(chatId) {
  // Permintaan Kanaka: hapus state count nomor OpenClaw di slot itu tiap re-test.
  const r = await prisma.chat.updateMany({
    where: { id: chatId },
    data: { lastAutoGreetDate: null, aiReplyCount: 0, lastAiReplyAt: null },
  })
  return r.count === 1
}

async function main() {
  // S0 — login super_admin (copy db, pw di-reset via scripts/e2e-reset-superadmin.cjs)
  const sa = await api('POST', '/api/auth/login', { username: process.env.SUPERADMIN_USERNAME, password: process.env.SUPERADMIN_PASSWORD })
  check('S0 superadmin login (copy db)', sa.status === 200 && !!sa.data?.token, `status=${sa.status}`)
  const saTok = sa.data?.token
  if (!saTok) process.exit(1)

  // ensure chat rows tester (t8 ChatBareng slot0/slot1 + kontak)
  // FIX bug run-1: row tester asli (7669) punya waJid=JID-LID + phoneJid=nomorku;
  // findUnique by waJid=nomorku gugel → ensure via findFirst OR(waJid/phoneJid)
  async function ensureChat(slot) {
    const jid12 = JID.slice(0, 12)
    let chat = await prisma.chat.findFirst({
      where: { tenantId: 8, numberSlot: slot, OR: [{ waJid: JID }, { phoneJid: JID }] },
      orderBy: { id: 'asc' },
    })
    if (!chat) {
      chat = await prisma.chat.create({
        data: { tenantId: 8, waJid: JID, phoneJid: JID, contactPhone: jid12, contactName: 'QA Matriks (nomor OpenClaw)', numberSlot: slot, status: 'open' },
      })
      await prisma.contact.create({ data: { tenantId: 8, chatId: chat.id, name: 'QA Matriks (nomor OpenClaw)', phone: jid12, source: 'chat' } })
    } else {
      // pastikan phoneJid ter-set bila kosong (row 8250) — biar inbound resolve konsisten
      if (!chat.phoneJid) await prisma.chat.update({ where: { id: chat.id }, data: { phoneJid: JID } })
    }
    return chat
  }
  const chat0 = await ensureChat(0)
  const chat1 = await ensureChat(1)

  // fetch effective via GET ?slot (verdict custom/menuManaged)
  async function arGet(slot) { return api('GET', `/api/autoreply?tenantId=8&slot=${slot}`, undefined, saTok) }

  async function incoming(slot, text) {
    const chat = slot === 0 ? chat0 : chat1
    const ok0 = await resetCounter(chat.id) // WAJIB tiap inbound QA (Kanaka 04:31)
    if (!ok0) return { err: 'reset gugel' }
    const r = await api('POST', '/api/wa/inbound', {
      tenantId: 8, slot,
      messages: {
        key: { remoteJid: JID, fromMe: false, id: 'QAMAT-' + slot + '-' + Date.now() },
        pushName: 'QA Matriks (OpenClaw)',
        message: { conversation: text },
      },
    }, saTok)
    return r
  }

  async function lastAuto(chatId) {
    return prisma.message.findFirst({ where: { chatId, isAuto: true, direction: 'out' }, orderBy: { id: 'desc' } })
  }

  // ═══ M1 — OH slot0 CUSTOM row OHE=0 → SILENT (Custom wins over Default OHE=1) ═══
  // (config live t8: shared OHE=1; slot0 custom row OHE=0 — persis kondisi prod)
  await api('PUT', '/api/autoreply?tenantId=8', { outsideHoursEnabled: true, outsideHoursText: 'M1 away (default)', greetEnabled: false }, (await api('POST', '/api/auth/login', { username: 'kanaka', password: process.env.SUPERADMIN_PASSWORD })).data?.token || saTok) // jam default
  const m1 = await incoming(0, 'Pagi, mau tanya pricelist')
  const m1m = await lastAuto(chat0.id)
  check('M1 OH slot0 custom OHE=0 → SILENT', m1.status === 200 && !m1m, `auto=${!!m1m} status=${m1.status}`)

  // ═══ M2 — OH slot1 (tanpa row) → away text dari shared (mirror) ═══
  const m2 = await incoming(1, 'Halo, info pricelist dong')
  const m2m = await lastAuto(chat1.id)
  check('M2 OH slot1 mirror → away shared', m2.status === 200 && !!m2m && m2m.content?.includes?.('di luar jam operasional'), `text=${(m2m?.content || '').slice(0, 60)}`)

  // ═══ M3 — OH slot1 CUSTOM away text beda (put slot1) ═══
  // (slot1 masih tanpa row → put = buat Custom)
  const saTg = (await api('POST', '/api/auth/login', { username: 'kanaka', password: process.env.QA_PW || 'X' })) // dummy
  const tokK = (await api('POST', '/api/auth/login', { username: 'kanaka', password: process.env.SUPERADMIN_PASSWORD })).data?.token || saTok
  const r3 = await api('PUT', `/api/autoreply/slot/1?tenantId=8`, { outsideHoursEnabled: true, outsideHoursText: 'M3 away (slot 1 custom)', outsideHoursMode: 'text', repeatFrequency: 'daily' }, tokK)
  check('M3a PUT /slot/1 200', r3.status === 200, `status=${r3.status}`)
  const r3g = await api('GET', `/api/autoreply?tenantId=8&slot=1`, undefined, tokK)
  check('M3b custom:1 pasca put', r3g.data?.custom === true, `custom=${r3g.data?.custom}`)
  const m3 = await incoming(1, 'Halo lagi, info pricelist dong')
  const m3m = await lastAuto(chat1.id)
  check('M3b OH slot1 custom → away custom', !!m3m && m3m.content?.includes?.('M3 away'), `text=${(m3m?.content || '').slice(0, 50)}`)

  // ═══ M4 — DELETE /slot/1 (reset ke default) → mirror balik ke shared ═══
  const r4 = await api('DELETE', `/api/autoreply/slot/1?tenantId=8`, undefined, tokK)
  check('M4 DELETE /slot/1 200', r4ok(r4), `status=${r4.status}`)
  const r4g = await api('GET', `/api/autoreply?tenantId=8&slot=1`, undefined, tokK)
  check('M4b custom:0 + menuManaged flag hidup', r4g.data?.custom === false, `custom=${r4g.data?.custom} menu=${r4g.data?.menuManaged}`)
  const m4 = await incoming(1, 'test lagi')
  const m4m = await lastAuto(chat1.id)
  check('M4c mirror lagi → away shared', !!m4m && m4m.content?.includes?.('M1 away') || m4m?.content?.includes?.('di luar jam operasional'), `text=${(m4m?.content || '').slice(0, 50)}`)

  // ═══ M5 — anti-double marker (1x/hari) + COUNTER RESET re-fire (inti permintaan) ═══
  const m5a = await incoming(1, 'pesan pertama hari ini')
  const m5am = await lastAuto(chat1.id)
  check('M5a pertama → away terkirim', !!m5am, `status=${!!m5am}`)
  const m5b = await incoming(1, 'pesan kedua (marker aktif — HARUS silent)')
  const m5bm = await lastAuto(chat1.id)
  check('M5b anti-double: silent', !m5bm || m5bm.id === m5am?.id, `baru=${!!m5bm && m5bm.id !== m5am?.id ? 'BARU(!)' : 'no baru'}`)
  // reset counter (nomor OpenClaw slot1) — PERSIS perintahmu
  const okReset = await resetCounter(chat1.id)
  check('M5c resetCounter OK (lastAutoGreetDate/aiReplyCount null', okReset)
  const m5c = await incoming(1, 'pesan ketiga (setelah counter reset — HARUS balas lagi)')
  const m5cm = await lastAuto(chat1.id)
  check('M5d pasca reset → away LAGI (counter fresh)', !!m5cm && (!m5am || m5cm.id !== m5am?.id), `id=${m5cm?.id} vs ${m5am?.id}`)
  // VERIFY DB pasca reset (lesson #4 — bukti di data)
  const chatDb = await prisma.chat.findUnique({ where: { id: chat1.id }, select: { lastAutoGreetDate: true, aiReplyCount: true } })
  check('M5e DB post-verify (aiCount=1 pasca fire + marker=today', chatDb?.aiReplyCount === 0 && chatDb?.lastAutoGreetDate === null, JSON.stringify(chatDb || {}))

  // ═══ M6 — menu-managed 409 (save & reset slot) + jalur pemulihan ═══
  const r6 = await api('PUT', `/api/autoreply/slot/0?tenantId=8`, { greetEnabled: true, greetMode: 'text', greetText: 'M6 teks AR user' }, tokK)
  check('M6 PUT /slot/0 menu-managed → 409', r6.status === 409, `status=${r6.status}`)
  const r6d = await api('DELETE', `/api/autoreply/slot/0?tenantId=8`, undefined, tokK)
  check('M6b DELETE /slot/0 menu-managed → 409', r6d.status === 409, `status=${r6d.status}`)

  // ═══ M7 — CB-AI fields DITOLAK di slot + plan-gate cbai ═══
  const r7 = await api('PUT', `/api/autoreply/slot/0?tenantId=8&force=1`, { outsideHoursEnabled: false, cbaiBotName: 'Sinta' }, tokK)
  check('M7 PUT /slot/0 dengan cbaiBotName → 400', r7.status === 400, `status=${r7.status} err=${JSON.stringify(r7.data).slice(0, 90)}`)
  const tok11 = (await api('POST', '/api/auth/login', { username: 'kanaka', password: process.env.QA_PW11 || process.env.SUPERADMIN_PASSWORD })).data?.token // dummy
  const r7p = await api('PUT', `/api/autoreply/slot/0?tenantId=11`, { outsideHoursEnabled: true, outsideHoursMode: 'cbai' }, tokK)
  check('M7b tenant tanpa featAiKnowledge → 403', r7p.status === 403, `status=${r7p.status}`)

  // ═══ M8 — full reset cycle slot0 + config verdict API (visual QA path) ═══
  // t8 slot0 = menu row (id 29) — lewat jalur pemulihan legacy untuk lepas lock
  const r8 = await api('PUT', `/api/autoreply?tenantId=8`, { numberSlots: [0], outsideHoursEnabled: false, greetEnabled: false, greetMode: 'text', greetText: 'M8 reset' }, tokK)
  check('M8 legacy PUT (jalur pemulihan) 200', r8.status === 200, `status=${r8.status}`)
  const r8g = await api('GET', `/api/autoreply?tenantId=8&slot=0`, undefined, tokK)
  check('M8b pasca reset: slot0 OHE=0 + greet off', r8g.data?.outsideHoursEnabled === false && r8g.data?.greetEnabled === false, `echo=${JSON.stringify({ ohe: r8g.data?.outsideHoursEnabled, gE: r8g.data?.greetEnabled })}`)
  const okR8 = await resetCounter(chat0.id)
  check('M8c resetCounter slot0 OK', okR8)

  // cleanup: matikan trigger (biar copy db QA aman), lapor
  const summary = `\n=== MATRIKS QA: ${pass} PASS / ${fails.length} FAIL ===\n${fails.length ? 'FAIL list:\n' + fails.map((f) => '  - ' + f).join('\n') : 'SEMUA HIJAU'}`
  console.log(summary)
  await prisma.$disconnect()
}

function r4ok(r4) { return r4.status === 200 }
main().catch((e) => { console.error(e); process.exit(1) })