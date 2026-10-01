const express = require('express')
const router = express.Router()
const multer = require('multer')
const path = require('path')
const config = require('../config')
const { requireAuth, verifyToken, resolveTenant } = require('../auth')

// v3.0 — Isolasi tenant: media milik chat tenant. Flexible auth (header/query token)
// → tenant resolve soft; upload = tenant dari JWT.
function requireMediaAuth(req, res, next) {
  // reuse flexible auth lalu resolveTenant
  const header = req.headers.authorization
  const tryDecode = (token) => {
    const decoded = verifyToken(token)
    if (decoded) {
      req.user = decoded
      resolveTenant(req, res, () => next())
      return true
    }
    return false
  }
  if (header && header.startsWith('Bearer ')) {
    if (tryDecode(header.slice(7))) return
  }
  const queryToken = req.query.token
  if (queryToken) {
    if (tryDecode(queryToken)) return
  }
  return res.status(401).json({ error: 'No valid token provided' })
}
const { saveMedia, loadMedia } = require('../wa/media')
const prisma = require('../prisma')

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxMediaSizeMb * 1024 * 1024 },
})



// POST /api/media/upload
router.post('/upload', requireAuth, resolveTenant, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
    
    const allowedTypes = [
      'image/jpeg', 'image/png', 'image/webp',
      'video/mp4', 'audio/mp3', 'application/pdf',
    ]
    if (!allowedTypes.includes(req.file.mimetype)) {
      return res.status(400).json({ error: 'File type not allowed' })
    }
    
    const ext = req.file.originalname.split('.').pop() || 'bin'
    const filepath = await saveMedia(req.file.buffer, ext)
    
    res.json({
      mediaId: filepath,
      mediaType: req.file.mimetype.split('/')[0],
      mediaMime: req.file.mimetype,
      mediaSize: req.file.size,
    })
  } catch (e) {
    console.error('Upload error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/media/:messageId — serve decrypted media
router.get('/:messageId', requireMediaAuth, async (req, res) => {
  try {
    const messageId = parseInt(req.params.messageId, 10)
    // v3 — tenant-scoped: user tenant → tenant JWT; super_admin → ?tenant= wajib
    const tid = req.user.role === 'super_admin'
      ? parseInt(req.query.tenant ?? req.headers['x-tenant-id'], 10)
      : Number(req.user.tenantId)
    if (!Number.isFinite(tid)) return res.status(400).json({ error: 'tenant tidak valid' })
    const message = await prisma.message.findFirst({ where: { id: messageId, tenantId: tid } })

    if (!message || !message.mediaPath) {
      return res.status(404).json({ error: 'Media not found' })
    }

    // v0.1.21 — Isolasi: CS hanya boleh akses media chat yang bisa diaksesnya
    if (req.user.role !== 'admin') {
      const chat = await prisma.chat.findFirst({ where: { id: message.chatId, tenantId: tid } })
      const allowed = chat && (
        (chat.assignedToId === req.user.id && chat.status === 'open') ||
        chat.resolvedById === req.user.id
      )
      if (!allowed) {
        return res.status(403).json({ error: 'Anda tidak memiliki akses ke media ini' })
      }
    }
    
    const buffer = loadMedia(message.mediaPath)
    
    res.setHeader('Content-Type', message.mediaMime || 'application/octet-stream')
    res.setHeader('Content-Length', buffer.length)
    res.send(buffer)
  } catch (e) {
    console.error('Media serve error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router