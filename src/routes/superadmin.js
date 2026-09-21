// v3.0 Phase 1 — Superadmin API (owner platform). SEMUA route requireSuperAdmin.
// Isolasi default-deny: endpoint di sini tidak pernah menyentuh data tenant
// kecuali eksplisit lewat parameter tenantId.
// Port dari wa-cs-hub-saas v2 (superadmin.js) diadaptasi utk base v0.15.2:
// - WA stub fase 1: waStatus selalu { connected:false, state:'disabled', disabled:true }
// - seed per-tenant via services/tenantSeed.seedTenantDefaults saat create
const express = require('express')
const router = express.Router()
const prisma = require('../prisma')
const config = require('../config')
const wa = require('../wa/pool')
const { requireAuth, requireSuperAdmin, signShortToken, hashPassword } = require('../auth')
const { body } = require('express-validator')
const { validationResult } = require('express-validator')

// Middleware chain: auth + superadmin
const sa = [requireAuth, requireSuperAdmin]

function validate(req, res) {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    res.status(400).json({ error: errors.array()[0]?.msg || 'Validation failed', errors: errors.array() })
    return false
  }
  return true
}

// Status WA fase 1 — pool stub (tanpa koneksi nyata). Tetap dipanggil lewat pool
// supaya fase 2 tinggal mengganti isi pool tanpa menyentuh file ini.
function waStatusFor(tenantId) {
  const s = wa.getStatusForTenant(tenantId)
  return {
    connected: s.connected,
    qrNeeded: s.qrNeeded,
    state: s.state,
    phoneNumber: s.phoneNumber || null,
    disabled: !!s.disabled,
  }
}

