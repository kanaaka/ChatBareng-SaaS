// ═══════════════════════════════════════════════════════════════════
// v3.9.13 — Public API v1: API key service (spec docs/spec-api-keys-v1.md).
// v4.6.12 pending (API v1.1) — scopes baru `choose_slot` + `assign_agent`
// (docs/SPEC-api-v1.1-additive.md §1): CSV di kolom `scopes` existing —
// TANPA migration DB. Scope = capability saja; behaviour per-request
// ditentukan param (`numberSlot`/`assignTo` di POST /api/v1/messages).
//
// Aturan KEAMANAN (locked):
// - Raw key TIDAK PERNAH disimpan di DB/log — hanya sha256 hex.
// - Raw key ditampilkan SEKALI di response create (UI: show-once + copy).
// - prefix = 12 char pertama raw key (identifikasi di UI tanpa bocor).
// - scopes = CSV subset dari send|read (P1; P2: groups|webhook).
// - Rate limit per-key in-memory Map (cukup utk P1 — reset per menit).
// ═══════════════════════════════════════════════════════════════════

const crypto = require('crypto')
const prisma = require('../prisma')

const KEY_PREFIX_LIVE = 'cbk_live_'
const VALID_SCOPES = ['send', 'read', 'choose_slot', 'assign_agent'] // P1 + API v1.1 (2026-10-17); P2 tambah 'groups', 'webhook'
const DEFAULT_RATE_PER_MIN = 60
const MAX_RATE_PER_MIN = 600

/** generate(tenantId, {name, scopes, ratePerMin, planGated, expiresAt, createdByUserId})
 * → { apiKey (row), rawKey (SEKALI ini saja — TIDAK disimpan/log) } */
async function generate({ tenantId, name, scopes, ratePerMin, planGated = true, expiresAt = null, createdByUserId }) {
  const tid = Number(tenantId)
  if (!Number.isFinite(tid) || tid <= 0) throw badRequest('Invalid tenantId')
  const creator = Number(createdByUserId)
  if (!Number.isFinite(creator) || creator <= 0) throw badRequest('Invalid createdByUserId')
  const cleanName = String(name || '').trim()
  if (!cleanName || cleanName.length > 80) throw badRequest('Nama key wajib diisi (1-80 karakter)')

  const scopeList = normalizeScopes(scopes)
  const rate = clampRate(ratePerMin)

  const raw = KEY_PREFIX_LIVE + crypto.randomBytes(32).toString('base64url')
  const keyHash = sha256Hex(raw)
  const prefix = raw.slice(0, 12)

  const apiKey = await prisma.apiKey.create({
    data: {
      tenantId: tid,
      name: cleanName,
      keyHash,
      prefix,
      scopes: scopeList.join(','),
      planGated: Boolean(planGated),
      ratePerMin: rate,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      createdByUserId: creator,
    },
  })
  return { apiKey, rawKey: raw }
}

/** parseScopes(input) → array scope valid (400 bila kosong/ada yang gak dikenal). */
function parseScopes(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(',')
  const list = raw.map((s) => String(s).trim()).filter(Boolean)
  const invalid = list.filter((s) => !VALID_SCOPES.includes(s))
  if (invalid.length) throw badRequest(`Scope tidak dikenal: ${invalid.join(', ')} (valid: ${VALID_SCOPES.join(', ')})`)
  const unique = [...new Set(list)]
  if (unique.length === 0) throw badRequest('Minimal 1 scope diperlukan')
  return unique
}

/** verify(rawKey) → { apiKey } | null (hash lookup — tanpa timing leak material). */
async function verify(rawKey) {
  const s = String(rawKey || '')
  if (!s.startsWith(KEY_PREFIX_LIVE)) return null
  const keyHash = sha256Hex(s)
  const found = await prisma.apiKey.findUnique({ where: { keyHash } })
  return found ? { apiKey: found } : null
}

