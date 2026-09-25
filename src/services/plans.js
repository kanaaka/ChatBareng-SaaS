// v3.4 — Plan & kuota per-tenant: preset Lite/Pro/Max + custom (spec §3).
// Angka preset LOCKED (Kanaka 2026-09-22 15:25) — lihat docs/spec-v3.4-plan-kuota-branding-superadmin.md §1.
// Semua nilai null = unlimited. Preset hanya template: setelah apply, field boleh
// dioverride individual (preset di-DB jadi "custom" bila hasil menyimpang).
const prisma = require('../prisma')

const GB = 1024 * 1024 * 1024

// ── Preset LOCKED (spec §1) ──────────────────────────────────────────────
const PRESETS = {
  lite: {
    maxAgents: 3,
    tkQuotaBytes: 2 * GB,
    maxContacts: 5000,
    featAnalytics: false,
    featBlast: false,
    featMenuGateway: false,
    featHistoryExport: false,
    featCsat: false,
    featGdriveBackup: false,
    featApiAccess: false, // v3.9.13 — Public API v1
    featAiRouting: false, // v3.9.25 — AI Hybrid Routing (Lite ✗ — D5)
  },
  pro: {
    maxAgents: 10,
    tkQuotaBytes: 5 * GB,
    maxContacts: 10000,
    featAnalytics: true,
    featBlast: true,
    featMenuGateway: true,
    featHistoryExport: true,
    featCsat: true,
    featGdriveBackup: false,
    featApiAccess: false, // v3.9.13 — Public API v1 (pro belum)
    featAiRouting: true, // v3.9.25 — AI Hybrid Routing (Pro ✓ — D5)
  },
  max: {
    maxAgents: 50,
    tkQuotaBytes: 10 * GB,
    maxContacts: 50000,
    featAnalytics: true,
    featBlast: true,
    featMenuGateway: true,
    featHistoryExport: true,
    featCsat: true,
    featGdriveBackup: true,
    featApiAccess: true, // v3.9.13 — Public API v1 (max dulu)
    featAiRouting: true, // v3.9.25 — AI Hybrid Routing (Max ✓ — D5)
  },
}

// Field fitur (boolean) & kuota (angka/null) — dipakai apply preset + compare custom
const FEATURE_KEYS = ['featAnalytics', 'featBlast', 'featMenuGateway', 'featHistoryExport', 'featCsat', 'featGdriveBackup', 'featApiAccess', 'featAiRouting']
const QUOTA_KEYS = ['maxAgents', 'maxContacts', 'tkQuotaBytes']

/** applyPreset(name) → object field siap create/update TenantPlan. */
function applyPreset(name) {
  const key = String(name || '').toLowerCase()
  const preset = PRESETS[key]
  if (!preset) return null
  return { preset: key, ...preset }
}

/**
 * ensureTenantPlan(tenantId, presetName='max') — create plan bila belum ada.
 * Default preset utk tenant yang SUDAH ADA (boot/existing) = 'max'
 * (safe: fitur yang sebelumnya kebuka tetap kebuka, kuota longgar — spec §3).
 * Idempoten: plan sudah ada → return apa adanya.
 */
async function ensureTenantPlan(tenantId, presetName = 'max') {
  const tid = Number(tenantId)
  if (!Number.isFinite(tid) || tid <= 0) throw new Error('Invalid tenantId')
  const existing = await prisma.tenantPlan.findUnique({ where: { tenantId: tid } })
  if (existing) return existing
  const fields = applyPreset(presetName) || applyPreset('max')
  const plan = await prisma.tenantPlan.create({ data: { tenantId: tid, ...fields } })
  const tenant = await prisma.tenant.findUnique({ where: { id: tid }, select: { name: true } })
  console.log(`[Plan] Tenant #${tid} ${tenant?.name ?? ''} seeded plan=${fields.preset} (existing)`)
  return plan
}

/**
 * Boot: loop tenant tanpa plan → ensureTenantPlan dengan preset 'max'.
 * Dipanggil dari server.js setelah seeding super_admin (spec §3).
 */
async function ensureAllTenantPlans() {
  const tenants = await prisma.tenant.findMany({
    where: { plan: null },
    select: { id: true, name: true },
  })
  for (const t of tenants) {
    try {
      await ensureTenantPlan(t.id, 'max')
    } catch (e) {
      console.error(`[Plan] ensureTenantPlan #${t.id} error:`, e.message)
    }
  }
  return tenants.length
}

// ── Cache in-memory 30 detik ─────────────────────────────────────────────
const CACHE_TTL_MS = 30 * 1000
const planCache = new Map() // tenantId → { plan, expiresAt }

function invalidatePlanCache(tenantId) {
  if (tenantId === undefined || tenantId === null) planCache.clear()
  else planCache.delete(Number(tenantId))
}

/** getPlan(tenantId) → TenantPlan | null (cache 30s). tkQuotaBytes BigInt → Number. */
async function getPlan(tenantId) {
  const tid = Number(tenantId)
  if (!Number.isFinite(tid)) return null
  const hit = planCache.get(tid)
  if (hit && hit.expiresAt > Date.now()) return hit.plan
  let plan = await prisma.tenantPlan.findUnique({ where: { tenantId: tid } })
  if (plan) {
    // BigInt (BIGINT) → Number utk JSON & matematika (10 GB < 2^53 aman)
    plan = { ...plan, tkQuotaBytes: plan.tkQuotaBytes == null ? null : Number(plan.tkQuotaBytes) }
  }
  planCache.set(tid, { plan, expiresAt: Date.now() + CACHE_TTL_MS })
  return plan
}

