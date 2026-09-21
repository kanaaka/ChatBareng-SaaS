/**
 * v0.8.0 — Auto Backup Chat ke Google Drive (OAuth per-user, admin only)
 *
 * Aturan utama (spec wa-cs-hub-v0.8.0-spec.md):
 * - Scheduler IN-PROCESS (setInterval cek menit WIB) — pola anti-cron-eksternal.
 * - Reuse logic export v0.6.0 (history.js) → CSV — file ini punya salinan logika
 *   export yang identik; route /api/history TIDAK diubah sama sekali.
 * - Upload ke Drive v3 folder "WA CS Hub Backups" (find-or-create), scope drive.file.
 * - Refresh token AES-256-GCM (pola utils/crypto.js via MEDIA_ENCRYPTION_KEY).
 * - Retensi: simpan N file terakhir di folder, sisanya dihapus dari Drive.
 * - Anti double-run: in-memory lock (scheduler tick + manual backup-now bersama).
 * - Gagal → BackupLog error + GDriveLink.lastBackupStatus=error (tidak crash).
 * - Tidak ada link → skip senyap (log saja).
 * - Kredensial OAuth dari process.env GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET —
 *   TIDAK pernah di-hardcode. Env kosong → error jelas, bukan crash.
 */

const prisma = require('../prisma')
const { encrypt, decrypt } = require('../utils/crypto')
// v0.11.0 — CSV backup: dekrip content on-the-fly (pola sama dgn export v0.6.0)
const { decryptTextSafe } = require('./textCrypto')

// ─── Konstanta ───────────────────────────────────────────────────────────
const TIMEZONE = 'Asia/Jakarta'
const GDRIVE_FOLDER_NAME = 'WA CS Hub Backups'
const REDIRECT_URI_RELAY = 'https://locaspark.com/gdrive-oauth.php'
const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email',
]
const FREQUENCIES = ['daily', 'weekly', 'monthly']
const CHECK_INTERVAL_MS = 30 * 1000 // cek 2× per menit — fired-key mencegah dobel

// ─── WIB helpers (Asia/Jakarta, bukan timezone server) — pola autoReply.js ───
function wibDateString(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

function wibMinutesOfDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
  const [h, m] = parts.split(':').map(Number)
  return h * 60 + m
}

function wibDayOfWeek(date = new Date()) {
  const s = wibDateString(date) // "YYYY-MM-DD"
  const [y, mo, d] = s.split('-').map(Number)
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay() // 0=Minggu..6=Sabtu
}

// ─── Config PER-TENANT (pola AutoReplyConfig v0.7.0) ──
// v3.0 — Map tenantId → config (BackupConfig @@unique([tenantId])).
const configCache = new Map()

async function getConfig(tenantId) {
  const tid = Number(tenantId)
  if (!Number.isFinite(tid)) throw new Error('gdriveBackup.getConfig butuh tenantId')
  if (configCache.has(tid)) return configCache.get(tid)
  let cfg = await prisma.backupConfig.findUnique({ where: { tenantId: tid } })
  if (!cfg) {
    cfg = await prisma.backupConfig.create({ data: { tenantId: tid } }).catch(async (e) => {
      if (e.code === 'P2002') return prisma.backupConfig.findUnique({ where: { tenantId: tid } })
      throw e
    })
    console.log(`[GDriveBackup] Seeded BackupConfig (tenant ${tid}, enabled=false)`)
  }
  configCache.set(tid, cfg)
  return cfg
}

function invalidateConfig(tenantId) {
  if (tenantId === undefined) configCache.clear()
  else configCache.delete(Number(tenantId))
}

// ─── Kredensial OAuth dari env (JANGAN hardcode) ─────────────────────────
function getOAuthCredentials() {
  const clientId = (process.env.GDRIVE_CLIENT_ID || '').trim()
  const clientSecret = (process.env.GDRIVE_CLIENT_SECRET || '').trim()
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
}

