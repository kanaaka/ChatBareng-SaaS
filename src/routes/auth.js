const express = require('express')
const router = express.Router()
const prisma = require('../prisma')
const { signToken, comparePassword, hashPassword, requireAuth } = require('../auth')
const { loginValidation } = require('../utils/validation')
const { body, validationResult } = require('express-validator')
const rateLimit = require('express-rate-limit')

// v0.12.2 — rate limit ketat khusus change-password (brute-force guard, tidak menyentuh limiter global)
const changePasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many attempts, try again later.' },
})

// v0.12.2 — validasi change-password (pattern file ini / express-validator)
const changePasswordValidation = [
  body('currentPassword').notEmpty().withMessage('Current password required'),
  body('newPassword').isLength({ min: 6 }).withMessage('New password must be at least 6 chars'),
]

// v3.9.4 — login limiter TERPISAH dari bucket write global (QA Kanaka 24 Sep: login
// ikut kena "Too many requests" global saat traffic tinggi → gak bisa login sama
// sekali). 15/menit per-IP: brute-force tetap terhalang, user sah gak ikut gosong.
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  message: { error: 'Terlalu banyak percobaan login — tunggu ±1 menit lalu coba lagi.' },
})

// POST /api/auth/login
router.post('/login', loginLimiter, loginValidation, async (req, res) => {
  try {
    const errors = req.validationErrors
    if (errors && errors.length > 0) {
      return res.status(400).json({ errors })
    }
    
    const { username, password } = req.body
    const user = await prisma.user.findUnique({ where: { username } })
    
    if (!user || user.status !== 'active') {
      // v0.12.4 — plaintext password TIDAK PERNAH di-log/di-hash ke DB
      return res.status(401).json({ error: 'Invalid credentials' })
    }

    // v3.0 — tenant suspended → login ditolak (default-deny, keputusan v2)
    if (user.tenantId != null) {
      const tenant = await prisma.tenant.findUnique({ where: { id: user.tenantId }, select: { status: true } })
      if (!tenant || tenant.status !== 'active') {
        return res.status(403).json({ error: 'Tenant sedang suspended — hubungi administrator platform' })
      }
    }
    
    const valid = await comparePassword(password, user.passwordHash)
    if (!valid) {
      // v0.12.4 — plaintext password TIDAK PERNAH di-log/di-hash ke DB
      return res.status(401).json({ error: 'Invalid credentials' })
    }
    
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() },
    })
    
    const token = signToken({ id: user.id, username: user.username, role: user.role, tenantId: user.tenantId ?? null })

    // v3.0 — super_admin → sertakan daftar tenant (frontend redirect /superadmin);
    // user tenant → response normal (tanpa info tenant apa pun — transparan).
    if (user.role === 'super_admin') {
      const tenants = await prisma.tenant.findMany({
        orderBy: { id: 'asc' },
        include: { _count: { select: { users: true, chats: true } } },
      })
      return res.json({
        token,
        user: { id: user.id, username: user.username, role: user.role },
        tenants: tenants.map(t => ({
          id: t.id,
          name: t.name,
          status: t.status,
          userCount: t._count.users,
          chatCount: t._count.chats,
        })),
      })
    }
    
    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
      },
    })
  } catch (e) {
    console.error('Login error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/auth/change-password (v0.12.2 — self-service ganti password, requireAuth)
// Fix bug 403: Settings.vue sebelumnya nekat PUT /api/users/:id yang requireAdmin → CS kena 403.
router.post('/change-password', changePasswordLimiter, changePasswordValidation, requireAuth, async (req, res) => {
  try {
    // v0.12.2 — consume validationResult (pattern users.js; req.validationErrors dead-check di EV7)
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0]?.msg || 'Validation failed', errors: errors.array() })
    }

    const { currentPassword, newPassword } = req.body
    const user = await prisma.user.findUnique({ where: { id: req.user.id } })

    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }

    const valid = await comparePassword(currentPassword, user.passwordHash)
    if (!valid) {
      return res.status(401).json({ error: 'Current password incorrect' })
    }

    const passwordHash = await hashPassword(newPassword)
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } })

    res.json({ ok: true })
  } catch (e) {
    console.error('Change password error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, username: true, role: true, status: true, lastLogin: true, tenantId: true },
    })
    if (!user) return res.status(404).json({ error: 'User not found' })
    // v3.0 — user tenant TIDAK melihat apapun soal tenant (tenantId tidak dikirim);
    // super_admin butuh tenantId utk impersonasi header.
    const payload = {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      lastLogin: user.lastLogin,
    }
    if (user.role === 'super_admin') payload.tenantId = null
    // v3.4 — branding + plan utk user tenant (spec §6). super_admin tanpa tenant →
    // tidak ada branding/plan (frontend superadmin tetap ChatBareng polos).
    if (user.tenantId != null) {
      // v3.8 — masa aktif tenant: state + tanggal utk banner & route guard frontend.
      // super_admin (tenantId null) → tanpa subscription (guard tidak berlaku).
      try {
        const validity = require('../services/validity')
        const sub = await validity.getSubscription(user.tenantId)
        if (sub) payload.subscription = sub
      } catch (subErr) {
        console.error('[Auth/me] subscription error (non-fatal):', subErr.message)
      }
      try {
        const plans = require('../services/plans')
        const [tenant, plan, usage] = await Promise.all([
          prisma.tenant.findUnique({
            where: { id: user.tenantId },
            select: { brandName: true, logoPath: true },
          }),
          plans.getPlan(user.tenantId),
          plans.getUsage(user.tenantId),
        ])
        payload.branding = {
          brandName: tenant?.brandName || '',
          logoUrl: tenant?.logoPath ? '/api/branding/logo' : null,
        }
        payload.plan = {
          features: {
            analytics: plan?.featAnalytics ?? false,
            blast: plan?.featBlast ?? false,
            menuGateway: plan?.featMenuGateway ?? false,
            historyExport: plan?.featHistoryExport ?? false,
            csat: plan?.featCsat ?? false,
            gdriveBackup: plan?.featGdriveBackup ?? false,
            apiAccess: plan?.featApiAccess ?? false, // v3.9.13 — Public API v1
          },
          maxAgents: plan?.maxAgents ?? null,
          maxContacts: plan?.maxContacts ?? null,
          tkQuotaBytes: plan?.tkQuotaBytes == null ? null : Number(plan.tkQuotaBytes),
          usage: usage,
        }
      } catch (planErr) {
        console.error('[Auth/me] branding/plan error (non-fatal):', planErr.message)
      }
    }
    res.json({ user: payload })
  } catch (e) {
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router