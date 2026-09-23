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
  USyncQuery,
  USyncUser,
} = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')

const config = require('../config')
const prisma = require('../prisma')
const broadcast = require('../socket/broadcast')
const queue = require('../socket/queue')
const push = require('../push')
const { saveMedia } = require('./media')
// v3.7 — anti-duplicate re-link kontak orphan (helper shared C1–C4)
const { relinkOrphanContact } = require('../utils/contactRelink')

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
      // v3.5 — in-memory Set per socket: LID yang sudah pernah dikirim
      // requestPhoneNumber (hindari spam). Reset saat connect (reconnect baru).
      requestPhoneSentSet: new Set(),
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

  // ── v3.5 — chats.phoneNumberShare: WA share nomor asli utk kontak LID ──
  // Port dari hub non-SaaS (baileys.js v0.15.x L624-640), adaptasi tenant:
  // update chat by [tenantId, waJid: normalizedLid], bukan by chat.id = JID.
  sock.ev.on('chats.phoneNumberShare', async ({ lid, jid }) => {
    try {
      if (!lid || !jid) return
      const phone = String(jid).split('@')[0]
      // Normalisasi LID — strip device suffix ("260678896062673:35@lid" → "260678896062673@lid")
      const normalizedLid = String(lid).split(':')[0] + '@lid'
      // 1) Chat LID existing → isi contactPhone + phoneJid (display + export)
      const res = await prisma.chat.updateMany({
        where: { tenantId: tid, waJid: normalizedLid },
        data: { contactPhone: phone, phoneJid: jid },
      })
      // 2) Chat phone JID milik nomor yang sama → belajar LID-nya (routing dua arah)
      const phoneJid = `${phone}@s.whatsapp.net`
      await prisma.chat.updateMany({
        where: { tenantId: tid, phoneJid },
        data: { lidJid: normalizedLid },
      })
      if (res.count > 0) {
        broadcast.emitToTenant(tid, 'chat_update', { waJid: normalizedLid, contactPhone: phone, phoneJid })
      }
      log(tid, `phoneNumberShare: LID ${normalizedLid} → phone ${phone} (chat updated: ${res.count})`)
    } catch (e) {
      logErr(tid, 'phoneNumberShare error:', e.message)
    }
  })

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

// ─── v3.5 — LID ↔ Phone routing helpers ─────────────────────────────
// Port dari hub non-SaaS (baileys.js v0.15.x: resolveLidToPhone L176-218,
// inline resolve L833-857), adaptasi skema v3 (Chat Int id + tenantId).

/**
 * Resolve LID → phone JID via onWhatsApp → USyncQuery (pola hub).
 * Return phone JID ("62xxx@s.whatsapp.net") atau null.
 */
async function resolveLidToPhone(sock, lidJid) {
  if (!sock || !lidJid || !String(lidJid).endsWith('@lid')) return null
  const lidUser = String(lidJid).split('@')[0]

  // Approach 1: onWhatsApp (internally USyncQuery)
  try {
    const results = await sock.onWhatsApp(lidUser)
    if (Array.isArray(results)) {
      for (const r of results) {
        if (r?.jid && r.jid.endsWith('@s.whatsapp.net')) {
          log('resolveLidToPhone onWhatsApp:', lidJid, '→', r.jid)
          return r.jid
        }
      }
    }
  } catch (e) {
    logErr('onWhatsApp resolve failed:', e.message)
  }

  // Approach 2: direct USyncQuery dgn withId(lidJid)
  try {
    const query = new USyncQuery().withContactProtocol().withUser(new USyncUser().withId(lidJid))
    const result = await sock.executeUSyncQuery(query)
    if (result?.list?.length) {
      for (const entry of result.list) {
        if (entry?.id && entry.id.endsWith('@s.whatsapp.net')) {
          log('resolveLidToPhone USync:', lidJid, '→', entry.id)
          return entry.id
        }
      }
    }
  } catch (e) {
    logErr('USync resolve failed:', e.message)
  }

  return null
}