// ─── Enkripsi refresh token (AES-256-GCM, pola utils/crypto.js) ─────────
function encryptToken(plain) {
  return encrypt(Buffer.from(String(plain), 'utf8')).toString('base64')
}
function decryptToken(encB64) {
  return decrypt(Buffer.from(String(encB64), 'base64')).toString('utf8')
}

// ─── HTTP helper untuk Google API (fetch bawaan Node, tanpa dependency) ──
async function gfetch(url, options = {}) {
  const res = await fetch(url, options)
  const text = await res.text()
  let body = text
  try {
    body = JSON.parse(text)
  } catch {
    /* biarkan string */
  }
  if (!res.ok) {
    const err = new Error(
      `Google API ${res.status}: ${typeof body === 'object' && body ? JSON.stringify(body) : String(text).slice(0, 300)}`
    )
    err.status = res.status
    err.body = body
    throw err
  }
  return body
}

async function exchangeAccessToken(link, { forceRefresh = false } = {}) {
  const cred = getOAuthCredentials()
  if (!cred) {
    const e = new Error('OAuth Google belum dikonfigurasi (GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET kosong)')
    e.code = 'NO_CREDENTIALS'
    throw e
  }
  if (!forceRefresh && link._cachedAccessToken) return link._cachedAccessToken
  const tokenRes = await gfetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cred.clientId,
      client_secret: cred.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: decryptToken(link.refreshTokenEnc),
    }),
  })
  if (!tokenRes.access_token) {
    throw new Error('Google tidak mengembalikan access_token dari refresh_token')
  }
  link._cachedAccessToken = tokenRes.access_token
  return tokenRes.access_token
}

// Jalankan fn dengan access token; kalau 401/invalid token → refresh sekali & coba lagi
async function withAccessToken(link, fn) {
  let token = await exchangeAccessToken(link)
  try {
    return await fn(token)
  } catch (e) {
    if (e && (e.status === 401 || e.status === 403)) {
      // coba sekali lagi dengan refresh paksa
      token = await exchangeAccessToken(link, { forceRefresh: true })
      return await fn(token)
    }
    throw e
  }
}

// ─── Drive v3 helpers (folder + upload multipart + retensi) ──────────────
async function findBackupFolder(token) {
  const q = `name = '${GDRIVE_FOLDER_NAME.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
  const res = await gfetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=10`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  return res.files && res.files.length ? res.files[0] : null
}

async function createBackupFolder(token) {
  return gfetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: GDRIVE_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
  })
}

async function findOrCreateBackupFolder(token) {
  const existing = await findBackupFolder(token)
  if (existing) return existing
  return createBackupFolder(token)
}

async function uploadCsvToFolder(token, folderId, fileName, csvBuffer) {
  const boundary = 'wa-cs-hub-backup-' + Math.random().toString(36).slice(2)
  const metadata = JSON.stringify({
    name: fileName,
    parents: [folderId],
    mimeType: 'text/csv',
  })
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${metadata}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/csv; charset=UTF-8\r\n\r\n`
  const tail = `\r\n--${boundary}--`
  const payload = Buffer.concat([Buffer.from(body, 'utf8'), csvBuffer, Buffer.from(tail, 'utf8')])
  return gfetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'Content-Length': String(payload.length),
    },
    body: payload,
  })
}

async function listFolderFiles(token, folderId) {
  const q = `'${folderId}' in parents and trashed = false`
  const res = await gfetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&orderBy=createdTime desc&fields=files(id,name,createdTime)&pageSize=200`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  return res.files || []
}

async function deleteDriveFile(token, fileId) {
  await gfetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
}

// ─── Generate CSV backup (reuse logic export v0.6.0 — history.js) ────────
// Salinan logika build payload export dari src/routes/history.js (range=all),
// diratakan jadi CSV satu-baris-per-pesan. Route existing TIDAK diubah.
const pad2 = (n) => String(n).padStart(2, '0')

