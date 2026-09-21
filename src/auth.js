const jwt = require('jsonwebtoken')
const bcrypt = require('bcryptjs')
const config = require('./config')

function signToken(payload) {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtExpiry })
}

// v3.0 — short-lived token (impersonate superadmin → view-as tenant)
function signShortToken(payload, expiresIn = '30m') {
  return jwt.sign(payload, config.jwtSecret, { expiresIn })
}

function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret)
  } catch {
    return null
  }
}

async function hashPassword(password) {
  return bcrypt.hash(password, 12)
}

async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash)
}

// Express middleware: require auth
function requireAuth(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' })
  }
  const token = header.slice(7)
  const decoded = verifyToken(token)
  if (!decoded) {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
  req.user = decoded
  next()
}

// Express middleware: require admin role (super_admin tidak dianggap admin tenant)
// v3.0 — super_admin DIIZINKAN pada endpoint admin ber-scope tenant (requireTenant
// yang jalan sebelumnya sudah mem-validasi ?tenant= — mode impersonasi/debug spec §3).
function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'No token provided' })
  }
  if (req.user.role === 'super_admin') {
    if (req.user.tenantId != null) {
      return res.status(403).json({ error: 'Invalid super admin token' })
    }
    return next()
  }
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' })
  }
  next()
}

// v3.0 — super_admin only (owner platform). Token superadmin WAJIB punya tenantId null.
function requireSuperAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super admin access required' })
  }
  if (req.user.tenantId != null) {
    return res.status(403).json({ error: 'Invalid super admin token' })
  }
  next()
}

// v3.0 — Isolasi tenant (default-deny). Wajib terpasang di SEMUA route milik tenant.
//   - super_admin → butuh `?tenant=` / header `X-Tenant-Id` (mode impersonate/debug), else 400
//   - admin/cs/relay → tenantId dari JWT
// Set `req.tenantId` (number) — SEMUA query tenant-scoped WAJIB filter `tenantId: req.tenantId`.
function requireTenant(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'No token provided' })
  }
  if (req.user.role === 'super_admin') {
    const raw = req.query.tenant ?? req.headers['x-tenant-id']
    const tenantId = parseInt(raw, 10)
    if (!Number.isFinite(tenantId) || tenantId <= 0) {
      return res.status(400).json({ error: 'Super admin wajib menyertakan ?tenant=<id> untuk endpoint ber-scope tenant' })
    }
    req.tenantId = tenantId
    return next()
  }
  const tenantId = req.user.tenantId
  if (!Number.isFinite(Number(tenantId))) {
    return res.status(403).json({ error: 'Akun tidak terhubung ke tenant' })
  }
  req.tenantId = Number(tenantId)
  next()
}

// v3.0 — guard kombinasi: super_admin tidak boleh memakai endpoint dashboard CS
// tanpa impersonasi eksplisit (?tenant= dipakai via requireTenant di route tsb).
function forbidSuperAdmin(req, res, next) {
  if (req.user && req.user.role === 'super_admin') {
    return res.status(403).json({ error: 'Super admin tidak dapat mengakses dashboard CS' })
  }
  next()
}

// v3.0 — resolve tenant LUNAK (optional): set req.tenantId kalau bisa ditentukan,
// TIDAK menolak kalau tidak ada (untuk endpoint yang boleh lintas — mis. theme.css).
function resolveTenant(req, res, next) {
  if (!req.user) return next()
  if (req.user.role === 'super_admin') {
    const raw = req.query.tenant ?? req.headers['x-tenant-id']
    const tenantId = parseInt(raw, 10)
    if (Number.isFinite(tenantId) && tenantId > 0) req.tenantId = tenantId
    return next()
  }
  if (Number.isFinite(Number(req.user.tenantId))) req.tenantId = Number(req.user.tenantId)
  next()
}

module.exports = {
  signToken,
  signShortToken,
  verifyToken,
  hashPassword,
  comparePassword,
  requireAuth,
  requireAdmin,
  requireSuperAdmin,
  requireTenant,
  forbidSuperAdmin,
  resolveTenant,
}