// v3.0 Phase 1 — Superadmin API (owner platform). SEMUA route requireSuperAdmin.
// Isolasi default-deny: endpoint di sini tidak pernah menyentuh data tenant
// kecuali eksplisit lewat parameter tenantId.
// Port dari wa-cs-hub-saas v2 (superadmin.js) diadaptasi utk base v0.15.2:
// - WA stub fase 1: waStatus selalu { connected:false, state:'disabled', disabled:true }
// - seed per-tenant via services/tenantSeed.seedTenantDefaults saat create
const express = require('express')
const router = express.Router()
const fs = require('fs')
const path = require('path')
const prisma = require('../prisma')
const config = require('../config')
const wa = require('../wa/pool')
const { requireAuth, requireSuperAdmin, signShortToken, hashPassword } = require('../auth')
const { body } = require('express-validator')
const { validationResult } = require('express-validator')
const broadcast = require('../socket/broadcast')
const { invalidateThemeCssCache } = require('./appearance')
// v3.4 — plan/kuota + audit + backup tenant
const plans = require('../services/plans')
const saAudit = require('../services/saAudit')
const tenantBackup = require('../services/tenantBackup')
const multer = require('multer')

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

// ─── v3.4 — Plan helpers ─────────────────────────────────────────────────
const FEATURE_KEYS = plans.FEATURE_KEYS
const QUOTA_KEYS = plans.QUOTA_KEYS
const PRESET_NAMES = Object.keys(plans.PRESETS) // ['lite','pro','max']

function presetBadge(plan) {
  if (!plan) return 'Custom'
  const label = String(plan.preset || 'custom')
  return label.charAt(0).toUpperCase() + label.slice(1)
}

/** Serialize TenantPlan → JSON-aman (BigInt tkQuotaBytes → Number/null). */
function planToJson(plan) {
  if (!plan) return null
  return {
    preset: plan.preset,
    maxAgents: plan.maxAgents,
    maxContacts: plan.maxContacts,
    tkQuotaBytes: plan.tkQuotaBytes == null ? null : Number(plan.tkQuotaBytes),
    featAnalytics: plan.featAnalytics,
    featBlast: plan.featBlast,
    featMenuGateway: plan.featMenuGateway,
    featHistoryExport: plan.featHistoryExport,
    featCsat: plan.featCsat,
    featGdriveBackup: plan.featGdriveBackup,
  }
}

