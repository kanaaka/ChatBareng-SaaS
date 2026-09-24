// ═══════════════════════════════════════════════════════════════════════
// v0.14.0 — Manajemen Grup (PIC Model) — service layer
// Spec: wa-cs-hub-v0.14.0-grup-spec.md (LOCKED, APPROVED Kanaka 17 Sep 18:02)
//
// Prinsip (spec §2): fitur grup = jalur BARU di samping jalur 1:1.
// - Grup = born-assigned: picUserId AND assignedToId di-set bersamaan sejak
//   lahir → guard existing (reply-lock assertTaken, canAccessChat owner branch)
//   otomatis bekerja utk grup TANPA diubah (spec §4).
// - Grup TIDAK PERNAH lewat antrean/take: baris Chat grup TIDAK punya queuedAt
//   dan grup yatim (belum di-adopt) TIDAK dibuatkan row → queueWhere() tak tersentuh.
// - Semua aksi manajemen → GroupActionLog.
// - WA belum open → 503 WA_BELUM_TERHUBUNG; bot bukan admin → 422 BOT_BUKAN_ADMIN.
// ═══════════════════════════════════════════════════════════════════════

const prisma = require('../prisma')
const wa = require('../wa/pool')
const broadcast = require('../socket/broadcast')
const push = require('../push')
const { encryptText, decryptTextSafe } = require('./textCrypto')

const GROUP_SUFFIX = '@g.us'

// ─── Error baku (route memetakan ke status HTTP) ──────────────────────
class GroupServiceError extends Error {
  /**
   * @param {string} code - kode stabil utk UI (WA_BELUM_TERHUBUNG, BOT_BUKAN_ADMIN, FORBIDDEN, ...)
   * @param {number} status - HTTP status
   * @param {string} message - pesan manusia
   */
  constructor(code, status, message) {
    super(message || code)
    this.code = code
    this.status = status
  }
}

function isAdmin(user) {
  return user?.role === 'admin'
}

function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith(GROUP_SUFFIX)
}

function assertWaReady(tenantId) {
  const st = wa.getStatusForTenant(tenantId)
  if (!st.connected) {
    throw new GroupServiceError('WA_BELUM_TERHUBUNG', 503, 'WhatsApp belum terhubung. Hubungkan WhatsApp dulu (halaman Admin → WhatsApp).')
  }
}

// ═══ v3.9.6 — Slot-aware grup ═══
// Nomor pembuat grup (jadi admin WA) bisa DIPILIH via body.slot (0..MAX_SLOT).
// Row grup menyimpan slot pemilik di numberSlot (1 grup = 1 baris, v3.9.2 K1-A);
// SEMUA aksi grup (metadata/member/setting/invite/reset) lewat socket slot itu.
// Row legacy (numberSlot 0) = perilaku lama persis. PM & invite-link ke participant
// TETAP via slot-0 (status quo — isolasi chat 1:1 slot-0, documented).
function assertWaReadySlot(tenantId, slot) {
  const s = Number(slot) || 0
  const st = wa.getStatusForTenant(tenantId, s)
  if (!st.connected) {
    const msg = s === 0
      ? 'WhatsApp belum terhubung. Hubungkan WhatsApp dulu (halaman Admin → WhatsApp).'
      : `Nomor slot ${s} belum terhubung. Hubungkan nomor itu dulu di halaman Admin → WhatsApp.`
    throw new GroupServiceError('WA_BELUM_TERHUBUNG', 503, msg)
  }
}

/** Validasi body.slot utk create: ada row TenantNumber + dalam rentang slot. */
async function resolveCreateSlot(tenantId, raw) {
  const max = Number(wa.MAX_SLOT) || 2
  const s = Math.max(0, Math.min(Number(raw) || 0, max))
  const row = await wa.getTenantNumber(tenantId, s)
  if (!row) {
    throw new GroupServiceError('VALIDATION', 400, `Slot ${s} tidak tersedia untuk tenant ini`)
  }
  return s
}

/** Slot pemilik row grup (row legacy = slot-0). */
function slotOfRow(row) {
  return Number(row?.numberSlot) || 0
}

/** Socket utk aksi row grup: slot pemilik (TANPA fallback — kalau slot mati, error jelas). */
function getSocketForRow(tenantId, row) {
  return wa.getSocketForTenant(tenantId, slotOfRow(row))
}

/** WA siap utk aksi row grup: slot PEMILIK wajib connected (bukan cek slot-0 legacy). */
function assertWaReadyForRow(tenantId, row) {
  assertWaReadySlot(tenantId, slotOfRow(row))
}

/**
 * Metadata grup dari slot manapun yang connected & anggota (0..MAX_SLOT, asc).
 * Return {metadata, slot} — dipakai jalur orphan (detail/adopt/leave).
 */
async function fetchGroupMetadataAnySlot(tenantId, chatId) {
  const max = Number(wa.MAX_SLOT) || 2
  let lastErr = null
  for (let s = 0; s <= max; s++) {
    const sock = wa.getSocketForTenant(tenantId, s)
    if (!sock) continue
    try {
      const metadata = await sock.groupMetadata(chatId)
      return { metadata, slot: s }
    } catch (e) {
      lastErr = e
    }
  }
  if (lastErr) throw mapWaError(lastErr, 'groupMetadata')
  throw new GroupServiceError('WA_BELUM_TERHUBUNG', 503, 'WhatsApp belum terhubung. Hubungkan WhatsApp dulu (halaman Admin → WhatsApp).')
}

/**
 * Peta error Baileys → error service. Bot bukan admin / bukan anggota grup =
 * 422 BOT_BUKAN_ADMIN (BUKAN 500) — spec §3/§5.
 */
function mapWaError(e, context = '') {
  const msg = String(e?.message || e || '')
  const boomStatus = e?.isBoom ? e?.output?.statusCode : undefined
  if (/WA_BELUM_TERHUBUNG/.test(msg)) {
    return new GroupServiceError('WA_BELUM_TERHUBUNG', 503, 'WhatsApp belum terhubung.')
  }
  if (
    boomStatus === 401 || boomStatus === 403 || boomStatus === 406 ||
    /not-authorized|forbidden|conflict|not an admin|bukan admin|item-not-found|not in group|not a participant/i.test(msg)
  ) {
    return new GroupServiceError('BOT_BUKAN_ADMIN', 422, 'Bot bukan admin (atau tidak lagi berada) di grup ini — aksi ditolak WhatsApp.')
  }
  console.error(`[Groups] WA error${context ? ' (' + context + ')' : ''}:`, msg)
  return new GroupServiceError('WA_GAGAL', 502, `Aksi WhatsApp gagal${context ? ' (' + context + ')' : ''}: ${msg.slice(0, 180)}`)
}

// ─── Normalisasi nomor → JID ───────────────────────────────────────────
/** digits-only, 0/8 → 62 prefix (pola normalizePhoneForContact baileys) */
function normalizePhone(raw) {
  if (!raw) return null
  let phone = String(raw).replace(/[\s\-().]/g, '')
  if (phone.startsWith('+')) phone = phone.slice(1)
  if (phone.startsWith('0')) phone = '62' + phone.slice(1)
  if (phone.startsWith('8') && phone.length >= 8 && !phone.startsWith('62')) phone = '62' + phone
  if (!/^\d+$/.test(phone)) return null
  if (phone.length < 8 || phone.length > 15) return null
  return phone
}

function phoneToJid(phone) {
  return `${phone}@s.whatsapp.net`
}

/** Validasi & normalisasi daftar nomor input → { jids, results(gagal normalisasi) } */
function normalizePhoneInputs(phonesRaw) {
  const jids = []
  const results = []
  const seen = new Set()
  for (const raw of phonesRaw || []) {
    const phone = normalizePhone(raw)
    if (!phone) {
      results.push({ phone: String(raw || ''), status: 'error', error: 'Nomor tidak valid (pakai format 62…)' })
      continue
    }
    if (seen.has(phone)) continue
    seen.add(phone)
    jids.push(phoneToJid(phone))
    results.push({ phone, status: 'pending', jid: phoneToJid(phone) })
  }
  return { jids, results }
}

// ─── Bot identity helpers ─────────────────────────────────────────────
function getBotJids(tenantId, slot = 0) {
  const sock = wa.getSocketForTenant(tenantId, slot)
  const ids = new Set()
  const uid = sock?.user?.id
  if (uid) {
    ids.add(uid)
    ids.add(String(uid).split(':')[0] + '@s.whatsapp.net')
  }
  const lid = sock?.user?.lid
  if (lid) ids.add(String(lid).split(':')[0] + '@lid')
  return ids
}

function digitsOf(jid) {
  return String(jid || '').split('@')[0].split(':')[0]
}

/** Apakah bot admin di metadata grup? (false jika bot tidak ditemukan) */
function botIsAdminFromMetadata(tenantId, metadata, slot = 0) {
  if (!metadata || !Array.isArray(metadata.participants)) return false
  const botJids = getBotJids(tenantId, slot)
  const botDigits = new Set([...botJids].map(digitsOf))
  return metadata.participants.some(p => botJids.has(p.id) || botDigits.has(digitsOf(p.id)))
    && metadata.participants.some(p => (botJids.has(p.id) || botDigits.has(digitsOf(p.id))) && (p.isAdmin || p.admin === 'admin' || p.admin === 'superadmin'))
}

