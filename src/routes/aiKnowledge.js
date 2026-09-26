// ═════════════════════════════════════════════════════════════════
// v4.0.0 — ChatBareng AI (CB-AI) Knowledge API — NEW (spec §8).
// Mount /api/ai-knowledge (server.js pola :168). admin + SA ?tenant= (requireTenant).
//
// GET    /              → list docs + aiUsage bulan WIB + config {cbaiLimit, cbaiInfoFooter}
// POST   /upload        → multer memory (pola blast.js:17), 5MB, whitelist txt/md/csv/docx/xlsx,
//                         label wajib; label sama = upsert REPLACE (D1); body.docId → replace itu
// POST   /compose       → {label, content} composer (warga kelas satu, D1)
// POST   /trial         → {question} jalur answerFromKnowledge identik, TANPA Chat/counter;
//                         metering tetap log (chatId null); plan ✗ → 403 upsell; GAK kirim WA (D11)
// PUT    /:id/content   → composer edit inline (sourceType composer ATAU file — content replace)
// PUT    /:id/active    → {active: bool}
// DELETE /:id
// PUT    /config        → {cbaiLimit 1..10 int strict, cbaiInfoFooter bool strict} → 400 liar
//
// Konvensi pola: routes/autoreply.js (requireAuth+requireTenant+requireAdmin, validate-first,
// 400 {error}, 500 internal). Field asing DITOLAK (400) — ketat.
// ═════════════════════════════════════════════════════════════════
const express = require('express')
const router = express.Router()
const multer = require('multer')
const prisma = require('../prisma')
const { requireAuth, requireAdmin, requireTenant } = require('../auth')
const plans = require('../services/plans')
const featAiKnowledgeGate = plans.requireFeature('featAiKnowledge') // 403 ramah + upsell bila fitur OFF
const aiKnowledge = require('../services/aiKnowledge')

const rt = [requireAuth, requireTenant, requireAdmin] // requireTenant dulu — super_admin wajib ?tenant=
const LABEL_MAX = 100

// multer memoryStorage pola blast.js:17 — 5 MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
})

// ── GET / — list + usage + config (mirror GET menu-gateway aiUsage pattern) ──
// wibMonthStartUtc FIX v3.9.25 (audit MEDIUM-A): 00:00 WIB = 17:00 UTC hari sebelumnya.
function wibMonthStartUtc(now = new Date()) {
  const ym = new Date(now.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 7) // ym dalam WIB
  return new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1, -7)) // 00:00 WIB = 17:00 UTC sebelumnya
}
async function aiUsageForTenant(tenantId) {
  try {
    const since = wibMonthStartUtc()
    const agg = await prisma.aiUsageLog.aggregate({
      where: { tenantId, source: 'knowledge', createdAt: { gte: since } },
      _count: { id: true },
      _sum: { costUsd: true },
    })
    const calls = Number(agg._count?.id) || 0
    const costUsd = Number(agg._sum?.costUsd) || 0
    const cfg = await prisma.aiConfig.findUnique({ where: { id: 1 }, select: { usdToIdr: true } })
    const rate = Number(cfg?.usdToIdr)
    const usdToIdr = Number.isFinite(rate) && rate > 0 ? rate : 16000
    return { calls, costUsd, costRp: Math.round(costUsd * usdToIdr), usdToIdr }
  } catch (e) {
    console.error('[AiKnowledge] aiUsageForTenant error (non-fatal):', e.message)
    return { calls: 0, costUsd: 0, costRp: 0, usdToIdr: 16000 }
  }
}

