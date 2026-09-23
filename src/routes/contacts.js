const express = require('express')
const router = express.Router()
const multer = require('multer')
const prisma = require('../prisma')
const { requireAuth, requireAdmin, requireTenant } = require('../auth')
const broadcast = require('../socket/broadcast')
const queue = require('../socket/queue')
// v3.4 — kuota kontak per-tenant (spec §4)
const plans = require('../services/plans')
// v3.7 — anti-duplicate re-link kontak orphan (helper shared C1–C4)
const { relinkOrphanContact } = require('../utils/contactRelink')

// v3.0 — Isolasi tenant: kontak = tenant-scoped; chat find-or-create by [tenantId, waJid]
const rt = [requireAuth, requireTenant]

// Multer config for CSV uploads — in-memory, 5MB max
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
})

// ─── Helpers ──────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function normalizePhone(raw) {
  if (!raw) return { normalized: '', valid: false, reason: 'Empty' }
  let phone = String(raw).replace(/[\s\-().]/g, '')
  if (phone.startsWith('+')) phone = phone.slice(1)
  if (phone.startsWith('0')) phone = '62' + phone.slice(1)
  if (phone.startsWith('8') && phone.length >= 8 && !phone.startsWith('62')) {
    phone = '62' + phone
  }
  if (!/^\d+$/.test(phone)) {
    return { normalized: '', valid: false, reason: 'Contains non-digit characters' }
  }
  if (!phone.startsWith('62')) {
    if (phone.length < 8) return { normalized: '', valid: false, reason: 'Too short' }
  } else {
    if (phone.length < 10) return { normalized: '', valid: false, reason: 'Too short (min 8 digits after 62)' }
  }
  if (phone.length > 15) return { normalized: '', valid: false, reason: 'Too long' }
  return { normalized: phone, valid: true, reason: '' }
}

function isLidDigits(chatId) {
  if (!chatId) return false
  return chatId.endsWith('@lid')
}

