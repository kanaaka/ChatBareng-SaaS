const express = require('express')
const router = express.Router()
const multer = require('multer')
const path = require('path')
const fs = require('fs')
const config = require('../config')
const prisma = require('../prisma')
const { requireAuth, requireAdmin, requireTenant, verifyToken, resolveTenant } = require('../auth')
// v3.4 — kuota Tangan Kanan per-tenant (spec §4: hanya TK; media chat/blast tidak ikut)
const plans = require('../services/plans')
const { saveMedia, loadMedia, resolveMediaFilePath } = require('../wa/media')
const broadcast = require('../socket/broadcast')

// v3.0 — Isolasi tenant: folder/file Tangan Kanan = tenant-scoped. Download flexible
// auth → tenant resolve soft (user tenant dari JWT; super_admin via ?tenant=).
const rt = [requireAuth, requireTenant]

// Multer for file uploads (in-memory, 10MB limit)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxMediaSizeMb * 1024 * 1024 },
})

// Flexible auth (supports query param for download via <img>/etc)
function requireAuthFlexible(req, res, next) {
  const tryDecode = (token) => {
    const decoded = verifyToken(token)
    if (decoded) {
      req.user = decoded
      resolveTenant(req, res, () => next())
      return true
    }
    return false
  }
  const header = req.headers.authorization
  if (header && header.startsWith('Bearer ')) {
    if (tryDecode(header.slice(7))) return
  }
  const queryToken = req.query.token
  if (queryToken) {
    if (tryDecode(queryToken)) return
  }
  return res.status(401).json({ error: 'No valid token provided' })
}

// Determine file type from mimetype
function getFileType(mimetype) {
  if (mimetype.startsWith('image/')) return 'image'
  if (mimetype.startsWith('video/')) return 'document'
  if (mimetype === 'application/pdf' || mimetype.includes('document') || mimetype.includes('msword') || mimetype.includes('officedocument')) return 'document'
  return 'document'
}

// Determine which system folder a file type belongs to
function getSystemFolderId(type, folders) {
  const folder = folders.find(f => f.isSystem && f.name.toLowerCase() === type)
  return folder?.id || null
}

// ─── Folders ─────────────────────────────────────────────────────

