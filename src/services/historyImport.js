// v0.15.0 — Engine import history (diekstrak dari src/routes/history.js)
//
// MECHANICAL MOVE dari routes/history.js (v0.11.0): fungsi-fungsi di sini
// dipindah apa adanya agar bisa dipakai ulang oleh POST /api/history/import
// DAN POST /api/cekat-import. Perilaku endpoint TIDAK berubah.
//
// Kontrak import (tidak berubah sejak v0.6.0):
//   APPEND + dedup. TIDAK ADA delete/update destruktif. Transaksi per-chat:
//   1 chat gagal → rollback chat itu saja, lanjut, error tercatat.
//   Update hanya pada field yang eksplisit diizinkan (contact field kosong).
//   JANGAN emit socket per-message — emit 'history_imported' sekali di akhir.
//
// Format file: { format: 'wa-cs-hub-history', version: 1, ... }
// Media binary TIDAK ikut (ada di data/media/) — hanya metadata-nya.

const crypto = require('crypto')
const path = require('path')
const config = require('../config')
// v0.11.0 — enkripsi saat import (DB at-rest terenkripsi)
const { decryptTextSafe, encryptText, isEncrypted } = require('./textCrypto')

const HISTORY_FORMAT = 'wa-cs-hub-history'
const HISTORY_VERSION = 1
const IMPORT_BATCH_SIZE = 500 // insert per-batch, jangan satu per satu

// ─── Helpers ─────────────────────────────────────────────────────────────

