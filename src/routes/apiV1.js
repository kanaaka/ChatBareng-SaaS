// ═══════════════════════════════════════════════════════════════════
// v3.9.13 — Public API v1 router (spec docs/spec-api-keys-v1.md).
// Mount: app.use('/api/v1', apiV1Routes) di server.js — TIDAK menyentuh
// route lama. Autentikasi = API key per-tenant (requireApiKey), BUKAN JWT.
//
// Endpoint P1:
//   GET  /api/v1/health   — public liveness (tanpa key)
//   POST /api/v1/messages — scope send  (person/grup; slot auto-resolve)
//   GET  /api/v1/chats    — scope read  (list chat 1:1 + pagination cursor)
//
// Isolasi: SEMUA handler tenant-scoped via req.tenantId (pola requireTenant).
// Audit: setiap send API → ChatEvent source 'api' (lihat tipe chat_event).
// ═══════════════════════════════════════════════════════════════════

const express = require('express')
const router = express.Router()
const prisma = require('../prisma')
const wa = require('../wa/pool')
const broadcast = require('../socket/broadcast')
const apiKeys = require('../services/apiKeys')
const { encryptText, decryptTextSafe } = require('../services/textCrypto')

// ─── Middleware: requireApiKey (spec §2 — urutan cek LOCKED) ───────────
// 1) header ada & hash lookup  → 401 UNAUTHORIZED
// 2) revokedAt / expiresAt     → 401 KEY_REVOKED / KEY_EXPIRED
// 3) plan gate featApiAccess   → 403 UPGRADE_REQUIRED
// 4) rate limit per-key        → 429 + Retry-After
// 5) sukses → req.tenantId + req.apiKey (scope dicek PER-ENDPOINT via requireScope)
async function requireApiKey(req, res, next) {
  // Bearer cbk_… ATAU X-API-Key
  const header = req.headers.authorization
  const bearer = header && header.startsWith('Bearer ') ? header.slice(7).trim() : null
  const raw = bearer || String(req.headers['x-api-key'] || '').trim()
  if (!raw) {
    return res.status(401).json({ error: 'API key tidak ditemukan', code: 'UNAUTHORIZED' })
  }
  let found
  try {
    found = await apiKeys.verify(raw)
  } catch (e) {
    console.error('[APIv1] verify error:', e.message)
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' })
  }
  if (!found) {
    return res.status(401).json({ error: 'API key tidak valid', code: 'UNAUTHORIZED' })
  }
  const apiKey = found.apiKey

  // Revoked → mati instan (tanpa restart)
  if (apiKey.revokedAt) {
    return res.status(401).json({ error: 'API key sudah dicabut', code: 'KEY_REVOKED' })
  }
  // Expired
  if (apiKey.expiresAt && new Date(apiKey.expiresAt).getTime() <= Date.now()) {
    return res.status(401).json({ error: 'API key sudah kedaluwarsa', code: 'KEY_EXPIRED' })
  }
  // Plan gate: planGated key wajib tenant-nya punya featApiAccess
  if (apiKey.planGated) {
    try {
      const plansService = require('../services/plans')
      const plan = await plansService.getPlan(apiKey.tenantId)
      if (!plan || plan.featApiAccess !== true) {
        return res.status(403).json({
          error: 'Akses API tidak tersedia di paket Anda. Hubungi admin platform untuk upgrade.',
          code: 'UPGRADE_REQUIRED',
        })
      }
    } catch (e) {
      console.error('[APIv1] plan gate error (fail-closed):', e.message)
      return res.status(403).json({
        error: 'Akses API tidak tersedia di paket Anda. Hubungi admin platform untuk upgrade.',
        code: 'UPGRADE_REQUIRED',
      })
    }
  }
  // Rate limit per-key (SETELAH auth valid — 429 hanya untuk key yang sah)
  const rl = apiKeys.checkRate(apiKey)
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfter))
    return res.status(429).json({ error: `Batas ${apiKey.ratePerMin} permintaan/menit terlampaui — coba lagi.`, code: 'RATE_LIMITED' })
  }

  req.apiKey = apiKey
  req.tenantId = Number(apiKey.tenantId)
  apiKeys.markUsed(apiKey.id)
  return next()
}

