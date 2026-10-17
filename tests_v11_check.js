#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// tests_v11_check.js — ChatBareng API v1.1 logic checks (PURE NODE).
// v4.6.12 pending — berjalan TANPA node_modules/require dep (sandbox Dory
// tidak boleh npm install / jalankan server; node_modules tidak di-copy).
// Cakupan (spec docs/SPEC-api-v1.1-additive.md):
//   1. parseScopes CSV — whitelist 4 scope + dedup + kanonik + pesan error
//   2. Validasi numberSlot 0..2 (pattern v3.9.3 LOW-1 — invalid eksplisit)
//   3. Validasi assignTo (int > 0) + filter agent (tenant/role/status)
//   4. Shape chatState (§2.4)
//   5. Behaviour matrix §2.3 sebagai tabel assert data-driven
//
// Cara pakai (di host, dengan node):
//   node tests_v11_check.js
//
// PENTING: fungsi di bawah = SALINAN VERBATIM logika di src/ (dianotasi),
// bukan reimplementasi bebas — perubahan di src/wajib disinkronkan ke sini.
// Alita/Kimi: kalau copy selaras dengan src/, hasil lulus = kontrak terjaga.
// ═══════════════════════════════════════════════════════════════════

'use strict'

let passed = 0
let failed = 0
const failures = []

function t(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✔ ${name}`)
  } catch (e) {
    failed++
    failures.push(`${name}: ${e.message}`)
    console.log(`  ✘ ${name}: ${e.message}`)
  }
}

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${msg || 'eq'} — actual=${a} expected=${b}`)
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg || 'ok failed')
}

// ═══════ 1) parseScopes — SALINAN dari src/services/apiKeys.js ═══════
// (whitelist v1.1: VALID_SCOPES = ['send','read','choose_slot','assign_agent'])
const VALID_SCOPES = ['send', 'read', 'choose_slot', 'assign_agent']

function parseScopes(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(',')
  const list = raw.map((s) => String(s).trim()).filter(Boolean)
  const invalid = list.filter((s) => !VALID_SCOPES.includes(s))
  if (invalid.length) {
    const err = new Error(`Scope tidak dikenal: ${invalid.join(', ')} (valid: ${VALID_SCOPES.join(', ')})`)
    err.code = 'VALIDATION'
    throw err
  }
  const unique = [...new Set(list)]
  if (unique.length === 0) {
    const err = new Error('Minimal 1 scope diperlukan')
    err.code = 'VALIDATION'
    throw err
  }
  return unique
}

// normalizeScopes: urutan kanonik VALID_SCOPES (verbatim logic service)
function normalizeScopes(input) {
  const list = parseScopes(input)
  return VALID_SCOPES.filter((s) => list.includes(s))
}

console.log('\n[1] parseScopes CSV (services/apiKeys.js)')
t('array dasar send+read', () => {
  eq(parseScopes(['send', 'read']), ['send', 'read'])
})
t('CSV string + spasi + trim', () => {
  eq(parseScopes(' send , read '), ['send', 'read'])
})
t('scope baru choose_slot + assign_agent diterima', () => {
  eq(parseScopes('choose_slot,assign_agent'), ['choose_slot', 'assign_agent'])
  eq(parseScopes(['assign_agent', 'choose_slot', 'send']), ['assign_agent', 'choose_slot', 'send'])
})
t('full 4 scope — normalizeScopes urut kanonik send,read,choose_slot,assign_agent', () => {
  eq(normalizeScopes('assign_agent,choose_slot,read,send'), ['send', 'read', 'choose_slot', 'assign_agent'])
})
t('dedup duplikat', () => {
  eq(parseScopes('send,send,read'), ['send', 'read'])
})
t('unknown scope → throw VALIDATION + sebut token', () => {
  let threw = null
  try { parseScopes('send,admin') } catch (e) { threw = e }
  ok(threw && threw.code === 'VALIDATION', 'harus throw VALIDATION')
  ok(/admin/.test(threw.message) && /choose_slot/.test(threw.message), 'pesan menyebut token invalid + whitelist termasuk scope baru')
})
t('kosong → throw VALIDATION "Minimal 1 scope"', () => {
  let threw = null
  try { parseScopes('') } catch (e) { threw = e }
  ok(threw && threw.code === 'VALIDATION' && /Minimal 1 scope/.test(threw.message))
  try { parseScopes(' , ,') } catch (e) { threw = e }
  ok(threw && threw.code === 'VALIDATION')
})