/** markUsed(apiKeyId) — lastUsedAt update best-effort (fire-and-forget). */
function markUsed(apiKeyId) {
  prisma.apiKey
    .update({ where: { id: apiKeyId }, data: { lastUsedAt: new Date() } })
    .catch((e) => console.error('[ApiKey] lastUsedAt error (non-fatal):', e.message))
}

/** revoke(apiKeyId) → row | null (sudah revoked / tidak ada). Idempoten. */
async function revoke(apiKeyId) {
  const id = Number(apiKeyId)
  if (!Number.isFinite(id)) return null
  const row = await prisma.apiKey.findUnique({ where: { id } })
  if (!row || row.revokedAt) return row || null
  return prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } })
}

/** listByTenant(tenantId, includeRevoked=false) → rows TANPA keyHash (never out). */
async function listByTenant(tenantId, includeRevoked = false) {
  const where = { tenantId: Number(tenantId) }
  if (!includeRevoked) where.revokedAt = null
  const rows = await prisma.apiKey.findMany({
    where,
    orderBy: { id: 'desc' },
    select: {
      id: true,
      tenantId: true,
      name: true,
      prefix: true,
      scopes: true,
      planGated: true,
      ratePerMin: true,
      lastUsedAt: true,
      expiresAt: true,
      revokedAt: true,
      createdAt: true,
    },
  })
  return rows
}

/** rowToPublic(row) → JSON aman utk response (keyHash TIDAK PERNAH keluar). */
function rowToPublic(row) {
  if (!row) return null
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    prefix: row.prefix,
    scopes: String(row.scopes || '').split(',').filter(Boolean),
    planGated: row.planGated,
    ratePerMin: row.ratePerMin,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  }
}

// ── Per-key rate limiter (in-memory; P1 — multi-instance pakai store bersama di P3) ──
// bucket: apiKeyId → { windowStart, count }
const buckets = new Map()

/** checkRate(apiKey) → { allowed, retryAfter } — sliding 60s fixed window per key. */
function checkRate(apiKey) {
  const limit = Math.max(1, Number(apiKey?.ratePerMin) || DEFAULT_RATE_PER_MIN)
  const now = Date.now()
  const b = buckets.get(apiKey.id)
  if (!b || now - b.windowStart >= 60_000) {
    buckets.set(apiKey.id, { windowStart: now, count: 1 })
    // housekeeping ringan: buang bucket stale (lebih dari 2 window)
    if (buckets.size > 10000) {
      for (const [k, v] of buckets) {
        if (now - v.windowStart > 120_000) buckets.delete(k)
      }
    }
    return { allowed: true, retryAfter: 0 }
  }
  if (b.count >= Math.max(1, apiKey.ratePerMin)) {
    const retryAfter = Math.max(1, Math.ceil((b.windowStart + 60_000 - now) / 1000))
    return { allowed: false, retryAfter }
  }
  b.count++
  return { allowed: true, retryAfter: 0 }
}

/** (test helper) kosongkan bucket rate — dipakai E2E antar-skenario. */
function resetRateBuckets() {
  buckets.clear()
}

// ── Helpers ─────────────────────────────────────────────────────────
function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex')
}

function normalizeScopes(input) {
  const list = parseScopes(input)
  return VALID_SCOPES.filter((s) => list.includes(s)) // urutan kanonik
}

function clampRate(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_RATE_PER_MIN
  return Math.max(1, Math.min(MAX_RATE_PER_MIN, Math.trunc(n)))
}

function badRequest(msg) {
  const err = new Error(msg)
  err.code = 'VALIDATION'
  err.status = 400
  return err
}

module.exports = {
  KEY_PREFIX_LIVE,
  VALID_SCOPES,
  DEFAULT_RATE_PER_MIN,
  generate,
  parseScopes,
  verify,
  markUsed,
  revoke,
  listByTenant,
  rowToPublic,
  checkRate,
  resetRateBuckets,
  sha256Hex,
}