const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const helmet = require('helmet')
const cors = require('cors')
const rateLimit = require('express-rate-limit')
const path = require('path')
const fs = require('fs')

const config = require('./config')
const prisma = require('./prisma')
// v0.11.0 — Boot check kunci enkripsi isi pesan: missing/invalid → THROW di sini
// (process.exit(1) di catch start) — JANGAN silent fallback ke plaintext.
const textCrypto = require('./services/textCrypto')
console.log('[TEXT-CRYPTO] Kunci MSG_ENCRYPTION_KEY tervalidasi (AES-256-GCM ready)')
void textCrypto
const broadcast = require('./socket/broadcast')
const { setupHandlers } = require('./socket/handler')
const wa = require('./wa/baileys')

// Routes
const authRoutes = require('./routes/auth')
const announcementRoutes = require('./routes/announcements')
const chatRoutes = require('./routes/chats')
const mediaRoutes = require('./routes/media')
const waRoutes = require('./routes/wa')
const userRoutes = require('./routes/users')
const purgeRoutes = require('./routes/purge')
const contactRoutes = require('./routes/contacts').router
const tagRoutes = require('./routes/tags')
const blastRoutes = require('./routes/blast')
const templateRoutes = require('./routes/templates')
const tanganKananRoutes = require('./routes/tanganKanan')
const analyticsRoutes = require('./routes/analytics')
const pushRoutes = require('./routes/push')
const historyRoutes = require('./routes/history') // v0.6.0 — Backup & Restore history chat (admin)
const cekatImportRoutes = require('./routes/cekatImport') // v0.15.0 — Import dari Cekat.AI (admin)
const autoReplyRoutes = require('./routes/autoreply') // v0.7.0 — Auto Greeting config (admin)
const gdriveRoutes = require('./routes/gdrive') // v0.8.0 — Auto Backup Google Drive (admin)
const appearanceRoutes = require('./routes/appearance') // v0.9.0 — UI Revamp: accent config + /theme.css
const csatRoutes = require('./routes/csat') // v0.10.0 — CSAT Survey (admin)
const appConfigRoutes = require('./routes/appConfig') // v0.12.9 — AppConfig global (admin)
const scheduledRoutes = require('./routes/scheduled') // v0.10.0 — Pesan Terjadwal
const menuGatewayRoutes = require('./routes/menuGateway') // v0.13.0 — Menu Gateway (admin)
const groupRoutes = require('./routes/groups') // v0.14.0 — Manajemen Grup (PIC Model)
const superadminRoutes = require('./routes/superadmin') // v3.0 — Platform owner API
const brandingRoutes = require('./routes/branding') // v3.4 — Branding per-tenant (logo)

const app = express()
// v3.9.4 — trust proxy 'loopback': server di belakang cloudflared tunnel (127.0.0.1)
// → req.ip = IP klien asli dari X-Forwarded-For, BUKAN 127.0.0.1. Tanpa ini SEMUA
// klien dianggap satu IP → rate limit global gampang kembang oleh polling UI.
app.set('trust proxy', 'loopback')
const server = http.createServer(app)
const io = new Server(server, {
  cors: { origin: config.corsOrigin },
})

// Initialize Socket.IO
broadcast.init(io)
setupHandlers(io)

// Middleware
app.use(helmet({ contentSecurityPolicy: false }))
app.use(cors({ origin: config.corsOrigin }))
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

// Rate limiting
// v3.9.4 — SPLIT limiter READ vs WRITE. Bug fatal lama: SATU bucket 100/min per-IP
// untuk SEMUA request → polling dashboard (GET) + take chat beruntun (POST) + halaman
// admin paralel menghabiskan jatah → 429 "Too many requests, slow down" massal →// diperparah frontend logout paksa saat 429 (fetchMe) → user terlempar ke login,
// login pun kena limit = lingkaran setan. Sekarang: GET/HEAD bucket lega terpisah,
// WRITE bucket naik, dan login punya limiter sendiri (lihat routes/auth.js).
const apiReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: config.rateLimitReadPerMin,
  skip: (req) => req.method !== 'GET' && req.method !== 'HEAD',
  message: { error: 'Terlalu banyak permintaan — tunggu sebentar lalu coba lagi.' },
})
const apiWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: config.rateLimitPerMin,
  skip: (req) => req.method === 'GET' || req.method === 'HEAD',
  message: { error: 'Terlalu banyak aksi sekaligus — pelan-pelan, coba lagi sebentar.' },
})
app.use('/api/', apiReadLimiter, apiWriteLimiter)

