const express = require('express')
const router = express.Router()
const multer = require('multer')
const prisma = require('../prisma')
const { requireAuth, requireAdmin, requireTenant } = require('../auth')

// v3.0 — Isolasi tenant: template = tenant-scoped (unique [tenantId,name/keyword])
const rt = [requireAuth, requireTenant]
const broadcast = require('../socket/broadcast')

// ─────────────────────────────────────────────────────────────────────────
// v0.15.1 — Export & Import templates (portabilitas antar-deploy, admin only)
//
// Export (GET /api/templates/export):
//   1 file JSON — SEMUA template (name, keyword, content, category).
//   Filename: chatbareng-templates-YYYYMMDD-HHmm.json.
//
// Import (POST /api/templates/import):
//   Sifatnya AMAN — tidak ada delete/update. keyword sudah ada → skip
//   (existing menang); name sudah ada → auto-rename "(import)", "(import2)", …;
//   duplikat keyword di dalam file → entry kedua skip; entry invalid →
//   errors[] (import tidak gagalkan sisanya).
//   ?dryRun=true|1 → hitung hasil tanpa menulis DB, tanpa emit.
//   Emit 'template_update' {action:'imported'} SEKALI setelah import sukses.
//
// Pure functions (normalizeTemplateEntry, mergeDecision, buildExportPayload)
// diekstrak + di-export via module.exports agar bisa unit-test OFFLINE
// (tanpa Prisma/DB). Normalisasi & merge TIDAK menyentuh Prisma.
// ─────────────────────────────────────────────────────────────────────────

const TEMPLATES_FORMAT = 'wa-cs-hub-templates'
const TEMPLATES_VERSION = 1
const IMPORT_MAX_ENTRIES = 1000

// Multer: .json saja, memory storage, maks 5MB
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter(req, file, cb) {
    const ok = file.mimetype === 'application/json' || /\.json$/i.test(file.originalname || '')
    if (!ok) return cb(new Error('File harus .json (file export template WA CS Hub)'))
    cb(null, true)
  },
})

// ─── Helpers (pure — tidak nyentuh Prisma) ───────────────────────────────

function pad2(n) {
  return String(n).padStart(2, '0')
}

// Nama file export: chatbareng-templates-YYYYMMDD-HHmm.json (waktu server lokal)
function exportFilename(d) {
  return (
    `chatbareng-templates-` +
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `-${pad2(d.getHours())}${pad2(d.getMinutes())}.json`
  )
}

// Validasi payload import: {format, version, templates[]}
// → {data} | {error}
function parseImportPayload(buffer) {
  let parsed
  try {
    parsed = JSON.parse(buffer.toString('utf8'))
  } catch {
    return { error: 'File bukan JSON yang valid' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'Struktur file tidak dikenal (harus object)' }
  }
  if (parsed.format !== TEMPLATES_FORMAT) {
    return { error: `Format file tidak dikenal (harus "${TEMPLATES_FORMAT}")` }
  }
  if (parsed.version !== TEMPLATES_VERSION) {
    return { error: `Versi file tidak didukung (didapat v${parsed.version}, didukung v${TEMPLATES_VERSION})` }
  }
  if (!Array.isArray(parsed.templates)) {
    return { error: 'Field "templates" harus berupa array' }
  }
  if (parsed.templates.length > IMPORT_MAX_ENTRIES) {
    return { error: `Terlalu banyak template (maksimal ${IMPORT_MAX_ENTRIES} per file)` }
  }
  return { data: parsed }
}

/**
 * v0.15.1 — Normalisasi & validasi 1 entry template mentah dari file import.
 * Pure — TIDAK menyentuh Prisma. → {entry} | {error: reason}
 *  - name kosong → error 'name kosong'
 *  - keyword: trim + lowercase + buang whitespace, auto-prepend '/', hasil
 *    '/' sendirian → error 'keyword tidak valid'
 *  - content kosong/whitespace → error 'content kosong' (trim hanya untuk
 *    cek — content disimpan apa adanya)
 *  - category kosong → 'umum'
 */
function normalizeTemplateEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'entry bukan object' }
  }

  if (typeof raw.name !== 'string' || !raw.name.trim()) {
    return { error: 'name kosong' }
  }

  if (typeof raw.keyword !== 'string') {
    return { error: 'keyword tidak valid' }
  }
  let keyword = raw.keyword.trim().toLowerCase().replace(/\s+/g, '')
  if (keyword && !keyword.startsWith('/')) keyword = '/' + keyword
  if (!keyword || keyword === '/') {
    return { error: 'keyword tidak valid' }
  }

  if (typeof raw.content !== 'string' || !raw.content.trim()) {
    return { error: 'content kosong' }
  }

  const category = (typeof raw.category === 'string' && raw.category.trim()) || 'umum'

  return {
    entry: {
      name: raw.name.trim(),
      keyword,
      content: raw.content, // disimpan apa adanya (trim hanya untuk cek)
      category,
    },
  }
}

/**
 * v0.15.1 — Keputusan merge utk 1 entry yang sudah dinormalisasi.
 * Pure — TIDAK menyentuh Prisma.
 *  - keyword sudah ada di DB → 'skip-keyword' (existing menang)
 *  - keyword di-claim entry sebelumnya dalam file → 'skip-keyword'
 *  - name sudah ada (atau di-claim file) → 'rename' → `${name} (import)`,
 *    `(import2)`, dst sampai unik
 *  - selainnya → 'create'
 */
function mergeDecision(entry, existingKeywords, existingNames, claimedInFile) {
  if (existingKeywords.has(entry.keyword) || claimedInFile.has(entry.keyword)) {
    return 'skip-keyword'
  }
  if (existingNames.has(entry.name) || claimedInFile.has(entry.name)) {
    let i = 1
    let candidate = `${entry.name} (import)`
    while (existingNames.has(candidate) || claimedInFile.has(candidate)) {
      i += 1
      candidate = `${entry.name} (import${i})`
    }
    return { decision: 'rename', name: candidate }
  }
  return 'create'
}

/**
 * v0.15.1 — Bentuk payload export (pure — mudah di-test round-trip).
 */
function buildExportPayload(templates, meta) {
  return {
    format: TEMPLATES_FORMAT,
    version: TEMPLATES_VERSION,
    exportedAt: (meta && meta.exportedAt) || new Date().toISOString(),
    exportedBy: (meta && meta.exportedBy) || null,
    counts: { templates: templates.length },
    templates: templates.map((t) => ({
      name: t.name,
      keyword: t.keyword,
      content: t.content,
      category: t.category,
    })),
  }
}


