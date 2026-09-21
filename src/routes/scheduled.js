/**
 * v0.10.0 — Pesan Terjadwal API (Fitur D)
 * POST /api/scheduled { chatId, body, scheduledAt } — assigned CS/admin (pemilik chat)
 * GET  /api/scheduled?chatId= — pending list chat itu (pemilik/admin)
 * POST /api/scheduled/:id/cancel — pemilik ATAU admin, hanya selama pending
 * GET  /api/scheduled/all — admin: semua pesan terjadwal
 *
 * Pengiriman dilakukan scheduler in-process (services/v0100Scheduler.js).
 * Validasi: scheduledAt > now + 2 menit, body ≤ 4000 char.
 */
const express = require('express')
const router = express.Router()
const prisma = require('../prisma')
const { requireAuth, requireAdmin, requireTenant } = require('../auth')

// v3.0 — Isolasi tenant: pesan terjadwal = tenant-scoped
const rt = [requireAuth, requireTenant]
const broadcast = require('../socket/broadcast')
// v0.12.4 — enkripsi scope 2: body tersimpan ciphertext, API/scheduler baca plaintext
const { encryptText, decryptTextSafe } = require('../services/textCrypto')

const MAX_BODY_LEN = 4000
const MIN_DELAY_MS = 2 * 60 * 1000 // > now + 2 menit

// Chat yang boleh diakses CS: pemilik assignment aktif ATAU resolver. Admin semua.
function canAccessChat(user, chat) {
  if (user.role === 'admin') return true
  if (chat.assignedToId === user.id && chat.status === 'open') return true
  if (chat.resolvedById === user.id) return true
  return false
}

// POST /api/scheduled
router.post('/', ...rt, async (req, res) => {
  try {
    const { chatId, body, scheduledAt } = req.body || {}
    if (!chatId || typeof body !== 'string' || !body.trim()) {
      return res.status(400).json({ error: 'chatId dan body wajib diisi' })
    }
    if (body.length > MAX_BODY_LEN) {
      return res.status(400).json({ error: `Pesan maksimal ${MAX_BODY_LEN} karakter` })
    }

    const chat = await prisma.chat.findFirst({ where: { id: Number(chatId), tenantId: req.tenantId } })
    if (!chat) return res.status(404).json({ error: 'Chat not found' })
    if (!canAccessChat(req.user, chat)) {
      return res.status(403).json({ error: 'Anda tidak memiliki akses ke chat ini' })
    }

    const when = new Date(scheduledAt)
    if (!scheduledAt || isNaN(when.getTime())) {
      return res.status(400).json({ error: 'scheduledAt (ISO datetime) wajib dan valid' })
    }
    if (when.getTime() <= Date.now() + MIN_DELAY_MS) {
      return res.status(400).json({ error: 'Waktu terjadwal minimal 2 menit dari sekarang' })
    }

    const sm = await prisma.scheduledMessage.create({
      data: {
        tenantId: req.tenantId,
        chatId: chat.id,
        createdById: req.user.id,
        body: encryptText(body.trim()), // v0.12.4 — body terenkripsi at-rest
        scheduledAt: when,
        status: 'pending',
      },
      include: { user: { select: { id: true, username: true } } },
    })
    const smPlain = { ...sm, body: decryptTextSafe(sm.body) } // v0.12.4 — API/broadcast plaintext

    // Real-time panel update untuk viewer chat yang sama
    broadcast.emitToRoom(`chat:${chat.id}`, 'scheduled_added', { chatId: chat.id, scheduled: smPlain })
    res.status(201).json({ scheduled: smPlain })
  } catch (e) {
    console.error('Scheduled create error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/scheduled?chatId= — pending list milik chat (pemilik/admin melihat
// pending chat itu; CS non-pemilik tetap 403 via canAccessChat)
router.get('/', ...rt, async (req, res) => {
  try {
    const chatId = req.query.chatId
    if (!chatId) return res.status(400).json({ error: 'chatId wajib' })
    const chat = await prisma.chat.findFirst({ where: { id: Number(chatId), tenantId: req.tenantId } })
    if (!chat) return res.status(404).json({ error: 'Chat not found' })
    if (!canAccessChat(req.user, chat)) {
      return res.status(403).json({ error: 'Anda tidak memiliki akses ke chat ini' })
    }
    const scheduled = await prisma.scheduledMessage.findMany({
      where: { tenantId: req.tenantId, chatId: chat.id, status: 'pending' },
      orderBy: { scheduledAt: 'asc' },
      include: { user: { select: { id: true, username: true } } },
    })
    // v0.12.4 — enkripsi scope 2: API return plaintext
    res.json({ scheduled: scheduled.map(s => ({ ...s, body: decryptTextSafe(s.body) })) })
  } catch (e) {
    console.error('Scheduled list error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/scheduled/:id/cancel — pemilik ATAU admin, hanya saat pending
router.post('/:id/cancel', ...rt, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' })
    const sm = await prisma.scheduledMessage.findFirst({ where: { id, tenantId: req.tenantId } })
    if (!sm) return res.status(404).json({ error: 'Pesan terjadwal tidak ditemukan' })
    if (sm.createdById !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Hanya pembuat pesan atau admin yang bisa membatalkan' })
    }
    if (sm.status !== 'pending') {
      return res.status(400).json({ error: `Pesan sudah ${sm.status} — tidak bisa dibatalkan` })
    }
    // Atomic cancel: hanya bila masih pending (race dgn scheduler)
    const cancelled = await prisma.scheduledMessage.updateMany({
      where: { id, tenantId: req.tenantId, status: 'pending' },
      data: { status: 'cancelled' },
    })
    if (cancelled.count === 0) {
      return res.status(400).json({ error: 'Pesan sudah diproses — tidak bisa dibatalkan' })
    }
    broadcast.emitToRoom(`chat:${sm.chatId}`, 'scheduled_updated', {
      chatId: sm.chatId,
      id,
      status: 'cancelled',
    })
    res.json({ success: true })
  } catch (e) {
    console.error('Scheduled cancel error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/scheduled/all — admin: semua pesan terjadwal
router.get('/all', ...rt, requireAdmin, async (req, res) => {
  try {
    const status = req.query.status
    const where = status ? { tenantId: req.tenantId, status } : { tenantId: req.tenantId }
    const scheduled = await prisma.scheduledMessage.findMany({
      where,
      orderBy: { scheduledAt: 'desc' },
      take: 200,
      include: {
        user: { select: { id: true, username: true } },
        chat: { select: { id: true, contactName: true, contactPhone: true } },
      },
    })
    // v0.12.4 — enkripsi scope 2: API return plaintext
    res.json({ scheduled: scheduled.map(s => ({ ...s, body: decryptTextSafe(s.body) })) })
  } catch (e) {
    console.error('Scheduled all error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router