// ═══════════════════════════════════════════════════════════════════
// v3.9.13 — Tenant-admin API keys management (halaman "API Keys").
// SEMUA endpoint requireAuth + requireTenant + requireAdmin (BOTH create
// dan revoke = admin-only; CS tidak boleh). Tenant-scoped via req.tenantId.
//
//   GET    /api/api-keys           — list key tenant (tanpa hash)
//   POST   /api/api-keys           — create → response BAWA rawKey SEKALI
//   DELETE /api/api-keys/:id       — revoke (idempoten)
//
// Response create: { apiKey, key: <raw cbk_live_…>, warning } — raw key
// TIDAK tersimpan/log; UI menampilkan show-once + copy.
// ═══════════════════════════════════════════════════════════════════

const express = require('express')
const router = express.Router()
const prisma = require('../prisma')
const { requireAuth, requireTenant, requireAdmin, requireActiveSubscription } = require('../auth')
const apiKeys = require('../services/apiKeys')

const rt = [requireAuth, requireTenant, requireAdmin]
const rtw = [...rt, requireActiveSubscription] // non-GET: guard masa aktif (pola requireActiveSubscription)

// GET /api/api-keys — list key tenant (revoked ikut tampil utk badge riwayat)
router.get('/', ...rt, async (req, res) => {
  try {
    const rows = await apiKeys.listByTenant(req.tenantId, true)
    res.json({ keys: rows.map(apiKeys.rowToPublic) })
  } catch (e) {
    console.error('[ApiKeys] list error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/api-keys { name, scopes: ['send','read'] | 'send,read', ratePerMin? }
// v4.6.12 pending — scopes juga terima 'choose_slot' / 'assign_agent'
// (API v1.1; whitelist + pesan error dari services/apiKeys.parseScopes).
// → 201 { apiKey, key: RAW (sekali), warning }
router.post('/', ...rtw, async (req, res) => {
  try {
    const body = req.body || {}
    let created
    try {
      created = await apiKeys.generate({
        tenantId: req.tenantId,
        name: body.name,
        scopes: apiKeys.parseScopes(body.scopes),
        ratePerMin: body.ratePerMin,
        planGated: true,
        expiresAt: null,
        createdByUserId: req.user.id,
      })
    } catch (e) {
      if (e?.code === 'VALIDATION') return res.status(400).json({ error: e.message, code: 'VALIDATION' })
      throw e
    }

    // Plan gate info: bila plan tenant belum featApiAccess → key tetap dibuat
    // tapi endpoint /api/v1 akan 403 UPGRADE_REQUIRED sampai plan di-upgrade.
    const plans = require('../services/plans')
    const plan = await plans.getPlan(req.tenantId).catch(() => null)
    const planWarning = plan && plan.featApiAccess !== true
      ? 'Akses API belum aktif di paket tenant ini — key baru bisa dipakai setelah admin platform mengaktifkan featApiAccess.'
      : null

    console.log(`[ApiKeys] key dibuat tenant=${req.tenantId} id=${created.apiKey.id} name="${created.apiKey.name}" scopes="${created.apiKey.scopes}" by @${req.user.username} (raw TIDAK di-log)`)
    res.status(201).json({
      apiKey: apiKeys.rowToPublic(created.apiKey),
      key: created.rawKey,
      warning: planWarning || 'Simpan key ini SEKARANG — hanya ditampilkan sekali dan tidak bisa dilihat lagi.',
    })
  } catch (e) {
    console.error('[ApiKeys] create error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/api-keys/:id — revoke (idempoten; tenant-scoped)
router.delete('/:id', ...rtw, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) return res.status(404).json({ error: 'Key tidak ditemukan' })
    const row = await prisma.apiKey.findFirst({ where: { id, tenantId: req.tenantId } })
    if (!row) return res.status(404).json({ error: 'Key tidak ditemukan' })
    if (row.revokedAt) return res.json({ ok: true, alreadyRevoked: true })
    await apiKeys.revoke(row.id)
    console.log(`[ApiKeys] key #${row.id} tenant=${req.tenantId} di-revoke by @${req.user.username}`)
    const fresh = await prisma.apiKey.findUnique({ where: { id: row.id } })
    res.json({ ok: true, apiKey: apiKeys.rowToPublic(fresh) })
  } catch (e) {
    console.error('[ApiKeys] revoke error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Method/path lain → 404 JSON
router.use((req, res) => {
  res.status(404).json({ error: 'Endpoint tidak ditemukan' })
})

module.exports = router