function isoOrNull(d) {
  if (!d) return null
  const date = d instanceof Date ? d : new Date(d)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function csvEscape(v) {
  if (v === null || v === undefined) return ''
  let s = String(v)
  if (s === '\u0000') return '' // konvensi null vs '' dari history.js
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

function backupFilename(date = new Date()) {
  const d = wibDateString(date) // WIB eksplisit
  const { h, m } = (() => {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date)
    const [hh, mm] = parts.split(':')
    return { h: hh, m: mm }
  })()
  return `wa-cs-hub-backup-${d}-${h}${m}.csv`
}

async function generateBackupCsv(tenantId = null) {
  const [users, chats] = await Promise.all([
    prisma.user.findMany({
      where: tenantId != null ? { tenantId, role: { not: 'super_admin' } } : {},
      select: { username: true, role: true },
      orderBy: { id: 'asc' },
    }),
    prisma.chat.findMany({
      where: tenantId != null ? { tenantId } : {},
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

  const HEADER = [
    'chatId',
    'contactPhone',
    'contactName',
    'phoneJid',
    'status',
    'resolvedAt',
    'createdAt',
    'lastMessageAt',
    'assignedToUsername',
    'firstAssignedAt',
    'lastAssignedAt',
    'firstIncomingAt',
    'firstResponseAt',
    'csMessagesSent',
    'reopenedCount',
    'messagesBeforeResolve',
    'contactBirthDate',
    'contactGender',
    'contactCity',
    'contactNote',
    'tags',
    'messageDirection',
    'messageContent',
    'messageSenderName',
    'messageSenderUsername',
    'messageTimestamp',
    'messageStatus',
    'messageWaMessageId',
    'messagePurged',
    'messageMediaType',
    'messageMediaMime',
    'messageMediaSize',
    'messageMediaPath',
  ]

  const lines = [HEADER.join(',')]
  for (const c of chats) {
    const chatCols = [
      c.id,
      c.contactPhone,
      c.contactName,
      c.phoneJid,
      c.status,
      isoOrNull(c.resolvedAt),
      isoOrNull(c.createdAt),
      isoOrNull(c.lastMessageAt),
      c.assignedTo?.username || null,
      isoOrNull(c.firstAssignedAt),
      isoOrNull(c.lastAssignedAt),
      isoOrNull(c.firstIncomingAt),
      isoOrNull(c.firstResponseAt),
      c.csMessagesSent,
      c.reopenedCount,
      c.messagesBeforeResolve,
      c.contact ? isoOrNull(c.contact.birthDate) : null,
      c.contact ? c.contact.gender : null,
      c.contact ? c.contact.city : null,
      c.contact ? c.contact.note : null,
      c.tags.map((ct) => `${ct.tag.name}:${ct.tag.color}`).join(';'),
    ]
    const chatPrefix = chatCols.map(csvEscape).join(',')
    if (c.messages.length === 0) {
      lines.push(chatPrefix + ',' + HEADER.slice(21).map(() => '').join(','))
      continue
    }
    for (const m of c.messages) {
      const msgCols = [
        m.direction,
        decryptTextSafe(m.content), // v0.11.0 — CSV backup tetap plaintext
        m.senderName,
        m.sender?.username || null,
        isoOrNull(m.timestamp),
        m.status,
        m.waMessageId,
        m.purged ? 'true' : 'false',
        m.mediaType,
        m.mediaMime,
        m.mediaSize,
        m.mediaPath,
      ]
      lines.push(chatPrefix + ',' + msgCols.map(csvEscape).join(','))
    }
  }
  // Trailer baris meta (data users seperti export v0.6.0 — username+role saja)
  lines.push('')
  lines.push(`# users: ${users.map((u) => `${u.username}:${u.role}`).join(';')}`)

  return { buffer: Buffer.from(lines.join('\r\n') + '\r\n', 'utf8'), filename: backupFilename() }
}

// ─── Jadwal: apakah sekarang (WIB) cocok dengan config? ─────────────────
function scheduleDue(cfg, date = new Date()) {
  if (!cfg || !cfg.enabled) return false
  const hour = wibMinutesOfDay(date) >= cfg.hour * 60 && wibMinutesOfDay(date) < (cfg.hour + 1) * 60
  if (!hour) return false
  if (cfg.frequency === 'weekly') return wibDayOfWeek(date) === cfg.dayOfWeek
  if (cfg.frequency === 'monthly') {
    const dom = Number(wibDateString(date).split('-')[2])
    return dom === cfg.dayOfMonth
  }
  return cfg.frequency === 'daily'
}

// Fired-key: sekali per blok jadwal per hari (anti dobel walau interval 30s
// atau restart di tengah blok jam). key = tanggalWIB-freq-jam
function firedKey(cfg, date = new Date()) {
  return `${wibDateString(date)}-${cfg.frequency}-h${cfg.hour}`
}

// ─── Anti double-run: in-memory lock ─────────────────────────────────────
let isRunning = false
let runningInfo = null

function tryAcquireLock(info) {
  if (isRunning) return false
  isRunning = true
  runningInfo = { ...info, startedAt: new Date().toISOString() }
  return true
}

function releaseLock() {
  isRunning = false
  runningInfo = null
}

// ─── Backup job utama ────────────────────────────────────────────────────
/**
 * Jalankan backup untuk satu user (link).
 * @param {number} userId
 * @param {object} opts - { reason: 'schedule'|'manual' }
 * @returns {Promise<{ok: boolean, skipped?: string, fileName?: string, error?: string}>}
 */
async function runBackupJob(userId, opts = {}) {
  const reason = opts.reason || 'manual'
  if (!tryAcquireLock({ userId, reason })) {
    console.log(`[GDriveBackup] Job sedang berjalan (lock) — skip trigger ${reason} utk user ${userId}`)
    return { ok: false, skipped: 'locked', error: 'Backup lain sedang berjalan, coba lagi nanti' }
  }
  try {
    const link = await prisma.gDriveLink.findUnique({ where: { userId } })
    if (!link) {
      console.log(`[GDriveBackup] Tidak ada GDriveLink utk user ${userId} — skip (${reason})`)
      return { ok: false, skipped: 'not_linked', error: 'Google Drive belum terhubung' }
    }

    let fileName = null
    let sizeBytes = 0
    try {
      // 1) Access token (refresh_token → access_token)
      const token = await exchangeAccessToken(link)

      // 2) Folder find-or-create
      const folder = await withAccessToken(link, (t) => findOrCreateBackupFolder(t))

      // 3) Generate CSV (reuse logic export v0.6.0) — scope TENANT dari link user
      const owner = await prisma.user.findUnique({ where: { id: userId }, select: { tenantId: true } })
      const csv = await generateBackupCsv(owner?.tenantId ?? null)
      fileName = csv.filename
      sizeBytes = csv.buffer.length

      // 4) Upload multipart
      await withAccessToken(link, (t) => uploadCsvToFolder(t, folder.id, fileName, csv.buffer))

      // 5) Retensi: hapus file di luar N terakhir (orderBy createdTime desc)
      const cfg = await getConfig(owner?.tenantId)
      const files = await withAccessToken(link, (t) => listFolderFiles(t, folder.id))
      const keep = new Set([fileName])
      let deleted = 0
      for (let i = 0; i < files.length; i++) {
        if (keep.has(files[i].name)) {
          keep.delete(files[i].name)
          continue
        }
        if (i >= cfg.retentionCount) {
          try {
            await withAccessToken(link, (t) => deleteDriveFile(t, files[i].id))
            deleted++
          } catch (delErr) {
            console.error(`[GDriveBackup] Gagal hapus file lama ${files[i].name}:`, delErr.message)
          }
        }
      }

      // 6) Sukses → BackupLog + update GDriveLink
      await prisma.backupLog.create({
        data: { userId, fileName, sizeBytes, status: 'success', error: null },
      })
      await prisma.gDriveLink.update({
        where: { userId },
        data: { lastBackupAt: new Date(), lastBackupStatus: 'success', lastBackupError: null },
      })
      console.log(`[GDriveBackup] Sukses (${reason}): ${fileName} (${sizeBytes} bytes), retensi hapus ${deleted} file`)
      return { ok: true, fileName, sizeBytes, deletedOld: deleted }
    } catch (e) {
      // Gagal tetap → BackupLog error + lastBackupStatus=error
      const msg = e.message || 'Unknown error'
      const needRelink = /invalid_grant|invalid_client|Token has been expired|revoked/i.test(msg)
      const humanMsg = needRelink ? `${msg} — hubungkan ulang Google Drive` : msg
      console.error(`[GDriveBackup] GAGAL (${reason}) utk user ${userId}:`, msg)
      await prisma.backupLog
        .create({
          data: {
            userId,
            fileName: fileName || backupFilename(),
            sizeBytes,
            status: 'error',
            error: humanMsg.slice(0, 500),
          },
        })
        .catch((logErr) => console.error('[GDriveBackup] Gagal tulis BackupLog error:', logErr.message))
      await prisma.gDriveLink
        .update({
          where: { userId },
          data: { lastBackupStatus: 'error', lastBackupError: humanMsg.slice(0, 500) },
        })
        .catch((uErr) => console.error('[GDriveBackup] Gagal update GDriveLink:', uErr.message))
      return { ok: false, error: humanMsg }
    }
  } finally {
    releaseLock()
  }
}

// ─── Scheduler in-process ────────────────────────────────────────────────
let schedulerTimer = null
let lastFiredKey = null

async function schedulerTick() {
  try {
    // v3 — config per tenant: ambil semua config enabled, cek due per tenant;
    // link user di-scope ke tenant masing-masing (tenant via userId).
    const cfgs = await prisma.backupConfig.findMany({ where: { enabled: true } })
    for (const cfg of cfgs) {
      if (!scheduleDue(cfg)) continue
      const key = firedKey(cfg)
      if (key === lastFiredKey) continue // sudah fire di blok jadwal ini
      const links = await prisma.gDriveLink.findMany({
        where: { user: { tenantId: cfg.tenantId } },
      })
      if (!links.length) {
        console.log(`[GDriveBackup] Jadwal cocok tenant ${cfg.tenantId} tapi belum ada Google Drive yang terhubung — skip`)
        lastFiredKey = key
        continue
      }
      lastFiredKey = key
      console.log(`[GDriveBackup] Jadwal terpicu (tenant ${cfg.tenantId}, ${cfg.frequency}, jam ${cfg.hour} WIB) — ${links.length} link`)
      for (const link of links) {
        await runBackupJob(link.userId, { reason: 'schedule' })
      }
    }
  } catch (e) {
    console.error('[GDriveBackup] schedulerTick error:', e.message)
  }
}

function initGDriveScheduler() {
  // v3 — seed config dipindah ke tenantSeed.seedTenantDefaults (per tenant);
  // di sini cukup start interval (tick membaca config per tenant).
  if (schedulerTimer) return
  schedulerTimer = setInterval(() => {
    schedulerTick()
  }, CHECK_INTERVAL_MS)
  console.log(`[GDriveBackup] Scheduler started (interval ${CHECK_INTERVAL_MS / 1000}s, WIB ${TIMEZONE})`)
}

function stopGDriveScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer)
    schedulerTimer = null
    console.log('[GDriveBackup] Scheduler stopped')
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────
module.exports = {
  TIMEZONE,
  GDRIVE_FOLDER_NAME,
  REDIRECT_URI_RELAY,
  OAUTH_SCOPES,
  FREQUENCIES,
  getConfig,
  invalidateConfig,
  getOAuthCredentials,
  encryptToken,
  decryptToken,
  wibDateString,
  wibMinutesOfDay,
  wibDayOfWeek,
  scheduleDue,
  firedKey,
  generateBackupCsv,
  backupFilename,
  runBackupJob,
  initGDriveScheduler,
  stopGDriveScheduler,
  isJobRunning: () => ({ isRunning, runningInfo }),
  exchangeAccessToken,
  revokeToken: async (token) => {
    return gfetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    })
  },
  fetchUserEmail: async (accessToken) => {
    const res = await gfetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    return res.email || null
  },
  gfetch,
}