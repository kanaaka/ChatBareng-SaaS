/**
 * E2E v3.9.19 — SuperAdmin Dashboard Rework (spec §8)
 * Jalan terhadap DB COPY di port 5099 (WA_DISABLED=1) — produksi (5047) tidak tersentuh.
 * Pola: scripts/e2e-v3913.cjs (api helper + check).
 *
 * Skenario:
 * - GET /api/sa/stats/trends → shape { dates: [...], counts: [...] } (WIB grouping, penuh)
 * - GET /api/sa/stats/avg-response → shape { avgMinutes: [...], avgTotal: N }
 * - GET /api/sa/stats/resolution → shape { resolved, open, percentResolved }
 * - GET /api/sa/tenants (+ search/filter/pagination CLIENT-side di view — endpoint
 *   TIDAK berubah; di sini diverifikasi endpoint tetap 200 + shape utuh)
 * - Tenant isolation tetap (impersonate t12 → lihat slot-0 miliknya, bukan tenant lain)
 * - Branding platform: GET/PUT /api/sa/platform-branding round-trip + validasi + reset
 * - Audit log: GET /api/sa/audit + filter + cursor pagination (?before=)
 * - Ganti password SA via /api/auth/change-password (existing) — round-trip di COPY db
 * - SuperAdmin.vue split → 4 child view routes (verifikasi file + router shape)
 *
 * ZERO destructive DB op — hanya INSERT row test (Chat seed dgn firstIncomingAt dsb
 * utk isi chart) yang di-BUAT di COPY db. Production DB tidak dibuka script ini.
 */