// ─── Group action log ─────────────────────────────────────────────────
async function logAction(actorUserId, tenantId, chatId, action, detail) {
  try {
    await prisma.groupActionLog.create({
      data: { tenantId: Number(tenantId) || 0, chatId: Number(chatId) || 0, actorUserId: Number(actorUserId) || 0, action, detail: detail ? String(detail).slice(0, 2000) : null },
    })
  } catch (e) {
    console.error('[Groups] logAction error (non-fatal):', e.message)
  }
}

// ─── Audience rooms: PIC + semua admin (spec §5 socket) ───────────────
let adminIdsCache = new Map() // tenantId → { ids, at }
async function getAdminIds(tenantId) {
  const tid = Number(tenantId) || 0
  const now = Date.now()
  const c = adminIdsCache.get(tid)
  if (c && now - c.at < 15000) return c.ids
  const admins = await prisma.user.findMany({ where: { role: 'admin', tenantId: tid || undefined }, select: { id: true } })
  adminIdsCache.set(tid, { ids: admins.map(a => a.id), at: now })
  return adminIdsCache.get(tid).ids
}

/** Room names utk emit chat-scoped grup: PIC + semua admin (bukan broadcast umum). */
async function groupAudienceRooms(tenantId, picUserId) {
  const adminIds = await getAdminIds(tenantId)
  const rooms = new Set(adminIds.map(id => `user:${id}`))
  if (picUserId) rooms.add(`user:${picUserId}`)
  return [...rooms]
}

function emitGroupUpdate(tenantId, chatId) {
  // fire-and-forget: refetch list/detail di UI PIC+admin (admin tenant itu saja)
  groupAudienceRooms(tenantId, null).then(async rooms => {
    for (const r of rooms) broadcast.emitToRoom(r, 'group_update', { chatId })
  }).catch(() => {})
}

// ─── Visibility helpers (matriks spec §3) ─────────────────────────────
/** PIC & admin saja; CS lain / cabang non-PIC tidak melihat sama sekali. */
function canSeeGroup(user, chat) {
  if (!isGroupJid(chat.waJid) && !(chat.phoneJid && isGroupJid(chat.phoneJid))) return false
  if (isAdmin(user)) return true
  return chat.picUserId === user.id
}

function assertCanSee(user, chat) {
  if (!canSeeGroup(user, chat)) {
    throw new GroupServiceError('FORBIDDEN', 403, 'Anda tidak memiliki akses ke grup ini')
  }
}

// ─── DB helpers ───────────────────────────────────────────────────────
// v3.9.11 — resolve id ATAU JID: frontend SaaS ngirim row-id numerik (Chat.id Int),
// porting hub non-SaaS nyocokin waJid → match gagal → jatuh ke jalur adopt dgn
// "JID" sampah (angka) → groupMetadata() gantung tanpa timeout → "Menyimpan…"
// abadi di Ganti PIC (lapor Kanaka 24 Sep). Angka → by id (wajib grup, bukan →
// 404, JANGAN pernah adopt dgn id numerik); selain itu → by waJid (null = yatim).
async function findGroupChat(tenantId, chatId) {
  const raw = String(chatId)
  const include = { assignedTo: { select: { id: true, username: true, role: true } } }
  if (/^\d+$/.test(raw)) {
    const byId = await prisma.chat.findFirst({ where: { tenantId, id: Number(raw) }, include })
    if (!byId || (!isGroupJid(byId.waJid) && !(byId.phoneJid && isGroupJid(byId.phoneJid)))) {
      throw new GroupServiceError('NOT_FOUND', 404, 'Grup tidak ditemukan')
    }
    return byId
  }
  const chat = await prisma.chat.findFirst({ where: { tenantId, waJid: raw }, include })
  if (!chat) return null
  if (!isGroupJid(chat.waJid) && !(chat.phoneJid && isGroupJid(chat.phoneJid))) return null
  return chat
}

// v3.9.2 K1-A — grup TIDAK dipisah per slot (1 grup = 1 baris): findFirst by
// (tenantId, waJid) tanpa slot (deterministik: id asc). Pakai createGroup & fallback.
async function findGroupChatRowAnySlot(tenantId, waJid) {
  return prisma.chat.findFirst({ where: { tenantId, waJid: String(waJid) }, orderBy: { id: 'asc' } })
}

function isOrphanRow(chat) {
  return !chat.picUserId
}

// ─── Orphans (grup yatim — bot ditambahkan dari luar ChatBareng) ──────
/**
 * Grup @g.us yang bot ikuti tapi BELUM ada row Chat (belum di-adopt).
 * SENGAJA tidak persist (row tanpa PIC akan bocor ke queueWhere()/list 1:1 —
 * queueWhere tidak boleh disentuh per spec §2) → daftar yatim diambil LIVE dari
 * groupFetchAllParticipating saat admin buka halaman Grup. WA off → [].
 */
async function listOrphanGroups(tenantId) {
  // v3.9.6 — fetch yatim dari SEMUA slot connected (slot-0 saja bikin grup yang
  // cuma di-invite ke nomor slot-1 tak kelihatan — QA Kanaka 24 Sep 10:47).
  const max = Number(wa.MAX_SLOT) || 2
  const merged = new Map()
  let anyConnected = false
  for (let s = 0; s <= max; s++) {
    const sock = wa.getSocketForTenant(tenantId, s)
    if (!sock) continue
    anyConnected = true
    try {
      const all = await sock.groupFetchAllParticipating()
      for (const [gid, meta] of Object.entries(all || {})) {
        if (!isGroupJid(gid) || merged.has(gid)) continue
        merged.set(gid, meta)
      }
    } catch (e) {
      console.error(`[Groups] listOrphanGroups slot-${s} error (non-fatal):`, e.message)
    }
  }
  if (!anyConnected) return []
  try {
    const gids = [...merged.keys()]
    if (gids.length === 0) return []
    const known = await prisma.chat.findMany({ where: { tenantId, waJid: { in: gids } }, select: { waJid: true } })
    const knownSet = new Set(known.map(c => c.waJid))
    return gids.filter(gid => !knownSet.has(gid)).map(gid => ({
      id: gid,
      name: merged.get(gid)?.subject || gid,
      phoneJid: gid,
      memberCount: merged.get(gid)?.size ?? null,
      orphan: true,
      isGroup: true,
      picUserId: null,
      pic: null,
      unreadCount: 0,
      lastMessageAt: null,
      lastMessagePreview: null,
    }))
  } catch (e) {
    console.error('[Groups] listOrphanGroups error (non-fatal):', e.message)
    return []
  }
}

// ─── List ─────────────────────────────────────────────────────────────
/**
 * GET /api/groups — PIC: miliknya; admin: semua + yatim; lainnya: [].
 */
async function listGroups(user, tenantId) {
  const groupCondition = { OR: [{ waJid: { endsWith: GROUP_SUFFIX } }, { phoneJid: { endsWith: GROUP_SUFFIX } }] }
  const AND = [groupCondition]
  if (!isAdmin(user)) AND.push({ picUserId: user.id })

  const rows = await prisma.chat.findMany({
    where: { AND, tenantId },
    include: { assignedTo: { select: { id: true, username: true, role: true } } },
    orderBy: { lastMessageAt: 'desc' },
    take: 200,
  })

  const groups = rows.map(c => ({
    id: c.id,
    waJid: c.waJid,
    name: c.contactName || c.waJid,
    phoneJid: c.phoneJid || c.waJid,
    isGroup: true,
    orphan: isOrphanRow(c),
    picUserId: c.picUserId,
    numberSlot: Number(c.numberSlot) || 0, // v3.9.6 — slot nomor admin grup
    pic: c.assignedTo ? { id: c.assignedTo.id, username: c.assignedTo.username, role: c.assignedTo.role } : null,
    unreadCount: c.unreadCount || 0,
    lastMessageAt: c.lastMessageAt,
    lastMessagePreview: c.lastMessagePreview != null ? decryptTextSafe(c.lastMessagePreview) : null,
    status: c.status,
  }))

  // Grup yatim HANYA untuk admin (spec §3); WA belum terhubung → skip live-fetch.
  if (isAdmin(user)) {
    const orphans = await listOrphanGroups(tenantId)
    groups.push(...orphans)
  }

  return groups
}

// ─── Detail ───────────────────────────────────────────────────────────
async function fetchGroupMetadata(tenantId, chatId, slot = null) {
  // v3.9.6 — slot eksplisit = socket pemilik grup; null = fallback legacy slot-0
  // (caller orphan tanpa row). Untuk row, SELALU pass slot row.
  const sock = wa.getSocketForTenant(tenantId, slot == null ? 0 : slot)
  try {
    return await sock.groupMetadata(chatId)
  } catch (e) {
    throw mapWaError(e, 'groupMetadata')
  }
}

async function getGroupDetail(user, tenantId, chatId) {
  // Orphan (belum ada row Chat): hanya admin, metadata live dari WA.
  let row = await findGroupChat(tenantId, chatId)
  if (!row) {
    if (!isAdmin(user)) throw new GroupServiceError('FORBIDDEN', 403, 'Anda tidak memiliki akses ke grup ini')
    // v3.9.6 — orphan: coba SEMUA slot connected (grup mungkin cuma di-invite ke slot-1).
    // v3.9.6b (audit MEDIUM-1) — orphan: slot hasil temuan diteruskan ke payload
    // (botJids/botIsAdmin/invite-code via slot yang BENAR, bukan selalu slot-0).
    const { metadata, slot: orphanSlot } = await fetchGroupMetadataAnySlot(tenantId, chatId)
    return buildDetailPayload(tenantId, null, metadata, orphanSlot)
  }
  chatId = row.waJid // v3.9.11 — WA call pakai JID asli row (input bisa id numerik)
  assertCanSee(user, row)
  assertWaReadyForRow(tenantId, row)
  const metadata = await fetchGroupMetadata(tenantId, chatId, slotOfRow(row))
  return buildDetailPayload(tenantId, row, metadata)
}

