// v0.15.0 — history.js jadi THIN routes.
// Engine import diekstrak ke src/services/historyImport.js (MECHANICAL MOVE —
// perilaku endpoint TIDAK berubah sedikitpun: request/response shape, dryRun,
// emit 'history_imported' + queue_update, semuanya sama).
const express = require('express')
const router = express.Router()
const multer = require('multer')
const prisma = require('../prisma')
const { requireAuth, requireAdmin, requireTenant } = require('../auth')

// v3.0 — Isolasi tenant: export scope tenant req.user (super_admin WAJIB ?tenant=);
// import masuk ke tenant req.user (super_admin wajib ?tenant=).
const plans = require('../services/plans') // v3.4 — feature gate Export/Import Riwayat (plan per-tenant)
const featHistoryExportGate = plans.requireFeature('featHistoryExport') // 403 ramah + upsell bila fitur OFF
const rt = [requireAuth, requireTenant, requireAdmin]  // requireTenant dulu — super_admin wajib ?tenant= sebelum cek admin
const broadcast = require('../socket/broadcast')
const queue = require('../socket/queue')
// v4.6.4-log (spec docs/spec-log-coverage-upgrade.md §B6) — breadcrumbs IMPORT-DONE/
// IMPORT-FAIL (best-effort; flood guard logInfo tetap jalan di service).
const sysLog = require('../services/systemLog')
const { decryptTextSafe } = require('../services/textCrypto')
const {
  HISTORY_FORMAT,
  HISTORY_VERSION,
  isoOrNull,
  relativeMediaPath,
  parseImportPayload,
  runHistoryImport,
  buildUserMap,
} = require('../services/historyImport')

// ─────────────────────────────────────────────────────────────────────────
// v0.6.0 — Backup & Restore history chat (admin only)
//
// Export (GET /api/history/export):
//   1 file JSON lengkap — chats (metadata + contact + tags + assignedToUsername)
//   + messages (metadata, timestamp asli, tanpa binary media) + users
//   (username + role, TANPA passwordHash).
//
// Import (POST /api/history/import):
//   APPEND + dedup. TIDAK ADA delete/update destruktif. Transaksi per-chat:
//   1 chat gagal → rollback chat itu saja, lanjut, error tercatat.
//   Update hanya pada field yang eksplisit diizinkan (contact field kosong).
//   JANGAN emit socket per-message — emit 'history_imported' sekali di akhir.
//
// Format file: { format: 'wa-cs-hub-history', version: 1, ... }
// Media binary TIDAK ikut (ada di data/media/) — hanya metadata-nya.
// ─────────────────────────────────────────────────────────────────────────

// Multer: .json saja, maks 200MB
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024, files: 1 },
  fileFilter(req, file, cb) {
    const ok = file.mimetype === 'application/json' || /\.json$/i.test(file.originalname || '')
    if (!ok) return cb(new Error('File harus .json (file backup WA CS Hub)'))
    cb(null, true)
  },
})

// ─── Helpers ─────────────────────────────────────────────────────────────

function pad2(n) {
  return String(n).padStart(2, '0')
}

