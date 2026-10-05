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
const systemLog = require('../services/systemLog') // v4.6.4 — SystemLog capture terstruktur (spec D2.5)
const tenantBackup = require('../services/tenantBackup')
const usernameGuard = require('../utils/usernameGuard') // v3.4.1 — username unik global lintas tenant
const validity = require('../services/validity') // v3.8 — masa aktif tenant
const apiKeys = require('../services/apiKeys') // v3.9.13 — Public API v1 keys
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
function waStatusFor(tenantId, slot = 0) {
  const s = wa.getStatusForTenant(tenantId, slot)
  return {
    connected: s.connected,
    qrNeeded: s.qrNeeded,
    state: s.state,
    phoneNumber: s.phoneNumber || null,
    disabled: !!s.disabled,
    slot: Number(slot) || 0,
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
    maxNumbers: plan.maxNumbers ?? null, // v3.9 — kuota nomor WA (null = 1, hard cap 3)
    tkQuotaBytes: plan.tkQuotaBytes == null ? null : Number(plan.tkQuotaBytes),
    featAnalytics: plan.featAnalytics,
    featBlast: plan.featBlast,
    featMenuGateway: plan.featMenuGateway,
    featHistoryExport: plan.featHistoryExport,
    featCsat: plan.featCsat,
    featGdriveBackup: plan.featGdriveBackup,
    featApiAccess: plan.featApiAccess, // v3.9.13 — plan gate Public API
    featAiRouting: plan.featAiRouting, // v3.9.25 — AI Hybrid Routing gate
    featAiKnowledge: plan.featAiKnowledge, // v4.0.0 — CB-AI Knowledge Auto-Reply gate
  }
}

// v3.9 — status WA per-slot utk kartu tenant (polling v3.8 yang sudah ada dipakai)
function waSlotsFor(tenantId) {
  return wa.listTenantNumbers(tenantId)
    .then((rows) => rows.map((n) => ({
      id: n.id,
      slot: n.slot,
      label: n.label || null,
      routeMode: n.routeMode || 'pool',
      assignedAgentId: n.assignedAgentId || null,
      reassignOffline: !!n.reassignOffline,
      waSessionDir: n.waSessionDir || null,
      status: waStatusFor(tenantId, n.slot),
    })))
    .catch(() => [])
}

// GET /api/sa/tenants — list + jumlah user/chat per tenant + waStatus (fase 1: disabled)
// v3.4 — + plan (badge paket) + usage meter (agents/contacts/tkBytes)
// v3.9 — + slots (daftar nomor per tenant + status per-slot) + waMode
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
        // v3.9 — mode multi-nomor + daftar slot (additive)
        waMode: t.waMode || 'pool',
        slots: await waSlotsFor(t.id),
        // v3.9.25 — AI Hybrid toggle per-tenant (D5a): status baca dari row menu gateway
        // shared tenant (numberSlot null). Row belum ada → false. Gagal → false (non-fatal).
        aiHybridEnabled: await prisma.menuGatewayConfig.findFirst({ where: { tenantId: t.id, numberSlot: null }, select: { aiHybrid: true } }).then(r => !!r?.aiHybrid).catch(() => false),
        createdAt: t.createdAt,
        // v3.8 — masa aktif tenant (+ computed validityState; null/null = lifetime)
        ...validity.validityToJson(t),
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