async function buildDetailPayload(tenantId, row, metadata, orphanSlot = 0) {
  // v3.9.6b — effSlot: row → slot pemilik; orphan → slot hasil fetchAnySlot.
  const effSlot = row ? slotOfRow(row) : (Number(orphanSlot) || 0)
  // Nama member dari Contact bila ada (pola contacts.js: phone normalized 62…)
  // v0.14.3 — cari kontak by LID digits ATAU nomor asli (phoneNumber) sekaligus.
  const digits = (metadata.participants || []).flatMap(p => {
    const arr = [digitsOf(p.id)]
    if (p.phoneNumber) arr.push(digitsOf(p.phoneNumber))
    return arr
  })
  let contactMap = new Map()
  if (digits.length) {
    const contacts = await prisma.contact.findMany({ where: { tenantId, phone: { in: digits } }, select: { phone: true, name: true } })
    contactMap = new Map(contacts.map(c => [c.phone, c.name]))
  }
  const botJids = getBotJids(tenantId, effSlot)
  const botDigits = new Set([...botJids].map(digitsOf))

  const members = (metadata.participants || []).map(p => {
    const phone = digitsOf(p.id)
    // v0.14.3 — nomor asli bila WA mengirimnya (phoneNumber utk LID participant):
    // dipakai utk nama kontak + panel Kelola + auto-heal kontak LID→phone.
    const pn = p.phoneNumber ? digitsOf(p.phoneNumber) : null
    return {
      jid: p.id,
      phone,
      // v0.14.0b — nama: Contact DB (LID-atau-nomor asli) > notify (nama profil WA) > null
      name: contactMap.get(phone) || (pn && contactMap.get(pn)) || p.notify || null,
      notify: p.notify || null,
      pn,
      isAdmin: !!(p.isAdmin || p.admin === 'admin' || p.admin === 'superadmin'),
      isBot: botJids.has(p.id) || botDigits.has(phone),
    }
  })

  const botIsAdmin = botIsAdminFromMetadata(tenantId, metadata, effSlot)

  let inviteCode = metadata.inviteCode || null
  if (!inviteCode && botIsAdmin) {
    try {
      const detailSock = wa.getSocketForTenant(tenantId, effSlot)
      inviteCode = detailSock ? await detailSock.groupInviteCode(metadata.id) || null : null
    } catch (e) { /* non-fatal */ }
  }

  return {
    group: row ? {
      id: row.id,
      waJid: row.waJid,
      name: row.contactName || metadata.subject || row.waJid,
      phoneJid: row.phoneJid || row.waJid,
      isGroup: true,
      orphan: isOrphanRow(row),
      picUserId: row.picUserId,
      numberSlot: slotOfRow(row), // v3.9.6 — slot nomor admin grup
      pic: row.assignedTo ? { id: row.assignedTo.id, username: row.assignedTo.username } : null,
      unreadCount: row.unreadCount || 0,
      status: row.status,
      lastMessageAt: row.lastMessageAt,
      lastMessagePreview: row.lastMessagePreview != null ? decryptTextSafe(row.lastMessagePreview) : null,
    } : {
      id: metadata.id,
      name: metadata.subject || metadata.id,
      phoneJid: metadata.id,
      isGroup: true,
      orphan: true,
      picUserId: null,
      pic: null,
      unreadCount: 0,
      status: null,
    },
    description: metadata.desc || null,
    announcement: !!metadata.announce,
    locked: !!metadata.restrict,
    approval: !!metadata.joinApprovalMode,
    memberAddMode: !!metadata.memberAddMode,
    botIsAdmin,
    inviteCode,
    inviteUrl: inviteCode ? `https://chat.whatsapp.com/${inviteCode}` : null,
    members,
  }
}

// ─── Create ───────────────────────────────────────────────────────────
/**
 * POST /api/groups — admin: pilih PIC (default diri); CS: otomatis PIC dia;
 * relay → 403. Grup born-assigned (picUserId + assignedToId sekaligus).
 */
async function createGroup(user, tenantId, body) {
  if (user.role === 'relay') {
    throw new GroupServiceError('FORBIDDEN', 403, 'Role Cabang tidak dapat membuat grup')
  }
  const subject = String(body.subject || body.name || '').trim()
  if (!subject) throw new GroupServiceError('VALIDATION', 400, 'Nama grup wajib diisi')
  if (subject.length > 100) throw new GroupServiceError('VALIDATION', 400, 'Nama grup maksimal 100 karakter')
  const description = body.description != null ? String(body.description).trim().slice(0, 500) : null

  // v3.9.6 — pilih nomor pembuat grup (jadi admin WA): body.slot (0..MAX_SLOT).
  // Default 0 = status quo (nomor utama). Row TenantNumber wajib ada.
  const createSlot = await resolveCreateSlot(tenantId, body.slot)

  // PIC: admin boleh pilih (termasuk cabang/relay — spec §3); CS → diri sendiri.
  let picUserId = user.id
  if (isAdmin(user) && body.picUserId != null) {
    const pic = await prisma.user.findFirst({ where: { id: parseInt(body.picUserId, 10), tenantId }, select: { id: true, status: true } })
    if (!pic || pic.status !== 'active') {
      throw new GroupServiceError('VALIDATION', 400, 'User PIC tidak ditemukan atau tidak aktif')
    }
    picUserId = pic.id
  }

  assertWaReadySlot(tenantId, createSlot)
  const sock = wa.getSocketForTenant(tenantId, createSlot)
  let metadata
  try {
    metadata = await sock.groupCreate(subject, [])
  } catch (e) {
    throw mapWaError(e, 'groupCreate')
  }
  const gid = metadata?.id
  if (!gid || !isGroupJid(gid)) {
    throw new GroupServiceError('WA_GAGAL', 502, 'WhatsApp tidak mengembalikan ID grup yang valid')
  }

  // Hotfix v0.14.0a — race dgn chats.upsert (Baileys): row utk grup baru bisa
  // sudah dibuat oleh upsertChat() sebelum insert di sini → P2002 unique id.
  // Grup di WA sebenarnya sukses dibuat; pakai upsert + pastikan PIC terisi.
  // queuedAt: null → kalau upsertChat sempat masukin antrean, keluarkan lagi
  // (grup yang dikelola PIC tidak perlu ngantre). Retry 1x utk jendela ms antara
  // find & create upsert (SQLite tidak punya upsert native di Prisma).
  const chatData = {
    tenantId,
    waJid: gid,
    contactPhone: gid.split('@')[0],
    contactName: subject,
    phoneJid: gid,
    picUserId,
    assignedToId: picUserId, // born-assigned — guard existing otomatis jalan (spec §4)
    status: 'open',
    unreadCount: 0,
    numberSlot: createSlot, // v3.9.6 — slot pemilik grup (nomor pembuat/admin WA)
  }
  const chatUpdate = { picUserId, assignedToId: picUserId, queuedAt: null, numberSlot: createSlot }
  // v3.9.2 K1-A — grup (@g.us) TIDAK dipisah per slot (1 grup = 1 baris): lookup
  // by (tenantId, waJid) via findFirst; numberSlot row = slot pemilik grup (v3.9.6).
  let chat
  try {
    chat = await findGroupChatRowAnySlot(tenantId, gid) || await prisma.chat.create({ data: { ...chatData, numberSlot: createSlot } })
    chat = await prisma.chat.update({ where: { id: chat.id }, data: chatUpdate })
  } catch (e) {
    if (e?.code !== 'P2002') throw e
    chat = await findGroupChatRowAnySlot(tenantId, gid)
    if (!chat) throw e
    chat = await prisma.chat.update({ where: { id: chat.id }, data: chatUpdate })
  }

  await logAction(user.id, tenantId, chat.id, 'create', `subject="${subject}" picUserId=${picUserId} slot=${createSlot}`)

  // Anggota awal (opsional) → lewat groupParticipantsUpdate utk partial-failure
  // per-member (groupCreate tidak melaporkan kegagalan per nomor).
  let memberResults = []
  const phonesRaw = Array.isArray(body.phones) ? body.phones : (Array.isArray(body.participants) ? body.participants : [])
  if (phonesRaw.length) {
    memberResults = await addParticipants(tenantId, gid, phonesRaw, createSlot)
    await logAction(user.id, tenantId, chat.id, 'add', `anggota awal: ${JSON.stringify(memberResults.map(r => ({ phone: r.phone, status: r.status })))}`)
  }
  // v0.14.7 — kontak LID-only (tanpa nomor asli): WA menolak add langsung →
  // fallback kirim LINK UNDANGAN ke chat 1:1 mereka (join mandiri via link).
  const lidsRaw = Array.isArray(body.lids) ? body.lids : []
  if (lidsRaw.length) {
    const inviteResults = await sendGroupInviteLinks(user, tenantId, gid, lidsRaw, subject)
    memberResults = [...memberResults, ...inviteResults]
  }
  if (description) {
    try {
      await sock.groupUpdateDescription(gid, description)
    } catch (e) {
      console.error('[Groups] set description error (non-fatal):', e.message)
    }
  }

  emitGroupUpdate(tenantId, chat.id)
  const pic = await prisma.user.findUnique({ where: { id: picUserId }, select: { id: true, username: true, role: true } })
  return {
    group: {
      id: chat.id,
      waJid: chat.waJid,
      name: chat.contactName,
      phoneJid: chat.phoneJid,
      isGroup: true,
      orphan: false,
      picUserId,
      pic: pic ? { id: pic.id, username: pic.username, role: pic.role } : null,
      unreadCount: 0,
      lastMessageAt: null,
      lastMessagePreview: null,
      status: 'open',
    },
    memberResults,
  }
}