/**
 * v3.5 — Merge guard dua arah (§2/§4): setelah chat LID belajar phone-nya,
 * cek apakah sudah ada chat LAIN dengan waJid = phone JID itu (scope tenant).
 * Kalau ada → merge ringan: pindahkan pesan chat LID → chat phone, pindahkan
 * Contact LID (delete, data diambil chat phone), pasang lidJid di chat phone,
 * hapus chat LID. Return chat phone. Gagal merge → return chat LID apa adanya
 * (routing tidak boleh gagal karena merge — non-fatal).
 */
async function mergeLidIntoPhoneChat(tid, lidChat, phoneJid) {
  const phone = String(phoneJid).split('@')[0]
  try {
    const phoneChat = await prisma.chat.findUnique({
      where: { tenantId_waJid: { tenantId: tid, waJid: phoneJid } },
    })
    if (!phoneChat || phoneChat.id === lidChat.id) return lidChat

    const r = await prisma.$transaction(async (tx) => {
      // pesan → canonical phone chat
      const mv = await tx.message.updateMany({ where: { chatId: lidChat.id }, data: { chatId: phoneChat.id } })
      // Contact row yang menempel ke chat LID:
      // - phone chat SUDAH punya contact → hapus dobel (phone chat punya row-nya sendiri)
      // - phone chat BELUM punya → RELOCATE ke phone chat (v3.5.1 review Alita —
      //   jangan buang identitas kontak; kasus Kolonel: contact hanya ada di LID side)
      const phoneContact = await tx.contact.findFirst({ where: { chatId: phoneChat.id } })
      if (phoneContact) {
        await tx.contact.deleteMany({ where: { chatId: lidChat.id } })
      } else {
        await tx.contact.updateMany({ where: { chatId: lidChat.id }, data: { chatId: phoneChat.id } })
      }
      // pasang mapping dua arah di canonical chat
      await tx.chat.update({
        where: { id: phoneChat.id },
        data: {
          lidJid: lidChat.waJid.split(':')[0],
          phoneJid: phoneChat.phoneJid || phoneJid,
          contactPhone: phone,
          contactName: phoneChat.contactName || lidChat.contactName || null,
          lastMessageAt: lidChat.lastMessageAt && (!phoneChat.lastMessageAt || lidChat.lastMessageAt > phoneChat.lastMessageAt)
            ? lidChat.lastMessageAt : phoneChat.lastMessageAt,
        },
      })
      // tags/events/notes/csat/scheduled yang masih nempel chat LID
      await tx.chatTag.updateMany({ where: { chatId: lidChat.id }, data: { chatId: phoneChat.id } }).catch(() => {})
      await tx.chatEvent.updateMany({ where: { chatId: lidChat.id }, data: { chatId: phoneChat.id } }).catch(() => {})
      await tx.chatNote.updateMany({ where: { chatId: lidChat.id }, data: { chatId: phoneChat.id } }).catch(() => {})
      await tx.csatSurvey.updateMany({ where: { chatId: lidChat.id }, data: { chatId: phoneChat.id } }).catch(() => {})
      await tx.scheduledMessage.updateMany({ where: { chatId: lidChat.id }, data: { chatId: phoneChat.id } }).catch(() => {})
      // hapus chat LID
      await tx.chat.delete({ where: { id: lidChat.id } })
      return mv
    })
    log(tid, `mergeLidIntoPhoneChat: chat LID ${lidChat.waJid} (#${lidChat.id}) → chat phone #${phoneChat.id} (${r.count} pesan dipindah)`)
    broadcast.emitToTenant(tid, 'chat_update', { chatId: phoneChat.id, contactPhone: phone, phoneJid })
    return await prisma.chat.findUnique({ where: { id: phoneChat.id } })
  } catch (e) {
    logErr(tid, 'mergeLidIntoPhoneChat error (non-fatal):', e.message)
    return lidChat
  }
}

/**
 * v3.5 — Inline LID resolve (port hub L833-857, tenant-scoped):
 * pesan 1:1 dari LID yang phoneJid-nya masih null → fire-and-forget resolve
 * (tidak memblokir persist pesan). Dapat phone → update chat LID + merge guard;
 * gagal → kirim requestPhoneNumber SEKALI per LID (Set per socket, reset saat reconnect).
 */
