const express = require('express')
const router = express.Router()
const { requireAuth, requireAdmin, requireTenant } = require('../auth')
const wa = require('../wa/pool')
const config = require('../config')

// v3.2 — Semua endpoint WA scoped per tenant (requireTenant men-set req.tenantId).
// WA_DISABLED=1 → status balik { connected:false, disabled:true } tanpa menyentuh Baileys.
const rt = [requireAuth, requireTenant]

// GET /api/wa/status — status WA tenant ini
router.get('/status', ...rt, (req, res) => {
  try {
    res.json(wa.getStatusForTenant(req.tenantId))
  } catch (e) {
    console.error('[WA route] status error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/wa/qr — QR login tenant ini (data URL). Kalau sudah connected → 400.
router.get('/qr', ...rt, async (req, res) => {
  try {
    const status = wa.getStatusForTenant(req.tenantId)
    if (status.disabled) {
      return res.status(400).json({ error: 'WhatsApp disabled (WA_DISABLED=1)', disabled: true })
    }
    if (!status.qrNeeded) {
      return res.status(400).json({ error: 'QR not needed. WhatsApp is ' + status.state })
    }
    const qrDataUrl = await wa.getQRDataUrl(req.tenantId)
    if (!qrDataUrl) {
      return res.status(404).json({ error: 'QR not available yet — tunggu beberapa detik lalu coba lagi' })
    }
    res.json({ qrDataUrl })
  } catch (e) {
    console.error('[WA route] qr error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/wa/phone — nomor terhubung tenant ini (ringkas)
router.get('/phone', ...rt, (req, res) => {
  try {
    const status = wa.getStatusForTenant(req.tenantId)
    res.json({ phoneNumber: status.phoneNumber || null, connected: status.connected, disabled: !!status.disabled })
  } catch (e) {
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/wa/reconnect (admin only) — soft disconnect + connect lagi (per-tenant)
router.post('/reconnect', ...rt, requireAdmin, async (req, res) => {
  try {
    const status = wa.getStatusForTenant(req.tenantId)
    if (status.disabled) {
      return res.status(400).json({ error: 'WhatsApp disabled (WA_DISABLED=1)', disabled: true })
    }
    await wa.reconnectTenant(req.tenantId)
    res.json({ message: 'Reconnect dimulai', status: wa.getStatusForTenant(req.tenantId) })
  } catch (e) {
    console.error('[WA route] reconnect error:', e)
    res.status(500).json({ error: e.message || 'Internal server error' })
  }
})

// POST /api/wa/logout (admin only) — logout + hapus sesi tenant ini.
// Butuh konfirmasi: ?confirm=true atau body { confirm: true }.
router.post('/logout', ...rt, requireAdmin, async (req, res) => {
  try {
    const status = wa.getStatusForTenant(req.tenantId)
    if (status.disabled) {
      return res.status(400).json({ error: 'WhatsApp disabled (WA_DISABLED=1)', disabled: true })
    }
    const confirmed = req.query.confirm === 'true' || req.body?.confirm === true
    if (!confirmed) {
      return res.status(400).json({ error: 'Konfirmasi diperlukan: kirim ?confirm=true' })
    }
    await wa.logoutTenant(req.tenantId)
    res.json({ message: 'Logout WhatsApp berhasil. Scan QR ulang untuk connect.', status: wa.getStatusForTenant(req.tenantId) })
  } catch (e) {
    console.error('[WA route] logout error:', e)
    res.status(500).json({ error: e.message || 'Internal server error' })
  }
})

// POST /api/wa/pairing-code (admin only) — minta kode pairing 8 digit (alternatif QR).
// Minimal viable: 1 kode per request (auto re-issue + TTL lifecycle = fase lanjut).
// Lesson v0.13.8b: browser sudah kanonik → IQ 400 tidak terjadi.
router.post('/pairing-code', ...rt, requireAdmin, async (req, res) => {
  try {
    const status = wa.getStatusForTenant(req.tenantId)
    if (status.disabled) {
      return res.status(400).json({ error: 'WhatsApp disabled (WA_DISABLED=1)', disabled: true })
    }
    const phone = String(req.body?.phone || '').replace(/[^0-9]/g, '')
    if (!/^\d{8,15}$/.test(phone)) {
      return res.status(400).json({ error: 'Nomor tidak valid — format 62xxx tanpa +/spasi' })
    }
    const st = wa.tenantState(req.tenantId)
    if (!st.sock || !['connecting', 'qr'].includes(st.connectionState)) {
      return res.status(409).json({ error: 'Pairing code hanya bisa diminta saat socket menunggu pairing (state: ' + st.connectionState + ')' })
    }
    const code = await st.sock.requestPairingCode(phone)
    res.json({ pairingCode: wa.formatPairingCode(code), issuedAt: new Date().toISOString() })
  } catch (e) {
    console.error('[WA route] pairing-code error:', e)
    res.status(500).json({ error: e.message || 'Internal server error' })
  }
})

module.exports = router