// Offline test harness: parser Cekat.AI CSV → konversi → struktur payload.
// TANPA DB, TANPA server — hanya memverifikasi cekatCsv.js + cekatConverter.js
// terhadap file referensi 2.924 rows (angka wajib: 2.509 WA, 415 skip non-WA,
// 15 first_message kosong — sesuai converter Python terbukti 2026-09-21).
//
// Run: node scripts/test-cekat-parser.js
// READ-ONLY terhadap file referensi; tidak menulis apa pun ke DB.

const fs = require('fs')
const { parseCekatCsv } = require('../src/services/cekatCsv')
const { convertCekatRows } = require('../src/services/cekatConverter')

const SRC =
  '/home/kanakxxx/.openclaw/workspace/media/inbound/openclaw-staged-3ba36d68-e701-434a-b29f-0222dd90ccd0/conversations_export_1789961471429---ac120c8e-a649-4224-bde6-084e1346b4b2.csv'

const buf = fs.readFileSync(SRC)
const rows = parseCekatCsv(buf)
const { chats, skipped } = convertCekatRows(rows)

const emptyFirstMessage = chats.filter(
  (c) => c.messages[0].content === '[Pesan pertama tidak tersedia di export Cekat.AI]'
).length

console.log('rows total          :', rows.length)
console.log('chats (WA kandidat) :', chats.length)
console.log('skipped nonWhatsApp :', skipped.nonWhatsApp)
console.log('skipped noPhone     :', skipped.noPhone)
console.log('empty first_message :', emptyFirstMessage)

const first = chats[0]
console.log('first chat          :', JSON.stringify(
  { chatId: first.chatId, contactName: first.contactName, createdAt: first.createdAt }, null, 0
))

let ok = true
function expect(name, got, want) {
  const pass = got === want
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}: got=${got} want=${want}`)
  if (!pass) ok = false
}

expect('rowsTotal', rows.length, 2924)
expect('chats WA', chats.length, 2509)
expect('skip nonWhatsApp', skipped.nonWhatsApp, 415)
expect('empty first_message', emptyFirstMessage, 15)
expect('first.chatId', first.chatId, '6281330909131@s.whatsapp.net')
expect('first.contactName', first.contactName, 'Ummu Aisha')
expect('first.createdAt', first.createdAt, '2026-09-21T02:54:56.000Z')
expect('first.status', first.status, 'resolved')
expect('first.tags[0].name', first.tags[0].name, 'Import CekatAI')
expect('first.tags[0].color', first.tags[0].color, '#6366F1')
expect('first.messages.length', first.messages.length, 1)
expect('first msg direction', first.messages[0].direction, 'in')
expect('first msg senderName', first.messages[0].senderName, 'Ummu Aisha')
expect('lastMessageAt', first.lastMessageAt, '2026-09-21T03:25:01.215Z')
expect('payload.format', 'wa-cs-hub-history', 'wa-cs-hub-history')

// Idempotency struktur: dua konversi file sama → chatId set identik (urutan file stabil)
const second = convertCekatRows(parseCekatCsv(buf)).chats
expect('deterministic length', second.length, chats.length)
expect(
  'deterministic first chatId',
  second[0].chatId,
  chats[0].chatId
)

console.log(ok ? '\nALL CHECKS PASS' : '\nCHECKS FAILED')
process.exit(ok ? 0 : 1)