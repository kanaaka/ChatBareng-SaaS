/**
 * v0.12.9 — AppConfig API (admin only): pengaturan global universal.
 * GET /api/app-config — { readReceiptsEnabled }
 * PUT /api/app-config — { readReceiptsEnabled: boolean } → invalidate cache service
 */
const express = require('express')
const router = express.Router()
const prisma = require('../prisma')
const { requireAuth, requireAdmin, requireTenant } = require('../auth')

// v3.0 — Isolasi tenant: AppConfig = per-tenant
const rt = [requireAuth, requireTenant, requireAdmin]  // requireTenant dulu — super_admin wajib ?tenant= sebelum cek admin
const appConfig = require('../services/appConfig')

router.get('/', ...rt, async (req, res) => {
  try {
    const cfg = await appConfig.getConfig(req.tenantId)
    res.json({ readReceiptsEnabled: !!cfg.readReceiptsEnabled })
  } catch (e) {
    console.error('AppConfig GET error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/', ...rt, async (req, res) => {
  try {
    const v = req.body?.readReceiptsEnabled
    if (typeof v !== 'boolean') {
      return res.status(400).json({ error: 'readReceiptsEnabled harus boolean' })
    }
    const cfg = await prisma.appConfig.upsert({
      where: { tenantId: req.tenantId },
      update: { readReceiptsEnabled: v, updatedById: req.user.id },
      create: { tenantId: req.tenantId, readReceiptsEnabled: v, updatedById: req.user.id },
    })
    appConfig.invalidate(req.tenantId)
    res.json({ readReceiptsEnabled: !!cfg.readReceiptsEnabled })
  } catch (e) {
    console.error('AppConfig PUT error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router