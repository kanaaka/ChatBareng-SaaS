/**
 * Mulai ChatBareng (SAAS) — portable Windows launcher
 * ============================================
 * Double-click entry point. Responsibilities (urutan):
 *  1. BASE = dirname(execPath) — portable root absolut, tahan folder dipindah
 *  2. Env runtime absolut: DATABASE_URL, JWT_SECRET (first-run generate), PORT
 *  3. First-run bootstrap: prisma db push --skip-generate (DB BARU kosong) + seed admin
 *  4. Spawn node.exe src/server.js (NOT detached — ikut mati)
 *  5. Health check /api/health
 *  6. Spawn cloudflared tunnel → parse *.trycloudflare.com
 *  7. Watchdog 30s: cloudflared mati → regen → URL baru → data/url.txt + console
 *  8. URL siap → Set-Clipboard + buka browser + tampil besar di console
 *  9. Console ditutup → semua child mati (taskkill /T di exit handler)
 *
 * TANPA bit.ly. TANPA notifikasi Telegram. Semua status cuma di console ini.
 */

const { spawn, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const http = require('http')

// ─── 1. BASE ───────────────────────────────────────────────────────────────
const BASE = path.dirname(process.execPath) // folder berisi Mulai ChatBareng.exe
const APP_DIR = path.join(BASE, 'app')
const DATA_DIR = path.join(BASE, 'data')
const NODE_EXE = path.join(APP_DIR, 'node.exe')
const CLOUDFLARED_EXE = path.join(BASE, 'cloudflared.exe')
const DB_FILE = path.join(DATA_DIR, 'wa-cs-hub.db')
const TUNNEL_LOG = path.join(DATA_DIR, 'tunnel.log')
const URL_FILE = path.join(DATA_DIR, 'url.txt')
const SECRET_FILE = path.join(DATA_DIR, 'secret.txt')
const MSGKEY_FILE = path.join(DATA_DIR, 'msgkey.txt')
const SEED_MARKER = path.join(DATA_DIR, '.seeded')
const CRED_FILE = path.join(DATA_DIR, 'KREDENSIAL-ADMIN.txt')
const CRED_SHOWN = path.join(DATA_DIR, '.cred-shown')
const PORT = parseInt(process.env.CB_PORT || '5030', 10)

// ─── Console helpers ──────────────────────────────────────────────────────
let screenLines = []
let statusLine = ''
let urlLine = ''
let serverState = 'starting'
let tunnelState = 'starting'
let tunnelUrl = ''

function render() {
  try { process.stdout.write('\x1b[2J\x1b[H') } catch (e) {}
  const line = (s) => process.stdout.write(s + '\r\n')
  line('')
  line('  ============================================================')
  line('    CHATBARENG - Portable Server WhatsApp CS')
  line('  ============================================================')
  line('')
  line('  Server lokal  : ' + serverState)
  line('  Tunnel publik : ' + tunnelState)
  if (tunnelUrl) {
    line('')
    line('  ----------------------------------------------------------')
    line('    AKSES DARI KOMPATUR LAIN:')
    line('')
    line('    ' + tunnelUrl)
    line('')
    line('    (sudah di-copy — tinggal Ctrl+V)')
    line('  ----------------------------------------------------------')
  }
  line('')
  line('  Status      : ' + statusLine)
  line('')
  line('  PENTING: Jangan tutup window ini selamanya dipakai.')
  line('  URL berubah tiap restart — lihat window ini / data\\url.txt')
  line('')
  line('  Tutup window ini untuk MEMATIKAN ChatBareng.')
  line('')
}

function setStatus(s) {
  statusLine = s
  render()
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function ensureDirs() {
  for (const d of [DATA_DIR, path.join(DATA_DIR, 'media'), path.join(DATA_DIR, 'wa-session')]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
  }
}

function ensureSecret(file, genBytes) {
  if (fs.existsSync(file)) {
    const v = fs.readFileSync(file, 'utf8').trim()
    if (v) return v
  }
  const v = crypto.randomBytes(genBytes).toString('hex')
  fs.writeFileSync(file, v, 'utf8')
  return v
}

function ensureAdminPass() {
  if (fs.existsSync(CRED_FILE)) {
    const txt = fs.readFileSync(CRED_FILE, 'utf8')
    const m = txt.match(/Password:\s*([^\r\n]+)/)
    if (m && m[1].trim()) {
      if (!fs.existsSync(CRED_SHOWN)) showCred()
      return m[1].trim()
    }
  }
  const pass = crypto.randomBytes(9).toString('base64url')
  const txt = [
    'Kredensial ChatBareng (SAAS) - dibuat otomatis saat jalankan pertama',
    'Tanggal: ' + new Date().toLocaleString('id-ID'),
    'URL:  lihat tunnel lokal  http://127.0.0.1:5030',
    'Account SUPERADMIN (pemilik platform):',
    '  Username: superadmin',
    '  Password: ' + pass,
    '',
    'Login dgn ini kapan saja (URL tunnel gak mengubah login).',
    'SIMPAAN: copy file ini, lalu HAPUS.',
    '',
  ].join('\r\n')
  fs.writeFileSync(CRED_FILE, txt, 'utf8')
  if (!fs.existsSync(CRED_SHOWN)) showCred()
  return pass
}

function showCred() {
  try { require('child_process').spawn('cmd.exe', ['/c', 'start', '', 'notepad.exe', CRED_FILE], { stdio: 'ignore' }) } catch (e) {}
  try { fs.writeFileSync(CRED_SHOWN, new Date().toISOString(), 'utf8') } catch (e) {}
}

function ensureMsgKey() {
  // MSG_ENCRYPTION_KEY: base64 32-byte (wajib — server exit tanpa ini)
  if (fs.existsSync(MSGKEY_FILE)) {
    const v = fs.readFileSync(MSGKEY_FILE, 'utf8').trim()
    if (v) {
      try {
        if (Buffer.from(v, 'base64').length === 32) return v
      } catch (e) {}
    }
  }
  const v = crypto.randomBytes(32).toString('base64')
  fs.writeFileSync(MSGKEY_FILE, v, 'utf8')
  return v
}

function runNode(args, opts = {}) {
  const r = spawnSyncShim(NODE_EXE, args, opts)
  return r
}

function spawnSyncShim(cmd, args, opts) {
  const { spawnSync } = require('child_process')
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts })
}

