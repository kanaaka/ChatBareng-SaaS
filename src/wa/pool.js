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
// v4.6.4 — SystemLog capture terstruktur (spec D2.5): error pool/koneksi WA masuk
// log superadmin module=wa (best-effort, non-fatal).
const systemLog = require('../services/systemLog')
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
// ═══ v3.9 — MULTI-NOMOR: key = `${tenantId}:${slot}` (slot 0..2). Slot-0 = slot
// utama (dir sesi = Tenant.waSessionDir existing — JANGAN migrasi); slot 1/2 =
// dir tenant-<id>/slot-<slot>. Semua helper lama default slot-0 → zero change
// utk tenant 1 nomor (spec §0 HARD RULE).
const pool = new Map()

const WA_NOT_CONNECTED_MSG = 'WhatsApp belum terhubung untuk tenant ini'
const WA_DISABLED_MSG = 'WhatsApp disabled (WA_DISABLED=1) — fitur WA mati di fase 1'

// Reconnect backoff: 5s → 10s → 30s → 60s → 60s, MAX 5x lalu berhenti
// (status 'failed'). JANGAN infinite loop reconnect.
const RECONNECT_DELAYS_MS = [5000, 10000, 30000, 60000, 60000]
const MAX_RECONNECT_ATTEMPTS = RECONNECT_DELAYS_MS.length

// v3.9 — hard cap slot (spec §1: 0..2, maks 3)
const MAX_SLOT = 2

function slotKey(tenantId, slot) {
  return `${Number(tenantId)}:${Number(slot) || 0}`
}

function defaultSessionDir(tenantId, slot = 0) {
  const s = Number(slot) || 0
  const base = path.resolve(config.waSessionDir, `tenant-${Number(tenantId)}`)
  // slot-0 = dir LAMA (tenant-<id>) — kompatibilitas sesi existing (HARD RULE)
  return s === 0 ? base : path.join(base, `slot-${s}`)
}

function tenantState(tenantId, slot = 0) {
  const key = slotKey(tenantId, slot)
  let st = pool.get(key)
  if (!st) {
    st = {
      tenantId: Number(tenantId),
      slot: Number(slot) || 0,
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
    pool.set(key, st)
  }
  return st
}

// v3.9 — logger slot-aware. Kompatibel dengan panggilan lama:
//   log(tid, 'msg')                    → [WA:tenant-<tid>]
//   log(tid, slot, 'msg')              → [WA:tenant-<tid>:slot-<n>] (slot>0) / [WA:tenant-<tid>] (slot-0)
//   log(tid, {slot:1}, 'msg')          → [WA:tenant-<tid>:slot-1]
function slotPrefix(tenantId, slot) {
  const s = Number(slot) || 0
  return `[WA:tenant-${Number(tenantId)}${s ? `:slot-${s}` : ''}]`
}

function log(tenantId, slot, ...args) {
  if (slot === undefined || (typeof slot === 'object' && slot !== null && !(('slot') in slot))) {
    console.log(slotPrefix(tenantId, 0), slot === undefined ? '' : slot, ...args)
    return
  }
  if (typeof slot === 'object' && slot !== null) { console.log(slotPrefix(tenantId, slot.slot), ...args); return }
  console.log(slotPrefix(tenantId, slot), ...args)
}

function logErr(tenantId, slot, ...args) {
  if (slot === undefined || (typeof slot === 'object' && slot !== null && !(('slot') in slot))) {
    console.error(slotPrefix(tenantId, 0), slot === undefined ? '' : slot, ...args)
    return
  }
  if (typeof slot === 'object' && slot !== null) { console.error(slotPrefix(tenantId, slot.slot), ...args); return }
  console.error(slotPrefix(tenantId, slot), ...args)
}

// ─── Broadcast helper (socket.io, room tenant:<id>) ────────────────

function broadcastWaStatus(st, extra = {}) {
  broadcast.emitToTenant(st.tenantId, 'wa_status', {
    connected: st.connectionState === 'open',
    qrNeeded: st.connectionState === 'qr',
    state: st.connectionState,
    phoneNumber: st.phoneNumber,
    // v3.9 — slot context (additive; slot-0 = compat)
    slot: st.slot || 0,
    ...extra,
  })
}

// ─── v3.9 — TenantNumber DB helpers (sumber kebenaran slot) ───────

/**
 * listTenantNumbers(tenantId) → baris TenantNumber milik tenant (asc slot).
 * Bila BELUM ADA baris sama sekali → SINTETIS slot-0 (agar tenant lama berperilaku
 * 1 slot tanpa perlu backfill — spec §0 zero change).
 */
async function listTenantNumbers(tenantId) {
  const tid = Number(tenantId)
  const rows = await prisma.tenantNumber.findMany({ where: { tenantId: tid }, orderBy: { slot: 'asc' } })
  if (rows.length === 0) {
    return [{ id: 0, tenantId: tid, slot: 0, label: null, waSessionDir: null, routeMode: 'pool', assignedAgentId: null, reassignOffline: false, _synthetic: true }]
  }
  return rows
}

/**
 * getTenantNumber(tenantId, slot) → row slot itu; fallback sintetis slot-0.
 */
async function getTenantNumber(tenantId, slot = 0) {
  const tid = Number(tenantId)
  const s = Number(slot) || 0
  const row = await prisma.tenantNumber.findUnique({ where: { tenantId_slot: { tenantId: tid, slot: s } } })
  if (row) return row
  if (s === 0) return (await listTenantNumbers(tid))[0]
  return null
}

/**
 * ensureSlot0Row — saat connect slot-0 tanpa baris DB, buat baris slot-0 (idempoten)
 * supaya kuota (baris yang ADA) selalu eksplisit. Gagal → non-fatal (sintetis tetap jalan).
 */
async function ensureSlot0Row(tenantId, sessionDir) {
  try {
    const existing = await prisma.tenantNumber.findUnique({ where: { tenantId_slot: { tenantId: Number(tenantId), slot: 0 } } })
    if (existing) return existing
    return await prisma.tenantNumber.create({ data: { tenantId: Number(tenantId), slot: 0, waSessionDir: sessionDir || null } })
  } catch (e) {
    logErr(tenantId, 0, 'ensureSlot0Row error (non-fatal):', e.message)
    return null
  }
}

/**
 * resolveRouteForSlot(tenantId, slot) → 'assigned' | 'pool' utk pesan masuk slot itu.
 * tenant.waMode = pool → 'pool' SELALU (zero change); assigned → assigned (slot apapun);
 * mix → slot.routeMode.
 * Fallback aman: gagal baca DB → 'pool' (perilaku existing).
 */
async function resolveRouteForSlot(tenantId, slot) {
  const tid = Number(tenantId)
  const s = Number(slot) || 0
  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: tid }, select: { waMode: true } })
    const mode = tenant?.waMode || 'pool'
    if (mode === 'assigned') return 'assigned'
    if (mode === 'mix') {
      const row = await prisma.tenantNumber.findUnique({ where: { tenantId_slot: { tenantId: tid, slot: s } } })
      if (row && row.routeMode === 'assigned') return 'assigned'
      return 'pool'
    }
    return 'pool'
  } catch (e) {
    logErr(tid, s, 'resolveRouteForSlot error (fail-open → pool):', e.message)
    return 'pool'
  }
}

// ─── Bootstrap (dipanggil server.js via baileys.connectToWhatsApp) ──