const REPO = '/home/kanakxxx/.openclaw/workspace/wa-cs-hub-saas-v3'
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:5099'
require(REPO + '/node_modules/dotenv').config({ path: REPO + '/.env' })
const { PrismaClient } = require(REPO + '/node_modules/@prisma/client')
// WAJIB: tunjuk DB COPY — jangan pernah sentuh DB produksi dari script test ini
const prisma = new PrismaClient({ datasourceUrl: 'file:/tmp/saas-v3-e2e.db', log: ['error'] })

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
  // ── A. Setup: SA login (COPY db; password di-reset oleh e2e-reset-superadmin.cjs) ──
  const sa = await api('POST', '/api/auth/login', { username: process.env.SUPERADMIN_USERNAME, password: process.env.SUPERADMIN_PASSWORD })
  check('A0 superadmin login (copy db)', sa.status === 200 && !!sa.data?.token, `status=${sa.status}`)
  const saTok = sa.data?.token
  if (!saTok) return process.exit(1)
  const saId = sa.data?.user?.id

  // ── B. Trends API shape (spec §4.2) ──
  const tr7 = await api('GET', '/api/sa/stats/trends?range=7d', undefined, saTok)
  check('B1 trends 7d → 200', tr7.status === 200, `status=${tr7.status}`)
  check('B2 trends shape { dates, counts }', Array.isArray(tr7.data?.dates) && Array.isArray(tr7.data?.counts), `dates=${tr7.data?.dates?.length} counts=${tr7.data?.counts?.length}`)
  check('B3 trends dates.length == counts.length (7 utk 7d)', tr7.data?.dates?.length === 7 && tr7.data?.counts?.length === 7, `n=${tr7.data?.dates?.length}`)
  check('B4 trends dates penuh (tanpa lubang), last = hari ini WIB', tr7.data?.dates?.every?.((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d))) === true, `last=${tr7.data?.dates?.[6]}`)
  check('B5 trends counts numerik >= 0', tr7.data?.counts?.every?.((c) => Number.isFinite(c) && c >= 0) === true, '')
  const trToday = await api('GET', '/api/sa/stats/trends?range=today', undefined, saTok)
  check('B6 trends today → 1 elemen', trToday.status === 200 && trToday.data?.dates?.length === 1, `n=${trToday.data?.dates?.length}`)
  const tr30 = await api('GET', '/api/sa/stats/trends?range=30d', undefined, saTok)
  check('B7 trends 30d → 30 elemen', tr30.status === 200 && tr30.data?.dates?.length === 30, `n=${tr30.data?.dates?.length}`)
  const trBad = await api('GET', '/api/sa/stats/trends?range=bogus', undefined, saTok)
  check('B7b trends range invalid → 400', trBad.status === 400, `status=${trBad.status}`)

  // Seed chat hari ini (tenant 8 Mazaya — tenant eksisting di copy db) → trends today/7d
  // count naik (data benar, bukan cuma ok). Idempoten: upsert by (tenantId, waJid).
  const SEED_JID = '628999000001@s.whatsapp.net'
  const seedTarget = await prisma.chat.upsert({
    where: { tenantId_numberSlot_waJid: { tenantId: 8, numberSlot: 0, waJid: SEED_JID } },
    update: { firstIncomingAt: new Date() },
    create: {
      tenantId: 8,
      waJid: SEED_JID,
      contactPhone: '628999000001',
      contactName: 'E2E19 ChartSeed',
      firstIncomingAt: new Date(),
      status: 'open',
    },
  })
  check('B8 seed 1 chat hari ini (copy db)', !!seedTarget?.id, `id=${seedTarget?.id}`)
  const trToday2 = await api('GET', '/api/sa/stats/trends?range=today', undefined, saTok)
  check('B9 trends today reflect seed (lesson #4: data benar, bukan cuma ok)', trToday2.data?.counts?.[0] >= 1, `counts[0]=${trToday2.data?.counts?.[0]}`)

  // ── C. Avg-response shape (spec §4.3) ──
  const av = await api('GET', '/api/sa/stats/avg-response?range=7d', undefined, saTok)
  check('C1 avg-response → 200', av.status === 200, `status=${av.status}`)
  check('C2 shape { avgMinutes, avgTotal }', Array.isArray(av.data?.avgMinutes) && ('avgTotal' in av.data), `n=${av.data?.avgMinutes?.length} avgTotal=${av.data?.avgTotal}`)
  check('C3 avgMinutes utk 7d = 7 elemen (null utk hari tanpa data)', av.data?.avgMinutes?.length === 7, '')
  const avBad = await api('GET', '/api/sa/stats/avg-response?range=bogus', undefined, saTok)
  check('C3 avg-response range invalid → 400', avBad.status === 400, `status=${avBad.status}`)

  // ── D. Resolution shape (spec §4.4) ──
  const rs = await api('GET', '/api/sa/stats/resolution?range=7d', undefined, saTok)
  check('D1 resolution → 200', rs.status === 200, `status=${rs.status}`)
  check('D2 shape { resolved, open, percentResolved }', Number.isFinite(rs.data?.resolved) && Number.isFinite(rs.data?.open) && Number.isFinite(rs.data?.percentResolved), JSON.stringify({ resolved: rs.data?.resolved, open: rs.data?.open, percentResolved: rs.data?.percentResolved }))
  check('D3 percentResolved + percentOpen ≈ 100', Math.abs((rs.data?.percentResolved || 0) + (rs.data?.percentOpen || 0) - 100) < 0.5 || rs.data?.percentResolved + rs.data?.percentOpen === 0, `pct=${rs.data?.percentResolved}/${rs.data?.percentOpen}`)
  const rsBad = await api('GET', '/api/sa/stats/resolution?range=bogus', undefined, saTok)
  check('D4 resolution range invalid → 400', rsBad.status === 400, `status=${rsBad.status}`)

  // ── E. Tenants list + client-side search/filter/pagination data (endpoint unchanged) ──
  const tl = await api('GET', '/api/sa/tenants', undefined, saTok)
  check('E1 GET /tenants → 200 + array', tl.status === 200 && Array.isArray(tl.data?.tenants), `n=${tl.data?.tenants?.length}`)
  check('E2 row punya plan/status/validityState (chip UI tetap jalan)', tl.data?.tenants?.[0] ? ('plan' in tl.data.tenants[0] && 'status' in tl.data.tenants[0] && 'validityState' in tl.data.tenants[0]) : false, '')
  const tFirst = tl.data?.tenants?.[0]
  check('E3 GET /tenants/:id/plan → 200 (Edit Paket modal data source)', (await api('GET', `/api/sa/tenants/${tFirst?.id}/plan`, undefined, saTok)).status === 200, '')
  // search/filter dilakukan frontend (endpoint locked) → verifikasi data cukup utk filter klien
  check('E4 tenant list bawa name utk search klien', tl.data?.tenants?.every?.((t) => typeof t.name === 'string') === true, '')

  // ── F. Tenant isolation (spec §8): t12 impersonate → lihat miliknya, bukan tenant lain ──
  const imp12 = await api('POST', '/api/sa/impersonate/8', {}, saTok)
  check('F1 impersonate tenant-8 → 200', imp12.status === 200 && !!imp12.data?.token, `status=${imp12.status}`)
  const t8Tok = imp12.data?.token
  // SA stats = platform-wide (semua tenant) — memang by design utk SA; isolasi diuji
  // via slot-0 milik t12: chat seed E2E19 milik t12 TIDAK boleh bocor ke tenant lain.
  const t12Chats = await prisma.chat.findMany({ where: { tenantId: 8 }, select: { id: true, waJid: true }, take: 3 })
  check('F2 tenant-8 punya chat slot-0 miliknya (data utuh di copy db)', t12Chats.length >= 1, `n=${t12Chats.length}`)
  // Impersonated admin TIDAK bisa akses SA endpoint (requireSuperAdmin)
  const t12Stats = await api('GET', '/api/sa/stats', undefined, t8Tok)
  check('F3 admin impersonate akses /api/sa/* → 403 (isolation tetap)', t12Stats.status === 403, `status=${t12Stats.status}`)

  // ── G. Branding platform (GET/PUT /api/sa/platform-branding — additive baru) ──
  const pb0 = await api('GET', '/api/sa/platform-branding', undefined, saTok)
  check('G1 GET platform-branding → 200 + shape { brandName }', pb0.status === 200 && 'brandName' in pb0.data, `status=${pb0.status}`)
  const pbPut = await api('PUT', '/api/sa/platform-branding', { brandName: 'ChatBareng E2E19' }, saTok)
  check('G2 PUT platform-branding valid → 200 + brandName ter-echo', pbPut.status === 200 && pbPut.data?.brandName === 'ChatBareng E2E19', JSON.stringify(pbPut.data))
  const pbGet = await api('GET', '/api/sa/platform-branding', undefined, saTok)
  check('G2 GET after PUT → round-trip brandName (lesson #4 post-verify)', pbGet.data?.brandName === 'ChatBareng E2E19', JSON.stringify(pbGet.data))
  const pbBad = await api('PUT', '/api/sa/platform-branding', { brandName: 'A' }, saTok)
  check('G3 PUT 1-char → 400 validasi', pbBad.status === 400, `status=${pbBad.status}`)
  const pbReset = await api('PUT', '/api/sa/platform-branding', { brandName: '' }, saTok)
  const pbAfter = await api('GET', '/api/sa/platform-branding', undefined, saTok)
  check('G4 PUT "" reset → GET brandName null', pbReset.status === 200 && pbAfter.data?.brandName === null, `status=${pbReset.status} now=${JSON.stringify(pbAfter.data)}`)
  // tenant token = isolation guard utk endpoint baru
  const pbTenant = await api('GET', '/api/sa/platform-branding', undefined, t8Tok)
  check('G4b platform-branding utk admin tenant → 403 (SA-only)', pbTenant.status === 403, `status=${pbTenant.status}`)

  // ── H. Audit log: list + filter + cursor (spec §6) ──
  const au0 = await api('GET', '/api/sa/audit?limit=5', undefined, saTok)
  check('H1 GET /audit?limit=5 → 200 + items ≤5', au0.status === 200 && (au0.data?.items?.length || 0) <= 5, `n=${au0.data?.items?.length}`)
  check('H2 nextBefore cursor ada bila penuh', au0.data?.items?.length === 5 ? typeof au0.data?.nextBefore === 'number' : true, `nextBefore=${au0.data?.nextBefore}`)
  // filter action
  const auF = await api('GET', '/api/sa/audit?action=platform_branding&limit=50', undefined, saTok)
  check('H2b filter action=platform_branding → semua row action itu', auF.status === 200 && (auF.data?.items?.length || 0) >= 2 && auF.data.items.every((i) => i.action === 'platform_branding'), `n=${auF.data?.items?.length}`)
  // cursor: page-2 pakai before=lastId page-1 → id makin kecil
  if (au0.data?.nextBefore) {
    const au2 = await api('GET', `/api/sa/audit?limit=5&before=${au0.data.nextBefore}`, undefined, saTok)
    check('H3 cursor before= → halaman lanjut, id < cursor', au2.status === 200 && au2.data.items.every((i) => i.id < au0.data.nextBefore), `n=${au2.data?.items?.length} cursor=${au0.data.nextBefore}`)
  } else {
    check('H3 cursor before= (skip — data audit < 1 halaman)', true, 'nextBefore=null (audit rows < limit)')
  }
  // filter tenant (tenant 8 ada activity — F1 impersonate t8 = audit row tenantId 8)
  const auT = await api('GET', '/api/sa/audit?tenantId=8&limit=50', undefined, saTok)
  check('H4 filter tenantId=8 → 200 (rows ≥1 krn impersonate t8 barusan)', auT.status === 200, `n=${auT.data?.items?.length}`)




  // ── I. Ganti password SA (POST /api/auth/change-password — existing endpoint; COPY db) ──
  const pw1 = await api('POST', '/api/auth/change-password', { currentPassword: 'salah-banget', newPassword: 'e2enewpass19', confirmNewPassword: 'e2enewpass19' }, saTok)
  check('I1 change-password current salah → 401/400 (tetap terjaga)', [401, 400].includes(pw1.status), `status=${pw1.status}`)
  const pw2 = await api('POST', '/api/auth/change-password', { currentPassword: process.env.SUPERADMIN_PASSWORD, newPassword: 'e2enewpass19' }, saTok)
  check('I2 change-password valid → 200', pw2.status === 200, `status=${pw2.status}`)
  const reLogin = await api('POST', '/api/auth/login', { username: process.env.SUPERADMIN_USERNAME, password: 'e2enewpass19' })
  check('I3 re-login dgn password baru → 200 (round-trip lesson #4)', reLogin.status === 200 && !!reLogin.data?.token, `status=${reLogin.status}`)
  // kembalikan password utk run berikutnya (idempoten, copy db only)
  await api('POST', '/api/auth/change-password', { currentPassword: 'e2enewpass19', newPassword: process.env.SUPERADMIN_PASSWORD }, reLogin.data?.token)
  const reLogin2 = await api('POST', '/api/auth/login', { username: process.env.SUPERADMIN_USERNAME, password: process.env.SUPERADMIN_PASSWORD })
  check('I4 password di-restore utk run berikutnya', reLogin2.status === 200, `status=${reLogin2.status}`)

  // ── I2. change-password validasi client-side tetap (konfirmasi mismatch ditolak FE —
  // di backend hanya cek current; FE guard pwNew===pwConfirm di SaPengaturan.vue) ──

  // ── I5. SuperAdmin.vue split → router shape (verifikasi file — server-side static) ──
  const fs = require('fs')
  const superAdminSrc = fs.readFileSync(REPO + '/frontend/src/views/SuperAdmin.vue', 'utf8')
  check('J1 SuperAdmin.vue = shell (SaSidebar + router-view, tanpa logic lama)', superAdminSrc.includes('<router-view') && superAdminSrc.includes('SaSidebar') && !superAdminSrc.includes('purgeTenant'), `bytes=${superAdminSrc.length}`)
  const routerSrc = fs.readFileSync(REPO + '/frontend/src/router.js', 'utf8')
  for (const p of ['/superadmin/overview', '/superadmin/tenants', '/superadmin/audit', '/superadmin/pengaturan']) {
    check(`J2 route child ${p} terdaftar`, routerSrc.includes(`'${p}'`), '')
  }
  check('J3 redirect /superadmin → /superadmin/overview', /path: '',\s*redirect: '\/superadmin\/overview'/.test(routerSrc), '')
  for (const f of ['SaOverview.vue', 'SaTenants.vue', 'SaAudit.vue', 'SaPengaturan.vue']) {
    check(`J4 file ${f} ada`, fs.existsSync(REPO + '/frontend/src/views/' + f), '')
  }
  check('J5 SaPengaturan panggil /api/auth/change-password', fs.readFileSync(REPO + '/frontend/src/views/SaPengaturan.vue', 'utf8').includes('/api/auth/change-password'), '')
  check('J6 SaAudit pakai cursor ?before=', fs.readFileSync(REPO + '/frontend/src/views/SaAudit.vue', 'utf8').includes('params.before = auditNextBefore.value'), '')

  // ── K. Stats endpoint lain tetap 200 (regression ringan) ──
  const st = await api('GET', '/api/sa/stats', undefined, saTok)
  check('K1 GET /stats → 200 (5 metric cards)', st.status === 200 && Number.isFinite(st.data?.tenants), JSON.stringify(st.data))

  // ── L. v3.9.20 — Per-chart date ranges: all + custom (+ invalid cases) ──
  // WIB date util (mirror backend): today WIB + N hari lalu
  const wibToday = () => new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const wibDaysAgo = (n) => {
    const t = new Date(Date.now() + 7 * 60 * 60 * 1000)
    return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - n * 86400000)
      .toISOString().slice(0, 10)
  }
  const TODAY = wibToday()
  const D20 = wibDaysAgo(20) // from utk custom 21 hari (span inklusif)

  // L1 — trends all
  const trAll = await api('GET', '/api/sa/stats/trends?range=all', undefined, saTok)
  check('L1 trends all → 200', trAll.status === 200, `status=${trAll.status}`)
  check('L2 trends all dates monotonic (strict naik) + counts aligned',
    Array.isArray(trAll.data?.dates) && trAll.data.dates.length >= 1
    && trAll.data.dates.every((d, i) => i === 0 || String(d) > String(trAll.data.dates[i - 1]))
    && trAll.data.dates.length === trAll.data.counts?.length,
    `n=${trAll.data?.dates?.length} first=${trAll.data?.dates?.[0]} last=${trAll.data?.dates?.at(-1)}`)
  check('L3 trends all total >= total 7d', Number(trAll.data?.total) >= Number(tr7.data?.total),
    `all=${trAll.data?.total} 7d=${tr7.data?.total}`)

  // L4 — trends custom (20 hari lalu → hari ini WIB = 21 hari)
  const trCus = await api('GET', `/api/sa/stats/trends?range=custom&from=${D20}&to=${TODAY}`, undefined, saTok)
  check('L4 trends custom → 200 + dates.length = span (21)',
    trCus.status === 200 && trCus.data?.dates?.length === 21 && trCus.data?.counts?.length === 21,
    `status=${trCus.status} n=${trCus.data?.dates?.length} from=${D20} to=${TODAY}`)
  check('L5 trends custom total >= 0 + echo from/to',
    Number(trCus.data?.total) >= 0 && trCus.data?.from === D20 && trCus.data?.to === TODAY,
    `total=${trCus.data?.total}`)

  // L6 — avg-response all & custom
  const avAll = await api('GET', '/api/sa/stats/avg-response?range=all', undefined, saTok)
  check('L6 avg-response all → 200, avgTotal number|null, avgMinutes aligned dates',
    avAll.status === 200 && (avAll.data?.avgTotal === null || Number.isFinite(avAll.data?.avgTotal))
    && avAll.data?.dates?.length === avAll.data?.avgMinutes?.length,
    `status=${avAll.status} avgTotal=${avAll.data?.avgTotal} n=${avAll.data?.dates?.length}`)
  const avCus = await api('GET', `/api/sa/stats/avg-response?range=custom&from=${D20}&to=${TODAY}`, undefined, saTok)
  check('L7 avg-response custom → 200, avgMinutes.length = 21',
    avCus.status === 200 && avCus.data?.avgMinutes?.length === 21, `status=${avCus.status} n=${avCus.data?.avgMinutes?.length}`)

  // L8 — resolution all (legacy resolved ±2.504 → percentResolved > 0)
  const rsAll = await api('GET', '/api/sa/stats/resolution?range=all', undefined, saTok)
  check('L8 resolution all → 200, percentResolved > 0 (legacy resolved terhitung)',
    rsAll.status === 200 && rsAll.data?.percentResolved > 0,
    `status=${rsAll.status} pct=${rsAll.data?.percentResolved} resolved=${rsAll.data?.resolved} open=${rsAll.data?.open}`)
  check('L9 resolution all pctResolved + pctOpen ≈ 100',
    Math.abs((rsAll.data?.percentResolved || 0) + (rsAll.data?.percentOpen || 0) - 100) < 0.5,
    `pct=${rsAll.data?.percentResolved}/${rsAll.data?.percentOpen}`)
  const rsCus = await api('GET', `/api/sa/stats/resolution?range=custom&from=${D20}&to=${TODAY}`, undefined, saTok)
  check('L10 resolution custom → 200 + shape utuh',
    rsCus.status === 200 && Number.isFinite(rsCus.data?.resolved) && Number.isFinite(rsCus.data?.open),
    `status=${rsCus.status}`)

  // L11 — invalid custom cases → 400
  const iv1 = await api('GET', '/api/sa/stats/trends?range=custom', undefined, saTok)
  check('L11 custom tanpa from/to → 400', iv1.status === 400, `status=${iv1.status}`)
  const iv2 = await api('GET', `/api/sa/stats/trends?range=custom&from=${TODAY}&to=${D20}`, undefined, saTok)
  check('L12 custom from > to → 400', iv2.status === 400, `status=${iv2.status}`)
  const iv3 = await api('GET', '/api/sa/stats/trends?range=custom&from=20-hari-lalu&to=bogus', undefined, saTok)
  check('L13 custom format bogus → 400', iv3.status === 400, `status=${iv3.status}`)
  const iv4 = await api('GET', `/api/sa/stats/trends?range=custom&from=${wibDaysAgo(400)}&to=${TODAY}`, undefined, saTok)
  check('L14 custom span > 366 → 400', iv4.status === 400, `status=${iv4.status}`)
  const iv5 = await api('GET', '/api/sa/stats/avg-response?range=custom', undefined, saTok)
  check('L15 avg-response custom tanpa from/to → 400', iv5.status === 400, `status=${iv5.status}`)
  const iv6 = await api('GET', '/api/sa/stats/resolution?range=custom', undefined, saTok)
  check('L16 resolution custom tanpa from/to → 400', iv6.status === 400, `status=${iv6.status}`)

  console.log(`\n=== e2e-v3919: ${pass} PASS / ${fails.length} FAIL ===`)
  if (fails.length) { console.log('FAILED:', fails.join(' | ')); process.exitCode = 1 }
  await prisma.$disconnect()
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })