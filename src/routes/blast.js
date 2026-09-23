const express = require('express')
const router = express.Router()
const multer = require('multer')
const prisma = require('../prisma')
const { requireAuth, requireAdmin, requireTenant } = require('../auth')
const broadcast = require('../socket/broadcast')

// v3.0 — Isolasi tenant: blast = tenant-scoped
const plans = require('../services/plans') // v3.4 — feature gate Blast (plan per-tenant)
const featBlastGate = plans.requireFeature('featBlast') // 403 ramah + upsell bila fitur OFF
const rt = [requireAuth, requireTenant]
const { runBlast } = require('../services/blast')
// v0.12.4 — enkripsi scope 2: message (template) tersimpan ciphertext, API/sender plaintext
const { encryptText, decryptTextSafe } = require('../services/textCrypto')

// Multer config for CSV uploads — in-memory, 5MB max
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
})

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Normalize a phone number to Indonesian 62xxx format.
 * Returns { normalized, valid, reason }.
 */
function normalizePhone(raw) {
  if (!raw) return { normalized: '', valid: false, reason: 'Empty' }

  // Strip spaces, dashes, parentheses, dots
  let phone = raw.replace(/[\s\-().]/g, '')

  // Remove leading +
  if (phone.startsWith('+')) {
    phone = phone.slice(1)
  }

  // Remove leading 0 → replace with 62 (Indonesian)
  if (phone.startsWith('0')) {
    phone = '62' + phone.slice(1)
  }

  // If starts with 8 and no country code, prepend 62
  if (phone.startsWith('8') && phone.length >= 8 && !phone.startsWith('62')) {
    phone = '62' + phone
  }

  // Validate: must be all digits, at least 8 digits after country code (62)
  if (!/^\d+$/.test(phone)) {
    return { normalized: '', valid: false, reason: 'Contains non-digit characters' }
  }

  if (!phone.startsWith('62')) {
    // Not Indonesian format — accept if it's all digits and long enough
    if (phone.length < 8) {
      return { normalized: '', valid: false, reason: 'Too short' }
    }
  } else {
    // Indonesian: 62 + at least 8 digits
    if (phone.length < 10) {
      return { normalized: '', valid: false, reason: 'Too short (min 8 digits after 62)' }
    }
  }

  if (phone.length > 15) {
    return { normalized: '', valid: false, reason: 'Too long' }
  }

  return { normalized: phone, valid: true, reason: '' }
}

/**
 * Parse CSV content into rows.
 * Supports: name,phone / phone only / name,phone,notes (extra cols ignored)
 * Handles both with and without header row.
 */
function parseCsv(csvText) {
  const lines = csvText.split(/\r?\n/).filter(l => l.trim().length > 0)
  if (lines.length === 0) return []

  // Auto-detect delimiter: count ; vs , in first line, use the more frequent one
  const firstLineRaw = lines[0]
  const semicolonCount = (firstLineRaw.match(/;/g) || []).length
  const commaCount = (firstLineRaw.match(/,/g) || []).length
  const delimiter = semicolonCount > commaCount ? ';' : ','

  // Detect header row — if first line contains "name" or "phone" (case-insensitive)
  const firstLine = firstLineRaw.toLowerCase()
  let startIdx = 0
  let nameCol = 0
  let phoneCol = 1

  if (firstLine.includes('name') || firstLine.includes('phone') || firstLine.includes('nomor') || firstLine.includes('nama')) {
    startIdx = 1
    // Find column indices from header
    const headers = lines[0].split(delimiter).map(h => h.trim().toLowerCase())
    const nameIdx = headers.findIndex(h => h === 'name' || h === 'nama')
    const phoneIdx = headers.findIndex(h => h === 'phone' || h === 'telepon' || h === 'nomor' || h === 'no' || h === 'number' || h === 'hp' || h === 'wa')
    if (nameIdx >= 0) nameCol = nameIdx
    if (phoneIdx >= 0) phoneCol = phoneIdx
    // If only 1 column total and it's "phone", phoneCol should be 0
    if (headers.length === 1) phoneCol = 0
  } else {
    // No header — detect format from first data line
    const cols = lines[0].split(delimiter)
    if (cols.length === 1) {
      // Single column: phone only
      phoneCol = 0
      nameCol = -1
    }
  }

  const results = []
  for (let i = startIdx; i < lines.length; i++) {
    const cols = lines[i].split(delimiter).map(c => c.trim().replace(/^"(.*)"$/, '$1'))
    const phoneRaw = cols[phoneCol] || ''
    const name = nameCol >= 0 ? (cols[nameCol] || '') : ''
    const { normalized, valid, reason } = normalizePhone(phoneRaw)
    results.push({ name, phone: phoneRaw, normalized, valid, reason })
  }

  return results
}