// ─── 2. Env ────────────────────────────────────────────────────────────────
function buildEnv() {
  const env = { ...process.env }
  env.DATABASE_URL = 'file:' + DB_FILE.replace(/\\/g, '/')
  env.JWT_SECRET = ensureSecret(SECRET_FILE, 32)
  env.MSG_ENCRYPTION_KEY = ensureMsgKey()
  env.PORT = String(PORT)
  env.NODE_ENV = 'production'
  // direktori data absolut (biar gak nyasar ke C:\Windows\System32)
  env.MEDIA_DIR = path.join(DATA_DIR, 'media')
  env.WA_SESSION_DIR = path.join(DATA_DIR, 'wa-session')
  // .env di repo gak ikut — matikan dotenv fallback dengan nilai eksplisit:
  env.MEDIA_ENCRYPTION_KEY = env.MEDIA_ENCRYPTION_KEY || '0'.repeat(64)
  env.RATE_LIMIT_PER_MIN = env.RATE_LIMIT_PER_MIN || '100'
  env.WA_SEND_RATE_PER_SEC = env.WA_SEND_RATE_PER_SEC || '10'
  env.VAPID_PUBLIC_KEY = env.VAPID_PUBLIC_KEY || ''
  env.VAPID_PRIVATE_KEY = env.VAPID_PRIVATE_KEY || ''
  env.VAPID_SUBJECT = env.VAPID_SUBJECT || 'mailto:admin@localhost'
  // SB (SAAS): akun platform owner — password acak per-install + KREDENSIAL-ADMIN.txt
  env.SUPERADMIN_USERNAME = 'superadmin'
  env.SUPERADMIN_PASSWORD = ensureAdminPass()
  delete env.GDRIVE_CLIENT_ID
  delete env.GDRIVE_CLIENT_SECRET
  return env
}

