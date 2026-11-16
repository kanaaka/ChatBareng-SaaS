#!/usr/bin/env node
/**
 * UNIT TEST — API v1.2 route-order (fix v4.6.15b, PR #18)
 *
 * Root cause yang dicegah: `router.get('/numbers')` teregistrasi SETELAH
 * catch-all `router.use(404)` → Express mengeksekusi catch-all lebih dulu →
 * SEMUA request /numbers selalu 404 NOT_FOUND walau server sudah restart
 * (kasus nyata v4.6.15 di produksi, 2026-11-16).
 *
 * Test ini memuat router ASLI (src/routes/apiV1.js) dengan dependensi
 * berat di-stub via interseksi Module._load (tanpa DB/sesi WhatsApp),
 * lalu memverifikasi urutan registrasi + kontrak endpoint:
 *
 *   A. GET /api/v1/numbers + key ber-scope choose_slot → 200 {numbers:[…]}
 *   B. GET /api/v1/numbers tanpa key                  → 401 UNAUTHORIZED
 *      (ini SINYAL DEPLOY: 401 = route eksis; 404 = masih kode lama)
 *   C. GET /api/v1/<path-tak-dikenal> + key           → 404 NOT_FOUND
 *      (catch-all TETAP berlaku untuk path lain)
 *
 * Jalankan dari repo root:
 *   node scripts/unit-api-v1-numbers-routeorder.cjs
 * Tanpa dependency baru — Node bawaan + express yang sudah ada.
 */
'use strict'

const path = require('path')
const http = require('http')
const assert = require('assert')

const ROOT = path.resolve(__dirname, '..')

// ── Sinyal cepat: urutan registrasi harus /numbers DI ATAS catch-all ──
const src = require('fs').readFileSync(path.join(ROOT, 'src/routes/apiV1.js'), 'utf8')
const idxNumbers = src.indexOf("router.get('/numbers'")
const idxCatchAll = src.indexOf('// Semua method/paths lain di bawah /api/v1')
assert.ok(idxCatchAll !== -1, 'catch-all 404 tidak ditemukan')
assert.ok(idxNumbers !== -1, "route /numbers tidak ditemukan")
assert.ok(idxNumbers < idxCatchAll, 'ROUTE ORDER SALAH: /numbers teregistrasi SETELAH catch-all 404 (akan di-shadow)')
console.log('  [A0] Urutan registrasi: /numbers DI ATAS catch-all 404 ✓')

// ── Stub dependensi berat (interseksi Module._load — andal lintas resolusi) ──
const stubs = new Map([
  [path.join(ROOT, 'src/prisma.js'), {
    tenant: { findUnique: async () => null },
    chat: { findFirst: async () => null },
    $queryRawUnsafe: async () => [],
  }],
  [path.join(ROOT, 'src/socket/broadcast.js'), { emitToTenant: () => {} }],
  [path.join(ROOT, 'src/services/apiKeys.js'), {
    // key stub utama: scopes choose_slot + send, plan gate OFF, rate OK.
    // audit Gemini r1: key TANPA choose_slot (scope lain ada) → 403 SCOPE_MISSING
    // harus ditgetest juga (bukan 200 diam-diam).
    verify: async (raw) => {
      const scopes = String(raw || '').startsWith('cbk_live_noslot') ? 'send' : 'choose_slot,send'
      return { apiKey: { id: 1, tenantId: 1, scopes, planGated: false } }
    },
    markUsed: () => {},
    checkRate: () => ({ allowed: true, retryAfter: 60 }),
    sha256Hex: (s) => s,
  }],
  [path.join(ROOT, 'src/services/systemLog.js'), { logInfo: () => {}, logWarn: () => {} }],
  [path.join(ROOT, 'src/wa/pool.js'), {
    listTenantNumbers: async () => ([
      { slot: 0, label: 'Utama', _synthetic: false },
      { slot: 1, label: 'Sales', _synthetic: false },
    ]),
    getStatusForTenant: (t, s) => (
      s === 0
        ? { connected: true, status: 'connected', phoneNumber: '6282257176832' }
        : { connected: false, status: null, phoneNumber: null }
    ),
    sendMessageForTenant: async () => { throw new Error('not used here') },
  }],
  [path.join(ROOT, 'src/services/textCrypto.js'), { encryptText: () => 'x', decryptTextSafe: () => '' }],
])

