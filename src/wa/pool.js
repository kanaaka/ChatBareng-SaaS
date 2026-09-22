// v3.2 — WA connection pool per tenant (REAL implementation).
//
// Port dari wa-cs-hub-saas v2 pool.js (889 baris, sudah dipakai produksi) +
// upgrade dari baileys.js v0.15.x non-SaaS (lesson 408-loop, cleanup socket,
// pairing dual-mode). Kontrak interface fase 1 TIDAK berubah.
//
// Perubahan vs v2:
//   - Browser kanonik Browsers.ubuntu('Chrome') — lesson v0.13.8b non-SaaS:
//     nama custom ("WA CS Hub (...)") ditolak IQ 400 saat PAIRING CODE; QR aman.
//   - getMessage decrypt-aware (v3 textCrypto 'enc:v1:' — pesan lama terenkripsi).
//   - processIncomingMessage/syncContactFromChat = versi v3 fase 1 yang sudah
//     lebih kaya (CSAT consume, auto-reopen, menu gateway, auto-reply hook,
//     grup via services/groups, push, queue) — TIDAK ditimpa versi v2.
//   - WA_DISABLED=1 tetap didukung penuh (kill-switch, endpoint kembalikan
//     {disabled:true}, bootstrap no-op).
const path = require('path')
const fs = require('fs')
const P = require('pino')
const QRCode = require('qrcode')
const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')

const config = require('../config')
const prisma = require('../prisma')
const broadcast = require('../socket/broadcast')
const queue = require('../socket/queue')
const push = require('../push')
const { saveMedia } = require('./media')

// tenantId (number) → socket state object
const pool = new Map()

const WA_NOT_CONNECTED_MSG = 'WhatsApp belum terhubung untuk tenant ini'
const WA_DISABLED_MSG = 'WhatsApp disabled (WA_DISABLED=1) — fitur WA mati di fase 1'

// Reconnect backoff: 5s → 10s → 30s → 60s → 60s, MAX 5x lalu berhenti
// (status 'failed'). JANGAN infinite loop reconnect.
const RECONNECT_DELAYS_MS = [5000, 10000, 30000, 60000, 60000]
const MAX_RECONNECT_ATTEMPTS = RECONNECT_DELAYS_MS.length

function defaultSessionDir(tenantId) {
  return path.resolve(config.waSessionDir, `tenant-${Number(tenantId)}`)
}

function tenantState(tenantId) {
  let st = pool.get(Number(tenantId))
  if (!st) {
    st = {
      tenantId: Number(tenantId),
      sock: null,
      currentQR: null,
      connectionState: 'disconnected',
      phoneNumber: null,
      baileysVersion: null,
      reconnectTimeoutId: null,
      reconnectAttempts: 0,
      isConnecting: false,
      manualDisconnect: false,
      saveCreds: null,
    }
    pool.set(st.tenantId, st)
  }
  return st
}

function log(tenantId, ...args) {
  console.log(`[WA:tenant-${Number(tenantId)}]`, ...args)
}

function logErr(tenantId, ...args) {
  console.error(`[WA:tenant-${Number(tenantId)}]`, ...args)
}

// ─── Broadcast helper (socket.io, room tenant:<id>) ────────────────

function broadcastWaStatus(st, extra = {}) {
  broadcast.emitToTenant(st.tenantId, 'wa_status', {
    connected: st.connectionState === 'open',
    qrNeeded: st.connectionState === 'qr',
    state: st.connectionState,
    phoneNumber: st.phoneNumber,
    ...extra,
  })
}

// ─── Bootstrap (dipanggil server.js via baileys.connectToWhatsApp) ──

async function connectAllTenants() {
  if (config.waDisabled) {
    console.log('[WA] WA disabled (WA_DISABLED=1) — skipping Baileys bootstrap entirely')
    return
  }
  try {
    const tenants = await prisma.tenant.findMany({ where: { status: 'active' }, orderBy: { id: 'asc' } })
    if (tenants.length === 0) {
      console.log('[WA] Pool: no active tenants yet')
    }
    for (const t of tenants) {
      try {
        await connectTenant(t.id)
      } catch (e) {
        logErr(t.id, 'connectTenant error:', e.message)
      }
    }
  } catch (e) {
    console.error('[WA] Pool bootstrap error:', e.message)
  }
}

/**
 * Connect satu tenant: socket Baileys + auth dir milik tenant itu sendiri.
 * Guard double-connect: skip kalau isConnecting atau socket masih hidup.
 */