async function connectAllTenants() {
  if (config.waDisabled) {
    console.log('[WA] WA disabled (WA_DISABLED=1) — skipping Baileys bootstrap entirely')
    return
  }
  try {
    const tenants = await prisma.tenant.findMany({ where: { status: 'active' }, orderBy: { id: 'asc' }, include: { numbers: { orderBy: { slot: 'asc' } } } })
    if (tenants.length === 0) {
      console.log('[WA] Pool: no active tenants yet')
    }
    for (const t of tenants) {
      // v3.9 — connect SEMUA slot terdaftar (baris TenantNumber). Tanpa baris → slot-0 saja.
      const slots = (t.numbers && t.numbers.length > 0) ? t.numbers.map((n) => n.slot) : [0]
      for (const slot of slots) {
        try {
          await connectTenant(t.id, { slot })
        } catch (e) {
          logErr(t.id, slot, 'connectTenant error:', e.message)
        }
      }
    }
  } catch (e) {
    console.error('[WA] Pool bootstrap error:', e.message)
    void systemLog.logError('Pool bootstrap error', { module: 'wa', err: e })
  }
}

/**
 * Connect satu tenant+SLOT: socket Baileys + auth dir milik tenant/slot itu.
 * v3.9 — slot-0 = dir lama (Tenant.waSessionDir); slot 1/2 = tenant-<id>/slot-<n>
 * (atau TenantNumber.waSessionDir eksplisit). Guard double-connect per-slot.
 * opts.slot default 0 — SEMUA caller lama tidak berubah (zero change §0).
 */