// ─── Members ──────────────────────────────────────────────────────────
/**
 * Jalankan groupParticipantsUpdate → map hasil per-member (partial failure).
 * Return [{phone, status: 'ok'|'error', error?}]
 */
async function addParticipants(tenantId, chatId, phonesRaw, slot = 0) {
  const { jids, results } = normalizePhoneInputs(phonesRaw)
  if (!jids.length) return results
  for (const r of results) if (r.jid) r.sentJid = r.jid
  // v3.9.6 — aksi member via socket slot PEMILIK grup
  const sock = wa.getSocketForTenant(tenantId, Number(slot) || 0)
  let response
  try {
    response = await sock.groupParticipantsUpdate(chatId, jids, 'add')
  } catch (e) {
    throw mapWaError(e, 'groupParticipantsUpdate(add)')
  }
  const mapped = mergeParticipantResults(results, response, 'add')
  // Ground truth: participant yang kini tercatat di metadata = beneran masuk.
  return reconcileWithMetadata(tenantId, chatId, mapped)
}

/** Petakan respons Baileys [{status, jid, content}] ke hasil per-nomor input.
 * v0.14.3 — respons WA utk grup LID balik sbg JID @lid (bukan nomor HP): match
 * perlu 3 jalur — digits JID respons, digits phone_number di attrs respons, dan
 * digits JID yang dikirim (sentJid bisa LID setelah mapping).
 * `action` dipakai utk note 409 yang sesuai konteks (add vs remove). */
function mergeParticipantResults(results, response, action = 'add') {
  const byDigits = new Map()
  const byPhoneDigits = new Map()
  for (const r of (response || [])) {
    const d = digitsOf(r.jid)
    if (d) byDigits.set(d, r.status)
    // Baileys v7: node participant bawa attrs.phone_number utk LID participant
    const pn = r?.content?.attrs?.phone_number || r?.content?.attrs?.phoneNumber
    if (pn) { const pd = digitsOf(pn); if (pd) byPhoneDigits.set(pd, r.status) }
  }
  const STATUS_TEXT = {
    '200': null,
    '403': 'Gagal — privasi nomor / baru dihapus dari grup',
    '404': 'Gagal — nomor tidak terdaftar di WhatsApp',
    '408': 'Gagal — baru saja keluar dari grup',
    '401': 'Gagal — tidak diizinkan',
    '500': 'Gagal — error server WhatsApp',
  }
  for (const r of results) {
    if (r.status !== 'pending') continue
    const sentDigits = digitsOf(r.sentJid || r.jid)
    let st = byDigits.get(sentDigits)
    if (st == null) st = byPhoneDigits.get(sentDigits)
    if (st == null) {
      r.status = 'error'
      r.error = 'Tidak ada respons dari WhatsApp'
    } else {
      // v0.14.3 — 409 = target sudah dalam state tujuan → idempoten: sukses + catatan
      if (String(st) === '409') {
        r.status = 'ok'
        r.error = action === 'remove' ? 'Bukan member — sudah keluar sebelumnya' : 'Sudah menjadi member grup'
        delete r.jid
        delete r.sentJid
        continue
      }
      const errText = STATUS_TEXT[String(st)] != null ? STATUS_TEXT[String(st)] : (String(st) === '200' ? null : `Gagal (status ${st})`)
      if (!errText) {
        r.status = 'ok'
      } else {
        r.status = 'error'
        r.error = errText
      }
    }
    delete r.jid
    delete r.sentJid // v0.14.3 — internal, jangan bocor ke API response
  }
  return results
}

// ─── v0.14.3 — LID mapping: kirim JID participant asli, bukan phone-jid ──
/**
 * WA grup skrg pakai participant @lid; groupParticipantsUpdate dgn phone-jid
 * ke grup ber-LID → internal-server-error (kasus remove grup hello 10:32).
 * Mapping: groupMetadata v7 bawa phoneNumber utk tiap participant → digits → JID.
 * Nomor yg BELUM member (add) tidak ada di metadata → tetap phone-jid (WA resolve).
 */
async function mapToParticipantJids(tenantId, chatId, jids, slot = 0) {
  // v3.9.6 — metadata via slot pemilik grup
  const sock = wa.getSocketForTenant(tenantId, Number(slot) || 0)
  let meta
  try {
    meta = await sock.groupMetadata(chatId)
  } catch (e) {
    return jids // metadata gagal → jangan blokir, kirim apa adanya
  }
  const byPhone = new Map()
  for (const p of (meta.participants || [])) {
    if (p.phoneNumber) byPhone.set(digitsOf(p.phoneNumber), p.id)
    byPhone.set(digitsOf(p.id), p.id)
  }
  return jids.map(j => byPhone.get(digitsOf(j)) || j)
}

/** Verifikasi kebenaran final via metadata: participant yg kini anggota grup → ok. */
async function reconcileWithMetadata(tenantId, chatId, results, slot = 0) {
  const stillPendingErrors = results.filter(r => r.status === 'error' && r.error === 'Tidak ada respons dari WhatsApp')
  if (!stillPendingErrors.length) return results
  // v3.9.6 — metadata via slot pemilik grup
  const sock = wa.getSocketForTenant(tenantId, Number(slot) || 0)
  let meta
  try {
    meta = await sock.groupMetadata(chatId)
  } catch {
    return results
  }
  const memberPhones = new Set()
  for (const p of (meta.participants || [])) {
    if (p.phoneNumber) memberPhones.add(digitsOf(p.phoneNumber))
    memberPhones.add(digitsOf(p.id))
  }
  for (const r of results) {
    if (r.status === 'error' && r.error === 'Tidak ada respons dari WhatsApp' && memberPhones.has(r.phone)) {
      r.status = 'ok'
      delete r.error
    }
  }
  return results
}

/**
 * POST /api/groups/:id/members — {phones[], action: add|remove|promote|demote}
 * Respons per-member {phone, status, error?} — partial failure friendly (spec §5).
 */
async function updateMembers(user, tenantId, chatId, body) {
  const row = await findGroupChat(tenantId, chatId)
  if (!row) throw new GroupServiceError('NOT_FOUND', 404, 'Grup tidak ditemukan')
  assertCanSee(user, row)

  const action = String(body.action || '').toLowerCase()
  if (!['add', 'remove', 'promote', 'demote'].includes(action)) {
    throw new GroupServiceError('VALIDATION', 400, 'action wajib salah dari: add, remove, promote, demote')
  }
  const phonesRaw = Array.isArray(body.phones) ? body.phones : (body.phone ? [body.phone] : [])
  // v0.14.7 — lids[]: chat id 1:1 target (kontak LID-only) — hanya utk action add.
  const lidsRaw = (action === 'add' && Array.isArray(body.lids)) ? body.lids : []
  if (!phonesRaw.length && !lidsRaw.length) {
    throw new GroupServiceError('VALIDATION', 400, 'phones[] atau lids[] wajib diisi')
  }

  chatId = row.waJid // v3.9.11 — WA call pakai JID asli row (input bisa id numerik)
  assertWaReadyForRow(tenantId, row)
  const gslot = slotOfRow(row)
  const sock = wa.getSocketForTenant(tenantId, gslot)

  let results
  if (action === 'add') {
    results = phonesRaw.length ? await addParticipants(tenantId, chatId, phonesRaw, gslot) : []
    // v0.14.7 — kontak LID-only: kirim link undangan ke chat 1:1 (join via link).
    if (lidsRaw.length) {
      const inviteResults = await sendGroupInviteLinks(user, tenantId, chatId, lidsRaw, row.contactName || 'grup')
      results = [...results, ...inviteResults]
    }
  } else {
    const { jids, results: pre } = normalizePhoneInputs(phonesRaw)
    results = pre
    if (jids.length) {
      // v0.14.3 — kirim JID participant asli (LID): remove/promote/demote dgn
      // phone-jid ke grup ber-LID ditolak WA (kasus remove grup hello 10:32).
      for (const r of results) if (r.jid) r.sentJid = r.jid
      const targetJids = await mapToParticipantJids(tenantId, chatId, jids, gslot)
      let response
      try {
        response = await sock.groupParticipantsUpdate(chatId, targetJids, action)
      } catch (e) {
        throw mapWaError(e, `groupParticipantsUpdate(${action})`)
      }
      results = mergeParticipantResults(results, response, action)
      // Ground truth utk remove: nomor yang kini TIDAK lagi di metadata = beneran keluar.
      if (action === 'remove') {
        let meta = null
        try { meta = await sock.groupMetadata(chatId) } catch { /* non-fatal */ }
        if (meta) {
          const memberPhones = new Set()
          for (const p of (meta.participants || [])) {
            if (p.phoneNumber) memberPhones.add(digitsOf(p.phoneNumber))
            memberPhones.add(digitsOf(p.id))
          }
          for (const r of results) {
            if (r.status !== 'ok' && !memberPhones.has(r.phone)) {
              r.status = 'ok'
              delete r.error // WA gagal tapi target sudah bukan member → done
            }
          }
        }
      }
    }
  }

  await logAction(user.id, tenantId, row.id, action, JSON.stringify(results.map(r => ({ phone: r.phone, status: r.status, error: r.error || undefined }))))
  emitGroupUpdate(tenantId, chatId)
  return { results }
}

