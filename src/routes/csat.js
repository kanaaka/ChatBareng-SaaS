/**
 * v0.10.0 — CSAT config/stats/list API (admin only utk semua endpoint)
 * GET  /api/csat/config — baca config singleton (default enabled=false)
 * PUT  /api/csat/config — update enabled + message (maks 1000 char, hanya {name})
 * GET  /api/csat/stats?from=&to= — avg, distribusi 1–5, respons vs terkirim, per-CS
 * GET  /api/csat/list — riwayat survey
 */
const express = require('express')
const router = express.Router()
const prisma = require('../prisma')
const { requireAuth, requireAdmin, requireTenant } = require('../auth')

// v3.0 — Isolasi tenant: CSAT = tenant-scoped
const plans = require('../services/plans') // v3.4 — feature gate CSAT (plan per-tenant)
const featCsatGate = plans.requireFeature('featCsat') // 403 ramah + upsell bila fitur OFF
const rt = [requireAuth, requireTenant, requireAdmin]  // requireTenant dulu — super_admin wajib ?tenant= sebelum cek admin
const csat = require('../services/csat')

// GET /api/csat/config (admin only)
router.get('/config', ...rt, featCsatGate, async (req, res) => {
  try {
    const cfg = await csat.getConfig(req.tenantId)
    res.json({ config: cfg })
  } catch (e) {
    console.error('CSAT GET config error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/csat/config (admin only)
router.put('/config', ...rt, featCsatGate, async (req, res) => {
  try {
    const body = req.body || {}
    const errors = []

    await csat.getConfig(req.tenantId) // pastikan config tenant ter-seed

    const data = {}
    if (body.enabled !== undefined) data.enabled = !!body.enabled

    if (body.message !== undefined) {
      if (typeof body.message !== 'string') {
        errors.push('Pesan survey harus berupa teks')
      } else {
        // Placeholder diizinkan hanya {name} — sisanya di-strip (pola autoreply)
        const cleaned = csat.stripUnknownPlaceholders(body.message)
        if (cleaned.length > csat.MAX_TEXT_LEN) {
          errors.push(`Pesan survey maksimal ${csat.MAX_TEXT_LEN} karakter`)
        } else if (!cleaned.trim()) {
          errors.push('Pesan survey tidak boleh kosong')
        } else {
          data.message = cleaned
        }
      }
    }

    if (body.cooldownMode !== undefined) {
      const allowed = ['per_chat', 'per_agent', 'hybrid']
      if (!allowed.includes(body.cooldownMode)) {
        errors.push('Mode cooldown harus salah satu dari: per_chat, per_agent, hybrid')
      } else {
        data.cooldownMode = body.cooldownMode
      }
    }

    if (body.cooldownHours !== undefined) {
      const n = parseInt(body.cooldownHours, 10)
      if (Number.isNaN(n) || n < 0 || n > 168) {
        errors.push('Jam cooldown harus angka 0–168')
      } else {
        data.cooldownHours = n
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: errors[0], errors })
    }
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'Tidak ada field yang valid untuk diupdate' })
    }

    const cfg = await prisma.csatConfig.update({
      where: { tenantId: req.tenantId },
      data: { ...data, updatedById: req.user.id },
    })
    csat.invalidateConfig(req.tenantId)
    res.json({ config: cfg })
  } catch (e) {
    console.error('CSAT PUT config error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/csat/stats?from=&to= (admin only)
router.get('/stats', ...rt, featCsatGate, async (req, res) => {
  try {
    const where = { tenantId: req.tenantId, respondedAt: { not: null } }
    if (req.query.from || req.query.to) {
      where.respondedAt = {}
      if (req.query.from) where.respondedAt.gte = new Date(req.query.from)
      if (req.query.to) {
        const end = new Date(req.query.to)
        end.setHours(23, 59, 59, 999)
        where.respondedAt.lte = end
      }
    }

    const [responded, sentTotal, distRaw, perCsRaw] = await Promise.all([
      prisma.csatSurvey.findMany({
        where,
        select: { rating: true, createdById: true, chat: { select: { contactName: true, contactPhone: true } } },
      }),
      prisma.csatSurvey.count({ where: { tenantId: req.tenantId, sentAt: { not: null }, ...(req.query.from || req.query.to ? { sentAt: where.respondedAt } : {}) } }),
      prisma.csatSurvey.groupBy({
        by: ['rating'],
        where,
        _count: { _all: true },
      }),
      prisma.csatSurvey.groupBy({
        by: ['createdById', 'rating'],
        where,
        _count: { _all: true },
      }),
    ])

    const totalResponded = responded.length
    const avgRating = totalResponded
      ? responded.reduce((s, r) => s + (r.rating || 0), 0) / totalResponded
      : null

    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
    for (const d of distRaw) {
      if (d.rating >= 1 && d.rating <= 5) distribution[d.rating] = d._count._all
    }

    // Per-CS: gabungkan groupBy by createdById
    const csMap = new Map()
    for (const row of perCsRaw) {
      if (!csMap.has(row.createdById)) csMap.set(row.createdById, { count: 0, sum: 0 })
      const entry = csMap.get(row.createdById)
      entry.count += row._count._all
      entry.sum += (row.rating || 0) * row._count._all
    }
    const userIds = Array.from(csMap.keys())
    const users = userIds.length
      ? await prisma.user.findMany({ where: { id: { in: userIds }, tenantId: req.tenantId }, select: { id: true, username: true, role: true } })
      : []
    const userMap = new Map(users.map(u => [u.id, u]))
    const perCs = Array.from(csMap.entries()).map(([userId, { count, sum }]) => ({
      userId,
      username: userMap.get(userId)?.username || `user-${userId}`,
      role: userMap.get(userId)?.role || 'cs',
      responses: count,
      avgRating: sum / count,
    })).sort((a, b) => b.responses - a.responses)

    res.json({
      avgRating,
      totalResponded,
      totalSent: sentTotal,
      responseRate: sentTotal ? totalResponded / sentTotal : null,
      distribution,
      perCs,
    })
  } catch (e) {
    console.error('CSAT stats error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/csat/list (admin only) — riwayat survey terbaru
router.get('/list', ...rt, featCsatGate, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '100', 10) || 100, 500)
    const surveys = await prisma.csatSurvey.findMany({
      where: { tenantId: req.tenantId },
      orderBy: { id: 'desc' },
      take: limit,
      include: {
        chat: { select: { id: true, contactName: true, contactPhone: true } },
      },
    })
    // createdById → username
    const userIds = [...new Set(surveys.map(s => s.createdById))]
    const users = userIds.length
      ? await prisma.user.findMany({ where: { id: { in: userIds }, tenantId: req.tenantId }, select: { id: true, username: true } })
      : []
    const userMap = new Map(users.map(u => [u.id, u.username]))
    res.json({
      surveys: surveys.map(s => ({
        ...s,
        createdBy: userMap.get(s.createdById) || `user-${s.createdById}`,
      })),
    })
  } catch (e) {
    console.error('CSAT list error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router