// ═══ v3.8 — Global WRITE-GUARD masa aktif tenant (READ-ONLY enforcement) ═══
// Keputusan owner 15:30: tenant expired TETAP bisa login + GET/read (lihat chat,
// kontak, statistik, export); SEMUA aksi tulis diblokir 403 SUBSCRIPTION_EXPIRED.
// WAJIB SEBELUM router tenant terdaftar (middleware chain order) — intercept
// semua non-GET dgn resolver tenant (resolveTenant; butuh token utk tenant user;
// super_admin bebas). Router yang TIDAK disentuh (whitelist di bawah): branding
// (logo = GET-asset, auth flexible), media (GET media viewer utk semua), push
// (self-service device), appearance (GET publik), history/blast/contacts export
// (read-only = spec "export dibuka"). Low-level send guard di pool.js menutup
// jalur scheduler/auto-reply/greeting/CSAT.
const { requireActiveSubscription } = require('./auth')
const { resolveTenant } = require('./middleware/tenant')
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next()
  const p = req.path
  // Whitelist NON-GET yang TIDAK kena guard (self-service / tidak memengaruhi tenant):
  if (
    p.startsWith('/auth/') || // login + change-password mandiri (logout = POST /api/auth/logout)
    p.startsWith('/branding/') || // serve logo (GET-ish, auth flexible ?token=)
    p.startsWith('/media/') || // POST upload — di-guard per-route (media viewer harus tetap jalan)
    p.startsWith('/push/') || // push subscription milik user sendiri (perangkat sendiri)
    (p.startsWith('/csat/') && !p.startsWith('/csat/config')) || // csat submit publik (token, bukan sesi)
    (p.startsWith('/appearance') && p !== '/appearance') || // GET /appearance/public dll
    (p.startsWith('/gdrive/') && p.startsWith('/gdrive/oauth/callback')) || // OAuth redirect publik
    (p.startsWith('/history/') && p.startsWith('/history/export')) || // export = read (spec: export dibuka)
    (p.startsWith('/blast/') && (p === '/blast/upload-csv' || p.startsWith('/blast/preview') || p.startsWith('/blast/export'))) || // preview CSV/eksport riwayat = read-only, TIDAK menulis apa pun
    p.startsWith('/contacts/export') // export kontak = read (spec: export dibuka)
  ) {
    return next()
  }
  // resolveTenant butuh req.user — pastikan auth header diparse ringan tanpa reject:
  // guard ini JANGAN menolak 401 sendiri (biar route asli yang handle); kalau tak ada
  // token → next() (route asli yang 401).
  const header = req.headers.authorization
  const token = header && header.startsWith('Bearer ') ? header.slice(7) : null
  const decoded = token ? require('./auth').verifyToken(token) : null
  if (!decoded) return next()
  req.user = decoded
  resolveTenant(req, res, () => requireActiveSubscription(req, res, next))
})

// API routes
app.use('/api/auth', authRoutes)
app.use('/api/sa', superadminRoutes) // v3.0 — Platform owner (requireSuperAdmin di dalam)
app.use('/api/announcements', announcementRoutes)
app.use('/api/chats', chatRoutes)
app.use('/api/media', mediaRoutes)
app.use('/api/wa', waRoutes)
app.use('/api/users', userRoutes)
app.use('/api/purge', purgeRoutes)
app.use('/api/contacts', contactRoutes)
app.use('/api/tags', tagRoutes)
app.use('/api/blast', blastRoutes)
app.use('/api/templates', templateRoutes)
app.use('/api/tk', tanganKananRoutes)
app.use('/api/analytics', analyticsRoutes)
app.use('/api/push', pushRoutes)
app.use('/api/history', historyRoutes)
app.use('/api/cekat-import', cekatImportRoutes) // v0.15.0 — Import dari Cekat.AI (admin)
app.use('/api/autoreply', autoReplyRoutes) // v0.7.0 — Auto Greeting config (admin)
app.use('/api/gdrive', gdriveRoutes) // v0.8.0 — Auto Backup Google Drive (admin)

