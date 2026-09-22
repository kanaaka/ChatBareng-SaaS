const express = require('express')
const router = express.Router()
const prisma = require('../prisma')
const { requireAuth, requireAdmin, requireTenant, hashPassword } = require('../auth')

// v3.0 — Isolasi tenant: manajemen user = per-tenant (super_admin tidak muncul;
// create user selalu tenant admin; transfer lintas tenant → 403).
const rt = [requireAuth, requireTenant]
const { createUserValidation, updateUserValidation } = require('../utils/validation')
const { validationResult } = require('express-validator')
const presence = require('../socket/presence')

// GET /api/users (admin only — full list with roles, status, etc)
router.get('/', ...rt, requireAdmin, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: { tenantId: req.tenantId, role: { not: 'super_admin' } },
      select: { id: true, username: true, role: true, status: true, createdAt: true, lastLogin: true },
      orderBy: { createdAt: 'desc' },
    })
    res.json({ users })
  } catch (e) {
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/users/agents (any authenticated user — for transfer dropdown)
// v0.5.0 — hanya user ONLINE (presence) + exclude requester sendiri + field role.
// Admin = safety valve: boleh lihat SEMUA active user (dengan flag online per entry)
// supaya bisa reassign paksa chat nyangkut ke user offline.
router.get('/agents', ...rt, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: { status: 'active', tenantId: req.tenantId, role: { not: 'super_admin' } },
      select: { id: true, username: true, role: true },
      orderBy: { username: 'asc' },
    })
    const onlineUserIds = presence.getOnlineUserIds(req.tenantId)
    const onlineSet = new Set(onlineUserIds)
    let entries = users
      .filter(u => u.id !== req.user.id) // exclude self
      .filter(u => (req.user.role === 'admin') ? true : onlineSet.has(u.id)) // non-admin: online only
      .map(u => ({ id: u.id, username: u.username, role: u.role, online: onlineSet.has(u.id) }))
    res.json({ users: entries, onlineUserIds })
  } catch (e) {
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/users/online — sinkron awal presence (spec Fitur 2 poin 18, opsional)
router.get('/online', ...rt, async (req, res) => {
  try {
    res.json({ onlineUserIds: presence.getOnlineUserIds(req.tenantId) })
  } catch (e) {
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/users (admin only)
router.post('/', ...rt, requireAdmin, createUserValidation, async (req, res) => {
  try {
    // v0.5.0 — validationResult sebelumnya tidak pernah di-consume (dead check di
    // auth.js pakai req.validationErrors yang tidak pernah di-set express-validator 7)
    // → validasi role (termasuk 'relay') baru benar-benar di-enforce sekarang.
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0]?.msg || 'Validation failed', errors: errors.array() })
    }

    const { username, password, role } = req.body
    
    const existing = await prisma.user.findUnique({ where: { username } })
    if (existing) {
      return res.status(409).json({ error: 'Username already exists' })
    }
    
    const passwordHash = await hashPassword(password)
    const user = await prisma.user.create({
      data: { username, passwordHash, role, tenantId: req.tenantId },
      select: { id: true, username: true, role: true, status: true, createdAt: true },
    })
    
    res.status(201).json({ user })
  } catch (e) {
    console.error('Create user error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/users/:id (admin only)
router.put('/:id', ...rt, requireAdmin, updateUserValidation, async (req, res) => {
  try {
    // v0.5.0 — sama seperti POST: consume validationResult agar role invalid ditolak
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0]?.msg || 'Validation failed', errors: errors.array() })
    }

    const id = parseInt(req.params.id, 10)
    const { role, status, password } = req.body
    
    // v0.3.5: admin gak boleh menonaktifkan dirinya sendiri (cegah lockout)
    if (id === req.user.id && status === 'inactive') {
      return res.status(400).json({ error: 'Cannot deactivate yourself' })
    }
    
    const data = {}
    if (role) data.role = role
    if (status) data.status = status
    if (password) data.passwordHash = await hashPassword(password)
    
    // v3 — target harus satu tenant (lintas tenant → 403); super_admin tidak bisa diubah dari sini
    const target = await prisma.user.findFirst({ where: { id, tenantId: req.tenantId, role: { not: 'super_admin' } } })
    if (!target) return res.status(403).json({ error: 'User tidak ditemukan di tenant ini' })
    const user = await prisma.user.update({
      where: { id },
      data,
      select: { id: true, username: true, role: true, status: true },
    })
    
    res.json({ user })
  } catch (e) {
    console.error('Update user error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/users/:id (admin only — v0.3.5: HARD delete dengan reassign kepemilikan data)
router.delete('/:id', ...rt, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    
    if (id === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete yourself' })
    }
    
    const user = await prisma.user.findFirst({ where: { id, tenantId: req.tenantId, role: { not: 'super_admin' } } })
    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }
    
    // Hard delete, tapi riwayat data dipertahankan (SEMUA updateMany tenant-scoped):
    // - FK nullable (chat assignment, sender, events) → detach (set null)
    // - Join read-only (reads, favorites) → hapus barisnya
    // - Kepemilikan aset (blast, announcement, shared file, purge log, template) → transfer ke admin yang men-delete
    const tid = req.tenantId
    await prisma.$transaction([
      prisma.chat.updateMany({ where: { tenantId: tid, assignedToId: id }, data: { assignedToId: null } }),
      prisma.chat.updateMany({ where: { tenantId: tid, firstResponseById: id }, data: { firstResponseById: null } }),
      prisma.chat.updateMany({ where: { tenantId: tid, resolvedById: id }, data: { resolvedById: null } }),
      prisma.message.updateMany({ where: { tenantId: tid, senderId: id }, data: { senderId: null } }),
      prisma.chatEvent.updateMany({ where: { tenantId: tid, userId: id }, data: { userId: null } }),
      prisma.tag.updateMany({ where: { tenantId: tid, createdBy: id }, data: { createdBy: null } }),
      prisma.sharedFolder.updateMany({ where: { tenantId: tid, createdBy: id }, data: { createdBy: null } }),
      prisma.announcementRead.deleteMany({ where: { userId: id } }),
      prisma.favoriteMessage.deleteMany({ where: { userId: id } }),
      // v0.4.2 hotfix: PushSubscription non-nullable (user User) — kalau CS pernah
      // aktifin notif push, baris ini bikin P2003 FK violation saat user.delete
      prisma.pushSubscription.deleteMany({ where: { userId: id } }),
      prisma.blast.updateMany({ where: { tenantId: tid, createdBy: id }, data: { createdBy: req.user.id } }),
      prisma.announcement.updateMany({ where: { tenantId: tid, createdById: id }, data: { createdById: req.user.id } }),
      prisma.sharedFile.updateMany({ where: { tenantId: tid, uploadedBy: id }, data: { uploadedBy: req.user.id } }),
      prisma.purgeLog.updateMany({ where: { tenantId: tid, purgedById: id }, data: { purgedById: req.user.id } }),
      prisma.messageTemplate.updateMany({ where: { tenantId: tid, createdBy: id }, data: { createdBy: req.user.id } }),
      // v3.1.3 hotfix: 4 relasi User WAJIB yang kelewat (pola P2003 — sama dgn wa-cs-hub
      // v0.4.2 fina & v0.15.3 oslo/magetan): nambah fitur = nambah relasi, transaksi
      // delete WAJIB di-update juga.
      // - ChatNote.userId (non-nullable) → dipindah ke admin (riwayat tetap)
      // - ScheduledMessage.createdById (non-nullable) → dipindah ke admin
      // - GDriveLink.user @unique (non-nullable, kredensial terenkripsi) → hapus
      // - BackupLog.user (non-nullable) → hapus
      prisma.chatNote.updateMany({ where: { tenantId: tid, userId: id }, data: { userId: req.user.id } }),
      prisma.scheduledMessage.updateMany({ where: { tenantId: tid, createdById: id }, data: { createdById: req.user.id } }),
      prisma.gDriveLink.deleteMany({ where: { userId: id } }),
      prisma.backupLog.deleteMany({ where: { userId: id } }),
      prisma.user.delete({ where: { id } }),
    ])
    
    res.json({ ok: true, deleted: { id: user.id, username: user.username } })
  } catch (e) {
    console.error('Delete user error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router