function csvEscape(value) {
  if (value === null || value === undefined) return ''
  const str = String(value)
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

function formatDateLocal(d) {
  if (!d) return ''
  const date = new Date(d)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function parseDateInput(value) {
  if (!value) return null
  if (!DATE_RE.test(value)) return null
  const d = new Date(value + 'T00:00:00')
  if (Number.isNaN(d.getTime())) return null
  return d
}

function normalizeGender(value) {
  if (!value) return null
  const v = String(value).trim().toLowerCase()
  if (['male', 'm', 'laki-laki', 'laki', 'l'].includes(v)) return 'male'
  if (['female', 'f', 'perempuan', 'p', 'wanita'].includes(v)) return 'female'
  return null
}

function chatInclude() {
  return {
    select: {
      id: true,
      status: true,
      lastMessageAt: true,
      unreadCount: true,
      reopenedCount: true, // v0.15.2 — dipakai hitung reopen di /open (linked branch)
      assignedTo: { select: { id: true, username: true } },
      tags: { include: { tag: true } },
    },
  }
}

// v0.15.2 — include-shape untuk re-fetch chat (response /open + findChatByPhone).
// SEBELUMNYA BUG SILENT: `include: chatInclude().include` = undefined (chatInclude
// berbentuk {select}) → prisma mengembalikan chat TANPA relasi → response /open
// tidak pernah memuat assignedTo/tags sejak perubahan bentuk chatInclude.
// CHAT_FETCH_INCLUDE = relasi yang dibutuhkan response (semua scalar tetap ikut,
// karena include semantics).
const CHAT_FETCH_INCLUDE = {
  assignedTo: { select: { id: true, username: true } },
  tags: { include: { tag: true } },
}

// ─── v3.5 — Helper lookup dua arah (spec §4) ─────────────────────────
/**
 * Cari chat existing by waJid → phoneJid → lidJid (urut id asc utk deterministik).
 * Return row Chat pertama yang cocok, atau null. Semua tenant-scoped.
 */
async function findChatByAnyJid(tenantId, phoneJidOrLid) {
  const jid = String(phoneJidOrLid || '')
  if (!jid) return null
  return (
    (await prisma.chat.findUnique({
      where: { tenantId_waJid: { tenantId, waJid: jid } },
    })) ||
    (await prisma.chat.findFirst({ where: { tenantId, phoneJid: jid }, orderBy: { id: 'asc' } })) ||
    (await prisma.chat.findFirst({ where: { tenantId, lidJid: jid }, orderBy: { id: 'asc' } })) ||
    null
  )
}

function contactToJson(contact) {
  return {
    id: contact.id,
    name: contact.name,
    phone: contact.phone,
    chatId: contact.chatId,
    birthDate: contact.birthDate,
    gender: contact.gender,
    city: contact.city,
    note: contact.note,
    source: contact.source,
    createdAt: contact.createdAt,
    updatedAt: contact.updatedAt,
    chat: contact.chat
      ? {
          id: contact.chat.id,
          status: contact.chat.status,
          lastMessageAt: contact.chat.lastMessageAt,
          unreadCount: contact.chat.unreadCount,
          assignedTo: contact.chat.assignedTo,
          tags: contact.chat.tags,
        }
      : null,
  }
}

// Find existing contact by phone or chatId (used by import + open) — tenant-scoped
async function findExistingContactByPhone(tenantId, phone) {
  if (!phone) return null
  return prisma.contact.findFirst({
    where: { tenantId, phone },
    include: { chat: chatInclude() },
  })
}

async function findChatByPhone(tenantId, phone) {
  if (!phone) return null
  const jid = `${phone}@s.whatsapp.net`
  const chat = await prisma.chat.findUnique({
    where: { tenantId_waJid: { tenantId, waJid: jid } },
    include: CHAT_FETCH_INCLUDE,
  })
  return chat
}

async function buildChatFromContact(contact) {
  if (contact.chat) {
    return {
      id: contact.chat.id,
      status: contact.chat.status,
      lastMessageAt: contact.chat.lastMessageAt,
      unreadCount: contact.chat.unreadCount,
      assignedTo: contact.chat.assignedTo,
      tags: contact.chat.tags,
    }
  }
  return null
}

async function autoLinkContactChatByPhone(contact) {
  if (contact.chatId) return contact
  if (!contact.phone) return contact
  const chat = await findChatByPhone(contact.tenantId, contact.phone)
  if (!chat) return contact
  const linked = await prisma.contact.update({
    where: { id: contact.id },
    data: { chatId: chat.id },
    include: { chat: chatInclude() },
  })
  // v0.14.6 — nama manual menang di display (chatlist/header) setelah link:
  // chat.contactName = nama kontak (fix "edit nama gak ke-refleksi", lapor 15:27)
  if (linked.name) {
    await prisma.chat.updateMany({
      where: { id: chat.id },
      data: { contactName: linked.name },
    })
    broadcast.emitToTenant(contact.tenantId, 'chat_update', { chatId: chat.id, contactName: linked.name })
  }
  return linked
}

// ─── GET /api/contacts — list + search + pagination ────────────────────
router.get('/', ...rt, async (req, res) => {
  try {
    const q = (req.query.q || '').trim()
    const page = Math.max(1, parseInt(req.query.page || '1', 10))
    const pageSize = 20

    const where = { tenantId: req.tenantId }
    // v0.13.4 HOTFIX (Alita review) — list endpoint WAJIB honor tagId: frontend chip
    // filter kirim ?tagId= ke endpoint ini, tapi sebelumnya hanya /export yang
    // memfilter → chip filter tidak berfungsi (silent ignore). Chip filter = semua
    // role (spec §B), jadi TIDAK admin-only (beda dgn export).
    if (req.query.tagId !== undefined && req.query.tagId !== '') {
      const tagId = parseInt(req.query.tagId, 10)
      if (!Number.isInteger(tagId) || tagId <= 0) {
        return res.status(400).json({ error: 'tagId tidak valid' })
      }
      const tag = await prisma.tag.findFirst({ where: { id: tagId, tenantId: req.tenantId } })
      if (!tag) {
        return res.status(404).json({ error: 'Tag tidak ditemukan' })
      }
      where.tags = { some: { tagId } }
    }
    if (q) {
      // SQLite (Prisma 5.10) gak support mode: 'insensitive' — pakai LOWER-based raw OR buat case-insensitive search
      const qLower = q.toLowerCase()
      where.OR = [
        { name: { contains: q } },
        { name: { contains: qLower } },
        { name: { contains: q.toUpperCase() } },
        { phone: { contains: q } },
        { phone: { contains: qLower } },
        { city: { contains: q } },
        { city: { contains: qLower } },
        { note: { contains: q } },
        { note: { contains: qLower } },
      ]
    }

    const [contacts, total] = await Promise.all([
      prisma.contact.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { chat: chatInclude() },
      }),
      prisma.contact.count({ where }),
    ])

    res.json({
      contacts: contacts.map(contactToJson),
      total,
      page,
    })
  } catch (e) {
    console.error('List contacts error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ─── POST /api/contacts — manual create ────────────────────────────────
router.post('/', ...rt, async (req, res) => {
  try {
    const { name, phone, note, birthDate, gender, city } = req.body

    let normalized = null
    if (phone) {
      const norm = normalizePhone(phone)
      if (!norm.valid) {
        return res.status(400).json({ error: `Nomor tidak valid: ${norm.reason}` })
      }
      normalized = norm.normalized
      const existing = await prisma.contact.findFirst({ where: { tenantId: req.tenantId, phone: normalized } })
      if (existing) {
        return res.status(409).json({ error: 'Kontak dengan nomor ini sudah ada' })
      }
    }

    // v3.4 — kuota kontak per-tenant (spec §4): cek SEBELUM create
    const quota = await plans.checkContactQuota(req.tenantId)
    if (!quota.ok) {
      return res.status(403).json({ error: plans.contactQuotaMessage(quota.count, quota.max) })
    }

    const parsedBirth = parseDateInput(birthDate)
    const validGender = normalizeGender(gender)
    if (gender !== undefined && gender !== null && gender !== '' && validGender === null) {
      return res.status(400).json({ error: 'Gender harus male/female' })
    }
    if (birthDate !== undefined && birthDate !== null && birthDate !== '' && parsedBirth === null) {
      return res.status(400).json({ error: 'Format tanggal lahir harus YYYY-MM-DD' })
    }

    const contact = await prisma.contact.create({
      data: {
        tenantId: req.tenantId,
        name: name || null,
        phone: normalized,
        note: note || null,
        birthDate: parsedBirth,
        gender: validGender,
        city: city || null,
        source: 'manual',
      },
      include: { chat: chatInclude() },
    })

    res.status(201).json({ contact: contactToJson(contact) })
  } catch (e) {
    console.error('Create contact error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ─── GET /api/contacts/by-chat/:chatId — get or create by chat ─────────
router.get('/by-chat/:chatId', ...rt, async (req, res) => {
  try {
    const chat = await prisma.chat.findFirst({ where: { id: Number(req.params.chatId), tenantId: req.tenantId } })
    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' })
    }

    let contact = await prisma.contact.findUnique({
      where: { chatId: chat.id },
      include: { chat: chatInclude() },
    })

    if (!contact) {
      const phoneNorm = normalizePhone(chat.contactPhone)
      const phone = phoneNorm.valid && !isLidDigits(chat.waJid) ? phoneNorm.normalized : null
      // v3.7 — ANTI-DOBEL: sebelum create, re-link kontak orphan (chatId=null,
      // data utuh — mis. hasil "Hapus Chat" mode keep) dgn nomor yang sama.
      const relinked = phone ? await relinkOrphanContact(req.tenantId, phone, chat.id, chat.contactName || null) : null
      if (relinked) {
        contact = await prisma.contact.findUnique({
          where: { chatId: chat.id },
          include: { chat: chatInclude() },
        })
      }
      if (!contact) {
        contact = await prisma.contact.create({
          data: {
            tenantId: req.tenantId,
            chatId: chat.id,
            phone,
            name: chat.contactName || null,
            source: 'chat',
          },
          include: { chat: chatInclude() },
        })
      }
    }

    res.json({ contact: contactToJson(contact) })
  } catch (e) {
    console.error('Get or create contact by chat error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ─── PUT /api/contacts/:id — edit all fields ───────────────────────────
router.put('/:id', ...rt, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: 'Invalid contact ID' })
    }

    const existing = await prisma.contact.findFirst({ where: { id, tenantId: req.tenantId } })
    if (!existing) {
      return res.status(404).json({ error: 'Contact not found' })
    }

    const { name, phone, note, birthDate, gender, city } = req.body

    let normalized = existing.phone
    if (phone !== undefined && phone !== existing.phone) {
      if (phone) {
        const norm = normalizePhone(phone)
        if (!norm.valid) {
          return res.status(400).json({ error: `Nomor tidak valid: ${norm.reason}` })
        }
        normalized = norm.normalized
      } else {
        normalized = null
      }
    }

    const parsedBirth = birthDate === '' || birthDate === null || birthDate === undefined
      ? null
      : parseDateInput(birthDate)
    if (birthDate && parsedBirth === null) {
      return res.status(400).json({ error: 'Format tanggal lahir harus YYYY-MM-DD' })
    }
    const validGender = gender === undefined ? existing.gender : normalizeGender(gender)
    if (gender !== undefined && gender !== null && gender !== '' && validGender === null) {
      return res.status(400).json({ error: 'Gender harus male/female' })
    }

    const data = {
      name: name !== undefined ? (name || null) : existing.name,
      phone: normalized,
      note: note !== undefined ? (note || null) : existing.note,
      birthDate: birthDate === undefined ? existing.birthDate : parsedBirth,
      gender: validGender,
      city: city !== undefined ? (city || null) : existing.city,
    }

    const updated = await prisma.contact.update({
      where: { id },
      data,
      include: { chat: chatInclude() },
    })

    // v0.14.6 — sync nama manual ke display cache: chatlist & chat header baca
    // chat.contactName (denormalized). Tanpa ini edit nama gak pernah kelihatan
    // (lapor Kanaka 15:27). Nama manual = override otoritatif; null = kosongkan
    // (WA notify boleh isi ulang lewat guard contacts.upsert).
    if (updated.chatId) {
      await prisma.chat.updateMany({
        where: { id: updated.chatId },
        data: { contactName: updated.name },
      })
      broadcast.emitToTenant(req.tenantId, 'chat_update', { chatId: updated.chatId, contactName: updated.name })
    }

    // If phone was added/changed and there is no linked chat, try to link
    if (!updated.chatId && updated.phone) {
      const linked = await autoLinkContactChatByPhone(updated)
      return res.json({ contact: contactToJson(linked) })
    }

    res.json({ contact: contactToJson(updated) })
  } catch (e) {
    console.error('Update contact error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ─── DELETE /api/contacts/:id — admin only ─────────────────────────────
router.delete('/:id', ...rt, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: 'Invalid contact ID' })
    }

    const existing = await prisma.contact.findFirst({ where: { id, tenantId: req.tenantId } })
    if (!existing) {
      return res.status(404).json({ error: 'Contact not found' })
    }

    await prisma.contact.delete({ where: { id } })
    res.json({ success: true })
  } catch (e) {
    console.error('Delete contact error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ─── GET /api/contacts/export — CSV download ──────────────────────────
// v0.13.4 — param tagId (ADMIN ONLY): filter kontak by tag (via ContactTag).
// Tanpa param → perilaku existing utuh (semua role, tanpa filter).
router.get('/export', ...rt, async (req, res) => {
  try {
    const where = { tenantId: req.tenantId }
    if (req.query.tagId !== undefined && req.query.tagId !== '') {
      if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin only' })
      }
      const tagId = parseInt(req.query.tagId, 10)
      if (!Number.isInteger(tagId) || tagId <= 0) {
        return res.status(400).json({ error: 'tagId tidak valid' })
      }
      const tag = await prisma.tag.findFirst({ where: { id: tagId, tenantId: req.tenantId } })
      if (!tag) {
        return res.status(404).json({ error: 'Tag tidak ditemukan' })
      }
      where.tags = { some: { tagId } }
    }
    const contacts = await prisma.contact.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      include: { chat: chatInclude() },
    })

    const header = 'name,phone,birth_date,gender,city,note,source,chat_id,last_active_at\n'
    const rows = contacts.map((c) => {
      const name = csvEscape(c.name || '')
      const phone = csvEscape(c.phone || '')
      const birth = csvEscape(formatDateLocal(c.birthDate))
      const gender = csvEscape(c.gender || '')
      const city = csvEscape(c.city || '')
      const note = csvEscape(c.note || '')
      const source = csvEscape(c.source || '')
      const chatId = csvEscape(c.chatId || '')
      const lastActive = csvEscape(formatDateLocal(c.chat?.lastMessageAt || null))
      return `${name},${phone},${birth},${gender},${city},${note},${source},${chatId},${lastActive}`
    })

    const csv = header + rows.join('\n')

    const filename = (req.query.tagId !== undefined && req.query.tagId !== '')
      ? `contacts-tag-${req.query.tagId}.csv`
      : 'contacts.csv'
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(csv)
  } catch (e) {
    console.error('Contact export error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ─── POST /api/contacts/import — CSV upload ───────────────────────────
router.post('/import', ...rt, csvUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No CSV file uploaded' })
    }

    const ext = req.file.originalname.split('.').pop().toLowerCase()
    if (ext !== 'csv' && !req.file.mimetype.includes('csv') && !req.file.mimetype.includes('text')) {
      return res.status(400).json({ error: 'File must be a CSV' })
    }

    const csvText = req.file.buffer.toString('utf-8')
    const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0)
    if (lines.length === 0) {
      return res.status(400).json({ error: 'CSV file is empty' })
    }

    const firstRaw = lines[0]
    const semicolonCount = (firstRaw.match(/;/g) || []).length
    const commaCount = (firstRaw.match(/,/g) || []).length
    const delimiter = semicolonCount > commaCount ? ';' : ','

    const firstLine = firstRaw.toLowerCase()
    let startIdx = 0
    let headers = []
    if (firstLine.includes('name') || firstLine.includes('phone') || firstLine.includes('nomor') || firstLine.includes('nama')) {
      startIdx = 1
      headers = firstRaw.split(delimiter).map((h) => h.trim().toLowerCase())
    }

    const colIndex = (names) => {
      for (const name of names) {
        const idx = headers.findIndex((h) => h === name)
        if (idx >= 0) return idx
      }
      return -1
    }

    const nameCol = colIndex(['name', 'nama', 'full_name'])
    const phoneCol = colIndex(['phone', 'telepon', 'nomor', 'no', 'number', 'hp', 'wa', 'mobile'])
    const birthCol = colIndex(['birth_date', 'birthdate', 'dob', 'tanggal_lahir'])
    const genderCol = colIndex(['gender', 'sex', 'jenis_kelamin'])
    const cityCol = colIndex(['city', 'kota'])
    const noteCol = colIndex(['note', 'notes', 'catatan'])

    const errors = []
    let created = 0
    let updated = 0
    let skipped = 0
    const total = lines.length - startIdx
    const seenPhones = new Set()

    // v3.4 — kuota kontak: hitung NEW rows yang akan dibuat vs sisa kuota SEBELUM commit
    // (dedup: baris baru = nama/phone valid, belum ada di DB, belum duplikat dalam CSV)
    const quota = await plans.checkContactQuota(req.tenantId)
    if (quota.max != null) {
      const existingPhones = new Set(
        (await prisma.contact.findMany({ where: { tenantId: req.tenantId }, select: { phone: true } }))
          .map((c) => c.phone)
          .filter(Boolean)
      )
      let newCount = 0
      for (let i = startIdx; i < lines.length; i++) {
        const cols = lines[i].split(delimiter).map((c) => c.trim().replace(/^"(.*)"$/, '$1'))
        const name = nameCol >= 0 ? (cols[nameCol] || '') : ''
        const phoneRaw = phoneCol >= 0 ? (cols[phoneCol] || '') : ''
        const phoneNorm = normalizePhone(phoneRaw)
        const phone = phoneNorm.valid ? phoneNorm.normalized : null
        if (!name && !phone) continue
        if (phone && (seenPhones.has(phone) || existingPhones.has(phone))) continue
        if (phone) seenPhones.add(phone)
        newCount++
      }
      if (quota.count + newCount > quota.max) {
        const sisa = Math.max(0, quota.max - quota.count)
        return res.status(403).json({
          error: `Kuota kontak tidak cukup: import ini butuh ${Number(newCount).toLocaleString('id-ID')} kontak baru, sisa kuota ${Number(sisa).toLocaleString('id-ID')} (${Number(quota.count).toLocaleString('id-ID')}/${Number(quota.max).toLocaleString('id-ID')}). Hubungi admin platform untuk upgrade paket.`,
        })
      }
    }

    for (let i = startIdx; i < lines.length; i++) {
      const lineNo = i + 1
      const cols = lines[i].split(delimiter).map((c) => c.trim().replace(/^"(.*)"$/, '$1'))
      const name = nameCol >= 0 ? (cols[nameCol] || '') : ''
      const phoneRaw = phoneCol >= 0 ? (cols[phoneCol] || '') : ''
      const phoneNorm = normalizePhone(phoneRaw)
      const phone = phoneNorm.valid ? phoneNorm.normalized : null

      if (!name && !phone) {
        skipped++
        continue
      }

      // Duplicate phone within the CSV
      if (phone && seenPhones.has(phone)) {
        skipped++
        errors.push({ line: lineNo, message: `Duplikat nomor dalam file: ${phoneRaw}` })
        if (errors.length >= 10) break
        continue
      }
      if (phone) seenPhones.add(phone)

      // Validate optional fields
      const birthInput = birthCol >= 0 ? cols[birthCol] : ''
      const birthDate = birthInput ? parseDateInput(birthInput) : null
      if (birthInput && birthDate === null) {
        errors.push({ line: lineNo, message: `Format tanggal lahir tidak valid: ${birthInput}` })
        skipped++
        if (errors.length >= 10) break
        continue
      }

      const genderInput = genderCol >= 0 ? cols[genderCol] : ''
      const gender = normalizeGender(genderInput)
      if (genderInput && !gender) {
        errors.push({ line: lineNo, message: `Gender tidak valid: ${genderInput}` })
        skipped++
        if (errors.length >= 10) break
        continue
      }

      const city = cityCol >= 0 ? (cols[cityCol] || null) : null
      const note = noteCol >= 0 ? (cols[noteCol] || null) : null

      // Try update by existing phone (tenant-scoped)
      const existing = phone ? await findExistingContactByPhone(req.tenantId, phone) : null
      if (existing) {
        const data = {}
        if (name && !existing.name) data.name = name
        if (birthDate && !existing.birthDate) data.birthDate = birthDate
        if (gender && !existing.gender) data.gender = gender
        if (city && !existing.city) data.city = city
        if (note && !existing.note) data.note = note

        if (Object.keys(data).length === 0) {
          skipped++
        } else {
          await prisma.contact.update({ where: { id: existing.id }, data })
          updated++
        }
        continue
      }

      // Try link to existing chat by phone (tenant-scoped)
      let chatId = null
      if (phone) {
        const chat = await findChatByPhone(req.tenantId, phone)
        if (chat) chatId = chat.id
      }

      await prisma.contact.create({
        data: {
          tenantId: req.tenantId,
          name: name || null,
          phone,
          chatId,
          birthDate,
          gender,
          city,
          note,
          source: 'import',
        },
      })
      created++
    }

    res.json({ created, updated, skipped, total, errors })
  } catch (e) {
    console.error('Import contacts error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ─── POST /api/contacts/:id/open — chat again ──────────────────────────
router.post('/:id/open', ...rt, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: 'Invalid contact ID' })
    }

    const contact = await prisma.contact.findFirst({
      where: { id, tenantId: req.tenantId },
      include: { chat: chatInclude() },
    })
    if (!contact) {
      return res.status(404).json({ error: 'Contact not found' })
    }

    // v0.1.25 — CS klik "Chat" di Kontak = klaim eksplisit chat open+unassigned.
    // Tanpa ini, GET /api/chats/:id menolak CS utk chat unassigned (isolasi v0.1.21)
    // → detail gak kebuka. Semantik sama dengan take-next, tapi inisiatif dari Kontak.
    // v0.5.0 — auto-claim HANYA untuk role cs. Admin manual via Take; relay
    // tidak boleh klaim sama sekali (chat relay hanya lewat transfer).
    // v0.15.2 — admin kini ikut auto-claim (permintaan owner: klik Chat dari
    // halaman Kontak harus langsung jadi chat-nya, konsisten dgn CS — aneh
    // kalau chat yang dia inisiasi malah masuk Unassigned). Relay TETAP
    // tidak boleh klaim (chat relay hanya lewat transfer).
    const claimIfUnassigned = async (ch) => {
      if ((req.user.role !== 'cs' && req.user.role !== 'admin') || ch.assignedToId) return ch
      const claimed = await prisma.chat.updateMany({
        where: { id: ch.id, tenantId: req.tenantId, assignedToId: null, status: 'open' },
        data: {
          assignedToId: req.user.id,
          lastAssignedAt: new Date(),
          queuedAt: null,
          ...(ch.firstAssignedAt ? {} : { firstAssignedAt: new Date() }),
        },
      })
      if (claimed.count === 1) {
        await prisma.chatEvent.create({ data: { tenantId: req.tenantId, chatId: ch.id, userId: req.user.id, type: 'assigned' } })
        broadcast.emitToTenant(req.tenantId, 'chat_update', { chatId: ch.id, assignedTo: { id: req.user.id, username: req.user.username } })
        queue.emitQueueUpdate(req.tenantId)
        console.log(`[Contacts] ${req.user.username} mengklaim chat dari Kontak: chat=${ch.id} (tenant ${req.tenantId})`)
      }
      return prisma.chat.findFirst({ where: { id: ch.id, tenantId: req.tenantId }, include: CHAT_FETCH_INCLUDE })
    }

    // Existing linked chat
    if (contact.chatId && contact.chat) {
      let chat = contact.chat
      if (chat.status === 'resolved') {
        const reopenedCount = (chat.reopenedCount || 0) + 1
        chat = await prisma.chat.update({
          where: { id: chat.id },
          data: { status: 'open', resolvedAt: null, reopenedCount },
          include: CHAT_FETCH_INCLUDE,
        })
        await prisma.chatEvent.create({
          data: { tenantId: req.tenantId, chatId: chat.id, userId: req.user.id, type: 'reopened' },
        })
        broadcast.emitToTenant(req.tenantId, 'chat_update', { chatId: chat.id, status: 'open', resolvedAt: null })
      }
      // v0.1.25 — klaim bila CS + masih unassigned
      chat = await claimIfUnassigned(chat)
      return res.json({ chat: {
        id: chat.id,
        status: chat.status,
        lastMessageAt: chat.lastMessageAt,
        unreadCount: chat.unreadCount,
        assignedTo: chat.assignedTo,
        tags: chat.tags,
        contactName: contact.name,
        contactPhone: contact.phone,
      } })
    }

    if (!contact.phone) {
      return res.status(400).json({ error: 'Nomor kontak tidak diketahui (LID belum resolved)' })
    }

    const phoneNorm = normalizePhone(contact.phone)
    if (!phoneNorm.valid) {
      return res.status(400).json({ error: 'Nomor kontak tidak valid' })
    }

    const jid = `${phoneNorm.normalized}@s.whatsapp.net`
    // v3.5 §4 — cek dua arah sebelum create: waJid → phoneJid → lidJid
    // (chat LID yang mapping-nya sudah ke nomor ini = chat yang sama, bukan duplikat).
    let chat = await findChatByAnyJid(req.tenantId, jid)
    if (chat) {
      chat = await prisma.chat.findFirst({ where: { id: chat.id, tenantId: req.tenantId }, include: CHAT_FETCH_INCLUDE })
    }

    if (!chat) {
      chat = await prisma.chat.create({
        data: {
          tenantId: req.tenantId,
          waJid: jid,
          contactPhone: phoneNorm.normalized,
          contactName: contact.name || null,
          phoneJid: jid,
          lastMessageAt: new Date(),
        },
        include: CHAT_FETCH_INCLUDE,
      })
    }

    if (!contact.chatId) {
      // v3.7 — ANTI-DOBEL: kontak orphan (mis. hasil "Hapus Chat" mode keep)
      // yang di-start chat lagi → re-link ke chat existing/baru by phone,
      // BUKAN biarkan orphan + bikin kontak dobel di jalur WA masuk nanti.
      // Fallback C4 = SET row INI SAJA by id (bukan by phone!): helper relink
      // null karena nomor sudah kepake kontak lain / invalid — kalau by phone
      // bisa tabrak unique chatId milik kontak lain (500, kasus QA 4a).
      // updateMany by id berkondisi chatId null = race-safe + no-op kalau
      // row sudah ke-link proses lain.
      const relinked = await relinkOrphanContact(req.tenantId, contact.phone, chat.id, contact.name)
      if (!relinked) {
        try {
          await prisma.contact.updateMany({ where: { id: contact.id, tenantId: req.tenantId, chatId: null }, data: { chatId: chat.id } })
        } catch (e) {
          // Unique chatId milik kontak lain (nomor double-row lama) — JANGAN 500;
          // kontak biarkan orphan, chat tetap dibuka (log utk observer).
          console.error('[Contacts] re-link fallback chatId dilewati (unique):', e.message)
        }
      }
    }

    if (chat.status === 'resolved') {
      const reopenedCount = (chat.reopenedCount || 0) + 1
      chat = await prisma.chat.update({
        where: { id: chat.id },
        data: { status: 'open', resolvedAt: null, reopenedCount },
        include: CHAT_FETCH_INCLUDE,
      })
      await prisma.chatEvent.create({
        data: { tenantId: req.tenantId, chatId: chat.id, userId: req.user.id, type: 'reopened' },
      })
      broadcast.emitToTenant(req.tenantId, 'chat_update', { chatId: chat.id, status: 'open', resolvedAt: null })
    }

    // v0.1.25 — klaim bila CS + masih unassigned
    chat = await claimIfUnassigned(chat)

    res.json({ chat: {
      id: chat.id,
      status: chat.status,
      lastMessageAt: chat.lastMessageAt,
      unreadCount: chat.unreadCount,
      assignedTo: chat.assignedTo,
      tags: chat.tags,
      contactName: contact.name,
      contactPhone: contact.phone,
    } })
  } catch (e) {
    console.error('Open chat from contact error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = { router, normalizePhone }
