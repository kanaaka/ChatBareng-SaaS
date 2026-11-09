const express = require('express')
const router = express.Router()
const prisma = require('../prisma')
const { requireAuth, requireAdmin, requireTenant } = require('../auth')

// v3.0 — Isolasi tenant: analytics = tenant-scoped
const plans = require('../services/plans') // v3.4 — feature gate Analytics (plan per-tenant)
const featAnalyticsGate = plans.requireFeature('featAnalytics') // 403 ramah + upsell bila fitur OFF
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
router.get('/overview', ...rt, featAnalyticsGate, async (req, res) => {
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
router.get('/agents', ...rt, featAnalyticsGate, async (req, res) => {
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
router.get('/hourly', ...rt, featAnalyticsGate, async (req, res) => {
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
        `SELECT CAST(strftime('%w', m.timestamp / 1000.0, 'unixepoch') AS INTEGER) AS dow, CAST(strftime('%H', m.timestamp / 1000.0, 'unixepoch') AS INTEGER) AS hour, COUNT(*) AS count
         FROM Message m WHERE m.tenantId = ${tid} AND m.direction = 'out' AND m.isAuto = 0 AND m.senderId = ${cs} ${msgWhere}
         GROUP BY dow, hour`
      )
      byNewChatsRaw = await prisma.$queryRawUnsafe(
        `SELECT CAST(strftime('%w', e.createdAt / 1000.0, 'unixepoch') AS INTEGER) AS dow, CAST(strftime('%H', e.createdAt / 1000.0, 'unixepoch') AS INTEGER) AS hour, COUNT(*) AS count
         FROM ChatEvent e WHERE e.tenantId = ${tid} AND e.type = 'assigned' AND e.userId = ${cs} ${eventWhere}
         GROUP BY dow, hour`
      )
    } else {
      const msgWhere = buildRawWhere(window, 'm.timestamp')
      const chatWhere = buildRawWhere(window, 'c.firstIncomingAt')
      byMessagesRaw = await prisma.$queryRawUnsafe(
        `SELECT CAST(strftime('%w', m.timestamp / 1000.0, 'unixepoch') AS INTEGER) AS dow, CAST(strftime('%H', m.timestamp / 1000.0, 'unixepoch') AS INTEGER) AS hour, COUNT(*) AS count
         FROM Message m WHERE m.tenantId = ${tid} AND m.direction = 'in' ${msgWhere}
         GROUP BY dow, hour`
      )
      byNewChatsRaw = await prisma.$queryRawUnsafe(
        `SELECT CAST(strftime('%w', c.firstIncomingAt / 1000.0, 'unixepoch') AS INTEGER) AS dow, CAST(strftime('%H', c.firstIncomingAt / 1000.0, 'unixepoch') AS INTEGER) AS hour, COUNT(*) AS count
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
  // v4.6.13 fix — kolom DateTime SQLite = INTEGER ms (bukan TEKS ISO): banding numerik ms
  if (!window || !window.since) return ''
  const parts = [`${column} >= ${window.since.getTime()}`]
  if (window.until) parts.push(`${column} <= ${window.until.getTime()}`)
  return `AND ${parts.join(' AND ')}`
}

// GET /api/analytics/chats
router.get('/chats', ...rt, featAnalyticsGate, async (req, res) => {
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

// ─── v4.6.13 (pending) — Laporan bulanan Excel (gaya laporan Kantor; per nomor WA + pesan per CS) ───
// GET /api/analytics/excel?months=N → file .xlsx, blok gaya REPORT_*:
//   (1) Performance overview per bulan (avg first response / resolution / wait + MAU)
//   (2) Conversation overview per bulan (total/assigned/unassigned/resolved/campaign:0)
//   (3) Messages Sent per CS per bulan (matrix agen × bulan + total)
// Sheet = "Semua Nomor" + 1 sheet per nomor WA (TenantNumber). ADDITIVE — file/endpoint
// lain tidak disentuh; tanpa kolom DB baru (numberSlot existing dipakai).

const MONTH_LABELS_ID = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember']
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000

function pad2Num(n) { return String(n).padStart(2, '0') }

// Bulan kalender WIB terakhir N: {key:'2026-02', label:'Februari', startISO, endISO} (end eksklusif)
function buildExcelMonths(monthsRaw, endRaw) {
  const count = Math.min(Math.max(parseInt(monthsRaw, 10) || 12, 1), 24)
  let baseWib = null
  if (endRaw && DATE_RE.test(endRaw)) {
    const d = parseLocalDate(endRaw)
    baseWib = d ? new Date(d.getTime() + WIB_OFFSET_MS) : null
  }
  if (!baseWib) baseWib = new Date(Date.now() + WIB_OFFSET_MS)
  const months = []
  for (let i = 0; i < count; i++) {
    const firstUtc = new Date(Date.UTC(baseWib.getUTCFullYear(), baseWib.getUTCMonth() - i, 1))
    const days = new Date(Date.UTC(firstUtc.getUTCFullYear(), firstUtc.getUTCMonth() + 1, 1) - firstUtc.getTime()) / 86400000
    months.push({
      key: firstUtc.getUTCFullYear() + '-' + pad2Num(firstUtc.getUTCMonth() + 1),
      label: MONTH_LABELS_ID[firstUtc.getUTCMonth()],
      startMs: firstUtc.getTime() - WIB_OFFSET_MS,
      endMs: firstUtc.getTime() - WIB_OFFSET_MS + days * 86400000,
      startISO: new Date(firstUtc.getTime() - WIB_OFFSET_MS).toISOString(),
      endISO: new Date(firstUtc.getTime() - WIB_OFFSET_MS + days * 86400000).toISOString(),
    })
  }
  return months.reverse()
}

function durationHMS(min) {
  if (min == null || min === undefined || Number.isNaN(min)) return '—'
  let totalSec = Math.max(0, Math.round(Number(min) * 60))
  const h = Math.floor(totalSec / 3600)
  totalSec -= h * 3600
  const m = Math.floor(totalSec / 60)
  totalSec -= m * 60
  return pad2Num(h) + 'h ' + pad2Num(m) + 'm ' + pad2Num(totalSec) + 's'
}

function xlNum(n) { return n == null ? 0 : Math.round(Number(n)) }

async function excelAggregates(tid, slot, win, months) {
  const numberClause = slot == null ? '' : ' AND c.numberSlot = ' + parseInt(slot, 10)
  const [perfRaw, convRaw, resolvedRaw, mauRaw] = await Promise.all([
    prisma.$queryRawUnsafe(
      "SELECT strftime('%Y-%m', c.resolvedAt / 1000.0, 'unixepoch', '+7 hours') AS mk, " +
      "AVG((julianday(c.firstResponseAt / 1000.0, 'unixepoch') - julianday(c.firstIncomingAt / 1000.0, 'unixepoch')) * 86400.0) AS frSec, " +
      "AVG((julianday(c.resolvedAt / 1000.0, 'unixepoch') - julianday(c.firstAssignedAt / 1000.0, 'unixepoch')) * 86400.0) AS rsSec, " +
      "AVG((julianday(c.firstAssignedAt / 1000.0, 'unixepoch') - julianday(c.firstIncomingAt / 1000.0, 'unixepoch')) * 86400.0) AS wtSec " +
      'FROM Chat c ' +
      "WHERE c.tenantId = " + tid + " AND c.status = 'resolved' AND c.resolvedAt >= " + win.startMs + " AND c.resolvedAt < " + win.endMs + "" + numberClause + ' ' +
      'GROUP BY mk'
    ),
    prisma.$queryRawUnsafe(
      "SELECT strftime('%Y-%m', c.firstIncomingAt / 1000.0, 'unixepoch', '+7 hours') AS mk, COUNT(*) AS total, " +
      'SUM(CASE WHEN c.firstAssignedAt IS NOT NULL THEN 1 ELSE 0 END) AS assigned, ' +
      'SUM(CASE WHEN c.firstAssignedAt IS NULL THEN 1 ELSE 0 END) AS unassigned ' +
      'FROM Chat c ' +
      "WHERE c.tenantId = " + tid + " AND c.firstIncomingAt >= " + win.startMs + " AND c.firstIncomingAt < " + win.endMs + "" + numberClause + ' ' +
      'GROUP BY mk'
    ),
    prisma.$queryRawUnsafe(
      "SELECT strftime('%Y-%m', c.resolvedAt / 1000.0, 'unixepoch', '+7 hours') AS mk, COUNT(*) AS resolved " +
      'FROM Chat c ' +
      "WHERE c.tenantId = " + tid + " AND c.status = 'resolved' AND c.resolvedAt >= " + win.startMs + " AND c.resolvedAt < " + win.endMs + "" + numberClause + ' ' +
      'GROUP BY mk'
    ),
    prisma.$queryRawUnsafe(
      "SELECT strftime('%Y-%m', c.lastMessageAt / 1000.0, 'unixepoch', '+7 hours') AS mk, COUNT(DISTINCT c.contactPhone) AS mau " +
      'FROM Chat c ' +
      "WHERE c.tenantId = " + tid + " AND c.lastMessageAt >= " + win.startMs + " AND c.lastMessageAt < " + win.endMs + "" + numberClause + ' ' +
      'GROUP BY mk'
    ),
  ])
  const mapOf = (rows, valMap) => Object.fromEntries(rows.map((r) => [r.mk, valMap(r)]))
  const toNumOrNull = (v) => (v == null || Number.isNaN(Number(v)) ? null : Number(v))
  const perf = mapOf(perfRaw, (r) => ({ frSec: toNumOrNull(r.frSec), rsSec: toNumOrNull(r.rsSec), wtSec: toNumOrNull(r.wtSec) }))
  const conv = mapOf(convRaw, (r) => ({ total: xlNum(r.total), assigned: xlNum(r.assigned), unassigned: xlNum(r.unassigned) }))
  const resolved = mapOf(resolvedRaw, (r) => ({ resolved: xlNum(r.resolved) }))
  const mau = mapOf(mauRaw, (r) => ({ mau: xlNum(r.mau) }))
  return months.map((m) => {
    const p = perf[m.key] || {}
    const c = conv[m.key] || {}
    return {
      month: m.label,
      firstRespSec: p.frSec != null && !Number.isNaN(p.frSec) ? p.frSec : null,
      resolutionSec: p.rsSec != null && !Number.isNaN(p.rsSec) ? p.rsSec : null,
      waitSec: p.wtSec != null && !Number.isNaN(p.wtSec) ? p.wtSec : null,
      mau: (mau[m.key] || {}).mau || 0,
      total: c.total || 0,
      assigned: c.assigned || 0,
      unassigned: c.unassigned || 0,
      resolved: (resolved[m.key] || {}).resolved || 0,
      campaign: 0,
    }
  })
}

// GET /api/analytics/excel?months=N[&end=YYYY-MM-DD][&number=0..2] → .xlsx
router.get('/excel', ...rt, featAnalyticsGate, async (req, res) => {
  let ExcelJS
  try {
    ExcelJS = require('exceljs')
  } catch (e) {
    return res.status(500).json({ error: 'Library exceljs belum ter-install pada server' })
  }
  try {
    const tid = Number(req.tenantId)
    if (!Number.isFinite(tid)) return res.status(400).json({ error: 'tenant tidak valid' })
    const months = buildExcelMonths(req.query.months, req.query.end)
    const win = { startISO: months[0].startISO, endISO: months[months.length - 1].endISO, startMs: months[0].startMs, endMs: months[months.length - 1].endMs }

    // filter nomor eksplisit (opsional): kalau ada, hanya 1 sheet nomor itu (+ pesan per CS tetap global)
    let onlyNumber = null
    if (req.query.number !== undefined && req.query.number !== '') {
      onlyNumber = parseInt(req.query.number, 10)
      if (Number.isNaN(onlyNumber) || onlyNumber < 0 || onlyNumber > 2) {
        return res.status(400).json({ error: 'number harus integer 0..2' })
      }
    }

    const [tenant, tenantNumbers, msgRaw] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: tid }, select: { name: true, waPhone: true, brandName: true } }),
      prisma.tenantNumber.findMany({ where: { tenantId: tid }, orderBy: { slot: 'asc' } }),
      prisma.$queryRawUnsafe(
        "SELECT u.username AS username, u.role AS role, strftime('%Y-%m', m.timestamp / 1000.0, 'unixepoch', '+7 hours') AS mk, COUNT(*) AS n " +
        'FROM Message m JOIN User u ON u.id = m.senderId ' +
        "WHERE m.tenantId = " + tid + " AND m.isAuto = 0 AND m.direction = 'out' AND m.senderId IS NOT NULL " +
        "AND m.timestamp >= " + win.startMs + " AND m.timestamp < " + win.endMs + " " +
        "AND u.tenantId = " + tid + " AND u.role != 'super_admin' " +
        'GROUP BY m.senderId, mk ORDER BY u.username ASC'
      ),
    ])

    const numbers = tenantNumbers.length > 0
      ? tenantNumbers.map((n) => ({ slot: n.slot, label: n.label || null }))
      : [{ slot: 0, label: tenant && tenant.waPhone ? 'Nomor ' + tenant.waPhone : null }]
    const scopedNumbers = onlyNumber == null ? numbers : numbers.filter((n) => n.slot === onlyNumber)

    const allScope = await excelAggregates(tid, null, win, months)
    const perNumber = []
    for (const n of scopedNumbers) {
      perNumber.push({ slot: n.slot, label: n.label, rows: await excelAggregates(tid, n.slot, win, months) })
    }

    // Matrix pesan per CS × bulan (global semua nomor)
    const agentMap = new Map()
    const monthTotals = new Map(months.map((m) => [m.key, 0]))
    for (const r of msgRaw) {
      if (!months.some((m) => m.key === r.mk)) continue
      if (!agentMap.has(r.username)) {
        agentMap.set(r.username, { username: r.username, role: r.role, perMonth: new Map(months.map((m) => [m.key, 0])), total: 0 })
      }
      const a = agentMap.get(r.username)
      const n = xlNum(r.n)
      a.perMonth.set(r.mk, (a.perMonth.get(r.mk) || 0) + n)
      a.total += n
      monthTotals.set(r.mk, (monthTotals.get(r.mk) || 0) + n)
    }
    const agents = Array.from(agentMap.values()).sort((a, b) => b.total - a.total)

    const wb = new ExcelJS.Workbook()
    wb.creator = 'ChatBareng'
    const usedNames = new Set()
    function nextSheetName(base) {
      const clean = String(base || '').replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 28) || 'Sheet'
      let name = clean
      let i = 2
      while (usedNames.has(name)) name = clean.slice(0, 25) + ' ' + i++
      usedNames.add(name)
      return name
    }
    const nowWib = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false })
    const periodLabel = months[0].label + ' ' + months[0].key.slice(0, 4) + ' s/d ' + months[months.length - 1].label + ' ' + months[months.length - 1].key.slice(0, 4)
    const brandName = tenant && (tenant.brandName || tenant.name) ? (tenant.brandName || tenant.name) : 'ChatBareng'

    function styleHeader(cell) {
      cell.font = { bold: true }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } }
    }

    function addScopeSheet(baseTitle, rows) {
      const ws = wb.addWorksheet(nextSheetName(baseTitle))
      ws.getCell('A1').value = brandName + ' — ' + baseTitle
      ws.getCell('A1').font = { bold: true, size: 12 }
      ws.getCell('B2').value = 'Laporan: ' + periodLabel + ' (' + months.length + ' bulan)'
      ws.getCell('A3').value = 'Dibuat: ' + nowWib + ' WIB · sumber: Analytics ChatBareng'
      ws.getCell('A3').font = { size: 9, color: { argb: 'FF6B7280' } }
      let r = 6
      ws.getCell('A' + r).value = 'Bulan'
      ws.getCell('A' + r).font = { bold: true }
      ws.getCell('B' + r).value = 'Performance overview'
      ws.getCell('B' + r).font = { bold: true }
      r++
      const perfCols = ['Average First Response Time', 'Average Resolution Time', 'Average Wait Time', 'Monthly Active Users']
      for (let i = 0; i < perfCols.length; i++) {
        const cell = ws.getCell(r, 2 + i)
        cell.value = perfCols[i]
        styleHeader(cell)
      }
      r++
      rows.forEach((row) => {
        ws.getCell('A' + r).value = row.month
        ws.getCell('B' + r).value = durationHMS(row.firstRespSec != null ? row.firstRespSec / 60 : null)
        ws.getCell('C' + r).value = durationHMS(row.resolutionSec != null ? row.resolutionSec / 60 : null)
        ws.getCell('D' + r).value = durationHMS(row.waitSec != null ? row.waitSec / 60 : null)
        ws.getCell('E' + r).value = row.mau
        r++
      })
      r += 1
      ws.getCell('A' + r).value = 'Conversation overview'
      ws.getCell('A' + r).font = { bold: true }
      r++
      const convCols = ['Total Conversations', 'Assigned', 'Unassigned', 'Resolved', 'Campaign']
      for (let i = 0; i < convCols.length; i++) {
        const cell = ws.getCell(r, 1 + i)
        cell.value = convCols[i]
        styleHeader(cell)
      }
      r++
      rows.forEach((row) => {
        ws.getCell('A' + r).value = row.month
        ws.getCell('B' + r).value = row.total
        ws.getCell('C' + r).value = row.assigned
        ws.getCell('D' + r).value = row.unassigned
        ws.getCell('E' + r).value = row.resolved
        ws.getCell('F' + r).value = row.campaign
        r++
      })
      ws.getColumn('A').width = 20
      ws.getColumn('B').width = 26
      ws.getColumn('C').width = 26
      ws.getColumn('D').width = 20
      ws.getColumn('E').width = 20
      ws.getColumn('F').width = 12
    }

    addScopeSheet(onlyNumber == null ? 'Semua Nomor' : (scopedNumbers[0] && scopedNumbers[0].label) || 'Nomor slot ' + onlyNumber, allScope)
    for (const n of perNumber) {
      addScopeSheet(n.label || 'Nomor slot ' + n.slot, n.rows)
    }

    const wsMsg = wb.addWorksheet(nextSheetName('Pesan per CS'))
    wsMsg.getCell('A1').value = brandName + ' — Messages Sent per CS'
    wsMsg.getCell('A1').font = { bold: true, size: 12 }
    wsMsg.getCell('B2').value = 'Periode: ' + periodLabel
    wsMsg.getCell('A3').value = 'Dibuat: ' + nowWib + ' WIB · hanya pesan keluar CS manusia (auto-reply tidak dihitung)'
    wsMsg.getCell('A3').font = { size: 9, color: { argb: 'FF6B7280' } }
    let rm = 6
    styleHeader(wsMsg.getCell('A' + rm))
    wsMsg.getCell('A' + rm).value = 'Agen'
    months.forEach((m, i) => {
      styleHeader(wsMsg.getCell(rm, 2 + i))
      wsMsg.getCell(rm, 2 + i).value = m.label
    })
    const totCol = 2 + months.length
    styleHeader(wsMsg.getCell(rm, totCol))
    wsMsg.getCell(rm, totCol).value = 'Total'
    rm++
    agents.forEach((a) => {
      wsMsg.getCell('A' + rm).value = a.username
      months.forEach((m, i) => { wsMsg.getCell(rm, 2 + i).value = a.perMonth.get(m.key) || 0 })
      wsMsg.getCell(rm, totCol).value = a.total
      rm++
    })
    if (agents.length > 0) {
      wsMsg.getCell('A' + rm).value = 'Total'
      wsMsg.getCell('A' + rm).font = { bold: true }
      months.forEach((m, i) => {
        const c = wsMsg.getCell(rm, 2 + i)
        c.value = monthTotals.get(m.key) || 0
        c.font = { bold: true }
      })
      const tc = wsMsg.getCell(rm, totCol)
      tc.value = Array.from(monthTotals.values()).reduce((s, v) => s + v, 0)
      tc.font = { bold: true }
    }
    wsMsg.getColumn('A').width = 16
    for (let i = 2; i <= totCol; i++) wsMsg.getColumn(i).width = 12

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', 'attachment; filename="report-chatbareng-' + periodLabel.replace(/[^A-Za-z0-9]+/g, '-') + '.xlsx"')
    const buf = await wb.xlsx.writeBuffer()
    res.send(Buffer.from(buf))
  } catch (e) {
    console.error('Analytics excel error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