// GET /api/templates — list all templates (any authenticated user)
router.get('/', ...rt, async (req, res) => {
  try {
    const templates = await prisma.messageTemplate.findMany({
      where: { tenantId: req.tenantId },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    })
    res.json({ templates })
  } catch (e) {
    console.error('List templates error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/templates — create template (admin only)
router.post('/', ...rt, requireAdmin, async (req, res) => {
  try {
    let { name, keyword, content, category } = req.body

    // Validation
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Name is required' })
    }
    if (!keyword || !keyword.trim()) {
      return res.status(400).json({ error: 'Keyword is required' })
    }
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Content is required' })
    }

    // Auto-prepend "/" if missing
    if (!keyword.startsWith('/')) {
      keyword = '/' + keyword
    }

    // Validate keyword format (only lowercase letters, numbers, no spaces after /)
    const keywordClean = keyword.replace(/\s+/g, '')
    if (keywordClean !== keyword) {
      return res.status(400).json({ error: 'Keyword must not contain spaces' })
    }

    // Check uniqueness — keyword
    const existingKeyword = await prisma.messageTemplate.findFirst({ where: { tenantId: req.tenantId, keyword } })
    if (existingKeyword) {
      return res.status(409).json({ error: 'Keyword already exists', field: 'keyword' })
    }

    // Check uniqueness — name
    const existingName = await prisma.messageTemplate.findFirst({ where: { tenantId: req.tenantId, name: name.trim() } })
    if (existingName) {
      return res.status(409).json({ error: 'Name already exists', field: 'name' })
    }

    const template = await prisma.messageTemplate.create({
      data: {
        tenantId: req.tenantId,
        name: name.trim(),
        keyword,
        content: content.trim(),
        category: category?.trim() || 'umum',
        createdBy: req.user.id,
      },
    })

    broadcast.emitToTenant(req.tenantId, 'template_update', { action: 'created', template })

    res.status(201).json({ template })
  } catch (e) {
    console.error('Create template error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/templates/:id — update template (admin only)
router.put('/:id', ...rt, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid template ID' })
    }

    let { name, keyword, content, category } = req.body

    // Check template exists (tenant-scoped)
    const existing = await prisma.messageTemplate.findFirst({ where: { id, tenantId: req.tenantId } })
    if (!existing) {
      return res.status(404).json({ error: 'Template not found' })
    }

    const data = {}

    if (name !== undefined) {
      if (!name.trim()) {
        return res.status(400).json({ error: 'Name cannot be empty' })
      }
      // Check uniqueness if name changed
      if (name.trim() !== existing.name) {
        const existingName = await prisma.messageTemplate.findFirst({ where: { tenantId: req.tenantId, name: name.trim() } })
        if (existingName) {
          return res.status(409).json({ error: 'Name already exists', field: 'name' })
        }
      }
      data.name = name.trim()
    }

    if (keyword !== undefined) {
      if (!keyword.trim()) {
        return res.status(400).json({ error: 'Keyword cannot be empty' })
      }
      // Auto-prepend "/" if missing
      if (!keyword.startsWith('/')) {
        keyword = '/' + keyword
      }
      // No spaces
      if (keyword !== keyword.replace(/\s+/g, '')) {
        return res.status(400).json({ error: 'Keyword must not contain spaces' })
      }
      // Check uniqueness if keyword changed
      if (keyword !== existing.keyword) {
        const existingKeyword = await prisma.messageTemplate.findFirst({ where: { tenantId: req.tenantId, keyword } })
        if (existingKeyword) {
          return res.status(409).json({ error: 'Keyword already exists', field: 'keyword' })
        }
      }
      data.keyword = keyword
    }

    if (content !== undefined) {
      if (!content.trim()) {
        return res.status(400).json({ error: 'Content cannot be empty' })
      }
      data.content = content.trim()
    }

    if (category !== undefined) {
      data.category = category.trim() || 'umum'
    }

    const template = await prisma.messageTemplate.update({
      where: { id },
      data,
    })

    broadcast.emitToTenant(req.tenantId, 'template_update', { action: 'updated', template })

    res.json({ template })
  } catch (e) {
    console.error('Update template error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/templates/:id — delete template (admin only)
router.delete('/:id', ...rt, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid template ID' })
    }

    const existing = await prisma.messageTemplate.findFirst({ where: { id, tenantId: req.tenantId } })
    if (!existing) {
      return res.status(404).json({ error: 'Template not found' })
    }

    await prisma.messageTemplate.delete({ where: { id } })

    broadcast.emitToTenant(req.tenantId, 'template_update', { action: 'deleted', template: { id } })

    res.json({ success: true })
  } catch (e) {
    console.error('Delete template error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ─────────────────────────────────────────────────────────────────────────
// v0.15.1 — Export & Import endpoints (admin only)
// ─────────────────────────────────────────────────────────────────────────

// GET /api/templates/export — download JSON semua template (admin only)
router.get('/export', ...rt, requireAdmin, async (req, res) => {
  try {
    const templates = await prisma.messageTemplate.findMany({
      where: { tenantId: req.tenantId },
      orderBy: { name: 'asc' },
    })

    const payload = buildExportPayload(templates, {
      exportedAt: new Date().toISOString(),
      exportedBy: req.user?.username || null,
    })

    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${exportFilename(new Date())}"`)
    res.send(JSON.stringify(payload, null, 2))
  } catch (e) {
    console.error('Template export error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/templates/import — multipart file .json (admin). ?dryRun=true|1 → preview saja.
router.post(
  '/import',
  requireAuth,
  requireTenant,
  requireAdmin,
  (req, res, next) => {
    importUpload.single('file')(req, res, (err) => {
      if (err) {
        const msg =
          err instanceof multer.MulterError
            ? err.code === 'LIMIT_FILE_SIZE'
              ? 'File terlalu besar (maksimal 5MB)'
              : `Upload gagal: ${err.code}`
            : err.message
        return res.status(400).json({ error: msg })
      }
      next()
    })
  },
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'Tidak ada file yang diunggah (field "file")' })
      }

      const { data, error } = parseImportPayload(req.file.buffer)
      if (error) return res.status(400).json({ error })

      const dryRun = ['true', '1', 'yes'].includes(String(req.query.dryRun || '').toLowerCase())

      // Snapshot existing DB untuk merge decision (keyword & name unik di DB)
      const existingRows = await prisma.messageTemplate.findMany({
        where: { tenantId: req.tenantId },
        select: { name: true, keyword: true },
      })
      const existingKeywords = new Set(existingRows.map((r) => r.keyword))
      const existingNames = new Set(existingRows.map((r) => r.name))

      const result = {
        dryRun,
        total: data.templates.length,
        created: 0,
        skipped: 0,
        renamed: 0,
        errors: [],
      }

      // Keyword/name yang di-claim oleh entry sebelumnya DALAM file ini —
      // supaya duplikat dalam file & tabrakan antar-entry konsisten dengan DB.
      const claimedInFile = new Set()

      for (let i = 0; i < data.templates.length; i++) {
        const raw = data.templates[i]
        const norm = normalizeTemplateEntry(raw)
        if (norm.error) {
          result.errors.push({
            index: i,
            name: (raw && typeof raw === 'object' && typeof raw.name === 'string' && raw.name.trim()) || '(tanpa nama)',
            reason: norm.error,
          })
          continue
        }

        const entry = norm.entry
        const decision = mergeDecision(entry, existingKeywords, existingNames, claimedInFile)
        const decisionObj = typeof decision === 'string' ? { decision } : decision

        if (decisionObj.decision === 'skip-keyword') {
          result.skipped += 1
          continue
        }

        const nameToUse = decisionObj.decision === 'rename' ? decisionObj.name : entry.name

        // Claim sekarang juga — entry berikutnya dalam file yang sama
        // tidak boleh menabrak nama/keyword yang akan dibuat entry ini.
        claimedInFile.add(entry.keyword)
        claimedInFile.add(nameToUse)

        if (decisionObj.decision === 'rename') result.renamed += 1
        else result.created += 1

        if (!dryRun) {
          try {
            await prisma.messageTemplate.create({
              data: {
                tenantId: req.tenantId,
                name: nameToUse,
                keyword: entry.keyword,
                content: entry.content,
                category: entry.category,
                createdBy: req.user.id,
              },
            })
          } catch (e) {
            // Race/tabrakan di level DB (unique constraint) → jangan gagalkan sisanya
            result[decisionObj.decision === 'rename' ? 'renamed' : 'created'] -= 1
            result.errors.push({
              index: i,
              name: nameToUse,
              reason: `Gagal menyimpan: ${e.code === 'P2002' ? 'sudah ada di database' : e.message}`,
            })
          }
        }
      }

      // Emit SEKALI setelah import sukses (bukan per-entry) — Dashboard
      // sudah dengarkan 'template_update' → template "/" ikut refresh.
      if (!dryRun && (result.created > 0 || result.renamed > 0)) {
        broadcast.emitToTenant(req.tenantId, 'template_update', { action: 'imported' })
      }

      res.json(result)
    } catch (e) {
      console.error('Template import error:', e)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
)

// Attach pure functions & konstanta format — agar bisa unit-test OFFLINE
// (require route file ini tanpa Prisma/DB; prisma lazy-connect, broadcast no-op).
router.normalizeTemplateEntry = normalizeTemplateEntry
router.mergeDecision = mergeDecision
router.buildExportPayload = buildExportPayload
router.parseImportPayload = parseImportPayload
router.TEMPLATES_FORMAT = TEMPLATES_FORMAT
router.TEMPLATES_VERSION = TEMPLATES_VERSION

module.exports = router
