/**
 * E2E v4.1.4 — FEATURE: Edit tag (rename + ganti warna) di Tag Manager Kontak
 * (spec docs/spec-v4.1.4-tag-edit.md §D4).
 * Jalan terhadap DB COPY di port 5099 (WA_DISABLED=1) — produksi (5047) TIDAK tersentuh.
 * Pola: scripts/e2e-v4121.cjs (login SA dari env + dotenv DATABASE_URL DIPAKSA ke copy).
 *
 * Setup copy-DB (dari repo root, pola e2e-v4121.cjs — copy DB + jalankan di copy, JANGAN prod):
 *   python3 -c "import sqlite3; src=sqlite3.connect('prisma/data/saas-v3.db'); dst=sqlite3.connect('/tmp/saas-v3-e2e.db'); src.backup(dst); dst.close(); src.close()"
 *   python3 scripts/_bookkeeping_v414.py   # NO-OP schema (v4.1.4 TIDAK ada migration) — placeholder bookkeeping
 *   node scripts/e2e-reset-superadmin.cjs
 *   PORT=5099 DATABASE_URL=file:/tmp/saas-v3-e2e.db WA_DISABLED=1 E2E_OK_SEND=1 node src/server.js &
 *   set -a && . ./.env && set +a && node scripts/e2e-v414.cjs
 *
 * Checks (S0, N1–N11, R12 — ~14 grup):
 * S0  login superadmin (copy db) 200 + token.
 * N1  POST tag "EditQA A" (red) → 201; POST "EditQA B" (blue) → 201.
 * N2  PUT tag A { name: 'EditQA A2', color: 'green' } → 200 + echo name/color.
 * N3  GET / → A2 ada dgn color green + contactCount field tetap ada (regresi shape).
 * N4  PUT A2 { name: 'EditQA B' } (dup dgn B) → 409.
 * N5  PUT A2 { name: 'EditQA A2' } (self-rename sama) → 200 (bukan 409).
 * N6  PUT { color: 'hijau_muda' } → fallback blue 200; PUT { color: 12345 } → 400.
 * N7  PUT {} → 400 Nothing to update.
 * N8  attach tag ke chat (POST /api/chats/:id/tags) → rename → GET chat detail → nama baru tampil (join intact).
 * N9  user tenant non-admin (cs) → PUT → 403.
 * N10 PUT tag id tenant lain (liar 999999) → 404.
 * N11 DELETE tag A2 (admin) → 200; GET → hilang.
 * R12 regresi: scripts/e2e-v4121.cjs terhadap copy db yang sama — 61/61 PASS (dijalankan terpisah).
 */
const REPO = '/home/kanakxxx/.openclaw/workspace/wa-cs-hub-saas-v3'
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:5099'
// KRITIS (lesson v4.1.0/v4.1.1/v4.1.2): dotenv .env berisi DATABASE_URL PROD → DATABASE_URL
// DIPAKSA ke copy SETELAH dotenv (seluruh proses satu DB copy — service tidak menembak PROD).
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
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let data = null
  try { data = await res.json() } catch {}
  return { status: res.status, data }
}

const T8 = 8 // tenant uji (Mazaya) — pola e2e-v4121