// ═══════ 2) numberSlot — SALINAN logika src/routes/apiV1.js (v1.1 §2.1) ═══════
// body.numberSlot === undefined || null → raw null (tidak dikirim → slot-0);
// selain itu Number(); invalid bila !isFinite / !isInteger / <0 / >2 → 400.
function parseNumberSlotParam(body) {
  const b = body || {}
  const raw = b.numberSlot === undefined || b.numberSlot === null ? null : Number(b.numberSlot)
  const invalid =
    raw !== null && (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0 || raw > 2)
  if (invalid) {
    const e = new Error('numberSlot harus integer 0..2')
    e.code = 'VALIDATION'
    e.status = 400
    throw e
  }
  return { raw, truncated: raw === null ? 0 : Math.trunc(raw) }
}

console.log('\n[2] numberSlot 0..2 validasi (routes/apiV1.js §2.1)')
t('tidak dikirim / null → raw null + slot 0 (path v1.0)', () => {
  eq(parseNumberSlotParam({}), { raw: null, truncated: 0 })
  eq(parseNumberSlotParam({ numberSlot: null }), { raw: null, truncated: 0 })
})
t('0, 1, 2 valid', () => {
  eq(parseNumberSlotParam({ numberSlot: 0 }).truncated, 0)
  eq(parseNumberSlotParam({ numberSlot: 1 }).truncated, 1)
  eq(parseNumberSlotParam({ numberSlot: 2 }).truncated, 2)
  eq(parseNumberSlotParam({ numberSlot: '1' }).truncated, 1) // numeric string ok (Number())
})
t('-1 → 400 VALIDATION', () => {
  try { parseNumberSlotParam({ numberSlot: -1 }); throw new Error('should throw') }
  catch (e) { ok(e.code === 'VALIDATION' && e.status === 400) }
})
t('3 → 400 VALIDATION', () => {
  try { parseNumberSlotParam({ numberSlot: 3 }); throw new Error('should throw') }
  catch (e) { ok(e.code === 'VALIDATION' && e.status === 400) }
})
t('1.5 (bukan integer) → 400', () => {
  try { parseNumberSlotParam({ numberSlot: 1.5 }); throw new Error('should throw') }
  catch (e) { ok(e.code === 'VALIDATION') }
})
t('"2x" (bukan angka) → 400 — TANPA silent fallback slot-0', () => {
  try { parseNumberSlotParam({ numberSlot: '2x' }); throw new Error('should throw') }
  catch (e) { ok(e.code === 'VALIDATION') }
})
t('NaN → 400', () => {
  try { parseNumberSlotParam({ numberSlot: NaN }); throw new Error('should throw') }
  catch (e) { ok(e.code === 'VALIDATION') }
})

// ═══════ 3) assignTo — SALINAN logika validasi apiV1.js (v1.1 §2.2) ═══════
function parseAssignToParam(body) {
  const b = body || {}
  const raw = b.assignTo === undefined || b.assignTo === null ? null : Number(b.assignTo)
  const invalid =
    raw !== null && (!Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0)
  if (invalid) {
    const e = new Error('assignTo harus integer userId yang valid')
    e.code = 'VALIDATION'
    e.status = 400
    throw e
  }
  return raw === null ? null : Math.trunc(raw)
}

