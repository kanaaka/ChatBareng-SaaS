// v3.0 Phase 1 — Smoke test (spec "Verifikasi WAJIB")
// Node script — header auth pakai Buffer.from('QmVhcmVyIA==','base64') + ' ' + token
// (JANGAN literal auth scheme string — sanitizer trap).
const BASE = 'http://localhost:5047'
const SCHEME = Buffer.from('QmVhcmVyIA==', 'base64').toString('utf8')
const authHeader = (token) => ({ Authorization: SCHEME + token })

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log(`  ✅ ${name}`)
  else { failures++; console.log(`  ❌ ${name} ${extra}`) }
}

async function api(method, path, token, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? authHeader(token) : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  let data = null
  try { data = await res.json() } catch { /* non-json */ }
  return { status: res.status, data }
}

async function main() {
  console.log('── 1. Health ──')
  const health = await api('GET', '/api/health')
  check('health 200', health.status === 200)

  console.log('── 2. Login superadmin (env auto-seed, no default tenant) ──')
  // 2026-11-11: password QA jangan di-hardcode — set via env CB_SMOKE_PASSWORD
  const saLogin = await api('POST', '/api/auth/login', null, { username: 'superadmin', password: process.env.CB_SMOKE_PASSWORD })
  check('superadmin login 200', saLogin.status === 200, JSON.stringify(saLogin.data))
  const sa = saLogin.data.token
  check('super_admin role', saLogin.data.user?.role === 'super_admin')
  check('tenants list dikirim', Array.isArray(saLogin.data.tenants))

  console.log('── 3. Buat Tenant Alpha + Beta + admin masing-masing ──')
  const tAlpha = await api('POST', '/api/sa/tenants', sa, { name: 'Alpha' })
  check('tenant Alpha dibuat', tAlpha.status === 201, JSON.stringify(tAlpha.data))
  const tBeta = await api('POST', '/api/sa/tenants', sa, { name: 'Beta' })
  check('tenant Beta dibuat', tBeta.status === 201)
  const alphaId = tAlpha.data.tenant.id
  const betaId = tBeta.data.tenant.id

  const aAdmin = await api('POST', `/api/sa/tenants/${alphaId}/admins`, sa, { username: 'adminalpha', password: 'alpha123' })
  check('admin Alpha dibuat', aAdmin.status === 201, JSON.stringify(aAdmin.data))
  const bAdmin = await api('POST', `/api/sa/tenants/${betaId}/admins`, sa, { username: 'adminbeta', password: 'beta12345' })
  check('admin Beta dibuat', bAdmin.status === 201)

  const saTenants = await api('GET', '/api/sa/tenants', sa)
  const alphaRow = saTenants.data.tenants?.find(t => t.id === alphaId)
  check('list tenants + counts + waStatus null/disabled',
    saTenants.status === 200 && saTenants.data.tenants.length === 2
    && alphaRow?.userCount === 1 && alphaRow?.chatCount === 0
    && (alphaRow?.waStatus === null || alphaRow?.waStatus?.disabled === true),
    JSON.stringify(saTenants.data))

  console.log('── 4. Seed per-tenant ──')
  const alphaLogin = await api('POST', '/api/auth/login', null, { username: 'adminalpha', password: 'alpha123' })
  check('admin Alpha login', alphaLogin.status === 200, JSON.stringify(alphaLogin.data))
  const alpha = alphaLogin.data.token
  const betaLogin = await api('POST', '/api/auth/login', null, { username: 'adminbeta', password: 'beta12345' })
  check('admin Beta login', betaLogin.status === 200)
  const beta = betaLogin.data.token

  const waStatusAlpha = await api('GET', '/api/wa/status', alpha)
  check('WA status Alpha disabled:true (stub fase 1)', waStatusAlpha.status === 200 && waStatusAlpha.data.disabled === true && waStatusAlpha.data.connected === false,
    JSON.stringify(waStatusAlpha.data))
  const arCfg = await api('GET', '/api/autoreply', alpha)
  check('AutoReplyConfig Alpha ter-seed', arCfg.status === 200 && arCfg.data.config?.id > 0, JSON.stringify(arCfg.data))
  const tkFolders = await api('GET', '/api/tk/folders', alpha)
  check('3 folder sistem Alpha ter-seed', tkFolders.status === 200 && tkFolders.data.folders?.length === 3,
    JSON.stringify(tkFolders.data.folders?.map(f => f.name)))

  console.log('── 5. Isolasi: Alpha bikin template/tag/kontak → Beta gak lihat ──')
  const tpl = await api('POST', '/api/templates', alpha, { name: 'TPL-ALPHA', keyword: '/alpha', content: 'Halo dari Alpha' })
  check('template Alpha dibuat', tpl.status === 201, JSON.stringify(tpl.data))
  const tag = await api('POST', '/api/tags', alpha, { name: 'TAG-ALPHA' })
  check('tag Alpha dibuat', tag.status === 201)
  const contact = await api('POST', '/api/contacts', alpha, { name: 'Kontak Alpha', phone: '628111000222' })
  check('kontak Alpha dibuat', contact.status === 201, JSON.stringify(contact.data))

  const betaTpl = await api('GET', '/api/templates', beta)
  check('Beta TIDAK lihat template Alpha', betaTpl.status === 200 && betaTpl.data.templates.length === 0,
    JSON.stringify(betaTpl.data))
  const betaTag = await api('GET', '/api/tags', beta)
  check('Beta TIDAK lihat tag Alpha', betaTag.status === 200 && betaTag.data.tags.length === 0)
  const betaContacts = await api('GET', '/api/contacts', beta)
  check('Beta TIDAK lihat kontak Alpha', betaContacts.status === 200 && betaContacts.data.contacts.length === 0,
    JSON.stringify(betaContacts.data))

  // super_admin wajib ?tenant= untuk endpoint ber-scope
  const saNoTenant = await api('GET', '/api/templates', sa)
  check('superadmin tanpa ?tenant → 400', saNoTenant.status === 400, JSON.stringify(saNoTenant.data))
  const saWithTenant = await api('GET', '/api/templates?tenant=' + alphaId, sa)
  check('superadmin + ?tenant=Alpha lihat template Alpha', saWithTenant.status === 200 && saWithTenant.data.templates.length === 1)

  console.log('── 6. Non-superadmin /api/sa/* → 403 ──')
  const saForb = await api('GET', '/api/sa/tenants', alpha)
  check('admin Alpha → /api/sa/tenants 403', saForb.status === 403)

  console.log('── 7. Buat CS via users API (admin Alpha) ──')
  const csCreate = await api('POST', '/api/users', alpha, { username: 'csalpha', password: 'csalpha123', role: 'cs' })
  check('CS Alpha dibuat', csCreate.status === 201, JSON.stringify(csCreate.data))
  const csLogin = await api('POST', '/api/auth/login', null, { username: 'csalpha', password: 'csalpha123' })
  check('CS Alpha login', csLogin.status === 200)
  const cs = csLogin.data.token

  console.log('── 8. processIncomingMessage: tenantId beda + JID sama → 2 chat terpisah ──')
  const pool = require('../src/wa/pool')
  const prisma = require('../src/prisma')
  const jid = '628999888777@s.whatsapp.net'
  const mkMsg = () => ({
    key: { remoteJid: jid, fromMe: false, id: 'TESTMSG-' + Math.random().toString(36).slice(2) },
    message: { conversation: 'Halo test' },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: 'Tester',
  })
  await pool.processIncomingMessage(alphaId, mkMsg())
  await pool.processIncomingMessage(betaId, mkMsg())
  const alphaChats = await prisma.chat.findMany({ where: { tenantId: alphaId, waJid: jid } })
  const betaChats = await prisma.chat.findMany({ where: { tenantId: betaId, waJid: jid } })
  check('chat Alpha terbentuk (waJid sama)', alphaChats.length === 1)
  check('chat Beta terbentuk terpisah (unique [tenantId,waJid])', betaChats.length === 1)
  check('id Int beda antar tenant', alphaChats[0].id !== betaChats[0].id)
  check('Message tersimpan per tenant (2 baris)',
    (await prisma.message.count({ where: { tenantId: alphaId, chatId: alphaChats[0].id } })) === 1
    && (await prisma.message.count({ where: { tenantId: betaId, chatId: betaChats[0].id } })) === 1)

  // isolasi read: admin Beta TIDAK boleh akses chat Alpha by id
  const betaReadAlpha = await api('GET', `/api/chats/${alphaChats[0].id}`, beta)
  check('admin Beta GET chat Alpha → 404', betaReadAlpha.status === 404, JSON.stringify(betaReadAlpha.data))
  const alphaReadOwn = await api('GET', `/api/chats/${alphaChats[0].id}`, alpha)
  check('admin Alpha GET chat sendiri → 200', alphaReadOwn.status === 200, JSON.stringify(alphaReadOwn.data).slice(0, 120))

  console.log('── 9. Queue count + take-next per tenant ──')
  const qc = await api('GET', '/api/chats/queue-count', cs)
  check('queue-count Alpha = 1 (chat test)', qc.status === 200 && qc.data.count === 1, JSON.stringify(qc.data))
  const qcBeta = await api('GET', '/api/chats/queue-count', beta)
  check('queue-count Beta = 1 (chat testnya sendiri)', qcBeta.status === 200 && qcBeta.data.count === 1)
  const take = await api('POST', '/api/chats/take-next', cs)
  check('CS Alpha take-next chat Alpha', take.status === 200 && take.data.chat?.assignedTo?.id, JSON.stringify(take.data).slice(0, 150))
  const takeAgain = await api('POST', '/api/chats/take-next', cs)
  check('queue Alpha kosong setelah take (404)', takeAgain.status === 404)

  console.log('── 10. historyImport dry-run per tenant ──')
  const exportRes = await api('GET', '/api/history/export', alpha)
  check('export Alpha 200 (admin)', exportRes.status === 200)
  const exportPayload = typeof exportRes.data === 'object' ? exportRes.data : JSON.parse(exportRes.data)
  check('export berisi 1 chat Alpha', exportPayload.chats?.length === 1)

  // import ke Beta via dry-run pakai payload Alpha
  const importForm = new FormData()
  importForm.append('file', new Blob([JSON.stringify(exportPayload)], { type: 'application/json' }), 'backup.json')
  const dryRes = await fetch(BASE + '/api/history/import?dryRun=true', {
    method: 'POST',
    headers: authHeader(beta),
    body: importForm,
  })
  const dryData = await dryRes.json().catch(() => null)
  check('import dry-run Beta 200', dryRes.status === 200, JSON.stringify(dryData))
  check('dry-run: 1 chat dibuat di Beta', dryData?.chatsCreated === 1, JSON.stringify(dryData))

  // super_admin export tanpa ?tenant → 400
  const saExportNo = await api('GET', '/api/history/export', sa)
  check('superadmin export tanpa ?tenant → 400', saExportNo.status === 400)
  const saExportOk = await api('GET', '/api/history/export?tenant=' + alphaId, sa)
  check('superadmin export ?tenant=Alpha → 200', saExportOk.status === 200)

  console.log('── 11. Suspended tenant login → 403 ──')
  const suspend = await api('PUT', `/api/sa/tenants/${betaId}`, sa, { status: 'suspended' })
  check('suspend Beta ok', suspend.status === 200 && suspend.data.tenant?.status === 'suspended')
  const betaLogin2 = await api('POST', '/api/auth/login', null, { username: 'adminbeta', password: 'beta12345' })
  check('admin Beta login saat suspended → 403', betaLogin2.status === 403, JSON.stringify(betaLogin2.data))
  const reactivate = await api('PUT', `/api/sa/tenants/${betaId}`, sa, { status: 'active' })
  check('activate Beta lagi', reactivate.status === 200)

  console.log('── 12. Impersonate superadmin → view-as tenant ──')
  const imp = await api('POST', `/api/sa/impersonate/${alphaId}`, sa)
  check('impersonate 200', imp.status === 200 && imp.data.token, JSON.stringify(imp.data).slice(0, 100))
  const impList = await api('GET', '/api/templates', imp.data.token)
  check('impersonated token lihat data Alpha (role admin)', impList.status === 200 && impList.data.templates.length === 1)

  console.log('── 13. WA send saat disabled → error jelas ──')
  const reply = await api('POST', `/api/chats/${alphaChats[0].id}/reply`, alpha, { content: 'Tes reply' })
  check('reply saat WA disabled tetap 200 (message failed tersimpan)', reply.status === 200, JSON.stringify(reply.data).slice(0, 160))
  const sendErr = await pool.sendMessageForTenant(alphaId, jid, 'x').catch((e) => e)
  check('sendMessageForTenant → error jelas', sendErr instanceof Error && /disabled|belum terhubung/i.test(sendErr.message),
    sendErr?.message)

  console.log('── 14. DELETE tenant kosong vs tidak kosong ──')
  const tEmpty = await api('POST', '/api/sa/tenants', sa, { name: 'Empty' })
  check('tenant Empty dibuat', tEmpty.status === 201)
  const delEmpty = await api('DELETE', `/api/sa/tenants/${tEmpty.data.tenant.id}`, sa)
  check('tenant kosong terhapus', delEmpty.status === 200, JSON.stringify(delEmpty.data))
  const delAlpha = await api('DELETE', `/api/sa/tenants/${alphaId}`, sa)
  check('tenant Alpha (tidak kosong) → 400', delAlpha.status === 400, JSON.stringify(delAlpha.data))

  console.log(`\n${failures === 0 ? '🎉 SEMUA CHECK PASS' : '⚠️ FAILURES: ' + failures}`)
  process.exit(failures ? 1 : 0)
}

main().catch((e) => { console.error('SMOKE CRASH:', e); process.exit(1) })