// ─── v0.14.7 — Invite via link (kontak LID-only) ──────────────────────
/**
 * Kirim link undangan grup ke chat 1:1 target (kontak LID-only yang tidak
 * bisa di-add langsung — WA menolak add tanpa nomor asli; LID ≠ phone).
 * Pola pmParticipant: kirim WA → upsert Chat born-assigned (P2002 retry) →
 * Message enkripsi at-rest → broadcast. Partial failure per-target; isolasi
 * chat 1:1 dijaga (dipegang CS lain → error per-target, admin bebas).
 * @returns Array<{phone: label, status: 'ok'|'error', error?, viaLink: true}>
 */
async function sendGroupInviteLinks(user, tenantId, chatId, lidJids, groupName) {
  const row = await findGroupChat(tenantId, chatId)
  if (!row) throw new GroupServiceError('NOT_FOUND', 404, 'Grup tidak ditemukan')
  chatId = row.waJid // v3.9.11 — WA call pakai JID asli row (input bisa id numerik)
  assertCanSee(user, row)
  // v3.9.6 — PM/invite-link ke chat 1:1 TETAP slot-0 (isolasi 1:1 status quo) —
  // tapi kode invite diambil via slot PEMILIK grup (yang mungkin admin WA).
  assertWaReady(tenantId)
  const sock = wa.getSocketForTenant(tenantId)

  // Invite code (pola getGroupDetail): metadata dulu; bot admin → groupInviteCode.
  let inviteCode = null
  try {
    const metadata = await fetchGroupMetadata(tenantId, chatId, slotOfRow(row))
    inviteCode = metadata?.inviteCode || null
    if (!inviteCode && botIsAdminFromMetadata(tenantId, metadata, slotOfRow(row))) {
      inviteCode = await wa.getSocketForTenant(tenantId, slotOfRow(row)).groupInviteCode(chatId).catch(() => null)
    }
  } catch (e) { /* non-fatal — fallback di bawah */ }
  if (!inviteCode) {
    // Fallback: coba slot pemilik dulu, lalu slot-0 (legacy).
    // v3.9.6b (audit HIGH-1) — socket slot bisa NULL saat disconnect: cek dulu
    // SEBELUM .method() (TypeError sinkron tidak tertangkap .catch).
    const ownerSock = wa.getSocketForTenant(tenantId, slotOfRow(row))
    if (ownerSock) inviteCode = await ownerSock.groupInviteCode(chatId).catch(() => null)
    if (!inviteCode && sock) inviteCode = await sock.groupInviteCode(chatId).catch(() => null)
  }
  if (!inviteCode) {
    throw new GroupServiceError('WA_GAGAL', 502, 'Gagal mengambil link undangan grup (pastikan bot masih anggota grup)')
  }
  const inviteUrl = `https://chat.whatsapp.com/${inviteCode}`
  const text = `Anda diundang bergabung ke grup WhatsApp "${groupName}".\nKlik link berikut untuk bergabung:\n${inviteUrl}`

  const results = []
  for (const raw of lidJids) {
    const jid = String(raw || '').trim()
    let display = jid || '(kosong)'
    try {
      const pj = validateParticipantJid(jid)

      // Label manusiawi: nama kontak tersimpan (Contact linked by chatId Int).
      // v3.9.2 K1-A — 1 identity per orang: contact by phone (nomor asli — slot
      // apapun); @lid tanpa nomor asli → fallback contact via chat (slot apapun).
      const ct = pj.isPhoneJid
        ? await prisma.contact.findFirst({ where: { tenantId, phone: pj.digits }, select: { name: true } })
        : await prisma.contact.findFirst({ where: { tenantId, chat: { waJid: pj.jid } }, select: { name: true } })
      display = (ct?.name || '').trim() || pj.jid

      // Isolasi: chat 1:1 dipegang CS lain → error per-target (bukan throw — partial).
      // v3.9.2 K1-A — cek SEMUA chat 1:1 nomor ini (slot apapun): pesan group-invite
      // dikirim via socket slot-0 (getSocketForTenant default).
      const existingChat = await prisma.chat.findFirst({
        where: { tenantId, waJid: pj.jid, assignedToId: { not: null } },
        orderBy: { id: 'asc' },
      })
      if (existingChat && existingChat.assignedToId != null && existingChat.assignedToId !== user.id && !isAdmin(user)) {
        results.push({ phone: display, status: 'error', error: 'Chat 1:1 sedang dipegang CS lain', viaLink: true })
        continue
      }

      // Kirim WA dulu — @lid jid valid utk kirim (Baileys v7, pola pmParticipant).
      const waResult = await sock.sendMessage(pj.jid, { text })

      // Upsert Chat 1:1 anti-race (pola createGroup/pmParticipant — P2002 retry).
      // v3.9.2 K1-A — find-or-create per (tenantId, numberSlot, waJid); PM dari
      // grup = slot-0 (sama dgn socket pengirim), existing slot lain gak disentuh.
      const chatData = {
        tenantId,
        waJid: pj.jid,
        contactPhone: pj.digits, // Chat.contactPhone = fallback display (pola upsertChat), BUKAN Contact.phone
        contactName: ct?.name || null,
        phoneJid: pj.isPhoneJid ? pj.jid : null,
        numberSlot: 0,
        assignedToId: user.id,
        status: 'open',
        unreadCount: 0,
      }
      const chatUpdate = {} // chat existing tidak disentuh assignment-nya
      let pmChat
      try {
        pmChat = await prisma.chat.findFirst({ where: { tenantId, numberSlot: 0, waJid: pj.jid } })
        if (!pmChat) {
          pmChat = await prisma.chat.create({ data: chatData }).catch(async (e) => {
            if (e?.code !== 'P2002') throw e
            return prisma.chat.findFirst({ where: { tenantId, numberSlot: 0, waJid: pj.jid } })
          })
        }
        if (Object.keys(chatUpdate).length > 0) {
          pmChat = await prisma.chat.update({ where: { id: pmChat.id }, data: chatUpdate })
        }
      } catch (e) {
        if (e?.code !== 'P2002') throw e
        pmChat = await prisma.chat.findFirst({ where: { tenantId, numberSlot: 0, waJid: pj.jid } })
      }

      // Auto-reopen: chat resolved → open lagi (pola reply/pmParticipant).
      let chatStatus = pmChat.status
      if (pmChat.status === 'resolved') {
        await prisma.chat.update({
          where: { id: pmChat.id },
          data: { status: 'open', resolvedAt: null, reopenedCount: { increment: 1 } },
        })
        await prisma.chatEvent.create({
          data: { tenantId, chatId: pmChat.id, userId: user.id, type: 'reopened', createdAt: new Date() },
        })
        chatStatus = 'open'
      }

      // Simpan Message — enkripsi at-rest (pola v0.11.0).
      const dbMsg = await prisma.message.create({
        data: {
          tenantId,
          chatId: pmChat.id,
          direction: 'out',
          content: encryptText(text),
          senderName: user.username,
          senderId: user.id,
          waMessageId: waResult?.key?.id || null,
          status: 'sent',
          timestamp: new Date(),
        },
      })
      await prisma.chat.update({
        where: { id: pmChat.id },
        data: { lastMessageAt: dbMsg.timestamp, lastMessagePreview: encryptText(text) },
      })
      broadcast.emitToTenant(tenantId, 'new_message', {
        chatId: pmChat.id,
        assignedToId: pmChat.assignedToId ?? null,
        status: chatStatus,
        message: { ...dbMsg, content: text },
      })
      broadcast.emitToTenant(tenantId, 'chat_update', {
        chatId: pmChat.id,
        lastMessage: text,
        lastMessageAt: dbMsg.timestamp,
      })
      results.push({ phone: display, status: 'ok', viaLink: true })
    } catch (e) {
      results.push({ phone: display, status: 'error', error: e?.message || 'Gagal mengirim link undangan', viaLink: true })
    }
  }

  await logAction(user.id, tenantId, row.id, 'invite_link', `group="${groupName}" → ${JSON.stringify(results.map(r => ({ to: r.phone, status: r.status })))}`)
  return results
}

// ─── Rename / description ─────────────────────────────────────────────
async function updateGroupInfo(user, tenantId, chatId, body) {
  const row = await findGroupChat(tenantId, chatId)
  if (!row) throw new GroupServiceError('NOT_FOUND', 404, 'Grup tidak ditemukan')
  assertCanSee(user, row)

  const name = body.name != null ? String(body.name).trim() : null
  const description = body.description != null ? String(body.description).trim() : null
  if (name != null && !name) throw new GroupServiceError('VALIDATION', 400, 'Nama grup tidak boleh kosong')
  if (name == null && description == null) throw new GroupServiceError('VALIDATION', 400, 'Tidak ada perubahan (name/description)')

  chatId = row.waJid // v3.9.11 — WA call pakai JID asli row (input bisa id numerik)
  // v3.9.6 — rename/description via slot PEMILIK grup
  assertWaReadyForRow(tenantId, row)
  const sock = wa.getSocketForTenant(tenantId, slotOfRow(row))
  try {
    if (name) await sock.groupUpdateSubject(chatId, name)
    if (description != null) await sock.groupUpdateDescription(chatId, description)
  } catch (e) {
    throw mapWaError(e, 'groupUpdateSubject/Description')
  }

  if (name) {
    await prisma.chat.update({ where: { id: row.id }, data: { contactName: name } })
    await logAction(user.id, tenantId, row.id, 'rename', `subject="${name}"`)
  }
  if (description != null) await logAction(user.id, tenantId, row.id, 'rename', `description diubah (${description.length} char)`)
  emitGroupUpdate(tenantId, chatId)
  return { ok: true, name: name || row.contactName }
}