// ─── 3. First-run bootstrap ────────────────────────────────────────────────
function bootstrap(env) {
  if (fs.existsSync(DB_FILE) && fs.statSync(DB_FILE).size > 0) {
    setStatus('Database sudah ada — skip bootstrap')
    return true
  }
  setStatus('First run: menyiapkan database...')
  const prismaCli = path.join(APP_DIR, 'node_modules', 'prisma', 'build', 'index.js')
  if (!fs.existsSync(prismaCli)) {
    console.error('FATAL: prisma CLI tidak ditemukan di ' + prismaCli)
    return false
  }
  const r1 = spawnSyncShim(NODE_EXE, [prismaCli, 'db', 'push', '--skip-generate', '--schema', path.join(APP_DIR, 'prisma', 'schema.prisma')], {
    cwd: APP_DIR, env, encoding: 'utf8', timeout: 120000,
  })
  if (r1.status !== 0) {
    console.error('Gagal prisma db push:')
    console.error((r1.stdout || '') + (r1.stderr || ''))
    return false
  }
  // SAAS: seed.js (admin tenant-less) DILAPANGI — akun platform = superadmin via env
  // (boot server men-seed sendiri dari SUPERADMIN cred yang launcher generate).
  if (!fs.existsSync(SEED_MARKER)) {
    fs.writeFileSync(SEED_MARKER, new Date().toISOString(), 'utf8')
  }
  return true
}

