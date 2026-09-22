// v3.0 Phase 1 — Superadmin API (owner platform). SEMUA route requireSuperAdmin.
// Isolasi default-deny: endpoint di sini tidak pernah menyentuh data tenant
// kecuali eksplisit lewat parameter tenantId.
// Port dari wa-cs-hub-saas v2 (superadmin.js) diadaptasi utk base v0.15.2:
// - WA stub fase 1: waStatus selalu { connected:false, state:'disabled', disabled:true }
// - seed per-tenant via services/tenantSeed.seedTenantDefaults saat create
const express = require('express')
const router = express.Router()
const fs = require('fs')
const prisma = require('../prisma')
const config = require('../config')
const wa = require('../wa/pool')
const { requireAuth, requireSuperAdmin, signShortToken, hashPassword } = require('../auth')
const { body } = require('express-validator')
const { validationResult } = require('express-validator')
const broadcast = require('../socket/broadcast')
const { invalidateThemeCssCache } = require('./appearance')

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

// POST /api/sa/tenants/:id/purge — v3.1.2 — HAPUS PERMANEN tenant + SELURUH datanya.
// Beda dengan DELETE /tenants/:id (hanya tenant kosong): purge menyapu semua row
// milik tenant TANPA migrasi schema, menghormati FK restrict via URUTAN DELETE
// (child → parent). Konfirmasi WAJIB: body { confirmName } harus sama persis dengan
// nama tenant (anti salah klik — ini operasi irreversibel).
// Urutan (schema v3.0 frozen):
//   messages → blasts (BlastLog cascade) → csatSurveys/scheduledMessages/chatNotes/
//   chatEvents/groupActionLogs (semua FK Chat/User) → chatTags (join, via chat.tenant)
//   → contactTags → contacts → chats → tags → sharedFiles → sharedFolders →
//   announcements (AnnouncementRead cascade) → purgeLogs → messageTemplates →
//   user-scoped tanpa tenantId (pushSubscriptions/gdriveLinks/backupLogs/
//   favoriteMessages via user.tenantId) → users → configs (app/autoReply/backup/
//   appearance/csat/menuGateway) → tenant.
// File media (message.mediaPath / sharedFile.storagePath / blast.mediaPath)
// dihapus dari disk SETELAH transaksi DB sukses — transaksi gagal → file tetap
// utuh. Room socket tenant di-disconnect (JWT user terhapus masih berlaku sampai
// exp; reconnect → /auth/me gagal → klien auto-logout).
router.post(
  '/tenants/:id/purge',
  ...sa,
  [body('confirmName').trim().notEmpty().withMessage('confirmName wajib diisi')],
  async (req, res) => {
    try {
      if (!validate(req, res)) return
      const id = parseInt(req.params.id, 10)
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid tenant id' })
      const tenant = await prisma.tenant.findUnique({
        where: { id },
        include: { _count: { select: { chats: true, users: true } } },
      })
      if (!tenant) return res.status(404).json({ error: 'Tenant not found' })

      const confirmName = (req.body.confirmName || '').trim()
      if (confirmName !== tenant.name) {
        return res.status(400).json({
          error: `Konfirmasi gagal — ketik nama tenant persis: "${tenant.name}"`,
        })
      }

      const tid = tenant.id

      // 1) Kumpulkan path file media SEBELUM row terhapus (path hanya ada di DB)
      const [msgFiles, sharedFiles, blastFiles] = await Promise.all([
        prisma.message.findMany({ where: { tenantId: tid }, select: { mediaPath: true } }),
        prisma.sharedFile.findMany({ where: { tenantId: tid }, select: { storagePath: true } }),
        prisma.blast.findMany({ where: { tenantId: tid }, select: { mediaPath: true } }),
      ])
      const filePaths = [
        ...msgFiles.map((m) => m.mediaPath),
        ...sharedFiles.map((f) => f.storagePath),
        ...blastFiles.map((b) => b.mediaPath),
      ].filter(Boolean)

      // 2) Transaksi: hapus SEMUA row tenant, urut FK (lihat komentar header)
      const deleted = await prisma.$transaction(async (tx) => {
        const ops = [
          ['messages', () => tx.message.deleteMany({ where: { tenantId: tid } })], // FavoriteMessage cascade
          ['blasts', () => tx.blast.deleteMany({ where: { tenantId: tid } })], // BlastLog cascade
          ['csatSurveys', () => tx.csatSurvey.deleteMany({ where: { tenantId: tid } })],
          ['scheduledMessages', () => tx.scheduledMessage.deleteMany({ where: { tenantId: tid } })],
          ['groupActionLogs', () => tx.groupActionLog.deleteMany({ where: { tenantId: tid } })],
          ['chatNotes', () => tx.chatNote.deleteMany({ where: { tenantId: tid } })],
          ['chatEvents', () => tx.chatEvent.deleteMany({ where: { tenantId: tid } })],
          ['chatTags', () => tx.chatTag.deleteMany({ where: { chat: { tenantId: tid } } })],
          ['contactTags', () => tx.contactTag.deleteMany({ where: { tenantId: tid } })],
          ['contacts', () => tx.contact.deleteMany({ where: { tenantId: tid } })],
          ['chats', () => tx.chat.deleteMany({ where: { tenantId: tid } })],
          ['tags', () => tx.tag.deleteMany({ where: { tenantId: tid } })],
          ['sharedFiles', () => tx.sharedFile.deleteMany({ where: { tenantId: tid } })],
          ['sharedFolders', () => tx.sharedFolder.deleteMany({ where: { tenantId: tid } })],
          ['announcements', () => tx.announcement.deleteMany({ where: { tenantId: tid } })], // AnnouncementRead cascade
          ['purgeLogs', () => tx.purgeLog.deleteMany({ where: { tenantId: tid } })],
          ['messageTemplates', () => tx.messageTemplate.deleteMany({ where: { tenantId: tid } })],
          ['pushSubscriptions', () => tx.pushSubscription.deleteMany({ where: { user: { tenantId: tid } } })],
          ['gdriveLinks', () => tx.gDriveLink.deleteMany({ where: { user: { tenantId: tid } } })],
          ['backupLogs', () => tx.backupLog.deleteMany({ where: { user: { tenantId: tid } } })],
          ['favoriteMessages', () => tx.favoriteMessage.deleteMany({ where: { user: { tenantId: tid } } })],
          ['users', () => tx.user.deleteMany({ where: { tenantId: tid } })],
          ['appConfigs', () => tx.appConfig.deleteMany({ where: { tenantId: tid } })],
          ['autoReplyConfigs', () => tx.autoReplyConfig.deleteMany({ where: { tenantId: tid } })],
          ['backupConfigs', () => tx.backupConfig.deleteMany({ where: { tenantId: tid } })],
          ['appearanceConfigs', () => tx.appearanceConfig.deleteMany({ where: { tenantId: tid } })],
          ['csatConfigs', () => tx.csatConfig.deleteMany({ where: { tenantId: tid } })],
          ['menuGatewayOptions', () => tx.menuGatewayOption.deleteMany({ where: { tenantId: tid } })],
          ['menuGatewayConfigs', () => tx.menuGatewayConfig.deleteMany({ where: { tenantId: tid } })],
        ]
        const result = {}
        for (const [name, op] of ops) result[name] = (await op()).count
        await tx.tenant.delete({ where: { id: tid } })
        return result
      })

      // 3) File disk SETELAH transaksi sukses (transaksi gagal → file utuh)
      let filesRemoved = 0
      for (const fp of filePaths) {
        try {
          if (fs.existsSync(fp)) {
            fs.unlinkSync(fp)
            filesRemoved++
          }
        } catch {}
      }

      // 4) VACUUM best-effort — hapus byte plaintext dari slack space (pola purge.js)
      try {
        await prisma.$executeRawUnsafe('VACUUM')
      } catch (e) {
        console.error('[SA] VACUUM gagal (purge tetap sukses):', e.message)
      }

      // 5) Kick socket room tenant (klien auto-logout saat reconnect)
      try {
        const io = broadcast.getIO()
        if (io) io.to(`tenant:${tid}`).disconnectSockets(true)
      } catch {}

      // 6) Invalidate cache tema tenant (kalau sempat ke-cache via ?tenant=)
      try { invalidateThemeCssCache(tid) } catch {}

      console.log(`[SA] Tenant #${tid} (${tenant.name}) PURGED permanen by @${req.user.username}:`, JSON.stringify({ ...deleted, filesRemoved }))
      res.json({ ok: true, deleted, filesRemoved })
    } catch (e) {
      console.error('[SA] Purge tenant error:', e)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
)

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