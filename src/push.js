// v0.4.0 — Web Push wrapper (VAPID). Fire-and-forget helpers.
// JANGAN await fungsi di sini di jalur pesan masuk — cukup panggil dan biarkan jalan.
const webpush = require('web-push')
const config = require('./config')
const prisma = require('./prisma')

let vapidConfigured = false
try {
  if (config.vapidPublicKey && config.vapidPrivateKey) {
    webpush.setVapidDetails(
      config.vapidSubject || 'mailto:admin@example.com',
      config.vapidPublicKey,
      config.vapidPrivateKey
    )
    vapidConfigured = true
  } else {
    console.warn('[Push] VAPID keys missing in env — push disabled')
  }
} catch (e) {
  console.error('[Push] Failed to set VAPID details:', e.message)
}

// Plain-text preview, max ~120 char
function truncate(text, max = 120) {
  if (!text) return ''
  const s = String(text).replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

function isGone(err) {
  return err && (err.statusCode === 404 || err.statusCode === 410)
}

// Send one notification to one subscription row; auto-delete dead subs.
async function sendToSubscription(sub, payload) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: 3600 }
    )
    return true
  } catch (err) {
    if (isGone(err)) {
      // Subscription hangus (browser cleared / endpoint expired) → hapus
      prisma.pushSubscription
        .delete({ where: { id: sub.id } })
        .catch(() => {})
      return false
    }
    // 429/5xx sementara: log saja, jangan hapus
    console.error('[Push] send error:', err.statusCode || '', err.message)
    return false
  }
}

// Fire-and-forget ke semua subscription milik satu user.
// Pemanggil TIDAK perlu await.
function sendToUser(userId, payload) {
  if (!vapidConfigured) return Promise.resolve(false)
  return (async () => {
    try {
      const subs = await prisma.pushSubscription.findMany({ where: { userId } })
      if (!subs.length) return false
      const results = await Promise.allSettled(subs.map(s => sendToSubscription(s, payload)))
      return results.some(r => r.status === 'fulfilled' && r.value)
    } catch (e) {
      console.error('[Push] sendToUser error:', e.message)
      return false
    }
  })()
}

// Fire-and-forget ke user aktif SATU TENANT dengan role tertentu ('cs' | 'admin' | ...)
// v3.0 — sendToActiveRole(role) tanpa tenantId = GLOBAL (dihindari); jalur tenant
// WAJIB pakai sendToTenantActive / sendToActiveRole(tenantId, role, ...).
function sendToTenantActive(tenantId, payload, role = null) {
  if (!vapidConfigured) return Promise.resolve(false)
  return (async () => {
    try {
      const where = { status: 'active', tenantId }
      if (role) where.role = role
      const users = await prisma.user.findMany({
        where,
        select: { id: true },
      })
      await Promise.allSettled(users.map(u => sendToUser(u.id, payload)))
      return true
    } catch (e) {
      console.error('[Push] sendToTenantActive error:', e.message)
      return false
    }
  })()
}

function getPublicKey() {
  return config.vapidPublicKey || ''
}

module.exports = { sendToUser, sendToTenantActive, sendToSubscription, getPublicKey, truncate, isGone, isVapidConfigured: () => vapidConfigured }