/** requireScope(scope) — per-endpoint scope guard (403 SCOPE_MISSING). */
function requireScope(scope) {
  return (req, res, next) => {
    const scopes = String(req.apiKey?.scopes || '').split(',').filter(Boolean)
    if (!scopes.includes(scope)) {
      return res.status(403).json({
        error: `API key ini tidak punya scope "${scope}". Minta pemilik key menambahkan scope.`,
        code: 'SCOPE_MISSING',
      })
    }
    return next()
  }
}

// GET /api/v1/health — public, tanpa key (liveness untuk consumer apps)
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// ─── POST /api/v1/messages (scope send) ───────────────────────────────
// body { target, text, mediaPath? }
// - target nomor   : "0812…"/"62812…"/"+62812…" → 62…@s.whatsapp.net
// - target JID     : "<digits>@g.us" (grup) / "<digits>@s.whatsapp.net"
// - target nama    : nama grup EKSAK milik tenant (resolve dari Chat rows)
// WA off → 503 WA_BELUM_TERHUBUNG (konsisten dengan route CS lama).
router.post('/messages', requireApiKey, requireScope('send'), async (req, res) => {
  try {
    const tid = req.tenantId
    const body = req.body || {}
    const target = String(body.target || '').trim()
    const text = typeof body.text === 'string' ? body.text : ''
    const mediaPath = typeof body.mediaPath === 'string' ? body.mediaPath.trim() : ''

    if (!target) return res.status(400).json({ error: 'Field `target` wajib diisi', code: 'VALIDATION' })
    if (!text && !mediaPath) {
      return res.status(400).json({ error: 'Field `text` atau `mediaPath` wajib diisi', code: 'VALIDATION' })
    }
    if (text.length > 4096) return res.status(400).json({ error: 'Pesan maksimal 4096 karakter', code: 'VALIDATION' })
    if (mediaPath) {
      // P1: media via API belum didukung (butuh upload pipeline) — jangan silent-ignore.
      return res.status(400).json({ error: 'mediaPath belum didukung di API v1 — gunakan text saja', code: 'VALIDATION' })
    }

    // Resolve target → { jid, slot }
    const resolved = await resolveTarget(tid, target)
    if (!resolved.ok) {
      return res.status(400).json({ error: resolved.error, code: 'VALIDATION' })
    }
    const { jid, slot } = resolved

    // Kirim via pool existing (assertCanSendTenant + slot guard di dalam)
    let waResult
    try {
      waResult = await wa.sendMessageForTenant(tid, jid, text, { slot })
    } catch (e) {
      if (e?.code === 'WA_NOT_CONNECTED' || /belum terhubung|disabled/i.test(e?.message || '')) {
        return res.status(503).json({
          error: e.message || 'WhatsApp belum terhubung untuk tenant ini',
          code: 'WA_BELUM_TERHUBUNG',
        })
      }
      throw e
    }

    // Audit: ChatEvent source 'api' (pola existing type-based events)
    const dbMsgId = waResult?.key?.id || null
    await logApiEvent(tid, jid, text, dbMsgId, slot).catch((e) =>
      console.error('[APIv1] audit event error (non-fatal):', e.message)
    )

    return res.status(200).json({ ok: true, ...(dbMsgId ? { waMessageId: dbMsgId } : {}) })
  } catch (e) {
    console.error('[APIv1] POST /messages error:', e)
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' })
  }
})

/**
 * resolveTarget(tenantId, raw) → { ok:true, jid, slot } | { ok:false, error }
 * - JID @g.us eksplisit → cari row grup tenant (any-slot; slot = slotOfRow).
 * - JID @s.whatsapp.net eksplisit → validasi regex, slot-0.
 * - Nomor biasa → normalize 62 (pola blast.normalizePhone) → slot-0.
 * - Nama grup eksak → Chat row grup tenant (contactName match, 1 baris).
 */
