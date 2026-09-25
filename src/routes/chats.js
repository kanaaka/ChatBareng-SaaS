const express = require('express')
const fs = require('fs')
const router = express.Router()
const multer = require('multer')
const prisma = require('../prisma')
const config = require('../config')
const { requireAuth, requireTenant, requireAdmin } = require('../auth')
const { replyValidation } = require('../utils/validation')
const wa = require('../wa/pool')
const broadcast = require('../socket/broadcast')
const queue = require('../socket/queue')
const presence = require('../socket/presence')
const push = require('../push')
const { saveMedia, loadMedia, resolveMediaFilePath } = require('../wa/media')
// v0.11.0 — enkripsi at-rest isi pesan (AES-256-GCM via textCrypto)
const { encryptText, decryptTextSafe, decryptText } = require('../services/textCrypto')
// v0.10.0 — CSAT + rate limit catatan internal
const csat = require('../services/csat')
// v0.12.9 — Read receipts (blue tick, gate AppConfig admin default OFF)
const receipts = require('../services/receipts')
const menuGateway = require('../services/menuGateway') // v3.9.8 — clear limbo broadcast

// v3.0 — Isolasi tenant: SEMUA endpoint chats = tenant-scoped.
const rt = [requireAuth, requireTenant]

// v3.9.10b (audit LOW-2) — guard :id numerik untuk SEMUA route /:id (GET/POST/
// PUT/PATCH/DELETE): JID @g.us masuk ke sini → 404 bersih, bukan 500 dari
// Number(NaN) Prisma. Sebelumnya guard hanya di GET /:id.
router.param('id', (req, res, next, id) => {
  if (!/^\d+$/.test(String(id))) return res.status(404).json({ error: 'Chat tidak ditemukan' })
  next()
})

// v0.10.0 — Rate limit sederhana 1 note / 5 detik / user (in-memory)
const noteLastAt = new Map() // userId → timestamp ms
function assertNoteRate(user) {
  const last = noteLastAt.get(user.id) || 0
  if (Date.now() - last < 5000) {
    return false
  }
  return true
}
function markNoteRate(user) {
  noteLastAt.set(user.id, Date.now())
}

// Multer for media uploads (in-memory, limits from config)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxMediaSizeMb * 1024 * 1024 },
})

// ─── v0.11.0 — Helpers enkripsi at-rest ───────────────────────────────
// Dekrip isi pesan utk response API. Legacy plaintext (tanpa prefix) → apa adanya.
// Error dekrip (kunci ganti/korup) → placeholder, TIDAK crash response.
function decContent(stored) {
  return decryptTextSafe(stored)
}

// Dekrip preview di object chat (single / list / nested) untuk response API
function decChatPreview(chat) {
  if (!chat || typeof chat !== 'object') return chat
  if (chat.lastMessagePreview != null) {
    chat.lastMessagePreview = decryptTextSafe(chat.lastMessagePreview)
  }
  return chat
}

// Dekrip array messages in-place (response GET messages/detail/search/favorites)
function decMessagesInPlace(messages) {
  for (const m of messages || []) {
    if (m && m.content != null) m.content = decryptTextSafe(m.content)
  }
  return messages
}

// ─── v0.1.21 — Queue discipline helpers ─────────────────────────

// Reply lock TOTAL: chat belum di-Take (assignedToId null) → 403, BERLAKU JUGA UNTUK ADMIN.
// Return true kalau boleh lanjut kirim.
function assertTaken(chat, res) {
  if (chat.assignedToId === null) {
    res.status(403).json({ error: 'Chat belum di-Take. Ambil chat dulu sebelum membalas.' })
    return false
  }
  return true
}

// Akses detail chat: admin, pemilik yang open, atau yang resolve (resolvedById=me).
function canAccessChat(user, chat) {
  if (user.role === 'admin') return true
  if (chat.assignedToId === user.id && chat.status === 'open') return true
  if (chat.resolvedById === user.id) return true
  return false
}

function accessDenied(res) {
  return res.status(403).json({ error: 'Anda tidak memiliki akses ke chat ini' })
}

// ═══ v3.9.2 K1-A — Contact identity helpers (C.8) ═══
// Kontak = identity per (tenantId, phone): 1 orang = 1 kontak, WALAUPUN dia punya
// chat di beberapa slot. Chat yang dihapus boleh per-chat, kontak TIDAK boleh
// dibuang kalau masih dibutuhkan chat lain.

/**
 * Cari kontak yang nempel chat ini + chat 1:1 LAIN milik nomor yang sama
 * (slot lain — match by phone normalized). Return { contact, otherChat }.
 * Nomor LID yang belum resolved gak bisa di-match by phone → dianggap tidak sharing.
 */
async function findContactAndSiblingChat(tx, tenantId, chatId) {
  const contact = await tx.contact.findFirst({ where: { chatId, tenantId } })
  if (!contact) return { contact: null, otherChat: null }
  const chat = await tx.chat.findUnique({ where: { id: chatId }, select: { id: true, waJid: true, contactPhone: true, tenantId: true } })
  if (!chat) return { contact, otherChat: null }
  // Grup / LID belum resolved → tidak ada sibling yang bisa dipastikan.
  if (chat.waJid.endsWith('@g.us') || !contact.phone) return { contact, otherChat: null }
  const jid = `${contact.phone}@s.whatsapp.net`
  // chat 1:1 sisanya milik nomor sama — slot apapun (contact.phone = identity).
  // Match by contactPhone OR phoneJid (chat LID yang sudah ke-resolve ke nomor ini).
  const otherChat = await tx.chat.findFirst({
    where: {
      tenantId,
      id: { not: chatId },
      waJid: { not: { endsWith: '@g.us' } },
      OR: [
        { waJid: jid },
        { phoneJid: jid },
      ],
    },
    orderBy: { lastMessageAt: 'desc' },
    select: { id: true },
  })
  return { contact, otherChat }
}

/**
 * deleteContactOnlyIfNotShared — HAPUS kontak linked ke chat ini, KECUALI kontak
 * masih nempel (via phone) ke chat 1:1 lain slot lain → DIPERTAHANKAN (primary
 * otomatis pindah saat chat itu aktif lagi — syncContactFromChat K1-A).
 */
async function deleteContactOnlyIfNotShared(tx, tenantId, chatId) {
  const { contact, otherChat } = await findContactAndSiblingChat(tx, tenantId, chatId)
  if (!contact) return { count: 0 }
  if (otherChat) return { count: 0 } // identitas masih dibutuhkan — pertahankan
  return tx.contact.deleteMany({ where: { id: contact.id } })
}

/**
 * detachContactKeepIdentity — kontak di-detach dari chat yang dihapus.
 * v3.9.2 K1-A: bila kontak juga punya chat LAIN (slot lain, nomor sama) → primary
 * pindah ke chat sisanya (paling baru aktif; BUKAN orphan); kalau tidak ada →
 * orphan (chatId null, pola v3.7).
 */
async function detachContactKeepIdentity(tx, tenantId, chatId) {
  const { contact, otherChat } = await findContactAndSiblingChat(tx, tenantId, chatId)
  if (!contact) return { count: 0 }
  if (otherChat) {
    return tx.contact.updateMany({ where: { id: contact.id, chatId }, data: { chatId: otherChat.id } })
  }
  return tx.contact.updateMany({ where: { id: contact.id, chatId }, data: { chatId: null } })
}

// ═══ v3.9.14 — Quote Reply (WhatsApp contextInfo) ═══

/**
 * Strip kolom quoted mentah (incl. quotedSnippet ciphertext) dari pesan utk payload
 * API — quote cuma keluar via shape `quoted` (§6). TIDAK pernah bocor ciphertext.
 */
function stripRawQuotedColumns(messageLike) {
  if (!messageLike || typeof messageLike !== 'object') return messageLike
  const out = { ...messageLike }
  delete out.quotedWaMessageId
  delete out.quotedParticipantJid
  delete out.quotedSnippet
  delete out.quotedType
  return out
}

/**
 * Shape `quoted` utk payload API (§6 spec): plaintext snippet (dekrip on-the-fly)
 * + dbMessageId resolve same-chat via waMessageId (null bila purged/hilang).
 * Return null bila pesan tanpa quote.
 */
async function buildQuotedPayload(dbMsg) {
  if (!dbMsg || !dbMsg.quotedWaMessageId) return null
  try {
    let dbMessageId = null
    try {
      const orig = await prisma.message.findFirst({
        where: { chatId: dbMsg.chatId, waMessageId: dbMsg.quotedWaMessageId },
        select: { id: true, purged: true },
      })
      if (orig && !orig.purged) dbMessageId = orig.id
    } catch {}
    return {
      waMessageId: dbMsg.quotedWaMessageId,
      participantJid: dbMsg.quotedParticipantJid || null,
      snippet: dbMsg.quotedSnippet ? decryptTextSafe(dbMsg.quotedSnippet) : null,
      type: dbMsg.quotedType || 'text',
      dbMessageId,
    }
  } catch {
    return null
  }
}