function maybeResolveLidChat(tid, chat, sock) {
  try {
    if (!chat.waJid.endsWith('@lid') || chat.phoneJid) return
    const st = pool.get(tid)
    if (!sock || !st) return
    resolveLidToPhone(sock, chat.waJid)
      .then(async (phoneJid) => {
        if (!phoneJid) {
          // USync gagal → requestPhoneNumber ONCE per LID (jangan spam tiap pesan)
          const set = st.requestPhoneSentSet || (st.requestPhoneSentSet = new Set())
          if (!set.has(chat.waJid)) {
            set.add(chat.waJid)
            try {
              await sock.sendMessage(chat.waJid, { requestPhoneNumber: true })
              log(tid, `requestPhoneNumber terkirim ke ${chat.waJid} (inline fallback)`)
            } catch (e) {
              logErr(tid, `inline requestPhoneNumber error ${chat.waJid}:`, e.message)
            }
          }
          return
        }
        const phone = phoneJid.split('@')[0]
        await prisma.chat.updateMany({
          where: { tenantId: tid, waJid: chat.waJid },
          data: { contactPhone: phone, phoneJid },
        })
        // Merge guard: bila chat phone dgn JID sama sudah ada → gabungkan
        const fresh = await prisma.chat.findUnique({ where: { tenantId_waJid: { tenantId: tid, waJid: chat.waJid } } })
        if (fresh) await mergeLidIntoPhoneChat(tid, fresh, phoneJid)
      })
      .catch((e) => logErr(tid, 'Inline LID resolve error:', e.message))
  } catch (e) {
    logErr(tid, 'maybeResolveLidChat error (non-fatal):', e.message)
  }
}

/**
 * Process one incoming WA message for a specific tenant.
 * Chat find-or-create by [tenantId, waJid] — JID sama di 2 tenant = 2 chat terpisah.
 * v3.5 — routing LID ↔ phone SEBELUM find-or-create (spec §1).
 * Return { chat, message } | null.
 */
