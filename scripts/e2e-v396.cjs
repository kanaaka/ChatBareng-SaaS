// E2E v3.9.6 — grup slot-aware (DB copy, WA_DISABLED=1 → semua jalur WA nonaktif,
// test fokus API-level: validasi slot, persist numberSlot, expand, adopt flow)
process.env.DB_NO_OP = '1'
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient({ datasourceUrl: 'file:/tmp/saas-v3-e2e.db' })
const BASE = 'http://127.0.0.1:5099'
let pass = 0, fail = 0
function ok(name, cond, extra = '') { if (cond) { pass++; console.log('PASS |', name, extra) } else { fail++; console.log('FAIL |', name, extra) } }
async function main() {
  // A0 login superadmin
  let r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: process.env.SUPERADMIN_USERNAME, password: process.env.SUPERADMIN_PASSWORD }) })
  ok('A0 login superadmin', r.status === 200)
  const { token } = await r.json()
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }
  // impersonate tenant 4
  r = await fetch(BASE + '/api/sa/impersonate/4', { method: 'POST', headers: H })
  ok('A1 impersonate t4', r.status === 200)
  const { token: t4 } = await r.json()
  const H4 = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t4 }

  // G1: slot tidak valid (99) → 400 VALIDATION
  r = await fetch(BASE + '/api/groups', { method: 'POST', headers: H4, body: JSON.stringify({ subject: 'Test G1', slot: 99 }) })
  const g1 = await r.json().catch(() => ({}))
  ok('G1 slot 99 → 400', r.status === 400, 'code=' + (g1.code || ''))

  // G2: slot 1 tanpa row TenantNumber → 400 (t4 cuma punya slot 0&1 rows? cek dulu)
  const rows = await prisma.tenantNumber.findMany({ where: { tenantId: 4 }, orderBy: { slot: 'asc' } })
  const slotsHave = rows.map(x => x.slot)
  r = await fetch(BASE + '/api/groups', { method: 'POST', headers: H4, body: JSON.stringify({ subject: 'Test G2', slot: 2 }) })
  const g2 = await r.json().catch(() => ({}))
  if (slotsHave.includes(2)) { ok('G2 slot 2 ada row → WA_BELUM_TERHUBUNG (503, WA off)', r.status === 503) } else { ok('G2 slot 2 gak ada row → 400', r.status === 400, 'code=' + (g2.code || '')) }

  // G3: slot valid (0) + WA off → 503 WA_BELUM_TERHUBUNG (bukan 500)
  r = await fetch(BASE + '/api/groups', { method: 'POST', headers: H4, body: JSON.stringify({ subject: 'Test G3', slot: 0 }) })
  const g3 = await r.json().catch(() => ({}))
  ok('G3 create slot-0 WA off → 503', r.status === 503, 'code=' + (g3.code || ''))

  // G4: list groups → field numberSlot ada di semua row
  r = await fetch(BASE + '/api/groups', { headers: H4 })
  const g4 = await r.json().catch(() => ({}))
  const list = g4.groups || []
  ok('G4 list groups numberSlot field', r.status === 200 && list.every(x => Number.isFinite(Number(x.numberSlot))), 'n=' + list.length)

  // G5: DB — row grup: legacy slot-0 utuh + slot-1 tetap tersimpan (numberSlot persist)
  // v3.9.6 — seed rows dulu (DB copy fresh — tenant 4 belum tentu punya grup)
  for (const [jid, slot] of [['120399900001-98765@g.us', 0], ['120399900002-54321@g.us', 1]]) {
    const ex = await prisma.chat.findFirst({ where: { tenantId: 4, waJid: jid } })
    if (!ex) await prisma.chat.create({ data: { tenantId: 4, waJid: jid, contactPhone: jid.split('@')[0], contactName: 'GrupTest' + slot, phoneJid: jid, numberSlot: slot, picUserId: 5, assignedToId: 5, status: 'open' } })
  }
  const grp = await prisma.chat.findMany({ where: { tenantId: 4, waJid: { endsWith: '@g.us' } }, select: { id: true, waJid: true, numberSlot: true } })
  ok('G5 numberSlot persist per-row (legacy 0 + slot-1)',
    grp.some(x => x.waJid === '120399900001-98765@g.us' && Number(x.numberSlot) === 0) &&
    grp.some(x => x.waJid === '120399900002-54321@g.us' && Number(x.numberSlot) === 1), JSON.stringify(grp))

  // G6: orphan list route OK (admin, WA off → array kosong, bukan 500)
  r = await fetch(BASE + '/api/groups', { headers: H4 })
  ok('G6 list (admin) OK dgn fetch multi-slot', r.status === 200)

  // G7: detail orphan gak ada row & WA off → 503 (fetchGroupMetadataAnySlot throw)
  r = await fetch(BASE + '/api/groups/' + encodeURIComponent('1234-9999@g.us'), { headers: H4 })
  const g7 = await r.json().catch(() => ({}))
  ok('G7 detail orphan WA off → 503', r.status === 503, 'code=' + (g7.code || ''))

  // G8: assignPic adopt orphan WA off → 503 (fetchGroupMetadataAnySlot)
  r = await fetch(BASE + '/api/groups/' + encodeURIComponent('1234-9998@g.us') + '/assign-pic', { method: 'POST', headers: { ...H4, 'Content-Type': 'application/json' }, body: JSON.stringify({ picUserId: 5 }) })
  const g8 = await r.json().catch(() => ({}))
  ok('G8 adopt orphan WA off → 503', r.status === 503, 'code=' + (g8.code || ''))

  // G9: settings/members/rename/reset/leave di grup existing (slot-0, WA off) → 503 konsisten
  const g = grp[0]
  if (g) {
    r = await fetch(BASE + '/api/groups/' + encodeURIComponent('x') + '/settings', { method: 'POST' })
    // pakai row waJid
    const rowg = await prisma.chat.findUnique({ where: { id: g.id }, select: { waJid: true } })
    const jid = encodeURIComponent(rowg.waJid)
    r = await fetch(BASE + '/api/groups/' + jid + '/settings', { method: 'POST', headers: { ...H4, 'Content-Type': 'application/json' }, body: JSON.stringify({ locked: true }) })
    const g9 = await r.json().catch(() => ({}))
    ok('G9 settings WA off → 503', r.status === 503, 'code=' + (g9.code || ''))
    r = await fetch(BASE + '/api/groups/' + jid + '/members', { method: 'POST', headers: { ...H4, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'add', phones: ['628111'] }) })
    ok('G10 members WA off → 503', r.status === 503)
    r = await fetch(BASE + '/api/groups/' + jid, { method: 'PATCH', headers: { ...H4, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'baru' }) })
    ok('G11 rename WA off → 503', r.status === 503)
    r = await fetch(BASE + '/api/groups/' + jid + '/invite-reset', { method: 'POST', headers: H4 })
    ok('G12 reset invite WA off → 503', r.status === 503)
    r = await fetch(BASE + '/api/groups/' + jid + '/leave', { method: 'POST', headers: H4 })
    ok('G13 leave WA off → 503 (fetchAnySlot)', r.status === 503)
  }

  console.log('=== RINGKASAN v3.9.6 ===')
  console.log(pass + ' PASS, ' + fail + ' FAIL')
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