// PUT /api/sa/tenants/:id/validity — v3.8 — set masa aktif tenant (super_admin only).
// body: { preset: '30d'|'1y'|'lifetime'|'custom', startDate?: ISO, endDate?: ISO }
// - lifetime → validUntil = null (validFrom boleh diset utk catatan)
// - 30d/1y   → validFrom = startDate || now; validUntil = validFrom + durasi
// - custom   → wajib endDate > startDate (400 kalau tidak)
// Response: nilai final + computed state. Audit action: validity_update.
router.put(
  '/tenants/:id/validity',
  ...sa,
  [body('preset').trim().notEmpty().withMessage('preset wajib diisi')],
  async (req, res) => {
    try {
      if (!validate(req, res)) return
      const id = parseInt(req.params.id, 10)
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid tenant id' })
      const tenant = await prisma.tenant.findUnique({ where: { id } })
      if (!tenant) return res.status(404).json({ error: 'Tenant not found' })

      const applied = validity.applyValidityPreset(tenant, req.body || {})
      if (applied.error) return res.status(400).json({ error: applied.error })

      const updated = await prisma.tenant.update({ where: { id }, data: applied.data })
      const state = validity.validityState(updated)
      console.log(`[SA] Tenant #${id} (${updated.name}) validity: preset=${req.body.preset} → validFrom=${updated.validFrom?.toISOString() || null} validUntil=${updated.validUntil?.toISOString() || null} state=${state}`)
      await saAudit.audit(req.user, 'validity_update', id, updated.name, {
        preset: String(req.body.preset || ''),
        startDate: req.body.startDate || null,
        endDate: req.body.endDate || null,
        validFrom: updated.validFrom ? updated.validFrom.toISOString() : null,
        validUntil: updated.validUntil ? updated.validUntil.toISOString() : null,
        state,
      })
      res.json({
        validFrom: updated.validFrom ? updated.validFrom.toISOString() : null,
        validUntil: updated.validUntil ? updated.validUntil.toISOString() : null,
        validityState: state,
      })
    } catch (e) {
      console.error('[SA] Set validity error:', e)
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
      void systemLog.logError(`Purge tenant #${tid} error`, { module: 'tenant', tenantId: tid || null, err: e })
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
    body('username').matches(/^[A-Za-z0-9._-]+$/).withMessage('Username hanya boleh huruf, angka, titik, underscore, dan strip'),
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
      // v3.4.1 — unik GLOBAL + case-insensitive lintas tenant (paritas users.js POST)
      const conflict = await usernameGuard.findConflict(username)
      if (conflict) {
        const suggestions = await usernameGuard.suggestUsernames(username, tenant.name)
        return res.status(409).json({ error: usernameGuard.conflictMessage(username, suggestions), suggestions })
      }

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

// ═══════════════════════ v3.9 — MULTI-NOMOR WA (slot management) ═══════════════════════
// Slot-0 = slot utama (implisit, sesi existing — TIDAK boleh dihapus via API ini);
// slot 1/2 = tambahan (dir tenant-<id>/slot-<n>). Kuota = jumlah BARIS slot yang ADA
// (connected/tidak — owner 18:24 #4). Cap = plan.maxNumbers (null = 1; hard cap 3).
// Pelanggaran cap → 403 (spec §5).
const SA_MAX_NUMBERS_HARD_CAP = 3

async function effectiveMaxNumbers(tenantId) {
  const plan = await plans.getPlan(tenantId)
  const n = plan?.maxNumbers
  const eff = (n == null || !Number.isFinite(Number(n))) ? 1 : Math.max(0, Math.trunc(Number(n)))
  return Math.min(eff, SA_MAX_NUMBERS_HARD_CAP)
}

// GET /api/sa/tenants/:id/numbers — daftar slot + status per-slot
router.get('/tenants/:id/numbers', ...sa, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid tenant id' })
    const tenant = await prisma.tenant.findUnique({ where: { id } })
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' })
    const slots = await waSlotsFor(id)
    const maxNumbers = await effectiveMaxNumbers(id)
    const usedDb = await prisma.tenantNumber.count({ where: { tenantId: id } }) // v3.9 fix BUG-14: konsisten dgn POST (hitung dari DB)
    res.json({ slots, maxNumbers, used: Math.max(usedDb, 1), waMode: tenant.waMode || 'pool' })
  } catch (e) {
    console.error('[SA] List numbers error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/sa/tenants/:id/numbers { slot, label?, routeMode?, assignedAgentId?, reassignOffline? }
// — tambah/daftarkan slot. Cap dgn plan.maxNumbers → 403 bila lebih.
router.post(
  '/tenants/:id/numbers',
  ...sa,
  [
    body('slot').notEmpty().withMessage('slot wajib (0..2)'),
  ],
  async (req, res) => {
    try {
      if (!validate(req, res)) return
      const id = parseInt(req.params.id, 10)
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid tenant id' })
      const tenant = await prisma.tenant.findUnique({ where: { id }, include: { plan: true } })
      if (!tenant) return res.status(404).json({ error: 'Tenant not found' })

      const slot = parseInt(req.body.slot, 10)
      if (!Number.isFinite(slot) || slot < 0 || slot > SA_MAX_NUMBERS_HARD_CAP - 1) {
        return res.status(400).json({ error: `Slot harus 0..${SA_MAX_NUMBERS_HARD_CAP - 1} (maks ${SA_MAX_NUMBERS_HARD_CAP} nomor)` })
      }

      const maxNumbers = await effectiveMaxNumbers(id)
      const used = await prisma.tenantNumber.count({ where: { tenantId: id } })
      const exists = await prisma.tenantNumber.findUnique({ where: { tenantId_slot: { tenantId: id, slot } } })
      if (!exists && used >= maxNumbers) {
        return res.status(403).json({
          error: `Kuota nomor WA penuh (${used}/${maxNumbers}). Naikkan "Maks. Nomor WA" di paket tenant untuk menambah slot.`,
          used,
          maxNumbers,
        })
      }

      const data = {}
      if (req.body.label !== undefined) {
        const label = String(req.body.label || '').trim()
        if (label.length > 50) return res.status(400).json({ error: 'Label maksimal 50 karakter' })
        data.label = label === '' ? null : label
      }
      if (req.body.routeMode !== undefined) {
        if (!['pool', 'assigned'].includes(req.body.routeMode)) {
          return res.status(400).json({ error: 'routeMode harus pool|assigned' })
        }
        data.routeMode = req.body.routeMode
      }
      if (req.body.assignedAgentId !== undefined) {
        if (req.body.assignedAgentId === null) data.assignedAgentId = null
        else {
          const aid = parseInt(req.body.assignedAgentId, 10)
          if (!Number.isFinite(aid)) return res.status(400).json({ error: 'assignedAgentId tidak valid' })
          const agent = await prisma.user.findFirst({ where: { id: aid, tenantId: id, role: { in: ['cs', 'admin'] }, status: 'active' } })
          if (!agent) return res.status(400).json({ error: 'Agent tidak ditemukan di tenant ini (role cs/admin, aktif)' })
          data.assignedAgentId = aid
        }
      }
      if (req.body.reassignOffline !== undefined) data.reassignOffline = !!req.body.reassignOffline

      const row = await prisma.tenantNumber.upsert({
        where: { tenantId_slot: { tenantId: id, slot } },
        update: data,
        create: { tenantId: id, slot, ...data },
      })
      console.log(`[SA] Tenant #${id} (${tenant.name}) number slot=${slot} di-upsert by @${req.user.username}`)
      await saAudit.audit(req.user, 'tenant_update', id, tenant.name, { action: 'number_upsert', slot, ...data })
      // Connect slot baru langsung (best-effort; QR akan broadcast)
      try {
        if (!config.waDisabled) await wa.connectTenant(id, { slot })
      } catch (e) {
        console.error(`[SA] connect slot ${slot} gagal (non-fatal):`, e.message)
      }
      res.status(201).json({ number: row })
    } catch (e) {
      console.error('[SA] Create number error:', e)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
)

// DELETE /api/sa/tenants/:id/numbers/:slot — hapus slot (logout + hapus dir sesi slot itu).
// slot-0 TIDAK boleh dihapus (slot utama = sesi existing). Sesi slot dihapus AMAN
// (logoutTenant per-slot hanya menyentuh dir slot itu).
// v3.9.2 K1-A (18): slot yang MASIH PUNYA chat → 409 dgn pesan jelas.
router.delete('/tenants/:id/numbers/:slot', ...sa, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    const slot = parseInt(req.params.slot, 10)
    if (!Number.isFinite(id) || !Number.isFinite(slot)) return res.status(400).json({ error: 'Invalid id/slot' })
    if (slot === 0) return res.status(400).json({ error: 'Slot-0 (nomor utama) tidak bisa dihapus — gunakan logout WhatsApp saja' })
    const tenant = await prisma.tenant.findUnique({ where: { id } })
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' })
    const row = await prisma.tenantNumber.findUnique({ where: { tenantId_slot: { tenantId: id, slot } } })
    if (!row) return res.status(404).json({ error: 'Slot tidak terdaftar' })
    // v3.9.2 K1-A (18) — slot masih punya chat → tolak 409 (chat gak boleh menggantung)
    const chatCount = await prisma.chat.count({ where: { tenantId: id, numberSlot: slot } })
    if (chatCount > 0) {
      return res.status(409).json({
        error: `Slot ${slot} masih punya ${chatCount} chat di tenant ini. Hapus/pindahkan chat-nya dulu (atau logout saja tanpa hapus slot) sebelum menghapus nomor.`,
        chatCount,
      })
    }
    // Logout per-slot: sesi WA slot itu dihapus aman (slot lain tidak tersentuh)
    // v3.9 fix BUG-11: logout GAGAL → 409, row TIDAK dihapus (cegah socket hantu)
    try {
      await wa.logoutTenant(id, slot)
    } catch (e) {
      console.error(`[SA] logout slot ${slot} error:`, e.message)
      return res.status(409).json({ error: `Gagal logout slot ${slot}: ${e.message}. Slot tidak dihapus — coba lagi setelah perbaikan koneksi.` })
    }
    await prisma.tenantNumber.delete({ where: { id: row.id } })
    console.log(`[SA] Tenant #${id} (${tenant.name}) number slot=${slot} DIHAPUS by @${req.user.username}`)
    await saAudit.audit(req.user, 'tenant_update', id, tenant.name, { action: 'number_delete', slot })
    res.json({ ok: true })
  } catch (e) {
    console.error('[SA] Delete number error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/sa/tenants/:id/wa-mode { waMode } — pool | assigned | mix
router.put(
  '/tenants/:id/wa-mode',
  ...sa,
  [body('waMode').trim().notEmpty().withMessage('waMode wajib (pool|assigned|mix)')],
  async (req, res) => {
    try {
      if (!validate(req, res)) return
      const id = parseInt(req.params.id, 10)
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid tenant id' })
      const tenant = await prisma.tenant.findUnique({ where: { id } })
      if (!tenant) return res.status(404).json({ error: 'Tenant not found' })
      const mode = String(req.body.waMode || '')
      if (!['pool', 'assigned', 'mix'].includes(mode)) {
        return res.status(400).json({ error: 'waMode harus pool|assigned|mix' })
      }
      const updated = await prisma.tenant.update({ where: { id }, data: { waMode: mode } })
      await saAudit.audit(req.user, 'tenant_update', id, tenant.name, { action: 'wa_mode', waMode: mode })
      res.json({ waMode: updated.waMode })
    } catch (e) {
      console.error('[SA] Set wa-mode error:', e)
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

// ═══════════════════════ v3.9.19 — STATISTIK TREND (additive murni) ═══════════════════════
// Semua chart dihitung dari tabel Chat existing — ZERO migration (spec §9 invariant).
// Server berjalan UTC → grouping per hari dikonversi ke WIB (UTC+7, Asia/Jakarta)
// di query (strftime modifier '+07:00'); grouping HARUS di SQL, bukan JS offset.

/** Regex + util tanggal 'YYYY-MM-DD' (WIB) — v3.9.20 (additive). */
const SA_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Tanggal WIB hari ini (YYYY-MM-DD). */
function saTodayWibStr() {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/** 'YYYY-MM-DD' valid sebagai tanggal kalender? (menolak 2026-02-30, 2026-13-01, dst.) */
function saIsValidDateStr(s) {
  if (!SA_DATE_RE.test(s)) return false
  const ms = Date.parse(`${s}T00:00:00Z`)
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === s
}

/** Midnight WIB (dalam ms UTC) untuk tanggal 'YYYY-MM-DD'. */
function saWibMidnightMs(dateStr) {
  return Date.UTC(
    Number(dateStr.slice(0, 4)), Number(dateStr.slice(5, 7)) - 1, Number(dateStr.slice(8, 10))
  ) - 7 * 60 * 60 * 1000
}

/**
 * Range query-param → descriptor (v3.9.20).
 * - today|7d|30d → { days, label } (behavior existing preserved)
 * - all          → { days: null, label: 'all' }
 * - custom       → { days: null, label: 'custom', from, to } — WAJIB ?from=YYYY-MM-DD&to=YYYY-MM-DD
 *                  (WIB; from<=to; to<=hari ini; span inklusif <=366 hari) — invalid → { error }
 * - unknown      → null (caller balas 400)
 */
function parseSaRange(req) {
  const raw = String(req.query.range || '7d').toLowerCase()
  if (raw === 'today') return { days: 1, label: 'today' }
  if (raw === '7d') return { days: 7, label: '7d' }
  if (raw === '30d') return { days: 30, label: '30d' }
  if (raw === 'all') return { days: null, label: 'all' }
  if (raw === 'custom') {
    const from = String(req.query.from || '').trim()
    const to = String(req.query.to || '').trim()
    if (!SA_DATE_RE.test(from) || !SA_DATE_RE.test(to)) {
      return { error: 'range=custom wajib parameter ?from=YYYY-MM-DD&to=YYYY-MM-DD (tanggal WIB)' }
    }
    if (!saIsValidDateStr(from) || !saIsValidDateStr(to)) {
      return { error: 'Tanggal from/to bukan tanggal kalender yang valid (format YYYY-MM-DD)' }
    }
    if (from > to) return { error: 'Parameter from harus <= to' }
    const todayStr = saTodayWibStr()
    if (to > todayStr) return { error: `Parameter to tidak boleh di masa depan (maksimal ${todayStr} WIB)` }
    const spanDays = Math.round((saWibMidnightMs(to) - saWibMidnightMs(from)) / 86400000) + 1
    if (spanDays > 366) return { error: 'Span rentang tanggal custom maksimal 366 hari' }
    return { days: null, label: 'custom', from, to }
  }
  return null
}

/**
 * WIB window utk range: hari "hari ini" mengikuti tanggal WIB (bukan UTC).
 * Window = N hari kalender WIB terakhir (inclusive hari ini).
 * Return { sinceIso, todayStr } — sinceIso = midnight WIB hari ke-N.
 */
function saWibWindow(days) {
  const nowWibMs = Date.now() + 7 * 60 * 60 * 1000
  const todayStr = new Date(nowWibMs).toISOString().slice(0, 10) // shifted = WIB clock
  const todayStartMs = Date.UTC(
    Number(todayStr.slice(0, 4)), Number(todayStr.slice(5, 7)) - 1, Number(todayStr.slice(8, 10))
  ) - 7 * 60 * 60 * 1000 // midnight WIB hari ini dalam ms UTC
  return {
    todayStr,
    sinceIso: new Date(todayStartMs - (days - 1) * 86400000).toISOString(),
  }
}

/** Daftar tanggal WIB (YYYY-MM-DD) oldest → today utk window (selalu penuh). */
function saWibDateList(days) {
  const out = []
  const nowWibMs = Date.now() + 7 * 60 * 60 * 1000
  const iso = new Date(nowWibMs).toISOString()
  const todayUtcMidnight = Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)))
  for (let i = days - 1; i >= 0; i--) {
    out.push(new Date(todayUtcMidnight - i * 86400000).toISOString().slice(0, 10))
  }
  return out
}

// ───────────────────────── v3.9.20 — PER-CHART DATE RANGES (additive) ─────────────────────────

/** Daftar tanggal WIB (YYYY-MM-DD) oldest → newest antara dua tanggal, inklusif.
 * v3.9.20 round-2 BUGFIX: jangan pakai saWibMidnightMs (UTC−7h → toISOString
 * balikin D−1 → sumbu tanggal geser sehari, total/zero-fill salah). Label tanggal
 * kalender murni — aritmetika string-date UTC midnight, grouping SQL map 1:1. */
function saWibDateListBetween(fromStr, toStr) {
  const start = Date.UTC(Number(fromStr.slice(0, 4)), Number(fromStr.slice(5, 7)) - 1, Number(fromStr.slice(8, 10)))
  const end = Date.UTC(Number(toStr.slice(0, 4)), Number(toStr.slice(5, 7)) - 1, Number(toStr.slice(8, 10)))
  const out = []
  for (let ms = start; ms <= end; ms += 86400000) {
    out.push(new Date(ms).toISOString().slice(0, 10))
  }
  return out
}

/** Tanggal WIB (YYYY-MM-DD) data Chat pertama (all time) — null bila tabel kosong.
 * Anchor = COALESCE(firstIncomingAt, createdAt), konsisten dengan window trends. */
async function saAllTimeStartDateStr() {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT MIN(COALESCE("firstIncomingAt", "createdAt")) AS mn FROM Chat'
  )
  const mn = rows?.[0]?.mn
  if (mn == null) return null
  return new Date(Number(mn) + 7 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/**
 * v3.9.20 — Window + sumbu tanggal untuk range apa pun (today|7d|30d|all|custom).
 * Return { todayStr, sinceIso|null, untilIso|null, dates[] }.
 * sinceIso/untilIso = batas window (since inklusif, until eksklusif); null = tanpa
 * filter di sisi itu. dates = daftar harian WIB penuh (caller zero-fill dari map).
 */
async function saStatsWindow(range) {
  const todayStr = saTodayWibStr()
  if (range.label === 'all') {
    const startStr = await saAllTimeStartDateStr()
    const from = startStr && startStr < todayStr ? startStr : todayStr
    return { todayStr, sinceIso: null, untilIso: null, dates: saWibDateListBetween(from, todayStr) }
  }
  if (range.label === 'custom') {
    return {
      todayStr,
      sinceIso: new Date(saWibMidnightMs(range.from)).toISOString(),
      untilIso: new Date(saWibMidnightMs(range.to) + 86400000).toISOString(),
      dates: saWibDateListBetween(range.from, range.to),
    }
  }
  // today | 7d | 30d — perilaku existing (window berakhir terbuka sisi atas)
  const { sinceIso } = saWibWindow(range.days)
  return { todayStr, sinceIso, untilIso: null, dates: saWibDateList(range.days) }
}

/** v3.9.21 — Sumbu per-jam WIB utk range "today": ['00','01',…,'<jam WIB sekarang>']
 * (inklusif jam saat ini, zero-padded). Window tetap [midnight WIB, +1d).
 * Mirror FE/E2E: now + 7h → getUTCHours() = jam dinding WIB. */
function saHourlyHourList() {
  const hourWib = new Date(Date.now() + 7 * 60 * 60 * 1000).getUTCHours()
  const out = []
  for (let h = 0; h <= hourWib; h++) out.push(String(h).padStart(2, '0'))
  return out
}

// GET /api/sa/stats/trends?range=today|7d|30d|all|custom — jumlah chat baru per hari (semua
// tenant), grouped WIB. Sumber tanggal = COALESCE(firstIncomingAt, createdAt)
// (chat import/seed bisa firstIncomingAt lebih tua dari createdAt — pakai yang
// tersedia). dates selalu penuh (hari kosong = 0) — frontend tanpa zero-fill.
// v3.9.20: all = tanpa filter sejak (dates dari data pertama); custom = from/to
// WIB (since <= t < until). Shape: { range, today, dates: [...WIB], counts: [...], total
// (+from, to utk custom) }
router.get('/stats/trends', ...sa, async (req, res) => {
  try {
    const range = parseSaRange(req)
    if (range?.error) return res.status(400).json({ error: range.error })
    if (!range) return res.status(400).json({ error: 'range harus today|7d|30d|all|custom' })
    // v3.9.21 — range "today" → sumbu PER JAM WIB (hourly): labels '00','01',…
    // s/d '<jam WIB sekarang>' (inklusif, zero-filled), window tetap [midnight WIB,
    // +1d) — konsisten dgn semantics existing. Grouping strftime('%H') (datetime
    // = INTEGER ms epoch — lesson v3.9.19). Range non-today: shape UNCHANGED
    // (tanpa field mode → mode:'hourly' hanya utk today).
    if (range.label === 'today') {
      const { todayStr } = await saStatsWindow(range)
      const hours = saHourlyHourList()
      const midMs = saWibMidnightMs(todayStr)
      const rows = await prisma.$queryRawUnsafe(`
        SELECT strftime('%H', COALESCE("firstIncomingAt", "createdAt")/1000, 'unixepoch', '+07:00') AS hour,
               COUNT(*) AS cnt
        FROM Chat
        WHERE COALESCE("firstIncomingAt", "createdAt") >= ? AND COALESCE("firstIncomingAt", "createdAt") < ?
        GROUP BY hour ORDER BY hour ASC
      `, new Date(midMs), new Date(midMs + 86400000))
      const map = new Map(rows.map((r) => [String(r.hour), Number(r.cnt)]))
      const counts = hours.map((h) => map.get(h) || 0) // zero-fill dari sumbu jam
      const total = counts.reduce((a, b) => a + b, 0)
      return res.json({ range: 'today', mode: 'hourly', today: todayStr, dates: hours, counts, total })
    }
    const { sinceIso, untilIso, todayStr, dates } = await saStatsWindow(range)
    const conds = []
    const params = []
    if (sinceIso != null) { conds.push('COALESCE("firstIncomingAt", "createdAt") >= ?'); params.push(new Date(sinceIso)) }
    if (untilIso != null) { conds.push('COALESCE("firstIncomingAt", "createdAt") < ?'); params.push(new Date(untilIso)) }
    const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const rows = await prisma.$queryRawUnsafe(`
      SELECT strftime('%Y-%m-%d', COALESCE("firstIncomingAt", "createdAt")/1000, 'unixepoch', '+07:00') AS day,
             COUNT(*) AS cnt
      FROM Chat
      ${whereSql}
      GROUP BY day ORDER BY day ASC
    `, ...params)
    const map = new Map(rows.map((r) => [String(r.day), Number(r.cnt)]))
    const counts = dates.map((d) => map.get(d) || 0) // zero-fill dari sumbu window
    const total = counts.reduce((a, b) => a + b, 0)
    const payload = { range: range.label, today: todayStr, dates, counts, total }
    if (range.label === 'custom') { payload.from = range.from; payload.to = range.to }
    res.json(payload)
  } catch (e) {
    console.error('[SA] Stats trends error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/sa/stats/avg-response?range=today|7d|30d|all|custom — rata-rata
// firstResponseAt − firstIncomingAt (MENIT) per hari, semua tenant, grouped WIB.
// Chat tanpa firstResponseAt (belum dibalas) dikecualikan — bukan dihitung 0.
// v3.9.20: window semantics = trends (since <= firstIncomingAt < until; all = tanpa
// filter). Shape: { range, dates, avgMinutes: [n|null...], avgTotal: n|null
// (+from, to utk custom) }. avgTotal = agregat window (sum durasi / sum n),
// BUKAN mean-of-means.
router.get('/stats/avg-response', ...sa, async (req, res) => {
  try {
    const range = parseSaRange(req)
    if (range?.error) return res.status(400).json({ error: range.error })
    if (!range) return res.status(400).json({ error: 'range harus today|7d|30d|all|custom' })
    // v3.9.21 — range "today" → bucket PER JAM WIB. Base filters WAJIB tetap
    // (firstIncomingAt IS NOT NULL + firstResponseAt IS NOT NULL +
    // firstResponseAt >= firstIncomingAt) + window [midnight WIB, +1d) pada
    // firstIncomingAt. avgTotal = agregat sum/sum window (bukan mean-of-means);
    // bucket/jam tanpa data = null.
    if (range.label === 'today') {
      const { todayStr } = await saStatsWindow(range)
      const hours = saHourlyHourList()
      const midMs = saWibMidnightMs(todayStr)
      const conds = ['"firstIncomingAt" IS NOT NULL', '"firstResponseAt" IS NOT NULL', '"firstResponseAt" >= "firstIncomingAt"', '"firstIncomingAt" >= ?', '"firstIncomingAt" < ?']
      const params = [new Date(midMs), new Date(midMs + 86400000)]
      const rows = await prisma.$queryRawUnsafe(`
        SELECT strftime('%H', "firstIncomingAt"/1000, 'unixepoch', '+07:00') AS hour,
               AVG((julianday("firstResponseAt"/1000, 'unixepoch') - julianday("firstIncomingAt"/1000, 'unixepoch')) * 1440.0) AS avgMin,
               COUNT(*) AS n
        FROM Chat
        WHERE ${conds.join(' AND ')}
        GROUP BY hour ORDER BY hour ASC
      `, ...params)
      const map = new Map(rows.map((r) => [String(r.hour), { avg: Number(r.avgMin), n: Number(r.n) }]))
      const avgMinutes = hours.map((h) => {
        const v = map.get(h)
        return v ? Math.round(v.avg * 10) / 10 : null // null = belum ada data jam itu
      })
      let sumMin = 0
      let sumN = 0
      for (const [, v] of map) { sumMin += v.avg * v.n; sumN += v.n }
      const avgTotal = sumN > 0 ? Math.round((sumMin / sumN) * 10) / 10 : null
      return res.json({ range: 'today', mode: 'hourly', today: todayStr, dates: hours, avgMinutes, avgTotal })
    }
    const { sinceIso, untilIso, dates } = await saStatsWindow(range)
    // Base filter selalu ada (all/custom/today) + window opsional
    const conds = ['"firstIncomingAt" IS NOT NULL', '"firstResponseAt" IS NOT NULL', '"firstResponseAt" >= "firstIncomingAt"']
    const params = []
    if (sinceIso != null) { conds.push('"firstIncomingAt" >= ?'); params.push(new Date(sinceIso)) }
    if (untilIso != null) { conds.push('"firstIncomingAt" < ?'); params.push(new Date(untilIso)) }
    const whereSql = `WHERE ${conds.join(' AND ')}`
    const rows = await prisma.$queryRawUnsafe(`
      SELECT strftime('%Y-%m-%d', "firstIncomingAt"/1000, 'unixepoch', '+07:00') AS day,
             AVG((julianday("firstResponseAt"/1000, 'unixepoch') - julianday("firstIncomingAt"/1000, 'unixepoch')) * 1440.0) AS avgMin,
             COUNT(*) AS n
      FROM Chat
      ${whereSql}
      GROUP BY day ORDER BY day ASC
    `, ...params)
    const map = new Map(rows.map((r) => [String(r.day), { avg: Number(r.avgMin), n: Number(r.n) }]))
    const avgMinutes = dates.map((d) => {
      const v = map.get(d)
      return v ? Math.round(v.avg * 10) / 10 : null // null = belum ada data hari itu
    })
    let sumMin = 0
    let sumN = 0
    for (const [, v] of map) { sumMin += v.avg * v.n; sumN += v.n }
    const avgTotal = sumN > 0 ? Math.round((sumMin / sumN) * 10) / 10 : null
    const payload = { range: range.label, dates, avgMinutes, avgTotal }
    if (range.label === 'custom') { payload.from = range.from; payload.to = range.to }
    res.json(payload)
  } catch (e) {
    console.error('[SA] Stats avg-response error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/sa/stats/tk-storage — ukuran storage "Tangan Kanan" semua tenant
// (SharedFile groupBy tenantId). v3.9.21 ADDITIVE — ZERO migration (schema
// existing SharedFile.size Int?). Pertimbangan upgrade server Kanaka.
// Shape: { totalBytes, fileCount, perTenant: [{ tenantId, tenantName, bytes,
// files }] } — size NULL dihitung 0; perTenant sort desc by bytes (tenant 0 byte
// otomatis di akhir); total = jumlah semua (JS number aman utk SQLite 64-bit).
router.get('/stats/tk-storage', ...sa, async (req, res) => {
  try {
    const groups = await prisma.sharedFile.groupBy({
      by: ['tenantId'],
      _sum: { size: true },
      _count: { _all: true },
    })
    const tenants = await prisma.tenant.findMany({ select: { id: true, name: true } })
    const nameMap = new Map(tenants.map((t) => [t.id, t.name]))
    const perTenant = groups
      .map((g) => ({
        tenantId: g.tenantId,
        tenantName: nameMap.get(g.tenantId) || `Tenant ${g.tenantId}`,
        bytes: Number(g._sum.size || 0),
        files: Number(g._count._all || 0),
      }))
      .sort((a, b) => b.bytes - a.bytes || b.files - a.files)
    const totalBytes = perTenant.reduce((a, t) => a + t.bytes, 0)
    const fileCount = perTenant.reduce((a, t) => a + t.files, 0)
    res.json({ totalBytes, fileCount, perTenant })
  } catch (e) {
    console.error('[SA] Stats tk-storage error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/sa/stats/resolution?range=today|7d|30d|all|custom — resolved vs open
// (+percent). v3.9.20: window pada COALESCE(firstIncomingAt, createdAt) — chats
// yang MASUK dalam window; resolved = subset dgn status='resolved' OR
// resolvedAt IS NOT NULL (chat legacy Cekat.AI: resolvedAt NULL tapi status
// 'resolved' ikut terhitung → fix pie 0%); open = total − resolved. all = tanpa
// filter. Shape: { range, resolved, open, percentResolved, percentOpen
// (+from, to utk custom) }
router.get('/stats/resolution', ...sa, async (req, res) => {
  try {
    const range = parseSaRange(req)
    if (range?.error) return res.status(400).json({ error: range.error })
    if (!range) return res.status(400).json({ error: 'range harus today|7d|30d|all|custom' })
    const { sinceIso, untilIso } = await saStatsWindow(range)
    const conds = []
    const params = []
    if (sinceIso != null) { conds.push('COALESCE("firstIncomingAt", "createdAt") >= ?'); params.push(new Date(sinceIso)) }
    if (untilIso != null) { conds.push('COALESCE("firstIncomingAt", "createdAt") < ?'); params.push(new Date(untilIso)) }
    const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const rows = await prisma.$queryRawUnsafe(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'resolved' OR "resolvedAt" IS NOT NULL THEN 1 ELSE 0 END) AS resolved
      FROM Chat
      ${whereSql}
    `, ...params)
    const total = Number(rows?.[0]?.total || 0)
    const resolved = Number(rows?.[0]?.resolved || 0)
    const open = total - resolved
    const pct = (n) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0)
    const payload = { range: range.label, resolved, open, percentResolved: pct(resolved), percentOpen: pct(open) }
    if (range.label === 'custom') { payload.from = range.from; payload.to = range.to }
    res.json(payload)
  } catch (e) {
    console.error('[SA] Stats resolution error:', e)
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
        // v3.9 — kuota nomor WA
        numbers: (await prisma.tenantNumber.count({ where: { tenantId: id } })),
        maxNumbers: plan?.maxNumbers ?? null,
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
          maxNumbers: tenant.plan.maxNumbers, // v3.9
          tkQuotaBytes: tenant.plan.tkQuotaBytes == null ? null : Number(tenant.plan.tkQuotaBytes),
          featAnalytics: tenant.plan.featAnalytics,
          featBlast: tenant.plan.featBlast,
          featMenuGateway: tenant.plan.featMenuGateway,
          featHistoryExport: tenant.plan.featHistoryExport,
          featCsat: tenant.plan.featCsat,
          featGdriveBackup: tenant.plan.featGdriveBackup,
          featApiAccess: tenant.plan.featApiAccess, // v3.9.13
        }
      } else {
        fields = plans.applyPreset('max')
      }

      // Override individual: hanya field yang EKSPLISIT di body (null = unlimited)
      const explicitQuota = {}
      // v3.9 — maxNumbers: null = 1 (default); 0..3 (hard cap 3 di semua jalur)
      if (req.body.maxNumbers !== undefined) {
        if (req.body.maxNumbers === null) explicitQuota.maxNumbers = null
        else {
          const n = Number(req.body.maxNumbers)
          if (!Number.isFinite(n) || n < 0) {
            return res.status(400).json({ error: 'maxNumbers harus angka >= 0 atau null (=1)' })
          }
          const capped = Math.min(Math.trunc(n), 3)
          if (Math.trunc(n) > 3) {
            console.warn('[SA] maxNumbers > 3 di-cap ke 3 (hard cap multi-nomor)')
          }
          explicitQuota.maxNumbers = capped
        }
      }
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

      // ── v3.9.16b — removeLogo: hapus logo terpasang (file disk + field) ──
      // Bug: sekalinya pasang logo gak bisa dihilangin (lapor Kanaka 25/9).
      const removeLogo = req.body.removeLogo === 'true' || req.body.removeLogo === '1'
      if (removeLogo && req.file) {
        return res.status(400).json({ error: 'Kirim logo BARU ATAU removeLogo — bukan keduanya' })
      }
      let logoRemoved = false
      if (removeLogo && tenant.logoPath) {
        if (fs.existsSync(tenant.logoPath)) {
          try { fs.unlinkSync(tenant.logoPath) } catch {}
        }
        logoRemoved = true
        detail.logoRemoved = true
      }

      if (brandNameApplied === null && !logoApplied && !logoRemoved && req.body.brandName === undefined) {
        return res.status(400).json({ error: 'Tidak ada yang diupdate (kirim brandName dan/atau logo)' })
      }

      const data = {}
      if (req.body.brandName !== undefined) {
        // JSON: brandName:"" → reset null; brandName:"X" → simpan
        data.brandName = brandNameApplied
      }
      if (logoApplied) data.logoPath = logoApplied
      if (logoRemoved) data.logoPath = null

      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: 'Tidak ada perubahan branding yang valid' })
      }

      const updated = await prisma.tenant.update({ where: { id }, data })
      console.log(`[SA] Branding tenant #${id} (${tenant.name}) diupdate by @${req.user.username}: ${JSON.stringify({ brandName: data.brandName !== undefined ? data.brandName : undefined, logo: !!logoApplied })}`)
      await saAudit.audit(req.user, 'branding_update', id, tenant.name, detail)
      // v3.9.15 — live update: tab tenant yang sudah terbuka refresh branding
      // tanpa full reload (dulu stale sampai F5 — bug ParahitaAsik 2026-09-25).
      broadcast.emitToTenant(id, 'branding_update', { brandName: updated.brandName || '', hasLogo: !!updated.logoPath })
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

// ═══════════════════════ v3.9.13 — PUBLIC API KEYS (superadmin onboarding) ═══

// GET /api/sa/tenants/:id/api-keys — list keys tenant (owner bantu onboarding)
router.get('/tenants/:id/api-keys', ...sa, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid tenant id' })
    const tenant = await prisma.tenant.findUnique({ where: { id }, select: { id: true, name: true } })
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' })
    const rows = await apiKeys.listByTenant(id, true)
    res.json({ keys: rows.map(apiKeys.rowToPublic) })
  } catch (e) {
    console.error('[SA] ApiKeys list error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/sa/tenants/:id/api-keys { name, scopes, ratePerMin?, planGated? }
// → 201 { apiKey, key: RAW (SEKALI), warning } — onboarding help oleh owner platform
router.post(
  '/tenants/:id/api-keys',
  ...sa,
  [],
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10)
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid tenant id' })
      const tenant = await prisma.tenant.findUnique({ where: { id } })
      if (!tenant) return res.status(404).json({ error: 'Tenant not found' })

      let created
      try {
        created = await apiKeys.generate({
          tenantId: id,
          name: req.body?.name,
          scopes: apiKeys.parseScopes(req.body?.scopes),
          ratePerMin: req.body?.ratePerMin,
          planGated: req.body?.planGated === undefined ? true : Boolean(req.body.planGated),
          expiresAt: req.body?.expiresAt || null,
          createdByUserId: req.user.id,
        })
      } catch (e) {
        if (e?.code === 'VALIDATION') return res.status(400).json({ error: e.message, code: 'VALIDATION' })
        throw e
      }

      console.log(`[SA] API key dibuat utk tenant #${id} (${tenant.name}) id=${created.apiKey.id} scopes="${created.apiKey.scopes}" by @${req.user.username} (raw TIDAK di-log)`)
      await saAudit.audit(req.user, 'api_key_create', id, tenant.name, {
        keyId: created.apiKey.id,
        name: created.apiKey.name,
        scopes: created.apiKey.scopes,
        prefix: created.apiKey.prefix,
      })
      res.status(201).json({
        apiKey: apiKeys.rowToPublic(created.apiKey),
        key: created.rawKey, // SEKALI ini — raw tidak tersimpan/log
        warning: 'Simpan key ini SEKARANG — hanya ditampilkan sekali dan tidak bisa dilihat lagi.',
      })
    } catch (e) {
      console.error('[SA] ApiKeys create error:', e)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
)

// DELETE /api/sa/tenants/:id/api-keys/:keyId — revoke (idempoten, tenant-scoped)
router.delete('/tenants/:id/api-keys/:keyId', ...sa, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    const keyId = parseInt(req.params.keyId, 10)
    if (!Number.isFinite(id) || !Number.isFinite(keyId)) return res.status(404).json({ error: 'Key tidak ditemukan' })
    const tenant = await prisma.tenant.findUnique({ where: { id }, select: { id: true, name: true } })
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' })
    const row = await prisma.apiKey.findFirst({ where: { id: keyId, tenantId: id } })
    if (!row) return res.status(404).json({ error: 'Key tidak ditemukan' })
    if (row.revokedAt) return res.json({ ok: true, alreadyRevoked: true })
    await apiKeys.revoke(row.id)
    console.log(`[SA] API key #${row.id} tenant #${id} (${tenant.name}) di-revoke by @${req.user.username}`)
    await saAudit.audit(req.user, 'api_key_revoke', id, tenant.name, { keyId: row.id, name: row.name, prefix: row.prefix })
    res.json({ ok: true })
  } catch (e) {
    console.error('[SA] ApiKeys revoke error:', e)
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
    void systemLog.logError(`Impersonate tenant #${parseInt(req.params.tenantId, 10) || '?'} error`, { module: 'tenant', tenantId: parseInt(req.params.tenantId, 10) || null, err: e })
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ═══════════════════════ v3.9.19 — BRANDING PLATFORM (additive murni) ═══════════════════════
// brandName GLOBAL platform (sidebar superadmin). Spec §7 bilang "disimpan AppConfig",
// TAPI AppConfig TIDAK punya kolom brandName dan ZERO-migration ter-locked (§9) —
// jadi disimpan di SaAuditLog (row permanen, TIDAK pernah di-purge — spec §2; tidak
// pernah dihapus siapa pun, queryable findFirst). Penyimpanan via audit() = trail
// platform_branding ikut tercatat (audit memang wajib utk aksi SA).
// NOTE utk Alita/audit round-3: ini DEVIASI KECIL dari spec (AppConfig → SaAuditLog)
// dgn alasan zero-migration; endpoint shape tetap { brandName } seperti spec.
const PLATFORM_BRAND_ACTION = 'platform_branding'

// GET /api/sa/platform-branding — { brandName } (null/absen = default "ChatBareng")
router.get('/platform-branding', ...sa, async (req, res) => {
  try {
    const row = await prisma.saAuditLog.findFirst({
      where: { action: PLATFORM_BRAND_ACTION },
      orderBy: { id: 'desc' },
    })
    let brandName = null
    if (row?.detailJson) {
      try { brandName = JSON.parse(row.detailJson)?.brandName ?? null } catch { brandName = null }
    }
    res.json({ brandName: brandName || null })
  } catch (e) {
    console.error('[SA] Platform branding GET error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/sa/platform-branding — JSON { brandName }: 2-50 char ATAU "" (reset ke default)
router.put('/platform-branding', ...sa, async (req, res) => {
  try {
    const bn = String(req.body?.brandName ?? '').trim()
    if (bn.length > 0 && (bn.length < 2 || bn.length > 50)) {
      return res.status(400).json({ error: 'brandName harus 2-50 karakter (atau "" untuk reset)' })
    }
    const applied = bn === '' ? null : bn
    // detail key = brandName (GET /platform-branding membaca detailJson.brandName —
    // harus konsisten; jangan pakai key lain, lesson #4 post-verify data beneran).
    await saAudit.audit(req.user, PLATFORM_BRAND_ACTION, null, null, {
      platformBrand: applied,
      brandName: applied, // key yg dibaca GET /platform-branding (sinkron!)
      reset: bn === '',
    })
    res.json({ brandName: applied })
  } catch (e) {
    console.error('[SA] Platform branding PUT error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ═══════════════════════ v3.9.23 — AI ASSISTANT (Ollama Cloud, additive murni) ═══════════════════════
// Spec docs/spec-v3.9.23-ai-summary.md §C. Key TIDAK PERNAH full ke response —
// hanya hasKey + keyMasked (last4). PUT apiKey null/absent = keep. Disimpan
// ENCRYPTED (textCrypto.encryptText, pola ciphertext pesan). Audit TANPA secret.
const llmService = require('../services/llm')
const { encryptText } = require('../services/textCrypto')

const AI_KEY_MIN = 20
// Anti-injection utk nama model (spec §C5): aman utk spawn `ollama pull` juga.
const AI_MODEL_RE = /^[a-zA-Z0-9._:\-\/]+$/
const AI_BASEURL_RE = /^https?:\/\//i

function maskKey(key) {
  if (!key || typeof key !== 'string') return null
  return '••••' + key.slice(-4)
}

/** Response shape GET/PUT ai-config (key TIDAK PERNAH full). */
function aiConfigJson(cfg) {
  return {
    cloudBaseUrl: cfg?.cloudBaseUrl || llmService.DEFAULT_CLOUD_BASE_URL,
    cloudModel: cfg?.cloudModel || llmService.DEFAULT_CLOUD_MODEL,
    hasKey: !!cfg?.apiKey,
    keyMasked: cfg?.apiKey ? maskKey(cfg.apiKey) : null,
    localBaseUrl: cfg?.localBaseUrl || llmService.DEFAULT_LOCAL_BASE_URL,
    localModel: cfg?.localModel || null,
    fallbackEnabled: !!cfg?.fallbackEnabled,
    defaultPreset: cfg?.defaultPreset || 'standard',
  }
}

// GET /api/sa/ai-config — { cloudBaseUrl, cloudModel, hasKey, keyMasked, localBaseUrl,
// localModel, fallbackEnabled, defaultPreset } (row belum ada → default, hasKey false)
router.get('/ai-config', ...sa, async (req, res) => {
  try {
    const cfg = await llmService.getAiConfig()
    res.json(aiConfigJson(cfg))
  } catch (e) {
    console.error('[SA] ai-config GET error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/sa/ai-config — body {cloudBaseUrl?, cloudModel?, apiKey?|null(=keep),
// localBaseUrl?, localModel?, fallbackEnabled?, defaultPreset?} → response shape GET.
// apiKey string ≥20 char (disimpan ENCRYPTED); null/undefined = keep; '' = hapus key.
router.put('/ai-config', ...sa, async (req, res) => {
  try {
    const b = req.body || {}
    const data = {}
    if (b.cloudBaseUrl !== undefined) {
      const u = String(b.cloudBaseUrl).trim().replace(/\/+$/, '')
      if (u && !AI_BASEURL_RE.test(u)) return res.status(400).json({ error: 'cloudBaseUrl harus diawali http(s)://' })
      if (u && u.length > 200) return res.status(400).json({ error: 'cloudBaseUrl maksimal 200 karakter' })
      if (u) data.cloudBaseUrl = u
    }
    if (b.cloudModel !== undefined) {
      const m = String(b.cloudModel).trim()
      if (!m) return res.status(400).json({ error: 'cloudModel tidak boleh kosong' })
      if (!AI_MODEL_RE.test(m)) return res.status(400).json({ error: 'Format model tidak valid' })
      if (m.length > 100) return res.status(400).json({ error: 'cloudModel maksimal 100 karakter' })
      data.cloudModel = m
    }
    if (b.localBaseUrl !== undefined) {
      const u = String(b.localBaseUrl).trim().replace(/\/+$/, '')
      if (u && !AI_BASEURL_RE.test(u)) return res.status(400).json({ error: 'localBaseUrl harus diawali http(s)://' })
      if (u && u.length > 200) return res.status(400).json({ error: 'localBaseUrl maksimal 200 karakter' })
      if (u) data.localBaseUrl = u
    }
    if (b.localModel !== undefined) {
      const m = b.localModel == null ? '' : String(b.localModel).trim()
      if (m && !AI_MODEL_RE.test(m)) return res.status(400).json({ error: 'Format model lokal tidak valid' })
      if (m.length > 100) return res.status(400).json({ error: 'localModel maksimal 100 karakter' })
      data.localModel = m || null
    }
    if (b.fallbackEnabled !== undefined) {
      if (typeof b.fallbackEnabled !== 'boolean') return res.status(400).json({ error: 'fallbackEnabled harus boolean' })
      data.fallbackEnabled = b.fallbackEnabled
    }
    if (b.defaultPreset !== undefined) {
      const p = String(b.defaultPreset).trim()
      if (!llmService.PRESET_KEYS.includes(p)) {
        return res.status(400).json({ error: `defaultPreset harus salah satu: ${llmService.PRESET_KEYS.join(', ')}` })
      }
      data.defaultPreset = p
    }
    let keyStored = false
    let keyCleared = false
    if (b.apiKey !== undefined && b.apiKey !== null) {
      const k = String(b.apiKey)
      if (k.trim() === '') {
        data.apiKeyEnc = null // eksplisit hapus key
        keyCleared = true
      } else if (k.length < AI_KEY_MIN) {
        return res.status(400).json({ error: `API key minimal ${AI_KEY_MIN} karakter` })
      } else {
        data.apiKeyEnc = encryptText(k) // ENCRYPTED — pola ciphertext pesan
        keyStored = true
      }
    }
    const updated = await prisma.aiConfig.upsert({
      where: { id: 1 },
      update: data,
      create: { id: 1, ...data },
    })
    console.log(`[SA] ai-config diupdate by @${req.user.username}: keys=${Object.keys(data).filter((k) => k !== 'apiKeyEnc').join(',') || '-'} apiKey=${keyStored ? 'diganti' : keyCleared ? 'dihapus' : 'keep'} (plaintext TIDAK di-log)`)
    await saAudit.audit(req.user, 'ai_config_update', null, null, {
      cloudBaseUrl: updated.cloudBaseUrl,
      cloudModel: updated.cloudModel,
      hasKey: !!updated.apiKeyEnc,
      localBaseUrl: updated.localBaseUrl,
      localModel: updated.localModel || null,
      fallbackEnabled: !!updated.fallbackEnabled,
      defaultPreset: updated.defaultPreset,
      keyAction: keyStored ? 'set' : keyCleared ? 'clear' : 'keep',
    })
    const cfg = await llmService.getAiConfig()
    res.json(aiConfigJson(cfg))
  } catch (e) {
    console.error('[SA] ai-config PUT error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/sa/ai-config/test — body {baseUrl?, apiKey?|null(=stored), model?}
// → aiTestConnection: {ok, latencyMs, model} / {ok:false, code, message}.
router.post('/ai-config/test', ...sa, async (req, res) => {
  try {
    const b = req.body || {}
    const cfg = await llmService.getAiConfig()
    const baseUrl = String(b.baseUrl || cfg?.cloudBaseUrl || llmService.DEFAULT_CLOUD_BASE_URL).trim().replace(/\/+$/, '')
    if (!AI_BASEURL_RE.test(baseUrl)) return res.status(400).json({ error: 'baseUrl harus diawali http(s)://' })
    // apiKey kosong/null/absent = pakai key stored (TIDAK pernah di-echo balik).
    let apiKey = typeof b.apiKey === 'string' && b.apiKey.trim() ? b.apiKey : cfg?.apiKey || null
    if (typeof b.apiKey === 'string' && b.apiKey.trim() && b.apiKey.length < AI_KEY_MIN) {
      return res.status(400).json({ error: `API key minimal ${AI_KEY_MIN} karakter` })
    }
    const model = String(b.model || cfg?.cloudModel || llmService.DEFAULT_CLOUD_MODEL).trim()
    if (!AI_MODEL_RE.test(model)) return res.status(400).json({ error: 'Format model tidak valid' })
    const r = await llmService.aiTestConnection({ baseUrl, apiKey, model })
    await saAudit.audit(req.user, 'ai_config_test', null, null, { baseUrl, model, ok: !!r.ok, code: r.code || null, latencyMs: r.latencyMs ?? null })
    res.json(r)
  } catch (e) {
    console.error('[SA] ai-config test error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/sa/ai-config/models?scope=cloud|local — proxy daftar model.
// Cloud: pakai stored key. Local: tanpa key. Response {models:[{name,sizeBytes}]} / {error, code}.
router.get('/ai-config/models', ...sa, async (req, res) => {
  try {
    const scope = req.query.scope === 'local' ? 'local' : 'cloud'
    const cfg = await llmService.getAiConfig()
    const baseUrl = scope === 'local'
      ? String(req.query.baseUrl || cfg?.localBaseUrl || llmService.DEFAULT_LOCAL_BASE_URL).trim()
      : String(req.query.baseUrl || cfg?.cloudBaseUrl || llmService.DEFAULT_CLOUD_BASE_URL).trim()
    if (!AI_BASEURL_RE.test(baseUrl)) return res.status(400).json({ error: 'baseUrl tidak valid' })
    const apiKey = scope === 'local' ? null : cfg?.apiKey || null
    if (scope === 'cloud' && !apiKey) return res.status(400).json({ error: 'API key belum diisi — simpan key dulu.', code: 'NO_CONFIG' })
    const r = await llmService.aiListModels({ baseUrl, apiKey })
    if (!r.ok) return res.status(400).json({ error: r.message, code: r.code })
    res.json({ models: r.models })
  } catch (e) {
    console.error('[SA] ai-config models error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/sa/ai-config/local-pull — body {model}. Cek binary `ollama` ada dulu
// (spawn which) → 400 kalau tidak ada. Ada → spawn DETACHED `ollama pull <model>`
// log /tmp/cb_ai_pull.log, response {started:true}. JANGAN auto-download.
router.post('/ai-config/local-pull', ...sa, async (req, res) => {
  const { execFile, spawn } = require('child_process')
  try {
    const model = String(req.body?.model || '').trim()
    if (!model) return res.status(400).json({ error: 'model wajib diisi' })
    if (!AI_MODEL_RE.test(model) || model.length > 100) {
      return res.status(400).json({ error: 'Format nama model tidak valid' })
    }
    execFile('which', ['ollama'], (err, stdout) => {
      if (err || !String(stdout || '').trim()) {
        return res.status(400).json({ error: 'Ollama binary tidak ditemukan di host ini' })
      }
      // spawn DETACHED — pull lanjut di background walau request/response selesai.
      try {
        const out = fs.openSync('/tmp/cb_ai_pull.log', 'a')
        const child = spawn('ollama', ['pull', model], {
          detached: true,
          stdio: ['ignore', out, out],
        })
        child.unref()
        console.log(`[SA] ollama pull "${model}" started (pid ${child.pid}) by @${req.user.username} — log /tmp/cb_ai_pull.log`)
        saAudit.audit(req.user, 'ai_config_pull', null, null, { model, pid: child.pid })
        return res.json({ started: true, model })
      } catch (spawnErr) {
        console.error('[SA] ai-config local-pull spawn error:', spawnErr)
        return res.status(500).json({ error: 'Gagal memulai unduhan model' })
      }
    })
  } catch (e) {
    console.error('[SA] ai-config local-pull error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ═══════════════ v3.9.24 — AI USAGE + AI RATES (additive murni, guard ...sa) ═══════════════
// Spec docs/spec-v3.9.24-ai-usage.md §5. Snapshot per-call di AiUsageLog — edit rate
// TIDAK PERNAH mengubah histori (D3). Key/token tidak pernah masuk response/audit.

// PUT /api/sa/ai-rates → replace-all transaksional (pilihan desain: hapus-then-insert —
// paling sederhana & aman; FE selalu kirim daftar penuh hasil edit, "hapus row" =
// kirim daftar tanpa row itu; DELETE endpoint tetap ada utk hapus eksplisit 1 model).
const AI_RATE_MODEL_RE = /^[a-zA-Z0-9._:\-\/]+$/
const AI_RATES_MAX_ROWS = 100

/** Validasi + normalisasi 1 row rate. → {row} | {error}. */
function parseAiRateRow(raw, idx) {
  const model = String(raw?.model ?? '').trim()
  if (!model) return { error: `rates[${idx}].model wajib diisi` }
  if (model.length > 64 || !AI_RATE_MODEL_RE.test(model)) {
    return { error: `rates[${idx}].model tidak valid (1-64 char; huruf/angka/._:-/)` }
  }
  const inputPerM = Number(raw?.inputPerM)
  const outputPerM = Number(raw?.outputPerM)
  if (!Number.isFinite(inputPerM) || inputPerM < 0) return { error: `rates[${idx}].inputPerM harus angka >= 0` }
  if (!Number.isFinite(outputPerM) || outputPerM < 0) return { error: `rates[${idx}].outputPerM harus angka >= 0` }
  let cachedPerM = null // null/''/absent = pakai rate input (D7)
  if (raw?.cachedPerM !== undefined && raw?.cachedPerM !== null && String(raw.cachedPerM).trim() !== '') {
    const c = Number(raw.cachedPerM)
    if (!Number.isFinite(c) || c < 0) return { error: `rates[${idx}].cachedPerM harus angka >= 0 (kosong = pakai input)` }
    cachedPerM = c
  }
  return { row: { model, inputPerM, cachedPerM, outputPerM } }
}

async function aiUsdToIdr() {
  const cfg = await prisma.aiConfig.findUnique({ where: { id: 1 } })
  const v = Number(cfg?.usdToIdr)
  return Number.isFinite(v) && v > 0 ? v : 16000
}

// GET /api/sa/ai-usage?range=today|7d|30d|all (default 7d) — dashboard panel SA.
// perDay = sumbu tanggal WIB penuh (pola v3.9.20, zero-filled); perTenant hanya row
// ber-tenant (source test tidak masuk); avgLatencyMs hanya row ok=true + latency ada.
router.get('/ai-usage', ...sa, async (req, res) => {
  try {
    const raw = String(req.query.range || '7d').toLowerCase()
    if (!['today', '7d', '30d', 'all'].includes(raw)) {
      return res.status(400).json({ error: 'range harus today|7d|30d|all' })
    }
    const range = raw === 'today' ? { days: 1, label: 'today' }
      : raw === '7d' ? { days: 7, label: '7d' }
      : raw === '30d' ? { days: 30, label: '30d' }
      : { days: null, label: 'all' }
    const { sinceIso, dates } = await saStatsWindow(range)
    const conds = []
    const params = []
    if (sinceIso != null) { conds.push('"createdAt" >= ?'); params.push(new Date(sinceIso)) }
    const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    // AiUsageLog.createdAt tersimpan INTEGER ms epoch (pola DateTime SQLite repo)
    // → grouping strftime('/1000','unixepoch','+07:00') = WIB, pola v3.9.20.
    const [totRows, dayRows, tenRows, untrRows] = await Promise.all([
      prisma.$queryRawUnsafe(`
        SELECT COUNT(*) AS calls,
               COALESCE(SUM("promptTokens" + "cachedTokens" + "outputTokens"), 0) AS tokens,
               COALESCE(SUM("costUsd"), 0) AS costUsd,
               AVG(CASE WHEN "ok" = 1 AND "latencyMs" IS NOT NULL THEN "latencyMs" END) AS avgLatency,
               SUM(CASE WHEN "ok" = 0 THEN 1 ELSE 0 END) AS errors,
               SUM(CASE WHEN "viaFallback" = 1 THEN 1 ELSE 0 END) AS fallbacks,
               COALESCE(SUM("wouldCostUsd"), 0) AS fallbackSavedUsd
        FROM AiUsageLog ${whereSql}
      `, ...params),
      prisma.$queryRawUnsafe(`
        SELECT strftime('%Y-%m-%d', "createdAt"/1000, 'unixepoch', '+07:00') AS day,
               COUNT(*) AS calls, COALESCE(SUM("costUsd"), 0) AS costUsd
        FROM AiUsageLog ${whereSql}
        GROUP BY day ORDER BY day ASC
      `, ...params),
      prisma.$queryRawUnsafe(`
        SELECT l."tenantId" AS tenantId, t."name" AS name,
               COUNT(*) AS calls,
               COALESCE(SUM(l."promptTokens" + l."cachedTokens" + l."outputTokens"), 0) AS tokens,
               COALESCE(SUM(l."costUsd"), 0) AS costUsd,
               MAX(l."createdAt") AS lastUsedAt
        FROM AiUsageLog l LEFT JOIN Tenant t ON t."id" = l."tenantId"
        ${conds.length ? 'WHERE l."createdAt" >= ? AND l."tenantId" IS NOT NULL' : 'WHERE l."tenantId" IS NOT NULL'}
        GROUP BY l."tenantId", t."name" ORDER BY costUsd DESC, l."tenantId" ASC
      `, ...params),
      // untracked = distinct model dgn costUsd NULL di range (hanya ok=true —
      // row gagal cost=0, bukan untracked, D4)
      prisma.$queryRawUnsafe(`
        SELECT DISTINCT "model" AS model FROM AiUsageLog
        WHERE ${conds.length ? conds.join(' AND ') + ' AND ' : ''}"costUsd" IS NULL AND "ok" = 1
        ORDER BY model ASC
      `, ...params),
    ])
    const t = totRows[0] || {}
    const dayMap = new Map(dayRows.map((r) => [String(r.day), r]))
    res.json({
      usdToIdr: await aiUsdToIdr(),
      totals: {
        calls: Number(t.calls) || 0,
        tokens: Number(t.tokens) || 0,
        costUsd: Number(t.costUsd) || 0,
        avgLatencyMs: t.avgLatency == null ? null : Math.round(Number(t.avgLatency)),
        errors: Number(t.errors) || 0,
        fallbacks: Number(t.fallbacks) || 0,
        fallbackSavedUsd: Number(t.fallbackSavedUsd) || 0,
      },
      perDay: dates.map((d) => {
        const r = dayMap.get(d)
        return { date: d, calls: Number(r?.calls) || 0, costUsd: Number(r?.costUsd) || 0 }
      }),
      perTenant: tenRows.map((r) => ({
        tenantId: Number(r.tenantId),
        name: r.name || `Tenant #${r.tenantId}`,
        calls: Number(r.calls) || 0,
        tokens: Number(r.tokens) || 0,
        costUsd: Number(r.costUsd) || 0,
        lastUsedAt: r.lastUsedAt == null ? null : new Date(Number(r.lastUsedAt)).toISOString(),
      })),
      untrackedModels: untrRows.map((r) => String(r.model)),
    })
  } catch (e) {
    console.error('[SA] ai-usage GET error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/sa/ai-rates — { usdToIdr, rates: [{model, inputPerM, cachedPerM, outputPerM, updatedAt}] }
router.get('/ai-rates', ...sa, async (req, res) => {
  try {
    const rows = await prisma.aiModelRate.findMany({ orderBy: { model: 'asc' } })
    res.json({
      usdToIdr: await aiUsdToIdr(),
      rates: rows.map((r) => ({
        model: r.model,
        inputPerM: r.inputPerM,
        cachedPerM: r.cachedPerM,
        outputPerM: r.outputPerM,
        updatedAt: r.updatedAt,
      })),
    })
  } catch (e) {
    console.error('[SA] ai-rates GET error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/sa/ai-rates — body { usdToIdr?, rates: [...] } (rates undefined = keep;
// array = replace-all transaksional). Validasi: model regex 1..64 char, angka finite
// >= 0, usdToIdr > 0, maks 100 row. Audit ai_rates_update (jumlah row, TANPA key/token).
router.put('/ai-rates', ...sa, async (req, res) => {
  try {
    const b = req.body || {}
    let usdUpdated = null
    if (b.usdToIdr !== undefined && b.usdToIdr !== null) {
      const v = Number(b.usdToIdr)
      if (!Number.isFinite(v) || v <= 0) return res.status(400).json({ error: 'usdToIdr harus angka > 0' })
      usdUpdated = v
    }
    let rows = null
    if (b.rates !== undefined && b.rates !== null) {
      if (!Array.isArray(b.rates)) return res.status(400).json({ error: 'rates harus array' })
      if (b.rates.length > AI_RATES_MAX_ROWS) {
        return res.status(400).json({ error: `rates maksimal ${AI_RATES_MAX_ROWS} row` })
      }
      rows = []
      const seen = new Set()
      for (let i = 0; i < b.rates.length; i++) {
        const parsed = parseAiRateRow(b.rates[i], i)
        if (parsed.error) return res.status(400).json({ error: parsed.error })
        if (seen.has(parsed.row.model)) return res.status(400).json({ error: `rates: model duplikat "${parsed.row.model}"` })
        seen.add(parsed.row.model)
        rows.push(parsed.row)
      }
    }
    if (usdUpdated != null) {
      await prisma.aiConfig.upsert({
        where: { id: 1 },
        update: { usdToIdr: usdUpdated },
        create: { id: 1, usdToIdr: usdUpdated },
      })
    }
    if (rows != null) {
      await prisma.$transaction(async (tx) => {
        await tx.aiModelRate.deleteMany({})
        if (rows.length) {
          await tx.aiModelRate.createMany({
            data: rows.map((r) => ({ ...r, updatedById: req.user?.id ?? null })),
          })
        }
      })
    }
    await saAudit.audit(req.user, 'ai_rates_update', null, null, {
      rateCount: rows == null ? null : rows.length,
      usdToIdr: usdUpdated, // null = tidak diubah
    })
    const saved = await prisma.aiModelRate.findMany({ orderBy: { model: 'asc' } })
    res.json({
      usdToIdr: await aiUsdToIdr(),
      rates: saved.map((r) => ({
        model: r.model,
        inputPerM: r.inputPerM,
        cachedPerM: r.cachedPerM,
        outputPerM: r.outputPerM,
        updatedAt: r.updatedAt,
      })),
    })
  } catch (e) {
    console.error('[SA] ai-rates PUT error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/sa/ai-rates/:model — hapus 1 rate (model jadi untracked, D4).
// Audit ai_rates_delete. 404 bila model tidak ada.
router.delete('/ai-rates/:model', ...sa, async (req, res) => {
  try {
    const model = String(req.params.model || '').trim()
    if (!model || model.length > 64 || !AI_RATE_MODEL_RE.test(model)) {
      return res.status(400).json({ error: 'Format model tidak valid' })
    }
    const existing = await prisma.aiModelRate.findUnique({ where: { model } })
    if (!existing) return res.status(404).json({ error: 'Rate model tidak ditemukan' })
    await prisma.aiModelRate.delete({ where: { model } })
    await saAudit.audit(req.user, 'ai_rates_delete', null, null, { model })
    res.json({ deleted: model })
  } catch (e) {
    console.error('[SA] ai-rates DELETE error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ═══════════════ v4.6.4 — SUPERADMIN SYSTEM LOG (spec §D4, additive murni) ═══════════════
// Log diagnostik lintas-tenant — SUPERADMIN ONLY (semua route di bawah ini memakai
// middleware `sa` yang sudah ada). TIDAK ADA endpoint create/update/delete manual:
// data hanya masuk via capture (services/systemLog.js) dan keluar via auto-prune.

// Builder filter bersama utk list/export (identik dgn spec D4)
function buildSystemLogWhere(req) {
  const where = {}
  if (req.query.level) {
    const levels = String(req.query.level).split(',').map((s) => s.trim()).filter(Boolean)
    if (levels.length) where.level = { in: levels }
  }
  const moduleF = String(req.query.module || '').trim()
  if (moduleF && systemLog.MODULES.includes(moduleF)) where.module = moduleF
  const tenantF = parseInt(String(req.query.tenantId || ''), 10)
  if (Number.isFinite(tenantF) && tenantF > 0) where.tenantId = tenantF
  const q = String(req.query.q || '').trim()
  if (q) where.message = { contains: q.slice(0, 200) }
  const from = new Date(String(req.query.from || ''))
  if (!Number.isNaN(from.getTime())) where.ts = { ...(where.ts || {}), gte: from }
  const to = new Date(String(req.query.to || ''))
  if (!Number.isNaN(to.getTime())) where.ts = { ...(where.ts || {}), lte: to }
  return where
}

function wibStampForFilename(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d)
  const get = (t) => parts.find((p) => p.type === t)?.value || ''
  return `${get('year')}${get('month')}${get('day')}-${get('hour')}${get('minute')}`
}

/** CSV cell — quote semua + escape " → "" (SQL/CSV-injection aman by construction). */
function logCsvCell(v) {
  if (v === null || v === undefined) return '""'
  return '"' + String(v).replace(/"/g, '""') + '"'
}

// GET /api/sa/system-logs — list ringkas + filter + cursor pagination (id desc)
// Response tanpa stack/metaJson (detail via :id — payload list tetap ramping).
router.get('/system-logs', ...sa, async (req, res) => {
  try {
    const limitRaw = parseInt(String(req.query.limit || '100'), 10)
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 100, 1), 500)
    const cursorRaw = parseInt(String(req.query.cursor || ''), 10)
    const where = buildSystemLogWhere(req)
    const findOpts = {
      where,
      orderBy: { id: 'desc' },
      take: limit,
      select: {
        id: true, ts: true, level: true, source: true, module: true,
        tenantId: true, tenantName: true, appVersion: true, message: true,
      },
    }
    if (Number.isFinite(cursorRaw) && cursorRaw > 0) {
      findOpts.cursor = { id: cursorRaw }
      findOpts.skip = 1 // mulai SETELAH id cursor
    }
    const rows = await prisma.systemLog.findMany(findOpts)
    res.json({ items: rows, nextCursor: rows.length === limit ? rows[rows.length - 1].id : null })
  } catch (e) {
    console.error('[SA] system-logs list error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/sa/system-logs/stats — ringkasan 24 jam (strip atas UI, spec D4 bonus)
// WAJIB terdaftar SEBELUM /:id — 'stats' bukan id.
router.get('/system-logs/stats', ...sa, async (req, res) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const [byLevel, byModule, byTenant] = await Promise.all([
      prisma.systemLog.groupBy({ by: ['level'], where: { ts: { gte: since } }, _count: { _all: true } }),
      prisma.systemLog.groupBy({ by: ['module'], where: { ts: { gte: since } }, _count: { _all: true } }),
      prisma.systemLog.groupBy({
        by: ['tenantId', 'tenantName'],
        where: { ts: { gte: since }, tenantId: { not: null } },
        _count: { _all: true },
        orderBy: { _count: { tenantId: 'desc' } },
        take: 5,
      }),
    ])
    res.json({
      windowHours: 24,
      byLevel: byLevel.map((r) => ({ level: r.level, count: r._count._all })),
      byModule: byModule.map((r) => ({ module: r.module, count: r._count._all })),
      topTenants: byTenant.map((r) => ({ tenantId: r.tenantId, tenantName: r.tenantName, count: r._count._all })),
    })
  } catch (e) {
    console.error('[SA] system-logs stats error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/sa/system-logs/export — CSV dgn filter identik list; cap 10.000 row
// terbaru sesuai filter (tidak mem-bombak memori). Redaksi sudah TERJADI SAAT INGEST
// → CSV aman by construction; kolom stack/meta di-CSV-quote (escape " → "").
router.get('/system-logs/export', ...sa, async (req, res) => {
  try {
    const where = buildSystemLogWhere(req)
    const rows = await prisma.systemLog.findMany({
      where,
      orderBy: { id: 'desc' },
      take: 10000, // cap spec D4
    })
    const header = ['id', 'ts', 'level', 'source', 'module', 'tenantId', 'tenantName', 'appVersion', 'message', 'stack', 'metaJson']
    const lines = [header.join(',')]
    for (const r of rows) {
      lines.push([
        r.id,
        r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
        r.level, r.source, r.module,
        r.tenantId == null ? '' : r.tenantId,
        r.tenantName == null ? '' : r.tenantName,
        r.appVersion == null ? '' : r.appVersion,
        r.message,
        r.stack === null || r.stack === undefined ? '' : JSON.stringify(r.stack),
        r.metaJson === null || r.metaJson === undefined ? '' : JSON.stringify(r.metaJson),
      ].map(logCsvCell).join(','))
    }
    const filename = `system-log-${wibStampForFilename()}.csv`
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(lines.join('\n'))
  } catch (e) {
    console.error('[SA] system-logs export error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/sa/system-logs/:id — detail lengkap (stack + metaJson). Terdaftar TERAKHIR
// di kelompok ini (stats/export sudah di atas — 'stats' tidak tertelan sbg :id).
router.get('/system-logs/:id', ...sa, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' })
    const row = await prisma.systemLog.findUnique({ where: { id } })
    if (!row) return res.status(404).json({ error: 'Log tidak ditemukan (mungkin sudah di-prune retensi)' })
    res.json({ item: row })
  } catch (e) {
    console.error('[SA] system-logs detail error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router