async function processIncomingMessage(tenantId, msg) {
  const tid = Number(tenantId)
  const rawJid = msg?.key?.remoteJid
  if (!Number.isFinite(tid) || tid <= 0 || !rawJid) return null
  if (rawJid === 'status@broadcast') return null

  // v3.5 §1 — resolveEffectiveJid: match chat existing dua arah sebelum create.
  // 1:1 saja (@lid / @s.whatsapp.net); grup (@g.us) dan status lewat jalur lama.
  const altJid = msg?.key?.remoteJidAlt || null
  let routeMode = 'exact' // exact | lid-to-phone | phone-to-lid
  let routedChat = null

  if (rawJid.endsWith('@lid') || rawJid.endsWith('@s.whatsapp.net')) {
    // (1) status quo: chat by [tenantId, waJid: rawJid]
    routedChat = await prisma.chat.findUnique({
      where: { tenantId_waJid: { tenantId: tid, waJid: rawJid } },
    })
    // v3.5.1 — PESAN LID yang membawa altJid phone (remoteJidAlt): chat PHONE
    // menang atas exact LID chat. Kasus 02:27 (Kanaka): chat LID lama exist dari
    // test sebelumnya → exact match menang → balasan nyasar + greeting. Kalau
    // chat phone utk nomor yang sama ada → itu canonical; kalau chat LID lama
    // JUGA ada (beda row) → merge inline LID → phone, route ke phone.
    if (rawJid.endsWith('@lid')) {
      const altPhonePref = altJid && String(altJid).endsWith('@s.whatsapp.net') ? altJid : null
      if (altPhonePref) {
        const altPhoneChat = await prisma.chat.findUnique({
          where: { tenantId_waJid: { tenantId: tid, waJid: altPhonePref } },
        })
        if (altPhoneChat && (!routedChat || routedChat.id !== altPhoneChat.id)) {
          if (routedChat) {
            const merged = await mergeLidIntoPhoneChat(tid, routedChat, altPhonePref)
            routedChat = merged && merged.waJid === altPhonePref ? merged : altPhoneChat
            log(tid, `routing v3.5.1: pesan LID ${rawJid} diarahkan ke chat phone #${routedChat.id}${merged && merged.waJid === altPhonePref ? ' (chat LID lama di-merge)' : ''}`)
          } else {
            routedChat = altPhoneChat
          }
          routeMode = 'lid-to-phone'
        }
      }
    }
    if (!routedChat && rawJid.endsWith('@lid')) {
      // (2) LID baru → chat phone-JID milik nomor yang sama
      const altPhone = altJid && altJid.endsWith('@s.whatsapp.net') ? altJid : null
      if (altPhone) {
        const byAlt = await prisma.chat.findUnique({
          where: { tenantId_waJid: { tenantId: tid, waJid: altPhone } },
        })
        if (byAlt) {
          routedChat = byAlt
          routeMode = 'lid-to-phone'
        }
      }
      if (!routedChat) {
        const byLidField = await prisma.chat.findFirst({
          where: { tenantId: tid, lidJid: rawJid },
          orderBy: { id: 'asc' },
        })
        if (byLidField) {
          routedChat = byLidField
          routeMode = 'lid-to-phone'
        }
      }
      if (!routedChat) {
        // (2b) LID baru tanpa lidJid tercatat → chat phone via phoneJid (mapping
        // kolom, chat LID lama yang sudah resolved ke nomor itu).
        const altPhone2 = altJid && altJid.endsWith('@s.whatsapp.net') ? altJid : null
        if (altPhone2) {
          const byPhoneField = await prisma.chat.findFirst({
            where: { tenantId: tid, phoneJid: altPhone2, waJid: { not: rawJid } },
            orderBy: { id: 'asc' },
          })
          if (byPhoneField) {
            routedChat = byPhoneField
            routeMode = 'lid-to-phone'
          }
        }
      }
    } else if (!routedChat && rawJid.endsWith('@s.whatsapp.net')) {
      // (3) phone JID → chat LID yang mapping-nya sudah tersimpan:
      //     altJid LID (v3.5.1) → kolom lidJid ATAU kolom phoneJid (chat LID yang
      //     sudah belajar nomor ini).
      const altLid = altJid && String(altJid).endsWith('@lid') ? String(altJid).split(':')[0] + '@lid' : null
      if (altLid) {
        const byAltLid = await prisma.chat.findUnique({
          where: { tenantId_waJid: { tenantId: tid, waJid: altLid } },
        })
        if (byAltLid) {
          routedChat = byAltLid
          routeMode = 'phone-to-lid'
        }
      }
      if (!routedChat) {
      const byLidField = await prisma.chat.findFirst({
        where: { tenantId: tid, lidJid: rawJid },
        orderBy: { id: 'asc' },
      })
      if (byLidField) {
        routedChat = byLidField
        routeMode = 'phone-to-lid'
      } else {
        const byPhoneField = await prisma.chat.findFirst({
          where: { tenantId: tid, phoneJid: rawJid, waJid: { endsWith: '@lid' } },
          orderBy: { id: 'asc' },
        })
        if (byPhoneField) {
          routedChat = byPhoneField
          routeMode = 'phone-to-lid'
        }
      }
      }
    }
  }

  const chatId = rawJid
  const isLid = chatId.endsWith('@lid')
  const phone = chatId.split('@')[0]

  // (5) Tidak ada match → create chat baru (status quo) TAPI bawa info mapping:
  //   - chat LID + altJid phone → phoneJid = altJid
  //   - chat phone + altJid LID → lidJid = altJid (1:1; participantAlt grup TIDAK berlaku di sini)
  const mappingPhoneJid = isLid ? altJid || null : chatId
  const mappingLidJid = !isLid && altJid && String(altJid).endsWith('@lid') ? String(altJid).split(':')[0] + '@lid' : null

  const effectiveChat = routedChat

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

  // (7) chat hasil routing dipakai utk SEMUA downstream; kalau tidak ada match
  //     → find-or-create seperti biasa (dengan mapping bila ada).
  let chat
  if (effectiveChat) {
    chat = effectiveChat
    // (6) Pasang mapping dua arah saat match (fire-and-forget tidak — harus konsisten
    //     sebelum downstream yang membaca mapping; tapi ringan: 1 update kondisional)
    try {
      if (routeMode === 'lid-to-phone') {
        // chat phone belajar LID-nya; phoneJid chat phone biarkan tetap
        await prisma.chat.update({ where: { id: chat.id }, data: { lidJid: chatId } })
        chat = { ...chat, lidJid: chatId }
      } else if (routeMode === 'phone-to-lid') {
        // chat LID belajar phone-nya (bila masih null)
        if (!chat.phoneJid) {
          await prisma.chat.update({ where: { id: chat.id }, data: { phoneJid: chatId, contactPhone: phone } })
          chat = { ...chat, phoneJid: chatId, contactPhone: phone }
        }
      }
    } catch (e) {
      logErr(tid, 'pasang mapping dua arah error (non-fatal):', e.message)
    }
  } else {
    chat = await prisma.chat.findUnique({
      where: { tenantId_waJid: { tenantId: tid, waJid: chatId } },
    })
    if (!chat) {
      chat = await prisma.chat.create({
        data: {
          tenantId: tid,
          waJid: chatId,
          contactPhone: phone,
          contactName: msg.pushName || null,
          phoneJid: mappingPhoneJid,
          lidJid: mappingLidJid,
          unreadCount: msg.key.fromMe ? 0 : 1,
          status: 'open',
          queuedAt: dbTimestamp,
          firstIncomingAt: msg.key.fromMe ? null : dbTimestamp,
        },
      })
      if (mappingLidJid || (isLid && mappingPhoneJid)) {
        log(tid, `chat baru ${chatId} dibuat dengan mapping (phoneJid=${mappingPhoneJid}, lidJid=${mappingLidJid})`)
      }
    }
  }

  // v3.5 §2 — inline LID resolve (fire-and-forget; tidak memblokir persist)
  if (!msg.key.fromMe) {
    maybeResolveLidChat(tid, chat, getSocketForTenant(tid))
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
  // v3.5 §2 — sync contactPhone yang baru di-resolve (LID→phone) ke Contact row
  try {
    await syncContactFromChat(tid, chat.id)
    if (!msg.key.fromMe && isLid && chat.phoneJid) {
      const freshAfterResolve = await prisma.chat.findUnique({ where: { id: chat.id }, include: { contact: true } })
      if (freshAfterResolve?.contact && !freshAfterResolve.contact.phone && freshAfterResolve.phoneJid) {
        const normPhone = normalizePhoneForContact(String(freshAfterResolve.phoneJid).split('@')[0])
        if (normPhone) {
          await prisma.contact.update({ where: { id: freshAfterResolve.contact.id }, data: { phone: normPhone } })
          log(tid, `Contact.phone terisi dari LID resolve: contact #${freshAfterResolve.contact.id} → ${normPhone}`)
        }
      }
    }
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
    // v3.7 — ANTI-DOBEL: sebelum create, coba re-link kontak orphan (chatId=null,
    // data utuh — mis. hasil "Hapus Chat" mode keep) dengan nomor yang sama.
    // Gagal/null → jatuh ke create baru (logic lama di bawah tetap jalan).
    if (phone && (await relinkOrphanContact(tid, phone, chat.id, chat.contactName || null))) return
    // v3.4 — kuota kontak (spec §4): WA masuk TIDAK PERNAH diblokir. Kuota penuh →
    // SKIP pembuatan Contact secara diam; chat & pesan tetap diproses normal.
    // Log sekali per tenant per jam biar tidak spam.
    try {
      const plans = require('../services/plans')
      const quota = await plans.checkContactQuota(tid)
      if (!quota.ok) {
        const key = `contact_quota_${tid}`
        const now = Date.now()
        const last = contactQuotaLogAt.get(key) || 0
        if (now - last > 60 * 60 * 1000) {
          contactQuotaLogAt.set(key, now)
          console.warn(`[Plan] Tenant #${tid} kuota kontak penuh (${quota.count}/${quota.max}) — auto-create kontak dari WA masuk di-skip (chat tetap diproses)`)
        }
        return
      }
    } catch (e) {
      console.error('[Plan] checkContactQuota error (fail-open):', e.message)
    }
    await prisma.contact.create({ data: createData })
  }
}

// v3.4 — log throttling: key=contact_quota_<tid> → timestamp log terakhir (jam-an)
const contactQuotaLogAt = new Map()

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