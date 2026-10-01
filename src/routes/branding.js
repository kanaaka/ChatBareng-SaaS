// v3.4 — Branding per-tenant: serve logo tenant (spec §6).
// GET /api/branding/logo — auth FLEXIBLE (pattern requireAuthFlexible tanganKanan.js:
// Bearer header ATAU ?token=). Serve file logo tenant SENDIRI (req.user.tenantId),
// Content-Type sesuai mime, cache no-store. Super_admin tanpa tenant → 404.
const express = require('express')
const router = express.Router()
const path = require('path')
const fs = require('fs')
const prisma = require('../prisma')
const { verifyToken, resolveTenant } = require('../auth')

// Auth flexible (sama persis pola tanganKanan.js) + resolveTenant utk super_admin ?tenant=
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

// MIME whitelist dari ekstensi file yang kita simpan sendiri (png/jpeg/webp — NO svg)
const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

router.get('/logo', requireAuthFlexible, async (req, res) => {
  try {
    const tid = Number(req.tenantId)
    // super_admin tanpa ?tenant= (req.tenantId tidak teresolve) → 404 (spec §6)
    if (!Number.isFinite(tid) || tid <= 0) {
      return res.status(404).json({ error: 'Logo not found' })
    }
    const tenant = await prisma.tenant.findUnique({
      where: { id: tid },
      select: { logoPath: true },
    })
    if (!tenant || !tenant.logoPath) {
      return res.status(404).json({ error: 'Logo not found' })
    }
    const filePath = tenant.logoPath
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Logo not found' })
    }
    // Path HARUS berada di bawah data/branding (defensive — path dari DB kita sendiri)
    const brandingRoot = path.resolve(__dirname, '..', '..', 'data', 'branding')
    if (!path.resolve(filePath).startsWith(brandingRoot)) {
      return res.status(404).json({ error: 'Logo not found' })
    }
    const ext = path.extname(filePath).toLowerCase()
    const mime = MIME_BY_EXT[ext] || 'application/octet-stream'
    res.setHeader('Content-Type', mime)
    res.setHeader('Cache-Control', 'no-store')
    res.sendFile(path.resolve(filePath))
  } catch (e) {
    console.error('[Branding] logo error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router