async function connectTenant(tenantId, opts = {}) {
  if (config.waDisabled) {
    throw new Error(WA_DISABLED_MSG)
  }
  const tid = Number(tenantId)
  if (!Number.isFinite(tid)) throw new Error('Invalid tenant id')
  const slot = Number(opts.slot) || 0
  if (slot < 0 || slot > MAX_SLOT) throw new Error(`Slot ${slot} tidak valid (0..${MAX_SLOT})`)

  const tenant = await prisma.tenant.findUnique({ where: { id: tid }, include: { numbers: { where: { slot } } } })
  if (!tenant) throw new Error(`Tenant ${tid} not found`)
  if (tenant.status !== 'active') throw new Error(`Tenant ${tid} is ${tenant.status} — connect ditolak`)
  // v3.9 — slot 1/2 WAJIB terdaftar di TenantNumber (slot-0 boleh implisit = compat)
  if (slot !== 0 && (!tenant.numbers || tenant.numbers.length === 0)) {
    throw new Error(`Slot ${slot} belum terdaftar untuk tenant ${tid} — tambahkan via Admin/Superadmin dulu`)
  }
  const numberRow = tenant.numbers?.[0] || null

  const st = tenantState(tid, slot)
  if (st.isConnecting) {
    log(tid, slot, 'connectTenant() already in progress, skipping')
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

  // Auth dir per tenant+slot.
  // slot-0: dir lama (Tenant.waSessionDir) — SAMA dgn sebelum v3.9 (HARD RULE).
  // slot>0: TenantNumber.waSessionDir bila di-set; else default tenant-<id>/slot-<n>.
  let sessionDir
  if (slot === 0) {
    sessionDir = tenant.waSessionDir
    if (!sessionDir) {
      sessionDir = defaultSessionDir(tid, 0)
      await prisma.tenant.update({ where: { id: tid }, data: { waSessionDir: sessionDir } })
      log(tid, 0, `Session dir di-assign: ${sessionDir}`)
    }
  } else {
    sessionDir = numberRow?.waSessionDir || null
    if (!sessionDir) {
      sessionDir = defaultSessionDir(tid, slot)
      try {
        await prisma.tenantNumber.update({ where: { tenantId_slot: { tenantId: tid, slot } }, data: { waSessionDir: sessionDir } })
      } catch (e) {
        logErr(tid, slot, 'persist waSessionDir slot error (non-fatal):', e.message)
      }
      log(tid, slot, `Session dir di-assign: ${sessionDir}`)
    }
  }
  fs.mkdirSync(sessionDir, { recursive: true })
  if (slot === 0) await ensureSlot0Row(tid, sessionDir)

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
  log(tid, slot, `Socket dibuat (attempt reconnect: ${st.reconnectAttempts})`)

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
        log(tid, slot, 'QR diterima — menunggu scan')
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
        log(tid, slot, `Connected${st.phoneNumber ? ` sebagai +${st.phoneNumber}` : ''}`)

        // Persist nomor ke Tenant.waPhone (kalau berubah) — slot-0 SAJA (waPhone = nomor utama)
        try {
          if (slot === 0 && st.phoneNumber && tenant.waPhone !== st.phoneNumber) {
            await prisma.tenant.update({ where: { id: tid }, data: { waPhone: st.phoneNumber } })
            log(tid, slot, `waPhone persisted: ${st.phoneNumber}`)
          }
        } catch (e) {
          logErr(tid, slot, 'persist waPhone error:', e.message)
        }
      }

      if (connection === 'close') {
        st.isConnecting = false
        const statusCode = lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output.statusCode
          : undefined
        const loggedOut = statusCode === DisconnectReason.loggedOut
        st.connectionState = 'close'
        log(tid, slot, 'Connection closed, statusCode:', statusCode, 'manualDisconnect:', st.manualDisconnect)

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
      logErr(tid, slot, 'connection.update handler error:', e)
      void systemLog.logError(`connection.update handler error (slot ${Number(slot) || 0})`, { module: 'wa', tenantId: tid, err: e })
    }
  })

  // ── creds.update ─────────────────────────────────────────────────
  sock.ev.on('creds.update', saveCreds)

  // ── v3.5 — chats.phoneNumberShare: WA share nomor asli utk kontak LID ──
  // Port dari hub non-SaaS (baileys.js v0.15.x L624-640), adaptasi tenant:
  // update chat by [tenantId, numberSlot, waJid: normalizedLid] (v3.9.2 K1-A:
  // scoped per SLOT socket ini — jangan sentuh chat slot lain), bukan by id = JID.
  sock.ev.on('chats.phoneNumberShare', async ({ lid, jid }) => {
    try {
      if (!lid || !jid) return
      const phone = String(jid).split('@')[0]
      // Normalisasi LID — strip device suffix ("260678896062673:35@lid" → "260678896062673@lid")
      const normalizedLid = String(lid).split(':')[0] + '@lid'
      // 1) Chat LID existing (slot ini) → isi contactPhone + phoneJid (display + export)
      const res = await prisma.chat.updateMany({
        where: { tenantId: tid, numberSlot: slot, waJid: normalizedLid },
        data: { contactPhone: phone, phoneJid: jid },
      })
      // 2) Chat phone JID milik nomor yang sama (slot ini) → belajar LID-nya (routing dua arah)
      const phoneJid = `${phone}@s.whatsapp.net`
      await prisma.chat.updateMany({
        where: { tenantId: tid, numberSlot: slot, phoneJid },
        data: { lidJid: normalizedLid },
      })
      if (res.count > 0) {
        broadcast.emitToTenant(tid, 'chat_update', { waJid: normalizedLid, contactPhone: phone, phoneJid })
      }
      log(tid, slot, `phoneNumberShare: LID ${normalizedLid} → phone ${phone} (chat updated: ${res.count}, slot ${slot})`)
    } catch (e) {
      logErr(tid, slot, 'phoneNumberShare error:', e.message)
    }
  })

  // ── messages.upsert → processIncomingMessage(tenantId, msg) ──────
  // v3.9 — slot penerima dibawa ke routing (Chat.numberSlot + born-assigned)
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      try {
        if (msg.key?.remoteJid === 'status@broadcast') continue
        // v4.1.0 — WA Channel (@newsletter) = one-way broadcast — BUKAN percakapan
        // customer (fondasi: v4.0.0c hotfix, QA Kanaka 11:57). Ganti plain-skip →
        // JALUR ARSIP read-only (spec docs/spec-v4.1.0-channels.md §3):
        // archiveNewsletterMessage (try/catch log-only, TIDAK PERNAH throw) →
        // continue. TETAP TIDAK ke processIncomingMessage (guard defense-in-depth
        // v4.0.0c di entry tetap hidup). D3: tanpa Chat/queue/unread/metering.
        if (typeof msg.key?.remoteJid === 'string' && msg.key.remoteJid.endsWith('@newsletter')) {
          try {
            const channelArchive = require('../services/channelArchive')
            await channelArchive.archiveNewsletterMessage(tid, slot, msg, { sock })
          } catch (ae) {
            logErr(tid, slot, 'channel archive error (log-only):', ae.message)
          }
          continue
        }
        if (!msg.message) continue // protocol/ephemeral control events
        await processIncomingMessage(tid, msg, { slot })
      } catch (e) {
        logErr(tid, slot, 'processIncomingMessage error:', e.message)
      }
    }
  })

  // ═══ v4.4.0 — Centang biru: messages.update → Message.status (F1 spec docs/spec-v4.4.0-blue-ticks-take-tag-exclude-resolve.md) ═══
  // Payload Baileys: array { key:{ id, remoteJid, fromMe, participant? }, update:{ status?, ... } }.
  // Status ACK Baileys: 0 pending, 1 server-ack, 2 device/pending, 3 = DELIVERED, 4 = READ, 5 = PLAYED.
  // Mapping: 3 → 'delivered', ≥4 → 'read', <3 diabaikan.
  // LINGKUP v4.4.0: key.fromMe === true DAN remoteJid BUKAN grup (@g.us) — chat 1:1
  // pelanggan (kasus utama Kanaka). TODO(v4.4.x): receipt grup (@g.us, key.participant
  // = pembaca per-anggota) → perlu mapping Message.participantJid, belum di scope ini.
  // GUARD MONOTONIC: status TIDAK PERNAH turun (sent → delivered → read).
  // Diterapkan via updateMany bertingkat (waMessageId TANPA unique constraint →
  // updateMany, bukan update) + filter status in [...] → race lintas update aman:
  //   delivered: where status in ['sent']             ; read: where status in ['sent','delivered']
  // Pesan yang sudah 'read' tidak pernah turun ke 'delivered' (filter menolak).
  sock.ev.on('messages.update', async (updates) => {
    if (!Array.isArray(updates) || updates.length === 0) return
    const deliveredIds = []
    const readIds = []
    for (const u of updates) {
      try {
        const key = u?.key
        const statusNum = u?.update?.status
        if (!key || typeof statusNum !== 'number') continue
        // v4.4.0 scope: 1:1 only — fromMe + bukan grup. Pesan grup → TODO di atas.
        if (key.fromMe !== true) continue
        if (typeof key.remoteJid !== 'string' || key.remoteJid.endsWith('@g.us')) continue
        // v4.4.0 audit L2 — defense-in-depth: newsletter/status tak pernah jadi row
        // Message (arsip channel), tapi filter eksplisit → handler tanpa query sia-sia.
        if (key.remoteJid.endsWith('@newsletter') || key.remoteJid === 'status@broadcast') continue
        if (!key.id) continue
        if (statusNum === 3) deliveredIds.push(key.id)
        else if (statusNum >= 4) readIds.push(key.id)
        // statusNum < 3 (pending/server-ack) → abaikan (tidak ada perubahan status UI)
      } catch {
        // entry payload buruk → lanjut entry berikutnya
      }
    }
    if (deliveredIds.length === 0 && readIds.length === 0) return
    try {
      // Kumpulkan tenant untuk broadcast (select SEBELUM update — chatId tetap valid
      // walau row di-purge; dedupe via Set)
      const tenantByWaId = new Map()
      const allIds = [...new Set([...deliveredIds, ...readIds])]
      const rows = await prisma.message.findMany({
        where: { waMessageId: { in: allIds }, direction: 'out', tenantId: tid },
        // v4.4.0 fix kontrak FE: handler onMessageStatus (Dashboard) match by
        // `messageId` (DB id) — pola receipts.js v0.12.9. waMessageId tetap dibawa.
        select: { id: true, waMessageId: true, tenantId: true, chatId: true, status: true },
      })
      for (const r of rows) {
        if (!r.waMessageId) continue
        if (!tenantByWaId.has(r.waMessageId)) tenantByWaId.set(r.waMessageId, { tenantId: r.tenantId, chatId: r.chatId, dbId: r.id, currentStatus: r.status })
      }
      // Monotonic dua-tahap: delivered dulu (dari 'sent'), read setelahnya (dari
      // 'sent'/'delivered') — updateMany = satu query per tahap, bukan per-baris.
      let deliveredCount = 0
      let readCount = 0
      if (deliveredIds.length > 0) {
        const res = await prisma.message.updateMany({
          where: { waMessageId: { in: deliveredIds }, direction: 'out', status: { in: ['sent'] }, tenantId: tid },
          data: { status: 'delivered' },
        })
        deliveredCount = res.count
      }
      if (readIds.length > 0) {
        const res = await prisma.message.updateMany({
          where: { waMessageId: { in: readIds }, direction: 'out', status: { in: ['sent', 'delivered'] }, tenantId: tid },
          data: { status: 'read' },
        })
        readCount = res.count
      }
      // Broadcast message_status per pasangan (tenantId, chatId ter-unik) — pola
      // emitToTenant seperti receipts.js/socket/queue.js. FE update in-place (tanpa refetch).
      const emitted = new Set()
      for (const [waId, info] of tenantByWaId) {
        const wasDelivered = deliveredIds.includes(waId)
        const wasRead = readIds.includes(waId)
        if (!wasDelivered && !wasRead) continue
        // Status final monotonic: read menang bila ada di kedua batch
        const finalStatus = wasRead ? 'read' : 'delivered'
        // v4.4.0 audit L1 — ACK duplikat (mis. DELIVERY datang lagi setelah READ):
        // DB tetap aman (filter monotonic), tapi emit jangan menurunkan tick FE —
        // skip bila status final TIDAK lebih tinggi dari status row saat pre-update.
        const STATUS_RANK = { sent: 1, delivered: 2, read: 3 }
        const finalRank = STATUS_RANK[finalStatus] || 0
        const currentRank = STATUS_RANK[info.currentStatus] || 0
        if (finalRank <= currentRank) continue
        const key = `${info.tenantId}:${info.chatId}:${waId}`
        if (emitted.has(key)) continue
        emitted.add(key)
        broadcast.emitToTenant(info.tenantId, 'message_status', {
          messageId: info.dbId,
          waMessageId: waId,
          chatId: info.chatId,
          status: finalStatus,
        })
      }
      if (deliveredCount > 0 || readCount > 0) {
        log(tid, slot, `[v4.4.0] receipts: delivered=${deliveredCount}, read=${readCount}`)
      }
    } catch (e) {
      logErr(tid, slot, 'messages.update (receipts) error:', e.message)
    }
  })

  return st
}