/**
 * Validasi target quote utk /:id/reply → return { ok, message?, error? }.
 * Guard (spec §5.1): ada, same chatId+tenantId, purged=false, punya waMessageId
 * nyata (row failed/legacy → 400 — JANGAN pernah fake stanzaId).
 */
async function resolveQuoteTarget(tenantId, chatId, replyToMessageId) {
  const target = await prisma.message.findFirst({ where: { id: replyToMessageId, tenantId, chatId } })
  if (!target) return { ok: false, status: 400, error: 'Pesan yang di-reply tidak ditemukan di chat ini' }
  if (target.purged) return { ok: false, status: 400, error: 'Pesan yang di-reply sudah dihapus' }
  if (!target.waMessageId) return { ok: false, status: 400, error: 'Pesan tidak dapat di-quote' }
  return { ok: true, message: target }
}

/**
 * protoFromRow(target) — WAMessage minimal utk Baileys `quoted` (spec §5.2).
 * text → { conversation }; media → proto media minimal (+caption bila ada).
 * WA render placeholder chip utk media — acceptable & standard.
 */
function protoFromRow(target) {
  const text = target.content ? decryptTextSafe(target.content) : null
  if (target.mediaType) {
    switch (target.mediaType) {
      case 'image': return { imageMessage: { ...(text ? { caption: text } : {}) } }
      case 'video': return { videoMessage: { ...(text ? { caption: text } : {}) } }
      case 'audio': return { audioMessage: {} }
      case 'sticker': return { stickerMessage: {} }
      case 'document': return { documentMessage: { ...(text ? { caption: text } : {}) } }
      default: return { conversation: text || '' }
    }
  }
  return { conversation: text || '' }
}

/** Snippet plaintext ≤200 utk kolom quotedSnippet outbound (fallback '[Type]' media tanpa caption) */
function quoteSnippetFromTarget(target) {
  const type = target.mediaType || 'text'
  let snippet = target.content ? decryptTextSafe(target.content) : null
  if (!snippet) snippet = `[${type.charAt(0).toUpperCase() + type.slice(1)}]`
  return String(snippet).slice(0, 200)
}