// ─── Settings ─────────────────────────────────────────────────────────
/**
 * POST /api/groups/:id/settings — {announcement?, locked?, approval?, memberAddMode?}
 * announcement → groupSettingUpdate('announcement'|'not_announcement')
 * locked       → groupSettingUpdate('locked'|'unlocked')
 * approval     → groupJoinApprovalMode('on'|'off')
 * memberAddMode→ groupMemberAddMode('admin_add'|'all_member_add')
 */
async function updateSettings(user, tenantId, chatId, body) {
  const row = await findGroupChat(tenantId, chatId)
  if (!row) throw new GroupServiceError('NOT_FOUND', 404, 'Grup tidak ditemukan')
  assertCanSee(user, row)
  chatId = row.waJid // v3.9.11 — WA call pakai JID asli row (input bisa id numerik)
  // v3.9.6 — settings via slot PEMILIK grup
  assertWaReadyForRow(tenantId, row)

  const sock = wa.getSocketForTenant(tenantId, slotOfRow(row))
  const applied = []
  const failed = []
  const truthy = v => v === true || v === 'true' || v === 1

  const steps = []
  if (body.announcement !== undefined) steps.push({ key: 'announcement', run: () => sock.groupSettingUpdate(chatId, truthy(body.announcement) ? 'announcement' : 'not_announcement'), value: !!truthy(body.announcement) })
  if (body.locked !== undefined) steps.push({ key: 'locked', run: () => sock.groupSettingUpdate(chatId, truthy(body.locked) ? 'locked' : 'unlocked'), value: !!truthy(body.locked) })
  if (body.approval !== undefined) steps.push({ key: 'approval', run: () => sock.groupJoinApprovalMode(chatId, truthy(body.approval) ? 'on' : 'off'), value: !!truthy(body.approval) })
  if (body.memberAddMode !== undefined) steps.push({ key: 'memberAddMode', run: () => sock.groupMemberAddMode(chatId, truthy(body.memberAddMode) ? 'all_member_add' : 'admin_add'), value: !!truthy(body.memberAddMode) })

  if (!steps.length) throw new GroupServiceError('VALIDATION', 400, 'Tidak ada pengaturan yang dikirim (announcement/locked/approval/memberAddMode)')

  for (const step of steps) {
    try {
      await step.run()
      applied.push({ setting: step.key, value: step.value })
    } catch (e) {
      const mapped = mapWaError(e, `setting:${step.key}`)
      failed.push({ setting: step.key, error: mapped.code, message: mapped.message })
    }
  }

  await logAction(user.id, tenantId, row.id, 'setting', JSON.stringify({ applied, failed }))
  emitGroupUpdate(tenantId, chatId)

  if (applied.length === 0 && failed.length > 0) {
    // Semua gagal → 422 BOT_BUKAN_ADMIN bila penyebabnya admin, else WA_GAGAL
    const adminFail = failed.every(f => f.error === 'BOT_BUKAN_ADMIN')
    throw new GroupServiceError(adminFail ? 'BOT_BUKAN_ADMIN' : 'WA_GAGAL', adminFail ? 422 : 502, failed[0].message)
  }
  return { applied, failed }
}

// ─── Invite reset ─────────────────────────────────────────────────────
async function resetInvite(user, tenantId, chatId) {
  const row = await findGroupChat(tenantId, chatId)
  if (!row) throw new GroupServiceError('NOT_FOUND', 404, 'Grup tidak ditemukan')
  assertCanSee(user, row)
  chatId = row.waJid // v3.9.11 — WA call pakai JID asli row (input bisa id numerik)
  // v3.9.6 — revoke invite via slot PEMILIK grup
  assertWaReadyForRow(tenantId, row)
  const sock = wa.getSocketForTenant(tenantId, slotOfRow(row))
  let code
  try {
    code = await sock.groupRevokeInvite(chatId)
  } catch (e) {
    throw mapWaError(e, 'groupRevokeInvite')
  }
  await logAction(user.id, tenantId, row.id, 'invite_reset', 'link invite lama dicabut + kode baru')
  emitGroupUpdate(tenantId, chatId)
  return { inviteCode: code || null, inviteUrl: code ? `https://chat.whatsapp.com/${code}` : null }
}

// ─── Assign PIC (admin only; adopt orphan di sini juga) ───────────────
async function assignPic(user, tenantId, chatId, picUserIdRaw) {
  if (!isAdmin(user)) {
    throw new GroupServiceError('FORBIDDEN', 403, 'Hanya admin yang dapat mengganti PIC grup')
  }
  const picUserId = parseInt(picUserIdRaw, 10)
  if (!Number.isFinite(picUserId)) throw new GroupServiceError('VALIDATION', 400, 'picUserId wajib diisi')
  const pic = await prisma.user.findFirst({ where: { id: picUserId, tenantId }, select: { id: true, status: true, username: true } })
  if (!pic || pic.status !== 'active') {
    throw new GroupServiceError('VALIDATION', 400, 'User PIC tidak ditemukan atau tidak aktif')
  }

  let row = await findGroupChat(tenantId, chatId)
  if (!row) {
    // Adopt grup yatim: buat row Chat born-assigned ke PIC (spec §3/§4).
    // v3.9.6 — metadata via SEMUA slot (orphan bisa milik slot manapun);
    // slot hasil temuan disimpan sbg pemilik row.
    const { metadata, slot: foundSlot } = await fetchGroupMetadataAnySlot(tenantId, chatId)
    // v3.9.6b (audit LOW-1) — anti-race P2002 (pola createGroup): dua admin adopt
    // barengan → yang kalah findExisting lalu update PIC (bukan 500).
    let row = null
    try {
      row = await prisma.chat.create({
        data: {
          tenantId,
          waJid: chatId,
          contactPhone: chatId.split('@')[0],
          contactName: metadata.subject || chatId,
          phoneJid: chatId,
          picUserId,
          assignedToId: picUserId,
          status: 'open',
          unreadCount: 0,
          numberSlot: foundSlot, // v3.9.6 — pemilik = slot yang punya grup di WA
        },
      })
    } catch (e) {
      if (e?.code !== 'P2002') throw e
      row = await findGroupChat(tenantId, chatId)
      if (!row) throw e
    }
    await logAction(user.id, tenantId, row.id, 'assign_pic', `adopt yatim → PIC @${pic.username} (subject="${metadata.subject}" slot=${foundSlot})`)
  } else {
    await prisma.chat.update({
      where: { id: row.id },
      data: { picUserId, assignedToId: picUserId }, // BOTH — spec §4
    })
    await logAction(user.id, tenantId, row.id, 'assign_pic', `PIC → @${pic.username}`)
  }
  emitGroupUpdate(tenantId, chatId)
  return { ok: true, picUserId, pic: { id: pic.id, username: pic.username } }
}

// ═══════════════════════════════════════════════════════════════════════
// v0.14.0 — Pesan grup masuk (dipanggil dari baileys processIncomingMessage)
// Jalur TERPISAH dari 1:1: tidak ada auto-queue, tidak ada first_incoming,
// tidak ada syncContact, tidak ada auto-reply/gateway (semua terkunci utk 1:1).
// Socket: chat-scoped HANYA ke room PIC + admin (spec §5).
// ═══════════════════════════════════════════════════════════════════════
async function handleIncomingGroupMessage(tenantId, msg, ctx) {
  try {
    const { text, mediaType, mediaPath, mediaMime, mediaSize, dbTimestamp, senderName } = ctx
    let chat = ctx.chatRow
    // v3.9.2 K1-A — grup = 1 baris (TIDAK per-slot): findFirst by (tenantId, waJid).
    if (!chat) chat = await prisma.chat.findFirst({ where: { tenantId, waJid: ctx.waJid }, orderBy: { id: 'asc' } })
    if (!chat) {
      // Grup yatim belum di-adopt → TIDAK dibuatkan row (row tanpa PIC akan
      // bocor ke queueWhere()/list 1:1 — queueWhere tidak boleh disentuh).
      console.log(`[Groups] Pesan grup dilewati (belum di-adopt / tanpa PIC): ${ctx.waJid}`) // v3.9.10 — TDZ fix: chatId dideklarasi di bawah
      return
    }

    const fromMe = !!msg.key?.fromMe
    const participantJid = msg.participant || msg.key?.participant || null
    const chatId = chat.id

    const dbMsg = await prisma.message.create({
      data: {
        tenantId,
        chatId,
        direction: fromMe ? 'out' : 'in',
        content: encryptText(text),
        mediaPath,
        mediaType,
        mediaMime,
        mediaSize,
        senderName: senderName || (fromMe ? 'me' : 'Unknown'),
        waMessageId: msg.key?.id || null,
        timestamp: dbTimestamp,
        status: fromMe ? 'sent' : 'delivered',
        participantJid: fromMe ? null : participantJid, // out = agent → nama CS dari senderName
      },
    })

    // Auto-reopen grup resolved: status open TANPA melepas PIC (beda dgn 1:1
    // yang melepas assignment ke antrean — grup TIDAK PERNAH ke antrean, spec §3).
    let reopened = false
    if (!fromMe && chat.status === 'resolved') {
      await prisma.chat.update({
        where: { id: chatId },
        data: { status: 'open', resolvedAt: null, reopenedCount: { increment: 1 } },
      })
      await prisma.chatEvent.create({
        data: { tenantId, chatId, userId: null, type: 'reopened', createdAt: dbTimestamp },
      })
      reopened = true
    }

    const preview = text || (mediaType ? `[${mediaType.charAt(0).toUpperCase() + mediaType.slice(1)}]` : '[Media]')
    const newUnread = fromMe ? chat.unreadCount : (chat.unreadCount || 0) + 1
    await prisma.chat.update({
      where: { id: chatId },
      data: {
        lastMessageAt: dbMsg.timestamp,
        lastMessagePreview: encryptText(preview),
        unreadCount: newUnread,
      },
    })

    const rooms = await groupAudienceRooms(tenantId, chat.picUserId)
    const msgPayload = {
      chatId,
      assignedToId: chat.assignedToId ?? null,
      status: reopened ? 'open' : chat.status,
      message: { ...dbMsg, content: text }, // broadcast plaintext (pola v0.11.0)
    }
    for (const room of rooms) {
      broadcast.emitToRoom(room, 'new_message', msgPayload)
      broadcast.emitToRoom(room, 'chat_update', {
        chatId,
        lastMessage: preview,
        lastMessageAt: dbMsg.timestamp,
        unreadCount: newUnread,
        ...(reopened ? { status: 'open', resolvedAt: null } : {}),
      })
    }

    // Push ke PIC saja (bukan broadcast antrean — grup tidak punya antrean).
    if (!fromMe && chat.picUserId) {
      try {
        push.sendToUser(chat.picUserId, {
          kind: 'message',
          chatId,
          title: chat.contactName || 'Grup WhatsApp',
          body: push.truncate(preview),
          url: `/groups?chat=${chatId}`,
        })
      } catch (e) {
        console.error('[Groups] push error (non-fatal):', e.message)
      }
    }
  } catch (e) {
    console.error('[Groups] handleIncomingGroupMessage error (non-fatal):', e.message)
  }
}

