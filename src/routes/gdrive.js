/**
 * v0.8.0 — Google Drive Auto Backup API (admin only)
 *
 * GET    /api/gdrive/status          — linked? email? config? 20 backup terakhir
 * GET    /api/gdrive/oauth/start     — generate URL consent Google (origin dari request;
 *                                      state=base64url JSON {origin,nonce}, nonce in-memory
 *                                      10 menit sekali pakai; relay locaspark redirect balik)
 * GET    /api/gdrive/oauth/callback  — validasi nonce → exchange code → encrypt refresh token
 *                                      (AES-256-GCM) → simpan → redirect /admin/backup?linked=1
 * DELETE /api/gdrive/disconnect      — revoke token ke Google + hapus GDriveLink
 * PUT    /api/gdrive/config          — update jadwal/retensi (validasi ketat)
 * POST   /api/gdrive/backup-now      — jalankan job backup manual (async, 202)
 *
 * Kredensial OAuth dari process.env GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET —
 * env kosong → error jelas (bukan crash).
 */

const express = require('express')
const router = express.Router()
const crypto = require('crypto')
const prisma = require('../prisma')
const { requireAuth, requireAdmin, requireTenant } = require('../auth')

// v3.0 — Isolasi tenant: BackupConfig per-tenant; GDriveLink per-user (tenant via user)
const plans = require('../services/plans') // v3.4 — feature gate Backup Google Drive (plan per-tenant)
const featGdriveBackupGate = plans.requireFeature('featGdriveBackup') // 403 ramah + upsell bila fitur OFF
const rt = [requireAuth, requireTenant, requireAdmin]  // requireTenant dulu — super_admin wajib ?tenant= sebelum cek admin
const {
  REDIRECT_URI_RELAY,
  OAUTH_SCOPES,
  FREQUENCIES,
  getConfig,
  invalidateConfig,
  getOAuthCredentials,
  encryptToken,
  decryptToken,
  runBackupJob,
  revokeToken,
  fetchUserEmail,
  exchangeAccessToken,
  gfetch,
} = require('../services/gdriveBackup')

// ─── Nonce anti-CSRF: in-memory, 10 menit, sekali pakai ──────────────────
const NONCE_TTL_MS = 10 * 60 * 1000
/** @type {Map<string, {createdAt: number, userId: number}>} */
const nonces = new Map()

function issueNonce(userId) {
  // bersihkan kadaluarsa
  const now = Date.now()
  for (const [k, v] of nonces) {
    if (now - v.createdAt > NONCE_TTL_MS) nonces.delete(k)
  }
  const nonce = crypto.randomBytes(24).toString('base64url')
  nonces.set(nonce, { createdAt: now, userId })
  return nonce
}

function consumeNonce(nonce) {
  if (!nonce) return null
  const entry = nonces.get(nonce)
  if (!entry) return null
  nonces.delete(nonce) // sekali pakai
  if (Date.now() - entry.createdAt > NONCE_TTL_MS) return null
  return entry
}

// ─── Origin dari request (BUKAN config — otomatis ikut tunnel aktif) ─────
function originFromRequest(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim()
  const host = req.headers.host || 'localhost'
  return `${proto}://${host}`
}

function base64urlJson(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url')
}

// ─── Routes ──────────────────────────────────────────────────────────────