const Module = require('module')
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  let resolved
  try { resolved = Module._resolveFilename(request, parent) } catch { return origLoad(request, parent, isMain) }
  if (stubs.has(resolved)) return stubs.get(resolved)
  return origLoad(request, parent, isMain)
}

// ── Server uji: mount router ASLI di /api/v1 (pola server.js) ──
const express = require('express')
const { router } = require(path.join(ROOT, 'src/routes/apiV1.js'))
const app = express()
app.use(express.json())
app.use('/api/v1', router)
const server = app.listen(0, '127.0.0.1')


const got = (p, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({
    host: '127.0.0.1',
    port: server.address().port,
    path: p,
    headers,
    method: 'GET',
  }, (res) => {
    let body = ''
    res.on('data', (d) => { body += d })
    res.on('end', () => {
      let json = null
      try { json = JSON.parse(body) } catch {}
      resolve({ status: res.statusCode, json, body })
    })
  })
  req.on('error', reject)
  req.end()
})

const KEY = 'cbk_live_unitstub0000000000000000000000000000000000000000'
const AUTH = { Authorization: 'Bearer ' + KEY }

;(async () => {
  await new Promise((res) => server.once('listening', res))
  try {
    // A. key valid + scope choose_slot → 200, numbers penuh label/phone
    const a = await got('/api/v1/numbers', AUTH)
    assert.strictEqual(a.status, 200, 'A: harus 200 (dapat ' + a.status + ' ' + a.body + ')')
    assert.ok(Array.isArray(a.json.numbers), 'A: numbers harus array')
    const slot0 = a.json.numbers.find((n) => Number(n.slot) === 0)
    assert.ok(slot0 && slot0.label === 'Utama', 'A: slot 0 harus label "Utama" (dapat ' + JSON.stringify(a.json.numbers).slice(0, 160) + ')')
    assert.ok(slot0.phoneNumber === '6282257176832' && slot0.connected === true, 'A: slot 0 harus phone+connected dari status live')
    assert.ok(a.json.numbers.some((n) => Number(n.slot) === 2), 'A: slot 2 sintetis harus ikut disertakan')
    console.log('  [A ] GET /numbers + key (choose_slot) → 200 ' + JSON.stringify(a.json.numbers.map((n) => { return { slot: n.slot, label: n.label, phone: n.phoneNumber, connected: n.connected } })) + ' ✓')

    // B. tanpa key → 401 UNAUTHORIZED (BUKAN 404 — sinyal route eksis)
    const b = await got('/api/v1/numbers')
    assert.strictEqual(b.status, 401, 'B: tanpa key harus 401 (dapat ' + b.status + ')')
    assert.strictEqual(b.json.code, 'UNAUTHORIZED', 'B: code = UNAUTHORIZED')
    console.log('  [B ] GET /numbers tanpa key → 401 ' + JSON.stringify(b.json) + ' ✓ (sinyal deploy: 401 = route eksis)')

    // C. path tak dikenal + key → 404 NOT_FOUND (catch-all tetap jalan)
    const c = await got('/api/v1/bukan-endpoint', AUTH)
    assert.strictEqual(c.status, 404, 'C: path asing harus 404 (dapat ' + c.status + ')')
    assert.strictEqual(c.json.code, 'NOT_FOUND', 'C: code = NOT_FOUND')
    console.log('  [C ] GET /api/v1/bukan-endpoint + key → 404 ' + JSON.stringify(c.json) + ' ✓ (catch-all tetap berlaku)')

    // D. key valid TANPA scope choose_slot → 403 SCOPE_MISSING (gate per-endpoint)
    const d = await got('/api/v1/numbers', { Authorization: 'Bearer cbk_live_noslotxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' })
    assert.strictEqual(d.status, 403, 'D: key tanpa choose_slot harus 403 (dapat ' + d.status + ')')
    assert.strictEqual(d.json.code, 'SCOPE_MISSING', 'D: code = SCOPE_MISSING (dapat ' + JSON.stringify(d.json) + ')')
    console.log('  [D ] GET /numbers + key tanpa choose_slot → 403 ' + JSON.stringify(d.json) + ' ✓ (scope gate per-endpoint)')

    console.log('UNIT PASS ✓ — 5/5 asersi lolos (urutan registrasi + kontrak endpoint + scope gate + field kontrak pool)')
    process.exit(0)
  } catch (e) {
    console.error('UNIT FAIL ✗ —', e.message)
    process.exit(1)
  } finally {
    server.close()
  }
})()