// ─── Routes ───────────────────────────────────────────────────────────

// POST /api/blast/upload-csv — upload CSV, parse, normalize, return numbers
router.post('/upload-csv', ...rt, featBlastGate, csvUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No CSV file uploaded' })
    }

    // Validate file type
    const ext = req.file.originalname.split('.').pop().toLowerCase()
    if (ext !== 'csv' && !req.file.mimetype.includes('csv') && !req.file.mimetype.includes('text')) {
      return res.status(400).json({ error: 'File must be a CSV' })
    }

    const csvText = req.file.buffer.toString('utf-8')
    const parsed = parseCsv(csvText)

    if (parsed.length === 0) {
      return res.status(400).json({ error: 'CSV file is empty or has no valid rows' })
    }

    // Max 5000 rows
    if (parsed.length > 5000) {
      return res.status(400).json({ error: 'Maximum 5000 rows per upload' })
    }

    // Dedup by normalized phone within the CSV
    const seen = new Set()
    const numbers = []
    let totalValid = 0
    let totalInvalid = 0
    let duplicates = 0

    for (const row of parsed) {
      if (row.valid && row.normalized) {
        if (seen.has(row.normalized)) {
          duplicates++
          // Mark as invalid duplicate
          numbers.push({ name: row.name, phone: row.phone, normalized: row.normalized, valid: false, reason: 'Duplicate in CSV' })
          continue
        }
        seen.add(row.normalized)
        numbers.push({ name: row.name, phone: row.phone, normalized: row.normalized, valid: true, reason: '' })
        totalValid++
      } else {
        numbers.push({ name: row.name, phone: row.phone, normalized: row.normalized || '', valid: false, reason: row.reason || 'Invalid' })
        totalInvalid++
      }
    }

    res.json({ numbers, totalValid, totalInvalid, duplicates })
  } catch (e) {
    console.error('CSV upload error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/blast/preview — preview recipients (dedup + count + cold number detection)
router.post('/preview', ...rt, featBlastGate, async (req, res) => {
  try {
    const { recipientChatIds = [], tagIds = [], csvNumbers = [] } = req.body

    let chatIds = new Set([...recipientChatIds])

    // If tagIds provided, fetch chats with those tags
    if (tagIds.length > 0) {
      const tagNumIds = tagIds.map(id => parseInt(id, 10)).filter(id => !isNaN(id))
      if (tagNumIds.length > 0) {
        const where = { tenantId: req.tenantId, AND: tagNumIds.map(tagId => ({ tags: { some: { tagId } } })) }
        const taggedChats = await prisma.chat.findMany({
          where,
          select: { id: true, contactName: true, contactPhone: true },
        })
        for (const c of taggedChats) {
          chatIds.add(c.id)
        }
      }
    }

    // Fetch chat details for all collected IDs (tenant-scoped)
    const allChatIds = [...chatIds]
    const chats = await prisma.chat.findMany({
      where: { tenantId: req.tenantId, id: { in: allChatIds } },
      select: { id: true, contactName: true, contactPhone: true },
    })

    // Build a map of existing phones from chats (for cold number detection)
    const existingPhones = new Set()
    const existingChatIds = new Set()
    for (const c of chats) {
      existingChatIds.add(c.id)
      if (c.contactPhone) {
        // Normalize the DB phone for comparison
        const norm = normalizePhone(c.contactPhone)
        if (norm.valid) existingPhones.add(norm.normalized)
      }
    }

    // Process CSV numbers
    const warmNumbers = []
    const coldNumbers = []

    for (const csv of csvNumbers) {
      if (!csv.valid || !csv.normalized) continue
      // Check if this phone exists in DB
      if (existingPhones.has(csv.normalized)) {
        // Find the chat record
        const chat = chats.find(c => {
          const norm = normalizePhone(c.contactPhone)
          return norm.valid && norm.normalized === csv.normalized
        })
        warmNumbers.push({
          phone: csv.normalized,
          name: csv.name || chat?.contactName || csv.normalized,
          chatId: chat?.id || null,
        })
      } else {
        // Also check if a chat with this JID exists
        const jid = `${csv.normalized}@s.whatsapp.net`
        if (existingChatIds.has(jid)) {
          warmNumbers.push({ phone: csv.normalized, name: csv.name || csv.normalized, chatId: jid })
        } else {
          coldNumbers.push({ phone: csv.normalized, name: csv.name || csv.normalized })
        }
      }
    }

    const totalRecipients = chats.length + coldNumbers.length + warmNumbers.filter(w => !chats.find(c => c.id === w.chatId)).length
    const sample = [
      ...chats.slice(0, 3).map(c => ({ chatId: c.id, name: c.contactName || c.contactPhone || 'Pelanggan', phone: c.contactPhone })),
      ...warmNumbers.slice(0, 1).map(w => ({ chatId: w.chatId, name: w.name, phone: w.phone })),
      ...coldNumbers.slice(0, 1).map(c => ({ chatId: null, name: c.name, phone: c.phone })),
    ].slice(0, 5)

    res.json({
      totalRecipients,
      sample,
      duplicatesRemoved: allChatIds.length - chats.length,
      coldNumbers,
      warmNumbers,
    })
  } catch (e) {
    console.error('Blast preview error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/blast — create + start blast (any authenticated user)
router.post('/', ...rt, featBlastGate, async (req, res) => {
  try {
    const {
      message,
      recipientChatIds = [],
      tagIds = [],
      csvNumbers = [],
      name,
      delayPerMsg,
      delayPerGroup,
      groupSize,
      mediaPath,
      // v3.9 — multi-nomor: numberSlots (array slot) + rotateEvery (null/0 = fixed)
      numberSlots,
      rotateEvery,
    } = req.body

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message is required' })
    }

    // Collect all chat IDs from direct selection + tags
    let allChatIds = new Set([...recipientChatIds])

    // Add chats from tags
    if (tagIds.length > 0) {
      const tagNumIds = tagIds.map(id => parseInt(id, 10)).filter(id => !isNaN(id))
      if (tagNumIds.length > 0) {
        const where = { tenantId: req.tenantId, AND: tagNumIds.map(tagId => ({ tags: { some: { tagId } } })) }
        const taggedChats = await prisma.chat.findMany({
          where,
          select: { id: true },
        })
        for (const c of taggedChats) {
          allChatIds.add(c.id)
        }
      }
    }

    // Fetch chat details for personalization (tenant-scoped)
    const uniqueChatIds = [...allChatIds]
    const chats = await prisma.chat.findMany({
      where: { tenantId: req.tenantId, id: { in: uniqueChatIds } },
      select: { id: true, contactName: true, contactPhone: true },
    })

    // Build a set of normalized phones from existing chats for dedup
    const existingChatPhones = new Map() // normalizedPhone → chat
    for (const c of chats) {
      if (c.contactPhone) {
        const norm = normalizePhone(c.contactPhone)
        if (norm.valid) existingChatPhones.set(norm.normalized, c)
      }
    }

    // Process CSV numbers — dedup against chat list
    const csvRecipients = [] // { phoneNumber, contactName }
    const seenPhones = new Set(existingChatPhones.keys())

    for (const csv of csvNumbers) {
      if (!csv.valid || !csv.normalized) continue
      // If this phone is already in chat list, skip (will be sent via chatId)
      if (seenPhones.has(csv.normalized)) continue
      seenPhones.add(csv.normalized)
      csvRecipients.push({ phoneNumber: csv.normalized, contactName: csv.name || null })
    }

    const totalRecipients = chats.length + csvRecipients.length
    if (totalRecipients === 0) {
      return res.status(400).json({ error: 'No recipients selected' })
    }

    // Max recipients check
    const maxRecipients = parseInt(process.env.BLAST_MAX_RECIPIENTS || '1000', 10)
    if (totalRecipients > maxRecipients) {
      return res.status(400).json({ error: `Maximum ${maxRecipients} recipients allowed` })
    }

    // Create blast record with logs
    // v3.9 — numberSlots/rotateEvery tersimpan (null = slot-0 fixed = compat)
    let numberSlotsJson = null
    if (Array.isArray(numberSlots) && numberSlots.length > 0) {
      const valid = [...new Set(numberSlots.map(Number).filter((n) => Number.isFinite(n) && n >= 0 && n <= 2))].sort((a, b) => a - b)
      numberSlotsJson = valid.length > 0 ? JSON.stringify(valid) : null
    }
    const rotateEveryInt = (numberSlotsJson && JSON.parse(numberSlotsJson).length > 1)
      ? Math.max(0, parseInt(rotateEvery, 10) || 0) || null
      : null // rotasi butuh ≥2 slot

    const blast = await prisma.blast.create({
      data: {
        tenantId: req.tenantId,
        name: name || null,
        message: encryptText(message.trim()), // v0.12.4 — template mentah terenkripsi at-rest (personalisasi {name} SETELAH dekrip di services/blast.js)
        mediaPath: mediaPath || null,
        totalRecipients,
        delayPerMsg: delayPerMsg || 5,
        delayPerGroup: delayPerGroup || 60,
        groupSize: groupSize || 100,
        numberSlots: numberSlotsJson, // v3.9 — JSON array slot (null = slot-0)
        rotateEvery: rotateEveryInt,
        status: 'pending',
        createdBy: req.user.id,
        logs: {
          create: [
            // Chat-based recipients
            ...chats.map(c => ({
              chatId: c.id,
              phoneNumber: c.contactPhone,
              contactName: c.contactName,
              status: 'pending',
            })),
            // CSV-based recipients (no chatId)
            ...csvRecipients.map(r => ({
              chatId: null,
              phoneNumber: r.phoneNumber,
              contactName: r.contactName,
              status: 'pending',
            })),
          ],
        },
      },
    })

    // Start blast in background (don't await)
    runBlast(blast.id).catch(err => {
      console.error(`[Blast] Background error for blast ${blast.id}:`, err)
    })

    res.json({ blastId: blast.id, totalRecipients })
  } catch (e) {
    console.error('Create blast error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/blast — list blasts (paginated)
router.get('/', ...rt, featBlastGate, async (req, res) => {
  try {
    const page = parseInt(req.query.page || '1', 10)
    const limit = parseInt(req.query.limit || '20', 10)
    const skip = (page - 1) * limit

    const where = { tenantId: req.tenantId }
    // CS only sees their own blasts
    if (req.user.role !== 'admin') {
      where.createdBy = req.user.id
    }

    const [blasts, total] = await Promise.all([
      prisma.blast.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          createdByUser: { select: { id: true, username: true } },
        },
      }),
      prisma.blast.count({ where }),
    ])

    // v0.12.4 — enkripsi scope 2: API return plaintext
    const blastsPlain = blasts.map(b => ({ ...b, message: decryptTextSafe(b.message) }))

    res.json({
      blasts: blastsPlain,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    })
  } catch (e) {
    console.error('List blasts error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/blast/:id — blast detail + logs (paginated)
router.get('/:id', ...rt, featBlastGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    const page = parseInt(req.query.page || '1', 10)
    const limit = parseInt(req.query.limit || '50', 10)
    const skip = (page - 1) * limit

    const blast = await prisma.blast.findFirst({
      where: { id, tenantId: req.tenantId },
      include: {
        createdByUser: { select: { id: true, username: true } },
      },
    })

    if (!blast) return res.status(404).json({ error: 'Blast not found' })

    // CS can only see their own blasts
    if (req.user.role !== 'admin' && blast.createdBy !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' })
    }

    const [logs, totalLogs] = await Promise.all([
      prisma.blastLog.findMany({
        where: { blastId: id },
        orderBy: { id: 'asc' },
        skip,
        take: limit,
      }),
      prisma.blastLog.count({ where: { blastId: id } }),
    ])

    res.json({
      blast: { ...blast, message: decryptTextSafe(blast.message) }, // v0.12.4 — plaintext
      logs,
      pagination: { page, limit, total: totalLogs, pages: Math.ceil(totalLogs / limit) },
    })
  } catch (e) {
    console.error('Blast detail error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/blast/:id/export — export blast results as CSV (owner or admin)
router.get('/:id/export', ...rt, featBlastGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    const blast = await prisma.blast.findFirst({ where: { id, tenantId: req.tenantId } })

    if (!blast) return res.status(404).json({ error: 'Blast not found' })

    // CS can only export their own blasts
    if (req.user.role !== 'admin' && blast.createdBy !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' })
    }

    // Fetch ALL logs (no pagination for export)
    const logs = await prisma.blastLog.findMany({
      where: { blastId: id },
      orderBy: { id: 'asc' },
    })

    // Build CSV
    const csvLines = ['name,phone,status,error,sent_at']
    for (const log of logs) {
      const name = (log.contactName || '').replace(/"/g, '""')
      const phone = (log.phoneNumber || log.chatId || '').replace(/"/g, '""')
      const status = log.status || 'pending'
      const error = (log.error || '').replace(/"/g, '""')
      const sentAt = log.sentAt ? new Date(log.sentAt).toISOString() : ''
      csvLines.push(`"${name}","${phone}","${status}","${error}","${sentAt}"`)
    }

    const csv = csvLines.join('\n')
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="blast_${id}_results.csv"`)
    res.send(csv)
  } catch (e) {
    console.error('Export blast error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/blast/:id/pause — pause (owner or admin)
router.post('/:id/pause', ...rt, featBlastGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    const blast = await prisma.blast.findFirst({ where: { id, tenantId: req.tenantId } })
    if (!blast) return res.status(404).json({ error: 'Blast not found' })
    if (req.user.role !== 'admin' && blast.createdBy !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' })
    }
    if (blast.status !== 'running') {
      return res.status(400).json({ error: 'Blast is not running' })
    }

    await prisma.blast.update({ where: { id }, data: { status: 'paused' } })
    broadcast.emitToTenant(req.tenantId, 'blast_progress', { blastId: id, status: 'paused' })
    res.json({ success: true })
  } catch (e) {
    console.error('Pause blast error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/blast/:id/resume — resume (owner or admin)
router.post('/:id/resume', ...rt, featBlastGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    const blast = await prisma.blast.findFirst({ where: { id, tenantId: req.tenantId } })
    if (!blast) return res.status(404).json({ error: 'Blast not found' })
    if (req.user.role !== 'admin' && blast.createdBy !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' })
    }
    if (blast.status !== 'paused') {
      return res.status(400).json({ error: 'Blast is not paused' })
    }

    await prisma.blast.update({ where: { id }, data: { status: 'running' } })
    broadcast.emitToTenant(req.tenantId, 'blast_progress', { blastId: id, status: 'running' })
    res.json({ success: true })
  } catch (e) {
    console.error('Resume blast error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/blast/:id/cancel — cancel (owner or admin)
router.post('/:id/cancel', ...rt, featBlastGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    const blast = await prisma.blast.findFirst({ where: { id, tenantId: req.tenantId } })
    if (!blast) return res.status(404).json({ error: 'Blast not found' })
    if (req.user.role !== 'admin' && blast.createdBy !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' })
    }
    if (!['running', 'paused', 'pending'].includes(blast.status)) {
      return res.status(400).json({ error: 'Blast cannot be cancelled' })
    }

    await prisma.blast.update({ where: { id }, data: { status: 'cancelled' } })
    broadcast.emitToTenant(req.tenantId, 'blast_progress', { blastId: id, status: 'cancelled' })
    res.json({ success: true })
  } catch (e) {
    console.error('Cancel blast error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/blast/:id — delete blast (admin only)
router.delete('/:id', ...rt, featBlastGate, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    const blast = await prisma.blast.findFirst({ where: { id, tenantId: req.tenantId } })
    if (!blast) return res.status(404).json({ error: 'Blast not found' })

    // Delete logs first (cascade), then blast
    // v0.12.4 — record terenkripsi dihapus langsung; plaintext legacy tidak pernah di-echo/log
    await prisma.blastLog.deleteMany({ where: { blastId: id } })
    await prisma.blast.delete({ where: { id } })
    res.json({ success: true })
  } catch (e) {
    console.error('Delete blast error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router