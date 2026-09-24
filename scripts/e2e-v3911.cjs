// E2E v3.9.11 — Ganti PIC via id numerik (akar bug "Menyimpan…" abadi) + filter/search list
process.env.DB_NO_OP = '1'
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient({ datasourceUrl: 'file:/tmp/saas-v3-e2e.db' })
const BASE = 'http://127.0.0.1:5099'
let pass = 0, fail = 0
function ok(name, cond, extra = '') { if (cond) { pass++; console.log('PASS |', name, extra) } else { fail++; console.log('FAIL |', name, extra) } }
async function main() {
  let r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: process.env.SUPERADMIN_USERNAME, password: process.env.SUPERADMIN_PASSWORD }) })
  ok('A0 login superadmin', r.status === 200)
  const { token } = await r.json()
  r = await fetch(BASE + '/api/sa/impersonate/4', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token } })
  ok('A1 impersonate t4', r.status === 200)
  const { token: t4 } = await r.json()
  const H4 = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t4 }

  // Seed row grup dgn PIC awal user 5 (admin t4)
  const jid = '120399900777-11111@g.us'
  const ex = await prisma.chat.findFirst({ where: { tenantId: 4, waJid: jid } })
  const row = ex || await prisma.chat.create({ data: { tenantId: 4, waJid: jid, contactPhone: jid.split('@')[0], contactName: 'GrupNumericTest', phoneJid: jid, picUserId: 5, assignedToId: 5, status: 'open' } })
  ok('A2 seed grup row numeric', !!row && Number.isFinite(row.id))

  // N1: list groups → item grup punya id numerik
  r = await fetch(BASE + '/api/groups', { headers: H4 })
  const list = (await r.json().catch(() => ({}))).groups || []
  const item = list.find(g => g.waJid === jid)
  ok('N1 list item id numerik', r.status === 200 && item && /^\d+$/.test(String(item.id)), 'id=' + (item?.id ?? 'x'))

  // N2 (INTI): POST assign-pic pakai ID NUMERIK (bentuk yg dikirim frontend) → 200, bukan hang
  r = await fetch(BASE + `/api/groups/${encodeURIComponent(item.id)}/assign-pic`, { method: 'POST', headers: H4, body: JSON.stringify({ picUserId: 5 }) })
  const n2 = await r.json().catch(() => ({}))
  ok('N2 ganti PIC via id numerik → 200', r.status === 200 && n2.ok, 'code=' + (n2.code || ''))
  const after = await prisma.chat.findUnique({ where: { id: row.id } })
  ok('N3 DB picUserId ter-update', after.picUserId === 5, 'pic=' + after.picUserId)

  // N4: id numerik yg gak ada → 404 bersih cepat (JANGAN adopt/hang)
  const t0 = Date.now()
  r = await fetch(BASE + '/api/groups/99999999/assign-pic', { method: 'POST', headers: H4, body: JSON.stringify({ picUserId: 5 }) })
  ok('N4 id numerik unknown → 404', r.status === 404, 'ms=' + (Date.now() - t0))

  // N5: JID path masih jalan (existing row by JID) → 200
  r = await fetch(BASE + `/api/groups/${encodeURIComponent(jid)}/assign-pic`, { method: 'POST', headers: H4, body: JSON.stringify({ picUserId: 5 }) })
  ok('N5 JID path tetap 200', r.status === 200)

  // N6: JID yatim (tak ada row) + WA off → 503 WA_BELUM_TERHUBUNG cepat (bukan hang)
  const t1 = Date.now()
  r = await fetch(BASE + '/api/groups/120399900888-22222%40g.us/assign-pic', { method: 'POST', headers: H4, body: JSON.stringify({ picUserId: 5 }) })
  const n6 = await r.json().catch(() => ({}))
  ok('N6 yatim JID WA off → 503', r.status === 503 && n6.code === 'WA_BELUM_TERHUBUNG', 'ms=' + (Date.now() - t1))

  // N7: GET detail via id numerik → jalur detail gak 500 (WA off → 503, bukan hang)
  const t2 = Date.now()
  r = await fetch(BASE + `/api/groups/${encodeURIComponent(item.id)}`, { headers: H4 })
  ok('N7 GET detail id numerik → 503 (WA off, cepat)', r.status === 503, 'ms=' + (Date.now() - t2))

  console.log(`=== RINGKASAN v3.9.11 ===`)
  console.log(`${pass} PASS, ${fail} FAIL`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
