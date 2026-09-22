const express = require('express')
const router = express.Router()
const prisma = require('../prisma')
const { requireAuth, requireAdmin, requireTenant } = require('../auth')

// v3.0 — Isolasi tenant: announcement = tenant-scoped
const plans = require('../services/plans') // v3.4 — feature gate Pengumuman (plan per-tenant, ikut featBlast)
const featBlastGate = plans.requireFeature('featBlast') // 403 ramah + upsell bila fitur OFF
const rt = [requireAuth, requireTenant]
const broadcast = require('../socket/broadcast')
const push = require('../push')

const TITLE_MAX = 100
const CONTENT_MAX = 2000

function isExpired(a) {
  return a.expiresAt && new Date(a.expiresAt) <= new Date()
}

function statusForAdmin(a) {
  if (!a.isActive) return 'inactive'
  if (isExpired(a)) return 'expired'
  return 'active'
}

// GET /api/announcements — active + not-expired for all users
router.get('/', ...rt, featBlastGate, async (req, res) => {
  try {
    const now = new Date()
    const rows = await prisma.announcement.findMany({
      where: {
        tenantId: req.tenantId,
        isActive: true,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      include: {
        createdBy: { select: { id: true, username: true } },
        reads: { where: { userId: req.user.id } },
      },
    })

    const announcements = rows.map(a => ({
      id: a.id,
      title: a.title,
      content: a.content,
      pinned: a.pinned,
      isActive: a.isActive,
      expiresAt: a.expiresAt,
      createdBy: a.createdBy,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      readByMe: a.reads.length > 0,
    }))

    res.json({ announcements })
  } catch (e) {
    console.error('List announcements error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/announcements/all — admin-only full list with read stats
router.get('/all', ...rt, featBlastGate, requireAdmin, async (req, res) => {
  try {
    const [announcements, totalUsers] = await Promise.all([
      prisma.announcement.findMany({
        where: { tenantId: req.tenantId },
        orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
        include: {
          createdBy: { select: { id: true, username: true } },
          _count: { select: { reads: true } },
        },
      }),
      prisma.user.count({ where: { status: 'active', tenantId: req.tenantId } }),
    ])

    res.json({
      announcements: announcements.map(a => ({
        id: a.id,
        title: a.title,
        content: a.content,
        pinned: a.pinned,
        isActive: a.isActive,
        expiresAt: a.expiresAt,
        createdBy: a.createdBy,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
        status: statusForAdmin(a),
        readCount: a._count.reads,
        totalUsers,
      })),
    })
  } catch (e) {
    console.error('List all announcements error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/announcements — create (admin only)
router.post('/', ...rt, featBlastGate, requireAdmin, async (req, res) => {
  try {
    const { title, content, pinned, expiresAt } = req.body

    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Title is required' })
    }
    if (title.trim().length > TITLE_MAX) {
      return res.status(400).json({ error: `Title max ${TITLE_MAX} characters` })
    }
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Content is required' })
    }
    if (content.trim().length > CONTENT_MAX) {
      return res.status(400).json({ error: `Content max ${CONTENT_MAX} characters` })
    }

    let parsedExpiresAt = null
    if (expiresAt) {
      parsedExpiresAt = new Date(expiresAt)
      if (isNaN(parsedExpiresAt.getTime())) {
        return res.status(400).json({ error: 'Invalid expiresAt date' })
      }
    }

    const announcement = await prisma.announcement.create({
      data: {
        tenantId: req.tenantId,
        title: title.trim(),
        content: content.trim(),
        pinned: pinned === true,
        isActive: true,
        expiresAt: parsedExpiresAt,
        createdById: req.user.id,
      },
      include: { createdBy: { select: { id: true, username: true } } },
    })

    broadcast.emitToTenant(req.tenantId, 'announcement_new', { announcement })
    // v0.4.0 — Push "Pengumuman" ke semua user aktif TENANT INI (fire-and-forget)
    try {
      push.sendToTenantActive(req.tenantId, {
        kind: 'announcement',
        title: 'Pengumuman',
        body: push.truncate(announcement.title, 120),
        url: '/',
      })
    } catch (e) {
      console.error('[Announcement] push trigger error (non-fatal):', e.message)
    }
    res.status(201).json({ announcement: { ...announcement, readByMe: false } })
  } catch (e) {
    console.error('Create announcement error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/announcements/:id — edit (admin only)
router.put('/:id', ...rt, featBlastGate, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid announcement ID' })
    }

    const { title, content, pinned, isActive, expiresAt } = req.body

    const existing = await prisma.announcement.findFirst({ where: { id, tenantId: req.tenantId } })
    if (!existing) {
      return res.status(404).json({ error: 'Announcement not found' })
    }

    const data = {}

    if (title !== undefined) {
      if (!title.trim()) {
        return res.status(400).json({ error: 'Title cannot be empty' })
      }
      if (title.trim().length > TITLE_MAX) {
        return res.status(400).json({ error: `Title max ${TITLE_MAX} characters` })
      }
      data.title = title.trim()
    }

    if (content !== undefined) {
      if (!content.trim()) {
        return res.status(400).json({ error: 'Content cannot be empty' })
      }
      if (content.trim().length > CONTENT_MAX) {
        return res.status(400).json({ error: `Content max ${CONTENT_MAX} characters` })
      }
      data.content = content.trim()
    }

    if (pinned !== undefined) data.pinned = pinned === true
    if (isActive !== undefined) data.isActive = isActive === true

    if (expiresAt !== undefined) {
      if (expiresAt === null || expiresAt === '') {
        data.expiresAt = null
      } else {
        const d = new Date(expiresAt)
        if (isNaN(d.getTime())) {
          return res.status(400).json({ error: 'Invalid expiresAt date' })
        }
        data.expiresAt = d
      }
    }

    const announcement = await prisma.announcement.update({
      where: { id },
      data,
      include: {
        createdBy: { select: { id: true, username: true } },
        _count: { select: { reads: true } },
      },
    })

    const totalUsers = await prisma.user.count({ where: { status: 'active', tenantId: req.tenantId } })
    const payload = {
      announcement: {
        ...announcement,
        status: statusForAdmin(announcement),
        readCount: announcement._count.reads,
        totalUsers,
      },
    }

    broadcast.emitToTenant(req.tenantId, 'announcement_update', payload)
    res.json({ announcement: payload.announcement })
  } catch (e) {
    console.error('Update announcement error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/announcements/:id — hard delete (admin only)
router.delete('/:id', ...rt, featBlastGate, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid announcement ID' })
    }

    const existing = await prisma.announcement.findFirst({ where: { id, tenantId: req.tenantId } })
    if (!existing) {
      return res.status(404).json({ error: 'Announcement not found' })
    }

    await prisma.announcement.delete({ where: { id } })

    broadcast.emitToTenant(req.tenantId, 'announcement_delete', { id })
    res.json({ success: true })
  } catch (e) {
    console.error('Delete announcement error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/announcements/:id/read — mark read by current user
router.post('/:id/read', ...rt, featBlastGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid announcement ID' })
    }

    const existing = await prisma.announcement.findFirst({ where: { id, tenantId: req.tenantId } })
    if (!existing) {
      return res.status(404).json({ error: 'Announcement not found' })
    }

    await prisma.announcementRead.upsert({
      where: {
        announcementId_userId: {
          announcementId: id,
          userId: req.user.id,
        },
      },
      update: {},
      create: {
        announcementId: id,
        userId: req.user.id,
      },
    })

    res.json({ success: true })
  } catch (e) {
    console.error('Mark announcement read error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