// GET /api/sa/tenants — list + jumlah user/chat per tenant + waStatus (fase 1: disabled)
router.get('/tenants', ...sa, async (req, res) => {
  try {
    const tenants = await prisma.tenant.findMany({
      orderBy: { id: 'asc' },
      include: {
        _count: {
          select: { users: true, chats: true },
        },
      },
    })
    res.json({
      tenants: tenants.map((t) => ({
        id: t.id,
        name: t.name,
        status: t.status,
        waPhone: t.waPhone || null,
        userCount: t._count.users,
        chatCount: t._count.chats,
        waStatus: waStatusFor(t.id),
        createdAt: t.createdAt,
      })),
    })
  } catch (e) {
    console.error('[SA] List tenants error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/sa/tenants { name } — create tenant + seed defaults per-tenant
router.post(
  '/tenants',
  ...sa,
  [body('name').trim().isLength({ min: 2, max: 80 }).withMessage('Nama tenant 2-80 karakter')],
  async (req, res) => {
    try {
      if (!validate(req, res)) return
      const name = req.body.name.trim()
      const existing = await prisma.tenant.findUnique({ where: { name } })
      if (existing) {
        return res.status(409).json({ error: 'Nama tenant sudah dipakai' })
      }
      const tenant = await prisma.tenant.create({ data: { name } })
      console.log(`[SA] Tenant dibuat: #${tenant.id} ${tenant.name}`)
      // Seed default per-tenant (folders/configs) — gagal seed TIDAK menggagalkan create
      try {
        const { seedTenantDefaults } = require('../services/tenantSeed')
        await seedTenantDefaults(tenant.id)
      } catch (seedErr) {
        console.error('[SA] seedTenantDefaults error (non-fatal):', seedErr.message)
      }
      res.status(201).json({ tenant })
    } catch (e) {
      console.error('[SA] Create tenant error:', e)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
)

// PUT /api/sa/tenants/:id — rename / status (active|suspended)
router.put(
  '/tenants/:id',
  ...sa,
  [
    body('name').optional().trim().isLength({ min: 2, max: 80 }).withMessage('Nama tenant 2-80 karakter'),
    body('status').optional().isIn(['active', 'suspended']).withMessage('Status harus active|suspended'),
  ],
  async (req, res) => {
    try {
      if (!validate(req, res)) return
      const id = parseInt(req.params.id, 10)
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid tenant id' })
      const tenant = await prisma.tenant.findUnique({ where: { id } })
      if (!tenant) return res.status(404).json({ error: 'Tenant not found' })

      const data = {}
      if (req.body.name !== undefined) data.name = req.body.name.trim()
      if (req.body.status !== undefined) data.status = req.body.status

      if (data.name && data.name !== tenant.name) {
        const dup = await prisma.tenant.findUnique({ where: { name: data.name } })
        if (dup) return res.status(409).json({ error: 'Nama tenant sudah dipakai' })
      }

      const updated = await prisma.tenant.update({ where: { id }, data })
      console.log(`[SA] Tenant #${id} diupdate: ${JSON.stringify(data)}`)
      res.json({ tenant: updated })
    } catch (e) {
      console.error('[SA] Update tenant error:', e)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
)

// DELETE /api/sa/tenants/:id — hanya kalau tenant kosong (tanpa chat & tanpa user)
router.delete('/tenants/:id', ...sa, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid tenant id' })
    const tenant = await prisma.tenant.findUnique({
      where: { id },
      include: { _count: { select: { chats: true, users: true } } },
    })
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' })
    if (tenant._count.chats > 0 || tenant._count.users > 0) {
      return res.status(400).json({
        error: 'Tenant tidak kosong — hapus tidak diizinkan. Gunakan suspend.',
        chatCount: tenant._count.chats,
        userCount: tenant._count.users,
      })
    }
    await prisma.tenant.delete({ where: { id } })
    console.log(`[SA] Tenant #${id} (${tenant.name}) dihapus (kosong)`)
    res.json({ ok: true })
  } catch (e) {
    console.error('[SA] Delete tenant error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/sa/tenants/:id/admins { username, password } — akun admin tenant
router.post(
  '/tenants/:id/admins',
  ...sa,
  [
    body('username').trim().isLength({ min: 3, max: 30 }).withMessage('Username 3-30 karakter'),
    body('password').isLength({ min: 6 }).withMessage('Password minimal 6 karakter'),
  ],
  async (req, res) => {
    try {
      if (!validate(req, res)) return
      const id = parseInt(req.params.id, 10)
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid tenant id' })
      const tenant = await prisma.tenant.findUnique({ where: { id } })
      if (!tenant) return res.status(404).json({ error: 'Tenant not found' })

      const username = req.body.username.trim()
      const existing = await prisma.user.findUnique({ where: { username } })
      if (existing) return res.status(409).json({ error: 'Username sudah dipakai' })

      const passwordHash = await hashPassword(req.body.password)
      const user = await prisma.user.create({
        data: { username, passwordHash, role: 'admin', tenantId: id },
        select: { id: true, username: true, role: true, tenantId: true, status: true, createdAt: true },
      })
      console.log(`[SA] Admin "${username}" dibuat utk tenant #${id} (${tenant.name})`)
      res.status(201).json({ user })
    } catch (e) {
      console.error('[SA] Create tenant admin error:', e)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
)

// GET /api/sa/stats — total tenants/users/messages lintas tenant
router.get('/stats', ...sa, async (req, res) => {
  try {
    const [tenants, activeTenants, users, chats, messages] = await Promise.all([
      prisma.tenant.count(),
      prisma.tenant.count({ where: { status: 'active' } }),
      prisma.user.count({ where: { role: { not: 'super_admin' } } }),
      prisma.chat.count(),
      prisma.message.count(),
    ])
    res.json({ tenants, activeTenants, users, chats, messages })
  } catch (e) {
    console.error('[SA] Stats error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/sa/impersonate/:tenantId → short-lived JWT view-as tenant (debug fase 3)
router.post('/impersonate/:tenantId', ...sa, async (req, res) => {
  try {
    const tenantId = parseInt(req.params.tenantId, 10)
    if (!Number.isFinite(tenantId)) return res.status(400).json({ error: 'Invalid tenant id' })
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } })
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' })

    // Token pendek ber-peran admin tenant — TIDAK menyimpan password siapa pun.
    const token = signShortToken({
      id: req.user.id,
      username: req.user.username,
      role: 'admin',
      tenantId,
      impersonatedBy: req.user.username,
    })
    res.json({ token, tenant: { id: tenant.id, name: tenant.name }, expiresIn: '30m' })
  } catch (e) {
    console.error('[SA] Impersonate error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router