async function resolveTarget(tenantId, raw) {
  const s = String(raw || '').trim()
  if (!s) return { ok: false, error: 'Target kosong' }

  // 1) JID eksplisit (grup WA asli = <digits>-<digits>@g.us → terima digit + dash;
  //    v3.9.18 — JID @lid (WA modern, chat Zahrina dsb.) diterima JIKA row-nya ada
  //    di tenant ini → notif masuk ke chat thread yang sama, bukan thread baru)
  if (s.includes('@')) {
    if (!/^[\d-]+@(s\.whatsapp\.net|g\.us|lid)$/.test(s)) {
      return { ok: false, error: 'Format JID tidak valid (harus <digits>@s.whatsapp.net, <digits>@lid, atau <digits>-<digits>@g.us)' }
    }
    if (s.endsWith('@g.us')) {
      const row = await prisma.chat.findFirst({
        where: { tenantId, waJid: s },
        select: { waJid: true, numberSlot: true },
        orderBy: { id: 'asc' },
      })
      if (!row) return { ok: false, error: 'Grup dengan JID tersebut tidak ditemukan di tenant ini' }
      return { ok: true, jid: row.waJid, slot: Number(row.numberSlot) || 0 }
    }
    // v3.9.18 — JID @lid: resolve via row Chat yang sudah ada (jangan bikin thread
    // baru — LID bukan nomor yang bisa di-normalisasi). Row gak ada → 400.
    if (s.endsWith('@lid')) {
      const row = await prisma.chat.findFirst({
        where: { tenantId, waJid: s },
        select: { waJid: true, numberSlot: true },
        orderBy: { id: 'asc' },
      })
      if (!row) return { ok: false, error: 'JID @lid tidak ditemukan di chat tenant ini (tidak membuat thread baru)' }
      return { ok: true, jid: row.waJid, slot: Number(row.numberSlot) || 0 }
    }
    return { ok: true, jid: s, slot: 0 }
  }

  // 2) Nomor telepon → normalisasi 62 (pola blast)
  if (/^\+?\d[\d\s\-().]*$/.test(s)) {
    const norm = normalizePhone(s)
    if (!norm.ok) return { ok: false, error: `Nomor tidak valid: ${norm.reason}` }
    return { ok: true, jid: `${norm.phone}@s.whatsapp.net`, slot: 0 }
  }

  // 3) Nama grup eksak milik tenant (hanya row grup yang di-adopt)
  const rows = await prisma.chat.findMany({
    where: {
      tenantId,
      contactName: s,
      OR: [{ waJid: { endsWith: '@g.us' } }, { phoneJid: { endsWith: '@g.us' } }],
    },
    select: { waJid: true, numberSlot: true },
    orderBy: { lastMessageAt: 'desc' },
    take: 2,
  })
  if (rows.length === 0) {
    return { ok: false, error: 'Grup dengan nama tersebut tidak ditemukan (nama harus eksak)' }
  }
  if (rows.length > 1) {
    return { ok: false, error: 'Nama grup ambigu (lebih dari satu grup dengan nama sama) — gunakan JID @g.us' }
  }
  return { ok: true, jid: rows[0].waJid, slot: Number(rows[0].numberSlot) || 0 }
}

/** Normalisasi nomor → 62xxx (pola blast.normalizePhone, ringkas). */
function normalizePhone(raw) {
  let phone = String(raw).replace(/[\s\-().]/g, '')
  if (phone.startsWith('+')) phone = phone.slice(1)
  if (phone.startsWith('0')) phone = '62' + phone.slice(1)
  else if (phone.startsWith('8') && !phone.startsWith('62')) phone = '62' + phone
  if (!/^\d+$/.test(phone)) return { ok: false, reason: 'mengandung karakter non-digit' }
  if (phone.length < 8 || phone.length > 15) return { ok: false, reason: 'panjang nomor tidak valid (8-15 digit)' }
  return { ok: true, phone }
}