// ─── Leave (ops cleanup) ─────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════
// v0.14.1 — Auto-save nama profil anggota grup → Contact (bonus)
// Dipanggil dari baileys.js (blok grup, sebelum handleIncomingGroupMessage).
// ATURAN (locked):
// - Hanya participant @s.whatsapp.net (nomor asli); @lid → coba resolveLidToPhone
//   SEKALI, gagal → skip (JANGAN pernah simpan LID sebagai phone).
// - Contact existing dgn phone sama → isi name HANYA bila name masih null/kosong
//   (JANGAN pernah overwrite nama).
// - Belum ada → create {phone, name, source:'chat'} TANPA chatId (chatId unique
//   untuk chat 1:1 — chatId grup JANGAN dipakai).
// - Non-fatal TOTAL: kegagalan helper TIDAK PERNAH menggagalkan pesan masuk.
// ═══════════════════════════════════════════════════════════════════════
const LID_SUFFIX = '@lid'
const PHONE_SUFFIX = '@s.whatsapp.net'

/** Kumpulan nama profil yang harus diabaikan (placeholder WA / bot sendiri). */
const IGNORED_PUSH_NAMES = new Set(['me', 'unknown', ''])

async function upsertContactFromGroup(tenantId, chatId, participantJid, pushName) {
  try {
    const name = String(pushName || '').trim()
    if (!name || IGNORED_PUSH_NAMES.has(name.toLowerCase())) return

    let jid = String(participantJid || '')
    if (!jid) return

    // @lid → coba resolve ke nomor asli SEKALI; gagal → skip (JANGAN simpan LID).
    if (jid.endsWith(LID_SUFFIX)) {
      const sock = wa.getSocketForTenant(tenantId)
      const resolved = await wa.resolveLidToPhone(sock, jid).catch(() => null)
      if (!resolved || !String(resolved).endsWith(PHONE_SUFFIX)) return
      jid = String(resolved)
    }
    if (!jid.endsWith(PHONE_SUFFIX)) return

    // phone = digits 62…, len 8-15 (normalizePhone yang sudah ada di file ini)
    const phone = normalizePhone(jid.split('@')[0].split(':')[0])
    if (!phone) return

    const existing = await prisma.contact.findFirst({ where: { tenantId, phone } })
    if (existing) {
      // HANYA isi name bila masih null/kosong — JANGAN pernah overwrite nama.
      if (existing.name == null || existing.name === '') {
        await prisma.contact.update({ where: { id: existing.id }, data: { name } })
        console.log(`[Groups] Contact name terisi dari grup (tidak overwrite): +${phone} → "${name}"`)
      }
      return
    }

    // Contact baru: TANPA chatId (chatId unique untuk 1:1; chatId grup jangan dipakai).
    // v3.4 — kuota kontak: skip diam bila penuh (spec §4, non-fatal)
    try {
      const plans = require('../services/plans')
      const quota = await plans.checkContactQuota(tenantId)
      if (!quota.ok) {
        console.warn(`[Groups] Kuota kontak penuh tenant #${tenantId} — contact dari grup di-skip`)
        return
      }
    } catch {}
    await prisma.contact.create({ data: { tenantId, phone, name, source: 'chat' } })
    console.log(`[Groups] Contact baru dari grup: +${phone} "${name}" (chatId=${chatId})`)
  } catch (e) {
    // Non-fatal selalu — jangan pernah gagalkan pesan masuk karena helper ini.
    console.error('[Groups] upsertContactFromGroup error (non-fatal):', e.message)
  }
}

// ═══════════════════════════════════════════════════════════════════════
// v0.14.4 — Participant Action Menu (tap nama pengirim di bubble grup)
// Dua aksi: Simpan ke Kontak + Pesan Pribadi (chat 1:1). ATURAN locked:
// - LID JANGAN PERNAH disimpan sbg phone/phoneJid (lesson 2026-09-18: 9 kontak
//   rusak) — nomor asli diambil dari metadata WA (participant.phoneNumber).
// - Contact existing: name HANYA diisi bila masih kosong (JANGAN overwrite nama).
// - Chat 1:1 peserta di-upsert anti-race (pola createGroup: retry 1x on P2002
//   karena row bisa dibuat duluan oleh upsertChat Baileys).
// - Isolasi: chat 1:1 dipegang CS lain → 403 (kecuali admin), CEK SEBELUM kirim
//   WA supaya tidak ada pesan terkirim lalu ditolak.
// ═══════════════════════════════════════════════════════════════════════

/** Validasi & normalisasi JID participant: @s.whatsapp.net (phone) atau @lid. */
function validateParticipantJid(rawJid) {
  const jid = String(rawJid || '').trim()
  if (!jid) throw new GroupServiceError('VALIDATION', 400, 'JID peserta wajib diisi')
  if (!jid.endsWith(PHONE_SUFFIX) && !jid.endsWith(LID_SUFFIX)) {
    throw new GroupServiceError('VALIDATION', 400, 'JID peserta tidak valid (harus @s.whatsapp.net atau @lid)')
  }
  const digits = digitsOf(jid)
  if (!digits) throw new GroupServiceError('VALIDATION', 400, 'JID peserta tidak valid')
  return { jid, digits, isPhoneJid: jid.endsWith(PHONE_SUFFIX) }
}

/** Cari participant di metadata grup (full JID match, lalu digits match — device suffix ":x" diabaikan). */
function findParticipantInMetadata(metadata, pj) {
  const parts = metadata?.participants || []
  let p = parts.find(x => x.id === pj.jid)
  if (!p) p = parts.find(x => digitsOf(x.id) === pj.digits)
  return p || null
}

/**
 * v0.14.4 — POST /api/groups/:id/participants/:pmJid/save-contact
 * Simpan peserta grup ke Kontak. Nomor asli dari metadata WA (phoneNumber utk
 * participant @lid); pmJid phone-jid → pakai digits-nya langsung.
 */
async function saveParticipantContact(user, tenantId, chatId, pmJidRaw) {
  const row = await findGroupChat(tenantId, chatId)
  if (!row) throw new GroupServiceError('NOT_FOUND', 404, 'Grup tidak ditemukan')
  chatId = row.waJid // v3.9.11 — WA call pakai JID asli row (input bisa id numerik)
  assertCanSee(user, row)
  const pj = validateParticipantJid(pmJidRaw)
  // v3.9.6 — metadata utk cari participant via slot PEMILIK grup (row pasti ada di caller ini)
  const metadata = await fetchGroupMetadata(tenantId, chatId, slotOfRow(row))
  const p = findParticipantInMetadata(metadata, pj)

  // Nomor asli: phone-jid → digits-nya sendiri; @lid → phoneNumber dari metadata.
  let pn = pj.isPhoneJid ? pj.digits : (p?.phoneNumber ? digitsOf(p.phoneNumber) : null)
  pn = normalizePhone(pn)
  if (!pn) {
    throw new GroupServiceError('VALIDATION', 422, 'Nomor asli peserta ini belum tersedia dari WhatsApp — minta dia chat bot dulu atau isi manual di halaman Kontak.')
  }

  const nameFromWa = (p?.notify || '').trim() || null

  const existing = await prisma.contact.findFirst({ where: { tenantId, phone: pn } })
  if (existing) {
    // Kontak sudah ada — JANGAN overwrite nama existing; isi HANYA bila kosong
    // dan nama profil WA (notify) tersedia.
    if ((existing.name == null || existing.name === '') && nameFromWa) {
      await prisma.contact.update({ where: { id: existing.id }, data: { name: nameFromWa } })
      await logAction(user.id, tenantId, row.id, 'save_contact', `pjid=${pj.jid} phone=${pn} name terisi dari profil WA (tidak overwrite)`)
      return { created: false, contact: { id: existing.id, name: nameFromWa, phone: pn } }
    }
    await logAction(user.id, tenantId, row.id, 'save_contact', `pjid=${pj.jid} phone=${pn} (sudah ada)`)
    return { created: false, contact: { id: existing.id, name: existing.name, phone: pn } }
  }

  // Kontak baru: source 'manual' (user-explicit), TANPA chatId (unique utk 1:1).
  const contact = await prisma.contact.create({ data: { tenantId, phone: pn, name: nameFromWa, source: 'manual' } })
  await logAction(user.id, tenantId, row.id, 'save_contact', `pjid=${pj.jid} phone=${pn}`)
  return { created: true, contact: { id: contact.id, name: contact.name, phone: contact.phone } }
}

