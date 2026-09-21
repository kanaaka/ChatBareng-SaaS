/**
 * v0.9.0 — Appearance config API (UI Revamp M3).
 * GET  /api/appearance      — baca config (auth; dipakai admin UI)
 * GET  /api/appearance/public — v0.12.7 PUBLIC no-auth: { accentSeed } saja — dipakai
 *                              init script index.html utk meta theme-color (status bar)
 *                              SEBELUM bundle app. DB error → 200 + DEFAULT_SEED (resilien,
 *                              pola sama dengan /theme.css fallback kosong).
 * PUT  /api/appearance      — update accentSeed (ADMIN ONLY; validasi hex; server
 *                             generate skema light+dark via material-color-utilities
 *                             → simpan CSS di DB → invalidate cache /theme.css)
 */
const express = require('express')
const fs = require('fs')
const path = require('path')
const router = express.Router()
const prisma = require('../prisma')
const { requireAuth, requireAdmin, requireTenant } = require('../auth')

// v3.0 — Isolasi tenant: AppearanceConfig = per-tenant. Endpoint auth = tenant dari
// JWT (super_admin wajib ?tenant=). /theme.css & /manifest PUBLIC resolve via
// ?tenant= (soft — tanpa tenant → config tenant pertama sebagai fallback fase 1).
const rt = [requireAuth, requireTenant]
const { normalizeHex, buildCssVars, DEFAULT_SEED } = require('../services/appearance')

// In-memory cache untuk GET /theme.css (invalidate saat PUT) — dipasang dari server.js
let themeCssCache = { css: null, updatedAt: 0 }
function getCachedThemeCss() {
  return themeCssCache.css
}
function invalidateThemeCssCache() {
  themeCssCache = { css: null, updatedAt: Date.now() }
}

// Per-tenant config — seed idempotent (pola AutoReplyConfig v0.7.0); seed utama
// jalan via tenantSeed.seedTenantDefaults saat tenant dibuat.
async function getConfig(tenantId) {
  const existing = await prisma.appearanceConfig.findUnique({ where: { tenantId } })
  if (existing) return existing
  const seedCss = buildCssVars(DEFAULT_SEED)
  return prisma.appearanceConfig.create({
    data: { tenantId, accentSeed: DEFAULT_SEED, themeCss: seedCss },
  }).catch(async (e) => {
    if (e.code === 'P2002') return prisma.appearanceConfig.findUnique({ where: { tenantId } })
    throw e
  })
}

// GET /api/appearance/public (PUBLIC, no-auth) — v0.12.7: { accentSeed } utk init script
// index.html (meta theme-color) & App.vue. Payload sengaja minimal + tanpa auth karena
// diakses browser SEBELUM login (bukan data sensitif — warna aksen aplikasi).
router.get('/public', async (req, res) => {
  try {
    // v3 — resolve tenant opsional: ?tenant= / X-Tenant-Id; fallback = tenant pertama
    let tenantId = parseInt(req.query.tenant ?? req.headers['x-tenant-id'], 10)
    if (!Number.isFinite(tenantId)) {
      const first = await prisma.tenant.findFirst({ orderBy: { id: 'asc' }, select: { id: true } })
      tenantId = first?.id
    }
    if (!Number.isFinite(tenantId)) return res.json({ accentSeed: DEFAULT_SEED })
    const cfg = await getConfig(tenantId)
    res.set('Cache-Control', 'no-cache')
    res.json({ accentSeed: cfg.accentSeed })
  } catch (e) {
    // Resilien: init script butuh jawaban valid agar status bar tidak melenceng jauh
    console.error('[Appearance] GET public error:', e)
    res.set('Cache-Control', 'no-cache')
    res.json({ accentSeed: DEFAULT_SEED })
  }
})