// ─── 4. Server ─────────────────────────────────────────────────────────────
let serverProc = null
function startServer(env) {
  serverProc = spawn(NODE_EXE, ['src/server.js'], {
    cwd: APP_DIR, env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const forward = (buf, tag) => {
    const s = buf.toString()
    for (const ln of s.split('\n')) {
      if (ln.trim()) console.log('  [app] ' + ln.trim())
    }
  }
  serverProc.stdout.on('data', forward)
  serverProc.stderr.on('data', forward)
  serverProc.on('exit', (code) => {
    serverState = code ? 'MATI (exit ' + code + ')' : 'mati'
    render()
  })
  return serverProc
}

function healthCheck() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 2000 }, (res) => {
      resolve(res.statusCode === 200)
      res.resume()
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

async function waitHealthy(retries, intervalMs) {
  for (let i = 0; i < retries; i++) {
    setStatus('Health check ' + (i + 1) + '/' + retries + '...')
    if (await healthCheck()) return true
    await sleep(intervalMs)
  }
  return false
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ─── 6. Tunnel ─────────────────────────────────────────────────────────────
let cloudflaredProc = null
let tunnelAttempts = 0

function startTunnel(env) {
  const logFd = fs.openSync(TUNNEL_LOG, 'w') // truncate per-run — log numpuk bikin parser ambil URL MATI lama (bug test Windows 2026-09-23)
  cloudflaredProc = spawn(CLOUDFLARED_EXE, ['tunnel', '--url', 'http://127.0.0.1:' + PORT], {
    cwd: BASE, env,
    stdio: ['ignore', logFd, logFd],
  })
  setStatus('Menunggu URL tunnel...')
  cloudflaredProc.on('exit', (code) => {
    tunnelState = 'putus (regen otomatis...)'
    tunnelUrl = ''
    render()
  })
  return cloudflaredProc
}

function parseTunnelUrlFromLog() {
  try {
    const txt = fs.readFileSync(TUNNEL_LOG, 'utf8')
    const urls = txt.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi)
    return urls ? urls[urls.length - 1] : null // TERAKHIR wins — log bisa berisi URL lama+baru
  } catch (e) { return null }
}

async function httpOkAny(url, timeoutMs) {
  return new Promise((resolve) => {
    try {
      // URL tunnel = https → WAJIB pakai modul https (bug test Windows 14:08:
      // http.get dgn URL https melempar sync error "Protocol https: not
      // supported. Expected http:" → FATAL crash launcher).
      const mod = /^https:/i.test(url) ? require('https') : http
      const req = mod.get(url, { timeout: timeoutMs || 5000 }, (res) => {
        resolve(res.statusCode === 200)
        res.resume()
      })
      req.on('error', () => resolve(false))
      req.on('timeout', () => { req.destroy(); resolve(false) })
    } catch (e) {
      resolve(false) // throw sync apapun = gagal verify, BUKAN crash launcher
    }
  })
}

// URL baru dianggap sah HANYA kalau beneran respond — jangan display/copy URL mati
async function adoptTunnelUrl(url) {
  if (!url) return false
  for (let i = 0; i < 5; i++) {
    if (await httpOkAny(url, 5000)) {
      tunnelUrl = url
      tunnelState = 'AKTIF'
      fs.writeFileSync(URL_FILE, url, 'utf8')
      copyClipboard(url)
      openBrowser(url)
      render()
      return true
    }
    await sleep(2000)
  }
  return false
}

async function waitTunnelUrl(timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const url = parseTunnelUrlFromLog()
    if (url) return url
    await sleep(1500)
  }
  return null
}

// ─── 8. URL ready actions ──────────────────────────────────────────────────
function copyClipboard(text) {
  try {
    spawnSyncShim('powershell.exe', ['-NoProfile', '-Command', 'Set-Clipboard -Value "' + text.replace(/"/g, '\\"') + '"'], { timeout: 15000 })
    return true
  } catch (e) { return false }
}

function openBrowser(url) {
  try {
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: false, stdio: 'ignore' })
  } catch (e) {}
}

// ─── 7. Watchdog ───────────────────────────────────────────────────────────
function startWatchdog(env) {
  setInterval(async () => {
    // server hidup?
    if (serverProc && serverProc.exitCode !== null) {
      serverState = 'MATI — coba start ulang...'
      render()
      startServer(env)
      return
    }
    // cloudflared hidup?
    if (!cloudflaredProc || cloudflaredProc.exitCode !== null) {
      tunnelAttempts++
      if (tunnelAttempts <= 3) {
        tunnelState = 'regen ke-' + tunnelAttempts + '...'
        render()
        fs.appendFileSync(TUNNEL_LOG, '\n--- regen #' + tunnelAttempts + ' ' + new Date().toISOString() + ' ---\n')
        startTunnel(env)
        const url = await waitTunnelUrl(60000)
        if (url && (await adoptTunnelUrl(url))) {
          tunnelState = 'AKTIF'
          render()
        } else {
          tunnelState = 'gagal ' + tunnelAttempts + '/3 — server lokal tetap jalan'
          render()
        }
      } else {
        tunnelState = 'gagal 3x — pakai akses lokal; regen di tick berikutnya'
        tunnelAttempts = 0
        render()
      }
    } else if (!tunnelUrl) {
      const url = parseTunnelUrlFromLog()
      if (url) {
        tunnelUrl = url
        tunnelState = 'AKTIF'
        fs.writeFileSync(URL_FILE, url, 'utf8')
        copyClipboard(url)
        render()
      }
    } else {
      // URL berubah? (log bisa berisi URL lama+baru)
      const url = parseTunnelUrlFromLog()
      if (url && url !== tunnelUrl && (await adoptTunnelUrl(url))) {
        setStatus('URL tunnel berganti — sudah di-update clipboard')
        render()
      }
    }
  }, 30000)
}

// ─── 9. Cleanup ────────────────────────────────────────────────────────────
function killChildren() {
  try { serverProc && serverProc.pid && process.kill(-serverProc.pid) } catch (e) {}
  try { cloudflaredProc && cloudflaredProc.pid && process.kill(-cloudflaredProc.pid) } catch (e) {}
}

process.on('exit', () => { try { killChildren() } catch (e) {} })
process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  render()
  if (process.platform !== 'win32') {
    console.log('  [i] mode non-Windows (dev test) — exe path: ' + process.execPath)
  }
  ensureDirs()
  setStatus('Menyiapkan environment...')
  const env = buildEnv()

  if (!fs.existsSync(NODE_EXE)) {
    console.error('FATAL: app\\node.exe tidak ditemukan — folder tidak lengkap.')
    setStatus('ERROR: app\\node.exe hilang')
    return
  }

  setStatus('First-run check...')
  if (!bootstrap(env)) {
    setStatus('ERROR: bootstrap database gagal — lihat pesan di atas')
    return
  }

  setStatus('Menjalankan server ChatBareng...')
  startServer(env)

  setStatus('Health check server...')
  const ok = await waitHealthy(15, 1000)
  if (!ok) {
    setStatus('WARNING: server tidak merespons /api/health dalam 15s — tetap mencoba')
  } else {
    serverState = 'JALAN (http://127.0.0.1:' + PORT + ')'
    render()
  }

  setStatus('Menjalankan tunnel publik...')
  startTunnel(env)
  const url = await waitTunnelUrl(60000)
  if (url && (await adoptTunnelUrl(url))) {
    tunnelState = 'AKTIF'
    render()
  } else {
    tunnelState = url ? 'URL belum merespons — watchdog coba lagi otomatis' : 'belum dapat URL (watchdog cari otomatis)'
    render()
  }

  setStatus('Semua siap. URL di data\\url.txt — berubah tiap restart.')
  startWatchdog(env)
}

main().catch((e) => {
  console.error('FATAL:', e)
  setStatus('FATAL: ' + e.message)
})