router.get('/', ...rt, featAiKnowledgeGate, async (req, res) => {
  try {
    const tid = req.tenantId
    const docs = await prisma.aiKnowledgeDoc.findMany({
      where: { tenantId: tid },
      select: { id: true, label: true, sourceType: true, fileName: true, charCount: true, active: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    })
    const cfg = await prisma.autoReplyConfig.findFirst({
      where: { tenantId: tid, numberSlot: null },
      select: { cbaiLimit: true, cbaiInfoFooter: true, outsideHoursMode: true, greetMode: true },
    })
    // plan ✗ → 403 by gate; aiUsage selalu diisi (fitur sudah terbuka di sini)
    res.json({
      docs,
      aiUsage: await aiUsageForTenant(tid),
      config: {
        cbaiLimit: cfg?.cbaiLimit ?? 3,
        cbaiInfoFooter: cfg?.cbaiInfoFooter !== false,
        outsideHoursMode: cfg?.outsideHoursMode || 'text',
        greetMode: cfg?.greetMode || 'text',
      },
    })
  } catch (e) {
    console.error('AiKnowledge GET error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── POST /upload — file (multipart) — label wajib; dup-label = replace (D1) ──
router.post('/upload', ...rt, featAiKnowledgeGate, upload.single('file'), async (req, res) => {
  try {
    const tid = req.tenantId
    const label = String(req.body?.label || '').trim()
    if (!label) return res.status(400).json({ error: 'Label wajib diisi (mis. "Pricelist", "Jam Buka")' })
    if (label.length > LABEL_MAX) return res.status(400).json({ error: `Label maksimal ${LABEL_MAX} karakter` })
    if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
      return res.status(400).json({ error: 'File wajib diunggah (field "file")' })
    }
    const reject = aiKnowledge.rejectUploadReason(req.file.mimetype, req.file.originalname)
    if (reject) return res.status(400).json({ error: reject })
    let parsed
    try {
      parsed = await aiKnowledge.parseUpload(req.file.buffer, req.file.mimetype, req.file.originalname)
    } catch (pe) {
      return res.status(400).json({ error: pe.message || 'Gagal membaca file' })
    }
    if (!parsed.text.trim()) return res.status(400).json({ error: 'File tidak berisi teks yang bisa dibaca' })

    // Optional body.docId → replace doc itu (HARUS label-nya sama dgn doc target — anti salah timpa)
    let docId = null
    if (req.body?.docId !== undefined && req.body?.docId !== null && String(req.body.docId).trim() !== '') {
      docId = parseInt(String(req.body.docId), 10)
      if (!Number.isFinite(docId)) return res.status(400).json({ error: 'docId tidak valid' })
      const target = await prisma.aiKnowledgeDoc.findFirst({ where: { id: docId, tenantId: tid } })
      if (!target) return res.status(404).json({ error: 'Dokumen tidak ditemukan' })
      if (target.label !== label) {
        return res.status(400).json({ error: 'Label harus sama dengan dokumen yang direplace (re-upload = replace)' })
      }
    }

    // Upsert replace: label sama = content/fileName/charCount/updatedAt naik (D1)
    const where = docId ? { id: docId } : { tenantId_label: { tenantId: tid, label } }
    const existing = docId
      ? await prisma.aiKnowledgeDoc.findFirst({ where: { id: docId, tenantId: tid } })
      : await prisma.aiKnowledgeDoc.findUnique({ where: { tenantId_label: { tenantId: tid, label } } })
    const data = {
      label,
      content: parsed.text,
      fileName: req.file.originalname,
      sourceType: 'file',
      charCount: parsed.text.length,
      updatedById: req.user.id,
    }
    let doc
    if (existing) {
      doc = await prisma.aiKnowledgeDoc.update({ where: { id: existing.id }, data })
    } else {
      doc = await prisma.aiKnowledgeDoc.create({ data: { tenantId: tid, ...data } })
    }
    res.json({ doc: { ...doc, truncated: parsed.truncated }, replaced: !!existing })
  } catch (e) {
    if (e?.code === 'P2002') return res.status(400).json({ error: 'Label sudah dipakai dokumen lain' })
    console.error('AiKnowledge upload error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── POST /compose — composer tulis manual (warga kelas satu, D1) ──
router.post('/compose', ...rt, featAiKnowledgeGate, async (req, res) => {
  try {
    const tid = req.tenantId
    const body = req.body || {}
    for (const key of Object.keys(body)) {
      if (!['label', 'content'].includes(key)) return res.status(400).json({ error: `Field tidak dikenal: ${key}` })
    }
    const label = String(body.label || '').trim()
    if (!label) return res.status(400).json({ error: 'Label wajib diisi' })
    if (label.length > LABEL_MAX) return res.status(400).json({ error: `Label maksimal ${LABEL_MAX} karakter` })
    const composed = aiKnowledge.composeContent(body.content)
    if (!composed.text.trim()) return res.status(400).json({ error: 'Isi dokumen wajib diisi' })
    const existing = await prisma.aiKnowledgeDoc.findUnique({ where: { tenantId_label: { tenantId: tid, label } } })
    let doc
    if (existing) {
      doc = await prisma.aiKnowledgeDoc.update({
        where: { id: existing.id },
        data: { content: composed.text, sourceType: 'composer', fileName: null, charCount: composed.text.length, updatedById: req.user.id },
      })
    } else {
      doc = await prisma.aiKnowledgeDoc.create({
        data: { tenantId: tid, label, content: composed.text, sourceType: 'composer', fileName: null, charCount: composed.text.length, updatedById: req.user.id },
      })
    }
    res.json({ doc: { ...doc, truncated: composed.truncated }, replaced: !!existing })
  } catch (e) {
    console.error('AiKnowledge compose error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── POST /trial — 🧪 chatbox trial (D11): jalur identik, TANPA Chat/counter; plan ✗ → 403 ──
router.post('/trial', ...rt, featAiKnowledgeGate, async (req, res) => {
  try {
    const tid = req.tenantId
    const body = req.body || {}
    for (const key of Object.keys(body)) {
      if (!['question'].includes(key)) return res.status(400).json({ error: `Field tidak dikenal: ${key}` })
    }
    const question = String(body.question || '').trim()
    if (!question) return res.status(400).json({ error: 'Pertanyaan wajib diisi' })
    if (question.length > 1000) return res.status(400).json({ error: 'Pertanyaan maksimal 1000 karakter' })
    const cfg = await prisma.autoReplyConfig.findFirst({ where: { tenantId: tid, numberSlot: null }, select: { cbaiInfoFooter: true } })
    const r = await aiKnowledge.answerFromKnowledge({
      tenantId: tid,
      chat: null, // TIDAK ada Chat → counter tidak nambah, chatId metering null
      customerText: question,
      mode: 'trial',
      cbaiInfoFooter: cfg?.cbaiInfoFooter !== false,
    })
    if (!r.ok) {
      const map = {
        PLAN_OFF: { status: 403, error: 'ChatBareng AI tidak tersedia di paket Anda. Hubungi admin platform untuk upgrade.' },
        NO_CONFIG: { status: 503, error: 'AI belum dikonfigurasi. Hubungi admin platform.' },
        NO_KB: { status: 400, error: 'Belum ada dokumen aktif — upload atau tulis dokumen dulu.' },
      }
      const m = map[r.code] || { status: 500, error: 'Internal server error' }
      return res.status(m.status).json({ error: m.error, code: r.code })
    }
    // TIDAK PERNAH kirim WA dari jalur trial (chat=null — tidak ada jalur kirim di sini)
    res.json({ covered: r.covered, answer: r.answer || null, code: r.code || null })
  } catch (e) {
    console.error('AiKnowledge trial error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /:id — detail dokumen (isi content penuh utk preview parse drawer) ──
router.get('/:id', ...rt, featAiKnowledgeGate, async (req, res) => {
  try {
    const tid = req.tenantId
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id tidak valid' })
    const doc = await prisma.aiKnowledgeDoc.findFirst({
      where: { id, tenantId: tid },
      select: { id: true, label: true, sourceType: true, fileName: true, content: true, charCount: true, active: true, updatedAt: true },
    })
    if (!doc) return res.status(404).json({ error: 'Dokumen tidak ditemukan' })
    res.json({ doc: { ...doc, truncated: (doc.charCount || 0) >= 100000 } })
  } catch (e) {
    console.error('AiKnowledge GET :id error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── PUT /config — cbaiLimit 1..10 int STRICT + cbaiInfoFooter bool STRICT (§8) ──
router.put('/config', ...rt, featAiKnowledgeGate, async (req, res) => {
  try {
    const body = req.body || {}
    for (const key of Object.keys(body)) {
      if (!['cbaiLimit', 'cbaiInfoFooter'].includes(key)) return res.status(400).json({ error: `Field tidak dikenal: ${key}` })
    }
    if (Object.keys(body).length === 0) return res.status(400).json({ error: 'Tidak ada field yang valid untuk diupdate' })
    const data = {}
    if (body.cbaiLimit !== undefined) {
      if (!Number.isInteger(body.cbaiLimit) || body.cbaiLimit < aiKnowledge.CBAI_LIMIT_MIN || body.cbaiLimit > aiKnowledge.CBAI_LIMIT_MAX) {
        return res.status(400).json({ error: `cbaiLimit harus integer ${aiKnowledge.CBAI_LIMIT_MIN}..${aiKnowledge.CBAI_LIMIT_MAX}` })
      }
      data.cbaiLimit = body.cbaiLimit
    }
    if (body.cbaiInfoFooter !== undefined) {
      if (typeof body.cbaiInfoFooter !== 'boolean') return res.status(400).json({ error: 'cbaiInfoFooter harus boolean' })
      data.cbaiInfoFooter = body.cbaiInfoFooter
    }
    // Prisma menolak compound unique dgn NULL (lesson v3.9 fix BUG-1) → findFirst +
    // create-catch-race (pola getConfig autoReply), BUKAN upsert tenantId_numberSlot:null.
    const existing = await prisma.autoReplyConfig.findFirst({ where: { tenantId: req.tenantId, numberSlot: null }, select: { id: true } })
    const cfg = existing
      ? await prisma.autoReplyConfig.update({ where: { id: existing.id }, data: { ...data, updatedById: req.user.id } })
      : await prisma.autoReplyConfig.create({ data: { tenantId: req.tenantId, numberSlot: null, ...data, updatedById: req.user.id } }).catch(async (e) => {
          if (e.code === 'P2002') {
            const again = await prisma.autoReplyConfig.findFirst({ where: { tenantId: req.tenantId, numberSlot: null }, select: { id: true } })
            return prisma.autoReplyConfig.update({ where: { id: again.id }, data: { ...data, updatedById: req.user.id } })
          }
          throw e
        })
    // invalidate cache service autoReply (config dibaca runtime via cache)
    require('../services/autoReply').invalidateConfig(req.tenantId)
    res.json({ config: { cbaiLimit: cfg.cbaiLimit, cbaiInfoFooter: cfg.cbaiInfoFooter } })
  } catch (e) {
    console.error('AiKnowledge PUT config error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── PUT /:id/content — composer edit inline (timestamp naik — D1) ──
router.put('/:id/content', ...rt, featAiKnowledgeGate, async (req, res) => {
  try {
    const tid = req.tenantId
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id tidak valid' })
    const body = req.body || {}
    for (const key of Object.keys(body)) {
      if (!['content'].includes(key)) return res.status(400).json({ error: `Field tidak dikenal: ${key}` })
    }
    const composed = aiKnowledge.composeContent(body.content)
    if (!composed.text.trim()) return res.status(400).json({ error: 'Isi dokumen wajib diisi' })
    const doc = await prisma.aiKnowledgeDoc.findFirst({ where: { id, tenantId: tid } })
    if (!doc) return res.status(404).json({ error: 'Dokumen tidak ditemukan' })
    // Fix audit NIT-3 — edit inline HANYA composer (file → re-upload dgn label sama = replace)
    if (doc.sourceType !== 'composer') return res.status(400).json({ error: 'Dokumen dari file di-update lewat upload ulang (label sama = replace), bukan edit inline.' })
    const updated = await prisma.aiKnowledgeDoc.update({
      where: { id: doc.id },
      data: { content: composed.text, charCount: composed.text.length, updatedById: req.user.id },
    })
    res.json({ doc: { ...updated, truncated: composed.truncated } })
  } catch (e) {
    console.error('AiKnowledge PUT content error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── PUT /:id/active — toggle aktif doc ──
router.put('/:id/active', ...rt, featAiKnowledgeGate, async (req, res) => {
  try {
    const tid = req.tenantId
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id tidak valid' })
    const body = req.body || {}
    if (body.active === undefined || typeof body.active !== 'boolean') {
      return res.status(400).json({ error: 'active wajib boolean' })
    }
    const doc = await prisma.aiKnowledgeDoc.findFirst({ where: { id, tenantId: tid } })
    if (!doc) return res.status(404).json({ error: 'Dokumen tidak ditemukan' })
    const updated = await prisma.aiKnowledgeDoc.update({ where: { id: doc.id }, data: { active: body.active, updatedById: req.user.id } })
    res.json({ doc: { id: updated.id, active: updated.active } })
  } catch (e) {
    console.error('AiKnowledge PUT active error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── DELETE /:id ──
router.delete('/:id', ...rt, featAiKnowledgeGate, async (req, res) => {
  try {
    const tid = req.tenantId
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id tidak valid' })
    const doc = await prisma.aiKnowledgeDoc.findFirst({ where: { id, tenantId: tid } })
    if (!doc) return res.status(404).json({ error: 'Dokumen tidak ditemukan' })
    await prisma.aiKnowledgeDoc.delete({ where: { id: doc.id } })
    res.json({ ok: true })
  } catch (e) {
    console.error('AiKnowledge DELETE error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router