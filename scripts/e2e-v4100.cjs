/**
 * E2E v4.1.0 — Channels (WA Channel archive, read-only) (spec docs/spec-v4.1.0-channels.md §6).
 * Jalan terhadap DB COPY di port 5099 (WA_DISABLED=1 + E2E_DEBUG_INBOUND=1 + E2E_OK_SEND=1)
 * — produksi (5047) TIDAK tersentuh. Pola: scripts/e2e-v4000.cjs.
 * TANPA LLM/mock LLM (fitur ini archive-only, 0 cost LLM — D8; mock LLM tidak dibutuhkan).
 *
 * Checks:
 * N1 archiveNewsletterMessage → archive ter-create + post tersimpan (content match);
 *    + N1e POST /api/wa/inbound @newsletter → handled=false (jalur guard v4.0.0c TETAP)
 * N2 dedupe: kirim pesan sama (serverId sama) → post TIDAK dobel (count 1, idempoten)
 * N3 fromMe=true → post tersimpan dgn fromMe=true; propName best-effort (D2)
 * N4 GET /api/channels → archive muncul (nama/jid/postCount); GET posts → isi benar;
 *    SA ?tenant= → 200; SA tanpa ?tenant= → 400
 * N5 admin tenant lain → 404/isolasi (tenant-scoped); CS token → 403 (admin-only);
 *    tanpa token → 401. TANPA plan gate (D8) — semua tenant aktif otomatis.
 * N6 media post (imageMessage tanpa caption) → arsip dgn metadata media (content
 *    kosong + mediaType) — tanpa crash; video dgn caption → content=caption;
 *    protocol event (tanpa message) → aman fail-closed; cursor pagination
 * N7 chat row TIDAK dibuat utk JID @newsletter (regresi N17 v4000 tetap hijau)
 *
 * Catatan jalur (spec §3): jalur runtime ASLI utk arsip = messages.upsert pool.js
 * (butuh socket Baileys nyata). E2E jalan dgn WA_DISABLED=1 (tanpa Baileys), jadi
 * archiveNewsletterMessage di-trigger in-process — KODE PANGGIL PERSIS pool.js
 * (try/catch + { sock } — sock=null di E2E → newsletterMetadata skip + media
 * metadata-only per D2/D6). Guard skip @newsletter di processIncomingMessage (D3)
 * diuji via N1e + regresi N17 e2e-v4000.
 *
 * Cara jalan (dari repo root):
 *   cp prisma/data/saas-v3.db /tmp/saas-v3-e2e.db
 *   && npx prisma db execute --file prisma/migrations/2026092613000000_channel_archive/migration.sql \
 *        --url file:/tmp/saas-v3-e2e.db  (apply additive ke copy)
 *   && insert row bookkeeping _prisma_migrations (pola proven v3.9.x/v4.0.0)
 *   && PORT=5099 DATABASE_URL=file:/tmp/saas-v3-e2e.db WA_DISABLED=1 \
 *        E2E_OK_SEND=1 E2E_DEBUG_INBOUND=1 node src/server.js &
 *   node scripts/e2e-reset-superadmin.cjs && set -a && . ./.env && set +a && node scripts/e2e-v4100.cjs
 */