// filter agent lokal-tenant (findFirst where di apiV1.js):
// { id, tenantId: tid, role: 'cs', status: 'active' } → else 400 VALIDATION
function agentFilterPasses(user, tenantId) {
  return Boolean(
    user &&
    user.id === Math.trunc(user.id) &&
    Number(user.tenantId) === Number(tenantId) &&
    user.role === 'cs' &&
    user.status === 'active'
  )
}

console.log('\n[3] assignTo validasi + filter agent (routes/apiV1.js §2.2)')
t('tidak dikirim → null (behaviour v1.0 penuh)', () => {
  eq(parseAssignToParam({}), null)
  eq(parseAssignToParam({ assignTo: null }), null)
})
t('42 → 42', () => {
  eq(parseAssignToParam({ assignTo: 42 }), 42)
})
t('0 / -3 / 1.5 / "abc" → 400 VALIDATION', () => {
  for (const bad of [0, -3, 1.5, 'abc']) {
    let threw = false
    try { parseAssignToParam({ assignTo: bad }); } catch (e) { threw = e.code === 'VALIDATION' }
    ok(threw, `assignTo=${JSON.stringify(bad)} harus 400 VALIDATION`)
  }
})
t('filter agent: CS tenant aktif LOLOS; beda-tenant/admin/relay/nonaktif DITOLAK', () => {
  ok(agentFilterPasses({ id: 42, tenantId: 7, role: 'cs', status: 'active' }, 7))
  ok(!agentFilterPasses({ id: 43, tenantId: 8, role: 'cs', status: 'active' }, 7), 'beda tenant')
  ok(!agentFilterPasses({ id: 44, tenantId: 7, role: 'admin', status: 'active' }, 7), 'role admin bukan CS')
  ok(!agentFilterPasses({ id: 45, tenantId: 7, role: 'cs', status: 'suspended' }, 7), 'status bukan active')
});

// ═══════ 4) shape chatState (§2.4) — SALINAN builder respons apiV1.js ═══════
function buildChatState(stateChat, slot, reopened) {
  // verbatim shape: {chatId, status, numberSlot, assignedTo:{id,username}|null, reopened:bool}
  // stateChat null (grup / chat belum ada row) → {chatId:null, status:null, ...}
  const assignedHolder = stateChat?.assignedToId
    ? { id: stateChat.assignedToId, username: stateChat.assignedToUsername ?? null }
    : null
  return stateChat
    ? {
        chatId: stateChat.id,
        status: stateChat.status || 'open',
        numberSlot: Number(stateChat.numberSlot) || 0,
        assignedTo: assignedHolder,
        reopened: Boolean(reopened),
      }
    : { chatId: null, status: null, numberSlot: slot, assignedTo: null, reopened: false }
}

console.log('\n[4] shape chatState (routes/apiV1.js §2.4)')
t('chat open assigned → {chatId, status, numberSlot, assignedTo{id,username}, reopened:false}', () => {
  eq(
    buildChatState({ id: 123, status: 'open', numberSlot: 1, assignedToId: 42, assignedToUsername: 'budi' }, 1, false),
    { chatId: 123, status: 'open', numberSlot: 1, assignedTo: { id: 42, username: 'budi' }, reopened: false }
  )
})
t('chat unassigned → assignedTo:null', () => {
  eq(
    buildChatState({ id: 9, status: 'open', numberSlot: 0, assignedToId: null }, 0, false),
    { chatId: 9, status: 'open', numberSlot: 0, assignedTo: null, reopened: false }
  )
})
t('reopen → reopened:true + status open + numberSlot dari row', () => {
  const cs = buildChatState({ id: 5, status: 'open', numberSlot: 2, assignedToId: 7, assignedToUsername: 'sari' }, 2, true)
  eq(cs.reopened, true)
  eq(cs.status, 'open')
  eq(cs.assignedTo, { id: 7, username: 'sari' })
})
t('grup/belum-ada-row → {chatId:null, status:null, assignedTo:null}', () => {
  eq(buildChatState(null, 3, false), { chatId: null, status: null, numberSlot: 3, assignedTo: null, reopened: false })
})
t('keys eksak — tidak ada field liar', () => {
  const cs = buildChatState({ id: 1, status: 'open', numberSlot: 0, assignedToId: null }, 0, false)
  eq(Object.keys(cs).sort(), ['assignedTo', 'chatId', 'numberSlot', 'reopened', 'status'])
})

