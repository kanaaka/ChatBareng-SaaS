// v0.4.0 — Web Push routes. Semua requireAuth. Subscribe/unsubscribe hanya
// v3.0 — subscription milik user (tenant via userId join) — tanpa perubahan query.
// menyentuh subscription milik req.user sendiri.
const express = require('express')
const router = express.Router()
const prisma = require('../prisma')
const { requireAuth, requireAdmin } = require('../auth')
const push = require('../push')

// GET /api/push/public-key
router.get('/public-key', requireAuth, (req, res) => {
  res.json({ publicKey: push.getPublicKey() })
})

// POST /api/push/subscribe  body: { endpoint, keys: { p256dh, auth } }
router.post('/subscribe', requireAuth, async (req, res) => {
  try {
    const { endpoint, keys } = req.body || {}
    if (!endpoint || typeof endpoint !== 'string') {
      return res.status(400).json({ error: 'endpoint is required' })
    }
    const p256dh = keys?.p256dh
    const auth = keys?.auth
    if (!p256dh || !auth) {
      return res.status(400).json({ error: 'keys.p256dh and keys.auth are required' })
    }
    if (!/^(https?:)\/\//i.test(endpoint)) {
      return res.status(400).json({ error: 'endpoint must be a valid URL' })
    }

    const userAgent = req.headers['user-agent'] || null

    // Upsert by endpoint (endpoint unik global, tapi hanya boleh dimiliki user yg login sekarang)
    const sub = await prisma.pushSubscription.upsert({
      where: { endpoint },
      update: { userId: req.user.id, p256dh, auth, userAgent },
      create: { userId: req.user.id, endpoint, p256dh, auth, userAgent },
    })

    res.json({ success: true, id: sub.id })
  } catch (e) {
    console.error('Push subscribe error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/push/unsubscribe  body: { endpoint }
router.post('/unsubscribe', requireAuth, async (req, res) => {
  try {
    const { endpoint } = req.body || {}
    if (!endpoint || typeof endpoint !== 'string') {
      return res.status(400).json({ error: 'endpoint is required' })
    }
    // Hapus HANYA jika milik req.user (endpoint orang lain tidak boleh terhapus)
    const deleted = await prisma.pushSubscription.deleteMany({
      where: { endpoint, userId: req.user.id },
    })
    res.json({ success: true, deleted: deleted.count })
  } catch (e) {
    console.error('Push unsubscribe error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/push/test — kirim push test ke subscription milik sendiri
// v0.12.6 — bug fix: route ini sebelumnya require('web-push') langsung TANPA
// setVapidDetails → FCM nolak 401 "unauthenticated", tombol test gak pernah nyampe
// (jalur otomatis via src/push.js OK karena di-set di sana). Sekarang pakai helper
// sendToSubscription dari src/push.js (satu sumber kebenaran VAPID + auto-delete 410).
router.post('/test', requireAuth, requireAdmin, async (req, res) => {
  try {
    const subs = await prisma.pushSubscription.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
    })
    if (!subs.length) {
      return res.status(404).json({ error: 'Tidak ada subscription. Aktifkan notifikasi dulu di browser ini.' })
    }
    if (!push.isVapidConfigured()) {
      return res.status(500).json({ error: 'VAPID keys tidak ter-set di server — push disabled' })
    }
    const payload = {
      kind: 'test',
      title: '🔔 Test Push — WA CS Hub',
      body: `Push notification berjalan! (${new Date().toLocaleTimeString('id-ID')})`,
      url: '/',
    }
    let sent = 0
    await Promise.allSettled(subs.map(async s => {
      const ok = await push.sendToSubscription(s, payload)
      if (ok) sent++
    }))
    res.json({ success: true, subscriptions: subs.length, sent })
  } catch (e) {
    console.error('Push test error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router