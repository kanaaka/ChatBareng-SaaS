const express = require('express')
const router = express.Router()
const prisma = require('../prisma')
const { requireAuth, requireAdmin, requireTenant } = require('../auth')

// v3.0 — Isolasi tenant: analytics = tenant-scoped
const rt = [requireAuth, requireTenant, requireAdmin]  // requireTenant dulu — super_admin wajib ?tenant= sebelum cek admin

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function getRangeFilter(range) {
  const now = new Date()
  switch (range) {
    case '7d':
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    case '30d':
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    case 'all':
    default:
      return null
  }
}

function parseLocalDate(dateStr) {
  if (!dateStr || !DATE_RE.test(dateStr)) return null
  const d = new Date(dateStr + 'T00:00:00')
  if (Number.isNaN(d.getTime())) return null
  return d
}

function resolveRangeParams(req) {
  const startStr = req.query.start
  const endStr = req.query.end
  const startDate = parseLocalDate(startStr)
  const endDate = parseLocalDate(endStr)

  if (startStr || endStr) {
    if (!startDate || !endDate) {
      return { error: 'start/end harus YYYY-MM-DD' }
    }
    if (startDate > endDate) {
      return { error: 'start harus <= end' }
    }
    const until = new Date(endDate)
    until.setHours(23, 59, 59, 999)
    return { rangeLabel: 'custom', start: startStr, end: endStr, since: startDate, until }
  }

  const range = req.query.range === '7d' || req.query.range === 'all' ? req.query.range : '30d'
  const since = getRangeFilter(range)
  return { rangeLabel: range, since, until: null }
}

function toRangeWhere(window, field = 'firstIncomingAt') {
  if (!window || !window.since) return {}
  const filter = { gte: window.since }
  if (window.until) filter.lte = window.until
  return { [field]: filter }
}

function rangeResponseFields(window) {
  if (!window || window.rangeLabel !== 'custom') return {}
  return { range: 'custom', start: window.start, end: window.end }
}

function diffMinutes(a, b) {
  if (!a || !b) return null
  return Math.round(((new Date(b).getTime() - new Date(a).getTime()) / 60000) * 10) / 10
}

function avgMinutes(values) {
  const valid = values.filter((v) => v !== null && !isNaN(v))
  if (valid.length === 0) return null
  return Math.round((valid.reduce((s, v) => s + v, 0) / valid.length) * 10) / 10
}

function formatDuration(minutes) {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes)) return null
  if (minutes < 60) return minutes.toFixed(1)
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  if (h < 24) return `${h}.${String(Math.round((m / 60) * 10)).padStart(2, '0')}`
  const d = Math.floor(h / 24)
  const rh = h % 24
  return `${d}.${String(Math.round((rh / 24) * 10)).padStart(2, '0')}`
}