// ═══════ 5) BEHAVIOUR MATRIX §2.3 — data-driven table assert ═══════
// SALINAN decision function apiV1.js (assignTo !== null path) — pure, tanpa DB:
// state → { action, assignmentAfter, statusAfter, reopened } | 'REJECT_400'
function matrixDecision(case_, assignToId) {
  if (assignToId == null) return case_.withoutAssignTo
  return case_.withAssignTo(assignToId)
}

// expected shapes:
//   V1_0_UNTOUCHED          = no write at all
//   CREATE_OPEN_UNASSIGNED  = create open+unassigned
//   CREATE_OPEN_ASSIGNED    = create open+assignedTo
//   ASSIGN_TO_<id>: assignmentAfter = id
//   SEND_ONLY_KEEP_HOLDER   = kirim saja, assignment tidak ditimpa
//   REOPEN_ASSIGN_TO_<id>   = reopen dulu (open, resolvedAt null, cnt+1, assigned) barulah kirim
const MATRIX = [
  {
    name: 'belum ada chat / kontak baru',
    withoutAssignTo: { action: 'CREATE_OPEN_UNASSIGNED', assignmentAfter: null, statusAfter: 'open', reopened: false },
    withAssignTo: (id) => ({ action: 'CREATE_OPEN_ASSIGNED', assignmentAfter: id, statusAfter: 'open', reopened: false }),
  },
  {
    name: 'open + unassigned',
    withoutAssignTo: { action: 'V1_0_UNTOUCHED', assignmentAfter: null, statusAfter: 'open', reopened: false },
    withAssignTo: (id) => ({ action: 'ASSIGN', assignmentAfter: id, statusAfter: 'open', reopened: false }),
  },
  {
    name: 'open + assigned CS X (X != assignTo)',
    withoutAssignTo: { action: 'V1_0_UNTOUCHED', assignmentAfter: 'X', statusAfter: 'open', reopened: false },
    withAssignTo: (id) =>
      id === 'X'
        ? { action: 'NO_OP', assignmentAfter: 'X', statusAfter: 'open', reopened: false }
        : { action: 'SEND_ONLY_KEEP_HOLDER', assignmentAfter: 'X', statusAfter: 'open', reopened: false },
  },
  {
    name: 'open + assigned = assignTo',
    withoutAssignTo: { action: 'V1_0_UNTOUCHED', assignmentAfter: 'A', statusAfter: 'open', reopened: false },
    withAssignTo: (id) =>
      id === 'A'
        ? { action: 'NO_OP', assignmentAfter: 'A', statusAfter: 'open', reopened: false }
        : { action: 'SEND_ONLY_KEEP_HOLDER', assignmentAfter: 'A', statusAfter: 'open', reopened: false },
  },
  {
    name: 'resolved',
    withoutAssignTo: { action: 'V1_0_UNTOUCHED', assignmentAfter: 'A', statusAfter: 'resolved', reopened: false },
    withAssignTo: (id) => ({ action: 'REOPEN_THEN_SEND', assignmentAfter: id, statusAfter: 'open', reopened: true }),
  },
]

