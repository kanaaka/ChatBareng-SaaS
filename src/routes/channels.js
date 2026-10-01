// ═══════════════════════════════════════════════════════════════════════
// v4.1.0 — Channels (WA Channel archive, read-only) — routes (spec §4).
// Mount /api/channels (server.js pola :168). ADMIN-ONLY (D5):
//   requireAuth + requireTenant + requireAdmin — pola routes/aiKnowledge.js.
//   super_admin wajib ?tenant= (requireTenant pola existing). CS tidak lihat.
// TANPA plan gate (D8 — archive-only, 0 cost LLM; semua tenant aktif otomatis).
//
// GET /                    → list archives {channels:[{id,name,waJid,numberSlot,postCount,lastPostAt,updatedAt}]}
// GET /:id/posts?limit=&before= → postingan terbaru dulu (cursor pagination)
//
// READ-ONLY TOTAL (D3): TIDAK ada POST/PUT/DELETE — arsip murni hasil auto-capture
// jalur @newsletter di pool.js. Media TIDAK di-serve dari sini (metadata saja; D6).
// ═══════════════════════════════════════════════════════════════════════
const express = require('express')
const router = express.Router()
const channelArchive = require('../services/channelArchive')
const { requireAuth, requireTenant, requireAdmin } = require('../auth')

const rt = [requireAuth, requireTenant, requireAdmin] // requireTenant dulu — super_admin wajib ?tenant=

// ── GET / — list archives milik tenant (read-only) ──
router.get('/', ...rt, async (req, res) => {
  try {
    const items = await channelArchive.listArchives(req.tenantId)
    res.json({ channels: items })
  } catch (e) {
    console.error('[Channels] GET error:', e?.message || e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /:id/posts — postingan channel (cursor, terbaru dulu) ──
// limit default 50 (cap 100); before = id terakhir halaman sebelumnya.
// Archive non-milik-tenant → null di service → 404 (isolasi ketat).
router.get('/:id/posts', ...rt, async (req, res) => {
  try {
    const limitRaw = parseInt(req.query.limit, 10)
    const beforeRaw = parseInt(req.query.before, 10)
    const limit = Number.isFinite(limitRaw) ? limitRaw : 50
    const before = Number.isFinite(beforeRaw) ? beforeRaw : null
    const result = await channelArchive.listPosts(req.tenantId, req.params.id, { limit, before })
    if (!result) return res.status(404).json({ error: 'Channel tidak ditemukan' })
    res.json(result)
  } catch (e) {
    console.error('[Channels] GET posts error:', e?.message || e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router