async function connectTenant(tenantId, opts = {}) {
  if (config.waDisabled) {
    throw new Error(WA_DISABLED_MSG)
  }
  const tid = Number(tenantId)
  if (!Number.isFinite(tid)) throw new Error('Invalid tenant id')

  const tenant = await prisma.tenant.findUnique({ where: { id: tid } })
  if (!tenant) throw new Error(`Tenant ${tid} not found`)
  if (tenant.status !== 'active') throw new Error(`Tenant ${tid} is ${tenant.status} — connect ditolak`)

  const st = tenantState(tid)
  if (st.isConnecting) {
    log(tid, 'connectTenant() already in progress, skipping')
    return st
  }
  if (st.sock && ['connecting', 'qr', 'open'].includes(st.connectionState)) {
    return st // sudah hidup — jangan double-connect
  }
  if (st.reconnectTimeoutId) {
    clearTimeout(st.reconnectTimeoutId)
    st.reconnectTimeoutId = null
  }

  st.isConnecting = true
  st.manualDisconnect = false
  st.currentQR = null

  // Auth dir per tenant — auto-assign ke Tenant.waSessionDir kalau masih null
  let sessionDir = tenant.waSessionDir
  if (!sessionDir) {
    sessionDir = defaultSessionDir(tid)
    await prisma.tenant.update({ where: { id: tid }, data: { waSessionDir: sessionDir } })
    log(tid, `Session dir di-assign: ${sessionDir}`)
  }
  fs.mkdirSync(sessionDir, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir)
  st.saveCreds = saveCreds

  let version = st.baileysVersion
  try {
    const fetched = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('version fetch timeout')), 15000)),
    ])
    version = fetched.version
    st.baileysVersion = version
  } catch (e) {
    log(tid, 'fetchLatestBaileysVersion gagal, lanjut tanpa version override:', e.message)
  }

  const logger = P({ level: 'warn' })

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    // v3.2 — browser kanonik (lesson v0.13.8b): nama custom → IQ 400 di pairing
    // CODE (QR tidak memvalidasi). Kanonik aman utk keduanya.
    browser: Browsers.ubuntu('Chrome'),
    ...(version ? { version } : {}),
    getMessage: async (key) => {
      try {
        const { decryptTextSafe } = require('../services/textCrypto')
        const msg = await prisma.message.findFirst({
          where: { waMessageId: key.id, tenantId: tid },
        })
        if (msg) return { conversation: decryptTextSafe(msg.content) || '' }
        return null
      } catch {
        return null
      }
    },
  })

  st.sock = sock
  st.connectionState = 'connecting'
  broadcastWaStatus(st)
  log(tid, `Socket dibuat (attempt reconnect: ${st.reconnectAttempts})`)

  // ── connection.update ────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    try {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        st.currentQR = qr
        st.connectionState = 'qr'
        st.isConnecting = false
        try {
          const qrDataUrl = await QRCode.toDataURL(qr, { width: 300 })
          broadcastWaStatus(st, { qrDataUrl })
        } catch {
          broadcastWaStatus(st)
        }
        log(tid, 'QR diterima — menunggu scan')
      }

      if (connection === 'connecting') {
        st.connectionState = 'connecting'
        st.isConnecting = false
        broadcastWaStatus(st)
      }

      if (connection === 'open') {
        st.currentQR = null
        st.connectionState = 'open'
        st.isConnecting = false
        st.reconnectAttempts = 0
        try {
          st.phoneNumber = sock.user?.id?.split(':')[0] || null
        } catch {
          st.phoneNumber = null
        }
        broadcastWaStatus(st)
        log(tid, `Connected${st.phoneNumber ? ` sebagai +${st.phoneNumber}` : ''}`)

        // Persist nomor ke Tenant.waPhone (kalau berubah)
        try {
          if (st.phoneNumber && tenant.waPhone !== st.phoneNumber) {
            await prisma.tenant.update({ where: { id: tid }, data: { waPhone: st.phoneNumber } })
            log(tid, `waPhone persisted: ${st.phoneNumber}`)
          }
        } catch (e) {
          logErr(tid, 'persist waPhone error:', e.message)
        }
      }

      if (connection === 'close') {
        st.isConnecting = false
        const statusCode = lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output.statusCode
          : undefined
        const loggedOut = statusCode === DisconnectReason.loggedOut
        st.connectionState = 'close'
        log(tid, 'Connection closed, statusCode:', statusCode, 'manualDisconnect:', st.manualDisconnect)

        if (loggedOut && !st.manualDisconnect) {
          await handleLoggedOut(st)
          return
        }

        if (st.manualDisconnect) {
          st.connectionState = 'disconnected'
          broadcastWaStatus(st)
          return
        }

        scheduleReconnect(st)
      }
    } catch (e) {
      logErr(tid, 'connection.update handler error:', e)
    }
  })

  // ── creds.update ─────────────────────────────────────────────────
  sock.ev.on('creds.update', saveCreds)

  // ── messages.upsert → processIncomingMessage(tenantId, msg) ──────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      try {
        if (msg.key?.remoteJid === 'status@broadcast') continue
        if (!msg.message) continue // protocol/ephemeral control events
        await processIncomingMessage(tid, msg)
      } catch (e) {
        logErr(tid, 'processIncomingMessage error:', e.message)
      }
    }
  })

  return st
}