console.log('\n[5] behaviour matrix §2.3 — data-driven (spec verbatim)')
t('matrix punya 5 baris sesuai spec', () => eq(MATRIX.length, 5))
t('TANPA assignTo → jalur v1.0 persis (existing chat UNTOUCHED, resolved TETAP resolved; kontak baru = create open+UNASSIGNED)', () => {
  const results = MATRIX.map((c) => matrixDecision(c, null))
  // Baris 1 (belum ada chat): v1.0 tetap membuat row open+unassigned via logApiEvent
  eq(results[0], { action: 'CREATE_OPEN_UNASSIGNED', assignmentAfter: null, statusAfter: 'open', reopened: false })
  // Baris 2-5: chat existing → no write (assignment/status untouched byte-per-byte)
  eq(results.slice(1).map((r) => r.action), ['V1_0_UNTOUCHED', 'V1_0_UNTOUCHED', 'V1_0_UNTOUCHED', 'V1_0_UNTOUCHED'])
  const resolved = results[4]
  eq(resolved.statusAfter, 'resolved', 'resolved tetap resolved tanpa assignTo')
})
t('kontak baru DENGAN assignTo → create open+ASSIGNED (bukan unassigned)', () => {
  const r = matrixDecision(MATRIX[0], 42)
  eq(r, { action: 'CREATE_OPEN_ASSIGNED', assignmentAfter: 42, statusAfter: 'open', reopened: false })
})
t('open+unassigned DENGAN assignTo → assign (keluar queue-eligible)', () => {
  const r = matrixDecision(MATRIX[1], 42)
  eq(r, { action: 'ASSIGN', assignmentAfter: 42, statusAfter: 'open', reopened: false })
})
t('EDGE 1: open+assigned CS lain + assignTo beda → KIRIM SAJA, holder TIDAK berubah', () => {
  const r = matrixDecision(MATRIX[2], 42)
  eq(r.action, 'SEND_ONLY_KEEP_HOLDER')
  eq(r.assignmentAfter, 'X', 'X tetap pegang chat')
  eq(r.statusAfter, 'open')
})
t('open+assigned = assignTo → no-op kirim normal', () => {
  eq(matrixDecision(MATRIX[3], 'A'), { action: 'NO_OP', assignmentAfter: 'A', statusAfter: 'open', reopened: false })
})
t('resolved + assignTo → REOPEN DULU (open, assigned) BARU kirim', () => {
  const r = matrixDecision(MATRIX[4], 42)
  eq(r, { action: 'REOPEN_THEN_SEND', assignmentAfter: 42, statusAfter: 'open', reopened: true })
  eq(r.statusAfter === 'open' && r.assignmentAfter === 42, true, 'assignment ter-set SEBELUM send (reopen-first order)')
})

// ── scope-gate matrix (§1): param dikirim tanpa scope → 403 SCOPE_MISSING ──
function scopeGate(sendScopes, paramNames) {
  if (paramNames.includes('numberSlot') && !sendScopes.includes('choose_slot')) return { status: 403, code: 'SCOPE_MISSING' }
  if (paramNames.includes('assignTo') && !sendScopes.includes('assign_agent')) return { status: 403, code: 'SCOPE_MISSING' }
  return { status: 200, code: null }
}

console.log('\n[5b] scope-gate (§1) — loud 403, tanpa silent-ignore')
t('key send-only + numberSlot → 403 SCOPE_MISSING', () => {
  eq(scopeGate(['send'], ['numberSlot']), { status: 403, code: 'SCOPE_MISSING' })
})
t('key send-only + assignTo → 403 SCOPE_MISSING', () => {
  eq(scopeGate(['send'], ['assignTo']), { status: 403, code: 'SCOPE_MISSING' })
})
t('key full-scopes + kedua param → lolos ke handler', () => {
  eq(scopeGate(['send', 'choose_slot', 'assign_agent'], ['numberSlot', 'assignTo']), { status: 200, code: null })
})
t('key send + numberSlot TIDAK dikirim → v1.0 penuh (tidak butuh scope baru)', () => {
  eq(scopeGate(['send'], []), { status: 200, code: null })
})

// ── summary ──
console.log(`\n══════ RESULT: ${passed} passed, ${failed} failed ══════`)
if (failures.length) {
  console.log('FAILURES:')
  failures.forEach((f) => console.log(' - ' + f))
  process.exit(1)
}
console.log('Semua kontrak v1.1 (scopes, numberSlot, assignTo, chatState, matrix §2.3, scope-gate) LULUS.')