function isoOrNull(d) {
  if (!d) return null
  const date = d instanceof Date ? d : new Date(d)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function parseDateOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

function intOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

// Path media di DB absolut; export sebagai path relatif thd mediaDir supaya portabel
function relativeMediaPath(p) {
  if (!p) return null
  const base = config.mediaDir.endsWith(path.sep) ? config.mediaDir : config.mediaDir + path.sep
  return p.startsWith(base) ? p.slice(base.length) : p
}

// Kebalikan relativeMediaPath: path relatif → absolut terhadap mediaDir
function resolveMediaPath(p) {
  if (!p) return null
  return path.isAbsolute(p) ? p : path.join(config.mediaDir, p)
}

// Kunci dedup pesan: hash(tenantId + chatId + timestamp + direction + senderName + content)
// SHA-1 pendek cukup — bukan keamanan, hanya dedup.
// v3.0 — tenantId ikut di-compose: JID sama di 2 tenant TIDAK dianggap duplikat.
function dedupKey(tenantId, chatId, timestamp, direction, senderName, content) {
  const payload = JSON.stringify([
    Number(tenantId) || 0,
    chatId,
    new Date(timestamp).toISOString(),
    direction || '',
    senderName || '',
    content === null || content === undefined ? '\u0000' : String(content), // bedakan null vs ''
  ])
  return crypto.createHash('sha1').update(payload).digest('hex')
}

function parseImportPayload(buffer) {
  let data
  try {
    data = JSON.parse(buffer.toString('utf8'))
  } catch {
    return { error: 'File bukan JSON yang valid' }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { error: 'Struktur file tidak dikenal — bukan file backup WA CS Hub' }
  }
  if (data.format !== HISTORY_FORMAT) {
    return { error: `Format tidak dikenal (dapat: "${data.format ?? 'undefined'}") — file backup harus ber-format "${HISTORY_FORMAT}"` }
  }
  if (Number(data.version) !== HISTORY_VERSION) {
    return { error: `Versi format tidak didukung (dapat v${data.version}, sistem mendukung v${HISTORY_VERSION})` }
  }
  if (!Array.isArray(data.chats)) {
    return { error: 'Field "chats" tidak ditemukan atau bukan array' }
  }
  return { data }
}

// Preview text utk chat baru (pesan terbaru dulu)
function previewOfNewest(candidates) {
  if (!candidates.length) return null
  let newest = candidates[0]
  for (const c of candidates) if (c.ts > newest.ts) newest = c
  if (newest.m.content) return String(newest.m.content)
  if (newest.m.mediaType) return `[${String(newest.m.mediaType).charAt(0).toUpperCase()}${String(newest.m.mediaType).slice(1)}]`
  return '[Media]'
}

// ─── v0.11.0 — Enkripsi saat IMPORT dari backup ────────────────────────
// Backup berisi plaintext (format v1 stabil, kompatibel lintas versi).
// Import di server ≥ v0.11.0 menyimpan ciphertext (DB at-rest terenkripsi).
// Nilai yang sudah ber-prefix 'enc:v1:' dibiarkan (idempotent, anti double-encrypt).
function encryptImportContent(content) {
  if (content === null || content === undefined || content === '') return content
  if (isEncrypted(content)) return content
  return encryptText(String(content))
}

// ─── Contact (fill-empty-only) ───────────────────────────────────────────

function contactFillData(existing, chatEntry) {
  const extra = chatEntry.contact && typeof chatEntry.contact === 'object' ? chatEntry.contact : {}
  const phone = chatEntry.contactPhone || null
  const name = chatEntry.contactName || null
  const birthDate = parseDateOrNull(extra.birthDate)
  const data = {}
  if (!existing.chatId && chatEntry.chatId != null) data.chatId = chatEntry.chatId
  if (contactFillData._check(existing.phone, phone)) data.phone = phone
  if (contactFillData._check(existing.name, name)) data.name = name
  if (!existing.birthDate && birthDate) data.birthDate = birthDate
  if (!existing.gender && extra.gender) data.gender = String(extra.gender)
  if (!existing.city && extra.city) data.city = String(extra.city)
  if (!existing.note && extra.note) data.note = String(extra.note)
  return data
}
contactFillData._check = (cur, inc) => (cur == null || cur === '') && inc != null && inc !== ''

async function upsertContact(tx, tenantId, chatEntry, dryRun) {
  const chatId = chatEntry.chatId // Int Chat.id hasil processChat
  // Cari by chatId dulu, lalu by phone (tenant-scoped)
  let contact = await tx.contact.findUnique({ where: { chatId } })
  if (!contact && chatEntry.contactPhone) {
    contact = await tx.contact.findFirst({ where: { tenantId, phone: chatEntry.contactPhone } })
  }

  if (!contact) {
    if (dryRun) return true
    const extra = chatEntry.contact && typeof chatEntry.contact === 'object' ? chatEntry.contact : {}
    await tx.contact.create({
      data: {
        tenantId,
        chatId,
        phone: chatEntry.contactPhone || null,
        name: chatEntry.contactName || null,
        birthDate: parseDateOrNull(extra.birthDate),
        gender: extra.gender ? String(extra.gender) : null,
        city: extra.city ? String(extra.city) : null,
        note: extra.note ? String(extra.note) : null,
        source: 'import',
      },
    })
    return true
  }

  const data = contactFillData(contact, chatEntry)
  if (!Object.keys(data).length) return false
  if (dryRun) return true
  await tx.contact.update({ where: { id: contact.id }, data })
  return true
}

// ─── Tags (match by name → buat kalau belum ada → sambungkan) ────────────

async function connectTags(tx, tenantId, chatId, tags) {
  for (const t of Array.isArray(tags) ? tags : []) {
    if (!t || !t.name) continue
    const name = String(t.name)
    let tag = await tx.tag.findFirst({ where: { tenantId, name } })
    if (!tag) {
      tag = await tx.tag.create({ data: { tenantId, name, color: t.color ? String(t.color) : 'blue' } })
    }
    const linked = await tx.chatTag.findUnique({ where: { chatId_tagId: { chatId, tagId: tag.id } } })
    if (!linked) {
      await tx.chatTag.create({ data: { chatId, tagId: tag.id } })
    }
  }
}

// ─── Insert messages (batch) ─────────────────────────────────────────────

async function insertMessages(tx, tenantId, chatId, candidates, userMap) {
  const rows = candidates.map(({ m, ts }) => ({
    tenantId,
    chatId,
    direction: m.direction === 'out' ? 'out' : 'in',
    content: encryptImportContent(m.content), // v0.11.0 — plaintext backup → ciphertext di DB
    senderName: m.senderName == null ? '' : String(m.senderName),
    senderId: m.senderUsername ? userMap.get(String(m.senderUsername)) ?? null : null,
    timestamp: ts,
    status: m.status ? String(m.status) : 'sent',
    waMessageId: m.waMessageId == null ? null : String(m.waMessageId),
    purged: !!m.purged,
    mediaPath: m.mediaPath ? resolveMediaPath(String(m.mediaPath)) : null,
    mediaType: m.mediaType == null ? null : String(m.mediaType),
    mediaMime: m.mediaMime == null ? null : String(m.mediaMime),
    mediaSize: m.mediaSize == null ? null : intOrNull(m.mediaSize),
  }))
  for (let i = 0; i < rows.length; i += IMPORT_BATCH_SIZE) {
    await tx.message.createMany({ data: rows.slice(i, i + IMPORT_BATCH_SIZE) })
  }
}

// ─── Per-chat processor (dipanggil dalam transaksi) ──────────────────────

async function processChat(tx, tenantId, chatEntry, userMap, dryRun, result) {
  const waJid = chatEntry && chatEntry.chatId != null ? String(chatEntry.chatId) : ''
  if (!waJid) {
    result.errors.push({ chatId: chatEntry?.chatId ?? null, error: 'Entri chat tanpa chatId — dilewati' })
    return
  }
  // v3.0 — dedup key selalu compose tenantId (JID sama antar tenant ≠ duplikat)
  const dk = (ts, m) => dedupKey(tenantId, waJid, ts, m.direction, m.senderName, m.content)

  const rawMessages = Array.isArray(chatEntry.messages) ? chatEntry.messages : []

  // Normalisasi + dedup intra-file
  const candidates = []
  const seen = new Set()
  rawMessages.forEach((m, idx) => {
    if (!m || typeof m !== 'object') return
    const ts = parseDateOrNull(m.timestamp)
    if (!ts) {
      result.errors.push({ chatId: waJid, error: `Pesan #${idx + 1} timestamp invalid — dilewati` })
      return
    }
    const key = dk(ts, m)
    if (seen.has(key)) {
      result.messagesSkipped++ // duplikat di dalam file sendiri
      return
    }
    seen.add(key)
    candidates.push({ m, ts, key })
  })

  // v3.0 — chat find-or-create by [tenantId, waJid] (Chat.id Int). chatEntry.chatId
  // dari file JID-string dijadikan waJid lookup; entry.chatId diganti Int id hasil.
  const existingChat = await tx.chat.findUnique({
    where: { tenantId_waJid: { tenantId, waJid } },
    select: { id: true, lastMessageAt: true },
  })

  if (existingChat) {
    chatEntry.chatId = existingChat.id // sambungkan Contact/ChatTag ke Int id
    // ── MERGE: jangan sentuh assignedTo/status/unread/queuedAt (data live menang)
    // v0.6.2 — dedup hanya terhadap pesan AKTIF (purged:false). Bug: soft purge
    // menyisakan baris purged:true → dipakai sbg kunci dedup → backup yang berisi
    // pesan sama TIDAK pernah di-insert → chatlist tetap kosong pasca restore.
    result.chatsMerged++
    const existingMsgs = await tx.message.findMany({
      where: { tenantId, chatId: existingChat.id, purged: false },
      select: { timestamp: true, direction: true, senderName: true, content: true },
    })
    // v0.11.0 — dedup key dihitung dari PLAINTEXT (dekrip bila ciphertext),
    // supaya backup lama (plaintext) gak di-insert dobel di atas pesan yang
    // sudah terenkripsi di DB. v3 — tenantId ikut di-compose.
    const existingKeys = new Set(
      existingMsgs.map((m) => dedupKey(tenantId, waJid, m.timestamp, m.direction, m.senderName, decryptTextSafe(m.content)))
    )
    const toInsert = []
    for (const c of candidates) {
      if (existingKeys.has(c.key)) {
        result.messagesSkipped++
      } else {
        toInsert.push(c)
      }
    }
    result.messagesAdded += toInsert.length
    // v0.6.3 — chat SHELL pasca soft-purge (tanpa pesan aktif): hidupkan kembali
    // state operasional dari backup (assignment, status, metrik lifecycle).
    const isShellBeingRevived = existingMsgs.length === 0 && toInsert.length > 0
    if (isShellBeingRevived) {
      const upd = {}
      if (chatEntry.status === 'resolved') {
        upd.status = 'resolved'
        const ra = parseDateOrNull(chatEntry.resolvedAt)
        if (ra) upd.resolvedAt = ra
      }
      const au = chatEntry.assignedToUsername ? String(chatEntry.assignedToUsername) : null
      if (au && userMap.has(au)) upd.assignedToId = userMap.get(au)
      const fa = parseDateOrNull(chatEntry.firstAssignedAt)
      if (fa) upd.firstAssignedAt = fa
      const la = parseDateOrNull(chatEntry.lastAssignedAt)
      if (la) upd.lastAssignedAt = la
      const fi = parseDateOrNull(chatEntry.firstIncomingAt)
      if (fi) upd.firstIncomingAt = fi
      const fresp = parseDateOrNull(chatEntry.firstResponseAt)
      if (fresp) upd.firstResponseAt = fresp
      const cs = intOrNull(chatEntry.csMessagesSent)
      if (cs != null) upd.csMessagesSent = cs
      const ro = intOrNull(chatEntry.reopenedCount)
      if (ro != null) upd.reopenedCount = ro
      const mbr = intOrNull(chatEntry.messagesBeforeResolve)
      if (mbr != null) upd.messagesBeforeResolve = mbr
      if (Object.keys(upd).length) {
        if (!dryRun) await tx.chat.update({ where: { id: existingChat.id }, data: upd })
        result.chatsRestoredState++
      }
    }
    if (!dryRun) {
      if (toInsert.length) await insertMessages(tx, tenantId, existingChat.id, toInsert, userMap)
      if (await upsertContact(tx, tenantId, chatEntry, dryRun)) result.contactsUpdated++
      await connectTags(tx, tenantId, existingChat.id, chatEntry.tags)
      // v0.6.2 — refresh lastMessageAt/preview dari pesan aktif terbaru
      if (toInsert.length) {
        const newest = await tx.message.findFirst({
          where: { tenantId, chatId: existingChat.id, purged: false },
          orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
        })
        if (newest) {
          const chatData = {}
          if (!existingChat.lastMessageAt || newest.timestamp > existingChat.lastMessageAt) {
            chatData.lastMessageAt = newest.timestamp
            chatData.lastMessagePreview = encryptImportContent(
              newest.content || (newest.mediaType ? `[${String(newest.mediaType).charAt(0).toUpperCase() + String(newest.mediaType).slice(1)}]` : '[Media]')
            )
          }
          if (Object.keys(chatData).length) await tx.chat.update({ where: { id: existingChat.id }, data: chatData })
        }
      }
    } else if (await upsertContact(tx, tenantId, chatEntry, dryRun)) {
      result.contactsUpdated++
    }
    return
  }

  // ── CREATE: chat belum ada di tenant ini → buat lengkap (Chat.id autoincrement)
  result.chatsCreated++
  if (dryRun) {
    result.messagesAdded += candidates.length
    result.contactsUpdated++ // contact akan dibuat
    return
  }

  const phone =
    chatEntry.contactPhone || (waJid.includes('@') ? waJid.split('@')[0] : waJid)
  const createdAt = parseDateOrNull(chatEntry.createdAt) || new Date()
  const lastMessageAt =
    parseDateOrNull(chatEntry.lastMessageAt) ||
    (candidates.length ? candidates.reduce((acc, c) => (c.ts > acc ? c.ts : acc), candidates[0].ts) : null)
  const firstIncomingAt =
    parseDateOrNull(chatEntry.firstIncomingAt) ||
    (candidates.length ? candidates.reduce((acc, c) => (c.ts < acc ? c.ts : acc), candidates[0].ts) : createdAt)

  const assignedToUsername = chatEntry.assignedToUsername ? String(chatEntry.assignedToUsername) : null
  const assignedToId = assignedToUsername ? userMap.get(assignedToUsername) ?? null : null // tidak ada → null, JANGAN bikin user

  const createdChat = await tx.chat.create({
    data: {
      tenantId,
      waJid,
      contactName: chatEntry.contactName ? String(chatEntry.contactName) : null,
      contactPhone: phone,
      phoneJid: chatEntry.phoneJid ? String(chatEntry.phoneJid) : null,
      status: chatEntry.status === 'resolved' ? 'resolved' : 'open',
      resolvedAt: parseDateOrNull(chatEntry.resolvedAt),
      createdAt,
      lastMessageAt,
      lastMessagePreview: encryptImportContent(previewOfNewest(candidates)), // v0.11.0
      assignedToId,
      firstAssignedAt: parseDateOrNull(chatEntry.firstAssignedAt),
      lastAssignedAt: parseDateOrNull(chatEntry.lastAssignedAt),
      firstIncomingAt,
      firstResponseAt: parseDateOrNull(chatEntry.firstResponseAt),
      firstResponseById: null, // tidak diekspor (bukan bagian format v1)
      csMessagesSent: intOrNull(chatEntry.csMessagesSent) ?? 0,
      messagesBeforeResolve: intOrNull(chatEntry.messagesBeforeResolve),
      reopenedCount: intOrNull(chatEntry.reopenedCount) ?? 0,
      // runtime state — selalu reset saat restore:
      unreadCount: 0,
      transferUnseen: false,
      queuedAt: null,
    },
  })
  chatEntry.chatId = createdChat.id // Int id utk Contact/ChatTag pasca-create

  if (candidates.length) await insertMessages(tx, tenantId, createdChat.id, candidates, userMap)
  result.messagesAdded += candidates.length
  if (await upsertContact(tx, tenantId, chatEntry, dryRun)) result.contactsUpdated++
  await connectTags(tx, tenantId, createdChat.id, chatEntry.tags)
}

// ─── Runner import (dipakai kedua endpoint; socket events ditangani caller) ──

/**
 * Jalankan engine import terhadap payload `{format, version, chats}`.
 * Socket events ('history_imported' + queue update) TIDAK di-emit di sini —
 * caller (route) yang emit, agar pola endpoint history tidak berubah.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{ format: string, version: number, chats: Array }} data payload valid
 * @param {Map<string,number>} userMap username → userId
 * @param {boolean} dryRun
 */
async function runHistoryImport(prisma, data, userMap, dryRun, tenantId) {
  const result = {
    dryRun,
    chatsCreated: 0,
    chatsMerged: 0,
    chatsRestoredState: 0,
    messagesAdded: 0,
    messagesSkipped: 0,
    contactsUpdated: 0,
    errors: [],
  }

  // Transaksi PER-CHAT: 1 gagal → rollback chat itu saja, lanjut, catat error.
  for (const chatEntry of data.chats) {
    try {
      await prisma.$transaction(
        async (tx) => {
          await processChat(tx, tenantId, chatEntry, userMap, dryRun, result)
        },
        { timeout: 60000, maxWait: 10000 }
      )
    } catch (e) {
      console.error('History import chat error:', e)
      result.errors.push({ chatId: chatEntry?.chatId ?? null, error: e.message || 'Gagal memproses chat' })
    }
  }

  return result
}

/**
 * Mapping username → id dari user DI SISTEM INI (jangan bikin user baru).
 * Dipakai engine import; versi lowercase-nya dipakai matcher Cekat.
 */
async function buildUserMap(prisma, tenantId = null) {
  const users = await prisma.user.findMany({
    where: tenantId != null ? { tenantId } : {},
    select: { id: true, username: true },
  })
  const userMap = new Map(users.map((u) => [u.username, u.id]))
  const userMapLower = new Map(users.map((u) => [String(u.username).toLowerCase(), u.username]))
  return { userMap, userMapLower }
}

module.exports = {
  HISTORY_FORMAT,
  HISTORY_VERSION,
  IMPORT_BATCH_SIZE,
  isoOrNull,
  parseDateOrNull,
  intOrNull,
  relativeMediaPath,
  resolveMediaPath,
  dedupKey,
  parseImportPayload,
  previewOfNewest,
  encryptImportContent,
  contactFillData,
  upsertContact,
  connectTags,
  insertMessages,
  processChat,
  runHistoryImport,
  buildUserMap,
}