function scheduleReconnect(st) {
  if (st.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    st.connectionState = 'failed'
    st.reconnectAttempts = 0
    broadcastWaStatus(st)
    logErr(st.tenantId, st.slot, `Reconnect gagal ${MAX_RECONNECT_ATTEMPTS}x — berhenti (status failed). Gunakan reconnect manual.`)
    return
  }
  st.reconnectAttempts++
  const delay = RECONNECT_DELAYS_MS[Math.min(st.reconnectAttempts, RECONNECT_DELAYS_MS.length) - 1]
  st.connectionState = 'reconnecting'
  broadcastWaStatus(st, { reconnectAttempt: st.reconnectAttempts, maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS })
  log(st.tenantId, st.slot, `Reconnect #${st.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} dalam ${delay}ms`)
  st.reconnectTimeoutId = setTimeout(() => {
    st.reconnectTimeoutId = null
    connectTenant(st.tenantId, { isReconnect: true, slot: st.slot }).catch((e) => {
      logErr(st.tenantId, st.slot, 'reconnect attempt error:', e.message)
      scheduleReconnect(st)
    })
  }, delay)
}

async function handleLoggedOut(st) {
  const slot = st.slot || 0
  logErr(st.tenantId, slot, 'Logged out oleh WA — sesi dihapus, scan QR ulang diperlukan')
  st.sock = null
  st.connectionState = 'disconnected'
  st.currentQR = null
  st.phoneNumber = null
  st.isConnecting = false
  // v3.9 — dir sesi per-slot; slot-0 = Tenant.waSessionDir (kompat)
  let dir
  if (slot === 0) {
    const tenant = await prisma.tenant.findUnique({ where: { id: st.tenantId }, select: { waSessionDir: true } })
    dir = tenant?.waSessionDir || defaultSessionDir(st.tenantId, 0)
  } else {
    const row = await prisma.tenantNumber.findUnique({ where: { tenantId_slot: { tenantId: st.tenantId, slot } }, select: { waSessionDir: true } })
    dir = row?.waSessionDir || defaultSessionDir(st.tenantId, slot)
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    log(st.tenantId, slot, 'Session dir dihapus:', dir)
  } catch (e) {
    logErr(st.tenantId, slot, 'Gagal hapus session dir:', e.message)
  }
  try {
    if (slot === 0) await prisma.tenant.update({ where: { id: st.tenantId }, data: { waPhone: null } })
  } catch {}
  broadcastWaStatus(st, { loggedOut: true })
}

// ─── Disconnect / Logout / Reconnect ───────────────────────────────

/**
 * Soft disconnect: end socket, SESI TETAP ada di disk (tinggal connect lagi).
 */