// Nama file export: wa-cs-hub-history-YYYYMMDD-HHmmss.json (waktu server lokal)
// v0.6.1 — suffix rentang utk non-all: wa-cs-hub-history-7d-20260902-130600.json
function exportFilename(d, rangeKey) {
  const rangePart = rangeKey && rangeKey !== 'all' ? `${rangeKey}-` : ''
  return (
    `wa-cs-hub-history-${rangePart}` +
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}.json`
  )
}

// v0.6.1 — parse rentang export: all (default) | 3d | 7d | 30d | custom(from,to)
const RANGE_PRESETS = { '3d': 3, '7d': 7, '30d': 30 }
function parseRange(q) {
  const key = String(q.range || 'all').toLowerCase()
  if (RANGE_PRESETS[key]) {
    const from = new Date()
    from.setHours(0, 0, 0, 0)
    from.setDate(from.getDate() - (RANGE_PRESETS[key] - 1))
    return { key, from, to: null }
  }
  if (key === 'custom') {
    const rawFrom = String(q.from || '').trim()
    const rawTo = String(q.to || '').trim()
    let from = null
    let to = null
    if (/^\d{4}-\d{2}-\d{2}$/.test(rawFrom)) {
      const d = new Date(`${rawFrom}T00:00:00`)
      if (!isNaN(d.getTime())) from = d
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(rawTo)) {
      const d = new Date(`${rawTo}T23:59:59.999`)
      if (!isNaN(d.getTime())) to = d
    }
    if (!from && !to) return { key: 'all', from: null, to: null }
    if (from && to && from.getTime() > to.getTime()) return { error: 'Tanggal "dari" lebih besar dari "sampai"' }
    return { key: 'custom', from, to }
  }
  return { key: 'all', from: null, to: null }
}

// Chat dianggap dalam rentang kalau aktivitas terakhirnya (lastMessageAt, fallback createdAt) masuk window
function chatInRange(chat, range) {
  if (range.key === 'all') return true
  const raw = chat.lastMessageAt || chat.createdAt
  if (!raw) return true
  const t = new Date(raw).getTime()
  if (isNaN(t)) return true
  if (range.from && t < range.from.getTime()) return false
  if (range.to && t > range.to.getTime()) return false
  return true
}

// ─── Routes ──────────────────────────────────────────────────────────────

// GET /api/history/export — file JSON backup lengkap (admin)
router.get('/export', ...rt, featHistoryExportGate, async (req, res) => {
  try {
    // v0.6.1 — rentang waktu (all default; custom butuh minimal salah satu from/to)
    const range = parseRange(req.query)
    if (range.error) return res.status(400).json({ error: range.error })

    const [users, chats] = await Promise.all([
      prisma.user.findMany({ where: { tenantId: req.tenantId, role: { not: 'super_admin' } }, select: { username: true, role: true }, orderBy: { id: 'asc' } }),
      prisma.chat.findMany({
        where: { tenantId: req.tenantId },
        include: {
          assignedTo: { select: { username: true } },
          contact: true,
          tags: { include: { tag: true } },
          messages: {
            include: { sender: { select: { username: true } } },
            orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
    ])

    const payload = {
      format: HISTORY_FORMAT,
      version: HISTORY_VERSION,
      exportedAt: new Date().toISOString(),
      exportedBy: req.user.username,
      range: { key: range.key, from: isoOrNull(range.from), to: isoOrNull(range.to) },
      counts: {
        chats: chats.filter((c) => chatInRange(c, range)).length,
        messages: chats.filter((c) => chatInRange(c, range)).reduce((n, c) => n + c.messages.length, 0),
      },
      users, // username + role saja — TANPA passwordHash
      chats: chats.filter((c) => chatInRange(c, range)).map((c) => ({
        chatId: c.id,
        contactPhone: c.contactPhone,
        contactName: c.contactName,
        phoneJid: c.phoneJid,
        status: c.status,
        resolvedAt: isoOrNull(c.resolvedAt),
        createdAt: isoOrNull(c.createdAt),
        lastMessageAt: isoOrNull(c.lastMessageAt),
        assignedToUsername: c.assignedTo?.username || null,
        firstAssignedAt: isoOrNull(c.firstAssignedAt),
        lastAssignedAt: isoOrNull(c.lastAssignedAt),
        firstIncomingAt: isoOrNull(c.firstIncomingAt),
        firstResponseAt: isoOrNull(c.firstResponseAt),
        csMessagesSent: c.csMessagesSent,
        reopenedCount: c.reopenedCount,
        messagesBeforeResolve: c.messagesBeforeResolve,
        contact: c.contact
          ? {
              birthDate: isoOrNull(c.contact.birthDate),
              gender: c.contact.gender,
              city: c.contact.city,
              note: c.contact.note,
            }
          : null,
        tags: c.tags.map((ct) => ({ name: ct.tag.name, color: ct.tag.color })),
        messages: c.messages.map((m) => ({
          direction: m.direction,
          content: decryptTextSafe(m.content), // v0.11.0 — export tetap plaintext (dekrip on-the-fly)
          senderName: m.senderName,
          senderUsername: m.sender?.username || null,
          timestamp: isoOrNull(m.timestamp),
          status: m.status,
          waMessageId: m.waMessageId,
          purged: !!m.purged,
          mediaType: m.mediaType,
          mediaMime: m.mediaMime,
          mediaSize: m.mediaSize,
          mediaPath: relativeMediaPath(m.mediaPath),
          mediaUrl: null, // binary tidak ikut di v1
        })),
      })),
    }

    const filename = exportFilename(new Date(), range.key)
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`)
    res.send(JSON.stringify(payload))
  } catch (e) {
    console.error('History export error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/history/import — multipart file .json (admin). ?dryRun=true → preview saja.
router.post(
  '/import',
  requireAuth,
  requireTenant,
  requireAdmin,
  featHistoryExportGate,
  (req, res, next) => {
    importUpload.single('file')(req, res, (err) => {
      if (err) {
        const msg =
          err instanceof multer.MulterError
            ? err.code === 'LIMIT_FILE_SIZE'
              ? 'File terlalu besar (maksimal 200MB)'
              : `Upload gagal: ${err.code}`
            : err.message
        return res.status(400).json({ error: msg })
      }
      next()
    })
  },
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Tidak ada file yang diunggah (field "file")' })

      const { data, error } = parseImportPayload(req.file.buffer)
      if (error) {
        // v4.6.4-log §B6 (deviasi mikro utk memenuhi §E kasus 6 — lihat catatan:
        // parse-error TIDAK pernah menyentuh catch 500 karena return early di sini —
        // tanpa ini "import rusak" invisible) — IMPORT-FAIL warn + reason detail.
        try {
          sysLog.logWarn(`IMPORT-FAIL tenant=${req.tenantId} reason=${error}`, {
            module: 'chat', tenantId: req.tenantId,
          })
        } catch { /* best-effort */ }
        return res.status(400).json({ error })
      }

      const dryRun = ['true', '1', 'yes'].includes(String(req.query.dryRun || '').toLowerCase())

      // Mapping username → id berdasarkan user TENANT INI (jangan bikin user baru)
      const { userMap } = await buildUserMap(prisma, req.tenantId)

      // v3.4 — kuota kontak (spec §4): hitung chat NEW (kontak baru akan dibuat) vs sisa
      // kuota SEBELUM commit. Chat merged/restore-state tidak bikin kontak baru.
      const plans = require('../services/plans')
      const cekatQuota = await plans.checkContactQuota(req.tenantId)
      if (cekatQuota.max != null && !dryRun) {
        const existingWaJids = new Set(
          (await prisma.chat.findMany({ where: { tenantId: req.tenantId }, select: { waJid: true } })).map((c) => c.waJid)
        )
        let newChats = 0
        for (const chatEntry of data.chats || []) {
          const waJid = chatEntry.waJid ? String(chatEntry.waJid) : null
          if (waJid && !existingWaJids.has(waJid)) newChats++
        }
        if (cekatQuota.count + newChats > cekatQuota.max) {
          const sisa = Math.max(0, cekatQuota.max - cekatQuota.count)
          return res.status(403).json({
            error: `Kuota kontak tidak cukup: import ini akan membuat ${Number(newChats).toLocaleString('id-ID')} kontak baru, sisa kuota ${Number(sisa).toLocaleString('id-ID')} (${Number(cekatQuota.count).toLocaleString('id-ID')}/${Number(cekatQuota.max).toLocaleString('id-ID')}). Hubungi admin platform untuk upgrade paket.`,
          })
        }
      }

      const result = await runHistoryImport(prisma, data, userMap, dryRun, req.tenantId)

      // v4.6.4-log §B6 — breadcrumbs IMPORT-DONE: file asli TIDAK disimpan di log
      // (privacy) — hanya jumlah rows/chats + dryRun + error internal bila ada.
      try {
        sysLog.logInfo(
          `IMPORT-DONE file=backup.json rows=${result.messagesAdded} chats=${result.chatsCreated + result.chatsMerged} dryRun=${dryRun}${result.errors.length ? ` internalErrors=${result.errors.length}` : ''} tenant=${req.tenantId}`,
          { module: 'chat', tenantId: req.tenantId, meta: { rows: result.messagesAdded, chats: result.chatsCreated + result.chatsMerged, dryRun } },
        )
      } catch { /* best-effort */ }

      // Emit sekali di akhir — JANGAN per-message (anti-spam client)
      if (!dryRun && (result.chatsCreated > 0 || result.messagesAdded > 0)) {
        broadcast.emitToTenant(req.tenantId, 'history_imported', {
          chatsCreated: result.chatsCreated,
          messagesAdded: result.messagesAdded,
          chatsRestoredState: result.chatsRestoredState,
        })
        // v0.6.3 — shell revival mengubah assignment/status → antrean bisa berubah
        await queue.emitQueueUpdate(req.tenantId)
      }

      res.json(result)
    } catch (e) {
      // v4.6.4-log §B6 — breadcrumbs IMPORT-FAIL (SATU tempat di catch existing;
      // err.message tetap diteruskan ke stdout persis seperti sebelumnya)
      try {
        sysLog.logWarn(`IMPORT-FAIL tenant=${req.tenantId} reason=${e.message || 'unknown'}`, {
          module: 'chat', tenantId: req.tenantId, err: e,
        })
      } catch { /* best-effort */ }
      console.error('History import error:', e)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
)

module.exports = router