// v0.9.0 — UI Revamp: appearance config
app.use('/api/appearance', appearanceRoutes.router)
app.use('/api/csat', csatRoutes) // v0.10.0 — CSAT Survey (admin)
app.use('/api/app-config', appConfigRoutes) // v0.12.9 — AppConfig global (admin)
app.use('/api/scheduled', scheduledRoutes) // v0.10.0 — Pesan Terjadwal
app.use('/api/menu-gateway', menuGatewayRoutes) // v0.13.0 — Menu Gateway (admin). Sweep di-init saat boot sejak v3.9.8.
app.use('/api/groups', groupRoutes) // v0.14.0 — Manajemen Grup (PIC Model)
app.use('/api/branding', brandingRoutes) // v3.4 — Branding per-tenant (logo, auth flexible)
// Public, no-auth: dipakai index.html SEBELUM bundle app (fallback aman kalau DB error)
app.get('/theme.css', appearanceRoutes.themeCssHandler)
// v0.12.7 — PUBLIC, no-auth: manifest dinamis (theme_color = accentSeed aktif).
// WAJIB terdaftar SEBELUM express.static di bawah — static akan menang duluan dan
// menyajikan file statis hardcoded #6d28d9 selamanya.
app.get('/manifest.webmanifest', appearanceRoutes.manifestHandler)

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// Serve static frontend
const publicDir = path.join(__dirname, '..', 'public')
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir))
  
  // SPA fallback — serve index.html for non-API routes
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) {
      return next()
    }
    res.sendFile(path.join(publicDir, 'index.html'))
  })
}

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err)
  res.status(500).json({ error: 'Internal server error' })
})

// ─── v3.0 Phase 1 — Boot seed super_admin dari env (TANPA default tenant/admin) ──
// Platform mulai BENAR-BENAR kosong: tenant dibuat via superadmin, bukan seed.
async function ensureSuperAdmin() {
  const existing = await prisma.user.findFirst({ where: { role: 'super_admin' } })
  if (existing) return existing
  const username = config.superadminUsername
  const password = config.superadminPassword
  if (!username || !password) {
    throw new Error('SUPERADMIN_USERNAME/SUPERADMIN_PASSWORD belum diset di .env — tidak ada akun awal yang bisa dibuat')
  }
  const { hashPassword } = require('./auth')
  const passwordHash = await hashPassword(password)
  const user = await prisma.user.create({
    data: { username, passwordHash, role: 'super_admin', tenantId: null },
  })
  console.log(`[Boot] Super admin "${username}" di-seed dari env (id=${user.id})`)
  return user
}

// Start server
async function start() {
  try {
    // Test DB connection
    await prisma.$connect()
    console.log('[DB] Connected to SQLite')

    // v3.0 — Seed super_admin dari env (TIDAK ada default tenant/admin).
    // Seed config/folder lama dihapus dari boot — kini per-tenant via
    // tenantSeed.seedTenantDefaults() saat superadmin membuat tenant.
    await ensureSuperAdmin()
    // v3.4 — Plan & kuota per-tenant: tenant yang SUDAH ADA (belum punya plan) di-seed
    // plan=max otomatis di boot (safe: fitur yang sebelumnya kebuka tetap kebuka).
    const plans = require('./services/plans')
    const seededPlans = await plans.ensureAllTenantPlans()
    if (seededPlans > 0) console.log(`[Plan] Boot: ${seededPlans} tenant existing di-seed plan=max`)
    const [tenantCount, userCount] = await prisma.$transaction([
      prisma.tenant.count(),
      prisma.user.count(),
    ])
    console.log(`[DB] Platform state: ${tenantCount} tenant, ${userCount} user`)

    // v0.8.0 — Scheduler Google Drive backup: config kini per-tenant (seed saat
    // tenant dibuat); scheduler tetap global, tick membaca config per link user.
    const gdriveBackup = require('./services/gdriveBackup')
    gdriveBackup.initGDriveScheduler()
    // v0.10.0 — Scheduler gabungan (snooze expiry + pesan terjadwal + CSAT pending)
    const v0100 = require('./services/v0100Scheduler')
    v0100.initV0100Scheduler()

    // v3.9.8 — Menu Gateway sweep: init di BOOT (idempoten), BUKAN post-WA-connect.
    // Bug: initMenuGatewaySweep gak pernah punya caller → timeout "Menunggu menu"
    // gak pernah jalan di produksi (chat nyangkut selamanya).
    require('./services/menuGateway').initMenuGatewaySweep()

    // Start Express
    server.listen(config.port, () => {
      console.log(`[Server] WA CS Hub running on port ${config.port}`)
    })

    // Start WhatsApp connection — WA_DISABLED=1 → skip bootstrap Baileys total
    if (config.waDisabled) {
      console.log('[WA] WA disabled (WA_DISABLED=1) — skipping Baileys bootstrap entirely')
    } else {
      await wa.connectToWhatsApp()
    }

  } catch (e) {
    console.error('Startup error:', e)
    process.exit(1)
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...')
  try {
    await prisma.$disconnect()
    process.exit(0)
  } catch (e) {
    process.exit(1)
  }
})

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down...')
  try {
    await prisma.$disconnect()
    process.exit(0)
  } catch (e) {
    process.exit(1)
  }
})

start()