// GET /api/appearance (auth) — config + seed (CSS tidak dikirim utk payload ringan)
router.get('/', ...rt, async (req, res) => {
  try {
    const cfg = await getConfig(req.tenantId)
    res.json({ config: { id: cfg.id, accentSeed: cfg.accentSeed, updatedAt: cfg.updatedAt, updatedById: cfg.updatedById } })
  } catch (e) {
    console.error('[Appearance] GET error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/appearance (admin) — { accentSeed: "#RRGGBB" }
router.put('/', ...rt, requireAdmin, async (req, res) => {
  try {
    const body = req.body || {}
    const seed = normalizeHex(body.accentSeed)
    if (!seed) {
      return res.status(400).json({ error: 'accentSeed harus hex valid, contoh #6D28D9' })
    }
    await getConfig(req.tenantId) // pastikan config tenant ter-seed

    const css = buildCssVars(seed)
    const cfg = await prisma.appearanceConfig.update({
      where: { tenantId: req.tenantId },
      data: { accentSeed: seed, themeCss: css, updatedById: req.user.id },
    })

    invalidateThemeCssCache() // cache /theme.css invalid → variabel baru aktif

    console.log(`[Appearance] Accent updated to ${seed} by @${req.user.username}`)
    res.json({ config: { id: cfg.id, accentSeed: cfg.accentSeed, updatedAt: cfg.updatedAt, updatedById: cfg.updatedById }, themeCss: css })
  } catch (e) {
    console.error('[Appearance] PUT error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /theme.css — PUBLIC, no-auth (dipakai index.html SEBELUM bundle app).
// Resilience: DB error → serve CSS kosong (fallback ke tokens.css default), bukan crash.
function themeCssHandler(req, res) {
  const cached = getCachedThemeCss()
  if (cached !== null) {
    res.set('Content-Type', 'text/css; charset=utf-8')
    res.set('Cache-Control', 'no-cache')
    return res.send(cached)
  }
  // v3 — tenant resolve (soft): ?tenant= / X-Tenant-Id; fallback tenant pertama
  const resolveTid = prisma.tenant.findFirst({ orderBy: { id: 'asc' }, select: { id: true } })
    .then((t) => {
      const explicit = parseInt(req.query.tenant ?? req.headers['x-tenant-id'], 10)
      return Number.isFinite(explicit) ? explicit : (t?.id ?? null)
    })
  resolveTid
    .then((tenantId) => (Number.isFinite(tenantId)
      ? prisma.appearanceConfig.findUnique({ where: { tenantId } })
      : null))
    .then((cfg) => {
      const css = (cfg && cfg.themeCss) ? cfg.themeCss : ''
      themeCssCache = { css, updatedAt: Date.now() }
      res.set('Content-Type', 'text/css; charset=utf-8')
      res.set('Cache-Control', 'no-cache')
      res.send(css)
    })
    .catch((e) => {
      // Fallback eksplisit: CSS kosong → tokens.css default yang tetap dipakai
      console.error('[Appearance] /theme.css DB error, serving empty fallback:', e.message)
      res.set('Content-Type', 'text/css; charset=utf-8')
      res.set('Cache-Control', 'no-cache')
      res.send('/* fallback: DB unavailable — default tokens apply */')
    })
}

// GET /manifest.webmanifest — v0.12.7 PUBLIC no-auth: manifest DINAMIS dgn theme_color =
// accentSeed aktif. Dulu: file statis manifest.webmanifest hardcoded #6d28d9 → ganti accent
// di Admin Appearance tidak pernah sampai ke status bar Android (theme_color manifest).
// Browser mengambil manifest TANPA auth → endpoint harus PUBLIC. File statis tetap ada
// sbg fallback template (kalau handler ini gagal load file → 503, static file yang lama
// tidak di-tulis ulang). Cache pendek max-age=60 (revisit cepat ikut accent baru).
let manifestTemplate = null
let manifestTemplateMtimeMs = 0
function manifestHandler(_req, res) {
  try {
    const manifestPath = path.join(__dirname, '..', '..', 'public', 'manifest.webmanifest')
    const st = fs.statSync(manifestPath)
    if (!manifestTemplate || st.mtimeMs !== manifestTemplateMtimeMs) {
      manifestTemplate = fs.readFileSync(manifestPath, 'utf8')
      manifestTemplateMtimeMs = st.mtimeMs
    }
    const resolveTid = prisma.tenant.findFirst({ orderBy: { id: 'asc' }, select: { id: true } })
      .then((t) => {
        const explicit = parseInt(_req.query?.tenant ?? _req.headers?.['x-tenant-id'], 10)
        return Number.isFinite(explicit) ? explicit : (t?.id ?? null)
      })
  resolveTid
    .then((tenantId) => (Number.isFinite(tenantId)
      ? prisma.appearanceConfig.findUnique({ where: { tenantId } })
      : null))
      .then((cfg) => {
        const seed = (cfg && cfg.accentSeed) || DEFAULT_SEED
        let manifest
        try {
          manifest = JSON.parse(manifestTemplate)
        } catch (e) {
          console.error('[Appearance] manifest template parse error:', e.message)
          return res.status(503).json({ error: 'manifest template invalid' })
        }
        manifest.theme_color = seed
        res.set('Content-Type', 'application/manifest+json; charset=utf-8')
        res.set('Cache-Control', 'public, max-age=60')
        res.json(manifest)
      })
      .catch((e) => {
        // DB gagal → serve template statis apa adanya (fallback, tidak crash)
        console.error('[Appearance] /manifest.webmanifest DB error, serving static fallback:', e.message)
        res.set('Content-Type', 'application/manifest+json; charset=utf-8')
        res.set('Cache-Control', 'public, max-age=60')
        res.send(manifestTemplate)
      })
  } catch (e) {
    console.error('[Appearance] manifest handler error:', e)
    res.status(503).json({ error: 'manifest unavailable' })
  }
}

module.exports = { router, themeCssHandler, manifestHandler, invalidateThemeCssCache }
