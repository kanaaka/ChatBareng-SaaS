const express = require('express')
const router = express.Router()
const prisma = require('../prisma')
const { requireAuth, requireAdmin, requireTenant } = require('../auth')

// v3.0 — Isolasi tenant: semua tag = tenant-scoped
const rt = [requireAuth, requireTenant]
const broadcast = require('../socket/broadcast')
// v4.4.0 F3 — refresh banner antrean setelah toggle exclude
const queue = require('../socket/queue')

// GET /api/tags — list all tags (any authenticated user)
// v0.13.4 — tambah contactCount per tag (via ContactTag) — ADDITIVE:
// _count.chats existing utuh, field response lama tidak berubah.
router.get('/', ...rt, async (req, res) => {
  try {
    const tags = await prisma.tag.findMany({
      where: { tenantId: req.tenantId },
      orderBy: { name: 'asc' },
      include: { _count: { select: { chats: true, contacts: true } } },
    })
    res.json({
      tags: tags.map((t) => ({
        ...t,
        contactCount: t._count.contacts,
      })),
    })
  } catch (e) {
    console.error('List tags error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/tags — create new tag (any authenticated user)
router.post('/', ...rt, async (req, res) => {
  try {
    const { name, color, excludeFromQueue } = req.body || {}
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Tag name is required' })
    }
    const validColors = ['blue', 'green', 'red', 'yellow', 'purple', 'gray']
    const tagColor = validColors.includes(color) ? color : 'blue'

    const existing = await prisma.tag.findFirst({ where: { tenantId: req.tenantId, name: name.trim() } })
    if (existing) {
      return res.status(409).json({ error: 'Tag already exists', tag: existing })
    }

    const tag = await prisma.tag.create({
      data: {
        tenantId: req.tenantId,
        name: name.trim(),
        color: tagColor,
        createdBy: req.user.id,
        // v4.4.0 F3 — buat tag yang langsung meng-eksklusi kontak dari antrean
        // v4.4.0 audit L4 — flag hanya dihormati utk admin (konsisten dgn PUT/PATCH
        // admin-only; POST biasa oleh CS tetap boleh buat tag, flag diabaikan).
        excludeFromQueue: excludeFromQueue === true && req.user.role === 'admin',
      },
    })

    broadcast.emitToTenant(req.tenantId, 'tag_created', { tag: { ...tag, contactCount: 0 } })
    // v0.13.4 — refresh contactCount chip di Contacts.vue (tag_created tidak dipakai
    // utk itu — Contacts punya listener tags_changed sendiri)
    broadcast.emitToTenant(req.tenantId, 'tags_changed', { reason: 'tag_created', tagId: tag.id })

    res.status(201).json({ tag })
  } catch (e) {
    console.error('Create tag error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// v4.1.4 — PUT /api/tags/:id — edit tag: rename + ganti warna (admin only,
// konsisten dgn DELETE: edit = mutasi resource yg dipakai lintas chat/kontak).
// Body { name?, color? } — minimal satu (dua-duanya kosong → 400). Self-rename
// (nama sama dgn dirinya sendiri) = OK; dup dgn tag LAIN = 409. Invalid color
// STRING → fallback 'blue' (konsisten dgn POST); bukan string → 400.
router.put('/:id', ...rt, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    const tagRow = await prisma.tag.findFirst({ where: { id, tenantId: req.tenantId } })
    if (!tagRow) return res.status(404).json({ error: 'Tag not found' })

    const { name, color } = req.body || {}
    const hasName = name !== undefined && name !== null
    const hasColor = color !== undefined && color !== null
    if (!hasName && !hasColor) {
      return res.status(400).json({ error: 'Nothing to update' })
    }

    const data = {}
    if (hasName) {
      if (typeof name !== 'string') {
        return res.status(400).json({ error: 'Tag name is required' })
      }
      const trimmed = name.trim()
      if (!trimmed) return res.status(400).json({ error: 'Tag name is required' })
      if (trimmed.length > 40) {
        return res.status(400).json({ error: 'Tag name must be 40 characters or less' })
      }
      // Self-rename: nama sama dgn dirinya sendiri = OK (bukan dup). Dup cek HANYA
      // bila nama berubah, dengan NOT { id } (belt-and-suspenders).
      if (trimmed !== tagRow.name) {
        const dup = await prisma.tag.findFirst({
          where: { tenantId: req.tenantId, name: trimmed, NOT: { id } },
        })
        if (dup) return res.status(409).json({ error: 'Tag already exists', tag: dup })
      }
      data.name = trimmed
    }
    if (hasColor) {
      if (typeof color !== 'string') {
        return res.status(400).json({ error: 'Invalid color' })
      }
      const validColors = ['blue', 'green', 'red', 'yellow', 'purple', 'gray']
      // Konsisten dgn POST: string di luar daftar → fallback 'blue' (BUKAN 400)
      data.color = validColors.includes(color) ? color : 'blue'
    }

    const updated = await prisma.tag.update({
      where: { id },
      data,
      include: { _count: { select: { chats: true, contacts: true } } },
    })
    const tag = { ...updated, contactCount: updated._count.contacts }

    broadcast.emitToTenant(req.tenantId, 'tag_updated', { tag })
    broadcast.emitToTenant(req.tenantId, 'tags_changed', { reason: 'tag_updated', tagId: id })

    res.json({ tag })
  } catch (e) {
    console.error('Update tag error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ═══ v4.4.0 F3 — PATCH /api/tags/:id — toggle excludeFromQueue (silent block) ═══
// ADMIN-ONLY (konsisten PUT/DELETE: memengaruhi antrean global tenant).
// Body { excludeFromQueue: true|false } — wajib boolean → selain itu 400.
// Setelah toggle: emit tag_updated (FE sync allTags/chips) + tags_changed +
// queue_update (banner count refresh segera; kontak ber-tag masuk/keluar antrean).
router.patch('/:id', ...rt, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    // v4.4.0 audit L3 — :id bukan angka → 400 bersih (bukan 500 dari Prisma)
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid tag id' })
    const tagRow = await prisma.tag.findFirst({ where: { id, tenantId: req.tenantId } })
    if (!tagRow) return res.status(404).json({ error: 'Tag not found' })

    const { excludeFromQueue } = req.body || {}
    if (typeof excludeFromQueue !== 'boolean') {
      return res.status(400).json({ error: 'excludeFromQueue harus boolean true/false' })
    }

    const updated = await prisma.tag.update({
      where: { id },
      data: { excludeFromQueue },
      include: { _count: { select: { chats: true, contacts: true } } },
    })
    const tag = { ...updated, contactCount: updated._count.contacts }

    broadcast.emitToTenant(req.tenantId, 'tag_updated', { tag })
    broadcast.emitToTenant(req.tenantId, 'tags_changed', { reason: 'tag_updated', tagId: id })
    queue.emitQueueUpdate(req.tenantId)

    res.json({ tag })
  } catch (e) {
    console.error('Patch tag (excludeFromQueue) error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/tags/:id — delete tag (admin only)
router.delete('/:id', ...rt, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    // Delete all ChatTag join records first (foreign key constraint)
    const tagRow = await prisma.tag.findFirst({ where: { id, tenantId: req.tenantId } })
    if (!tagRow) return res.status(404).json({ error: 'Tag not found' })
    const affectedChats = await prisma.chatTag.findMany({
      where: { tagId: id, chat: { tenantId: req.tenantId } },
      select: { chatId: true },
    })
    await prisma.chatTag.deleteMany({ where: { tagId: id } })
    // v0.13.4 — detach ContactTag juga (invariant: tag delete TIDAK meninggalkan
    // orphan join rows). Dulu hanya ChatTag — ContactTag dulu tidak di-sentuh.
    const affectedContacts = await prisma.contactTag.findMany({
      where: { tagId: id, tenantId: req.tenantId },
      select: { contactId: true },
    })
    await prisma.contactTag.deleteMany({ where: { tagId: id, tenantId: req.tenantId } })
    // Then delete the tag itself
    await prisma.tag.delete({ where: { id } })
    // Broadcast tag deletion: emit tag_deleted for allTags dropdown sync
    // AND emit chat_update with tagRemoved for each affected chat (proven reliable for real-time)
    broadcast.emitToTenant(req.tenantId, 'tag_deleted', { tagId: id })
    for (const ct of affectedChats) {
      broadcast.emitToTenant(req.tenantId, 'chat_update', { chatId: ct.chatId, tagRemoved: id })
    }
    // v0.13.4 — refresh contactCount chip di Contacts.vue tanpa polling
    broadcast.emitToTenant(req.tenantId, 'tags_changed', { reason: 'tag_deleted', tagId: id })
    // v4.4.0 audit M2 — hapus tag yang meng-exclude kontak = chat kembali masuk
    // antrean → banner WAJIB refresh (kalau tag biasa, count tetap — no-op murah).
    queue.emitQueueUpdate(req.tenantId)
    res.json({ success: true })
  } catch (e) {
    console.error('Delete tag error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router