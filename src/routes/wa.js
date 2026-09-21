const express = require('express')
const router = express.Router()
const { requireAuth, requireAdmin, requireTenant } = require('../auth')
const wa = require('../wa/pool')
const config = require('../config')

const rt = [requireAuth, requireTenant]

// GET /api/wa/status — per tenant (v3). WA_DISABLED → { connected:false, disabled:true }
router.get('/status', ...rt, (req, res) => {
  res.json(wa.getStatusForTenant(req.tenantId))
})

// GET /api/wa/qr — fase 1 stub: selalu tidak tersedia (fase 2: QR per tenant)
router.get('/qr', ...rt, async (req, res) => {
  try {
    const status = wa.getStatusForTenant(req.tenantId)
    if (status.disabled) {
      return res.status(400).json({ error: 'WhatsApp disabled (WA_DISABLED=1)', disabled: true })
    }
    if (!status.qrNeeded) {
      return res.status(400).json({ error: 'QR not needed. WhatsApp is ' + status.state })
    }
    // Fase 2: QR per tenant dari pool
    return res.status(404).json({ error: 'QR not available (koneksi nyata = fase 2)' })
  } catch (e) {
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/wa/pairing-code — fase 1 stub: WA disabled / koneksi nyata = fase 2
router.post('/pairing-code', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (config.waDisabled) {
      return res.status(400).json({ error: 'WhatsApp disabled (WA_DISABLED=1)', disabled: true })
    }
    return res.status(503).json({ error: 'Pairing per-tenant tersedia di fase 2' })
  } catch (e) {
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/wa/reconnect (admin only) — fase 1 stub
router.post('/reconnect', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (config.waDisabled) {
      return res.status(400).json({ error: 'WhatsApp disabled (WA_DISABLED=1)', disabled: true })
    }
    return res.status(503).json({ error: 'Reconnect per-tenant tersedia di fase 2' })
  } catch (e) {
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/wa/logout (admin only) — fase 1 stub
router.post('/logout', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (config.waDisabled) {
      return res.status(400).json({ error: 'WhatsApp disabled (WA_DISABLED=1)', disabled: true })
    }
    return res.status(503).json({ error: 'Logout per-tenant tersedia di fase 2' })
  } catch (e) {
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router