const REPO = '/home/kanakxxx/.openclaw/workspace/wa-cs-hub-saas-v3'
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:5099'
// KRITIS (lesson E2E v4100): dotenv .env berisi DATABASE_URL PROD → service di bawah
// (src/services/channelArchive.js → src/prisma.js) membaca process.env — kalaupun
// client utama dgn datasourceUrl copy, service tetap menembak PROD (gagal "table
// does not exist"). Karena itu env DATABASE_URL DIPIKSA ke copy SETELAH dotenv —
// seluruh proses (client utama + service) menunjuk copy DB yang sama.
const COPY_DB = 'file:/tmp/saas-v3-e2e.db'
require(REPO + '/node_modules/dotenv').config({ path: REPO + '/.env' })
process.env.DATABASE_URL = COPY_DB
const { PrismaClient } = require(REPO + '/node_modules/@prisma/client')
// WAJIB: tunjuk DB COPY — jangan pernah sentuh DB produksi dari script test ini
const prisma = new PrismaClient({ datasourceUrl: COPY_DB, log: ['error'] })

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
  // ═══ Setup: SA login + user tenant (pola v3924/v4000) ═══
  const sa = await api('POST', '/api/auth/login', { username: process.env.SUPERADMIN_USERNAME, password: process.env.SUPERADMIN_PASSWORD })
  check('S0 superadmin login (copy db)', sa.status === 200 && !!sa.data?.token, `status=${sa.status}`)
  const saTok = sa.data?.token
  if (!saTok) return process.exit(1)

  async function e2eLogin(username, password) {
    const r = await api('POST', '/api/auth/login', { username, password })
    return r.status === 200 ? r.data?.token : null
  }
  const { hashPassword } = require(REPO + '/src/auth')
  async function ensureE2EUser(username, role, tenantId) {
    const pw = 'e2e41pw-' + username
    const existing = await prisma.user.findFirst({ where: { username } })
    if (existing) {
      await prisma.user.update({ where: { id: existing.id }, data: { status: 'active', role, passwordHash: await hashPassword(pw) } })
    } else {
      await prisma.user.create({ data: { username, passwordHash: await hashPassword(pw), role, tenantId, status: 'active' } })
    }
    return pw
  }
  // t8 (Mazaya) = tenant uji; t10 (Klinik Parahita) = tenant lain utk uji isolasi
  const pwAdmin8 = await ensureE2EUser('e2e41adm8', 'admin', 8)
  const t8AdminTok = await e2eLogin('e2e41adm8', pwAdmin8)
  const pwCs8 = await ensureE2EUser('e2e41cs8', 'cs', 8)
  const t8CsTok = await e2eLogin('e2e41cs8', pwCs8)
  const pwAdmin10 = await ensureE2EUser('e2e41adm10', 'admin', 10)
  const t10AdminTok = await e2eLogin('e2e41adm10', pwAdmin10)
  check('S1 login admin t8 + cs t8 + admin t10 → token', !!t8AdminTok && !!t8CsTok && !!t10AdminTok, `adm8=${!!t8AdminTok} cs8=${!!t8CsTok} adm10=${!!t10AdminTok}`)
  if (!t8AdminTok) return process.exit(1)

  // Idempoten re-run: bersihkan arsip uji di COPY db only (tabel baru milik v4.1.0)
  await prisma.channelPost.deleteMany({})
  await prisma.channelArchive.deleteMany({})

  // ═══ Helper: trigger service langsung (kode panggil PERSIS pool.js jalur @newsletter;
  // sock=null → newsletterMetadata skip + media metadata-only, D2/D6) ═══
  const { archiveNewsletterMessage } = require(REPO + '/src/services/channelArchive')
  const sidSeq = { n: 0 }
  function newSid() { return `e2e41sid-${sidSeq.n++}` }

  // ═══════════ N1 — archive ter-create + post tersimpan (content match) ═══════════
  const JID1 = '120363410000000001@newsletter'
  const r1 = await archiveNewsletterMessage(8, 0, {
    key: { remoteJid: JID1, fromMe: false, id: newSid() },
    pushName: 'E2E41',
    message: { conversation: 'Jadwal Oktober tayang — postingan channel E2E41' },
    messageTimestamp: Math.floor(Date.now() / 1000),
  }, { sock: null })
  check('N1 archiveNewsletterMessage → archive+post ter-create', !!r1?.archive?.id && !!r1?.post?.id, `archive=${r1?.archive?.id} post=${r1?.post?.id}`)
  check('N1b nama fallback JID prefix (sock=null, D2)', r1?.archive?.name === JID1.split('@')[0], `name=${r1?.archive?.name}`)
  check('N1c post content match', r1?.post?.content === 'Jadwal Oktober tayang — postingan channel E2E41', `content=${(r1?.post?.content || '').slice(0, 50)}`)
  check('N1d fromMe=false default', r1?.post?.fromMe === false, `fromMe=${r1?.post?.fromMe}`)

  // N1-runtime: POST /api/wa/inbound @newsletter → handled=false (jalur guard TETAP
  // — arsip jalur runtime = messages.upsert pool.js, bukan dari endpoint debug ini)
  const n1in = await api('POST', '/api/wa/inbound', {
    tenantId: 8,
    messages: { key: { remoteJid: '120363410000009999@newsletter', fromMe: true }, message: { conversation: 'posting channel via inbound endpoint' } },
  }, saTok)
  check('N1e inbound endpoint @newsletter → 200 handled=false (tidak create chat)',
    n1in.status === 200 && n1in.data?.handled === false && n1in.data?.chatId === null,
    `status=${n1in.status} handled=${n1in.data?.handled}`)

  // ═══════════ N2 — dedupe by serverId (idempoten) ═══════════
  const JID2 = '120363410000000002@newsletter'
  const SID2 = 'e2e41-dup-sid-1'
  const r2a = await archiveNewsletterMessage(8, 0, {
    key: { remoteJid: JID2, fromMe: false, id: SID2 },
    message: { conversation: 'postingan dup test' },
  }, { sock: null })
  const r2b = await archiveNewsletterMessage(8, 0, {
    key: { remoteJid: JID2, fromMe: false, id: SID2 },
    message: { conversation: 'postingan dup test' },
  }, { sock: null })
  const cnt2 = await prisma.channelPost.count({ where: { archiveId: r2a?.archive?.id || -1, serverId: SID2 } })
  check('N2 dedupe serverId sama → count 1 (tidak dobel)', cnt2 === 1, `count=${cnt2}`)
  check('N2b re-run → deduped flag (idempoten skip)', !!r2a?.post?.id && r2b?.deduped === true, `r2a=${!!r2a?.post?.id} deduped=${r2b?.deduped}`)

  // ═══════════ N3 — fromMe=true + propName (D2) ═══════════
  const JID3 = '120363410000000003@newsletter'
  const r3 = await archiveNewsletterMessage(8, 0, {
    key: { remoteJid: JID3, fromMe: true, id: 'e2e41-fromme-1' },
    message: { conversation: 'postingan dari admin channel sendiri' },
  }, { sock: null })
  check('N3 fromMe=true → post tersimpan fromMe=true', !!r3?.post?.id && r3.post.fromMe === true, `fromMe=${r3?.post?.fromMe}`)

  const JID3B = '120363410000000003b@newsletter'
  const r3b = await archiveNewsletterMessage(8, 0, {
    key: { remoteJid: JID3B, fromMe: false, id: 'e2e41-propname-1' },
    message: { conversation: 'x' },
  }, { sock: null, propName: 'Channel Mazaya E2E41' })
  check('N3b propName dipakai sbg nama (D2)', r3b?.archive?.name === 'Channel Mazaya E2E41', `name=${r3b?.archive?.name}`)

  // ═══════════ N4 — GET /api/channels + GET /:id/posts (admin t8) ═══════════
  const n4 = await api('GET', '/api/channels', undefined, t8AdminTok)
  check('N4 GET /api/channels → 200 + channels[]', n4.status === 200 && Array.isArray(n4.data?.channels), `status=${n4.status} n=${n4.data?.channels?.length}`)
  const chan1 = (n4.data?.channels || []).find((c) => c.waJid === JID1)
  check('N4b archive N1 muncul (name/waJid/postCount)', !!chan1 && chan1.postCount === 1, `id=${chan1?.id} postCount=${chan1?.postCount}`)
  const n4p = chan1 ? await api('GET', `/api/channels/${chan1.id}/posts?limit=50`, undefined, t8AdminTok) : { status: 0, data: null }
  check('N4c GET posts → 200 + isi benar', n4p.status === 200 && (n4p.data?.posts || []).length === 1 && n4p.data.posts[0].content === 'Jadwal Oktober tayang — postingan channel E2E41',
    `status=${n4p.status} posts=${n4p.data?.posts?.length}`)
  check('N4d shape post (serverId/fromMe/mediaType null)', String(n4p.data?.posts?.[0]?.serverId || '').startsWith('e2e41sid-') && n4p.data?.posts?.[0]?.fromMe === false && n4p.data.posts[0].mediaType === null, '')

  // N4e — SA ?tenant= pola existing (impersonasi tenant 8)
  const n4sa = await api('GET', '/api/channels?tenant=8', undefined, saTok)
  check('N4e SA ?tenant=8 → 200 (pola existing)', n4sa.status === 200 && Array.isArray(n4sa.data?.channels), `status=${n4sa.status}`)
  const n4sa2 = await api('GET', '/api/channels', undefined, saTok)
  check('N4f SA TANPA ?tenant= → 400 (requireTenant)', n4sa2.status === 400, `status=${n4sa2.status}`)

  // ═══════════ N5 — isolasi tenant + admin-only ═══════════
  const n5a = await api('GET', `/api/channels/${chan1?.id || 1}/posts`, undefined, t10AdminTok)
  check('N5a admin tenant lain → 404 (tenant-scoped)', n5a.status === 404, `status=${n5a.status}`)
  const n5b = await api('GET', '/api/channels', undefined, t10AdminTok)
  check('N5b list tenant lain → kosong (isolasi)', n5b.status === 200 && (n5b.data?.channels || []).length === 0, `status=${n5b.status} n=${n5b.data?.channels?.length}`)
  const n5c = await api('GET', '/api/channels', undefined, t8CsTok)
  check('N5c CS token → 403 (admin-only, D5)', n5c.status === 403, `status=${n5c.status}`)
  const n5d = await api('GET', `/api/channels/${chan1?.id || 1}/posts`, undefined, t8CsTok)
  check('N5d CS posts → 403 (admin-only, D5)', n5d.status === 403, `status=${n5d.status}`)
  const n5e = await api('GET', '/api/channels')
  check('N5e tanpa token → 401', n5e.status === 401, `status=${n5e.status}`)

  // ═══════════ N6 — media post (D6) ═══════════
  const JID4 = '120363410000000004@newsletter'
  const r6 = await archiveNewsletterMessage(8, 0, {
    key: { remoteJid: JID4, fromMe: false, id: 'e2e41-media-1' },
    message: { imageMessage: { mimetype: 'image/jpeg' } }, // tanpa caption; sock=null → metadata saja (D6)
  }, { sock: null })
  check('N6 media post → arsip + mediaType image + content kosong', !!r6?.post?.id && r6.post.mediaType === 'image' && r6.post.content === '', `mediaType=${r6?.post?.mediaType} content="${r6?.post?.content}"`)
  check('N6b mediaMime terarsip', r6?.post?.mediaMime === 'image/jpeg', `mime=${r6?.post?.mediaMime}`)
  check('N6c mediaPath null (sock=null → metadata saja, D6)', r6?.post?.mediaPath === null, `mediaPath=${r6?.post?.mediaPath}`)
  const r6b = await archiveNewsletterMessage(8, 0, {
    key: { remoteJid: JID4, fromMe: false, id: 'e2e41-media-2' },
    message: { videoMessage: { mimetype: 'video/mp4', caption: 'promo video' } },
  }, { sock: null })
  check('N6d video dgn caption → content=caption + mediaType video', r6b?.post?.mediaType === 'video' && r6b?.post?.content === 'promo video', `type=${r6b?.post?.mediaType} content=${r6b?.post?.content}`)

  // N6e — fail-closed: pesan tanpa message (protocol event) → TIDAK crash
  const r6e = await archiveNewsletterMessage(8, 0, { key: { remoteJid: JID4, fromMe: false, id: 'e2e41-proto-1' } }, { sock: null })
  check('N6e protocol event (tanpa message) → aman', r6e === null || !!r6e?.post?.id, `ret=${JSON.stringify(r6e)?.slice(0, 60)}`)

  // N6f/g — cursor pagination: seed 3 post tambahan → limit + before bekerja
  for (let i = 0; i < 3; i++) {
    await archiveNewsletterMessage(8, 0, {
      key: { remoteJid: JID1, fromMe: false, id: newSid() },
      message: { conversation: `cursor post ${i}` },
    }, { sock: null })
  }
  const n4p2 = chan1 ? await api('GET', `/api/channels/${chan1.id}/posts?limit=2`, undefined, t8AdminTok) : { status: 0, data: null }
  check('N6f cursor limit=2 → 2 post terbaru + hasMore=true', n4p2.status === 200 && (n4p2.data?.posts || []).length === 2 && n4p2.data?.hasMore === true, `n=${n4p2.data?.posts?.length} hasMore=${n4p2.data?.hasMore}`)
  const nextBefore = n4p2.data?.nextBefore
  const n4p3 = nextBefore ? await api('GET', `/api/channels/${chan1.id}/posts?limit=50&before=${nextBefore}`, undefined, t8AdminTok) : { status: 0, data: null }
  check('N6g cursor before= → halaman lama (id lebih kecil, terbaru dulu)',
    n4p3.status === 200 && (n4p3.data?.posts || []).length >= 2 && Number(n4p3.data?.posts?.[0]?.id) < Number(n4p2.data?.posts?.[0]?.id),
    `next=${n4p3?.status} n=${(n4p3?.data?.posts || []).length}`)

  // ═══════════ N7 — chat row TIDAK dibuat utk JID @newsletter (regresi N17 v4000) ═══════════
  // NB: chat 7858 ("120363424886543307@newsletter") = SISA DATA LEGACY bug v4.0.0c
  // (sudah resolved, TIDAK queued) — ikut ter-copy ke DB. Test ini mengecek JID-baru
  // hasil jalur v4.1.0: TIDAK ada chat row yang dibuat dari pesan hari ini.
  const jidsNewsletter = [JID1, JID2, JID3, JID3B, JID4, '120363410000009999@newsletter']
  const chatRows = await prisma.chat.findMany({ where: { tenantId: 8, waJid: { in: jidsNewsletter } } })
  check('N7 TIDAK ada chat row utk JID @newsletter (D3)', chatRows.length === 0, `n=${chatRows.length}`)
  const msgRows = await prisma.message.count({ where: { chat: { tenantId: 8, waJid: { in: jidsNewsletter } } } })
  check('N7b TIDAK ada Message row utk channel (D3)', msgRows === 0, `n=${msgRows}`)
  const queueRows = await prisma.chat.count({ where: { tenantId: 8, waJid: { in: jidsNewsletter }, queuedAt: { not: null } } })
  check('N7c TIDAK ada chat newsletter masuk antrean (D3)', queueRows === 0, `n=${queueRows}`)

  console.log(`\n=== e2e-v4100: ${pass} PASS / ${fails.length} FAIL ===`)
  if (fails.length) { console.log('FAILED:', fails.join(' | ')); process.exitCode = 1 }
  await prisma.$disconnect()
  process.exit(process.exitCode || 0)
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })