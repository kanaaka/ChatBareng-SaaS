// v3.8 — Masa aktif tenant (subscription validity) — shared service.
// Sumber kebenaran perhitungan validityState (backend & response SA + /auth/me).
// Enforcement READ-ONLY per keputusan owner 15:30 (spec v3.8 §B):
//   - expired → tenant tetap bisa login + GET/read; SEMUA route NON-GET diblokir.
//   - validUntil null = Lifetime (tanpa batas) — default existing tenants.
//   - validFrom future = not_started (write diblok, read jalan).
// Suspend manual TETAP lebih kuat: suspended = gak bisa login sama sekali
// (ditangani di login route — JANGAN auto-un-suspend di sini).
const prisma = require('../prisma')

// Grace: sisa ≤ 7 hari → state "expiring" (chip kuning SuperAdmin).
const EXPIRING_WINDOW_DAYS = 7

/**
 * validityState(tenant, now = new Date()) — computed state murni.
 * @param {object|null} tenant row dengan validFrom/validUntil (Date|null)
 * @returns {'lifetime'|'active'|'expiring'|'expired'|'not_started'}
 */
function validityState(tenant, now = new Date()) {
  if (!tenant) return 'lifetime'
  const from = tenant.validFrom ? new Date(tenant.validFrom) : null
  const until = tenant.validUntil ? new Date(tenant.validUntil) : null
  // Lifetime: validUntil null (validFrom boleh ada utk catatan)
  if (!until) return 'lifetime'
  if (from && from.getTime() > now.getTime()) return 'not_started'
  if (until.getTime() < now.getTime()) return 'expired'
  const daysLeft = (until.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)
  if (daysLeft <= EXPIRING_WINDOW_DAYS) return 'expiring'
  return 'active'
}

/** Read-only blocked? true = tulis ditolak (expired / not_started). */
function isReadOnly(state) {
  return state === 'expired' || state === 'not_started'
}

/** Error code per state (dipakai middleware + low-level guard). */
function codeFor(state) {
  return state === 'not_started' ? 'SUBSCRIPTION_NOT_STARTED' : 'SUBSCRIPTION_EXPIRED'
}

/**
 * getSubscription(tenantId) → { state, validFrom, validUntil } | null.
 * null = tenant tidak ada (caller: JANGAN blokir — isolasi default-deny sudah
 * dipegang requireTenant; null hanya terjadi utk super_admin tanpa ?tenant=).
 */
async function getSubscription(tenantId) {
  const tid = Number(tenantId)
  if (!Number.isFinite(tid) || tid <= 0) return null
  const tenant = await prisma.tenant.findUnique({
    where: { id: tid },
    select: { validFrom: true, validUntil: true },
  })
  if (!tenant) return null
  const state = validityState(tenant)
  return {
    state,
    validFrom: tenant.validFrom ? tenant.validFrom.toISOString() : null,
    validUntil: tenant.validUntil ? tenant.validUntil.toISOString() : null,
  }
}

/** serialize validity fields utk list SA (computed + ISO string). */
function validityToJson(tenant, now = new Date()) {
  return {
    validFrom: tenant.validFrom ? new Date(tenant.validFrom).toISOString() : null,
    validUntil: tenant.validUntil ? new Date(tenant.validUntil).toISOString() : null,
    validityState: validityState(tenant, now),
  }
}

// ─── PUT /api/sa/tenants/:id/validity — preset engine ───────────────
// body: { preset: '30d'|'1y'|'lifetime'|'custom', startDate?: ISO, endDate?: ISO }
// - lifetime → validUntil = null (validFrom = startDate || existing || null)
// - 30d/1y   → validFrom = startDate || now; validUntil = validFrom + durasi
// - custom   → endDate wajib > startDate (400 kalau tidak)
const PRESETS = ['30d', '1y', 'lifetime', 'custom']

function applyValidityPreset(tenant, body) {
  const preset = String(body.preset || '').toLowerCase()
  if (!PRESETS.includes(preset)) {
    return { error: `Preset harus salah satu: ${PRESETS.join(', ')}` }
  }
  const now = new Date()
  let start = null
  if (body.startDate != null && body.startDate !== '') {
    start = new Date(body.startDate)
    if (isNaN(start.getTime())) return { error: 'startDate tidak valid (ISO date)' }
  }
  let end = null
  if (body.endDate != null && body.endDate !== '') {
    end = new Date(body.endDate)
    if (isNaN(end.getTime())) return { error: 'endDate tidak valid (ISO date)' }
  }

  if (preset === 'lifetime') {
    // validFrom boleh diset utk catatan (startDate explicit ATAU existing)
    return { data: { validFrom: start || (tenant.validFrom ? new Date(tenant.validFrom) : null), validUntil: null } }
  }

  if (preset === '30d' || preset === '1y') {
    const from = start || now
    const until = new Date(from.getTime())
    if (preset === '30d') until.setUTCDate(until.getUTCDate() + 30)
    else until.setUTCFullYear(until.getUTCFullYear() + 1)
    return { data: { validFrom: from, validUntil: until } }
  }

  // custom — wajib endDate; startDate opsional (default = existing validFrom || now)
  if (!end) return { error: 'endDate wajib untuk preset custom' }
  const from = start || (tenant.validFrom ? new Date(tenant.validFrom) : now)
  if (end.getTime() <= from.getTime()) {
    return { error: 'endDate harus SETELAH startDate' }
  }
  return { data: { validFrom: from, validUntil: end } }
}

module.exports = {
  EXPIRING_WINDOW_DAYS,
  PRESETS,
  validityState,
  isReadOnly,
  codeFor,
  getSubscription,
  validityToJson,
  applyValidityPreset,
}