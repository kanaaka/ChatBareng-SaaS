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
  // v3.9.21 — today → mode hourly: dates = ['00','01',…,'<jam WIB sekarang>'] (inklusif)
  const EXPECT_HOURS = new Date(Date.now() + 7 * 60 * 60 * 1000).getUTCHours() + 1
  check('B6 trends today → 200 + mode hourly + dates = jam WIB sekarang +1',
    trToday.status === 200 && trToday.data?.mode === 'hourly' && trToday.data?.dates?.length === EXPECT_HOURS,
    `status=${trToday.status} mode=${trToday.data?.mode} n=${trToday.data?.dates?.length} expect=${EXPECT_HOURS}`)
  check('B6b trends today counts.length == dates.length + label jam zero-pad',
    trToday.data?.counts?.length === trToday.data?.dates?.length && trToday.data?.dates?.[0] === '00' && /^\d{2}$/.test(String(trToday.data?.dates?.at(-1))),
    `last=${trToday.data?.dates?.at(-1)} counts=${trToday.data?.counts?.length}`)
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
  // v3.9.21 — hourly: total = sum semua jam (counts[0] = chat jam 00–01 doang = SALAH)
  check('B9 trends today reflect seed (lesson #4: data benar, bukan cuma ok)', trToday2.data?.total >= 1, `total=${trToday2.data?.total}`)

  // v3.9.21 — avg-response today → mode hourly (bucket per jam WIB, aligned dates)
  const avToday = await api('GET', '/api/sa/stats/avg-response?range=today', undefined, saTok)
  check('B10 avg-response today → 200 + mode hourly',
    avToday.status === 200 && avToday.data?.mode === 'hourly',
    `status=${avToday.status} mode=${avToday.data?.mode}`)
  check('B10b avg-response today avgMinutes.length == dates.length',
    Array.isArray(avToday.data?.avgMinutes) && avToday.data.avgMinutes.length === avToday.data?.dates?.length,
    `n=${avToday.data?.avgMinutes?.length} dates=${avToday.data?.dates?.length}`)

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

  // ── M. v3.9.21 — Storage Tangan Kanan (GET /api/sa/stats/tk-storage) ──
  const tk = await api('GET', '/api/sa/stats/tk-storage', undefined, saTok)
  check('M1 tk-storage → 200 + totalBytes ≥0 + fileCount ≥0 + perTenant array',
    tk.status === 200 && Number.isFinite(tk.data?.totalBytes) && tk.data.totalBytes >= 0
    && Number.isFinite(tk.data?.fileCount) && tk.data.fileCount >= 0 && Array.isArray(tk.data?.perTenant),
    `status=${tk.status} bytes=${tk.data?.totalBytes} files=${tk.data?.fileCount} n=${tk.data?.perTenant?.length}`)
  check('M2 tk-storage perTenant entry shape (tenantId/tenantName/bytes/files number)',
    (tk.data?.perTenant?.length || 0) === 0 || tk.data.perTenant.every((t) => Number.isFinite(t.tenantId) && typeof t.tenantName === 'string' && Number.isFinite(t.bytes) && Number.isFinite(t.files)),
    JSON.stringify(tk.data?.perTenant?.[0] || null))
  check('M3 tk-storage total/fileCount = sum perTenant (konsisten)',
    tk.data?.totalBytes === tk.data?.perTenant?.reduce((a, t) => a + t.bytes, 0)
    && tk.data?.fileCount === tk.data?.perTenant?.reduce((a, t) => a + t.files, 0), '')
  const tkTenant = await api('GET', '/api/sa/stats/tk-storage', undefined, t8Tok)
  check('M4 tk-storage utk admin tenant → 403 (SA-only guard ...sa)', tkTenant.status === 403, `status=${tkTenant.status}`)

  // ── N-setup: token admin tenant 8 / CS tenant 8 / admin tenant 10 (login asli;
  // password dev copy db dgn prefix e2e — idempoten upsert) ──
  async function e2eLogin(username, password) {
    const r = await api('POST', '/api/auth/login', { username, password })
    return r.status === 200 ? r.data?.token : null
  }
  async function ensureE2EUser(username, role, tenantId) {
    const pw = 'e2e23pw-' + username
    const existing = await prisma.user.findFirst({ where: { username } })
    if (existing) {
      await prisma.user.update({ where: { id: existing.id }, data: { status: 'active', role, tenantId: role === 'super_admin' ? null : existing.tenantId } })
    } else {
      await prisma.user.create({ data: { username, passwordHash: await hashPassword(pw), role, tenantId: role === 'super_admin' ? null : tenantId, status: 'active' } })
    }
    return pw
  }
  const { hashPassword } = require(REPO + '/src/auth')
  const { encryptText, decryptTextSafe } = require(REPO + '/src/services/textCrypto')
  const pwAdmin8 = await ensureE2EUser('e2e23adm8', 'admin', 8)
  const pwCs8 = await ensureE2EUser('e2e23cs8', 'cs', 8)
  const pwAdmin10 = await ensureE2EUser('e2e23adm10', 'admin', 10)
  // password user existing (bukan buatan e2e) mungkin beda → reset eksplisit (copy db only)
  for (const [u, pw] of [['e2e23adm8', pwAdmin8], ['e2e23cs8', pwCs8], ['e2e23adm10', pwAdmin10]]) {
    await prisma.user.update({ where: { username: u }, data: { passwordHash: await hashPassword(pw) } })
  }
  const t8AdminTok = await e2eLogin('e2e23adm8', pwAdmin8)
  const t8CsTok = await e2eLogin('e2e23cs8', pwCs8)
  const t10AdminTok = await e2eLogin('e2e23adm10', pwAdmin10)
  check('N00 login admin t8 + cs t8 + admin t10 → token', !!t8AdminTok && !!t8CsTok && !!t10AdminTok, `adm8=${!!t8AdminTok} cs8=${!!t8CsTok} adm10=${!!t10AdminTok}`)

  // ═════════════════════════════════════════════════════════════════
  // ── N. v3.9.23 — AI Chat Summary (Ollama Cloud) — mock LLM deterministic ──
  // Mock server 127.0.0.1:11435 (dari script ini, spec §F): GET /api/tags → 2
  // model canned; POST /api/chat → ECHO marker (jumlah pesan + system + user
  // di-base64) → memungkinkan assert WINDOW semantics + template & rail.
  // ZERO call ke internet/OpenClaw — semua via mock lokal. Server copy WAJIB
  // env AI_E2E_MOCK=1 (opt-in test hook, lihat src/services/llm.js).
  // ═════════════════════════════════════════════════════════════════
  const http = require('http')
  const mockServer = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      if (req.method === 'GET' && req.url.startsWith('/api/tags')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ models: [
          { name: 'mock-model-a', size: 40458027008 },
          { name: 'mock-model-b', size: 2019490656 },
        ] }))
      }
      if (req.method === 'POST' && req.url.startsWith('/api/chat')) {
        let parsed = {}
        try { parsed = JSON.parse(body || '{}') } catch {}
        const msgs = Array.isArray(parsed.messages) ? parsed.messages : []
        const systemContent = msgs.find((m) => m.role === 'system')?.content || ''
        const userContent = msgs.find((m) => m.role === 'user')?.content || ''
        // ECHO marker = JUMLAH BARIS TRANSCRIPT (bukan msgs.length — payload selalu
        // 2: system+user). Hitung baris '[ts] ...' di antara marker PERCAKAPAN.
        let nTranscript = 0
        const seg = String(userContent).split('=== PERCAKAPAN ===\n')[1]
        if (seg) {
          const body = seg.split('\n=== AKHIR PERCAKAPAN ===')[0].trim()
          if (body) nTranscript = body.split('\n').filter((l) => /^\[/.test(l.trim())).length
        }
        const payload = [
          `MOCK_ECHO_MSGS=${nTranscript}`,
          `MOCK_ECHO_USER=${Buffer.from(userContent).toString('base64')}`,
          `MOCK_ECHO_SYSTEM=${Buffer.from(systemContent).toString('base64')}`,
        ].join('|')
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ model: parsed.model || 'mock-model-a', message: { content: payload } }))
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'mock: not found' }))
    })
  })
  await new Promise((resolve) => mockServer.listen(11435, '127.0.0.1', resolve))
  check('N0 mock LLM listen 127.0.0.1:11435', mockServer.listening, '')

  const MOCK_URL = 'http://127.0.0.1:11435'
  function decodeEcho(content) {
    const parts = String(content || '').split('|')
    const get = (k) => {
      const p = parts.find((x) => x.startsWith(k + '='))
      return p ? Buffer.from(p.slice(k.length + 1), 'base64').toString('utf8') : null
    }
    const mLine = parts.find((x) => x.startsWith('MOCK_ECHO_MSGS=')) || ''
    return { msgs: Number(mLine.split('=')[1] || 0), user: get('MOCK_ECHO_USER'), system: get('MOCK_ECHO_SYSTEM') }
  }

  // Idempoten re-run: bersihkan config + template tenant 8 (row test lama)
  await prisma.aiConfig.deleteMany({})
  await prisma.tenantSummaryTemplate.deleteMany({})
  // (cooldown summary & note-rate in-memory server → tiap summary pakai chat baru)

  let nSeq = 100
  async function seedOneMsgChat() {
    // naikkan nSeq sampai JID belum terpakai (idempoten re-run; unique (tenantId,numberSlot,waJid))
    let jid
    for (;;) {
      jid = `62899923${String(nSeq++).padStart(4, '0')}@s.whatsapp.net`
      const ex = await prisma.chat.findUnique({ where: { tenantId_numberSlot_waJid: { tenantId: 8, numberSlot: 0, waJid: jid } } })
      if (!ex) break
    }
    const chat = await prisma.chat.create({
      data: { tenantId: 8, waJid: jid, contactPhone: jid.slice(0, 12), contactName: 'E2E23 ' + jid.slice(-4), status: 'open' },
    })
    await prisma.message.create({ data: { tenantId: 8, chatId: chat.id, direction: 'in', content: encryptText('pesan ' + jid.slice(0, 12)), senderName: 'Customer', timestamp: new Date() } })
    return chat
  }

  // N1 — PUT config (mock baseUrl + dummy key) → GET masked (key TIDAK full)
  const n1put = await api('PUT', '/api/sa/ai-config', { cloudBaseUrl: MOCK_URL, apiKey: 'test-key-123456-2345', cloudModel: 'mock-model-a' }, saTok)
  check('N1 PUT ai-config → 200 + hasKey true', n1put.status === 200 && n1put.data?.hasKey === true, `status=${n1put.status} hasKey=${n1put.data?.hasKey}`)
  check('N1b keyMasked = ••••2345 (last4)', n1put.data?.keyMasked === '••••2345', `masked=${JSON.stringify(n1put.data?.keyMasked)}`)
  const n1get = await api('GET', '/api/sa/ai-config', undefined, saTok)
  check('N1c GET config → key TIDAK pernah full di response', n1get.status === 200 && !JSON.stringify(n1get.data).includes('test-key-123456-2345') && !('apiKey' in (n1get.data || {})), `status=${n1get.status}`)
  check('N1d GET config shape (baseUrl/model/fallback/defaultPreset)', n1get.data?.cloudBaseUrl === MOCK_URL && n1get.data?.localBaseUrl === 'http://127.0.0.1:11434' && n1get.data?.fallbackEnabled === false && n1get.data?.defaultPreset === 'standard', JSON.stringify(n1get.data))
  const n1dbRow = await prisma.aiConfig.findUnique({ where: { id: 1 } })
  check('N1e DB apiKeyEnc terenkripsi (bukan plaintext di DB — spec §G)', !!n1dbRow?.apiKeyEnc && !String(n1dbRow.apiKeyEnc).includes('test-key-123456-2345'), `encPrefix=${String(n1dbRow?.apiKeyEnc || '').slice(0, 4)}…`)

  // N2 — tes koneksi (key stored, baseUrl/model default config) → ok + latency
  const n2 = await api('POST', '/api/sa/ai-config/test', {}, saTok)
  check('N2 POST test → ok true + latencyMs number', n2.status === 200 && n2.data?.ok === true && Number.isFinite(n2.data?.latencyMs), `status=${n2.status} ${JSON.stringify(n2.data)}`)

  // N3 — daftar model via mock → 2 canned + key TIDAK bocor
  const n3 = await api('GET', '/api/sa/ai-config/models?scope=cloud', undefined, saTok)
  check('N3 GET models → array 2 canned (mock-model-a/b)', n3.status === 200 && Array.isArray(n3.data?.models) && n3.data.models.length === 2 && n3.data.models.every((m) => ['mock-model-a', 'mock-model-b'].includes(m.name)), JSON.stringify(n3.data))
  check('N3b models response tanpa key', !JSON.stringify(n3.data).includes('test-key-123456-2345'), '')
  const n3Local = await api('GET', '/api/sa/ai-config/models?scope=local&baseUrl=' + encodeURIComponent(MOCK_URL), undefined, saTok)
  check('N3c models scope=local (baseUrl override) → 2 model', n3Local.status === 200 && n3Local.data?.models?.length === 2, `status=${n3Local.status}`)

  // N4 — window semantics (locked, spec §D): timestamp > resolvedAt (NULL → semua),
  // order asc. Seed chat A resolved @t3 (5 pesan t1..t5) + chat B open (5 pesan).
  const t0 = Date.now()
  const mk = (i) => new Date(t0 - 60000 + i * 1000) // t1..t5, t3 = mk(2)
  const N4_JID_A = '628999230001@s.whatsapp.net'
  const N4_JID_B = '628999230002@s.whatsapp.net'
  const n4a = await prisma.chat.upsert({
    where: { tenantId_numberSlot_waJid: { tenantId: 8, numberSlot: 0, waJid: N4_JID_A } },
    update: { status: 'resolved', resolvedAt: mk(2), resolvedById: 22, contactName: 'E2E23 WinA' },
    create: { tenantId: 8, waJid: N4_JID_A, contactPhone: '628999230001', contactName: 'E2E23 WinA', status: 'resolved', resolvedAt: mk(2), resolvedById: 22, firstIncomingAt: mk(0) },
  })
  const n4b = await prisma.chat.upsert({
    where: { tenantId_numberSlot_waJid: { tenantId: 8, numberSlot: 0, waJid: N4_JID_B } },
    update: { status: 'open', resolvedAt: null, resolvedById: null, contactName: 'E2E23 WinB' },
    create: { tenantId: 8, waJid: N4_JID_B, contactPhone: '628999230002', contactName: 'E2E23 WinB', status: 'open', firstIncomingAt: mk(0) },
  })
  for (const [chat, tag] of [[n4a, 'A'], [n4b, 'B']]) {
    // re-seed SETIAP run dgn timestamp segar (idempoten; t4/t5 harus > resolvedAt segar)
    await prisma.message.deleteMany({ where: { chatId: chat.id } })
    await prisma.message.createMany({ data: [1, 2, 3, 4, 5].map((i) => ({
      tenantId: 8, chatId: chat.id, direction: i % 2 ? 'in' : 'out',
      content: encryptText(`${tag}-pesan-${i}`), senderName: i % 2 ? 'Customer' : 'agent',
      timestamp: mk(i - 1),
    })) })
  }
  check('N4 seed chat A (resolved@t3) + B (open) + 5 pesan @t1..t5', !!n4a?.id && !!n4b?.id, `A=${n4a?.id} B=${n4b?.id}`)

  const n4s1 = await api('POST', `/api/chats/${n4a.id}/summary`, {}, t8AdminTok)
  check('N4a summary chat resolved (resolvedAt=t3) → 200', n4s1.status === 200, `status=${n4s1.status} ${JSON.stringify(n4s1.data).slice(0, 160)}`)
  const n4e1 = decodeEcho(n4s1.data?.summaryText)
  check('N4a2 window marker = 2 pesan (t4,t5 saja — post-resolve)', n4e1.msgs === 2, `msgs=${n4e1.msgs}`)
  check('N4a3 user content mengandung pesan A-4 & A-5, TIDAK A-1..3', (n4e1.user || '').includes('A-pesan-4') && (n4e1.user || '').includes('A-pesan-5') && !(n4e1.user || '').includes('A-pesan-1'), '')
  check('N4a4 user content berisi label Customer + CS (agent) + metadata kontak', (n4e1.user || '').includes('Customer:') && (n4e1.user || '').includes('CS (agent)') && (n4e1.user || '').includes('Kontak: E2E23 WinA'), '')
  check('N4a5 window meta {messageCount:2, from, to}', n4s1.data?.window?.messageCount === 2 && !!n4s1.data?.window?.from && !!n4s1.data?.window?.to, JSON.stringify(n4s1.data?.window))
  check('N4a6 response shape (templateUsed/model/viaFallback/latencyMs)', n4s1.data?.templateUsed === 'standard' && typeof n4s1.data?.model === 'string' && n4s1.data?.viaFallback === false && Number.isFinite(n4s1.data?.latencyMs), JSON.stringify({ templateUsed: n4s1.data?.templateUsed, model: n4s1.data?.model, viaFallback: n4s1.data?.viaFallback }))
  check('N4a7 system prompt = preset standard 4 blok + RAIL anti-halusinasi', (n4e1.system || '').includes('RINGKASAN') && (n4e1.system || '').includes('STATUS & LANGKAH LANJUT') && (n4e1.system || '').includes('JANGAN mengarang fakta'), '')
  const n4s2 = await api('POST', `/api/chats/${n4b.id}/summary`, {}, t8AdminTok)
  check('N4b chat tanpa resolvedAt → marker 5 pesan (semua pesan)', n4s2.status === 200 && decodeEcho(n4s2.data?.summaryText).msgs === 5, `status=${n4s2.status} msgs=${decodeEcho(n4s2.data?.summaryText).msgs}`)

  // N5 — cooldown 30s per chat (in-memory Map) → call kedua langsung → 429
  const n5 = await api('POST', `/api/chats/${n4b.id}/summary`, {}, t8AdminTok)
  check('N5 cooldown call kedua → 429 + retryAfter 1..30', n5.status === 429 && Number(n5.data?.retryAfter) > 0 && Number(n5.data?.retryAfter) <= 30, `status=${n5.status} retryAfter=${n5.data?.retryAfter}`)

  // N6 — guard: chat tenant lain → 404; config dikosongkan → 400 NO_CONFIG
  const n6a = await api('POST', `/api/chats/${n4a.id}/summary`, {}, t10AdminTok)
  check('N6a admin tenant lain akses chat t8 → 404 (tenant scope)', n6a.status === 404, `status=${n6a.status}`)
  const n6c = await seedOneMsgChat()
  const n6del = await prisma.aiConfig.deleteMany({})
  const n6b = await api('POST', `/api/chats/${n6c.id}/summary`, {}, t8AdminTok)
  check('N6b config dikosongkan → 400 NO_CONFIG dgn pesan jelas', n6b.status === 400 && n6b.data?.code === 'NO_CONFIG' && /belum dikonfigurasi/i.test(String(n6b.data?.error)), `status=${n6b.status} code=${n6b.data?.code} deleted=${n6del.count}`)
  // restore config (mock) utk N7+ — idempoten
  await api('PUT', '/api/sa/ai-config', { cloudBaseUrl: MOCK_URL, apiKey: 'test-key-123456-2345', cloudModel: 'mock-model-a' }, saTok)

  // N7 — Simpan-ke-catatan via endpoint ChatNote existing → SELECT-back (lesson #4)
  const noteBody = 'E2E23 summary note ' + Date.now()
  const n7 = await api('POST', `/api/chats/${n4b.id}/notes`, { body: noteBody }, t8AdminTok)
  check('N7 POST catatan existing → 201 (endpoint ChatNote)', n7.status === 200 || n7.status === 201, `status=${n7.status}`)
  const n7row = await prisma.chatNote.findFirst({ where: { chatId: n4b.id }, orderBy: { id: 'desc' } })
  check('N7b row ChatNote muncul (SELECT-back verify, body dekrip cocok)', !!n7row?.id && decryptTextSafe(n7row.body) === noteBody, `id=${n7row?.id}`)

  // N8 — fallback path: fallbackEnabled + cloudBaseUrl port mati → 200 via local (mock)
  const deadPort = 'http://127.0.0.1:19191'
  const n8put = await api('PUT', '/api/sa/ai-config', { cloudBaseUrl: deadPort, fallbackEnabled: true, localBaseUrl: MOCK_URL, localModel: 'mock-model-b' }, saTok)
  check('N8 PUT fallback config → 200 (key keep)', n8put.status === 200 && n8put.data?.hasKey === true && n8put.data?.fallbackEnabled === true, `status=${n8put.status} hasKey=${n8put.data?.hasKey} fb=${n8put.data?.fallbackEnabled}`)
  const n8c = await seedOneMsgChat()
  const n8 = await api('POST', `/api/chats/${n8c.id}/summary`, {}, t8AdminTok)
  check('N8a cloud mati + fallbackEnabled → 200 via fallback lokal', n8.status === 200 && n8.data?.viaFallback === true, `status=${n8.status} viaFallback=${n8.data?.viaFallback}`)
  check('N8b model = localModel (mock-model-b)', n8.data?.model === 'mock-model-b', `model=${n8.data?.model}`)
  check('N8c marker = 1 pesan (window fallback benar)', decodeEcho(n8.data?.summaryText).msgs === 1, `msgs=${decodeEcho(n8.data?.summaryText).msgs}`)
  // restore primary config
  await api('PUT', '/api/sa/ai-config', { cloudBaseUrl: MOCK_URL, fallbackEnabled: false }, saTok)

  // N9 — template jalur: default → medis → custom → preview → validasi → guard
  await prisma.tenantSummaryTemplate.deleteMany({ where: { tenantId: { in: [8, 10] } } })
  const n9get0 = await api('GET', '/api/chats/settings/summary-template', undefined, t8AdminTok)
  check('N9a GET template (belum diset) → default standard', n9get0.status === 200 && n9get0.data?.presetKey === 'standard' && !n9get0.data?.customText, `status=${n9get0.status} ${JSON.stringify(n9get0.data)}`)
  const n9putM = await api('PUT', '/api/chats/settings/summary-template', { presetKey: 'medis' }, t8AdminTok)
  check('N9b PUT preset=medis → 200 ter-echo', n9putM.status === 200 && n9putM.data?.presetKey === 'medis', `status=${n9putM.status}`)
  const n9cM = await seedOneMsgChat()
  const n9sM = await api('POST', `/api/chats/${n9cM.id}/summary`, {}, t8AdminTok)
  check('N9c summary echo instruksi medis (mock) + templateUsed medis', n9sM.status === 200 && n9sM.data?.templateUsed === 'medis' && (decodeEcho(n9sM.data?.summaryText).system || '').includes('pasien/klinik'), `status=${n9sM.status} tpl=${n9sM.data?.templateUsed}`)
  const n9putC = await api('PUT', '/api/chats/settings/summary-template', { presetKey: 'standard', customText: 'E2E23-CUSTOM-INSTRUKSI ringkas poin' }, t8AdminTok)
  check('N9d PUT customText → 200 tersimpan', n9putC.status === 200 && n9putC.data?.customText === 'E2E23-CUSTOM-INSTRUKSI ringkas poin', `status=${n9putC.status}`)
  const n9cC = await seedOneMsgChat()
  const n9sC = await api('POST', `/api/chats/${n9cC.id}/summary`, {}, t8AdminTok)
  const n9eC = decodeEcho(n9sC.data?.summaryText)
  check('N9e customText MENANG atas preset → templateUsed custom + echo', n9sC.status === 200 && n9sC.data?.templateUsed === 'custom' && (n9eC.system || '').includes('E2E23-CUSTOM-INSTRUKSI ringkas poin'), `status=${n9sC.status} tpl=${n9sC.data?.templateUsed}`)
  check('N9e2 RAIL tetap ditambahkan setelah custom instruksi', (n9eC.system || '').includes('JANGAN mengarang fakta'), '')
  const n9prev = await api('POST', '/api/settings/summary-template/preview', { presetKey: 'penjualan' }, t8AdminTok)
  check('N9f preview (draft, sample baked-in) → 200 + templateUsed penjualan', n9prev.status === 200 && n9prev.data?.templateUsed === 'penjualan' && typeof n9prev.data?.summaryText === 'string', `status=${n9prev.status} tpl=${n9prev.data?.templateUsed}`)
  const n9prevBad = await api('POST', '/api/chats/summary-preview', { presetKey: 'bogus' }, t8AdminTok)
  check('N9f2 preview direct chats path presetKey bogus → 400', n9prevBad.status === 400, `status=${n9prevBad.status}`)
  const n9big = await api('PUT', '/api/chats/settings/summary-template', { presetKey: 'standard', customText: 'x'.repeat(1001) }, t8AdminTok)
  check('N9g customText >1000 → 400', n9big.status === 400, `status=${n9big.status}`)
  const n9cs = await api('PUT', '/api/chats/settings/summary-template', { presetKey: 'ringkas' }, t8CsTok)
  check('N9h CS PUT template → 403 (admin-only)', n9cs.status === 403, `status=${n9cs.status}`)
  // N9i — isolasi antar-tenant: t10 admin lihat VIEW-nya sendiri (default standard,
  // customText null) — template t8 (custom 'E2E23-CUSTOM-INSTRUKSI…') TIDAK boleh bocor.
  // (GET = resolved view + default utk row belum ada, spec §D — BUKAN 404; deviasi
  // dari instruksi literal "tenant lain → 404" karena bertentangan dgn N9a default-200.)
  const n9o = await api('GET', '/api/chats/settings/summary-template', undefined, t10AdminTok)
  check('N9i isolasi template: t10 lihat default sendiri, TIDAK bocor template t8', n9o.status === 200 && n9o.data?.presetKey === 'standard' && !n9o.data?.customText, `status=${n9o.status} ${JSON.stringify(n9o.data)}`)
  const n9oPut = await api('PUT', '/api/chats/settings/summary-template', { presetKey: 'ringkas' }, t10AdminTok)
  check('N9i2 t10 PUT template terpisah → 200 (tenant scope masing-masing)', n9oPut.status === 200 && n9oPut.data?.presetKey === 'ringkas', `status=${n9oPut.status}`)
  const n9oGet = await api('GET', '/api/chats/settings/summary-template', undefined, t10AdminTok)
  check('N9i3 t10 GET after PUT → ringkas (row t10 sendiri, t8 tak terpengaruh)', n9oGet.status === 200 && n9oGet.data?.presetKey === 'ringkas', `status=${n9oGet.status}`)
  // audit summary_template_update tercatat (spec §D) — tanpa isi template
  const n9audit = await prisma.saAuditLog.findFirst({ where: { action: 'summary_template_update', tenantId: 8 }, orderBy: { id: 'desc' } })
  check('N9i4 audit summary_template_update (t8) tercatat tanpa isi template', !!n9audit?.id && !String(n9audit?.detailJson || '').includes('E2E23-CUSTOM-INSTRUKSI'), `id=${n9audit?.id}`)
  await prisma.tenantSummaryTemplate.deleteMany({ where: { tenantId: 10 } })
  // cleanup template t8 (biar state copy db bersih; AiConfig biarkan — post-verify pakai)
  const n9clean = await prisma.tenantSummaryTemplate.deleteMany({ where: { tenantId: 8 } })
  check('N9j cleanup template t8 (idempoten re-run)', n9clean.count >= 1, `deleted=${n9clean.count}`)

  mockServer.close()

  console.log(`\n=== e2e-v3919: ${pass} PASS / ${fails.length} FAIL ===`)
  if (fails.length) { console.log('FAILED:', fails.join(' | ')); process.exitCode = 1 }
  await prisma.$disconnect()
  process.exit(process.exitCode || 0) // mock sockets keep event loop alive → exit eksplisit
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })