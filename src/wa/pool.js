/**
 * v3.0 Phase 1 — WA connection pool per tenant (STUB fase 1).
 *
 * Map tenantId → { sock, status }. Fase 1 = modul ada + interface jalan TAPI
 * TIDAK ada koneksi nyata (WA_DISABLED=1 → getSocket → null, kirim → error jelas).
 * Koneksi nyata + QR per tenant = FASE 2 — port dari wa-cs-hub-saas v2 pool.js.
 *
 * Kontrak utk route/services (kontrak final — TIDAK diubah di fase 2):
 *   getSocketForTenant(tenantId) → sock | null
 *   isTenantConnected(tenantId)  → boolean
 *   sendMessageForTenant(tenantId, waJid, text)
 *   sendMediaForTenant(tenantId, waJid, buffer, mediaType, mimetype, caption, fileName)
 *   getStatusForTenant(tenantId) → { connected, qrNeeded, state, phoneNumber, disabled }
 *   processIncomingMessage(tenantId, msg) — find-or-create chat by [tenantId, waJid]
 *   syncContactFromChat(tenantId, chatIdInt) — Contact.chatId Int
 */

const config = require('../config')
const prisma = require('../prisma')
const broadcast = require('../socket/broadcast')
const queue = require('../socket/queue')
const push = require('../push')

// tenantId (number) → { sock, status, phoneNumber, ... }
const pool = new Map()

const WA_NOT_CONNECTED_MSG = 'WhatsApp belum terhubung untuk tenant ini'
const WA_DISABLED_MSG = 'WhatsApp disabled (WA_DISABLED=1) — fitur WA mati di fase 1'

function tenantState(tenantId) {
  const tid = Number(tenantId)
  let st = pool.get(tid)
  if (!st) {
    st = {
      tenantId: tid,
      sock: null,
      connectionState: 'disconnected',
      phoneNumber: null,
    }
    pool.set(tid, st)
  }
  return st
}

function log(tenantId, ...args) {
  console.log(`[WA:tenant-${Number(tenantId)}]`, ...args)
}

// ─── Status / socket resolution ──────────────────────────────────────

function getSocketForTenant(tenantId) {
  if (config.waDisabled) return null
  const st = pool.get(Number(tenantId))
  return st && st.connectionState === 'open' ? st.sock : null
}

function isTenantConnected(tenantId) {
  return !!getSocketForTenant(tenantId)
}

function getStatusForTenant(tenantId) {
  if (config.waDisabled) {
    return { connected: false, qrNeeded: false, state: 'disabled', phoneNumber: null, disabled: true }
  }
  const st = pool.get(Number(tenantId))
  if (!st) return { connected: false, qrNeeded: false, state: 'disconnected', phoneNumber: null, disabled: false }
  return {
    connected: st.connectionState === 'open',
    qrNeeded: st.connectionState === 'qr',
    state: st.connectionState,
    phoneNumber: st.phoneNumber,
    disabled: false,
  }
}

// ─── Outgoing (per tenant) — stub fase 1: selalu error jelas ─────────

function notConnectedError(msg) {
  const err = new Error(msg)
  err.code = 'WA_NOT_CONNECTED'
  return err
}

async function sendMessageForTenant(tenantId, waJid, text) {
  const sock = getSocketForTenant(tenantId)
  if (!sock) {
    throw notConnectedError(config.waDisabled ? WA_DISABLED_MSG : WA_NOT_CONNECTED_MSG)
  }
  const result = await sock.sendMessage(waJid, { text })
  return result
}

async function sendMediaForTenant(tenantId, waJid, buffer, mediaType, mimetype, caption, fileName) {
  const sock = getSocketForTenant(tenantId)
  if (!sock) {
    throw notConnectedError(config.waDisabled ? WA_DISABLED_MSG : WA_NOT_CONNECTED_MSG)
  }
  let content
  switch (mediaType) {
    case 'image':
      content = { image: buffer, caption: caption || undefined }
      break
    case 'video':
      content = { video: buffer, caption: caption || undefined, mimetype }
      break
    case 'audio':
      content = { audio: buffer, mimetype, ptt: false }
      break
    case 'document':
      content = { document: buffer, mimetype, fileName: fileName || 'file', caption: caption || undefined }
      break
    default:
      throw new Error(`Unsupported media type: ${mediaType}`)
  }
  const result = await sock.sendMessage(waJid, content)
  return result
}

// ─── Bootstrap (dipanggil server.js) ─────────────────────────────────

async function connectAllTenants() {
  if (config.waDisabled) {
    console.log('[WA] WA disabled (WA_DISABLED=1) — skipping Baileys bootstrap entirely')
    return
  }
  // Fase 1 stub: TIDAK ada koneksi nyata (fase 2: loop connectTenant per tenant active)
  console.log('[WA] Pool stub fase 1 — koneksi nyata per tenant = fase 2')
}

// ─── Incoming messages (multi-tenant) — logika inti fase 1 ────────────
// Port dari baileys.js v0.15.2 processIncomingMessage, diadaptasi:
//   - chat find-or-create by [tenantId, waJid] (Chat.id Int)
//   - Message.chatId Int + tenantId
//   - broadcast via emitToTenant
// Grup (@g.us) di-skip di fase 1 stub (jalur grup nyata = fase 2 via services/groups).
// Media download butuh socket Baileys → di stub: media dilewati (metadata tetap disimpan
// bila tersedia dari payload).

const MIME_DEFAULT = 'application/octet-stream'

function detectMediaType(msg) {
  const m = msg.message
  if (m.imageMessage) return 'image'
  if (m.videoMessage) return 'video'
  if (m.audioMessage) return 'audio'
  if (m.stickerMessage) return 'sticker'
  if (m.documentMessage) return 'document'
  return null
}

function extractText(msg) {
  if (msg.message?.conversation) return msg.message.conversation
  if (msg.message?.extendedTextMessage?.text) return msg.message.extendedTextMessage.text
  return null
}

/**
 * Process one incoming WA message for a specific tenant.
 * Chat find-or-create by [tenantId, waJid] — JID sama di 2 tenant = 2 chat terpisah.
 * Return { chat, message } | null.
 */
async function processIncomingMessage(tenantId, msg) {
  const tid = Number(tenantId)
  const chatId = msg?.key?.remoteJid
  if (!Number.isFinite(tid) || tid <= 0 || !chatId) return null
  if (chatId === 'status@broadcast') return null

  const { encryptText, decryptTextSafe } = require('../services/textCrypto')

  // ── Grup: jalur terpisah (@g.us) — persist pesan grup via services/groups ──
  // Grup tidak pernah menyentuh jalur 1:1 (queue/gateway/push antrean/syncContact/
  // auto-reply). Pesan grup tersimpan bila row Chat grup sudah di-adopt (PIC).
  if (chatId.endsWith('@g.us')) {
    // Pesan grup: persist ringan (row grup yang sudah di-adopt) + broadcast ke
    // room PIC/admin. Grup yatim tanpa PIC di-skip (invariant queueWhere v0.14.0).
    try {
      const groupsSvc = require('../services/groups')
      await groupsSvc.handleIncomingGroupMessage(tid, msg, { waJid: chatId, text: effectiveText || null, mediaType, mediaPath, mediaMime, mediaSize, dbTimestamp, senderName })
    } catch (e) {
      console.error('[WA] Group message handler error (non-fatal):', e.message)
    }
    return null
  }

  const isLid = chatId.endsWith('@lid')
  const phone = chatId.split('@')[0]

  const text = extractText(msg)
  const mediaType = detectMediaType(msg)
  let mediaPath = null
  let mediaMime = null
  let mediaSize = null
  let effectiveText = text
  if (mediaType) {
    const mediaMsg = msg.message[`${mediaType}Message`]
    mediaMime = mediaMsg?.mimetype || MIME_DEFAULT
    if (mediaMsg?.caption) effectiveText = mediaMsg.caption
    else if (mediaType === 'document' && mediaMsg?.fileName) effectiveText = mediaMsg.fileName
    // Stub fase 1: TIDAK download media (butuh socket nyata) — metadata tetap dicatat.
    if (!effectiveText) effectiveText = '[Media]'
  }

  const senderName = msg.key.fromMe ? 'me' : (msg.pushName || 'Unknown')
  const dbTimestamp = msg.messageTimestamp ? new Date(msg.messageTimestamp * 1000) : new Date()

  // Find-or-create chat by [tenantId, waJid]
  let chat = await prisma.chat.findUnique({
    where: { tenantId_waJid: { tenantId: tid, waJid: chatId } },
  })
  if (!chat) {
    chat = await prisma.chat.create({
      data: {
        tenantId: tid,
        waJid: chatId,
        contactPhone: phone,
        contactName: msg.pushName || null,
        phoneJid: isLid ? null : chatId,
        unreadCount: msg.key.fromMe ? 0 : 1,
        status: 'open',
        queuedAt: dbTimestamp,
        firstIncomingAt: msg.key.fromMe ? null : dbTimestamp,
      },
    })
  }

  if (!msg.key.fromMe) {
    // First incoming
    if (!chat.firstIncomingAt) {
      await prisma.chat.update({ where: { id: chat.id }, data: { firstIncomingAt: dbTimestamp } })
      await prisma.chatEvent.create({
        data: { tenantId: tid, chatId: chat.id, userId: null, type: 'first_incoming', createdAt: dbTimestamp },
      })
    }

    // CSAT silent-consume: jawaban rating murni → chat tetap resolved
    let consumedAsRating = false
    if (chat.status === 'resolved' && effectiveText) {
      try {
        const csatSvc = require('../services/csat')
        consumedAsRating = await csatSvc.consumePendingRating(chat.id, effectiveText)
        if (consumedAsRating) log(tid, `[CSAT] rating consumed — chat tetap resolved: chat=${chat.id}`)
      } catch (e) {
        console.error('[WA] csat consume error (non-fatal):', e.message)
      }
    }

    // Auto-reopen
    if (chat.status === 'resolved' && !consumedAsRating) {
      const newReopenedCount = (chat.reopenedCount || 0) + 1
      await prisma.chat.update({
        where: { id: chat.id },
        data: { status: 'open', resolvedAt: null, reopenedCount: newReopenedCount, assignedToId: null, queuedAt: dbTimestamp },
      })
      await prisma.chatEvent.create({
        data: { tenantId: tid, chatId: chat.id, userId: null, type: 'reopened_unassigned', createdAt: dbTimestamp },
      })
      broadcast.emitToTenant(tid, 'chat_update', { chatId: chat.id, status: 'open', resolvedAt: null, assignedTo: null, queuedAt: dbTimestamp })
      log(tid, `Auto-reopened resolved chat (unbind → queue): chat=${chat.id}`)
    }

    // Auto-queue fallback (chat lama tanpa queuedAt)
    if (chat.status === 'open' && chat.assignedToId === null && !chat.queuedAt) {
      await prisma.chat.update({ where: { id: chat.id }, data: { queuedAt: dbTimestamp } })
    }

    // Menu Gateway: chat awaiting → jawaban menentukan pilihan
    if (chat.menuState === 'awaiting') {
      try {
        const menuGateway = require('../services/menuGateway')
        const handled = await menuGateway.handleChoice(chat.id, effectiveText || '')
        if (handled) {
          log(tid, `[MenuGateway] pilihan diproses utk chat=${chat.id}`)
          return { chat, message: null }
        }
      } catch (e) {
        console.error('[WA] menuGateway.handleChoice error (non-fatal):', e.message)
      }
    }
  }

  // Save message (content terenkripsi at-rest)
  const dbMsg = await prisma.message.create({
    data: {
      tenantId: tid,
      chatId: chat.id,
      direction: msg.key.fromMe ? 'out' : 'in',
      content: encryptText(effectiveText),
      mediaPath,
      mediaType,
      mediaMime,
      mediaSize,
      senderName,
      waMessageId: msg.key.id,
      timestamp: dbTimestamp,
      status: msg.key.fromMe ? 'sent' : 'delivered',
    },
  })

  // Sync contact (Contact.chatId Int + tenantId)
  try {
    await syncContactFromChat(tid, chat.id)
  } catch (e) {
    console.error('[WA] syncContactFromChat error:', e)
  }

  // Update chat last message + unread (rating consumed tidak menaikkan unread)
  const preview = effectiveText || (mediaType ? `[${mediaType.charAt(0).toUpperCase() + mediaType.slice(1)}]` : '[Media]')
  const newUnread = msg.key.fromMe ? chat.unreadCount : (chat.unreadCount || 0) + 1
  await prisma.chat.update({
    where: { id: chat.id },
    data: {
      lastMessageAt: dbMsg.timestamp,
      lastMessagePreview: encryptText(preview),
      unreadCount: newUnread,
    },
  })

  // Broadcast scoped ke room tenant (plaintext utk UI)
  broadcast.emitToTenant(tid, 'new_message', { chatId: chat.id, message: { ...dbMsg, content: decryptTextSafe(dbMsg.content) } })
  broadcast.emitToTenant(tid, 'chat_update', {
    chatId: chat.id,
    lastMessage: preview,
    lastMessageAt: dbMsg.timestamp,
    unreadCount: newUnread,
  })

  // Push + queue update (fire-and-forget, pesan masuk saja)
  if (!msg.key.fromMe) {
    try {
      const chatTitle = chat.contactName || chat.contactPhone || chat.waJid
      const pushBody = push.truncate(preview)
      if (chat.assignedToId) {
        push.sendToUser(chat.assignedToId, {
          kind: 'message',
          chatId: chat.id,
          title: chatTitle,
          body: pushBody,
          url: `/?chat=${chat.id}`,
        })
      } else if (chat.status === 'open') {
        const queuePayload = {
          kind: 'message',
          chatId: chat.id,
          title: 'Chat baru di antrean',
          body: 'Ada chat baru menunggu di antrean',
          url: `/?chat=${chat.id}`,
        }
        push.sendToTenantActive(tid, queuePayload, 'cs')
        push.sendToTenantActive(tid, queuePayload, 'admin')
      }
    } catch (e) {
      log(tid, 'push trigger error (non-fatal):', e.message)
    }
    queue.emitQueueUpdate(tid)

    // Auto greeting + CSAT reply hook (fire-and-forget)
    try {
      const freshChat = await prisma.chat.findUnique({ where: { id: chat.id }, include: { contact: true } })
      if (freshChat && freshChat.menuState == null && freshChat.assignedToId == null && freshChat.status === 'open') {
        const autoReply = require('../services/autoReply')
        autoReply.maybeAutoReply(freshChat, msg).catch((e) =>
          console.error('[WA] autoReply error (non-fatal):', e.message)
        )
        const csat = require('../services/csat')
        csat.maybeHandleCsatReply(freshChat, effectiveText).catch((e) =>
          console.error('[WA] csat reply error (non-fatal):', e.message)
        )
      }
    } catch (e) {
      console.error('[WA] autoReply hook error (non-fatal):', e.message)
    }
  }

  return { chat, message: dbMsg }
}

/**
 * Sync Contact row utk satu chat (idempoten, fill-empty-only) — Contact.chatId Int.
 * @param {number} tenantId
 * @param {number} chatIdInt - Chat.id (Int)
 */
async function syncContactFromChat(tenantId, chatIdInt) {
  const tid = Number(tenantId)
  const chat = await prisma.chat.findFirst({
    where: { id: Number(chatIdInt), tenantId: tid },
    include: { contact: true },
  })
  if (!chat) return

  const phoneRaw = chat.contactPhone || chat.waJid.split('@')[0]
  const isLid = chat.waJid.endsWith('@lid')
  let phone
  if (isLid) {
    phone =
      chat.contactPhone && /^\d+$/.test(chat.contactPhone) && chat.contactPhone !== chat.waJid.split('@')[0]
        ? normalizePhoneForContact(chat.contactPhone)
        : null
  } else {
    phone = normalizePhoneForContact(phoneRaw)
  }
  const hasComplete = chat.contact && chat.contact.phone && chat.contact.name
  if (hasComplete && (!phone || chat.contact.phone === phone)) return

  const updateData = {}
  const createData = {
    tenantId: tid,
    chatId: chat.id,
    source: 'chat',
  }

  if (phone) {
    if (!chat.contact || !chat.contact.phone) {
      updateData.phone = phone
      createData.phone = phone
    }
  }
  if (chat.contactName) {
    if (!chat.contact || !chat.contact.name) {
      updateData.name = chat.contactName
      createData.name = chat.contactName
    }
  }

  if (Object.keys(updateData).length === 0) return

  if (chat.contact) {
    await prisma.contact.update({ where: { id: chat.contact.id }, data: updateData })
  } else {
    // Guard duplikat phone/chatId races (scope tenant)
    const existingPhone = phone ? await prisma.contact.findFirst({ where: { tenantId: tid, phone } }) : null
    const existingChatId = await prisma.contact.findUnique({ where: { chatId: chat.id } })
    if (existingPhone || existingChatId) {
      const existing = existingChatId || existingPhone
      const patch = {}
      if (phone && !existing.phone) patch.phone = phone
      if (chat.contactName && !existing.name) patch.name = chat.contactName
      if (Object.keys(patch).length > 0) {
        await prisma.contact.update({ where: { id: existing.id }, data: patch })
      }
      return
    }
    await prisma.contact.create({ data: createData })
  }
}

function normalizePhoneForContact(raw) {
  if (!raw) return null
  let phone = String(raw).replace(/[\s\-().]/g, '')
  if (phone.startsWith('+')) phone = phone.slice(1)
  if (phone.startsWith('0')) phone = '62' + phone.slice(1)
  if (phone.startsWith('8') && phone.length >= 8 && !phone.startsWith('62')) {
    phone = '62' + phone
  }
  if (!/^\d+$/.test(phone)) return null
  if (!phone.startsWith('62') && phone.length < 8) return null
  if (phone.startsWith('62') && phone.length < 10) return null
  if (phone.length > 15) return null
  return phone
}

module.exports = {
  connectAllTenants,
  getSocketForTenant,
  isTenantConnected,
  getStatusForTenant,
  sendMessageForTenant,
  sendMediaForTenant,
  processIncomingMessage,
  syncContactFromChat,
  normalizePhoneForContact,
  WA_NOT_CONNECTED_MSG,
  WA_DISABLED_MSG,
}