function scheduleReconnect(st) {
  if (st.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    st.connectionState = 'failed'
    st.reconnectAttempts = 0
    broadcastWaStatus(st)
    logErr(st.tenantId, `Reconnect gagal ${MAX_RECONNECT_ATTEMPTS}x — berhenti (status failed). Gunakan reconnect manual.`)
    return
  }
  st.reconnectAttempts++
  const delay = RECONNECT_DELAYS_MS[Math.min(st.reconnectAttempts, RECONNECT_DELAYS_MS.length) - 1]
  st.connectionState = 'reconnecting'
  broadcastWaStatus(st, { reconnectAttempt: st.reconnectAttempts, maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS })
  log(st.tenantId, `Reconnect #${st.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} dalam ${delay}ms`)
  st.reconnectTimeoutId = setTimeout(() => {
    st.reconnectTimeoutId = null
    connectTenant(st.tenantId, { isReconnect: true }).catch((e) => {
      logErr(st.tenantId, 'reconnect attempt error:', e.message)
      scheduleReconnect(st)
    })
  }, delay)
}

async function handleLoggedOut(st) {
  logErr(st.tenantId, 'Logged out oleh WA — sesi dihapus, scan QR ulang diperlukan')
  st.sock = null
  st.connectionState = 'disconnected'
  st.currentQR = null
  st.phoneNumber = null
  st.isConnecting = false
  const tenant = await prisma.tenant.findUnique({ where: { id: st.tenantId }, select: { waSessionDir: true } })
  const dir = tenant?.waSessionDir || defaultSessionDir(st.tenantId)
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    log(st.tenantId, 'Session dir dihapus:', dir)
  } catch (e) {
    logErr(st.tenantId, 'Gagal hapus session dir:', e.message)
  }
  try {
    await prisma.tenant.update({ where: { id: st.tenantId }, data: { waPhone: null } })
  } catch {}
  broadcastWaStatus(st, { loggedOut: true })
}

// ─── Disconnect / Logout / Reconnect ───────────────────────────────

/**
 * Soft disconnect: end socket, SESI TETAP ada di disk (tinggal connect lagi).
 */
async function disconnectTenant(tenantId) {
  const tid = Number(tenantId)
  const st = pool.get(tid)
  if (!st) return { ok: true, state: 'disconnected' }

  st.manualDisconnect = true
  if (st.reconnectTimeoutId) {
    clearTimeout(st.reconnectTimeoutId)
    st.reconnectTimeoutId = null
  }
  st.reconnectAttempts = 0
  st.currentQR = null
  const sock = st.sock
  st.sock = null
  st.connectionState = 'disconnected'
  broadcastWaStatus(st)
  log(tid, 'Soft disconnect')
  if (sock) {
    try {
      sock.end(new Error('manual disconnect'))
    } catch {}
  }
  return { ok: true, state: st.connectionState }
}

/**
 * Logout penuh: logout dari WA + hapus dir sesi + clear Tenant.waPhone.
 * waSessionDir string di DB dibiarkan (dir dibuat ulang saat connect berikutnya).
 */
async function logoutTenant(tenantId) {
  const tid = Number(tenantId)
  const st = pool.get(tid)

  if (st) {
    st.manualDisconnect = true
    if (st.reconnectTimeoutId) {
      clearTimeout(st.reconnectTimeoutId)
      st.reconnectTimeoutId = null
    }
    st.reconnectAttempts = 0
    st.currentQR = null
    if (st.sock) {
      try {
        await st.sock.logout('ChatBareng logout')
      } catch (e) {
        // not-connected logout itu OK — tetap lanjut hapus sesi lokal
        if (!/not connected|Connection Closed|loggedOut/i.test(e.message || '')) {
          logErr(tid, 'sock.logout error:', e.message)
        }
      }
      try {
        st.sock.end(new Error('manual logout'))
      } catch {}
      st.sock = null
    }
    st.phoneNumber = null
    st.connectionState = 'disconnected'
  }

  // Hapus dir sesi tenant ini SAJA
  const tenant = await prisma.tenant.findUnique({ where: { id: tid }, select: { waSessionDir: true } })
  const dir = tenant?.waSessionDir || defaultSessionDir(tid)
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    log(tid, 'Logout: session dir dihapus', dir)
  } catch (e) {
    logErr(tid, 'Logout: gagal hapus session dir:', e.message)
  }

  try {
    await prisma.tenant.update({ where: { id: tid }, data: { waPhone: null } })
  } catch (e) {
    logErr(tid, 'Logout: gagal clear waPhone:', e.message)
  }

  if (st) broadcastWaStatus(st, { loggedOut: true })
  log(tid, 'Logout selesai')
  return { ok: true }
}