// GET /api/tk/folders — list folders with files grouped
router.get('/folders', ...rt, async (req, res) => {
  try {
    const folders = await prisma.sharedFolder.findMany({
      where: { tenantId: req.tenantId },
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      include: {
        files: {
          orderBy: { createdAt: 'desc' },
          include: {
            uploader: { select: { id: true, username: true } },
          },
        },
      },
    })

    // Also get uncategorized files (folderId = null)
    const uncategorized = await prisma.sharedFile.findMany({
      where: { tenantId: req.tenantId, folderId: null },
      orderBy: { createdAt: 'desc' },
      include: { uploader: { select: { id: true, username: true } } },
    })

    res.json({ folders, uncategorized })
  } catch (e) {
    console.error('TK list folders error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/tk/folders — create custom folder
router.post('/folders', ...rt, async (req, res) => {
  try {
    const { name } = req.body
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Folder name is required' })
    }

    const trimmed = name.trim()

    // Prevent creating system folder names
    const systemNames = ['image', 'document', 'link']
    if (systemNames.includes(trimmed.toLowerCase())) {
      return res.status(400).json({ error: 'Cannot create folder with system name' })
    }

    // Check uniqueness
    const existing = await prisma.sharedFolder.findFirst({ where: { tenantId: req.tenantId, name: trimmed } })
    if (existing) {
      return res.status(409).json({ error: 'Folder name already exists' })
    }

    const folder = await prisma.sharedFolder.create({
      data: {
        tenantId: req.tenantId,
        name: trimmed,
        isSystem: false,
        createdBy: req.user.id,
      },
    })

    broadcast.emitToTenant(req.tenantId, 'tk_folder_created', { folder })

    res.status(201).json({ folder })
  } catch (e) {
    console.error('TK create folder error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/tk/folders/:id — delete folder (admin only), files move to uncategorized
router.delete('/folders/:id', ...rt, requireAdmin, async (req, res) => {
  try {
    const folderId = parseInt(req.params.id, 10)
    const folder = await prisma.sharedFolder.findFirst({ where: { id: folderId, tenantId: req.tenantId } })

    if (!folder) return res.status(404).json({ error: 'Folder not found' })
    if (folder.isSystem) return res.status(400).json({ error: 'Cannot delete system folder' })

    // Move files to uncategorized
    await prisma.sharedFile.updateMany({
      where: { folderId },
      data: { folderId: null },
    })

    await prisma.sharedFolder.delete({ where: { id: folderId } })

    broadcast.emitToTenant(req.tenantId, 'tk_folder_deleted', { folderId })

    res.json({ success: true })
  } catch (e) {
    console.error('TK delete folder error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ─── Files ───────────────────────────────────────────────────────

// GET /api/tk/files — list files with optional filters
router.get('/files', ...rt, async (req, res) => {
  try {
    const where = { tenantId: req.tenantId }

    if (req.query.folderId) {
      const fid = parseInt(req.query.folderId, 10)
      if (!isNaN(fid)) where.folderId = fid
    }

    if (req.query.pinnedOnly === 'true') {
      where.isPinned = true
    }

    if (req.query.type) {
      where.type = req.query.type
    }

    if (req.query.search) {
      const q = req.query.search.trim()
      if (q.length >= 2) {
        where.OR = [
          { filename: { contains: q } },
          { title: { contains: q } },
          { url: { contains: q } },
        ]
      }
    }

    const files = await prisma.sharedFile.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        uploader: { select: { id: true, username: true } },
        folder: { select: { id: true, name: true } },
      },
    })

    res.json({ files })
  } catch (e) {
    console.error('TK list files error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/tk/files/upload — upload file (multipart)
router.post('/files/upload', ...rt, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' })
    }

    // v3.4 — kuota TK: SUM SharedFile.size tenant + incoming vs tkQuotaBytes → 403 ramah
    const tkQuota = await plans.checkTkQuota(req.tenantId, req.file.size)
    if (!tkQuota.ok) {
      return res.status(403).json({ error: plans.tkQuotaMessage(tkQuota.current + tkQuota.incoming, tkQuota.quota) })
    }

    const type = getFileType(req.file.mimetype)
    const ext = req.file.originalname.split('.').pop() || 'bin'

    // Encrypt and save
    const storagePath = await saveMedia(req.file.buffer, ext)

    // Determine folder: use provided folderId, or auto-categorize to system folder
    let folderId = req.body.folderId ? parseInt(req.body.folderId, 10) : null
    if (isNaN(folderId)) folderId = null

    if (!folderId) {
      // Auto-categorize to system folder (tenant-scoped)
      const systemFolders = await prisma.sharedFolder.findMany({ where: { tenantId: req.tenantId, isSystem: true } })
      folderId = getSystemFolderId(type, systemFolders)
    }

    const file = await prisma.sharedFile.create({
      data: {
        tenantId: req.tenantId,
        filename: req.file.originalname,
        title: req.body.title || null,
        type,
        mimeType: req.file.mimetype,
        size: req.file.size,
        storagePath,
        folderId,
        caption: type === 'image' ? (req.body.caption || null) : null, // v0.1.21 — caption gambar
        uploadedBy: req.user.id,
      },
      include: {
        uploader: { select: { id: true, username: true } },
        folder: { select: { id: true, name: true } },
      },
    })

    broadcast.emitToTenant(req.tenantId, 'tk_file_created', { file })

    res.status(201).json({ file })
  } catch (e) {
    console.error('TK upload file error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/tk/files/link — add link
router.post('/files/link', ...rt, async (req, res) => {
  try {
    const { url, title, folderId } = req.body

    if (!url || !url.trim()) {
      return res.status(400).json({ error: 'URL is required' })
    }

    // Validate URL format
    try {
      new URL(url.trim())
    } catch {
      return res.status(400).json({ error: 'Invalid URL format' })
    }

    // Determine folder: use provided, or auto-categorize to "Link" system folder
    let fid = folderId ? parseInt(folderId, 10) : null
    if (isNaN(fid)) fid = null

    if (!fid) {
      const linkFolder = await prisma.sharedFolder.findFirst({ where: { tenantId: req.tenantId, isSystem: true, name: 'Link' } })
      if (linkFolder) fid = linkFolder.id
    }

    // Extract filename from URL for display
    let displayFilename = url.trim()
    try {
      const u = new URL(url.trim())
      displayFilename = u.hostname + (u.pathname !== '/' ? u.pathname : '')
    } catch {}

    const file = await prisma.sharedFile.create({
      data: {
        tenantId: req.tenantId,
        filename: displayFilename.substring(0, 255),
        title: title || null,
        type: 'link',
        url: url.trim(),
        folderId: fid,
        uploadedBy: req.user.id,
      },
      include: {
        uploader: { select: { id: true, username: true } },
        folder: { select: { id: true, name: true } },
      },
    })

    broadcast.emitToTenant(req.tenantId, 'tk_file_created', { file })

    res.status(201).json({ file })
  } catch (e) {
    console.error('TK add link error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/tk/files/:id/download — download file (decrypted)
router.get('/files/:id/download', requireAuthFlexible, async (req, res) => {
  try {
    const fileId = parseInt(req.params.id, 10)
    // v3 — tenant-scoped (super_admin wajib ?tenant= via resolveTenant)
    if (!Number.isFinite(Number(req.tenantId))) return res.status(400).json({ error: 'tenant tidak valid' })
    const file = await prisma.sharedFile.findFirst({ where: { id: fileId, tenantId: req.tenantId } })

    if (!file) return res.status(404).json({ error: 'File not found' })
    if (file.type === 'link') {
      // Redirect to URL for links
      return res.redirect(file.url)
    }
    if (!file.storagePath) {
      return res.status(404).json({ error: 'File has no stored content' })
    }

    const buffer = loadMedia(file.storagePath)

    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream')
    res.setHeader('Content-Length', buffer.length)
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`)
    res.send(buffer)
  } catch (e) {
    console.error('TK download file error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/tk/files/:id — delete file (uploader or admin)
router.delete('/files/:id', ...rt, async (req, res) => {
  try {
    const fileId = parseInt(req.params.id, 10)
    const file = await prisma.sharedFile.findFirst({ where: { id: fileId, tenantId: req.tenantId } })

    if (!file) return res.status(404).json({ error: 'File not found' })

    // Only uploader or admin can delete
    if (file.uploadedBy !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You can only delete files you uploaded' })
    }

    // Delete encrypted file from disk if it exists
    const abs = resolveMediaFilePath(file.storagePath) // v3.9.12 — relatif/absolut lintas-host
    if (abs && fs.existsSync(abs)) {
      try {
        fs.unlinkSync(abs)
      } catch (e) {
        console.error('TK delete file from disk error:', e)
      }
    }

    await prisma.sharedFile.delete({ where: { id: fileId } })

    broadcast.emitToTenant(req.tenantId, 'tk_file_deleted', { fileId })

    res.json({ success: true })
  } catch (e) {
    console.error('TK delete file error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/tk/files/:id/pin — toggle pin (admin only)
router.post('/files/:id/pin', ...rt, requireAdmin, async (req, res) => {
  try {
    const fileId = parseInt(req.params.id, 10)
    const file = await prisma.sharedFile.findFirst({ where: { id: fileId, tenantId: req.tenantId } })

    if (!file) return res.status(404).json({ error: 'File not found' })

    const updated = await prisma.sharedFile.update({
      where: { id: fileId },
      data: { isPinned: !file.isPinned },
      include: {
        uploader: { select: { id: true, username: true } },
        folder: { select: { id: true, name: true } },
      },
    })

    broadcast.emitToTenant(req.tenantId, 'tk_file_pinned', { fileId, isPinned: updated.isPinned })

    res.json({ file: updated })
  } catch (e) {
    console.error('TK pin file error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router