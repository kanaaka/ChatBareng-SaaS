// ═══════════════════════════════════════════════════════════════════
// v3.9.13 — Public API v1 router (spec docs/spec-api-keys-v1.md).
// v4.6.12 pending — API v1.1 additive (docs/SPEC-api-v1.1-additive.md):
// scopes baru choose_slot + assign_agent; param opsional numberSlot &
// assignTo di POST /messages; endpoint baru GET /users; response sukses
// selalu bawa chatState. Param tidak dikirim = byte-per-byte v1.0 (§5 lock).
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
// SystemLog: assign/reopen via API → logWarn/logInfo module 'api-keys' dgn
// meta {assignedToId, before, reopened} (§2.5 — ChatEvent tak punya kolom meta).
// ═══════════════════════════════════════════════════════════════════

const express = require('express')
const router = express.Router()
const prisma = require('../prisma')
const wa = require('../wa/pool')
const broadcast = require('../socket/broadcast')
const apiKeys = require('../services/apiKeys')
const systemLog = require('../services/systemLog')
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
// v3.9.13 — body { target, text, mediaPath? }
// - target nomor   : "0812…"/"62812…"/"+62812…" → 62…@s.whatsapp.net
// - target JID     : "<digits>@g.us" (grup) / "<digits>@s.whatsapp.net"
// - target nama    : nama grup EKSAK milik tenant (resolve dari Chat rows)
// WA off → 503 WA_BELUM_TERHUBUNG (konsisten dengan route CS lama).
//
// v4.6.12 pending (API v1.1, spec docs/SPEC-api-v1.1-additive.md §2) — ADDITIVE,
// param tidak dikirim = byte-per-byte v1.0:
// - `numberSlot` (opsional int 0..2): gate scope choose_slot (tanpa → 403
//   SCOPE_MISSING); invalid → 400 VALIDATION eksplisit (pattern v3.9.3 LOW-1,
//   bukan silent-fallback slot-0). Tidak dikirim → slot-0 (resolveTarget v1.0).
// - `assignTo` (opsional int userId agent): gate scope assign_agent (tanpa → 403
//   SCOPE_MISSING); gagal validasi → 400 VALIDATION. Tidak dikirim → behaviour
//   v1.0 penuh (assignment/status UNTOUCHED).
// Behaviour matrix (§2.3): belum-ada-chat/open-unassigned → create/tetap;
// open+assigned CS lain → TIDAK ditimpa (kirim saja + chatState catatan);
// resolved (+assignTo) → REOPEN DULU (open, resolvedAt null, reopenedCount+1,
// assignedToId=assignTo) BARU kirim — pesan masuk thread yang open.
// Sukses SELALU bawa `chatState` { chatId, status, numberSlot, assignedTo,
// reopened } (§2.4) + audit ChatEvent 'assigned_api' bila assign/reopen terjadi.
router.post('/messages', requireApiKey, requireScope('send'), async (req, res) => {
  // v4.6.12 pending (API v1.1 §2) — param opsional: scope gate LOUD 403
  // SCOPE_MISSING bila param dikirim tapi key tak punya scope-nya
  // (konsisten requireScope — tidak ada silent-ignore, §1 spec).
  const scopes = String(req.apiKey?.scopes || '').split(',').filter(Boolean)
  const body0 = req.body || {}
  if (body0.numberSlot !== undefined && body0.numberSlot !== null && !scopes.includes('choose_slot')) {
    return res.status(403).json({ error: 'Key tidak punya scope choose_slot', code: 'SCOPE_MISSING' })
  }
  if (body0.assignTo !== undefined && body0.assignTo !== null && !scopes.includes('assign_agent')) {
    return res.status(403).json({ error: 'Key tidak punya scope assign_agent', code: 'SCOPE_MISSING' })
  }

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

    // ═══ v4.6.12 pending (API v1.1 §2.1) — numberSlot: int 0..2 eksplisit ═══
    // Pattern v3.9.3 fix LOW-1 (contacts.js): invalid → 400 VALIDATION,
    // JANGAN silent-fallback ke slot-0. Tidak dikirim → slot-0 (resolveTarget
    // v1.0 tak berubah). Slot memilih chat terpisah per slot (v3.9.2 K1-A).
    const numberSlotRaw = body.numberSlot === undefined || body.numberSlot === null ? null : Number(body.numberSlot)
    const numberSlotInvalid =
      numberSlotRaw !== null && (!Number.isFinite(numberSlotRaw) || !Number.isInteger(numberSlotRaw) || numberSlotRaw < 0 || numberSlotRaw > 2)
    if (numberSlotInvalid) {
      return res.status(400).json({ error: 'numberSlot harus integer 0..2', code: 'VALIDATION' })
    }
    const numberSlot = numberSlotRaw === null ? 0 : Math.trunc(numberSlotRaw)

    // ═══ §2.2 — assignTo: userId agent tenant (validasi 400 di bawah) ═══
    const assignToRaw = body.assignTo === undefined || body.assignTo === null ? null : Number(body.assignTo)
    const assignToInvalid =
      assignToRaw !== null && (!Number.isFinite(assignToRaw) || !Number.isInteger(assignToRaw) || assignToRaw <= 0)
    if (assignToInvalid) {
      return res.status(400).json({ error: 'assignTo harus integer userId yang valid', code: 'VALIDATION' })
    }
    const assignToId = assignToRaw === null ? null : Math.trunc(assignToRaw)

    // ═══ §2.2 — validasi assignTo LOKAL ke tenant ini, role CS aktif, status active ═══
    // (List kandidat: endpoint baru GET /api/v1/users — spec §3.)
    let assignAgent = null
    if (assignToId !== null) {
      const agent = await prisma.user.findFirst({
        where: { id: assignToId, tenantId: tid, role: 'cs', status: 'active' },
        select: { id: true, username: true, name: true, role: true, tenantId: true, status: true },
      })
      if (!agent) {
        return res.status(400).json({
          error: 'assignTo tidak valid: user tidak ditemukan / bukan CS tenant ini / tidak aktif',
          code: 'VALIDATION',
        })
      }
      assignAgent = agent
    }

    // Resolve target → { jid, slot }
    // §2.1 — numberSlot dikirim (valid 0..2) → slot EKSPLISIT itu (chat terpisah per
    // slot, v3.9.2 K1-A): override target JID/nama-grup yang resolve ke slot lain.
    // Tidak dikirim → slot resolved by v1.0 (group-by-row / 0 untuk nomor/JID person).
    const resolved = await resolveTarget(tid, target)
    if (!resolved.ok) {
      return res.status(400).json({ error: resolved.error, code: 'VALIDATION' })
    }
    const explicitSlot = numberSlotRaw !== null
    const { jid } = resolved
    const slot = explicitSlot ? numberSlot : resolved.slot

    // ═══ §2.3 — behaviour matrix: assign/reopen bila assignTo dikirim ═══
    // TANPA assignTo → v1.0 penuh (chat dibuat/leave open+unassigned oleh
    // logApiEvent; existing-chat assignment & resolved status UNTOUCHED).
    // DENGAN assignTo → lihat tabel: belum-ada/open-unassigned → assign;
    // open+assigned CS lain → TIDAK ditimpa (§2.4: client baca response
    // chatState, bisa pilih slot lain); open+assigned=assignTo → no-op;
    // resolved → REOPEN DULU (open, resolvedAt null, reopenedCount+1,
    // assignedToId=assignTo) BARU kirim — pesan masuk thread yang open.
    // Semua assign/reopen di-audit sebagai ChatEvent 'assigned_api'
    // (source 'api', userId null, §2.5) SEBELUM pesan dikirim.
    let chatAfterAssign = null
    let reopened = false
    if (assignToId !== null) {
      const groupId = jid.endsWith('@g.us')
      let existing = await prisma.chat.findFirst({
        where: { tenantId: tid, waJid: jid, numberSlot: slot },
        orderBy: { id: 'asc' },
      })
      if (!existing && !groupId) {
        // v3.5 — fallback lookup dua arah (phoneJid → lidJid) biar thread
        // yang sama (bukan dobel) yang di-assign/reopen.
        existing =
          (await prisma.chat.findFirst({ where: { tenantId: tid, phoneJid: jid, numberSlot: slot }, orderBy: { id: 'asc' } })) ||
          (await prisma.chat.findFirst({ where: { tenantId: tid, lidJid: jid, numberSlot: slot }, orderBy: { id: 'asc' } })) ||
          null
      }
      if (existing) {
        if (existing.status === 'resolved') {
          // Resolved = chat bebas (keputusan 06:12) → selalu reopen + assign.
          // Urutan KONTRAK §2.3: reopen dulu, send kemudian (thread open).
          const updated = await prisma.chat.update({
            where: { id: existing.id },
            data: {
              status: 'open',
              resolvedAt: null,
              reopenedCount: (existing.reopenedCount || 0) + 1,
              assignedToId: assignToId,
              lastAssignedAt: new Date(),
              firstAssignedAt: existing.firstAssignedAt || new Date(),
              queuedAt: null,
            },
          })
          await prisma.chatEvent.create({
            data: {
              tenantId: tid,
              chatId: updated.id,
              // Audit trail §2.5 — metaJson bukan kolom ChatEvent di schema ini
              // (schema ChatEvent: id/tenantId/chatId/userId/type/source/createdAt),
              // meta kanaan jalan SystemLog (module 'api-keys') — spec §7.
              userId: null,
              type: 'assigned_api',
              source: 'api',
              createdAt: new Date(),
            },
          }).catch((e) => console.error('[APIv1] assigned_api event error (non-fatal):', e.message))
          systemLog.logInfo("[POST /api/v1/messages] resolved → reopen + assign", {
            tenantId: tid,
            module: 'api-keys',
            meta: { assignedToId: assignToId, before: existing.assignedToId || null, reopened: true, chatId: updated.id, jid, slot },
          })
          chatAfterAssign = updated
          reopened = true
        } else if (!existing.assignedToId) {
          // Open + unassigned → assign ke agent (keluar dari queue-eligible).
          const updated = await prisma.chat.update({
            where: { id: existing.id },
            data: { assignedToId: assignToId, lastAssignedAt: new Date(), queuedAt: null },
          })
          await prisma.chatEvent.create({
            data: { tenantId: tid, chatId: updated.id, userId: null, type: 'assigned_api', source: 'api', createdAt: new Date() },
          }).catch((e) => console.error('[APIv1] assigned_api event error (non-fatal):', e.message))
          broadcast.emitToTenant(tid, 'chat_update', { chatId: updated.id, assignedTo: { id: assignToId, username: assignAgent.username }, queuedAt: null })
          systemLog.logInfo("[POST /api/v1/messages] open+unassigned → assign", {
            tenantId: tid,
            module: 'api-keys',
            meta: { assignedToId: assignToId, before: null, reopened: false, chatId: updated.id, jid, slot },
          })
          chatAfterAssign = updated
        } else if (existing.assignedToId === assignToId) {
          // Open + assigned = assignTo → no-op (kirim normal).
          chatAfterAssign = existing
        } else {
          // Edge 1 (06:05): open + assigned CS LAIN → KIRIM SAJA, assignment
          // TIDAK ditimpa (breaking flow CS). Chat aktif = pekerjaan aktif CS itu;
          // client baca chatState di response + bisa pilih slot lain (assignTo
          // bekerja di sana karena chat per slot biasanya unassigned).
          chatAfterAssign = existing
          systemLog.logWarn("[POST /api/v1/messages] open+assigned CS lain → kirim tanpa menimpa", {
            tenantId: tid,
            module: 'api-keys',
            meta: { requestedAssignTo: assignToId, holderId: existing.assignedToId, chatId: existing.id, jid, slot },
          })
        }
      }
      // existing tak ada → belum-ada chat/kontak baru: dibuat open+assigned
      // oleh pre-send CREATE di bawah (matrix row 1 col 2).
    }

    // ═══ §2.3 matrix row 1 col 2 — belum-ada chat + assignTo → CREATE OPEN+ASSIGNED ═══
    // Pre-send deterministik: chat born-assigned SEBELUM pengiriman (tidak
    // mengandalkan efek samping logApiEvent post-send). Tanpa assignTo = jalur
    // v1.0 penuh (logApiEvent yang membuat born-API unassigned, tak diubah).
    let chatBeforeSend = null
    if (assignToId !== null && !chatAfterAssign && !jid.endsWith('@g.us')) {
      chatBeforeSend = await prisma.chat.findFirst({
        where: { tenantId: tid, waJid: jid, numberSlot: slot },
        orderBy: { id: 'asc' },
      })
      if (!chatBeforeSend) {
        try {
          const digits = jid.split('@')[0]
          chatBeforeSend = await prisma.chat.create({
            data: {
              tenantId: tid,
              waJid: jid,
              contactPhone: digits,
              phoneJid: jid,
              numberSlot: slot,
              status: 'open',
              assignedToId: assignToId,
              lastAssignedAt: new Date(),
              firstAssignedAt: new Date(),
              queuedAt: null,
            },
          })
          await prisma.chatEvent.create({
            data: { tenantId: tid, chatId: chatBeforeSend.id, userId: null, type: 'assigned_api', source: 'api', createdAt: new Date() },
          }).catch((e) => console.error('[APIv1] assigned_api event error (non-fatal):', e.message))
          broadcast.emitToTenant(tid, 'chat_update', { chatId: chatBeforeSend.id, newChat: true, assignedTo: { id: assignToId, username: assignAgent.username } })
          systemLog.logInfo('[POST /api/v1/messages] kontak baru → create open+assigned', {
            tenantId: tid,
            module: 'api-keys',
            meta: { assignedToId: assignToId, before: null, reopened: false, chatId: chatBeforeSend.id, jid, slot },
          })
        } catch (e) {
          if (e?.code === 'P2002') {
            chatBeforeSend = await prisma.chat.findFirst({ where: { tenantId: tid, waJid: jid, numberSlot: slot }, orderBy: { id: 'asc' } })
          } else throw e
        }
      }
    }

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

    // ═══ §2.4 — chatState SELALU ada pada sukses (v1.1). assignedTo = holder
    // AKTUAL SETELAH send (bukan hanya assignTo yang diminta) — Edge 1:
    // client menampilkan catatan "chat lagi di-handle CS X" bila beda. Chat
    // belum ada di DB (grup/API-pertama tanpa assignTo) → chatId = null.
    const stateChat = chatAfterAssign || chatBeforeSend
    let assignedHolder = null
    if (stateChat?.assignedToId) {
      if (assignAgent && stateChat.assignedToId === assignAgent.id) {
        assignedHolder = { id: stateChat.assignedToId, username: assignAgent.username }
      } else {
        // Holder bukan assignTo (Edge 1: open+assigned CS lain) — resolve
        // username aktual (kolom minimal, tanpa email/hash).
        const holder = await prisma.user
          .findUnique({ where: { id: stateChat.assignedToId }, select: { id: true, username: true } })
          .catch(() => null)
        assignedHolder = holder ? { id: holder.id, username: holder.username } : { id: stateChat.assignedToId, username: null }
      }
    }
    const chatState = stateChat
      ? {
          chatId: stateChat.id,
          status: stateChat.status || 'open',
          numberSlot: Number(stateChat.numberSlot) || 0,
          assignedTo: assignedHolder,
          reopened: Boolean(reopened),
        }
      : { chatId: null, status: null, numberSlot: slot, assignedTo: null, reopened: false }

    return res.status(200).json({ ok: true, ...(dbMsgId ? { waMessageId: dbMsgId } : {}), chatState })
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

// ─── GET /api/v1/users (scope assign_agent) — kandidat assignTo ────────
// v4.6.12 pending (API v1.1 §3): list user tenant INI saja, role CS/admin
// yang akunnya aktif — kolom minimal { id, username, name, role }, TANPA
// email/phone/hash. Gate assign_agent (bukan read — key yang bisa assign
// harus bisa milih agent, meski tak punya scope read). Paginasi sederhana
// limit/offset (pattern /chats).
router.get('/users', requireApiKey, requireScope('assign_agent'), async (req, res) => {
  try {
    const tid = req.tenantId
    // Paginasi sederhana: limit 1..100 (default 100), offset >= 0 (default 0).
    const limitRaw = parseInt(req.query.limit || '100', 10)
    const offsetRaw = parseInt(req.query.offset || '0', 10)
    const limit = Math.max(1, Math.min(100, Number.isFinite(limitRaw) ? limitRaw : 100))
    const offset = Math.max(0, Number.isFinite(offsetRaw) ? offsetRaw : 0)

    const users = await prisma.user.findMany({
      where: { tenantId: tid, role: { in: ['cs', 'admin'] }, status: 'active' },
      orderBy: [{ id: 'asc' }],
      skip: offset,
      take: limit,
      select: { id: true, username: true, name: true, role: true },
    })
    return res.status(200).json({ users })
  } catch (e) {
    console.error('[APIv1] GET /users error:', e)
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' })
  }
})

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