// GET /api/chats - list chats
router.get('/', ...rt, async (req, res) => {
  try {
    const filter = req.query.filter || 'all' // mine | unassigned | all | resolved
    const where = { tenantId: req.tenantId }

    // v0.14.0 — Manajemen Grup: grup @g.us tidak pernah bocor ke list chat 1:1.
    // Grup punya endpoint sendiri (GET /api/groups).
    // v0.14.9 — BUGFIX NULL trap: `{ phoneJid: { not: endsWith } }` TIDAK match
    // row phoneJid NULL → chat @lid (era LID WA modern) hilang dari SEMUA tab
    // list, padahal queue-count menghitungnya → banner "3 chat di antrean"
    // tapi tab Unassigned kosong. Jebakan yang sama kayak menuState v0.13.3;
    // asumsi lama "row NULL tetap muncul" terbukti salah (SQLite 3-valued
    // logic: NULL NOT LIKE '%@g.us' → NULL → row dibuang). Fix: null-escape
    // eksplisit via OR + guard id-based (id primary key selalu terisi → NOT
    // bebas jebakan NULL) supaya grup dengan phoneJid NULL pun tetap
    // terkecualikan. Ditaruh di where.AND agar komposabel dengan blok
    // menuState/tagIds di bawah (keduanya append ke where.AND).
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : []),
      { NOT: { waJid: { endsWith: '@g.us' } } },
      { OR: [{ phoneJid: null }, { phoneJid: { not: { endsWith: '@g.us' } } }] },
    ]

    // v0.1.21 — Filter isolation: CS (non-admin) gak boleh lihat unassigned/all,
    // resolved cuma milik sendiri.
    if (req.user.role !== 'admin') {
      if (filter === 'unassigned' || filter === 'all') {
        return res.status(403).json({ error: 'Filter ini hanya untuk admin' })
      }
      if (filter === 'resolved') {
        where.status = 'resolved'
        where.resolvedById = req.user.id
      }
    } else {
      if (filter === 'resolved') {
        where.status = 'resolved'
      }
    }

    if (filter === 'mine') {
      where.assignedToId = req.user.id
      where.status = 'open' // v0.1.21 — Mine = open + milikku (resolved keluar otomatis)
    } else if (filter === 'unassigned') {
      where.assignedToId = null
      where.status = 'open'
      // v0.13.3 — invariant §4.1: chat awaiting (limbo Menu Gateway) tidak tampil
      // di list antrean dashboard. Jejak NULL Prisma: { not: 'awaiting' } TIDAK
      // match row NULL → wajib OR eksplisit dgn menuState: null.
      // Ditaruh sbg grup OR di dalam where.AND agar tidak tertimpa blok snooze
      // (menulis where.OR) dan blok tagIds di bawah.
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : []),
        { OR: [{ menuState: null }, { menuState: { not: 'awaiting' } }] },
      ]
    } else if (filter === 'all' && req.user.role === 'admin') {
      // admin: semua chat (no extra where)
    } else if (filter === 'all') {
      // CS fallback ke mine kalau somehow lolos — safety net
      where.assignedToId = req.user.id
      where.status = 'open'
    }

    // v0.10.0 — SNOOZE: chat aktif snoozed hilang dari SEMUA list utama;
    // hanya tampil lewat ?snoozed=1 (chip khusus). queuedAt/assignment NIHIL berubah.
    if (req.query.snoozed === '1') {
      where.snoozedUntil = { not: null, gt: new Date() }
    } else {
      where.OR = [{ snoozedUntil: null }, { snoozedUntil: { lte: new Date() } }]
    }

    // Filter by tags (AND logic - chat must have ALL selected tags)
    const tagIdsRaw = req.query.tagIds
    if (tagIdsRaw) {
      const tagIds = tagIdsRaw.split(',').map(id => parseInt(id, 10)).filter(id => !isNaN(id))
      if (tagIds.length > 0) {
        // v0.13.3 — append ke where.AND (bukan menimpa) karena blok unassigned di
        // atas sudah memakai where.AND utk exclusion menuState awaiting.
        where.AND = [
          ...(Array.isArray(where.AND) ? where.AND : []),
          ...tagIds.map(tagId => ({
            tags: { some: { tagId } }
          })),
        ]
      }
    }

    // Filter by handler (assigned CS)
    const handlerId = req.query.handlerId
    if (handlerId) {
      // v0.1.21 — CS gak bisa intip chat orang lain via handlerId
      if (req.user.role !== 'admin') {
        const hid = parseInt(handlerId, 10)
        if (!isNaN(hid) && hid !== req.user.id) {
          return res.status(403).json({ error: 'Anda hanya bisa melihat chat Anda sendiri' })
        }
      }
      const hid = parseInt(handlerId, 10)
      if (!isNaN(hid)) {
        where.assignedToId = hid
      }
    }

    // Filter by date range (lastMessageAt)
    const dateFrom = req.query.dateFrom
    const dateTo = req.query.dateTo
    if (dateFrom || dateTo) {
      where.lastMessageAt = where.lastMessageAt || {}
      if (dateFrom) {
        where.lastMessageAt.gte = new Date(dateFrom)
      }
      if (dateTo) {
        // Include the full end day
        const endDate = new Date(dateTo)
        endDate.setHours(23, 59, 59, 999)
        where.lastMessageAt.lte = endDate
      }
    }

    // v0.1.22 — sembunyikan chat yang sudah tidak punya pesan aktif (habis di-purge)
    where.messages = { some: { purged: false } }

    const chats = await prisma.chat.findMany({
      where,
      orderBy: { lastMessageAt: 'desc' },
      take: 100,
      include: {
        assignedTo: { select: { id: true, username: true } },
        tags: { include: { tag: true } },
      },
    })

    // DEBUG v0.11.0 (temporary)
    console.log('[LIST-DEBUG] filter=', req.query.filter, '| role=', req.user.role, '| userId=', req.user.id)
    // v0.11.0 — preview chat list dekrip on-the-fly (DB berisi ciphertext)
    for (const c of chats) {
      if (c.lastMessagePreview != null) c.lastMessagePreview = decryptTextSafe(c.lastMessagePreview)
    }

    res.json({ chats })
  } catch (e) {
    console.error('List chats error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/favorites — all favorited messages across all chats
router.get('/favorites/all', ...rt, async (req, res) => {
  try {
    const favorites = await prisma.favoriteMessage.findMany({
      where: { userId: req.user.id },
      include: {
        message: {
          select: {
            id: true, chatId: true, direction: true, content: true,
            mediaType: true, mediaMime: true, senderName: true, senderId: true,
            timestamp: true, status: true, purged: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    })
    // v0.11.0 — favorites panel: dekrip content on-the-fly
    for (const f of favorites) {
      if (f.message && f.message.content != null) f.message.content = decryptTextSafe(f.message.content)
    }
    res.json({ favorites })
  } catch (e) {
    console.error('List all favorites error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ─── v0.10.0 — SNOOZE CHAT (Fitur A) ─────────────────────────────────
// POST /api/chats/:id/snooze { until: ISO } — assigned CS/admin
router.post('/:id/snooze', ...rt, async (req, res) => {
  try {
    const chatId = req.params.id
    const chat = await prisma.chat.findFirst({ where: { id: Number(chatId), tenantId: req.tenantId } })
    if (!chat) return res.status(404).json({ error: 'Chat not found' })

    // Akses: assigned CS + admin (konsisten permission transfer/release/resolve)
    if (chat.assignedToId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only the assigned agent or admin can snooze this chat' })
    }
    if (chat.status === 'resolved') {
      return res.status(400).json({ error: 'Chat sudah resolved — tidak bisa di-snooze' })
    }

    const until = new Date(req.body.until)
    if (!req.body.until || isNaN(until.getTime())) {
      return res.status(400).json({ error: 'Field `until` (ISO datetime) wajib dan valid' })
    }
    const now = new Date()
    const maxSnooze = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000) // max 30 hari
    if (until <= now) {
      return res.status(400).json({ error: 'Waktu snooze harus di masa depan' })
    }
    if (until > maxSnooze) {
      return res.status(400).json({ error: 'Snooze maksimal 30 hari' })
    }

    const updated = await prisma.chat.update({
      where: { id: chat.id },
      data: { snoozedUntil: until, snoozedBy: req.user.id },
      include: { assignedTo: { select: { id: true, username: true } } },
    })

    broadcast.emitToTenant(req.tenantId, 'chat_update', { chatId: Number(chatId), snoozedUntil: until, snoozedBy: req.user.id })
    console.log(`[Snooze] ${req.user.username} snooze chat ${chatId} sampai ${until.toISOString()}`)
    res.json({ chat: updated })
  } catch (e) {
    console.error('Snooze error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/chats/:id/snooze — cancel snooze manual (assigned CS/admin)
router.delete('/:id/snooze', ...rt, async (req, res) => {
  try {
    const chatId = req.params.id
    const chat = await prisma.chat.findFirst({ where: { id: Number(chatId), tenantId: req.tenantId } })
    if (!chat) return res.status(404).json({ error: 'Chat not found' })
    if (chat.assignedToId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only the assigned agent or admin can cancel snooze' })
    }
    if (!chat.snoozedUntil) return res.json({ chat, cancelled: false })

    const updated = await prisma.chat.update({
      where: { id: chat.id },
      data: { snoozedUntil: null, snoozedBy: null },
      include: { assignedTo: { select: { id: true, username: true } } },
    })
    broadcast.emitToTenant(req.tenantId, 'chat_update', { chatId: Number(chatId), snoozedUntil: null, snoozedBy: null })
    res.json({ chat: updated, cancelled: true })
  } catch (e) {
    console.error('Snooze cancel error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ─── v0.10.0 — CATATAN INTERNAL (Fitur B) ──────────────────────────────
// GET /api/chats/:id/notes — assigned CS/admin
router.get('/:id/notes', ...rt, async (req, res) => {
  try {
    const chatId = req.params.id
    const chat = await prisma.chat.findFirst({ where: { id: Number(chatId), tenantId: req.tenantId } })
    if (!chat) return res.status(404).json({ error: 'Chat not found' })
    // Assigned CS + admin (sama dengan reply permission). Resolver tetap boleh lihat.
    if (!canAccessChat(req.user, chat)) return accessDenied(res)

    const notes = await prisma.chatNote.findMany({
      where: { tenantId: req.tenantId, chatId: Number(chatId) },
      include: { user: { select: { id: true, username: true, role: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
    // v0.12.4 — enkripsi scope 2: body tersimpan ciphertext, API return plaintext
    const notesPlain = notes.map(n => ({ ...n, body: decryptTextSafe(n.body) }))
    res.json({ notes: notesPlain })
  } catch (e) {
    console.error('List notes error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/chats/:id/notes { body } — assigned CS/admin; rate 1 note/5s/user
router.post('/:id/notes', ...rt, async (req, res) => {
  try {
    const chatId = req.params.id
    const body = typeof req.body.body === 'string' ? req.body.body.trim() : ''
    if (!body) return res.status(400).json({ error: 'Isi catatan tidak boleh kosong' })
    if (body.length > 2000) return res.status(400).json({ error: 'Catatan maksimal 2000 karakter' })

    const chat = await prisma.chat.findFirst({ where: { id: Number(chatId), tenantId: req.tenantId } })
    if (!chat) return res.status(404).json({ error: 'Chat not found' })
    if (chat.assignedToId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only the assigned agent or admin can add notes' })
    }
    if (!assertNoteRate(req.user)) {
      return res.status(429).json({ error: 'Terlalu cepat — tunggu 5 detik antar catatan' })
    }

    const note = await prisma.chatNote.create({
      data: { tenantId: req.tenantId, chatId: Number(chatId), userId: req.user.id, body: encryptText(body) }, // v0.12.4 — body terenkripsi at-rest
      include: { user: { select: { id: true, username: true, role: true } } },
    })
    markNoteRate(req.user)

    const notePlain = { ...note, body: decryptTextSafe(note.body) } // v0.12.4 — API/broadcast plaintext
    // Real-time: semua viewer chat yang sama update live (pola broadcast existing)
    broadcast.emitToRoom(`chat:${Number(chatId)}`, 'note_added', { chatId: Number(chatId), note: notePlain })
    res.status(201).json({ note: notePlain })
  } catch (e) {
    console.error('Add note error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/chats/notes/:noteId — penulis/admin (MUST be above /:id)
router.delete('/notes/:noteId', ...rt, async (req, res) => {
  try {
    const noteId = parseInt(req.params.noteId, 10)
    if (isNaN(noteId)) return res.status(400).json({ error: 'Invalid note ID' })

    const note = await prisma.chatNote.findFirst({ where: { id: noteId, tenantId: req.tenantId } })
    if (!note) return res.status(404).json({ error: 'Note not found' })
    if (note.userId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Hanya penulis catatan atau admin yang bisa menghapus' })
    }

    await prisma.chatNote.delete({ where: { id: noteId } })
    broadcast.emitToRoom(`chat:${note.chatId}`, 'note_deleted', { chatId: note.chatId, noteId })
    res.json({ success: true })
  } catch (e) {
    console.error('Delete note error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ─── Search endpoint ─────────────────────────────────────────────

// GET /api/chats/search-all?q=searchterm — global search across ALL chats
router.get('/search-all', ...rt, async (req, res) => {
  try {
    const q = req.query.q
    if (!q || q.trim().length < 2) {
      return res.json({ results: [], total: 0 })
    }

    // v0.1.21 — Isolasi: admin lihat semua; CS hanya chat yang bisa diaksesnya
    let accessFilter = null
    if (req.user.role !== 'admin') {
      accessFilter = chat => (chat.assignedToId === req.user.id && chat.status === 'open') || chat.resolvedById === req.user.id
    }

    // v0.11.0 — Global search: SQL LIKE gak bisa di ciphertext → fetch kandidat
    // terbaru (batas 5000), dekrip in-memory, filter di aplikasi. (Catatan performa:
    // skala SQLite saat ini ribuan = OK; jutaan → perlu FTS terenkripsi fase 2.)
    const candidates = await prisma.message.findMany({
      where: { tenantId: req.tenantId, purged: false, content: { not: null } },
      orderBy: { timestamp: 'desc' },
      take: 5000,
      include: {
        chat: {
          select: {
            id: true,
            contactName: true,
            contactPhone: true,
            assignedToId: true,
            status: true,
            resolvedById: true, // v0.1.21 — untuk isolasi CS
          },
        },
      },
    })
    const qLower = q.trim().toLowerCase()
    const messages = []
    for (const msg of candidates) {
      if (msg.content == null) continue
      const plain = decryptTextSafe(msg.content)
      if (typeof plain !== 'string' || !plain.toLowerCase().includes(qLower)) continue
      msg.content = plain
      messages.push(msg)
      if (messages.length >= 100) break
    }
    const scannedCount = candidates.length

    // Group by chatId — one entry per chat with matching messages
    const chatMap = new Map()
    for (const msg of messages) {
      if (accessFilter && !accessFilter(msg.chat)) continue
      if (!chatMap.has(msg.chatId)) {
        chatMap.set(msg.chatId, {
          chat: msg.chat,
          messages: [],
          matchCount: 0,
        })
      }
      const entry = chatMap.get(msg.chatId)
      entry.messages.push({
        id: msg.id,
        content: msg.content,
        direction: msg.direction,
        senderName: msg.senderName,
        timestamp: msg.timestamp,
      })
      entry.matchCount++
    }

    const results = Array.from(chatMap.values()).sort((a, b) => b.matchCount - a.matchCount)

    res.json({ results, total: results.length, totalMessages: messages.length, scanned: scannedCount })
  } catch (e) {
    console.error('Global search error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ─── v0.1.21 — Queue endpoints (MUST be above /:id) ───────────────

// GET /api/chats/queue-count — jumlah chat di antrean (open + unassigned)
router.get('/queue-count', ...rt, async (req, res) => {
  try {
    const count = await queue.getQueueCount(req.tenantId)
    res.json({ count })
  } catch (e) {
    console.error('Queue count error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/chats/take-next — ambil chat terdepan dari antrean (FIFO)
router.post('/take-next', ...rt, async (req, res) => {
  try {
    // v0.5.0 — Role Cabang (relay) tidak boleh ambil chat dari antrean.
    // Chat hanya bisa diterima lewat transfer dari CS/Admin.
    if (req.user.role === 'relay') {
      return res.status(403).json({ error: 'Role Cabang tidak dapat mengambil chat dari antrean. Chat diterima melalui transfer.' })
    }

    const userId = req.user.id
    let result = null

    // SQLite single-writer serializes concurrent takes; loop with race-guard
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = await prisma.chat.findFirst({
        // v0.13.3 — invariant §4.1: chat menuState='awaiting' (limbo Menu Gateway)
        // tidak boleh di-take dari antrean. queueWhere() includes OR null-escape
        // untuk jebak NULL Prisma ({ not: 'awaiting' } tidak match NULL).
        where: queue.queueWhere(req.tenantId),
        orderBy: [
          { queuedAt: 'asc' },   // FIFO key; nulls-first di SQLite ASC untuk chat lama
          { lastMessageAt: 'asc' }, // fallback chat lama queuedAt=null
        ],
      })
      if (!candidate) break

      // Race-guard: hanya assign kalau masih unassigned
      const claimed = await prisma.chat.updateMany({
        where: { id: candidate.id, tenantId: req.tenantId, assignedToId: null, status: 'open' },
        data: {
          assignedToId: userId,
          lastAssignedAt: new Date(),
          queuedAt: null, // keluar dari antrean
          ...(candidate.firstAssignedAt ? {} : { firstAssignedAt: new Date() }),
        },
      })
      if (claimed.count === 1) {
        result = candidate.id
        break
      }
      // Kalau 0 → chat sudah diambil orang lain di antara findFirst dan updateMany → retry chat berikutnya
    }

    if (!result) {
      return res.status(404).json({ error: 'Antrean kosong' })
    }

    const now = new Date()
    const chat = await prisma.chat.update({
      where: { id: result },
      include: {
        assignedTo: { select: { id: true, username: true } },
        tags: { include: { tag: true } },
      },
      data: {}, // no-op update untuk refresh updatedAt & include
    })

    await prisma.chatEvent.create({
      data: { tenantId: req.tenantId, chatId: result, userId, type: 'taken_queue' },
    })
    // Analytics v0.1.19 compatibility: keep 'assigned' event type
    await prisma.chatEvent.create({
      data: { tenantId: req.tenantId, chatId: result, userId, type: 'assigned' },
    })

    broadcast.emitToTenant(req.tenantId, 'chat_update', {
      chatId: result,
      assignedTo: chat.assignedTo,
      queuedAt: null,
    })
    queue.emitQueueUpdate(req.tenantId)

    console.log(`[Queue] ${req.user.username} mengambil chat dari antrean: ${result}`)
    res.json({ chat })
  } catch (e) {
    console.error('Take-next error:', e)
    res.status(500).json({ error: e.message || 'Internal server error' })
  }
})

// GET /api/chats/:id - chat detail with paginated messages
router.get('/:id', ...rt, async (req, res) => {
  try {
    const chatId = req.params.id
    const page = parseInt(req.query.page || '1', 10)
    const limit = parseInt(req.query.limit || '50', 10)
    const skip = (page - 1) * limit

    const chat = await prisma.chat.findFirst({
      where: { id: Number(chatId), tenantId: req.tenantId },
      include: {
        assignedTo: { select: { id: true, username: true } },
        tags: { include: { tag: true } },
        // v0.10.0 — Fitur C: rating CSAT terakhir (badge "⭐ N" di chat detail).
        // Read-only additive; tidak mengubah shape endpoint yang dipakai existing.
        csatSurveys: {
          where: { rating: { not: null } },
          orderBy: { id: 'desc' },
          take: 1,
          select: { id: true, rating: true, respondedAt: true },
        },
      },
    })

    if (!chat) return res.status(404).json({ error: 'Chat not found' })

    // v0.1.21 — Isolasi detail chat: admin, pemilik open, atau resolver
    if (!canAccessChat(req.user, chat)) {
      return accessDenied(res)
    }

    // v0.10.0 — datarkan rating CSAT terakhir sebagai field flat (shape aman)
    chat.lastCsatRating = chat.csatSurveys?.[0]?.rating ?? null
    delete chat.csatSurveys

    // ─── v0.5.1 — Clear flag "transfer belum dibaca": chat dibuka oleh assignee ──
    if (req.user.id === chat.assignedToId && chat.transferUnseen) {
      try {
        await prisma.chat.update({ where: { id: Number(chatId) }, data: { transferUnseen: false } })
        chat.transferUnseen = false // respon GET bawa field terbaru
      } catch (e) {
        console.error('Clear transferUnseen error:', e.message)
      }
    }

    const [messages, total] = await Promise.all([
      prisma.message.findMany({
        where: { tenantId: req.tenantId, chatId: Number(chatId), purged: false },
        orderBy: { timestamp: 'desc' },
        skip,
        take: limit,
      }),
      prisma.message.count({ where: { tenantId: req.tenantId, chatId: Number(chatId), purged: false } }),
    ])

    // v0.11.0 — dekrip on-the-fly utk response (DB ciphertext → API plaintext)
    decMessagesInPlace(messages)
    decChatPreview(chat)

    // v3.9.14 — quoted shape per message (null bila tanpa quote; snippet-only bila asal purged);
    // kolom quoted mentah di-strip dari payload (ciphertext cuma di DB)
    for (const m of messages) {
      m.quoted = await buildQuotedPayload(m)
      delete m.quotedWaMessageId
      delete m.quotedParticipantJid
      delete m.quotedSnippet
      delete m.quotedType
    }

    res.json({
      chat,
      messages: messages.reverse(), // chronological order
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    })
  } catch (e) {
    console.error('Chat detail error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/chats/:id/assign
router.post('/:id/assign', ...rt, async (req, res) => {
  try {
    const chatId = req.params.id
    const userId = req.body.user_id || req.user.id

    const existing = await prisma.chat.findFirst({ where: { id: Number(chatId), tenantId: req.tenantId } })
    if (!existing) return res.status(404).json({ error: 'Chat not found' })

    // v0.1.21 — Anti cherry-picking: CS gak boleh self-assign chat unassigned.
    // Harus lewat take-next (FIFO). Admin boleh assign manual (Take di tab Unassigned/All).
    if (existing.assignedToId === null && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Gunakan tombol Take Next untuk mengambil chat dari antrean (FIFO). Ambil manual hanya untuk admin.' })
    }

    // v3.9.8b (audit MEDIUM-1) — anti-steal: CS tidak boleh merebut chat milik
    // agent lain (assign tanpa user_id pada chat assigned ke orang lain — dulu
    // lolos gate cherry-picking, kini 403; admin tetap boleh reassign paksa).
    if (existing.assignedToId !== null && existing.assignedToId !== req.user.id && !req.body.user_id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Chat ini milik agent lain. Admin dapat reassign lewat panel Assign.' })
    }

    // CS trying to assign to someone else - check if they own the chat
    if (req.body.user_id && req.body.user_id !== req.user.id && req.user.role !== 'admin') {
      if (existing.assignedToId !== req.user.id) {
        return res.status(403).json({ error: 'You can only transfer chats assigned to you' })
      }
    }

    // ─── v0.5.0 — Aturan transfer baru (matrix permission role) ─────────
    const targetUserId = req.body.user_id ? parseInt(req.body.user_id, 10) : null
    if (targetUserId && targetUserId !== req.user.id) {
      const targetUser = await prisma.user.findFirst({
        where: { id: targetUserId, tenantId: req.tenantId },
        select: { id: true, role: true, status: true },
      })
      if (!targetUser || targetUser.status !== 'active') {
        return res.status(403).json({ error: 'User tujuan tidak ditemukan atau tidak aktif' })
      }
      if (req.user.role === 'relay') {
        // Cabang hanya boleh transfer ke CS/Admin — bukan sesama Cabang
        if (targetUser.role !== 'cs' && targetUser.role !== 'admin') {
          return res.status(403).json({ error: 'Cabang hanya dapat transfer ke CS atau Admin' })
        }
        // Dan target harus online
        if (!presence.isOnline(req.tenantId, targetUserId)) {
          return res.status(403).json({ error: 'User tujuan sedang offline' })
        }
      } else if (req.user.role === 'cs') {
        // CS boleh ke cs/admin/relay, tapi target harus online
        if (!presence.isOnline(req.tenantId, targetUserId)) {
          return res.status(403).json({ error: 'User tujuan sedang offline' })
        }
      }
      // admin: bypass (safety valve — boleh reassign paksa ke user offline)
    }

    const wasInQueue = existing.assignedToId === null

    // v3.9.8 — invariant §4.1 repair: admin take chat LIMBO (menuState='awaiting',
    // intro terkirim tapi belum memilih) → sekalian clear limbo (done) supaya
    // tidak nyangkut selamanya di chip "⏳ Menunggu menu" (kasus Khoiriyah).
    const clearLimbo = existing.menuState === 'awaiting'

    // Determine timestamp and first/last assignment data
    const assignNow = new Date()
    const assignUpdateData = { assignedToId: userId, lastAssignedAt: assignNow }
    if (!existing.firstAssignedAt) {
      assignUpdateData.firstAssignedAt = assignNow
    }
    if (wasInQueue) {
      assignUpdateData.queuedAt = null // keluar dari antrean
    }
    // v3.9.8 — clear limbo saat take (SETELAH deklarasi assignUpdateData — anti TDZ)
    if (clearLimbo) {
      assignUpdateData.menuState = 'done'
    }
    // v0.5.1 — Transfer antar-agent (target ≠ actor) → tandai "transfer belum dibaca".
    // Take-next / self-assign TIDAK di-set (tetap false).
    if (targetUserId && targetUserId !== req.user.id) {
      assignUpdateData.transferUnseen = true
    }

    const chat = await prisma.chat.update({
      where: { id: Number(chatId) },
      data: assignUpdateData,
      include: {
        assignedTo: { select: { id: true, username: true } },
        tags: { include: { tag: true } },
      },
    })

    await prisma.chatEvent.create({
      data: { tenantId: req.tenantId, chatId: Number(chatId), userId, type: 'assigned' },
    })
    // v0.1.21 — event source: manual admin take dari antrean
    if (wasInQueue && req.user.role === 'admin') {
      await prisma.chatEvent.create({
        data: { tenantId: req.tenantId, chatId: Number(chatId), userId, type: 'taken_manual_admin' },
      })
    }

    // v0.5.1 — flag transfer hanya utk transfer antar-agent (target ≠ actor)
    const isTransfer = !!(targetUserId && targetUserId !== req.user.id)

    // v3.9.8 — limbo dibersihkan → refresh chip count realtime
    if (clearLimbo) {
      broadcast.emitToTenant(req.tenantId, 'menu_waiting_update', { count: await menuGateway.countWaiting(req.tenantId) })
    }

    broadcast.emitToTenant(req.tenantId, 'chat_update', {
      chatId: Number(chatId),
      assignedTo: chat.assignedTo,
      queuedAt: wasInQueue ? null : undefined,
      // v0.5.1 — username actor, hanya saat transfer antar-agent (payload endpoint lain tidak berubah)
      ...(isTransfer ? { transferredFrom: req.user.username } : {}),
    })
    if (wasInQueue) queue.emitQueueUpdate(req.tenantId)

    // v0.5.0 — Push baru utk event transfer (fire-and-forget, target ≠ actor).
    // Aman utk semua role — termasuk relay (satu-satunya cara dia dapat chat).
    if (targetUserId && targetUserId !== req.user.id) {
      try {
        push.sendToUser(targetUserId, {
          kind: 'transfer',
          chatId: Number(chatId),
          title: 'Chat ditransfer ke kamu',
          body: chat.contactName || chat.contactPhone || chatId,
          url: `/?chat=${Number(chatId)}`,
        })
      } catch (pushErr) {
        console.error('[Chats] transfer push error (non-fatal):', pushErr.message)
      }
    }

    res.json({ chat })
  } catch (e) {
    console.error('Assign error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/chats/:id/release
router.post('/:id/release', ...rt, async (req, res) => {
  try {
    const chatId = req.params.id

    const existing = await prisma.chat.findFirst({ where: { id: Number(chatId), tenantId: req.tenantId } })
    if (!existing) return res.status(404).json({ error: 'Chat not found' })

    // v0.1.21 — hanya pemilik/admin yang bisa release
    if (existing.assignedToId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only the assigned agent or admin can release this chat' })
    }

    // Release = masuk antrean: queuedAt=now, keluar dari binding
    const releaseAt = new Date()
    const chat = await prisma.chat.update({
      where: { id: Number(chatId) },
      data: { assignedToId: null, queuedAt: releaseAt },
    })

    await prisma.chatEvent.create({
      data: { tenantId: req.tenantId, chatId: Number(chatId), userId: req.user.id, type: 'released' },
    })

    broadcast.emitToTenant(req.tenantId, 'chat_update', { chatId: Number(chatId), assignedTo: null, queuedAt: releaseAt })
    queue.emitQueueUpdate(req.tenantId)

    res.json({ chat })
  } catch (e) {
    console.error('Release error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/chats/:id/reply - send text reply
router.post('/:id/reply', ...rt, replyValidation, async (req, res) => {
  try {
    const chatId = req.params.id
    const { content } = req.body
    // v3.9.14 — optional replyToMessageId (ChatBareng Message.id) utk quote reply
    let replyToMessageId = null
    if (req.body.replyToMessageId !== undefined && req.body.replyToMessageId !== null) {
      replyToMessageId = Number(req.body.replyToMessageId)
      if (!Number.isInteger(replyToMessageId) || replyToMessageId <= 0) {
        return res.status(400).json({ error: 'replyToMessageId harus berupa ID pesan (angka) yang valid' })
      }
    }

    // Check chat exists
    const chat = await prisma.chat.findFirst({ where: { id: Number(chatId), tenantId: req.tenantId } })
    if (!chat) return res.status(404).json({ error: 'Chat not found' })

    // v0.1.21 — Reply lock TOTAL: belum di-Take → 403 (admin juga)
    if (!assertTaken(chat, res)) return

    // Lock: only the assigned CS or admin can reply
    if (chat.assignedToId && chat.assignedToId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'This chat is assigned to another agent. Release it first before replying.' })
    }

    // v3.9.14 — quote guard (spec §5.1): target ada + same chat+tenant + purged=false +
    // punya waMessageId nyata → selain itu 400 VALIDATION (JANGAN fake stanzaId)
    let quoteTarget = null
    if (replyToMessageId !== null) {
      const q = await resolveQuoteTarget(req.tenantId, chat.id, replyToMessageId)
      if (!q.ok) return res.status(q.status).json({ error: q.error })
      quoteTarget = q.message
    }

    // Personalization: replace {name} with contact name or remove if null
    let personalizedContent = content
    if (content.includes('{name}')) {
      const contactName = chat.contactName
      if (contactName && contactName.trim()) {
        personalizedContent = content.replace(/\{name\}/g, contactName)
      } else {
        // Remove {name} and clean up extra spaces
        personalizedContent = content.replace(/\{name\}/g, '')
        personalizedContent = personalizedContent.replace(/  +/g, ' ')
        personalizedContent = personalizedContent.replace(/\s+,/g, ',').replace(/\s+\./g, '.')
        personalizedContent = personalizedContent.trim()
      }
    }

    // Send via pool per-tenant (v3 — WA_DISABLED → error jelas)
    // v3.9 — ATURAN TUNGGAL reply: keluar via nomor ASAL chat (numberSlot);
    // slot mati → GAGAL dgn pesan jelas, JANGAN fallback ke nomor lain (owner 18:24).
    // v3.9.14 — quoted WAMessage minimal dari target row → Baileys contextInfo.
    const replySlot = Number(chat.numberSlot) || 0
    const quotedWaMessage = quoteTarget
      ? {
          key: {
            remoteJid: chat.waJid,
            fromMe: quoteTarget.direction === 'out',
            id: quoteTarget.waMessageId,
            ...(quoteTarget.participantJid ? { participant: quoteTarget.participantJid } : {}),
          },
          message: protoFromRow(quoteTarget),
        }
      : undefined
    let waSendError = null // v3.9 fix BUG-6: alasan gagal per-slot ke CS (bukan cuma di log)
    const waResult = await wa.sendMessageForTenant(req.tenantId, chat.waJid, personalizedContent, { slot: replySlot, quoted: quotedWaMessage }).catch((err) => {
      console.error('[Chats] WA send error (non-fatal, tetap simpan):', err.message)
      waSendError = err.message
      return null
    })
    // v3.9 — bila reply slot-0 juga gagal not-connected → pesan ke CS tetap jelas
    // (message tersimpan status 'failed' seperti pola existing; error jelas di log).

    // Save message to DB — v0.11.0: content dienkripsi at-rest
    // v3.9.14 — kolom quoted persist (snippet terenkripsi ≤200; survive purge asal)
    const message = await prisma.message.create({
      data: {
        tenantId: req.tenantId,
        chatId: chat.id,
        direction: 'out',
        content: encryptText(personalizedContent),
        senderName: req.user.username,
        senderId: req.user.id,
        waMessageId: waResult?.key?.id || null,
        status: waResult ? 'sent' : 'failed',
        ...(quoteTarget
          ? {
              quotedWaMessageId: quoteTarget.waMessageId,
              quotedParticipantJid: quoteTarget.participantJid || null,
              quotedSnippet: encryptText(quoteSnippetFromTarget(quoteTarget)),
              quotedType: quoteTarget.mediaType || 'text',
            }
          : {}),
      },
    })

    const now = message.timestamp
    let reopenedFromResolved = false

    // Auto-reopen: if chat is resolved and CS sends a reply, revert to open
    if (chat.status === 'resolved') {
      const newReopenedCount = (chat.reopenedCount || 0) + 1
      await prisma.chat.update({
        where: { id: chat.id },
        data: { status: 'open', resolvedAt: null, reopenedCount: newReopenedCount },
      })
      await prisma.chatEvent.create({
        data: { tenantId: req.tenantId, chatId: chat.id, userId: req.user.id, type: 'reopened', createdAt: now },
      })
      broadcast.emitToTenant(req.tenantId, 'chat_update', { chatId: chat.id, status: 'open', resolvedAt: null })
      reopenedFromResolved = true
    }

    // Record first response and increment counter
    // v0.11.0 — preview dienkripsi; broadcast/response membawa plaintext
    const chatUpdateData = {
      lastMessageAt: message.timestamp,
      lastMessagePreview: encryptText(personalizedContent),
      csMessagesSent: { increment: 1 },
    }
    if (!chat.firstResponseAt) {
      chatUpdateData.firstResponseAt = now
      chatUpdateData.firstResponseById = req.user.id
    }
    await prisma.chat.update({
      where: { id: chat.id },
      data: chatUpdateData,
    })

    if (!chat.firstResponseAt) {
      await prisma.chatEvent.create({
        data: { tenantId: req.tenantId, chatId: chat.id, userId: req.user.id, type: 'first_response', createdAt: now },
      })
    }

    // Broadcast to all clients (frontend dedup handles sender)
    // v0.11.0 — broadcast & response membawa PLAINTEXT (dekrip payload ciphertext)
    // v0.12.1 — payload bawa assignedToId & status chat (toast gate frontend);
    // sinkron dgn auto-reopen di atas (row `chat` bisa stale setelah update)
    const messageOut = stripRawQuotedColumns({ ...message, content: decContent(message.content) })
    messageOut.quoted = await buildQuotedPayload(message) // v3.9.14 — quoted shape (§6)
    broadcast.emitToTenant(req.tenantId, 'new_message', { chatId: chat.id, assignedToId: (reopenedFromResolved ? null : chat.assignedToId) ?? null, status: reopenedFromResolved ? 'open' : chat.status, message: messageOut })
    broadcast.emitToTenant(req.tenantId, 'chat_update', {
      chatId: chat.id,
      lastMessage: personalizedContent,
      lastMessageAt: message.timestamp,
    })

    // v0.12.9 — implied read: balasan agent = chat dibaca → receipt biru ke pelanggan
    // (fire-and-forget; gate AppConfig di dalam service, default OFF)
    receipts.markIncomingRead(req.tenantId, chat.id).catch(e => console.error('[Receipts] reply:', e.message))

    res.json({ message: messageOut, waError: waSendError || undefined }) // v3.9 fix BUG-6
  } catch (e) {
    console.error('Reply error:', e)
    res.status(500).json({ error: e.message || 'Internal server error' })
  }
})

// POST /api/chats/:id/media - send media reply
router.post('/:id/media', ...rt, upload.single('file'), async (req, res) => {
  try {
    const chatId = req.params.id

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' })
    }

    if (req.body.replyToMessageId !== undefined && req.body.replyToMessageId !== null && String(req.body.replyToMessageId).trim() !== '') {
      // v3.9.14 — quote reply via media TIDAK didukung P1 → 400 eksplisit (bukan silent ignore)
      return res.status(400).json({ error: 'Quote reply (replyToMessageId) belum didukung untuk media (P1) — kirim teks dengan quote, atau media tanpa quote' })
    }

    let caption = req.body.caption || null

    // Check chat exists FIRST (v0.1.21 — fix: chat dipakai sebelum di-fetch)
    const chat = await prisma.chat.findFirst({ where: { id: Number(chatId), tenantId: req.tenantId } })
    if (!chat) return res.status(404).json({ error: 'Chat not found' })

    // v0.1.21 — Reply lock TOTAL: belum di-Take → 403 (admin juga)
    if (!assertTaken(chat, res)) return

    // v0.1.21 — Lock: media juga cuma pemilik/admin
    if (chat.assignedToId && chat.assignedToId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'This chat is assigned to another agent. Release it first before replying.' })
    }

    // Personalization: replace {name} in caption with contact name or remove if null
    if (caption && caption.includes('{name}')) {
      const contactName = chat.contactName
      if (contactName && contactName.trim()) {
        caption = caption.replace(/\{name\}/g, contactName)
      } else {
        caption = caption.replace(/\{name\}/g, '')
        caption = caption.replace(/  +/g, ' ')
        caption = caption.replace(/\s+,/g, ',').replace(/\s+\./g, '.')
        caption = caption.trim() || null
      }
    }

    // Determine media type from mimetype
    const mimetype = req.file.mimetype
    const mediaType = mimetype.split('/')[0] // image, video, audio, application
    const ext = req.file.originalname.split('.').pop() || 'bin'

    // Save encrypted media to disk
    const mediaPath = await saveMedia(req.file.buffer, ext)

    // Decrypt to buffer for Baileys sending
    const buffer = loadMedia(mediaPath)

    // Send via pool per-tenant (v3 — WA_DISABLED → error jelas, message tetap disimpan)
    // v3.9 — reply media via nomor asal chat (numberSlot), tanpa fallback.
    let waResult
    let waMediaSendError = null // v3.9.2 — paritas BUG-6: alasan gagal per-slot ke CS
    const replySlotMedia = Number(chat.numberSlot) || 0
    try {
      waResult = await wa.sendMediaForTenant(
        req.tenantId,
        chat.waJid,
        buffer,
        mediaType === 'application' ? 'document' : mediaType,
        mimetype,
        caption,
        req.file.originalname,
        { slot: replySlotMedia }
      )
    } catch (sendErr) {
      console.error('[Chats] WA send media error:', sendErr.message)
      waMediaSendError = sendErr.message
      // Still save the message to DB even if WA send fails
      waResult = null
    }

    // Save message to DB — v0.11.0: caption (content) dienkripsi at-rest
    const message = await prisma.message.create({
      data: {
        tenantId: req.tenantId,
        chatId: chat.id,
        direction: 'out',
        content: encryptText(caption),
        mediaPath,
        mediaType: mediaType === 'application' ? 'document' : mediaType,
        mediaMime: mimetype,
        mediaSize: req.file.size,
        senderName: req.user.username,
        senderId: req.user.id,
        waMessageId: waResult?.key?.id || null,
        status: waResult ? 'sent' : 'failed',
      },
    })

    const now = message.timestamp
    let reopenedFromResolved = false

    // Auto-reopen: if chat is resolved and CS sends media, revert to open
    if (chat.status === 'resolved') {
      const newReopenedCount = (chat.reopenedCount || 0) + 1
      await prisma.chat.update({
        where: { id: chat.id },
        data: { status: 'open', resolvedAt: null, reopenedCount: newReopenedCount },
      })
      await prisma.chatEvent.create({
        data: { tenantId: req.tenantId, chatId: chat.id, userId: req.user.id, type: 'reopened', createdAt: now },
      })
      broadcast.emitToTenant(req.tenantId, 'chat_update', { chatId: chat.id, status: 'open', resolvedAt: null })
      reopenedFromResolved = true
    }

    // Record first response and increment counter
    const preview = caption || `[${mediaType === 'application' ? 'Document' : mediaType.charAt(0).toUpperCase() + mediaType.slice(1)}]`
    const chatUpdateData = {
      lastMessageAt: message.timestamp,
      lastMessagePreview: encryptText(preview),
      csMessagesSent: { increment: 1 },
    }
    if (!chat.firstResponseAt) {
      chatUpdateData.firstResponseAt = now
      chatUpdateData.firstResponseById = req.user.id
    }
    await prisma.chat.update({
      where: { id: chat.id },
      data: chatUpdateData,
    })

    if (!chat.firstResponseAt) {
      await prisma.chatEvent.create({
        data: { tenantId: req.tenantId, chatId: chat.id, userId: req.user.id, type: 'first_response', createdAt: now },
      })
    }

    // Broadcast to all clients
    // v0.11.0 — broadcast & response membawa PLAINTEXT (dekrip payload ciphertext)
    // v0.12.1 — payload bawa assignedToId & status chat (toast gate frontend);
    // sinkron dgn auto-reopen di atas (row `chat` bisa stale setelah update)
    const messageOut = stripRawQuotedColumns({ ...message, content: decContent(message.content) })
    messageOut.quoted = null // v3.9.14 — media P1 tanpa quote
    broadcast.emitToTenant(req.tenantId, 'new_message', { chatId: chat.id, assignedToId: (reopenedFromResolved ? null : chat.assignedToId) ?? null, status: reopenedFromResolved ? 'open' : chat.status, message: messageOut })
    broadcast.emitToTenant(req.tenantId, 'chat_update', {
      chatId: chat.id,
      lastMessage: preview,
      lastMessageAt: message.timestamp,
    })

    // v0.12.9 — implied read (media reply, sama dgn reply teks)
    receipts.markIncomingRead(req.tenantId, chat.id).catch(e => console.error('[Receipts] media:', e.message))

    res.json({ message: messageOut, waError: waMediaSendError || undefined }) // v3.9 fix BUG-6 (media)
  } catch (e) {
    console.error('Media reply error:', e)
    res.status(500).json({ error: e.message || 'Internal server error' })
  }
})

// POST /api/chats/:id/read - mark as read
router.post('/:id/read', ...rt, async (req, res) => {
  try {
    const chatId = req.params.id
    const chat = await prisma.chat.findFirst({ where: { id: Number(chatId), tenantId: req.tenantId } })
    if (!chat) return res.status(404).json({ error: 'Chat not found' })

    // v0.1.21 — isolasi: hanya yang bisa akses chat boleh mark read
    if (!canAccessChat(req.user, chat)) {
      return accessDenied(res)
    }

    const updatedChat = await prisma.chat.update({
      where: { id: chat.id },
      data: { unreadCount: 0 },
    })

    // v0.12.9 — Read receipt via receipts service: kirim receipt utk SEMUA pesan
    // masuk chat ini yang belum di-receipt (idempoten, gate AppConfig admin).
    // Replaces call lama sock.sendReadReceipt(chatId, undefined, []) — method itu
    // gak exist di Baileys v6 + array kosong → error ditelan catch {} = no-op total.
    try {
      await receipts.markIncomingRead(req.tenantId, chat.id)
    } catch (e) { console.error('[Receipts] /read error:', e.message) }

    broadcast.emitToTenant(req.tenantId, 'chat_update', { chatId: chat.id, unreadCount: 0 })
    res.json({ chat })
  } catch (e) {
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/chats/:id/resolve - mark chat as resolved
router.post('/:id/resolve', ...rt, async (req, res) => {
  try {
    const chatId = req.params.id

    const chat = await prisma.chat.findFirst({ where: { id: Number(chatId), tenantId: req.tenantId } })
    if (!chat) return res.status(404).json({ error: 'Chat not found' })

    // Only the assigned CS (owner) or admin can resolve
    if (chat.assignedToId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only the assigned agent or admin can resolve this chat' })
    }

    // v3.9.8 — safety net: chat LIMBO (awaiting) di-resolve → bersihkan state menu
    const limboClear = chat.menuState === 'awaiting' ? { menuState: 'done', menuRequestedAt: null } : {}
    const updated = await prisma.chat.update({
      where: { id: chat.id },
      data: { status: 'resolved', resolvedAt: new Date(), resolvedById: req.user.id, messagesBeforeResolve: chat.csMessagesSent || 0, ...limboClear },
      include: {
        assignedTo: { select: { id: true, username: true } },
        tags: { include: { tag: true } },
      },
    })

    await prisma.chatEvent.create({
      data: { tenantId: req.tenantId, chatId: chat.id, userId: req.user.id, type: 'resolved' },
    })

    // v3.9.8b (audit LOW-1) — bila limbo ikut dibersihkan, refresh chip count realtime
    if (limboClear && Object.keys(limboClear).length) {
      broadcast.emitToTenant(req.tenantId, 'menu_waiting_update', { count: await menuGateway.countWaiting(req.tenantId) })
    }

    // v0.10.0 — Fitur A: resolve chat yang sedang snooze → snooze ikut dibersihkan
    if (chat.snoozedUntil) {
      await prisma.chat.update({
        where: { id: chat.id },
        data: { snoozedUntil: null, snoozedBy: null },
      })
    }

    // v0.10.0 — Fitur C (HOOK RESOLVE → CSAT): satu-satunya titik sentuh logika
    // resolve yang spec izinkan (spec §3). Fire-and-forget: error CSAT TIDAK
    // pernah menggagalkan resolve. Kalau config OFF → tidak kirim apa pun.
    csat.createSurveyAfterResolve(updated, req.user.id).catch((e) =>
      console.error('[Resolve] CSAT hook error (non-fatal):', e.message)
    )

    broadcast.emitToTenant(req.tenantId, 'chat_update', {
      chatId: chat.id,
      status: 'resolved',
      resolvedAt: updated.resolvedAt,
      resolvedById: req.user.id, // v0.1.21 — frontend reaksi resolved per-user
      snoozedUntil: null, // v0.10.0 — informasikan snooze clear
    })

    res.json({ chat: updated })
  } catch (e) {
    console.error('Resolve error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/chats/:id/tags - list tags for a chat
router.get('/:id/tags', ...rt, async (req, res) => {
  try {
    const chatId = req.params.id
    const chatTags = await prisma.chatTag.findMany({
      where: { chatId: Number(chatId), tag: { tenantId: req.tenantId } },
      include: { tag: true },
    })
    res.json({ tags: chatTags.map(ct => ct.tag) })
  } catch (e) {
    console.error('List chat tags error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/chats/:id/tags - add tag to chat
router.post('/:id/tags', ...rt, async (req, res) => {
  try {
    const chatId = req.params.id
    const { tagId } = req.body
    if (!tagId) {
      return res.status(400).json({ error: 'tagId is required' })
    }

    const chat = await prisma.chat.findFirst({ where: { id: Number(chatId), tenantId: req.tenantId } })
    if (!chat) return res.status(404).json({ error: 'Chat not found' })

    if (chat.assignedToId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only the assigned agent or admin can tag this chat' })
    }

    const tag = await prisma.tag.findFirst({ where: { id: parseInt(tagId, 10), tenantId: req.tenantId } })
    if (!tag) return res.status(404).json({ error: 'Tag not found' })

    try {
      await prisma.chatTag.create({
        data: { chatId: chat.id, tagId: parseInt(tagId, 10) },
      })
    } catch (e) {
      // Already exists - fine
    }

    // Broadcast tag change to all clients
    broadcast.emitToTenant(req.tenantId, 'chat_update', { chatId: chat.id, tagAdded: tag })

    res.status(201).json({ tag })
  } catch (e) {
    console.error('Add chat tag error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/chats/:id/tags/:tagId - remove tag from chat
router.delete('/:id/tags/:tagId', ...rt, async (req, res) => {
  try {
    const { id: chatId, tagId } = req.params

    const chat = await prisma.chat.findFirst({ where: { id: Number(chatId), tenantId: req.tenantId } })
    if (!chat) return res.status(404).json({ error: 'Chat not found' })

    if (chat.assignedToId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only the assigned agent or admin can remove tags from this chat' })
    }

    await prisma.chatTag.delete({
      where: { chatId_tagId: { chatId: chat.id, tagId: parseInt(tagId, 10) } },
    })

    // Broadcast tag removal to all clients
    broadcast.emitToTenant(req.tenantId, 'chat_update', { chatId: chat.id, tagRemoved: parseInt(tagId, 10) })

    res.json({ success: true })
  } catch (e) {
    console.error('Remove chat tag error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ═══ v3.6 — Hapus Chat Individual (permanen) dari kebab menu ═══

// v3.6 — helper GroupPic (best-effort): model tidak ada di schema v3.x (PIC grup
// disimpan sebagai kolom Chat.picUserId yang ikut kehapus saat chat.delete).
// Spec §1 minta deleteMany dulu kalau ada — implement via introspection table
// SQLite + dynamic model access (CACHING: cek sqlite_master SEKALI per proses,
// bukan per request; schema tidak berubah saat runtime di SQLite).
let _groupPicTableExists = null
async function deleteGroupPicsForChat(chatId) {
  try {
    if (_groupPicTableExists === null) {
      const rows = await prisma.$queryRawUnsafe(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('GroupPic','group_pics')"
      )
      _groupPicTableExists = Array.isArray(rows) && rows.length > 0 ? String(rows[0].name) : false
    }
    if (!_groupPicTableExists) return 0
    const n = await prisma[_groupPicTableExists === 'GroupPic' ? 'groupPic' : 'group_pics'].deleteMany({ where: { chatId } })
    return n?.count || 0
  } catch (e) {
    console.error('[Chats] deleteGroupPicsForChat (best-effort) gagal:', e.message)
    return 0
  }
}

// Spec: docs/spec-v3.6-delete-chat-individual.md + v3.7 — ADMIN ONLY (CS tidak
// boleh hapus permanen; super_admin via impersonation ?tenant= boleh).
// Logika = PORT dari one-off script teruji (chat #7635, 2026-09-23 02:52).
// Urutan: groupPic (PIC ref) dulu → kumpulkan mediaPath → transaksi hapus
// child rows (FavoriteMessage ikut cascade via onDelete: Cascade di schema,
// diverifikasi prisma/schema.prisma model FavoriteMessage.message) → purgeLog
// → file media di-disk SETELAH transaksi sukses → broadcast 'chat_deleted'.
// TANPA perubahan skema (pure route) — schema v3.x frozen.
router.delete('/:id', ...rt, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid chat id' })

    // 1) Isolasi tenant: chat harus milik tenant ini (super_admin impersonate
    //    ?tenant= juga tervalidasi requireTenant via rt).
    const chat = await prisma.chat.findUnique({ where: { id }, select: { id: true, tenantId: true } })
    if (!chat || chat.tenantId !== req.tenantId) {
      return res.status(404).json({ error: 'Chat not found' })
    }

    const deleteContact = req.query.deleteContact === 'true' // v3.7 — default (absent/false) = KONTAK DIPERTAHANKAN (detach)
    // 2) GroupPic rows yang nge-refer chat ini dihapus dulu supaya FK
    //    "groupPics" (User.groupsAsPic → Chat.picUserId) tidak memblokir kalau
    //    chat ini PIC grup. Cache table-existence (cold-start sekali/proses) —
    //    schema v3.x tidak punya model GroupPic; kalau schema di masa depan
    //    menambah model itu, route ini otomatis ikut membersihkannya tanpa
    //    perubahan kode (route tetap jalan normal kalau tabel tidak ada).
    const groupPicDeleted = await deleteGroupPicsForChat(chat.id)

    // 3) Kumpulkan mediaPath SEBELUM hapus (path cuma ada di DB)
    const mediaFiles = (
      await prisma.message.findMany({
        where: { tenantId: req.tenantId, chatId: chat.id, mediaPath: { not: null } },
        select: { mediaPath: true },
      })
    ).map((m) => m.mediaPath).filter(Boolean)

    // 4) Hitung counts utk response + purgeLog (sebelum row terhapus)
    const [messageCount, chatEventCount, chatNoteCount, csatSurveyCount, scheduledMessageCount, chatTagCount] = await Promise.all([
      prisma.message.count({ where: { chatId: chat.id } }),
      prisma.chatEvent.count({ where: { chatId: chat.id } }),
      prisma.chatNote.count({ where: { chatId: chat.id } }),
      prisma.csatSurvey.count({ where: { chatId: chat.id } }),
      prisma.scheduledMessage.count({ where: { chatId: chat.id } }),
      prisma.chatTag.count({ where: { chatId: chat.id } }),
    ])

    // Transaksi: child rows by chatId → chat row. FavoriteMessage TIDAK dihapus
    // eksplisit — onDelete: Cascade di relasi Message.favorites (schema v3.x)
    // menghapusnya otomatis saat message.deleteMany (VERIFIKASI schema §1 spec).
    // v3.7 — mode Hapus Chat: kontak IKUT TERHAPUS (deleteContact=true, behavior
    // v3.6) atau DIPERTAHANKAN (detach: chatId=null, data kontak utuh — nama,
    // nomor, tag; re-link otomatis via contactRelink kalau chat dibuka lagi).
    const deleted = await prisma.$transaction(async (tx) => {
      const ops = [
        ['messages', () => tx.message.deleteMany({ where: { chatId: chat.id } })], // FavoriteMessage cascade
        ['chatEvents', () => tx.chatEvent.deleteMany({ where: { chatId: chat.id } })],
        ['chatTags', () => tx.chatTag.deleteMany({ where: { chatId: chat.id } })],
        ['chatNotes', () => tx.chatNote.deleteMany({ where: { chatId: chat.id } })],
        ['csatSurveys', () => tx.csatSurvey.deleteMany({ where: { chatId: chat.id } })],
        ['scheduledMessages', () => tx.scheduledMessage.deleteMany({ where: { chatId: chat.id } })],
        deleteContact
          ? // v3.6 behavior: kontak linked ikut terhapus total
            // v3.9.2 K1-A (C.8) — kontak dihapus HANYA bila dia TIDAK link ke chat
            // lain milik slot lain (1 identity per orang — jangan buang identitas).
            // Chat 1:1 nomor sama di slot lain = kontak masih dibutuhkan.
            ['contacts', () => deleteContactOnlyIfNotShared(tx, req.tenantId, chat.id)]
          : // v3.7 KEEP: DETACH — kontak utuh (nama, nomor, tag) tapi lepas dari chat
            // v3.9.2 K1-A — detach HANYA bila kontak gak link ke chat lain (slot lain):
            // kalau masih link → primary pindah ke chat sisanya (jangan jadi orphan).
            ['contacts', () => detachContactKeepIdentity(tx, req.tenantId, chat.id)],
        ['chats', () => tx.chat.delete({ where: { id: chat.id } })],
      ]
      const result = {}
      for (const [name, op] of ops) {
        const r = await op()
        result[name] = typeof r?.count === 'number' ? r.count : 1
      }
      return result
    })

    // 5) purgeLog — audit trail purge (chatCount 1 — satu chat)
    await prisma.purgeLog.create({
      data: {
        tenantId: req.tenantId,
        purgedById: req.user.id,
        chatCount: 1,
        messageCount,
        reason: `chat_delete: kebab menu (v3.7, contact ${deleteContact ? 'deleted' : 'kept'})${req.body?.reason ? ` — ${String(req.body.reason).slice(0, 200)}` : ''}`,
        purgeDate: new Date(),
      },
    })

    // 6) File media di-disk SETELAH transaksi sukses (transaksi gagal → file utuh)
    let filesRemoved = 0
    for (const fp of mediaFiles) {
      const abs = resolveMediaFilePath(fp) // v3.9.12 — relatif/absolut lintas-host
      try {
        if (abs && fs.existsSync(abs)) {
          fs.unlinkSync(abs)
          filesRemoved++
        }
      } catch {}
    }

    // 7) Broadcast event BARU 'chat_deleted' (jangan recycle chats_purged)
    broadcast.emitToTenant(req.tenantId, 'chat_deleted', { chatId: chat.id })

    console.log(`[Chats] Chat #${chat.id} dihapus permanen (kebab menu v3.7, contact ${deleteContact ? 'deleted' : 'kept'}) by @${req.user.username} (tenant ${req.tenantId}):`, JSON.stringify({ ...deleted, groupPicDeleted, filesRemoved }))

    // 8) Response ringkas: counts hasil hapus + flag mode kontak (QA-friendly)
    res.json({ ok: true, deleteContact, deleted: { ...deleted, groupPic: groupPicDeleted, filesRemoved } })
  } catch (e) {
    console.error('Delete chat error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ─── Favorite endpoints ─────────────────────────────────────────

// POST /api/chats/:chatId/messages/:msgId/favorite — toggle favorite
router.post('/:chatId/messages/:msgId/favorite', ...rt, async (req, res) => {
  try {
    const { chatId, msgId } = req.params
    const userId = req.user.id
    const messageId = parseInt(msgId, 10)
    if (isNaN(messageId)) return res.status(400).json({ error: 'Invalid message ID' })

    // Check message exists and belongs to this chat (tenant-scoped)
    const msg = await prisma.message.findFirst({
      where: { id: messageId, tenantId: req.tenantId, chatId: Number(chatId) },
    })
    if (!msg) return res.status(404).json({ error: 'Message not found' })

    // Check if already favorited by this user
    const existing = await prisma.favoriteMessage.findUnique({
      where: { messageId_userId: { messageId, userId } },
    })

    if (existing) {
      // Toggle off — remove favorite
      await prisma.favoriteMessage.delete({
        where: { id: existing.id },
      })
      res.json({ favorited: false })
    } else {
      // Add favorite
      await prisma.favoriteMessage.create({
        data: { messageId, userId, chatId: Number(chatId) },
      })
      res.json({ favorited: true })
    }
  } catch (e) {
    console.error('Toggle favorite error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/chats/:id/favorites — list favorited messages in a chat
router.get('/:id/favorites', ...rt, async (req, res) => {
  try {
    const chatId = req.params.id
    const chat = await prisma.chat.findFirst({ where: { id: Number(chatId), tenantId: req.tenantId } })
    if (!chat) return res.status(404).json({ error: 'Chat not found' })
    if (!canAccessChat(req.user, chat)) {
      return accessDenied(res)
    }
    const favorites = await prisma.favoriteMessage.findMany({
      where: { chatId: chat.id, userId: req.user.id },
      include: {
        message: {
          select: {
            id: true, chatId: true, direction: true, content: true,
            mediaType: true, mediaMime: true, senderName: true, senderId: true,
            timestamp: true, status: true, purged: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    })
    // v0.11.0 — favorites panel: dekrip content on-the-fly
    for (const f of favorites) {
      if (f.message && f.message.content != null) f.message.content = decryptTextSafe(f.message.content)
    }
    res.json({ favorites })
  } catch (e) {
    console.error('List favorites error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})





// GET /api/chats/:id/search?q=searchterm
router.get('/:id/search', ...rt, async (req, res) => {
  try {
    const chatId = req.params.id
    const q = req.query.q
    if (!q || q.trim().length < 2) {
      return res.json({ messages: [], total: 0 })
    }

    // v0.1.21 — isolasi: hanya yang bisa akses chat
    const chat = await prisma.chat.findFirst({ where: { id: Number(chatId), tenantId: req.tenantId } })
    if (!chat) return res.status(404).json({ error: 'Chat not found' })
    if (!canAccessChat(req.user, chat)) {
      return accessDenied(res)
    }

    // v0.11.0 — In-chat search: SQL LIKE gak bisa di ciphertext → fetch pesan
    // chat ini (terbaru 5000), dekrip in-memory, filter di aplikasi.
    const candidates = await prisma.message.findMany({
      where: {
        tenantId: req.tenantId,
        chatId: chat.id,
        purged: false,
        content: { not: null },
      },
      orderBy: { timestamp: 'desc' },
      take: 5000,
    })
    const qLower = q.trim().toLowerCase()
    const messages = []
    for (const msg of candidates) {
      if (msg.content == null) continue
      const plain = decryptTextSafe(msg.content)
      if (typeof plain !== 'string' || !plain.toLowerCase().includes(qLower)) continue
      msg.content = plain
      messages.push(msg)
      if (messages.length >= 50) break
    }

    res.json({ messages: messages.reverse(), total: messages.length })
  } catch (e) {
    console.error('Search messages error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
