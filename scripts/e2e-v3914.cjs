/**
 * E2E v3.9.14 — Quote Reply (WhatsApp contextInfo)
 * Jalan terhadap DB COPY di port 5099 (WA_DISABLED=1) — produksi tidak tersentuh.
 * Pola: scripts/e2e-v3913.cjs.
 *
 * Skenario (spec §8): reply+quote roundtrip (snippet encrypted, decrypt-verify),
 * guard 400 (cross-chat/cross-tenant/purged/failed target), media+replyTo → 400,
 * extractQuote unit (media-quote included), read payload shape.
 */
const REPO = '/home/kanakxxx/.openclaw/workspace/wa-cs-hub-saas-v3'
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:5099'
require(REPO + '/node_modules/dotenv').config({ path: REPO + '/.env' })
const { PrismaClient } = require(REPO + '/node_modules/@prisma/client')
const { encryptText, decryptText } = require(REPO + '/src/services/textCrypto')
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
  // ── A. Setup: login tenant A (E2E QA) via impersonate SA? — SA impersonate pakai
  // /api/sa/impersonate/:tenantId. Tenant A = id dinamis dari seed. ──
  const tenants = await prisma.tenant.findMany({ where: { name: { in: ['E2E QA', 'E2E Other'] } } })
  const tA = tenants.find((t) => t.name === 'E2E QA')
  const tB = tenants.find((t) => t.name === 'E2E Other')
  if (!tA || !tB) { console.log('FAIL | seed hilang — jalankan /tmp/e2e-seed-quote.cjs dulu'); process.exit(1) }

  const sa = await api('POST', '/api/auth/login', { username: process.env.SUPERADMIN_USERNAME, password: process.env.SUPERADMIN_PASSWORD })
  check('A0 superadmin login', sa.status === 200 && !!sa.data?.token, `status=${sa.status}`)
  const saTok = sa.data?.token
  if (!saTok) return process.exit(1)

  const imp = await api('POST', `/api/sa/impersonate/${tA.id}`, {}, saTok)
  check('A1 impersonate tenant A', imp.status === 200 && !!imp.data?.token, `status=${imp.status} tenant=${tA.id}`)
  const tokA = imp.data?.token

  const chats = await prisma.chat.findMany({ where: { tenantId: tA.id, waJid: { startsWith: '628110000000' } }, select: { id: true, waJid: true } })
  const chatA1 = chats.find((c) => c.waJid === '6281100000001@s.whatsapp.net')
  const chatA2 = chats.find((c) => c.waJid === '6281100000005@s.whatsapp.net')
  const chatB = await prisma.chat.findFirst({ where: { tenantId: tB.id, waJid: '6282200000002@s.whatsapp.net' } })
  const msgIn1 = await prisma.message.findFirst({ where: { chatId: chatA1.id, waMessageId: 'E2EQIN1' } })
  const msgOut1 = await prisma.message.findFirst({ where: { chatId: chatA1.id, waMessageId: 'E2EQOUT1' } })
  const msgFailed = await prisma.message.findFirst({ where: { chatId: chatA1.id, status: 'failed' } })
  const msgPurged = await prisma.message.findFirst({ where: { chatId: chatA1.id, purged: true } })
  const msgMedia = await prisma.message.findFirst({ where: { chatId: chatA1.id, waMessageId: 'E2EQIN4' } })
  const msgCrossChat = await prisma.message.findFirst({ where: { chatId: chatA2.id, waMessageId: 'E2EQX1' } })
  const msgCrossTenant = await prisma.message.findFirst({ where: { chatId: chatB.id, waMessageId: 'E2EQT1' } })
  check('A2 seed rows ada', !!(chatA1 && chatA2 && chatB && msgIn1 && msgFailed && msgPurged && msgMedia && msgCrossChat && msgCrossTenant), `chatA1=${chatA1?.id}`)

  // ── B. Reply + quote → 200; row punya quoted cols; snippet terenkripsi & decrypt-verify ──
  const QTEXT = 'Balasan dengan quote\ndua baris — verifikasi multiline'
  const r1 = await api('POST', `/api/chats/${chatA1.id}/reply`, { content: QTEXT, replyToMessageId: msgIn1.id }, tokA)
  check('B1 reply+quote → 200', r1.status === 200, `status=${r1.status} body=${JSON.stringify(r1.data).slice(0, 160)}`)
  const replyRow = await prisma.message.findUnique({ where: { id: r1.data?.message?.id } })
  check('B2 row punya quotedWaMessageId=target', replyRow?.quotedWaMessageId === msgIn1.waMessageId, `got=${replyRow?.quotedWaMessageId} want=${msgIn1.waMessageId}`)
  check('B3 quotedParticipantJid null (1:1)', replyRow?.quotedParticipantJid == null, `got=${replyRow?.quotedParticipantJid}`)
  check('B4 quotedType=text', replyRow?.quotedType === 'text', `got=${replyRow?.quotedType}`)
  check('B5 quotedSnippet terenkripsi (enc:v1:)', typeof replyRow?.quotedSnippet === 'string' && replyRow.quotedSnippet.startsWith('enc:v1:'), `head=${String(replyRow?.quotedSnippet).slice(0, 12)}`)
  let roundtripOK = false
  try { roundtripOK = decryptText(replyRow.quotedSnippet) === 'Halo, mau tanya produk' } catch {}
  check('B6 snippet decrypt roundtrip = konten target', roundtripOK, `got=${roundtripOK ? decryptText(replyRow.quotedSnippet) : 'DECRYPT FAIL'}`)
  check('B7 waMessageId nyata ter-set (WA_DISABLED tetap simpan failed?)', typeof replyRow?.waMessageId === 'string' || replyRow?.waMessageId === null, `waMessageId=${replyRow?.waMessageId}`)
  check('B8 status sent atau failed (WA off pola existing)', ['sent', 'failed'].includes(replyRow?.status), `status=${replyRow?.status}`)

  // ── C. Read payload: GET /:id — quoted shape plaintext + dbMessageId; absent saat null ──
  const g1 = await api('GET', `/api/chats/${chatA1.id}`, undefined, tokA)
  const payMsg = (g1.data?.messages || []).find((m) => m.id === replyRow.id)
  check('C1 GET detail → 200 + pesan ada', g1.status === 200 && !!payMsg, `status=${g1.status}`)
  check('C2 quoted shape lengkap', payMsg?.quoted && payMsg.quoted.waMessageId === msgIn1.waMessageId && payMsg.quoted.snippet === 'Halo, mau tanya produk' && payMsg.quoted.type === 'text' && payMsg.quoted.dbMessageId === msgIn1.id && 'participantJid' in payMsg.quoted, JSON.stringify(payMsg?.quoted))
  const plainMsg = (g1.data?.messages || []).find((m) => m.waMessageId === 'E2EQOUT1')
  check('C3 pesan tanpa quote → quoted null/absent', plainMsg && (plainMsg.quoted === null || plainMsg.quoted === undefined), `quoted=${JSON.stringify(plainMsg?.quoted)}`)

  // ── D. Guards 400: cross-chat / cross-tenant / purged / failed target ──
  const d1 = await api('POST', `/api/chats/${chatA2.id}/reply`, { content: 'cross chat', replyToMessageId: msgIn1.id }, tokA)
  check('D1 cross-chat target → 400', d1.status === 400, `status=${d1.status}`)
  const d2 = await api('POST', `/api/chats/${chatA1.id}/reply`, { content: 'cross tenant', replyToMessageId: msgCrossTenant.id }, tokA)
  check('D2 cross-tenant target → 400', d2.status === 400, `status=${d2.status}`)
  const d3 = await api('POST', `/api/chats/${chatA1.id}/reply`, { content: 'purged', replyToMessageId: msgPurged.id }, tokA)
  check('D3 purged target → 400', d3.status === 400, `status=${d3.status}`)
  const d4 = await api('POST', `/api/chats/${chatA1.id}/reply`, { content: 'failed', replyToMessageId: msgFailed.id }, tokA)
  check('D4 failed target (tanpa waMessageId) → 400', d4.status === 400, `status=${d4.status}`)
  const d5 = await api('POST', `/api/chats/${chatA1.id}/reply`, { content: 'idsalah', replyToMessageId: 999999999 }, tokA)
  check('D5 target tidak ada → 400', d5.status === 400, `status=${d5.status}`)
  const d6 = await api('POST', `/api/chats/${chatA1.id}/reply`, { content: 'negatif', replyToMessageId: -5 }, tokA)
  check('D6 replyToMessageId invalid (negatif) → 400', d6.status === 400, `status=${d6.status}`)

  // ── E. Media route + replyToMessageId → 400 ──
  const e1 = await api('POST', `/api/chats/${chatA1.id}/media`, { replyToMessageId: msgIn1.id }, tokA)
  check('E1 media JSON (no file) → 400 (bukan quote path)', e1.status === 400, `status=${e1.status}`)
  // multipart dgn file + replyToMessageId → harus 400 karena replyTo disertakan
  const boundary = '----e2equoteboundary42'
  const mp = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="replyToMessageId"',
    '',
    String(msgIn1.id),
    `--${boundary}`,
    'Content-Disposition: form-data; name="file"; filename="e2e.png"',
    'Content-Type: image/png',
    '',
    'PNGDATA',
    `--${boundary}--`,
    '',
  ].join('\r\n')
  const e2 = await fetch(`${BASE}/api/chats/${chatA1.id}/media`, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + tokA, 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: mp,
  })
  const e2body = await e2.json().catch(() => null)
  check('E2 media multipart + replyToMessageId → 400 eksplisit', e2.status === 400 && /quote|replyTo/i.test(e2body?.error || ''), `status=${e2.status} body=${JSON.stringify(e2body).slice(0, 120)}`)
  const e3 = await fetch(`${BASE}/api/chats/${chatA1.id}/media`, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + tokA, 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: mp.replace(String(msgIn1.id), ''),
  })
  check('E3 media multipart TANPA replyTo → bukan 400-quote (400 file kosong juga oke)', !(e3.status === 400 && /quote|replyTo/i.test((await e3.json().catch(() => ({})))?.error || '')), `status=${e3.status}`)

  // ── F. extractQuote unit-style (require pool) ──
  const pool = require(REPO + '/src/wa/pool')
  const ex1 = pool.extractQuote({
    key: { id: 'MSG1' },
    message: {
      extendedTextMessage: {
        text: 'reply text',
        contextInfo: {
          stanzaId: 'STANZA123',
          participant: '6281990000111@s.whatsapp.net',
          quotedMessage: { conversation: 'pesan asli customer' },
        },
      },
    },
  })
  check('F1 extractQuote text', ex1 && ex1.quotedWaMessageId === 'STANZA123' && ex1.quotedParticipantJid === '6281990000111@s.whatsapp.net' && ex1.quotedType === 'text' && ex1.snippetPlain === 'pesan asli customer', JSON.stringify(ex1))

  const ex2 = pool.extractQuote({
    key: { id: 'MSG2' },
    message: {
      extendedTextMessage: {
        text: 'reply foto',
        contextInfo: {
          stanzaId: 'STANZA456',
          participant: '6281990000111@s.whatsapp.net',
          quotedMessage: { imageMessage: { caption: 'katalog september' } },
        },
      },
    },
  })
  check('F2 extractQuote media-quote (caption)', ex2 && ex2.quotedWaMessageId === 'STANZA456' && ex2.quotedType === 'image' && ex2.snippetPlain === 'katalog september', JSON.stringify(ex2))

  const ex3 = pool.extractQuote({
    key: { id: 'MSG3' },
    message: {
      extendedTextMessage: {
        text: 'reply doc tanpa caption',
        contextInfo: {
          stanzaId: 'STANZA789',
          participant: null,
          quotedMessage: { documentMessage: { fileName: 'laporan.pdf' } },
        },
      },
    },
  })
  check('F3 extractQuote document fileName', ex3 && ex3.quotedWaMessageId === 'STANZA789' && ex3.quotedType === 'document' && ex3.snippetPlain === 'laporan.pdf' && ex3.quotedParticipantJid === null, JSON.stringify(ex3))

  const ex4 = pool.extractQuote({
    key: { id: 'MSG4' },
    message: {
      extendedTextMessage: {
        text: 'reply video tanpa caption',
        contextInfo: {
          stanzaId: 'STANZAVID',
          quotedMessage: { videoMessage: { mimetype: 'video/mp4' } },
        },
      },
    },
  })
  check('F4 extractQuote video tanpa caption → [Video]', ex4 && ex4.quotedType === 'video' && ex4.snippetPlain === '[Video]', JSON.stringify(ex4))

  const long = 'x'.repeat(500)
  const ex5 = pool.extractQuote({
    key: { id: 'MSG5' },
    message: {
      extendedTextMessage: {
        text: 'reply panjang',
        contextInfo: { stanzaId: 'STANZALONG', quotedMessage: { conversation: long } },
      },
    },
  })
  check('F5 snippet truncate 200', ex5 && ex5.snippetPlain.length === 200 && ex5.snippetPlain === 'x'.repeat(200), `len=${ex5?.snippetPlain?.length}`)

  const ex6 = pool.extractQuote({ key: { id: 'MSG6' }, message: { conversation: 'bukan quote' } })
  check('F6 bukan quote → null', ex6 === null, JSON.stringify(ex6))

  const ex7 = pool.extractQuote({
    key: { id: 'MSG7' },
    message: {
      extendedTextMessage: {
        text: 'stanza kosong',
        contextInfo: { stanzaId: '', quotedMessage: { conversation: 'x' } },
      },
    },
  })
  check('F7 stanzaId kosong → null', ex7 === null, JSON.stringify(ex7))

  // quotedColumnsFromExtract: snippet TERENKRIPSI di kolom
  const cols = pool.quotedColumnsFromExtract(ex1)
  check('F8 quotedColumnsFromEncrypt — snippet enc:v1: & decrypt balik', typeof cols.quotedSnippet === 'string' && cols.quotedSnippet.startsWith('enc:v1:') && decryptText(cols.quotedSnippet) === 'pesan asli customer' && cols.quotedWaMessageId === 'STANZA123', `keys=${Object.keys(cols).join(',')}`)

  // ── G. Quote outbound ke bubble media (image) — quotedType=image ──
  const gq = await api('POST', `/api/chats/${chatA1.id}/reply`, { content: 'Ini balasan untuk foto kak', replyToMessageId: msgMedia.id }, tokA)
  check('G1 reply quote media bubble → 200', gq.status === 200, `status=${gq.status}`)
  const gqRow = await prisma.message.findUnique({ where: { id: gq.data?.message?.id } })
  check('G2 quotedType=image + waMessageId target', gqRow?.quotedType === 'image' && gqRow?.quotedWaMessageId === msgMedia.waMessageId, `type=${gqRow?.quotedType} wmid=${gqRow?.quotedWaMessageId}`)
  let gqOK = false
  try { gqOK = decryptText(gqRow.quotedSnippet) === 'foto produk kak' } catch {}
  check('G3 snippet media decrypt roundtrip', gqOK, `got=${gqOK ? decryptText(gqRow.quotedSnippet) : 'FAIL'}`)
  const g1b = await api('GET', `/api/chats/${chatA1.id}`, undefined, tokA)
  const gqPay = (g1b.data?.messages || []).find((m) => m.id === gqRow.id)
  check('G4 read payload quoted type image', gqPay?.quoted?.type === 'image' && gqPay?.quoted?.dbMessageId === msgMedia.id, JSON.stringify(gqPay?.quoted))

  // ── H. Persist saat WA send GAGAL (WA_DISABLED) — quoted cols tetap tersimpan ──
  // (B1-B8 di WA_DISABLED — replyRow status 'failed' & quoted cols ada sudah membuktikan;
  //  eksplisitkan check bila status failed)
  if (replyRow.status === 'failed') {
    check('H1 WA gagal → quoted cols TETAP tersimpan', !!replyRow.quotedWaMessageId && !!replyRow.quotedSnippet, '')
  } else {
    check('H1 WA send sukses (mock path) → quoted cols ada', !!replyRow.quotedWaMessageId && !!replyRow.quotedSnippet, '')
  }

  // ── I. Regresi kecil: response JSON valid & message content plaintext (bukan enc:v1:) ──
  check('I1 content plaintext di response', payMsg?.content === QTEXT, `got=${String(payMsg?.content).slice(0, 40)}`)
  check('I2 quotedSnippet TIDAK bocor di payload API', !('quotedSnippet' in (payMsg || {})), Object.keys(payMsg || {}).join(','))

  // ── J. Tenant isolation: admin tenant B tidak bisa lihat chat tenant A ──
  const impB = await api('POST', `/api/sa/impersonate/${tB.id}`, {}, saTok)
  const tokB = impB.data?.token
  const j1 = await api('GET', `/api/chats/${chatA1.id}`, undefined, tokB)
  check('J1 tenant B → chat A 404', j1.status === 404, `status=${j1.status}`)
  const j2 = await api('POST', `/api/chats/${chatB.id}/reply`, { content: 'x', replyToMessageId: msgIn1.id }, tokB)
  check('J2 tenant B reply dgn target tenant A → 400 (tidak bocor)', j2.status === 400, `status=${j2.status}`)

  console.log(`=== RINGKASAN v3.9.14 ===`)
  console.log(`${pass} PASS, ${fails.length} FAIL`)
  await prisma.$disconnect()
  process.exit(fails.length ? 1 : 0)
}

main().catch(async (e) => {
  console.error('E2E fatal:', e)
  try { await prisma.$disconnect() } catch {}
  process.exit(1)
})