/** Audit event per send API — tenant-scoped, source 'api' (spec §7). */
async function logApiEvent(tenantId, jid, text, waMessageId, slot) {
  // Grup @g.us: row grup pasti ada (resolveTarget menolak JID asing) → event ke row itu.
  // 1:1: cari row chat by JID (slot-aware); kalau belum ada → buat row born-API slot-0.
  let chat = null
  if (jid.endsWith('@g.us')) {
    chat = await prisma.chat.findFirst({ where: { tenantId, waJid: jid }, orderBy: { id: 'asc' } })
  } else {
    chat = await prisma.chat.findFirst({ where: { tenantId, waJid: jid }, orderBy: { id: 'asc' } })
    if (!chat) {
      const digits = jid.split('@')[0]
      try {
        chat = await prisma.chat.create({
          data: {
            tenantId,
            waJid: jid,
            contactPhone: digits,
            phoneJid: jid,
            numberSlot: Number(slot) || 0,
            status: 'open',
            unreadCount: 0,
            lastMessageAt: new Date(),
            lastMessagePreview: encryptText(text.slice(0, 200)),
          },
        })
        broadcast.emitToTenant(tenantId, 'chat_update', { chatId: chat.id, newChat: true })
      } catch (e) {
        if (e?.code === 'P2002') {
          chat = await prisma.chat.findFirst({ where: { tenantId, waJid: jid }, orderBy: { id: 'asc' } })
        } else throw e
      }
    }
  }
  if (!chat) return
  await prisma.chatEvent.create({
    data: {
      tenantId,
      chatId: chat.id,
      userId: null,
      type: 'api_message',
      source: 'api',
      createdAt: new Date(),
    },
  })
}

// ─── GET /api/v1/chats (scope read) — list chat 1:1 + pagination cursor ──
router.get('/chats', requireApiKey, requireScope('read'), async (req, res) => {
  try {
    const tid = req.tenantId
    const limitRaw = parseInt(req.query.limit || '20', 10)
    const limit = Math.max(1, Math.min(100, Number.isFinite(limitRaw) ? limitRaw : 20))
    const cursor = req.query.cursor ? String(req.query.cursor) : null

    const where = {
      tenantId: tid,
      // Konsisten dengan list 1:1 CS: grup @g.us tidak bocor ke sini (punya
      // endpoint sendiri di P2); hanya chat yang masih punya pesan aktif.
      NOT: { waJid: { endsWith: '@g.us' } },
      messages: { some: { purged: false } },
    }
    // Cursor = opaque "ts|id" (orderBy lastMessageAt desc, id desc — deterministik)
    let cursorTs = null
    let cursorId = null
    if (cursor) {
      const m = /^(\d+)\|(\d+)$/.exec(cursor)
      if (!m) return res.status(400).json({ error: 'Cursor tidak valid', code: 'VALIDATION' })
      cursorTs = new Date(Number(m[1]))
      cursorId = Number(m[2])
      if (isNaN(cursorTs.getTime()) || !Number.isFinite(cursorId)) {
        return res.status(400).json({ error: 'Cursor tidak valid', code: 'VALIDATION' })
      }
    }

    if (cursorTs && cursorId) {
      where.OR = [
        { lastMessageAt: { lt: cursorTs } },
        { lastMessageAt: cursorTs, id: { lt: cursorId } },
      ]
    }

    const chats = await prisma.chat.findMany({
      where,
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      take: limit + 1, // +1 deteksi hasNext
      select: {
        id: true,
        waJid: true,
        contactName: true,
        contactPhone: true,
        status: true,
        unreadCount: true,
        lastMessageAt: true,
        lastMessagePreview: true,
        assignedToId: true,
        numberSlot: true,
        createdAt: true,
      },
    })
    const hasNext = chats.length > limit
    const page = hasNext ? chats.slice(0, limit) : chats

    let nextCursor = null
    if (hasNext && page.length > 0) {
      const last = page[page.length - 1]
      if (last.lastMessageAt) {
        nextCursor = `${new Date(last.lastMessageAt).getTime()}|${last.id}`
      }
    }

    // Preview tersimpan ciphertext → API plaintext (pola v0.11.0)
    for (const c of page) {
      if (c.lastMessagePreview != null) c.lastMessagePreview = decryptTextSafe(c.lastMessagePreview)
    }

    return res.json({ chats: page, nextCursor })
  } catch (e) {
    console.error('[APIv1] GET /chats error:', e)
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' })
  }
})

// Semua method/paths lain di bawah /api/v1 = 404 JSON konsisten (bukan HTML error)
router.use((req, res) => {
  res.status(404).json({ error: 'Endpoint tidak ditemukan', code: 'NOT_FOUND' })
})

module.exports = { router, requireApiKey, requireScope }