/**
 * requireFeature(featureKey) — express middleware (spec §3).
 *  - tenant tidak ketemu (super_admin tanpa ?tenant=) → allow
 *  - plan ada & fitur OFF → 403 pesan upsell ramah
 *  - plan belum ada (race) → allow + log warn
 */
function requireFeature(featureKey) {
  const LABELS = {
    featAnalytics: 'Analitik',
    featBlast: 'Blast & Pengumuman',
    featMenuGateway: 'Menu Gateway',
    featHistoryExport: 'Export/Import Riwayat',
    featCsat: 'CSAT',
    featGdriveBackup: 'Backup Google Drive',
    featApiAccess: 'Akses API (Public API v1)',
    featAiRouting: 'AI Hybrid Routing',
  }
  return async (req, res, next) => {
    try {
      const tid = req.tenantId
      // super_admin tanpa ?tenant= → allow (endpoint SA lintas tenant)
      if (!Number.isFinite(Number(tid))) return next()
      const plan = await getPlan(tid)
      if (!plan) {
        console.warn(`[Plan] Tenant #${tid} belum punya plan — feature ${featureKey} di-allow (race)`)
        return next()
      }
      if (plan[featureKey] === false) {
        return res.status(403).json({
          error: `${LABELS[featureKey] || featureKey} tidak tersedia di paket Anda. Hubungi admin platform untuk upgrade.`,
        })
      }
      return next()
    } catch (e) {
      console.error('[Plan] requireFeature error (allow-safe):', e.message)
      return next()
    }
  }
}

// ── Usage helpers (murah di SQLite) ──────────────────────────────────────

/** Jumlah user tenant (semua role kecuali super_admin — super_admin tidak punya tenantId). */
async function countAgents(tenantId) {
  return prisma.user.count({ where: { tenantId: Number(tenantId) } })
}

async function countContacts(tenantId) {
  return prisma.contact.count({ where: { tenantId: Number(tenantId) } })
}

/** SUM SharedFile.size tenant — kuota Tangan Kanan SAJA (media chat/blast tidak ikut, spec §4). */
async function sumTkBytes(tenantId) {
  const agg = await prisma.sharedFile.aggregate({
    where: { tenantId: Number(tenantId) },
    _sum: { size: true },
  })
  return agg._sum.size || 0
}

async function getUsage(tenantId) {
  const [agents, contacts, tkBytes] = await Promise.all([
    countAgents(tenantId),
    countContacts(tenantId),
    sumTkBytes(tenantId),
  ])
  return { agents, contacts, tkBytes }
}

/** checkAgentQuota → { ok, count, max } — max null = unlimited. */
async function checkAgentQuota(tenantId) {
  const plan = await getPlan(tenantId)
  const count = await countAgents(tenantId)
  const max = plan?.maxAgents ?? null
  return { ok: max == null || count < max, count, max }
}

async function checkContactQuota(tenantId) {
  const plan = await getPlan(tenantId)
  const count = await countContacts(tenantId)
  const max = plan?.maxContacts ?? null
  return { ok: max == null || count < max, count, max }
}

/** checkTkQuota(tenantId, incomingBytes) — SUM size + incoming vs kuota. */
async function checkTkQuota(tenantId, incomingBytes) {
  const plan = await getPlan(tenantId)
  const current = await sumTkBytes(tenantId)
  const quota = plan?.tkQuotaBytes ?? null
  const incoming = Math.max(0, Number(incomingBytes) || 0)
  return { ok: quota == null || current + incoming <= quota, current, quota, incoming }
}

// ── Format pesan kuota ramah + upsell (spec §3) ──────────────────────────

function formatBytes(n) {
  const num = Number(n) || 0
  if (num >= GB) return `${(num / GB).toFixed(1).replace('.', ',')} GB`
  const mb = 1024 * 1024
  if (num >= mb) return `${Math.round(num / mb)} MB`
  return `${num} B`
}

function agentQuotaMessage(count, max) {
  return `Kuota agen penuh (${count}/${max}). Hubungi admin platform untuk upgrade ke paket Pro/Max.`
}

function contactQuotaMessage(count, max) {
  const fmt = (x) => Number(x).toLocaleString('id-ID')
  return `Kuota kontak penuh (${fmt(count)}/${fmt(max)}). Hubungi admin platform untuk upgrade paket.`
}

function tkQuotaMessage(current, quota) {
  return `Kuota penyimpanan Tangan Kanan penuh (${formatBytes(current)}/${formatBytes(quota)}). Hapus file lama atau upgrade paket.`
}

/** Simpan plan + set preset hasil (persis definisi → nama preset; menyimpang → "custom"). */
function resolvePresetLabel(fields) {
  for (const [name, def] of Object.entries(PRESETS)) {
    let exact = true
    for (const k of QUOTA_KEYS) if ((fields[k] ?? null) !== (def[k] ?? null)) exact = false
    for (const k of FEATURE_KEYS) if ((fields[k] ?? false) !== def[k]) exact = false
    if (exact) return name
  }
  return 'custom'
}

module.exports = {
  PRESETS,
  FEATURE_KEYS,
  QUOTA_KEYS,
  applyPreset,
  ensureTenantPlan,
  ensureAllTenantPlans,
  getPlan,
  invalidatePlanCache,
  requireFeature,
  countAgents,
  countContacts,
  sumTkBytes,
  getUsage,
  checkAgentQuota,
  checkContactQuota,
  checkTkQuota,
  agentQuotaMessage,
  contactQuotaMessage,
  tkQuotaMessage,
  formatBytes,
  resolvePresetLabel,
}