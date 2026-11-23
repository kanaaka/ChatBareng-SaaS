#!/usr/bin/env node
/**
 * UNIT v4.6.16 — unwrap + extractText/detectMediaType + pesan yang dulu di-skip
 * ("empty-body-non-media") kini terpetakan. Latar bug Kasus NURHIDAYAH
 * (tenant-10, 2026-11-16): DM terakhir CS melewatkan krn ingest drop.
 */
'use strict'
const assert = require('assert')
const path = require('path')
const ROOT = path.resolve(__dirname, '..')
// stub heavy deps
const Module = require('module')
const stubs = new Map([
  [path.join(ROOT, 'src/prisma.js'), { $connect: async () => {} }],
  [path.join(ROOT, 'src/socket/broadcast.js'), { emitToTenant: () => {} }],
  [path.join(ROOT, 'src/services/systemLog.js'), { logInfo: () => {}, logWarn: () => {} }],
  [path.join(ROOT, 'src/services/textCrypto.js'), { encryptText: (s) => s, decryptTextSafe: (s) => s }],
])
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  let r
  try { r = Module._resolveFilename(request, parent) } catch { return origLoad(request, parent, isMain) }
  if (stubs.has(r)) return stubs.get(r)
  return origLoad(request, parent, isMain)
}
const pool = require(path.join(ROOT, 'src/wa/pool.js'))
const { unwrapNestedMessage, extractText, detectMediaType } = pool

const CASES = [
  // [nama, msg, expectedText, expectedMediaType]
  ['teks biasa', { message: { conversation: 'halo bang' } }, 'halo bang', null],
  ['extended', { message: { extendedTextMessage: { text: 'ok'} } }, 'ok', null],
  ['ephemeral-wrapped text', { message: { ephemeralMessage: { message: { conversation: 'dm 2FA-test' } } } }, 'dm 2FA-test', null],
  ['viewOnce text', { message: { viewOnceMessage: { message: { conversation: 'sekali lihat' } } } }, 'sekali lihat', null],
  ['viewOnce image', { message: { viewOnceMessageV2: { message: { imageMessage: { url: 'x' } } } } }, null, 'image'],
  ['contact vCard', { message: { contactMessage: { displayName: 'dr. Gigi Jakarta' } } }, '📇 dr. Gigi Jakarta', null],
  ['location', { message: { locationMessage: { name: 'Klinik Cabang', degreesLatitude: -6.2, degreesLongitude: 106.8 } } }, '📍 Klinik Cabang', null],
  ['button reply', { message: { buttonsResponseMessage: { selectedDisplayText: 'Ya, lanjut' } } }, 'Ya, lanjut', null],
  ['list reply', { message: { interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: JSON.stringify({ selectedDisplayText: 'Pilih Paket B' }) } } } }, 'Pilih Paket B', null],
  ['documentWithCaption', { message: { documentWithCaptionMessage: { message: { fileName: 'harga.pdf', caption: 'daftar harga' } } } }, 'daftar harga', 'document'],
  ['sticker', { message: { stickerMessage: { url: 'x' } } }, null, 'sticker'],
  ['protocol via viewOnce', { message: { viewOnceMessage: { message: { protocolMessage: { type: 'REVOKE' } } } } }, null, null],
  ['contact tanpa displayName', { message: { contactMessage: {} } }, null, null],
  ['location coords only', { message: { locationMessage: { degreesLatitude: -6.2, degreesLongitude: 106.8 } } }, '📍 -6.2,106.8', null],
  ['docWithCaption kosong', { message: { documentWithCaptionMessage: { message: {} } } }, null, 'document'],
  ['contactsArrayMessage', { message: { contactsArrayMessage: { contacts: [{ displayName: 'A' }, { displayName: 'B' }, { displayName: 'C' }, { displayName: 'D' }] } } }, '📇 4 kontak: A, B, C…', null],
  ['pollV2', { message: { pollCreationMessageV2: { name: 'Polling v2' } } }, '📊 Polling v2', null],
  ['templateButtonReply', { message: { templateButtonReplyMessage: { selectedDisplayText: 'Terkirim' } } }, 'Terkirim', null],
]
let pass = 0
for (const [name, msg, wantT, wantM] of CASES) {
  if (name.startsWith('protocol via viewOnce')) {
    // audit Kimi r2 [LOW]: assert EKSPRESIKAN — gate menangkap protocol terbungkus
    const deep = unwrapNestedMessage(msg.message)
    assert.strictEqual(pool.isProtocolLikeMessage({ message: deep }), true, 'gate harus nangkap protocol terbungkus')
    assert.strictEqual(extractText(msg), wantT)
    console.log('  ✓ protocol via viewOnce → gate menangkap (skip, bukan lift)')
    pass++
    continue
  }
  const t = extractText(msg)
  const d = detectMediaType(msg)
  assert.strictEqual(t, wantT, `text ${name}: dapat ${JSON.stringify(t)}`)
  assert.strictEqual(d, wantM, `media ${name}: dapat ${JSON.stringify(d)}`)
  console.log(`  ✓ ${name} → text=${JSON.stringify(t)} media=${JSON.stringify(d)}`)
  pass++
}
console.log(`UNIT PASS ✓ — ${pass}/${CASES.length} kasus (hardened)`)
process.exit(0)
