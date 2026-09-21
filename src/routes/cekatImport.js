// v0.15.0 — POST /api/cekat-import: tombol "Import dari Cekat.AI" (admin only)
//
// Flow: upload CSV export Cekat.AI (conversations_export_*.csv, delimiter ';',
// utf-8 ATAU cp1252) → parse → convert ke payload wa-cs-hub-history v1
// (aturan SAMA PERSIS dengan converter Python terbukti, lihat cekatConverter.js)
// → jalankan engine import yang sama dengan POST /api/history/import
// (src/services/historyImport.js, payload in-memory — TIDAK lewat HTTP loopback).
//
// ?dryRun=true|1 → convert + simulasi saja (tidak menulis apa pun ke DB).
//
// Idempotent by design: dedup key engine (chatId+timestamp+direction+
// senderName+content) skip pesan dobel — upload ulang file yang sama aman.
//
// Post-pass (non-dryRun): setiap Contact hasil import di-link ke Tag
// 'Import CekatAI' (ContactTag) — konsisten dengan import manual 2026-09-21
// (2.509 link), supaya kontak bisa difilter di database Kontak.
const express = require('express')
const router = express.Router()
const multer = require('multer')
const prisma = require('../prisma')
const { requireAuth, requireAdmin, requireTenant } = require('../auth')

// v3.0 — Isolasi tenant: import ke tenant req.user (super_admin wajib ?tenant=)
const rt = [requireAuth, requireTenant, requireAdmin]  // requireTenant dulu — super_admin wajib ?tenant= sebelum cek admin
const broadcast = require('../socket/broadcast')
const queue = require('../socket/queue')
const { parseCekatCsv } = require('../services/cekatCsv')
const {
  convertCekatRows,
  buildCekatPayload,
  IMPORT_TAG_NAME,
} = require('../services/cekatConverter')
const {
  runHistoryImport,
  buildUserMap,
} = require('../services/historyImport')

const MAX_CSV_ROWS = 20000 // guard: jangan biarkan file raksasa menggantung server

// Multer: .csv saja, maks 50MB, in-memory
const cekatUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
  fileFilter(req, file, cb) {
    const ok = /\.csv$/i.test(file.originalname || '') || String(file.mimetype || '').includes('csv')
    if (!ok) return cb(new Error('File harus .csv (export conversations dari Cekat.AI)'))
    cb(null, true)
  },
})

// ─── Post-pass: link Contact → Tag 'Import CekatAI' (ContactTag) ──────────
// Tag-nya pasti sudah ada — engine connectTags membuatnya di chat level.
// Idempotent: cek existing dulu (@@unique([contactId, tagId])). Error
// per-contact di-skip — jangan gagalkan keseluruhan import.

async function linkImportedContactsToTag(tenantId, chatIds, dryRun) {
  let linked = 0
  let skipped = 0
  if (!chatIds.length) return { linked, skipped }
  if (dryRun) return { linked, skipped }

  let tag
  try {
    // v3 — tag tenant-scoped (engine connectTags membuatnya per tenant)
    tag = await prisma.tag.findFirst({ where: { tenantId, name: IMPORT_TAG_NAME } })
  } catch (e) {
    console.error('Cekat import post-pass: gagal cari tag', e)
    return { linked, skipped }
  }
  if (!tag) return { linked, skipped } // tak terduga — engine selalu membuatnya; jangan gagalkan import

  for (const chatId of chatIds) {
    try {
      // chatId = Int Chat.id (v3) — contact linked by chatId Int, tenant-scoped
      const contact = await prisma.contact.findFirst({
        where: { tenantId, chatId },
        select: { id: true },
      })
      if (!contact) {
        skipped++
        continue
      }
      const existing = await prisma.contactTag.findUnique({
        where: { contactId_tagId: { contactId: contact.id, tagId: tag.id } },
        select: { id: true },
      })
      if (existing) {
        skipped++ // sudah ter-link (idempotent)
        continue
      }
      await prisma.contactTag.create({ data: { tenantId, contactId: contact.id, tagId: tag.id, source: 'manual' } })
      linked++
    } catch (e) {
      // P2002 (race unique constraint) pun di-skip — link sudah ada
      skipped++
    }
  }
  return { linked, skipped }
}

// ─── Route ───────────────────────────────────────────────────────────────

router.post(
  '/',
  requireAuth,
  requireTenant,
  requireAdmin,
  (req, res, next) => {
    cekatUpload.single('file')(req, res, (err) => {
      if (err) {
        const msg =
          err instanceof multer.MulterError
            ? err.code === 'LIMIT_FILE_SIZE'
              ? 'File terlalu besar (maksimal 50MB)'
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

      const dryRun = ['true', '1', 'yes'].includes(String(req.query.dryRun || '').toLowerCase())

      // ── Parse CSV (utf-8 strict → fallback windows-1252/latin1) ──
      const rows = parseCekatCsv(req.file.buffer)
      if (!rows.length) return res.status(400).json({ error: 'CSV kosong atau tidak bisa diparse (harus export conversations Cekat.AI, delimiter ";")' })
      if (rows.length > MAX_CSV_ROWS) {
        return res.status(400).json({ error: `File terlalu besar: ${rows.length} baris data (maksimal ${MAX_CSV_ROWS}). Pecah file export Cekat.AI per periode.` })
      }

      // ── Mapping user TENANT INI (match case-insensitive; tanpa bikin user baru) ──
      const { userMap, userMapLower } = await buildUserMap(prisma, req.tenantId)

      // ── Convert (aturan terbukti) ──
      const { chats, skipped } = convertCekatRows(rows, { userMapLower })
      if (!chats.length) {
        return res.status(400).json({
          error: 'Tidak ada baris WhatsApp yang bisa diimport dari file ini.',
          rowsTotal: rows.length,
          rowsSkipped: skipped,
        })
      }

      // ── Engine import yang sama dengan POST /api/history/import ──
      const payload = buildCekatPayload(chats)
      const result = await runHistoryImport(prisma, payload, userMap, dryRun, req.tenantId)

      // ── Post-pass ContactTag (hanya import beneran) ──
      const processedChatIds = []
      for (const chatEntry of payload.chats) {
        // chat diproses = created ATAU merged tanpa error fatal — cukup
        // jadikan kandidat; post-pass sendiri idempotent.
        processedChatIds.push(chatEntry.chatId)
      }
      const tagLink = await linkImportedContactsToTag(req.tenantId, processedChatIds, dryRun)

      // ── Emit (sama seperti history import: sekali di akhir) ──
      if (!dryRun && (result.chatsCreated > 0 || result.messagesAdded > 0)) {
        broadcast.emitToTenant(req.tenantId, 'history_imported', {
          chatsCreated: result.chatsCreated,
          messagesAdded: result.messagesAdded,
          chatsRestoredState: result.chatsRestoredState,
        })
        await queue.emitQueueUpdate(req.tenantId)
      }

      res.json({
        ...result,
        source: 'cekat',
        rowsTotal: rows.length,
        rowsSkipped: skipped,
        contactTagsLinked: tagLink.linked,
        contactTagsSkipped: tagLink.skipped,
      })
    } catch (e) {
      console.error('Cekat import error:', e)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
)

module.exports = router