// GET /api/gdrive/status (admin only)
router.get('/status', ...rt, featGdriveBackupGate, async (req, res) => {
  try {
    const cfg = await getConfig(req.tenantId)
    const link = await prisma.gDriveLink.findUnique({
      where: { userId: req.user.id },
      select: {
        email: true,
        linkedAt: true,
        lastBackupAt: true,
        lastBackupStatus: true,
        lastBackupError: true,
      },
    })
    const logs = await prisma.backupLog.findMany({
      where: { userId: req.user.id },
      orderBy: { uploadedAt: 'desc' },
      take: 20,
    })
    res.json({
      linked: !!link,
      link: link || null,
      config: cfg,
      logs,
      oauthConfigured: !!getOAuthCredentials(),
    })
  } catch (e) {
    console.error('GDrive status error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/gdrive/oauth/start (admin only) — balikin URL consent Google
router.get('/oauth/start', ...rt, featGdriveBackupGate, async (req, res) => {
  try {
    const cred = getOAuthCredentials()
    if (!cred) {
      return res.status(503).json({
        error:
          'OAuth Google belum dikonfigurasi di server (GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET kosong). Hubungi admin sistem.',
      })
    }
    const origin = originFromRequest(req)
    const nonce = issueNonce(req.user.id)
    const state = base64urlJson({ origin, nonce })
    const params = new URLSearchParams({
      client_id: cred.clientId,
      redirect_uri: REDIRECT_URI_RELAY,
      response_type: 'code',
      scope: OAUTH_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    })
    res.json({
      consentUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
      origin,
      state,
    })
  } catch (e) {
    console.error('GDrive oauth/start error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/gdrive/oauth/callback — dipanggil Google via relay locaspark (browser redirect)
router.get('/oauth/callback', async (req, res) => {
  const redirectAdmin = (q) => res.redirect(302, `/${q}`)
  try {
    const { code, state, error } = req.query

    // Google mengirim error (user menolak consent, dll)
    if (error) {
      console.error('GDrive oauth/callback error dari Google:', error)
      return redirectAdmin('#/admin/backup?linked=0&error=' + encodeURIComponent(String(error)))
    }
    if (!state || !code) {
      return res.status(400).send('Callback tidak valid: parameter state/code hilang')
    }

    // Decode state → validasi origin + nonce
    let parsed
    try {
      parsed = JSON.parse(Buffer.from(String(state), 'base64url').toString('utf8'))
    } catch {
      return res.status(400).send('State tidak valid (gagal decode)')
    }
    if (!parsed || !parsed.origin || !parsed.nonce) {
      return res.status(400).send('State tidak valid (field hilang)')
    }
    const entry = consumeNonce(parsed.nonce)
    if (!entry) {
      return res.status(400).send('Nonce tidak sah atau kedaluwarsa — ulangi "Hubungkan Google Drive"')
    }

    // Origin callback harus sama dengan origin saat start (anti state lintas host)
    const callbackOrigin = originFromRequest(req)
    if (parsed.origin.replace(/\/$/, '') !== callbackOrigin.replace(/\/$/, '')) {
      console.error(`GDrive oauth/callback origin mismatch: start=${parsed.origin} callback=${callbackOrigin}`)
      return res.status(400).send('Origin tidak cocok dengan yang memulai OAuth')
    }

    const cred = getOAuthCredentials()
    if (!cred) {
      return res.status(503).send('OAuth Google belum dikonfigurasi di server')
    }

    // Exchange code → tokens (server-side; secret tidak pernah keluar)
    let tokenRes
    try {
      tokenRes = await gfetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: cred.clientId,
          client_secret: cred.clientSecret,
          code: String(code),
          code_verifier: '',
          grant_type: 'authorization_code',
          redirect_uri: REDIRECT_URI_RELAY,
        }),
      })
    } catch (e) {
      console.error('GDrive oauth/callback exchange gagal:', e.message)
      return redirectAdmin('#/admin/backup?linked=0&error=' + encodeURIComponent('exchange_failed'))
    }
    if (!tokenRes.refresh_token || !tokenRes.access_token) {
      // Tanpa refresh_token (mis. akun sudah pernah consent tanpa prompt=consent) → gagal jelas
      return redirectAdmin('#/admin/backup?linked=0&error=' + encodeURIComponent('no_refresh_token'))
    }

    // Email akun Google (userinfo)
    let email = null
    try {
      email = await fetchUserEmail(tokenRes.access_token)
    } catch (e) {
      console.error('GDrive oauth/callback userinfo gagal:', e.message)
    }
    if (!email) email = 'unknown'

    // Upsert GDriveLink (1 user = 1 akun Google; relink menimpa)
    const enc = encryptToken(tokenRes.refresh_token)
    await prisma.gDriveLink.upsert({
      where: { userId: entry.userId },
      create: { userId: entry.userId, email, refreshTokenEnc: enc },
      update: { email, refreshTokenEnc: enc, lastBackupStatus: null, lastBackupError: null },
    })

    console.log(`[GDrive] OAuth link sukses utk user ${entry.userId} (${email})`)
    return redirectAdmin('#/admin/backup?linked=1')
  } catch (e) {
    console.error('GDrive oauth/callback error:', e)
    return res.status(500).send('Terjadi kesalahan saat menghubungkan Google Drive')
  }
})

// DELETE /api/gdrive/disconnect (admin only) — revoke token + hapus row
router.delete('/disconnect', ...rt, featGdriveBackupGate, async (req, res) => {
  try {
    const link = await prisma.gDriveLink.findUnique({ where: { userId: req.user.id } })
    if (!link) {
      return res.status(404).json({ error: 'Google Drive belum terhubung' })
    }
    // Revoke ke Google (best-effort — row tetap dihapus walau revoke gagal)
    let revoked = false
    let revokeError = null
    try {
      const token = await exchangeAccessToken(link)
      await revokeToken(token)
      revoked = true
    } catch (e) {
      revokeError = e.message
      console.error('[GDrive] revoke gagal (row tetap dihapus):', e.message)
    }
    await prisma.gDriveLink.delete({ where: { userId: req.user.id } })
    console.log(`[GDrive] Disconnect user ${req.user.id} (revoked=${revoked})`)
    res.json({ ok: true, revoked, revokeError })
  } catch (e) {
    console.error('GDrive disconnect error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/gdrive/config (admin only) — validasi ketat sesuai spec
router.put('/config', ...rt, featGdriveBackupGate, async (req, res) => {
  try {
    const body = req.body || {}
    const errors = []
    await getConfig(req.tenantId) // pastikan config tenant ter-seed

    const data = {}

    if (body.frequency !== undefined) {
      if (!FREQUENCIES.includes(body.frequency)) {
        errors.push(`Frekuensi harus salah satu dari: ${FREQUENCIES.join(', ')}`)
      } else {
        data.frequency = body.frequency
      }
    }
    if (body.hour !== undefined) {
      const h = Number(body.hour)
      if (!Number.isInteger(h) || h < 0 || h > 23) {
        errors.push('Jam harus angka bulat 0–23')
      } else {
        data.hour = h
      }
    }
    if (body.dayOfWeek !== undefined) {
      const d = Number(body.dayOfWeek)
      if (!Number.isInteger(d) || d < 0 || d > 6) {
        errors.push('Hari (dayOfWeek) harus angka bulat 0–6 (0=Minggu)')
      } else {
        data.dayOfWeek = d
      }
    }
    if (body.dayOfMonth !== undefined) {
      const d = Number(body.dayOfMonth)
      if (!Number.isInteger(d) || d < 1 || d > 28) {
        errors.push('Tanggal (dayOfMonth) harus angka bulat 1–28')
      } else {
        data.dayOfMonth = d
      }
    }
    if (body.retentionCount !== undefined) {
      const r = Number(body.retentionCount)
      if (!Number.isInteger(r) || r < 1) {
        errors.push('Retensi harus angka bulat ≥ 1')
      } else {
        data.retentionCount = r
      }
    }
    if (body.enabled !== undefined) {
      data.enabled = !!body.enabled
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: errors[0], errors })
    }
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'Tidak ada field yang valid untuk diupdate' })
    }

    const cfg = await prisma.backupConfig.update({ where: { tenantId: req.tenantId }, data })
    invalidateConfig(req.tenantId) // cache service invalid → config baru aktif
    res.json({ config: cfg })
  } catch (e) {
    console.error('GDrive config PUT error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/gdrive/backup-now (admin only) — async job, langsung 202
router.post('/backup-now', ...rt, featGdriveBackupGate, async (req, res) => {
  try {
    const link = await prisma.gDriveLink.findUnique({ where: { userId: req.user.id } })
    if (!link) {
      return res.status(400).json({
        error: 'Google Drive belum terhubung. Klik "Hubungkan Google Drive" dulu sebelum backup.',
      })
    }
    const oauthConfigured = !!getOAuthCredentials()
    if (!oauthConfigured) {
      return res.status(503).json({
        error: 'OAuth Google belum dikonfigurasi di server (GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET kosong).',
      })
    }
    // Jalankan async — 202 langsung (job bisa makan waktu; status cek via /status)
    runBackupJob(req.user.id, { reason: 'manual' }).catch((e) =>
      console.error('[GDrive] backup-now job error:', e)
    )
    res.status(202).json({ ok: true, message: 'Backup dimulai. Cek status & riwayat beberapa saat lagi.' })
  } catch (e) {
    console.error('GDrive backup-now error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router