// GET /api/sa/tenants — list + jumlah user/chat per tenant + waStatus (fase 1: disabled)
// v3.4 — + plan (badge paket) + usage meter (agents/contacts/tkBytes)
router.get('/tenants', ...sa, async (req, res) => {
  try {
    const tenants = await prisma.tenant.findMany({
      orderBy: { id: 'asc' },
      include: {
        _count: {
          select: { users: true, chats: true },
        },
        plan: true,
      },
    })
    const out = []
    for (const t of tenants) {
      const usage = await plans.getUsage(t.id)
      out.push({
        id: t.id,
        name: t.name,
        status: t.status,
        waPhone: t.waPhone || null,
        brandName: t.brandName || null,
        logoPath: t.logoPath ? true : false,
        userCount: t._count.users,
        chatCount: t._count.chats,
        waStatus: waStatusFor(t.id),
        createdAt: t.createdAt,
        plan: t.plan
          ? {
              ...planToJson(t.plan),
            }
          : null,
        usage,
      })
    }
    res.json({ tenants: out })
  } catch (e) {
    console.error('[SA] List tenants error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/sa/tenants { name, preset? } — create tenant + seed defaults per-tenant
// v3.4 — preset plan (default "lite") → ensureTenantPlan setelah seedTenantDefaults.
router.post(
  '/tenants',
  ...sa,
  [
    body('name').trim().isLength({ min: 2, max: 80 }).withMessage('Nama tenant 2-80 karakter'),
    body('preset').optional().isIn(PRESET_NAMES).withMessage(`Preset harus salah satu: ${PRESET_NAMES.join(', ')}`),
  ],
  async (req, res) => {
    try {
      if (!validate(req, res)) return
      const name = req.body.name.trim()
      const preset = String(req.body.preset || 'lite').toLowerCase()
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
      // v3.4 — plan sesuai preset (gagal plan TIDAK menggagalkan create)
      let plan = null
      try {
        plan = await plans.ensureTenantPlan(tenant.id, preset)
        plans.invalidatePlanCache(tenant.id)
      } catch (planErr) {
        console.error('[SA] ensureTenantPlan error (non-fatal):', planErr.message)
      }
      await saAudit.audit(req.user, 'tenant_create', tenant.id, tenant.name, { preset })
      // v3.4 fix — plan raw berisi BigInt (tkQuotaBytes) → res.json() melempar
      // "Do not know how to serialize a BigInt" (500 padahal tenant SUDAH dibuat).
      // Serialisasi lewat planToJson (BigInt → Number).
      res.status(201).json({ tenant, plan: plan ? planToJson(plan) : null })
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
      await saAudit.audit(req.user, 'tenant_update', id, updated.name, data)
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
    await saAudit.audit(req.user, 'tenant_delete', id, tenant.name, { chatCount: tenant._count.chats, userCount: tenant._count.users })
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
      // v3.4 — branding logo tenant ikut dihapus dari disk saat purge (spec §2)
      const tenantFull = await prisma.tenant.findUnique({ where: { id: tid }, select: { logoPath: true } })
      const filePaths = [
        ...msgFiles.map((m) => m.mediaPath),
        ...sharedFiles.map((f) => f.storagePath),
        ...blastFiles.map((b) => b.mediaPath),
        tenantFull?.logoPath || null,
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
      // v3.4 — audit trail PERMANEN (SaAuditLog TIDAK ikut purge — tenantId plain)
      await saAudit.audit(req.user, 'tenant_purge', tid, tenant.name, { ...deleted, filesRemoved })
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
      await saAudit.audit(req.user, 'admin_create', id, tenant.name, { userId: user.id, username })
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

// ═══════════════════════ v3.4 — PLAN & KUOTA ═══════════════════════

// GET /api/sa/tenants/:id/plan — plan + usage
router.get('/tenants/:id/plan', ...sa, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid tenant id' })
    const tenant = await prisma.tenant.findUnique({
      where: { id },
      include: { plan: true },
    })
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' })
    const usage = await plans.getUsage(id)
    const plan = tenant.plan
    res.json({
      plan: planToJson(plan),
      usage: {
        agents: usage.agents,
        maxAgents: plan?.maxAgents ?? null,
        contacts: usage.contacts,
        maxContacts: plan?.maxContacts ?? null,
        tkBytes: usage.tkBytes,
        tkQuotaBytes: plan?.tkQuotaBytes == null ? null : Number(plan.tkQuotaBytes),
      },
    })
  } catch (e) {
    console.error('[SA] Get plan error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/sa/tenants/:id/plan — body: { preset?, maxAgents?, maxContacts?,
// tkQuotaBytes?, featAnalytics?... } — preset di-apply dulu, field eksplisit menimpa.
// null = unlimited. Field preset di-DB disimpan sesuai hasil (nama preset bila persis
// sama dgn definisinya, "custom" bila menyimpang). Invalidate cache. Audit plan_update.
router.put(
  '/tenants/:id/plan',
  ...sa,
  [body('preset').optional().isIn(PRESET_NAMES).withMessage(`Preset harus salah satu: ${PRESET_NAMES.join(', ')}`)],
  async (req, res) => {
    try {
      if (!validate(req, res)) return
      const id = parseInt(req.params.id, 10)
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid tenant id' })
      const tenant = await prisma.tenant.findUnique({ where: { id }, include: { plan: true } })
      if (!tenant) return res.status(404).json({ error: 'Tenant not found' })

      // Base: apply preset bila ada, else plan existing (atau lite bila belum ada — race)
      let fields
      const presetName = req.body.preset ? String(req.body.preset).toLowerCase() : null
      if (presetName) {
        fields = plans.applyPreset(presetName)
        if (!fields) return res.status(400).json({ error: 'Preset tidak dikenal' })
      } else if (tenant.plan) {
        fields = {
          preset: tenant.plan.preset,
          maxAgents: tenant.plan.maxAgents,
          maxContacts: tenant.plan.maxContacts,
          tkQuotaBytes: tenant.plan.tkQuotaBytes == null ? null : Number(tenant.plan.tkQuotaBytes),
          featAnalytics: tenant.plan.featAnalytics,
          featBlast: tenant.plan.featBlast,
          featMenuGateway: tenant.plan.featMenuGateway,
          featHistoryExport: tenant.plan.featHistoryExport,
          featCsat: tenant.plan.featCsat,
          featGdriveBackup: tenant.plan.featGdriveBackup,
        }
      } else {
        fields = plans.applyPreset('max')
      }

      // Override individual: hanya field yang EKSPLISIT di body (null = unlimited)
      const explicitQuota = {}
      for (const k of QUOTA_KEYS) {
        if (req.body[k] !== undefined) {
          if (req.body[k] === null) explicitQuota[k] = null
          else {
            const n = Number(req.body[k])
            if (!Number.isFinite(n) || n < 0) {
              return res.status(400).json({ error: `${k} harus angka >= 0 atau null (unlimited)` })
            }
            explicitQuota[k] = Math.trunc(n)
          }
        }
      }
      const explicitFeat = {}
      for (const k of FEATURE_KEYS) {
        if (req.body[k] !== undefined) explicitFeat[k] = Boolean(req.body[k])
      }
      const merged = { ...fields, ...explicitQuota, ...explicitFeat }

      // preset label hasil: persis definisi → nama preset, menyimpang → "custom"
      const resolvedPreset = plans.resolvePresetLabel(merged)

      const plan = await prisma.tenantPlan.upsert({
        where: { tenantId: id },
        update: { ...merged, preset: resolvedPreset, updatedBy: req.user.id },
        create: { tenantId: id, ...merged, preset: resolvedPreset, updatedBy: req.user.id },
      })
      plans.invalidatePlanCache(id)
      console.log(`[SA] Plan tenant #${id} (${tenant.name}) diupdate → preset=${resolvedPreset} by @${req.user.username}`)
      await saAudit.audit(req.user, 'plan_update', id, tenant.name, { preset: resolvedPreset, ...planToJson(plan) })
      res.json({ plan: { ...planToJson(plan), updatedAt: plan.updatedAt } })
    } catch (e) {
      console.error('[SA] Update plan error:', e)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
)

// ═══════════════════════ v3.4 — BRANDING ═══════════════════════

// Multipart logo (max 1 MB, mime whitelist png/jpeg/webp — NO svg)
const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1 * 1024 * 1024 },
})
const LOGO_MIMES = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
}

// PUT /api/sa/tenants/:id/branding — JSON { brandName? } ATAU multipart logo
router.put(
  '/tenants/:id/branding',
  ...sa,
  logoUpload.single('logo'),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10)
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid tenant id' })
      const tenant = await prisma.tenant.findUnique({ where: { id } })
      if (!tenant) return res.status(404).json({ error: 'Tenant not found' })

      const detail = {}
      let brandNameApplied = null
      let logoApplied = null

      // ── brandName (JSON body / multipart field) ──
      if (req.body.brandName !== undefined && req.body.brandName !== null) {
        const bn = String(req.body.brandName).trim()
        if (bn.length > 0 && (bn.length < 2 || bn.length > 50)) {
          return res.status(400).json({ error: 'brandName harus 2-50 karakter (atau "" untuk reset)' })
        }
        brandNameApplied = bn === '' ? null : bn
        detail.brandName = brandNameApplied
        if (bn === '') detail.brandNameReset = true
      }

      // ── logo (multipart) ──
      if (req.file) {
        const mime = req.file.mimetype || ''
        const ext = LOGO_MIMES[mime]
        if (!ext) {
          return res.status(400).json({ error: 'Format logo harus PNG/JPEG/WEBP (SVG tidak diizinkan)' })
        }
        const brandingDir = path.resolve(process.cwd(), 'data', 'branding', `tenant-${id}`)
        fs.mkdirSync(brandingDir, { recursive: true })
        const ts = Date.now()
        const filePath = path.join(brandingDir, `logo-${ts}${ext}`)
        fs.writeFileSync(filePath, req.file.buffer)
        // hapus file lama
        if (tenant.logoPath && fs.existsSync(tenant.logoPath)) {
          try { fs.unlinkSync(tenant.logoPath) } catch {}
        }
        logoApplied = filePath
        detail.logo = { path: filePath, size: req.file.size, mime }
      }

      if (brandNameApplied === null && !logoApplied && req.body.brandName === undefined) {
        return res.status(400).json({ error: 'Tidak ada yang diupdate (kirim brandName dan/atau logo)' })
      }

      const data = {}
      if (req.body.brandName !== undefined) {
        // JSON: brandName:"" → reset null; brandName:"X" → simpan
        data.brandName = brandNameApplied
      }
      if (logoApplied) data.logoPath = logoApplied

      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: 'Tidak ada perubahan branding yang valid' })
      }

      const updated = await prisma.tenant.update({ where: { id }, data })
      console.log(`[SA] Branding tenant #${id} (${tenant.name}) diupdate by @${req.user.username}: ${JSON.stringify({ brandName: data.brandName !== undefined ? data.brandName : undefined, logo: !!logoApplied })}`)
      await saAudit.audit(req.user, 'branding_update', id, tenant.name, detail)
      res.json({
        tenant: { id: updated.id, name: updated.name, brandName: updated.brandName, logoPath: updated.logoPath ? true : false },
      })
    } catch (e) {
      console.error('[SA] Update branding error:', e)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
)

// ═══════════════════════ v3.4 — BACKUP TENANT ═══════════════════════

// GET /api/sa/tenants/:id/backup — buat tar.gz SATU tenant, kirim sbg download,
// hapus temp file setelah kirim. Audit backup_download (nama file + ukuran + row count).
router.get('/tenants/:id/backup', ...sa, async (req, res) => {
  let backup = null
  try {
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid tenant id' })
    const tenant = await prisma.tenant.findUnique({ where: { id }, select: { id: true, name: true } })
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' })

    backup = await tenantBackup.createTenantBackup(id)
    const sizeBytes = fs.statSync(backup.filePath).size
    console.log(`[SA] Backup tenant #${id} (${tenant.name}) → ${backup.fileName} (${plans.formatBytes(sizeBytes)}) by @${req.user.username}`)
    await saAudit.audit(req.user, 'backup_download', id, tenant.name, {
      fileName: backup.fileName,
      sizeBytes,
      tables: backup.manifest.tables,
      filesCopied: backup.manifest.filesCopied,
      filesError: backup.manifest.filesError,
    })
    res.setHeader('Content-Disposition', `attachment; filename="${backup.fileName}"`)
    res.download(backup.filePath, backup.fileName, (err) => {
      // cleanup SELALU setelah kirim/gagal
      tenantBackup.cleanupBackup(backup)
      backup = null
      if (err && !res.headersSent) {
        console.error('[SA] Backup download error:', err.message)
        if (!res.writableEnded) res.status(500).json({ error: 'Backup download gagal' })
      }
    })
  } catch (e) {
    if (backup) tenantBackup.cleanupBackup(backup)
    console.error('[SA] Backup tenant error:', e)
    res.status(500).json({ error: e.message === 'Tenant not found' ? 'Tenant not found' : 'Internal server error' })
  }
})

// ═══════════════════════ v3.4 — AUDIT LOG ═══════════════════════

// GET /api/sa/audit?tenantId=&action=&limit=200&before=<ISO|id> — urut terbaru,
// cursor sederhana (before = id terakhir di page sebelumnya).
router.get('/audit', ...sa, async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 200))
    const where = {}
    if (req.query.tenantId !== undefined && req.query.tenantId !== '') {
      const tid = parseInt(req.query.tenantId, 10)
      if (Number.isFinite(tid)) where.tenantId = tid
    }
    if (req.query.action) where.action = String(req.query.action)
    if (req.query.before) {
      const b = parseInt(req.query.before, 10)
      if (Number.isFinite(b)) where.id = { lt: b }
    }
    const rows = await prisma.saAuditLog.findMany({
      where,
      orderBy: [{ id: 'desc' }],
      take: limit,
    })
    const items = rows.map((r) => {
      let detail = null
      try { detail = r.detailJson ? JSON.parse(r.detailJson) : null } catch { detail = r.detailJson }
      return {
        id: r.id,
        actorId: r.actorId,
        actorUsername: r.actorUsername,
        action: r.action,
        tenantId: r.tenantId,
        tenantName: r.tenantName,
        detail,
        createdAt: r.createdAt,
      }
    })
    const nextBefore = rows.length === limit ? rows[rows.length - 1].id : null
    res.json({ items, nextBefore })
  } catch (e) {
    console.error('[SA] Audit list error:', e)
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
    await saAudit.audit(req.user, 'impersonate', tenant.id, tenant.name, { expiresIn: '30m' })
    res.json({ token, tenant: { id: tenant.id, name: tenant.name }, expiresIn: '30m' })
  } catch (e) {
    console.error('[SA] Impersonate error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router