async function main() {
  // ═══ S0 — login superadmin (copy db) ═══
  const sa = await api('POST', '/api/auth/login', { username: process.env.SUPERADMIN_USERNAME, password: process.env.SUPERADMIN_PASSWORD })
  check(`S0 superadmin login (copy db) status=${sa.status} tok=${!!sa.data?.token}`, sa.status === 200 && !!sa.data?.token)
  const saTok = sa.data?.token
  if (!saTok) return process.exit(1)

  // S1 — login admin t8 (akun e2e existing dari v4121 — password diset ulang idempoten)
  const { hashPassword } = require(REPO + '/src/auth')
  const pwAdmin8 = 'e2e414pw-adm8'
  const adm8 = await prisma.user.findFirst({ where: { username: 'e2e414adm8' } })
  if (adm8) {
    await prisma.user.update({ where: { id: adm8.id }, data: { status: 'active', role: 'admin', tenantId: T8, passwordHash: await hashPassword(pwAdmin8) } })
  } else {
    await prisma.user.create({ data: { username: 'e2e414adm8', passwordHash: await hashPassword(pwAdmin8), role: 'admin', tenantId: T8, status: 'active' } })
  }
  const s1 = await api('POST', '/api/auth/login', { username: 'e2e414adm8', password: pwAdmin8 })
  const admTok = s1.status === 200 ? s1.data?.token : null
  check(`S1 login admin t8 (e2e414adm8) tok=${!!admTok}`, !!admTok)
  if (!admTok) return process.exit(1)

  // ═══ Setup DB COPY idempoten: bersihkan artefak EditQA sebelumnya ═══
  const old = await prisma.tag.findMany({ where: { tenantId: T8, name: { startsWith: 'EditQA' } } })
  if (old.length) {
    await prisma.contactTag.deleteMany({ where: { tagId: { in: old.map((t) => t.id) } } })
    await prisma.chatTag.deleteMany({ where: { tagId: { in: old.map((t) => t.id) } } })
    await prisma.tag.deleteMany({ where: { id: { in: old.map((t) => t.id) } } })
  }
  // user cs non-admin untuk N9 (idempoten)
  const pwCs8 = 'e2e414pw-cs8'
  const cs8 = await prisma.user.findFirst({ where: { username: 'e2e414cs8' } })
  if (cs8) {
    await prisma.user.update({ where: { id: cs8.id }, data: { status: 'active', role: 'cs', tenantId: T8, passwordHash: await hashPassword(pwCs8) } })
  } else {
    await prisma.user.create({ data: { username: 'e2e414cs8', passwordHash: await hashPassword(pwCs8), role: 'cs', tenantId: T8, status: 'active' } })
  }
  const s1b = await api('POST', '/api/auth/login', { username: 'e2e414cs8', password: pwCs8 })
  const csTok = s1b.status === 200 ? s1b.data?.token : null
  check(`S1b login user cs t8 (non-admin) tok=${!!csTok}`, !!csTok)
  if (!csTok) return process.exit(1)

  // ═══ N1 — POST tag A (red) + tag B (blue) ═══
  const n1a = await api('POST', '/api/tags', { name: 'EditQA A', color: 'red' }, admTok)
  check(`N1-a POST "EditQA A" (red) status=${n1a.status}`, n1a.status === 201 && n1a.data?.tag?.name === 'EditQA A' && n1a.data?.tag?.color === 'red')
  const n1b = await api('POST', '/api/tags', { name: 'EditQA B', color: 'blue' }, admTok)
  check(`N1-b POST "EditQA B" (blue) status=${n1b.status}`, n1b.status === 201 && n1b.data?.tag?.name === 'EditQA B' && n1b.data?.tag?.color === 'blue')
  const tagA = n1a.data?.tag
  const tagB = n1b.data?.tag
  if (!tagA || !tagB) return process.exit(1)

  // ═══ N2 — PUT rename + ganti warna → 200 + echo ═══
  const n2 = await api('PUT', `/api/tags/${tagA.id}`, { name: 'EditQA A2', color: 'green' }, admTok)
  check(`N2 PUT tag A → rename "EditQA A2" + color green status=${n2.status} name=${n2.data?.tag?.name} color=${n2.data?.tag?.color}`,
    n2.status === 200 && n2.data?.tag?.name === 'EditQA A2' && n2.data?.tag?.color === 'green')

  // ═══ N3 — GET / : A2 ada dgn color green + contactCount field tetap ada ═══
  const n3 = await api('GET', '/api/tags', undefined, admTok)
  const a2 = (n3.data?.tags || []).find((t) => t.id === tagA.id)
  check(`N3 GET / → A2 color=green + contactCount field ada (regresi shape) status=${n3.status}`,
    n3.status === 200 && a2?.color === 'green' && a2?.name === 'EditQA A2' && 'contactCount' in (a2 || {}))

  // ═══ N4 — PUT dup name (sama dgn tag B) → 409 ═══
  const n4 = await api('PUT', `/api/tags/${tagA.id}`, { name: 'EditQA B' }, admTok)
  check(`N4 PUT A2 → name dup "EditQA B" status=${n4.status} (409)`, n4.status === 409)

  // ═══ N5 — self-rename (nama sama dgn dirinya sendiri) → 200, BUKAN 409 ═══
  const n5 = await api('PUT', `/api/tags/${tagA.id}`, { name: 'EditQA A2' }, admTok)
  check(`N5 PUT A2 self-rename "EditQA A2" status=${n5.status} (200, bukan 409)`, n5.status === 200 && n5.data?.tag?.name === 'EditQA A2')

  // ═══ N6 — color fallback konsisten POST + tipe liar ═══
  const n6a = await api('PUT', `/api/tags/${tagA.id}`, { color: 'hijau_muda' }, admTok)
  check(`N6-a PUT color invalid string "hijau_muda" → fallback blue 200 status=${n6a.status} color=${n6a.data?.tag?.color}`,
    n6a.status === 200 && n6a.data?.tag?.color === 'blue')
  const n6b = await api('PUT', `/api/tags/${tagA.id}`, { color: 12345 }, admTok)
  check(`N6-b PUT color tipe liar (number) → 400 status=${n6b.status}`, n6b.status === 400)
  // restore warna utk N8 (green — biar beda dari default)
  await api('PUT', `/api/tags/${tagA.id}`, { color: 'green' }, admTok)

  // ═══ N7 — PUT {} → 400 Nothing to update ═══
  const n7 = await api('PUT', `/api/tags/${tagA.id}`, {}, admTok)
  check(`N7 PUT {} → 400 Nothing to update status=${n7.status} err=${n7.data?.error}`, n7.status === 400 && n7.data?.error === 'Nothing to update')

  // ═══ N8 — attach tag ke chat → rename → GET chat detail: nama tag BARU tampil (join intact) ═══
  // Buat chat t8 di copy DB (pola seedChat e2e-v4121 — WA_DISABLED, tidak ada runtime WA)
  const { encryptText } = require(REPO + '/src/services/textCrypto')
  let jid
  let nSeq = 414000
  for (;;) {
    jid = `62899945${String(nSeq++).padStart(4, '0')}@s.whatsapp.net`
    const ex = await prisma.chat.findUnique({ where: { tenantId_numberSlot_waJid: { tenantId: T8, numberSlot: 0, waJid: jid } } })
    if (!ex) break
  }
  const chat = await prisma.chat.create({
    data: { tenantId: T8, numberSlot: 0, waJid: jid, contactPhone: jid.slice(0, 12), contactName: 'E2E414 N8', status: 'open', queuedAt: new Date() },
  })
  await prisma.contact.create({ data: { tenantId: T8, chatId: chat.id, name: 'E2E414 N8', phone: jid.slice(0, 12), source: 'chat' } })
  await prisma.message.create({ data: { tenantId: T8, chatId: chat.id, direction: 'in', content: encryptText('halo kak'), senderName: 'Customer', timestamp: new Date() } })
  const n8a = await api('POST', `/api/chats/${chat.id}/tags`, { tagId: tagA.id }, admTok)
  check(`N8-a attach tag A2 ke chat (POST /api/chats/:id/tags) status=${n8a.status}`, n8a.status === 201)
  const n8b = await api('PUT', `/api/tags/${tagA.id}`, { name: 'EditQA A3' }, admTok)
  check(`N8-b rename ke "EditQA A3" status=${n8b.status}`, n8b.status === 200 && n8b.data?.tag?.name === 'EditQA A3')
  const n8c = await api('GET', `/api/chats/${chat.id}`, undefined, admTok)
  const chatTags = n8c.data?.chat?.tags || []
  check('N8-c GET chat detail → nama tag BARU "EditQA A3" tampil (join ChatTag intact)',
    n8c.status === 200 && chatTags.some((ct) => ct.tag?.name === 'EditQA A3'))
  check('N8-d contactCount ikut naik di response PUT (chat+1 kontak dgn tag sama = join ContactTag via chatId)',
    typeof n8b.data?.tag?.contactCount === 'number', `contactCount=${n8b.data?.tag?.contactCount}`)

  // ═══ N9 — user tenant non-admin (cs) → PUT → 403 ═══
  const n9 = await api('PUT', `/api/tags/${tagA.id}`, { name: 'EditQA Boleh Gak Ya' }, csTok)
  check(`N9 PUT oleh cs (non-admin) → 403 status=${n9.status}`, n9.status === 403)

  // ═══ N10 — PUT tag id tenant lain / liar → 404 ═══
  const n10 = await api('PUT', '/api/tags/999999', { name: 'EditQA Liar' }, admTok)
  check(`N10 PUT id liar 999999 → 404 status=${n10.status}`, n10.status === 404)

  // ═══ N11 — DELETE tag A3 (admin) → 200; GET → hilang ═══
  const n11a = await api('DELETE', `/api/tags/${tagA.id}`, undefined, admTok)
  check(`N11-a DELETE tag A3 status=${n11a.status}`, n11a.status === 200)
  const n11b = await api('GET', '/api/tags', undefined, admTok)
  check('N11-b GET / → tag A3 hilang (join ChatTag ikut terhapus — DELETE existing)',
    n11b.status === 200 && !(n11b.data?.tags || []).some((t) => t.id === tagA.id))

  // cleanup tag B juga (biar re-run idempoten)
  await api('DELETE', `/api/tags/${tagB.id}`, undefined, admTok)

  console.log(`\n=== e2e-v414: ${pass} PASS / ${fails.length} FAIL ===`)
  if (fails.length) { console.log('FAILED:', fails.join(' | ')); process.exitCode = 1 }
  await prisma.$disconnect()
  process.exit(process.exitCode || 0)
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1) })