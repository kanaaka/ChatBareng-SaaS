const express = require('express')
const router = express.Router()
const prisma = require('../prisma')
const { requireAuth, requireAdmin, requireTenant } = require('../auth')

// v3.0 — Isolasi tenant: semua tag = tenant-scoped
const rt = [requireAuth, requireTenant]
const broadcast = require('../socket/broadcast')

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
    const { name, color } = req.body
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
    res.json({ success: true })
  } catch (e) {
    console.error('Delete tag error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router