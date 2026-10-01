// v3.0 Phase 1 — Kill-switch WA + superadmin bootstrap env.
// WA_DISABLED=1 → skip bootstrap Baileys total (server boot bersih tanpa QR);
// endpoint WA balik { connected:false, disabled:true }.
const dotenv = require('dotenv')
const path = require('path')
const fs = require('fs')

// Load .env
dotenv.config()

// v3.9.12c (audit I3) — path RELATIF di env di-anchor ke ROOT APP (src/..),
// bukan CWD — supaya `node /path/app/src/server.js` dari folder manapun tetap
// benar (paket hosting). Path absolut (dev .env) tak terpengaruh.
const APP_ROOT = path.resolve(__dirname, '..')
const resolveFromAppRoot = (p) => (path.isAbsolute(p) ? p : path.resolve(APP_ROOT, p))

const config = {
  port: parseInt(process.env.PORT || '5047', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  databaseUrl: process.env.DATABASE_URL || 'file:./data/wa-cs-hub.db',

  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  jwtExpiry: '24h',

  mediaDir: resolveFromAppRoot(process.env.MEDIA_DIR || './data/media'),
  mediaEncryptionKey: process.env.MEDIA_ENCRYPTION_KEY || '0000000000000000000000000000000000000000000000000000000000000000',
  maxMediaSizeMb: parseInt(process.env.MAX_MEDIA_SIZE_MB || '10', 10),

  corsOrigin: process.env.CORS_ORIGIN || '*',

  waSessionDir: resolveFromAppRoot(process.env.WA_SESSION_DIR || './data/wa-session'),
  waReconnectIntervalMs: parseInt(process.env.WA_RECONNECT_INTERVAL_MS || '5000', 10),
  waQrTimeoutMs: parseInt(process.env.WA_QR_TIMEOUT_MS || '60000', 10),

  // v3.0 Phase 1 — kill-switch WA: lewati seluruh bootstrap Baileys (server tetap
  // boot, endpoint WA balik {connected:false, disabled:true}).
  waDisabled: ['1', 'true', 'yes'].includes(String(process.env.WA_DISABLED || '').toLowerCase()),

  // v3.0 Phase 1 — kredensial super_admin auto-seed boot pertama (JANGAN ubah .env
  // dari kode — hanya dibaca).
  superadminUsername: process.env.SUPERADMIN_USERNAME || 'superadmin',
  superadminPassword: process.env.SUPERADMIN_PASSWORD || 'superadmin123',

  // v3.9.4 — rate limit split READ/WRITE (lihat server.js). Default write 300/min
  // (naik dari 100), read default = 6× write (polling dashboard lega). .env produksi
  // dioverride eksplisit.
  rateLimitPerMin: parseInt(process.env.RATE_LIMIT_PER_MIN || '300', 10),
  rateLimitReadPerMin: parseInt(process.env.RATE_LIMIT_READ_PER_MIN || String(parseInt(process.env.RATE_LIMIT_PER_MIN || '300', 10) * 6), 10),
  waSendRatePerSec: parseInt(process.env.WA_SEND_RATE_PER_SEC || '10', 10),

  // v0.4.0 — Web Push (VAPID)
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || '',
  vapidSubject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
}

// Ensure directories exist
function ensureDirs() {
  const dirs = [
    resolveFromAppRoot('./data'),
    config.mediaDir,
  ]
  // Session dir global hanya dibuat kalau WA aktif (fase 2: per-tenant via pool)
  if (!config.waDisabled) {
    dirs.push(config.waSessionDir)
  }
  for (const d of dirs) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
  }
}

ensureDirs()

module.exports = config