/**
 * v0.14.4 — POST /api/groups/:id/participants/:pmJid/pm — body {content}
 * Kirim pesan pribadi ke peserta grup + pastikan ada row Chat 1:1 (born-assigned
 * ke user, TANPA queuedAt = tidak masuk antrean). @lid JID valid utk kirim (Baileys v7).
 */
async function pmParticipant(user, tenantId, chatId, pmJidRaw, body) {
  const row = await findGroupChat(tenantId, chatId)
  if (!row) throw new GroupServiceError('NOT_FOUND', 404, 'Grup tidak ditemukan')
  chatId = row.waJid // v3.9.11 — WA call pakai JID asli row (input bisa id numerik)
  assertCanSee(user, row)

  const content = typeof body?.content === 'string' ? body.content.trim() : ''
  if (!content) throw new GroupServiceError('VALIDATION', 400, 'Isi pesan wajib diisi')
  if (content.length > 4096) throw new GroupServiceError('VALIDATION', 400, 'Pesan maksimal 4096 karakter')

  const pj = validateParticipantJid(pmJidRaw)

  // Isolasi SEBELUM kirim: chat 1:1 sudah dipegang CS lain → 403 (admin bebas).
  // Cek awal mencegah pesan terkirim lalu aksi ditolak.
  // v3.9.2 K1-A — cek SEMUA chat 1:1 nomor ini (slot apapun); PM dikirim via slot-0.
  const existingChat = await prisma.chat.findFirst({
    where: { tenantId, waJid: pj.jid, assignedToId: { not: null } },
    orderBy: { id: 'asc' },
  })
  if (existingChat && existingChat.assignedToId != null && existingChat.assignedToId !== user.id && !isAdmin(user)) {
    throw new GroupServiceError('FORBIDDEN', 403, 'Chat 1:1 dengan nomor ini sedang dipegang CS lain')
  }

  assertWaReady(tenantId)
  const sock = wa.getSocketForTenant(tenantId)

  // Nama profil WA (notify) utk contactName chat 1:1 — best-effort, non-fatal.
  // v3.9.6 — metadata via slot PEMILIK grup (notify name konsisten dgn save-contact).
  let notifyName = null
  try {
    const metadata = await fetchGroupMetadata(tenantId, chatId, slotOfRow(row))
    const p = findParticipantInMetadata(metadata, pj)
    if (p) notifyName = (p.notify || '').trim() || null
  } catch (e) { /* non-fatal — kirim pesan tidak boleh gagal karena ini */ }

  // Kirim via WA dulu — @lid jid valid utk kirim (Baileys v7).
  let waResult
  try {
    waResult = await sock.sendMessage(pj.jid, { text: content })
  } catch (e) {
    throw mapWaError(e, 'sendMessage(pm)')
  }

  // Row Chat 1:1: upsert anti-race (pola createGroup — row bisa dibuat duluan
  // oleh chats.upsert Baileys → P2002 → retry 1x). Update = {} : JANGAN rebet
  // assignment/status existing (chat milik orang tidak disentuh). TANPA queuedAt
  // → born-assigned, keluar dari antrean.
  // v3.9.2 K1-A — find-or-create per (tenantId, numberSlot=0, waJid): PM dari grup
  // lewat socket slot-0; existing slot lain gak disentuh.
  const chatData = {
    tenantId,
    waJid: pj.jid,
    contactPhone: pj.digits, // digits nomor asli — LID TIDAK PERNAH disimpan sbg phone
    contactName: notifyName,
    phoneJid: pj.isPhoneJid ? pj.jid : null, // @lid → phoneJid null (pola upsertChat Baileys)
    numberSlot: 0,
    assignedToId: user.id,
    status: 'open',
    unreadCount: 0,
  }
  const chatUpdate = {}
  let pmChat
  try {
    pmChat = await prisma.chat.findFirst({ where: { tenantId, numberSlot: 0, waJid: pj.jid } })
    if (!pmChat) {
      pmChat = await prisma.chat.create({ data: chatData }).catch(async (e) => {
        if (e?.code !== 'P2002') throw e
        return prisma.chat.findFirst({ where: { tenantId, numberSlot: 0, waJid: pj.jid } })
      })
    }
    if (Object.keys(chatUpdate).length > 0) {
      pmChat = await prisma.chat.update({ where: { id: pmChat.id }, data: chatUpdate })
    }
  } catch (e) {
    if (e?.code !== 'P2002') throw e
    pmChat = await prisma.chat.findFirst({ where: { tenantId, numberSlot: 0, waJid: pj.jid } })
  }

  // Safety-net isolasi (race antara cek awal & upsert).
  if (pmChat.assignedToId != null && pmChat.assignedToId !== user.id && !isAdmin(user)) {
    throw new GroupServiceError('FORBIDDEN', 403, 'Chat 1:1 dengan nomor ini sedang dipegang CS lain')
  }

  // Auto-reopen: chat resolved + CS kirim pesan → open lagi (pola reply endpoint).
  let reopened = false
  if (pmChat.status === 'resolved') {
    await prisma.chat.update({
      where: { id: pmChat.id },
      data: { status: 'open', resolvedAt: null, reopenedCount: { increment: 1 } },
    })
    await prisma.chatEvent.create({
      data: { tenantId, chatId: pmChat.id, userId: user.id, type: 'reopened', createdAt: new Date() },
    })
    pmChat = { ...pmChat, status: 'open', resolvedAt: null }
    reopened = true
  }

  // Simpan Message — content ENKRIPSI at-rest (pola v0.11.0).
  const dbMsg = await prisma.message.create({
    data: {
      tenantId,
      chatId: pmChat.id,
      direction: 'out',
      content: encryptText(content),
      senderName: user.username,
      senderId: user.id,
      waMessageId: waResult?.key?.id || null,
      status: 'sent',
      timestamp: new Date(),
    },
  })

  await prisma.chat.update({
    where: { id: pmChat.id },
    // unreadCount tidak berubah (arah out)
    data: { lastMessageAt: dbMsg.timestamp, lastMessagePreview: encryptText(content) },
  })

  // Broadcast (pola persis reply endpoint chats.js) — plaintext utk UI.
  broadcast.emitToTenant(tenantId, 'new_message', {
    chatId: pmChat.id,
    assignedToId: pmChat.assignedToId ?? null,
    status: pmChat.status,
    message: { ...dbMsg, content },
  })
  broadcast.emitToTenant(tenantId, 'chat_update', {
    chatId: pmChat.id,
    lastMessage: content,
    lastMessageAt: dbMsg.timestamp,
    ...(reopened ? { status: 'open', resolvedAt: null } : {}),
  })

  await logAction(user.id, tenantId, row.id, 'pm', `→ ${pj.jid}`)
  return { chatId: pmChat.id, message: { ...dbMsg, content } }
}

/** Bot keluar dari grup (admin-only) — cleanup grup uji/orphan. */
async function leaveGroup(user, tenantId, chatId) {
  if (!isAdmin(user)) throw new GroupServiceError('FORBIDDEN', 403, 'Hanya admin yang dapat mengeluarkan bot dari grup')
  // v3.9.11 — resolve id/JID: numeric → row.waJid; JID (yatim/ops cleanup) → apa adanya
  const lgRow = await findGroupChat(tenantId, chatId)
  const leaveJid = lgRow ? lgRow.waJid : chatId
  // v3.9.6 — leave via slot manapun yang anggota (ops cleanup; row mungkin tidak ada)
  const { slot } = await fetchGroupMetadataAnySlot(tenantId, leaveJid)
  const sock = wa.getSocketForTenant(tenantId, slot)
  try {
    await sock.groupLeave(leaveJid)
  } catch (e) {
    throw mapWaError(e, 'groupLeave')
  }
  await logAction(user.id, tenantId, 0, 'leave', `bot keluar dari grup (ops cleanup) jid=${leaveJid} slot=${slot}`)
  emitGroupUpdate(tenantId, chatId)
  return { ok: true }
}

module.exports = {
  GroupServiceError,
  leaveGroup,
  GROUP_SUFFIX,
  isGroupJid,
  canSeeGroup,
  assertCanSee,
  listGroups,
  listOrphanGroups,
  getGroupDetail,
  createGroup,
  updateMembers,
  updateGroupInfo,
  updateSettings,
  resetInvite,
  assignPic,
  handleIncomingGroupMessage,
  // v0.14.1 — auto-save nama profil anggota grup → Contact
  upsertContactFromGroup,
  // v0.14.4 — participant action menu (save-contact + pm)
  saveParticipantContact,
  pmParticipant,
  // v0.14.7 — invite via link (kontak LID-only)
  sendGroupInviteLinks,
  groupAudienceRooms,
  normalizePhone,
  phoneToJid,
  logAction,
  mapWaError,
  assertWaReady,
}