async function disconnectTenant(tenantId, slot = 0) {
  const tid = Number(tenantId)
  const s = Number(slot) || 0
  const st = pool.get(slotKey(tid, s))
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
async function logoutTenant(tenantId, slot = 0) {
  const tid = Number(tenantId)
  const s = Number(slot) || 0
  const st = pool.get(slotKey(tid, s))

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

  // Hapus dir sesi slot ini SAJA (slot lain tidak tersentuh)
  let dir
  if (s === 0) {
    const tenant = await prisma.tenant.findUnique({ where: { id: tid }, select: { waSessionDir: true } })
    dir = tenant?.waSessionDir || defaultSessionDir(tid, 0)
  } else {
    const row = await prisma.tenantNumber.findUnique({ where: { tenantId_slot: { tenantId: tid, slot: s } }, select: { waSessionDir: true } })
    dir = row?.waSessionDir || defaultSessionDir(tid, s)
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    log(tid, s, 'Logout: session dir dihapus', dir)
  } catch (e) {
    logErr(tid, s, 'Logout: gagal hapus session dir:', e.message)
  }

  try {
    if (s === 0) await prisma.tenant.update({ where: { id: tid }, data: { waPhone: null } })
  } catch (e) {
    logErr(tid, s, 'Logout: gagal clear waPhone:', e.message)
  }

  if (st) broadcastWaStatus(st, { loggedOut: true })
  log(tid, s, 'Logout selesai')
  return { ok: true }
}

/**
 * Reconnect = soft disconnect + connect lagi (sesi lama dipakai kalau masih valid).
 * v3.9 — per-slot.
 */
async function reconnectTenant(tenantId, slot = 0) {
  await disconnectTenant(tenantId, slot)
  // beri jeda kecil agar socket lama benar-benar mati dulu
  await new Promise((r) => setTimeout(r, 500))
  return connectTenant(tenantId, { slot: Number(slot) || 0 })
}

// ─── Socket resolution (outgoing) ──────────────────────────────────

// v4.0.0 — E2E outbound stub (E2E_OK_SEND=1 + WA_DISABLED=1): pengiriman auto
// (auto-reply/gateway/CSAT path) "terkirim" disimulasikan TANPA Baileys —
// sendAutoText/sendAutoMessage sukses (Message row/broadcast/counter jalan utk E2E).
// Guard ganda: WA_DISABLED=1 WAJIB tetap ON (tidak pernah aktif di produksi —
// prod punya socket asli; var env ini hanya dibaca saat WA mati).
function e2eOkSendEnabled() {
  return config.waDisabled && String(process.env.E2E_OK_SEND || '') === '1'
}

function getSocketForTenant(tenantId, slot = 0) {
  if (config.waDisabled) {
    if (e2eOkSendEnabled()) return { fake: true, sendMessage: async () => ({ key: { id: 'E2E-OK-SEND-' + Date.now() } }) }
    return null
  }
  const st = pool.get(slotKey(tenantId, slot))
  return st && st.connectionState === 'open' ? st.sock : null
}

function isTenantConnected(tenantId, slot = 0) {
  return !!getSocketForTenant(tenantId, slot)
}

function getStatusForTenant(tenantId, slot = 0) {
  if (config.waDisabled) {
    return { connected: false, qrNeeded: false, state: 'disabled', phoneNumber: null, disabled: true, slot: Number(slot) || 0 }
  }
  const st = pool.get(slotKey(tenantId, slot))
  if (!st) return { connected: false, qrNeeded: false, state: 'disconnected', phoneNumber: null, disabled: false, slot: Number(slot) || 0 }
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
async function getQRDataUrl(tenantId, slot = 0) {
  const st = pool.get(slotKey(tenantId, slot))
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

// ═══ v3.8 — Low-level send guard (READ-ONLY enforcement) ═══
// Block SEMUA pengiriman outgoing tenant expired / not_started — SATU titik
// kontrol: scheduler pesan terjadwal, CSAT pending (self-heal), auto-reply
// greeting/outside-hours, menu gateway, blast — semuanya lewat
// sendMessageForTenant/sendMediaForTenant. Bila tenant expired → THROW
// (error tetap tercatat di logika pemanggil: scheduled error, blastLog failed,
// auto-reply revert marker — TIDAK ada pesan keluar atas nama tenant expired).
// Incoming WA tetap diterima & tampil (read-only). Guard murni per-tenant —
// jalur low-level tidak punya konteks actor (impersonate juga terblokir di
// level ini, sesuai "tidak boleh ada pesan keluar atas nama tenant expired").
const validity = require('../services/validity')
async function assertCanSendTenant(tenantId) {
  try {
    const sub = await validity.getSubscription(tenantId)
    if (sub && validity.isReadOnly(sub.state)) {
      const err = new Error(
        sub.state === 'not_started'
          ? 'Masa aktif tenant belum dimulai — pengiriman diblokir.'
          : 'Masa aktif tenant habis — pengiriman diblokir. Perbarui langganan untuk mengirim kembali.'
      )
      err.code = validity.codeFor(sub.state)
      throw err
    }
  } catch (e) {
    // Gagal membaca validity (bukan read-only rejection) → fail-open (pola
    // middleware: DB error TIDAK boleh mematikan pengiriman tenant normal).
    if (e.code === 'SUBSCRIPTION_EXPIRED' || e.code === 'SUBSCRIPTION_NOT_STARTED') throw e
    logErr(tenantId, 0, '[Validity] guard read error (fail-open):', e.message)
  }
}

// v3.9 — pesan error tidak-connected per-slot (aturan tunggal: JANGAN fallback;
// CS harus tahu nomor mana yang mati — owner 18:24 #3)
function slotNotConnectedMessage(tenantId, slot) {
  return `Nomor pengirim (slot ${Number(slot) || 0}) tidak terhubung — balas via nomor yang menerima. Nyalakan/hubungkan nomor itu dulu di Admin → WhatsApp.`
}

async function sendMessageForTenant(tenantId, waJid, text, opts = {}) {
  const slot = Number(opts.slot) || 0
  await assertCanSendTenant(tenantId)
  const sock = getSocketForTenant(tenantId, slot)
  if (!sock) {
    throw notConnectedError(config.waDisabled ? WA_DISABLED_MSG : (slot ? slotNotConnectedMessage(tenantId, slot) : WA_NOT_CONNECTED_MSG))
  }
  // v3.9.14 — quoted passthrough (WAMessage minimal dari target Message row) →
  // Baileys isi contextInfo (stanzaId + participant + quotedMessage proto).
  const result = await sock.sendMessage(waJid, { text }, opts.quoted ? { quoted: opts.quoted } : undefined)
  return result
}

async function sendMediaForTenant(tenantId, waJid, buffer, mediaType, mimetype, caption, fileName, opts = {}) {
  const slot = Number(opts.slot) || 0
  await assertCanSendTenant(tenantId)
  const sock = getSocketForTenant(tenantId, slot)
  if (!sock) {
    throw notConnectedError(config.waDisabled ? WA_DISABLED_MSG : (slot ? slotNotConnectedMessage(tenantId, slot) : WA_NOT_CONNECTED_MSG))
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

// ═══ v3.9.14 — Quote Reply (WhatsApp contextInfo) ═══
// Ekstrak contextInfo dari pesan masuk secara generik (key pertama yang membawa
// contextInfo — extendedTextMessage = kasus 99%). Return kolom quoted utk persist
// ATAU null bila bukan quote-reply.
const QUOTED_TYPE_BY_KEY = {
  conversation: 'text',
  extendedTextMessage: 'text',
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  stickerMessage: 'sticker',
  documentMessage: 'document',
}

/**
 * extractQuote(msg) → null | { quotedWaMessageId, quotedParticipantJid, quotedType, snippetPlain }
 * - snippetPlain: plaintext ≤200 char (BELUM dienkripsi — pemanggil encryptText)
 * - participant TIDAK di-resolve (@lid disimpan mentah — v3.5 LID mapping jalurnya sendiri)
 */
function extractQuote(msg) {
  try {
    const m = msg?.message
    if (!m) return null
    // key pesan pembawa contextInfo (extendedTextMessage 99%, fallback: key lain)
    const carrierKey = Object.keys(m).find((k) => m[k] && typeof m[k] === 'object' && m[k].contextInfo)
    if (!carrierKey) return null
    const ctx = m[carrierKey].contextInfo
    const stanzaId = ctx.stanzaId || null
    if (!stanzaId) return null // bukan quote-reply (mis. reply-link UI-only tanpa stanzaId)
    const quotedProto = ctx.quotedMessage || null
    if (!quotedProto) return null
    const quotedKey = Object.keys(quotedProto).find((k) => QUOTED_TYPE_BY_KEY[k])
    if (!quotedKey) return null // proto eksotis (poll/template) → P1 skip, chip fallback saja

    // Snippet plaintext: conversation / extendedTextMessage.text / media caption
    // (proto conversation = string langsung; extendedText di .text — WAJIB beda!)
    const q = quotedProto[quotedKey]
    let snippetPlain = null
    if (quotedKey === 'conversation') {
      snippetPlain = typeof q === 'string' ? q : String(q?.conversation || '')
    } else if (quotedKey === 'extendedTextMessage') {
      snippetPlain = String(q?.text || '')
    } else if (q?.caption) {
      snippetPlain = String(q.caption)
    } else if (quotedKey === 'documentMessage' && q?.fileName) {
      snippetPlain = String(q.fileName)
    }
    const type = QUOTED_TYPE_BY_KEY[quotedKey]
    snippetPlain = (snippetPlain || `[${type.charAt(0).toUpperCase() + type.slice(1)}]`).slice(0, 200)

    return {
      quotedWaMessageId: String(stanzaId),
      quotedParticipantJid: ctx.participant ? String(ctx.participant) : null,
      quotedType: type,
      snippetPlain,
    }
  } catch {
    return null // quote parsing GAK PERNAH bikin pesan masuk gagal persist
  }
}

/** Kolom quoted utk prisma.message.create (null → undefined biar Prisma default) */
function quotedColumnsFromExtract(extracted) {
  if (!extracted) return {}
  const { encryptText } = require('../services/textCrypto')
  return {
    quotedWaMessageId: extracted.quotedWaMessageId,
    quotedParticipantJid: extracted.quotedParticipantJid,
    quotedSnippet: encryptText(extracted.snippetPlain),
    quotedType: extracted.quotedType,
  }
}

/**
 * broadcast payload pesan: content plaintext + quoted shape v3.9.14 (plaintext
 * snippet dekrip on-the-fly + dbMessageId resolve same-chat via waMessageId).
 * Fire-and-forget resolve — gagal lookup → dbMessageId null (chip snippet-only).
 * Kolom quoted mentah (incl. quotedSnippet ciphertext) di-strip — cuma shape `quoted`.
 */
async function buildBroadcastPayload(dbMsg) {
  const { decryptTextSafe } = require('../services/textCrypto')
  const payload = { ...dbMsg, content: decryptTextSafe(dbMsg.content) }
  delete payload.quotedWaMessageId
  delete payload.quotedParticipantJid
  delete payload.quotedSnippet
  delete payload.quotedType
  payload.quoted = await buildQuotedShape(dbMsg)
  return payload
}

async function buildQuotedShape(dbMsg) {
  if (!dbMsg || !dbMsg.quotedWaMessageId) return null
  try {
    const { decryptTextSafe } = require('../services/textCrypto')
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
 * cek apakah sudah ada chat LAIN dengan waJid = phone JID itu (scope tenant + SLOT —
 * v3.9.2 K1-A: merge HANYA antar chat dalam slot yang sama, JANGAN lintas slot).
 * Kalau ada → merge ringan: pindahkan pesan chat LID → chat phone, pindahkan
 * Contact LID (delete, data diambil chat phone), pasang lidJid di chat phone,
 * hapus chat LID. Return chat phone. Gagal merge → return chat LID apa adanya
 * (routing tidak boleh gagal karena merge — non-fatal).
 */
async function mergeLidIntoPhoneChat(tid, slot, lidChat, phoneJid) {
  const s = Number(slot) || 0
  const phone = String(phoneJid).split('@')[0]
  try {
    const phoneChat = await prisma.chat.findUnique({
      where: { tenantId_numberSlot_waJid: { tenantId: tid, numberSlot: s, waJid: phoneJid } },
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
    log(tid, s, `mergeLidIntoPhoneChat: chat LID ${lidChat.waJid} (#${lidChat.id}) → chat phone #${phoneChat.id} (slot ${s}, ${r.count} pesan dipindah)`)
    broadcast.emitToTenant(tid, 'chat_update', { chatId: phoneChat.id, contactPhone: phone, phoneJid })
    return await prisma.chat.findUnique({ where: { id: phoneChat.id } })
  } catch (e) {
    logErr(tid, s, 'mergeLidIntoPhoneChat error (non-fatal):', e.message)
    return lidChat
  }
}

/**
 * v3.5 — Inline LID resolve (port hub L833-857, tenant-scoped + SLOT-scoped v3.9.2):
 * pesan 1:1 dari LID yang phoneJid-nya masih null → fire-and-forget resolve
 * (tidak memblokir persist pesan). Dapat phone → update chat LID (SLOT INI SAJA —
 * K1-A: JANGAN menyentuh chat slot lain) + merge guard dalam-slot;
 * gagal → kirim requestPhoneNumber SEKALI per LID (Set per socket, reset saat reconnect).
 */
function maybeResolveLidChat(tid, chat, sock, slot = 0) {
  const s = Number(slot) || 0
  try {
    if (!chat.waJid.endsWith('@lid') || chat.phoneJid) return
    const st = pool.get(slotKey(tid, s))
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
              log(tid, s, `requestPhoneNumber terkirim ke ${chat.waJid} (inline fallback)`)
            } catch (e) {
              logErr(tid, s, `inline requestPhoneNumber error ${chat.waJid}:`, e.message)
            }
          }
          return
        }
        const phone = phoneJid.split('@')[0]
        // v3.9.2 K1-A — scoped per slot: update chat LID di slot INI saja.
        await prisma.chat.updateMany({
          where: { tenantId: tid, numberSlot: s, waJid: chat.waJid },
          data: { contactPhone: phone, phoneJid },
        })
        // Merge guard: bila chat phone dgn JID sama sudah ada (SLOT SAMA) → gabungkan
        const fresh = await prisma.chat.findUnique({ where: { tenantId_numberSlot_waJid: { tenantId: tid, numberSlot: s, waJid: chat.waJid } } })
        if (fresh) await mergeLidIntoPhoneChat(tid, s, fresh, phoneJid)
      })
      .catch((e) => logErr(tid, s, 'Inline LID resolve error:', e.message))
  } catch (e) {
    logErr(tid, s, 'maybeResolveLidChat error (non-fatal):', e.message)
  }
}

/**
 * Process one incoming WA message for a specific tenant (+SLOT, v3.9).
 * v3.9.2 K1-A — Chat find-or-create by [tenantId, numberSlot, waJid]: kontak sama
 * via nomor beda = chat TERPISAH beneran per slot (owner locked 20:27). Semua
 * routing LID↔phone di-scope per slot — merge inline hanya antar chat DALAM slot
 * yang sama, JANGAN pernah menyentuh chat slot lain (unread/queue state).
 * Mode assigned/mix → born-assigned ke agent slot (pola PIC grup).
 * Return { chat, message } | null.
 */
async function processIncomingMessage(tenantId, msg, meta = {}) {
  const tid = Number(tenantId)
  const rawJid = msg?.key?.remoteJid
  if (!Number.isFinite(tid) || tid <= 0 || !rawJid) return null
  if (rawJid === 'status@broadcast') return null
  if (rawJid.endsWith('@newsletter')) return null // v4.0.0c — Channel bukan chat customer (defense-in-depth)
  const inboxSlot = Number(meta?.slot) || 0
  // v3.9.2 — true bila chat dibuat BARU oleh pesan ini (unread=1 sudah dihitung
  // di create — update final tidak increment lagi, cegah double-increment).
  let firstMessageCounted = false

  // v3.5 §1 — resolveEffectiveJid: match chat existing dua arah sebelum create.
  // 1:1 saja (@lid / @s.whatsapp.net); grup (@g.us) dan status lewat jalur lama.
  // v3.9.2 K1-A — SEMUA lookup di-scope per SLOT (numberSlot = inboxSlot):
  // pesan masuk slot N tidak pernah menyentuh chat milik slot lain.
  const altJid = msg?.key?.remoteJidAlt || null
  let routeMode = 'exact' // exact | lid-to-phone | phone-to-lid
  let routedChat = null

  if (rawJid.endsWith('@lid') || rawJid.endsWith('@s.whatsapp.net')) {
    // (1) status quo: chat by [tenantId, numberSlot, waJid: rawJid]
    routedChat = await prisma.chat.findUnique({
      where: { tenantId_numberSlot_waJid: { tenantId: tid, numberSlot: inboxSlot, waJid: rawJid } },
    })
    // v3.5.1 — PESAN LID yang membawa altJid phone (remoteJidAlt): chat PHONE
    // menang atas exact LID chat. Kasus 02:27 (Kanaka): chat LID lama exist dari
    // test sebelumnya → exact match menang → balasan nyasar + greeting. Kalau
    // chat phone utk nomor yang sama ada → itu canonical; kalau chat LID lama
    // JUGA ada (beda row) → merge inline LID → phone, route ke phone.
    // v3.9.2 K1-A: scoped ke inboxSlot — merge hanya antar chat dalam slot sama.
    if (rawJid.endsWith('@lid')) {
      const altPhonePref = altJid && String(altJid).endsWith('@s.whatsapp.net') ? altJid : null
      if (altPhonePref) {
        const altPhoneChat = await prisma.chat.findUnique({
          where: { tenantId_numberSlot_waJid: { tenantId: tid, numberSlot: inboxSlot, waJid: altPhonePref } },
        })
        if (altPhoneChat && (!routedChat || routedChat.id !== altPhoneChat.id)) {
          if (routedChat) {
            const merged = await mergeLidIntoPhoneChat(tid, inboxSlot, routedChat, altPhonePref)
            routedChat = merged && merged.waJid === altPhonePref ? merged : altPhoneChat
            log(tid, inboxSlot, `routing v3.5.1: pesan LID ${rawJid} diarahkan ke chat phone #${routedChat.id}${merged && merged.waJid === altPhonePref ? ' (chat LID lama di-merge, slot sama)' : ''}`)
          } else {
            routedChat = altPhoneChat
          }
          routeMode = 'lid-to-phone'
        }
      }
    }
    if (!routedChat && rawJid.endsWith('@lid')) {
      // (2) LID baru → chat phone-JID milik nomor yang sama (SLOT INI SAJA)
      const altPhone = altJid && altJid.endsWith('@s.whatsapp.net') ? altJid : null
      if (altPhone) {
        const byAlt = await prisma.chat.findUnique({
          where: { tenantId_numberSlot_waJid: { tenantId: tid, numberSlot: inboxSlot, waJid: altPhone } },
        })
        if (byAlt) {
          routedChat = byAlt
          routeMode = 'lid-to-phone'
        }
      }
      if (!routedChat) {
        const byLidField = await prisma.chat.findFirst({
          where: { tenantId: tid, numberSlot: inboxSlot, lidJid: rawJid },
          orderBy: { id: 'asc' },
        })
        if (byLidField) {
          routedChat = byLidField
          routeMode = 'lid-to-phone'
        }
      }
      if (!routedChat) {
        // (2b) LID baru tanpa lidJid tercatat → chat phone via phoneJid (mapping
        // kolom, chat LID lama yang sudah resolved ke nomor itu — slot ini).
        const altPhone2 = altJid && altJid.endsWith('@s.whatsapp.net') ? altJid : null
        if (altPhone2) {
          const byPhoneField = await prisma.chat.findFirst({
            where: { tenantId: tid, numberSlot: inboxSlot, phoneJid: altPhone2, waJid: { not: rawJid } },
            orderBy: { id: 'asc' },
          })
          if (byPhoneField) {
            routedChat = byPhoneField
            routeMode = 'lid-to-phone'
          }
        }
      }
    } else if (!routedChat && rawJid.endsWith('@s.whatsapp.net')) {
      // (3) phone JID → chat LID yang mapping-nya sudah tersimpan (SLOT INI):
      //     altJid LID (v3.5.1) → kolom lidJid ATAU kolom phoneJid (chat LID yang
      //     sudah belajar nomor ini).
      const altLid = altJid && String(altJid).endsWith('@lid') ? String(altJid).split(':')[0] + '@lid' : null
      if (altLid) {
        const byAltLid = await prisma.chat.findUnique({
          where: { tenantId_numberSlot_waJid: { tenantId: tid, numberSlot: inboxSlot, waJid: altLid } },
        })
        if (byAltLid) {
          routedChat = byAltLid
          routeMode = 'phone-to-lid'
        }
      }
      if (!routedChat) {
      const byLidField = await prisma.chat.findFirst({
        where: { tenantId: tid, numberSlot: inboxSlot, lidJid: rawJid },
        orderBy: { id: 'asc' },
      })
      if (byLidField) {
        routedChat = byLidField
        routeMode = 'phone-to-lid'
      } else {
        const byPhoneField = await prisma.chat.findFirst({
          where: { tenantId: tid, numberSlot: inboxSlot, phoneJid: rawJid, waJid: { endsWith: '@lid' } },
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
    // v3.9.2 — socket slot penerima (bukan selalu slot-0)
    const sock = getSocketForTenant(tid, inboxSlot)
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

  // v3.9.14 — quote-reply masuk: ekstrak contextInfo SEKALI di sini (dipakai jalur
  // 1:1 maupun grup via ctx.quoteCols).
  const quoteCols = quotedColumnsFromExtract(extractQuote(msg))

  // ── Grup: jalur terpisah (@g.us) — persist pesan grup via services/groups ──
  if (chatId.endsWith('@g.us')) {
    try {
      const groupsSvc = require('../services/groups')
      await groupsSvc.handleIncomingGroupMessage(tid, msg, { waJid: chatId, text: effectiveText || null, mediaType, mediaPath, mediaMime, mediaSize, dbTimestamp, senderName, numberSlot: inboxSlot, quoteCols })
    } catch (e) {
      console.error('[WA] Group message handler error (non-fatal):', e.message)
    }
    return null
  }

  // (7) chat hasil routing dipakai utk SEMUA downstream; kalau tidak ada match
  //     → find-or-create seperti biasa (dengan mapping bila ada).
  //     v3.9.2 K1-A — find-or-create by [tenantId, numberSlot, waJid]: kontak
  //     sama via nomor beda = 2 baris Chat berbeda (masing-masing slot tetap;
  //     TIDAK toggle numberSlot mengikuti pesan terakhir — owner 20:27 A.3).
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
      where: { tenantId_numberSlot_waJid: { tenantId: tid, numberSlot: inboxSlot, waJid: chatId } },
    })
    if (!chat) {
      chat = await prisma.chat.create({
        data: {
          tenantId: tid,
          waJid: chatId,
          contactPhone: phone,
          contactName: msg.key.fromMe ? null : (msg.pushName || null), // v3.9.10 — pushName di pesan keluar = NAMA OWNER sendiri; jangan dipakai sbg nama kontak (kasus Nurhayati)
          phoneJid: mappingPhoneJid,
          lidJid: mappingLidJid,
          numberSlot: inboxSlot, // v3.9.2 K1-A — slot asal pesan masuk (reply via nomor yang sama; chat per-slot)
          unreadCount: msg.key.fromMe ? 0 : 1,
          status: 'open',
          queuedAt: dbTimestamp,
          firstIncomingAt: msg.key.fromMe ? null : dbTimestamp,
        },
      })
      firstMessageCounted = true
      if (mappingLidJid || (isLid && mappingPhoneJid)) {
        log(tid, inboxSlot, `chat baru ${chatId} dibuat dgn mapping (phoneJid=${mappingPhoneJid}, lidJid=${mappingLidJid}, slot=${inboxSlot})`)
      }
    }
  }

  // ═══ v3.9 — numberSlot + born-assigned routing (owner 18:24 #1/#2) ═══
  // Pesan masuk (bukan fromMe): routing mode:
  //   pool → antrean existing TANPA perubahan (multi-nomor transparan utk CS)
  //   assigned → born-assigned ke agent slot (gak masuk antrean umum) + notif
  //   mix → per-slot (slot dgn assignedAgentId = assigned, sisanya pool)
  // v3.9.2 K1-A ATURAN TUNGGU: kontak sama via nomor beda = chat terpisah per
  // slot; numberSlot chat TIDAK pernah ditoggle mengikuti pesan terakhir (chat
  // sudah unik per slot — pesan masuk slot N gak nyentuh chat slot lain).
  // Reply tetap ikut numberSlot chat (tidak pernah fallback — owner 18:24 #3).
  if (!msg.key.fromMe) {
    // v3.9.10b (audit LOW-1) — backfill SEBELUM routing born-assigned: push
    // pertama ke agent sudah pakai nama kontak (pushName pelanggan), bukan
    // fallback nomor/JID. Kondisional contactName:null — anti timpa rename CS.
    if (msg.pushName && !chat.contactName) {
      try {
        const bf = await prisma.chat.updateMany({ where: { id: chat.id, contactName: null }, data: { contactName: String(msg.pushName) } })
        if (bf.count) chat = { ...chat, contactName: String(msg.pushName) }
      } catch (e) {
        logErr(tid, inboxSlot, 'backfill contactName error (non-fatal):', e.message)
      }
    }
    try {
      const route = await resolveRouteForSlot(tid, inboxSlot)
      // v3.9.2 K1-A: chat sudah di-scope ke inboxSlot (find-or-create by slot) —
      // numberSlot TIDAK pernah diubah lagi di sini (chat slot N tetap slot N).
      if (route === 'assigned' && chat.assignedToId == null) {
        const numRow = await prisma.tenantNumber.findUnique({
          where: { tenantId_slot: { tenantId: tid, slot: inboxSlot } },
          select: { assignedAgentId: true, reassignOffline: true, label: true },
        })
        let targetAgentId = numRow?.assignedAgentId || null
        // Opsi reassign-offline (default OFF): agent assigned offline → pindah ke
        // CS/admin tenant lain yang online. OFF → personal queue (gak di-reassign).
        if (targetAgentId) {
          const agent = await prisma.user.findFirst({ where: { id: targetAgentId, tenantId: tid }, select: { id: true, status: true } })
          if (!agent || agent.status !== 'active') targetAgentId = null // agent hilang/nonaktif → jangan assign ke hantu
          else if (numRow?.reassignOffline) {
            const presence = require('../socket/presence')
            if (!presence.isOnline(tid, targetAgentId)) {
              const fallback = await prisma.user.findFirst({
                where: { tenantId: tid, role: { in: ['cs', 'admin'] }, status: 'active', id: { not: targetAgentId } },
                orderBy: { id: 'asc' },
                select: { id: true },
              })
              const fallbackId = fallback?.id || null
              log(tid, inboxSlot, `[v3.9] agent assigned offline + reassignOffline=ON → pindah ke ${fallbackId || 'tidak ada kandidat (tetap personal queue)'}`)
              targetAgentId = fallbackId // null → tetap personal queue
            }
          }
        }
        if (targetAgentId && targetAgentId !== chat.assignedToId) {
          const nowTs = dbTimestamp
          await prisma.chat.update({
            where: { id: chat.id },
            data: {
              assignedToId: targetAgentId,
              status: 'open',
              queuedAt: null, // born-assigned = BUKAN antrean umum
              firstAssignedAt: chat.firstAssignedAt || nowTs,
              lastAssignedAt: nowTs,
            },
          })
          await prisma.chatEvent.create({
            data: { tenantId: tid, chatId: chat.id, userId: null, type: 'assigned', createdAt: nowTs },
          })
          chat = { ...chat, assignedToId: targetAgentId, queuedAt: null, status: 'open' }
          broadcast.emitToTenant(tid, 'chat_update', { chatId: chat.id, assignedTo: targetAgentId, queuedAt: null, numberSlot: inboxSlot, bornAssigned: true })
          queue.emitQueueUpdate(tid)
          log(tid, inboxSlot, `[v3.9] born-assigned chat=${chat.id} → agent=${targetAgentId} (slot ${inboxSlot}, gak lewat antrean umum)`)
          // Notif ke agent tsb (pola push PIC)
          try {
            push.sendToUser(targetAgentId, {
              kind: 'message',
              chatId: chat.id,
              title: chat.contactName || chat.contactPhone || chat.waJid,
              body: push.truncate(previewTextForPush(effectiveText, mediaType)),
              url: `/?chat=${chat.id}`,
            })
          } catch {}
        }
      }
    } catch (e) {
      logErr(tid, inboxSlot, '[v3.9] numberSlot/born-assigned routing error (non-fatal):', e.message)
    }
  }

  // v3.5 §2 — inline LID resolve (fire-and-forget; tidak memblokir persist)
  if (!msg.key.fromMe) {
    maybeResolveLidChat(tid, chat, getSocketForTenant(tid, inboxSlot), inboxSlot)
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
        const handled = await menuGateway.handleChoiceWithText(chat.id, effectiveText || '', effectiveText || '')
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
  // v3.9.14 — quote-reply masuk: persist 4 kolom quoted (+ snippet terenkripsi)
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
      ...quoteCols,
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
  // v3.9.2 — fix double-increment chat BARU: pesan pertama sudah dihitung di create
  // (unread=1). ATOMIC increment hanya bila chat existing / pesan lanjutan.
  const preview = effectiveText || (mediaType ? `[${mediaType.charAt(0).toUpperCase() + mediaType.slice(1)}]` : '[Media]')
  const chatUpdateFinal = {
    lastMessageAt: dbMsg.timestamp,
    lastMessagePreview: encryptText(preview),
  }
  if (!msg.key.fromMe && !firstMessageCounted) chatUpdateFinal.unreadCount = { increment: 1 }
  await prisma.chat.update({
    where: { id: chat.id },
    data: chatUpdateFinal,
  })
  const newUnread = msg.key.fromMe
    ? (chat.unreadCount || 0)
    : (firstMessageCounted ? (chat.unreadCount || 0) : ((chat.unreadCount || 0) + 1))

  // Broadcast scoped ke room tenant (plaintext utk UI)
  // v3.9.14 — payload bawa quoted shape konsisten dgn REST (§6 spec)
  broadcast.emitToTenant(tid, 'new_message', { chatId: chat.id, message: buildBroadcastPayload(dbMsg) })
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
      log(tid, inboxSlot, 'push trigger error (non-fatal):', e.message)
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

/** v3.9 — preview push aman (dipakai born-assigned sebelum preview penuh dihitung). */
function previewTextForPush(effectiveText, mediaType) {
  return effectiveText || (mediaType ? `[${mediaType.charAt(0).toUpperCase() + mediaType.slice(1)}]` : '[Media]')
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
  // v3.9.2 K1-A — Contact.chatId = PRIMARY chat (chat terakhir aktif kontak itu).
  // Chat 1:1 LAIN dgn nomor sama (slot beda) tetap sync kontak; bila kontak sudah
  // lengkap → HANYA pindahkan primary (chatId) ke chat yang baru aktif ini.
  if (chat.contact && (!phone || chat.contact.phone === phone)) {
    if (!chat.contact.chatId || chat.contact.chatId !== chat.id) {
      // Primary pindah ke chat yang baru masuk pesan (race-safe: bila kontak
      // sudah di-claim chat lain di antara baca & update → biarkan; C1 pola v3.7).
      await prisma.contact.updateMany({ where: { id: chat.contact.id }, data: { chatId: chat.id } }).catch((e) => {
        if (!String(e?.message || '').includes('Unique constraint')) console.error('[Pool] primary chat move error (non-fatal):', e.message)
      })
    }
  }
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
      // v3.9.2 K1-A — kontak existing (nomor sama, slot lain) + chat baru ini aktif
      // → PRIMARY pindah ke chat ini (Contact.chatId = chat terakhir aktif).
      // 1 kontak per orang tetap (identity per phone); JANGAN bikin kontak dobel.
      if (existing.chatId !== chat.id) patch.chatId = chat.id
      if (Object.keys(patch).length > 0) {
        try {
          await prisma.contact.update({ where: { id: existing.id }, data: patch })
        } catch (e) {
          if (!String(e?.message || '').includes('Unique constraint')) throw e
          // Unique chatId = kontak lain sudah nge-claim chat ini (race) — skip.
        }
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
  // v3.9.14 — Quote Reply
  extractQuote,
  quotedColumnsFromExtract,
  buildQuotedShape,
  // v4.1.0 — Channels: helper media utk services/channelArchive (metadata → ext)
  getExtFromMime,
  WA_NOT_CONNECTED_MSG,
  WA_DISABLED_MSG,
  // v3.9 — multi-nomor per-slot
  MAX_SLOT,
  slotKey,
  defaultSessionDir,
  listTenantNumbers,
  getTenantNumber,
  ensureSlot0Row,
  resolveRouteForSlot,
  // legacy/global (tanpa tenant) — netral/error jelas
  getStatus,
  getSocket,
  getQRDataUrlLegacy,
  reconnect,
  logout,
}