/**
 * Reconnect = soft disconnect + connect lagi (sesi lama dipakai kalau masih valid).
 */
async function reconnectTenant(tenantId) {
  await disconnectTenant(tenantId)
  // beri jeda kecil agar socket lama benar-benar mati dulu
  await new Promise((r) => setTimeout(r, 500))
  return connectTenant(tenantId)
}

// ─── Socket resolution (outgoing) ──────────────────────────────────

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
    baileysVersion: st.baileysVersion,
    disabled: false,
  }
}

// QR tersimpan sebagai string raw Baileys di st.currentQR; data URL digenerate
// on-demand saat route /api/wa/qr memintanya (per-tenant).
async function getQRDataUrl(tenantId) {
  const st = pool.get(Number(tenantId))
  if (!st || st.connectionState !== 'qr' || !st.currentQR) return null
  try {
    return await QRCode.toDataURL(st.currentQR, { width: 300 })
  } catch {
    return null
  }
}

// ─── Outgoing (per tenant) ─────────────────────────────────────────

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

// ─── Incoming messages (multi-tenant) — versi v3 (lebih kaya) ───────
// Port dari baileys.js v0.15.2 non-SaaS, diadaptasi v3:
//   - chat find-or-create by [tenantId, waJid] (Chat.id Int)
//   - Message.chatId Int + tenantId, konten terenkripsi textCrypto
//   - broadcast via emitToTenant (room tenant:<id>)
//   - grup @g.us via services/groups; CSAT consume; auto-reopen; menu gateway;
//     auto-reply hook; push; queue update.

const MIME_DEFAULT = 'application/octet-stream'

const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'audio/mp3': 'mp3',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/aac': 'aac',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
}

function getExtFromMime(mimetype) {
  return MIME_TO_EXT[mimetype] || 'bin'
}

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
    // Media nyata: download + encrypt + save (paritas dgn v2 pool)
    const sock = getSocketForTenant(tid)
    if (sock) {
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: P({ level: 'silent' }) })
        mediaPath = await saveMedia(buffer, getExtFromMime(mediaMime))
        mediaSize = buffer.length
      } catch (e) {
        logErr(tid, 'Media download error:', e.message)
        if (!effectiveText) effectiveText = '[Media download failed]'
      }
    } else {
      logErr(tid, 'Media masuk tapi socket tidak tersedia — media dilewati')
    }
    if (!effectiveText) effectiveText = '[Media]'
  }

  const senderName = msg.key.fromMe ? 'me' : (msg.pushName || 'Unknown')
  const dbTimestamp = msg.messageTimestamp ? new Date(msg.messageTimestamp * 1000) : new Date()

  // ── Grup: jalur terpisah (@g.us) — persist pesan grup via services/groups ──
  if (chatId.endsWith('@g.us')) {
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

// ─── Legacy/global (tanpa tenant) — netral/error jelas ─────────────

function getStatus() {
  if (config.waDisabled) {
    return { connected: false, qrNeeded: false, state: 'disabled', phoneNumber: null, baileysVersion: null, disabled: true }
  }
  return { connected: false, qrNeeded: false, state: 'disconnected', phoneNumber: null, baileysVersion: null, disabled: false }
}

function getSocket() {
  return pool.get(null) // selalu undefined — API legacy dihapus v3
}

async function getQRDataUrlLegacy() {
  return null
}

async function reconnect() {
  throw new Error('reconnect() global tidak ada lagi — gunakan reconnectTenant(tenantId)')
}

async function logout() {
  throw new Error('logout() global tidak ada lagi — gunakan logoutTenant(tenantId)')
}

function formatPairingCode(rawCode) {
  const compact = String(rawCode || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  if (compact.length !== 8) return compact
  return compact.slice(0, 4) + '-' + compact.slice(4)
}

module.exports = {
  connectAllTenants,
  connectTenant,
  disconnectTenant,
  logoutTenant,
  reconnectTenant,
  tenantState,
  formatPairingCode,
  getSocketForTenant,
  isTenantConnected,
  getStatusForTenant,
  getQRDataUrl,
  getWaHealthSummary: async () => [], // v3.2: belum dipakai (health page = fase 3)
  processIncomingMessage,
  syncContactFromChat,
  normalizePhoneForContact,
  sendMessageForTenant,
  sendMediaForTenant,
  WA_NOT_CONNECTED_MSG,
  WA_DISABLED_MSG,
  // legacy/global (tanpa tenant) — netral/error jelas
  getStatus,
  getSocket,
  getQRDataUrlLegacy,
  reconnect,
  logout,
}