// GET /api/analytics/overview
router.get('/overview', ...rt, async (req, res) => {
  try {
    const window = resolveRangeParams(req)
    if (window.error) return res.status(400).json({ error: window.error })

    const whereIn = { tenantId: req.tenantId, ...toRangeWhere(window, 'firstIncomingAt') }
    const whereResolved = { tenantId: req.tenantId, ...toRangeWhere(window, 'resolvedAt') }

    const [chatsIn, chatsResolved, backlogOpen, unassignedOpen, resolvedChats, allMessages, reopenedCount] = await Promise.all([
      prisma.chat.count({ where: whereIn }),
      prisma.chat.count({ where: { ...whereResolved, status: 'resolved' } }),
      prisma.chat.count({ where: { tenantId: req.tenantId, status: 'open' } }),
      prisma.chat.count({ where: { tenantId: req.tenantId, status: 'open', assignedToId: null } }),
      prisma.chat.findMany({
        where: { ...whereResolved, status: 'resolved' },
        select: { firstIncomingAt: true, firstAssignedAt: true, firstResponseAt: true, resolvedAt: true, messagesBeforeResolve: true },
      }),
      prisma.message.findMany({
        // v0.7.0 — csMessagesSent hanya hitung pesan CS manusia (bukan auto reply)
        where: window.since ? { tenantId: req.tenantId, timestamp: { gte: window.since, ...(window.until ? { lte: window.until } : {}) }, isAuto: false } : { tenantId: req.tenantId, isAuto: false },
        select: { direction: true },
      }),
      prisma.chat.aggregate({
        where: whereIn,
        _sum: { reopenedCount: true },
      }),
    ])

    const firstResponseTimes = resolvedChats.map((c) => diffMinutes(c.firstIncomingAt, c.firstResponseAt))
    const resolutionTimes = resolvedChats.map((c) => diffMinutes(c.firstAssignedAt, c.resolvedAt))
    const takeoverTimes = resolvedChats.map((c) => diffMinutes(c.firstIncomingAt, c.firstAssignedAt))
    const timeToSolve = resolvedChats.map((c) => diffMinutes(c.firstIncomingAt, c.resolvedAt))
    const effortValues = resolvedChats.map((c) => c.messagesBeforeResolve).filter((v) => v !== null)

    res.json({
      ...rangeResponseFields(window),
      ...(window.rangeLabel !== 'custom' ? { range: window.rangeLabel } : {}),
      totals: {
        chatsIn,
        chatsResolved,
        backlogOpen,
        unassignedOpen,
        avgFirstResponseMin: avgMinutes(firstResponseTimes),
        avgResolutionMin: avgMinutes(resolutionTimes),
        avgTakeoverMin: avgMinutes(takeoverTimes),
        avgTimeToSolveMin: avgMinutes(timeToSolve),
        avgCsEffort: effortValues.length > 0 ? Math.round((effortValues.reduce((s, v) => s + v, 0) / effortValues.length) * 10) / 10 : null,
        csMessagesSent: allMessages.filter((m) => m.direction === 'out').length,
        reopenedCount: reopenedCount._sum.reopenedCount || 0,
      },
    })
  } catch (e) {
    console.error('Analytics overview error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/analytics/agents
router.get('/agents', ...rt, async (req, res) => {
  try {
    const window = resolveRangeParams(req)
    if (window.error) return res.status(400).json({ error: window.error })

    // v0.7.0 — auto message (isAuto) tidak dihitung sebagai aktivitas CS
    const messageWhere = window.since
      ? { timestamp: { gte: window.since, ...(window.until ? { lte: window.until } : {}) }, isAuto: false }
      : { isAuto: false }

    const users = await prisma.user.findMany({
      where: { tenantId: req.tenantId, role: { not: 'super_admin' } },
      select: { id: true, username: true, role: true },
      orderBy: { username: 'asc' },
    })

    const [assignedEvents, resolvedChats, firstResponses, allMessages, activeChats] = await Promise.all([
      prisma.chatEvent.findMany({
        where: { tenantId: req.tenantId, type: 'assigned' },
        select: { chatId: true, userId: true, createdAt: true },
      }),
      prisma.chat.findMany({
        where: { tenantId: req.tenantId, ...toRangeWhere(window, 'resolvedAt') },
        select: { resolvedById: true, firstAssignedAt: true, firstIncomingAt: true, firstResponseById: true, messagesBeforeResolve: true, resolvedAt: true },
      }),
      prisma.message.findMany({
        // v0.7.0 — auto message (isAuto) tidak dihitung sebagai respons/manuskrip CS
        where: window.since
          ? { tenantId: req.tenantId, timestamp: { gte: window.since, ...(window.until ? { lte: window.until } : {}) }, direction: 'out', isAuto: false }
          : { tenantId: req.tenantId, direction: 'out', isAuto: false },
        select: { senderId: true, timestamp: true },
      }),
      prisma.message.findMany({
        // v0.7.0 — auto message tidak dihitung sebagai aktivitas CS
        where: { tenantId: req.tenantId, ...messageWhere },
        select: { senderId: true, direction: true, timestamp: true },
      }),
      prisma.chat.findMany({
        where: { tenantId: req.tenantId, status: 'open' },
        select: { assignedToId: true },
      }),
    ])

    const agents = users.map((u) => {
      const handledChatIds = new Set(assignedEvents.filter((e) => e.userId === u.id).map((e) => e.chatId))
      const userResolved = resolvedChats.filter((c) => c.resolvedById === u.id)
      const userFirstResponses = resolvedChats.filter((c) => c.firstResponseById === u.id)
      const userAssigned = assignedEvents.filter((e) => e.userId === u.id)
      const userMessages = allMessages.filter((m) => m.senderId === u.id)
      const userOutMessages = allMessages.filter((m) => m.senderId === u.id && m.direction === 'out')

      const firstResponseTimes = userFirstResponses
        .map((c) => diffMinutes(c.firstIncomingAt, c.firstResponseById ? c.firstIncomingAt : null))
        .filter((v) => v !== null)
      const resolutionTimes = userResolved.map((c) => diffMinutes(c.firstAssignedAt, c.resolvedAt)).filter((v) => v !== null)
      const takeoverTimes = userAssigned.map((e) => {
        const chat = resolvedChats.find((c) => c.resolvedById === e.userId) || resolvedChats.find((c) => c.firstResponseById === e.userId)
        if (!chat || !chat.firstIncomingAt || !e.createdAt) return null
        return diffMinutes(chat.firstIncomingAt, e.createdAt)
      }).filter((v) => v !== null)

      const lastTimestamps = userMessages.map((m) => m.timestamp).filter(Boolean)

      return {
        userId: u.id,
        username: u.username,
        role: u.role,
        activeChats: activeChats.filter((c) => c.assignedToId === u.id).length,
        totalHandled: handledChatIds.size,
        resolvedCount: userResolved.length,
        avgFirstResponseMin: avgMinutes(firstResponseTimes),
        avgResolutionMin: avgMinutes(resolutionTimes),
        avgTakeoverMin: avgMinutes(takeoverTimes),
        messagesSent: userOutMessages.length,
        lastActiveAt: lastTimestamps.length > 0 ? lastTimestamps.sort((a, b) => new Date(b) - new Date(a))[0] : null,
      }
    })

    res.json({ ...rangeResponseFields(window), agents: agents.sort((a, b) => b.totalHandled - a.totalHandled) })
  } catch (e) {
    console.error('Analytics agents error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/analytics/hourly
router.get('/hourly', ...rt, async (req, res) => {
  try {
    const window = resolveRangeParams(req)
    if (window.error) return res.status(400).json({ error: window.error })

    const csRaw = req.query.cs
    let cs = null
    if (csRaw !== undefined && csRaw !== '') {
      cs = parseInt(csRaw, 10)
      if (Number.isNaN(cs)) {
        return res.status(400).json({ error: 'cs harus ID user (integer)' })
      }
    }

    const msgColumn = cs != null ? 'm.timestamp' : 'm.timestamp'
    const chatColumn = cs != null ? "e.createdAt" : 'c.firstIncomingAt'

    let byMessagesRaw
    let byNewChatsRaw

    const tid = Number(req.tenantId)
    if (!Number.isFinite(tid)) return res.status(400).json({ error: 'tenant tidak valid' })
    if (cs != null) {
      const msgWhere = buildRawWhere(window, 'm.timestamp')
      const eventWhere = buildRawWhere(window, 'e.createdAt')
      byMessagesRaw = await prisma.$queryRawUnsafe(
        `SELECT CAST(strftime('%w', m.timestamp) AS INTEGER) AS dow, CAST(strftime('%H', m.timestamp) AS INTEGER) AS hour, COUNT(*) AS count
         FROM Message m WHERE m.tenantId = ${tid} AND m.direction = 'out' AND m.isAuto = 0 AND m.senderId = ${cs} ${msgWhere}
         GROUP BY dow, hour`
      )
      byNewChatsRaw = await prisma.$queryRawUnsafe(
        `SELECT CAST(strftime('%w', e.createdAt) AS INTEGER) AS dow, CAST(strftime('%H', e.createdAt) AS INTEGER) AS hour, COUNT(*) AS count
         FROM ChatEvent e WHERE e.tenantId = ${tid} AND e.type = 'assigned' AND e.userId = ${cs} ${eventWhere}
         GROUP BY dow, hour`
      )
    } else {
      const msgWhere = buildRawWhere(window, 'm.timestamp')
      const chatWhere = buildRawWhere(window, 'c.firstIncomingAt')
      byMessagesRaw = await prisma.$queryRawUnsafe(
        `SELECT CAST(strftime('%w', m.timestamp) AS INTEGER) AS dow, CAST(strftime('%H', m.timestamp) AS INTEGER) AS hour, COUNT(*) AS count
         FROM Message m WHERE m.tenantId = ${tid} AND m.direction = 'in' ${msgWhere}
         GROUP BY dow, hour`
      )
      byNewChatsRaw = await prisma.$queryRawUnsafe(
        `SELECT CAST(strftime('%w', c.firstIncomingAt) AS INTEGER) AS dow, CAST(strftime('%H', c.firstIncomingAt) AS INTEGER) AS hour, COUNT(*) AS count
         FROM Chat c WHERE c.tenantId = ${tid} AND c.firstIncomingAt IS NOT NULL ${chatWhere}
         GROUP BY dow, hour`
      )
    }

    function buildGrid(rows) {
      const grid = []
      for (let dow = 0; dow < 7; dow++) {
        for (let hour = 0; hour < 24; hour++) {
          const found = rows.find((r) => r.dow === dow && r.hour === hour)
          grid.push({ dow, hour, count: found ? Number(found.count) : 0 })
        }
      }
      return grid
    }

    res.json({
      ...rangeResponseFields(window),
      cs,
      byMessages: buildGrid(byMessagesRaw.map((r) => ({ dow: Number(r.dow), hour: Number(r.hour), count: Number(r.count) }))),
      byNewChats: buildGrid(byNewChatsRaw.map((r) => ({ dow: Number(r.dow), hour: Number(r.hour), count: Number(r.count) }))),
    })
  } catch (e) {
    console.error('Analytics hourly error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

function buildRawWhere(window, column) {
  if (!window || !window.since) return ''
  const parts = [`${column} >= '${window.since.toISOString()}'`]
  if (window.until) parts.push(`${column} <= '${window.until.toISOString()}'`)
  return `AND ${parts.join(' AND ')}`
}

// GET /api/analytics/chats
router.get('/chats', ...rt, async (req, res) => {
  try {
    const window = resolveRangeParams(req)
    if (window.error) return res.status(400).json({ error: window.error })

    const status = req.query.status === 'open' || req.query.status === 'resolved' ? req.query.status : 'all'
    const page = Math.max(1, parseInt(req.query.page || '1', 10))
    const pageSize = 20

    const where = { tenantId: req.tenantId, ...toRangeWhere(window, 'firstIncomingAt') }
    if (status !== 'all') {
      where.status = status
    }

    const [total, chats] = await Promise.all([
      prisma.chat.count({ where }),
      prisma.chat.findMany({
        where,
        orderBy: { firstIncomingAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          assignedTo: { select: { id: true, username: true } },
        },
      }),
    ])

    const userIds = new Set()
    chats.forEach((c) => {
      if (c.firstResponseById) userIds.add(c.firstResponseById)
      if (c.resolvedById) userIds.add(c.resolvedById)
    })
    const users = await prisma.user.findMany({
      where: { id: { in: Array.from(userIds) }, tenantId: req.tenantId },
      select: { id: true, username: true },
    })
    const userMap = Object.fromEntries(users.map((u) => [u.id, u.username]))

    const result = chats.map((c) => ({
      chatId: c.id,
      contactName: c.contactName,
      status: c.status,
      firstIncomingAt: c.firstIncomingAt,
      firstAssignedAt: c.firstAssignedAt,
      assignee: c.assignedTo ? c.assignedTo.username : null,
      firstResponseAt: c.firstResponseAt,
      firstResponseBy: c.firstResponseById ? userMap[c.firstResponseById] : null,
      resolvedAt: c.resolvedAt,
      resolvedBy: c.resolvedById ? userMap[c.resolvedById] : null,
      takeoverMin: diffMinutes(c.firstIncomingAt, c.firstAssignedAt),
      firstResponseMin: diffMinutes(c.firstIncomingAt, c.firstResponseAt),
      resolutionMin: diffMinutes(c.firstAssignedAt, c.resolvedAt),
      csMessagesBeforeResolve: c.messagesBeforeResolve,
      reopenedCount: c.reopenedCount,
    }))

    res.json({ ...rangeResponseFields(window), total, page, chats: result })
  } catch (e) {
    console.error('Analytics chats error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
