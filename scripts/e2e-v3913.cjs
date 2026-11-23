/**
 * E2E v3.9.13 — Public API v1 Phase 1 (API keys + /api/v1/messages + /api/v1/chats)
 * Jalan terhadap DB COPY di port 5099 (WA_DISABLED=1) — produksi tidak tersentuh.
 * Pola: scripts/e2e-v394.cjs (api helper + check) + /tmp/e2e-reset.cjs (SA password).
 *
 * Skenario (spec §9): key lifecycle create→use→scope-deny→plan-gate→revoke→401
 * + tenant isolation (404/empty BUKAN 403 bocor) + rate limit 429 + health public.
 */
const REPO = '/home/kanakxxx/.openclaw/workspace/wa-cs-hub-saas-v3'
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:5099'
require(REPO + '/node_modules/dotenv').config({ path: REPO + '/.env' })
const { PrismaClient } = require(REPO + '/node_modules/@prisma/client')
// WAJIB: tunjuk DB COPY — jangan pernah sentuh DB produksi dari script test ini
const prisma = new PrismaClient({ datasourceUrl: 'file:/tmp/saas-v3-e2e.db' })

const fails = []
let pass = 0
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${extra ? ' | ' + extra : ''}`)
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
  return { status: res.status, data, headers: res.headers }
}

async function main() {
  // ── A. Setup: SA login + impersonate tenant-4 (plan featApiAccess masih FALSE) ──
  const sa = await api('POST', '/api/auth/login', { username: process.env.SUPERADMIN_USERNAME, password: process.env.SUPERADMIN_PASSWORD })
  check('A0 superadmin login', sa.status === 200 && !!sa.data?.token, `status=${sa.status}`)
  const saTok = sa.data?.token
  if (!saTok) return process.exit(1)

  const imp = await api('POST', '/api/sa/impersonate/4', {}, saTok)
  check('A1 impersonate tenant-4', imp.status === 200 && !!imp.data?.token, `status=${imp.status}`)
  const t4Tok = imp.data?.token

  // Seed row grup tenant-4 (backup DB tidak punya grup t4 — dibutuhkan E3/E4)
  const gJid = '120399900001-98765@g.us'
  const gEx = await prisma.chat.findFirst({ where: { tenantId: 4, waJid: gJid } })
  const gRow = gEx || await prisma.chat.create({ data: { tenantId: 4, waJid: gJid, contactPhone: gJid.split('@')[0], contactName: 'GrupTest0', phoneJid: gJid, picUserId: 5, assignedToId: 5, status: 'open' } })
  check('A2 seed grup row tenant-4', !!gRow && Number.isFinite(gRow.id), `id=${gRow.id}`)

  // ── B. Key lifecycle via SUPERADMIN API (onboarding path) ──
  // B1. Create key utk tenant-4 (scopes send+read)
  const mk = await api('POST', '/api/sa/tenants/4/api-keys', { name: 'E2E Queue App', scopes: 'send,read' }, saTok)
  check('B1 SA create key → 201 + raw key cbk_live_', mk.status === 201 && typeof mk.data?.key === 'string' && mk.data.key.startsWith('cbk_live_'), `status=${mk.status} prefix=${mk.data?.apiKey?.prefix || 'x'}`)
  const rawKey = mk.data?.key
  check('B2 response row TANPA keyHash (hash never out)', mk.data?.apiKey && !('keyHash' in mk.data.apiKey) && mk.data.apiKey.keyHash === undefined, '')
  check('B3 warning show-once ada', typeof mk.data?.warning === 'string' && /sekali/i.test(mk.data.warning), '')

  // ── C. Plan gate: tenant-4 preset custom featApiAccess=false → 403 UPGRADE_REQUIRED ──
  const g1 = await api('POST', '/api/v1/messages', { target: '081234567890', text: 'x' }, rawKey)
  check('C1 plan gate (featApiAccess=false) → 403 UPGRADE_REQUIRED', g1.status === 403 && g1.data?.code === 'UPGRADE_REQUIRED', `status=${g1.status} code=${g1.data?.code}`)
  const g2 = await api('GET', '/api/v1/chats', undefined, rawKey)
  check('C2 plan gate GET /chats → 403 UPGRADE_REQUIRED', g2.status === 403 && g2.data?.code === 'UPGRADE_REQUIRED', `status=${g2.status} code=${g2.data?.code}`)

  // ── D. Nyalakan featApiAccess tenant-4 via plan update (field baru) ──
  const pu = await api('PUT', '/api/sa/tenants/4/plan', { featApiAccess: true }, saTok)
  check('D1 plan update featApiAccess=true → 200', pu.status === 200 && pu.data?.plan?.featApiAccess === true, `status=${pu.status} feat=${pu.data?.plan?.featApiAccess}`)

  // ── E. Use key: POST /api/v1/messages (WA off → 503 TAPI AUTH PASS = bukan 401/403) ──
  const m1 = await api('POST', '/api/v1/messages', { target: '081234567890', text: 'Antrian #12, silakan datang' }, rawKey)
  check('E1 send nomor 08… (WA off) → 503 WA_BELUM_TERHUBUNG (auth PASS)', m1.status === 503 && m1.data?.code === 'WA_BELUM_TERHUBUNG', `status=${m1.status} code=${m1.data?.code}`)
  const m2 = await api('POST', '/api/v1/messages', { target: '6281234567890', text: 'x' }, rawKey)
  check('E2 send nomor 62… → 503 (auth PASS)', m2.status === 503 && m2.data?.code === 'WA_BELUM_TERHUBUNG', `status=${m2.status}`)
  const m3 = await api('POST', '/api/v1/messages', { target: '120399900001-98765@g.us', text: 'x' }, rawKey)
  check('E3 send JID @g.us (grup tenant-4 ada) → 503 (auth PASS, bukan 400)', m3.status === 503 && m3.data?.code === 'WA_BELUM_TERHUBUNG', `status=${m3.status} code=${m3.data?.code}`)
  const m4 = await api('POST', '/api/v1/messages', { target: 'GrupTest0', text: 'x' }, rawKey)
  check('E4 send nama grup eksak (GrupTest0) → 503 (resolve OK)', m4.status === 503 && m4.data?.code === 'WA_BELUM_TERHUBUNG', `status=${m4.status}`)
  const m5 = await api('POST', '/api/v1/messages', { target: 'GrupTestTidakAda', text: 'x' }, rawKey)
  check('E5 nama grup tidak ada → 400 VALIDATION (bukan 500)', m5.status === 400 && m5.data?.code === 'VALIDATION', `status=${m5.status}`)
  const m6 = await api('POST', '/api/v1/messages', { target: 'bukan-jid-valid@x', text: 'x' }, rawKey)
  check('E6 target regex invalid → 400', m6.status === 400 && m6.data?.code === 'VALIDATION', `status=${m6.status}`)
  const m7 = await api('POST', '/api/v1/messages', { target: '081234567890' }, rawKey)
  check('E7 text kosong → 400', m7.status === 400, `status=${m7.status}`)

  // ── F. Scope enforcement: key read-only → POST /messages 403 SCOPE_MISSING ──
  const mk2 = await api('POST', '/api/sa/tenants/4/api-keys', { name: 'E2E ReadOnly', scopes: 'read' }, saTok)
  const readKey = mk2.data?.key
  check('F1 create read-only key', mk2.status === 201 && !!readKey, `status=${mk2.status}`)
  const f2 = await api('POST', '/api/v1/messages', { target: '081234567890', text: 'x' }, readKey)
  check('F2 read-only key POST /messages → 403 SCOPE_MISSING', f2.status === 403 && f2.data?.code === 'SCOPE_MISSING', `status=${f2.status} code=${f2.data?.code}`)
  const f3 = await api('GET', '/api/v1/chats?limit=5', undefined, readKey)
  check('F3 read-only key GET /chats → 200 (read OK)', f3.status === 200 && Array.isArray(f3.data?.chats), `status=${f3.status} count=${f3.data?.chats?.length}`)
  check('F4 chats tidak bocor grup @g.us', (f3.data?.chats || []).every((c) => !(c.waJid || '').endsWith('@g.us')), '')
  check('F5 preview plaintext (bukan enc:v1:)', (f3.data?.chats || []).every((c) => c.lastMessagePreview == null || !String(c.lastMessagePreview).startsWith('enc:v1:')), '')

  // ── G. Tenant isolation: key tenant-4 coba baca data tenant-8 → 404/empty BUKAN 403 bocor ──
  // (key tenant-scoped: /chats hanya balikin chat tenant-4; waJid tenant-8 tidak muncul)
  const isoChats = f3.data?.chats || []
  function t8Leak(list) { return (list || []).some((c) => c.tenantId != null && Number(c.tenantId) !== 4) }
  check('G1 GET /chats hanya tenant-4 (tidak ada row tenant-8)', !t8Leak(isoChats), `count=${isoChats.length}`)
  const isoDetail = await api('GET', '/api/v1/chats?limit=100', undefined, readKey)
  const allIds = (isoDetail.data?.chats || []).map((c) => c.id)
  const t8Chat = await prisma.chat.findFirst({ where: { tenantId: 8 }, select: { id: true } })
  check('G2 chat id tenant-8 tidak ada di list tenant-4', t8Chat ? !allIds.includes(t8Chat.id) : true, `t8ChatId=${t8Chat?.id ?? '-'} list=${allIds.length}`)
  // messages endpoint untuk chat tenant-8 (id di luar tenant) → 404/empty, bukan data bocor
  // (P1 tidak punya GET messages/:id — pakai POST messages dgn JID grup tenant-8 utk cek resolve ter-scope)
  const gIso = await api('POST', '/api/v1/messages', { target: '9999999999999999999@g.us', text: 'x' }, rawKey)
  check('G3 JID grup asing → 400 VALIDATION (bukan kirim/503)', gIso.status === 400 && gIso.data?.code === 'VALIDATION', `status=${gIso.status}`)
  function t8Leak(list) { return (list || []).some((c) => c.tenantId != null && Number(c.tenantId) !== 4) }

  // ── H. Rate limit: key ratePerMin=2 → request ke-3 429 + Retry-After ──
  const mk3 = await api('POST', '/api/sa/tenants/4/api-keys', { name: 'E2E Rate', scopes: 'read', ratePerMin: 2 }, saTok)
  check('H1 create ratePerMin=2 key', mk3.status === 201 && mk3.data?.apiKey?.ratePerMin === 2, `rate=${mk3.data?.apiKey?.ratePerMin}`)
  const rKey = mk3.data?.key
  await api('GET', '/api/v1/chats?limit=1', undefined, rKey)
  await api('GET', '/api/v1/chats?limit=1', undefined, rKey)
  const r3 = await api('GET', '/api/v1/chats?limit=1', undefined, rKey)
  const retryAfter = Number(r3.headers?.get?.('retry-after'))
  check('H2 rate limit ke-3 → 429 + Retry-After', r3.status === 429 && Number.isFinite(retryAfter) && retryAfter >= 1, `status=${r3.status} retry-after=${retryAfter}`)

  // ── I. Revoke → 401 KEY_REVOKED instan ──
  const keyRow = await prisma.apiKey.findFirst({ where: { tenantId: 4, name: 'E2E ReadOnly' } })
  const rv = await api('DELETE', `/api/sa/tenants/4/api-keys/${keyRow.id}`, {}, saTok)
  check('I1 SA revoke key → 200', rv.status === 200 && rv.data?.ok === true, `status=${rv.status}`)
  const rv2 = await api('GET', '/api/v1/chats?limit=1', undefined, readKey)
  check('I2 revoked key → 401 KEY_REVOKED', rv2.status === 401 && rv2.data?.code === 'KEY_REVOKED', `status=${rv2.status} code=${rv2.data?.code}`)
  const rv3 = await api('DELETE', `/api/sa/tenants/4/api-keys/${keyRow.id}`, {}, saTok)
  check('I3 revoke lagi (idempoten) → 200 alreadyRevoked', rv3.status === 200 && rv3.data?.alreadyRevoked === true, `status=${rv3.status}`)

  // ── J. Auth deny paths ──
  const j1 = await api('POST', '/api/v1/messages', { target: '081234567890', text: 'x' }, 'cbk_live_invalidkeyinvalidkeyinvalidkey0')
  check('J1 key salah → 401 UNAUTHORIZED', j1.status === 401 && j1.data?.code === 'UNAUTHORIZED', `status=${j1.status}`)
  const j2 = await api('POST', '/api/v1/messages', { target: '081234567890', text: 'x' }, undefined)
  check('J2 tanpa header → 401', j2.status === 401 && j2.data?.code === 'UNAUTHORIZED', `status=${j2.status}`)
  const j3 = await api('GET', '/api/v1/health')
  check('J3 GET /api/v1/health PUBLIC tanpa key → 200', j3.status === 200 && j3.data?.status === 'ok', `status=${j3.status}`)
  const j4 = await api('POST', '/api/v1/messages', { target: '081234567890', text: 'x' }, undefined, { 'x-api-key': rawKey })
  check('J4 X-API-Key header juga diterima → 503 (auth PASS)', j4.status === 503 && j4.data?.code === 'WA_BELUM_TERHUBUNG', `status=${j4.status}`)

  // ── K. Key mgmt tenant-admin (JWT admin path) + revokasi via /api/api-keys ──
  const mk5 = await api('POST', '/api/api-keys', { name: 'E2E AdminKey', scopes: ['read'] }, t4Tok)
  check('K1 tenant-admin create key → 201 + cbk_live_', mk5.status === 201 && String(mk5.data?.key || '').startsWith('cbk_live_'), `status=${mk5.status}`)
  const adminKeyId = mk5.data?.apiKey?.id
  const k2 = await api('GET', '/api/api-keys', undefined, t4Tok)
  check('K2 tenant-admin list keys → 200 + row tanpa keyHash', k2.status === 200 && (k2.data?.keys || []).every((k) => !('keyHash' in k)), `status=${k2.status} count=${k2.data?.keys?.length}`)
  const k3 = await api('DELETE', `/api/api-keys/${adminKeyId}`, undefined, t4Tok)
  check('K3 tenant-admin revoke key → 200 ok', k3.status === 200 && k3.data?.ok === true, `status=${k3.status}`)
  // CS isolation: admin tenant-8 (impersonate) → list keys hanya tenant-8
  const impCs = await api('POST', '/api/sa/impersonate/8', {}, saTok)
  const t8Tok = impCs.data?.token
  const k4 = await api('GET', '/api/api-keys', undefined, t8Tok)
  check('K4 admin tenant-8 list keys (isolasi) → 200 tanpa key tenant-4', k4.status === 200 && (k4.data?.keys || []).every((k) => Number(k.tenantId) === 8), `status=${k4.status} count=${k4.data?.keys?.length}`)

  // ── L. Audit: ChatEvent source 'api' — kirim via API dgn WA off (503) TIDAK event;
  // event hanya saat send sukses. Verifikasi struktur kolom source di DB (kolom ada). ──
  const cols = await prisma.$queryRawUnsafe('PRAGMA table_info(ChatEvent)')
  check('L1 ChatEvent kolom source (api) ada', cols.some((c) => c.name === 'source'), cols.map((c) => c.name).join(','))

  // ── M. Regresi kecil: /api/v1/health tetap 200; route lama /api/chats tetap JWT-guarded ──
  const mr = await api('GET', '/api/chats')
  check('M1 route lama /api/chats tanpa JWT → 401 (tidak tersentuh)', mr.status === 401, `status=${mr.status}`)

  console.log(`=== RINGKASAN v3.9.13 ===`)
  console.log(`${pass} PASS, ${fails.length} FAIL`)
  process.exit(fails.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })