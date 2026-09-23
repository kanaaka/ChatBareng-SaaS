const express = require('express')
const router = express.Router()
const { requireAuth, requireAdmin, requireTenant } = require('../auth')
const wa = require('../wa/pool')
const config = require('../config')

// v3.2 — Semua endpoint WA scoped per tenant (requireTenant men-set req.tenantId).
// WA_DISABLED=1 → status balik { connected:false, disabled:true } tanpa menyentuh Baileys.
const rt = [requireAuth, requireTenant]

// v3.9 — helper: slot dari query/body (default 0 — compat semua caller lama)
function slotFrom(req) {
  const raw = req.query.slot ?? req.body?.slot ?? 0
  const s = parseInt(raw, 10)
  if (!Number.isFinite(s) || s < 0 || s > wa.MAX_SLOT) return null
  return s
}

// GET /api/wa/status — status WA tenant ini (slot-0) + DAFTAR SLOT (v3.9 additive)
router.get('/status', ...rt, async (req, res) => {
  try {
    const s0 = wa.getStatusForTenant(req.tenantId, 0)
    // v3.9 — slots: daftar baris TenantNumber + status per-slot (additive field)
    let slots = []
    try {
      const rows = await wa.listTenantNumbers(req.tenantId)
      slots = rows.map((n) => ({
        id: n.id,
        slot: n.slot,
        label: n.label || null,
        routeMode: n.routeMode || 'pool',
        assignedAgentId: n.assignedAgentId || null,
        reassignOffline: !!n.reassignOffline,
        waSessionDir: n.waSessionDir || null,
        status: wa.getStatusForTenant(req.tenantId, n.slot),
      }))
    } catch (e) {
      console.error('[WA route] slots list error:', e.message)
    }
    // waMode tenant (additive)
    let waMode = 'pool'
    try {
      const tenant = await (require('../prisma')).tenant.findUnique({ where: { id: req.tenantId }, select: { waMode: true } })
      waMode = tenant?.waMode || 'pool'
    } catch {}
    res.json({ ...s0, slots, waMode })
  } catch (e) {
    console.error('[WA route] status error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/wa/qr — QR login tenant ini (data URL). Kalau sudah connected → 400.
// v3.9 — ?slot=0..2 (default 0)
router.get('/qr', ...rt, async (req, res) => {
  try {
    const slot = slotFrom(req)
    if (slot === null) return res.status(400).json({ error: 'Slot tidak valid (0..2)' })
    const status = wa.getStatusForTenant(req.tenantId, slot)
    if (status.disabled) {
      return res.status(400).json({ error: 'WhatsApp disabled (WA_DISABLED=1)', disabled: true })
    }
    if (!status.qrNeeded) {
      return res.status(400).json({ error: 'QR not needed. WhatsApp is ' + status.state })
    }
    const qrDataUrl = await wa.getQRDataUrl(req.tenantId, slot)
    if (!qrDataUrl) {
      return res.status(404).json({ error: 'QR not available yet — tunggu beberapa detik lalu coba lagi' })
    }
    res.json({ qrDataUrl, slot })
  } catch (e) {
    console.error('[WA route] qr error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/wa/phone — nomor terhubung tenant ini (ringkas)
router.get('/phone', ...rt, (req, res) => {
  try {
    const slot = slotFrom(req) ?? 0
    const status = wa.getStatusForTenant(req.tenantId, slot)
    res.json({ phoneNumber: status.phoneNumber || null, connected: status.connected, disabled: !!status.disabled, slot })
  } catch (e) {
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/wa/reconnect (admin only) — soft disconnect + connect lagi (per-tenant)
// v3.9 — body { slot } (default 0)
router.post('/reconnect', ...rt, requireAdmin, async (req, res) => {
  try {
    const slot = slotFrom(req)
    if (slot === null) return res.status(400).json({ error: 'Slot tidak valid (0..2)' })
    const status = wa.getStatusForTenant(req.tenantId, slot)
    if (status.disabled) {
      return res.status(400).json({ error: 'WhatsApp disabled (WA_DISABLED=1)', disabled: true })
    }
    await wa.reconnectTenant(req.tenantId, slot)
    res.json({ message: 'Reconnect dimulai', status: wa.getStatusForTenant(req.tenantId, slot) })
  } catch (e) {
    console.error('[WA route] reconnect error:', e)
    res.status(500).json({ error: e.message || 'Internal server error' })
  }
})

// POST /api/wa/logout (admin only) — logout + hapus sesi SLOT itu (v3.9).
// Butuh konfirmasi: ?confirm=true atau body { confirm: true }.
router.post('/logout', ...rt, requireAdmin, async (req, res) => {
  try {
    const slot = slotFrom(req)
    if (slot === null) return res.status(400).json({ error: 'Slot tidak valid (0..2)' })
    const status = wa.getStatusForTenant(req.tenantId, slot)
    if (status.disabled) {
      return res.status(400).json({ error: 'WhatsApp disabled (WA_DISABLED=1)', disabled: true })
    }
    const confirmed = req.query.confirm === 'true' || req.body?.confirm === true
    if (!confirmed) {
      return res.status(400).json({ error: 'Konfirmasi diperlukan: kirim ?confirm=true' })
    }
    await wa.logoutTenant(req.tenantId, slot)
    res.json({ message: 'Logout WhatsApp berhasil. Scan QR ulang untuk connect.', status: wa.getStatusForTenant(req.tenantId, slot) })
  } catch (e) {
    console.error('[WA route] logout error:', e)
    res.status(500).json({ error: e.message || 'Internal server error' })
  }
})

// POST /api/wa/pairing-code (admin only) — minta kode pairing 8 digit (alternatif QR).
// Minimal viable: 1 kode per request (auto re-issue + TTL lifecycle = fase lanjut).
// Lesson v0.13.8b: browser sudah kanonik → IQ 400 tidak terjadi.
// v3.9 — body { slot } (default 0)
router.post('/pairing-code', ...rt, requireAdmin, async (req, res) => {
  try {
    const slot = slotFrom(req)
    if (slot === null) return res.status(400).json({ error: 'Slot tidak valid (0..2)' })
    const status = wa.getStatusForTenant(req.tenantId, slot)
    if (status.disabled) {
      return res.status(400).json({ error: 'WhatsApp disabled (WA_DISABLED=1)', disabled: true })
    }
    const phone = String(req.body?.phone || '').replace(/[^0-9]/g, '')
    if (!/^\d{8,15}$/.test(phone)) {
      return res.status(400).json({ error: 'Nomor tidak valid — format 62xxx tanpa +/spasi' })
    }
    const st = wa.tenantState(req.tenantId, slot)
    if (!st.sock || !['connecting', 'qr'].includes(st.connectionState)) {
      return res.status(409).json({ error: 'Pairing code hanya bisa diminta saat socket menunggu pairing (state: ' + st.connectionState + ')' })
    }
    const code = await st.sock.requestPairingCode(phone)
    res.json({ pairingCode: wa.formatPairingCode(code), issuedAt: new Date().toISOString(), slot })
  } catch (e) {
    console.error('[WA route] pairing-code error:', e)
    res.status(500).json({ error: e.message || 'Internal server error' })
  }
})

// ═══ v3.9 — MANAJEMEN SLOT (tenant admin) ═══

// PUT /api/wa/numbers/:slot — update label / routeMode / assignedAgentId / reassignOffline
router.put('/numbers/:slot', ...rt, requireAdmin, async (req, res) => {
  try {
    const slot = parseInt(req.params.slot, 10)
    if (!Number.isFinite(slot) || slot < 0 || slot > wa.MAX_SLOT) {
      return res.status(400).json({ error: `Slot tidak valid (0..${wa.MAX_SLOT})` })
    }
    const data = {}
    if (req.body.label !== undefined) {
      const label = String(req.body.label || '').trim()
      if (label.length > 50) return res.status(400).json({ error: 'Label maksimal 50 karakter' })
      data.label = label === '' ? null : label
    }
    if (req.body.routeMode !== undefined) {
      if (!['pool', 'assigned'].includes(req.body.routeMode)) {
        return res.status(400).json({ error: 'routeMode harus pool|assigned' })
      }
      data.routeMode = req.body.routeMode
    }
    if (req.body.assignedAgentId !== undefined) {
      if (req.body.assignedAgentId === null) data.assignedAgentId = null
      else {
        const aid = parseInt(req.body.assignedAgentId, 10)
        if (!Number.isFinite(aid)) return res.status(400).json({ error: 'assignedAgentId tidak valid' })
        const agent = await (require('../prisma')).user.findFirst({ where: { id: aid, tenantId: req.tenantId, role: { in: ['cs', 'admin'] }, status: 'active' } })
        if (!agent) return res.status(400).json({ error: 'Agent tidak ditemukan di tenant ini (role cs/admin, aktif)' })
        data.assignedAgentId = aid
      }
    }
    if (req.body.reassignOffline !== undefined) data.reassignOffline = !!req.body.reassignOffline

    const row = await (require('../prisma')).tenantNumber.upsert({
      where: { tenantId_slot: { tenantId: req.tenantId, slot } },
      update: data,
      create: { tenantId: req.tenantId, slot, ...data },
    })
    res.json({ number: row })
  } catch (e) {
    console.error('[WA route] numbers/:slot update error:', e)
    res.status(500).json({ error: e.message || 'Internal server error' })
  }
})

// POST /api/wa/numbers — tambah slot (v3.9 fix BUG-12): cek kuota plan.maxNumbers (403 bila penuh, K4)
router.post('/numbers', ...rt, requireAdmin, async (req, res) => {
  try {
    const slot = parseInt(req.body.slot, 10)
    if (!Number.isFinite(slot) || slot < 0 || slot > wa.MAX_SLOT) {
      return res.status(400).json({ error: `Slot tidak valid (0..${wa.MAX_SLOT})` })
    }
    const prisma = require('../prisma')
    const plans = require('../services/plans')
    const existing = await prisma.tenantNumber.findUnique({ where: { tenantId_slot: { tenantId: req.tenantId, slot } } })
    if (existing) return res.status(409).json({ error: 'Slot ini sudah ada' })
    const plan = await plans.getPlan(req.tenantId)
    const maxN = (plan?.maxNumbers == null || !Number.isFinite(Number(plan.maxNumbers))) ? 1 : Math.max(0, Math.trunc(Number(plan.maxNumbers)))
    const effMax = Math.min(maxN, wa.MAX_SLOT + 1)
    const used = await prisma.tenantNumber.count({ where: { tenantId: req.tenantId } })
    if (used >= effMax) {
      return res.status(403).json({ error: `Kuota nomor penuh (${used}/${effMax}). Perbarui langganan/plan untuk menambah nomor.` })
    }
    const label = String(req.body.label || '').trim().slice(0, 50) || null
    const row = await prisma.tenantNumber.create({ data: { tenantId: req.tenantId, slot, label } })
    res.status(201).json({ number: row })
  } catch (e) {
    console.error('[WA route] numbers POST error:', e)
    res.status(500).json({ error: e.message || 'Internal server error' })
  }
})

// DELETE /api/wa/numbers/:slot — hapus slot (v3.9 fix BUG-12): logout dulu (slot-0 tidak boleh dihapus)
router.delete('/numbers/:slot', ...rt, requireAdmin, async (req, res) => {
  try {
    const slot = parseInt(req.params.slot, 10)
    if (!Number.isFinite(slot) || slot < 0 || slot > wa.MAX_SLOT) {
      return res.status(400).json({ error: `Slot tidak valid (0..${wa.MAX_SLOT})` })
    }
    if (slot === 0) return res.status(400).json({ error: 'Slot-0 (nomor utama) tidak bisa dihapus — gunakan logout WhatsApp saja' })
    const prisma = require('../prisma')
    const row = await prisma.tenantNumber.findUnique({ where: { tenantId_slot: { tenantId: req.tenantId, slot } } })
    if (!row) return res.status(404).json({ error: 'Slot tidak ditemukan' })
    try {
      await wa.logoutTenant(req.tenantId, slot) // end socket + hapus sesi dir slot ini
    } catch (logoutErr) {
      return res.status(409).json({ error: `Gagal logout slot ${slot}: ${logoutErr.message}. Slot tidak dihapus.` })
    }
    await prisma.tenantNumber.delete({ where: { id: row.id } })
    res.json({ ok: true, deletedSlot: slot })
  } catch (e) {
    console.error('[WA route] numbers DELETE error:', e)
    res.status(500).json({ error: e.message || 'Internal server error' })
  }
})

// PUT /api/wa/mode — tenant.waMode = pool | assigned | mix (admin tenant)
router.put('/mode', ...rt, requireAdmin, async (req, res) => {
  try {
    const mode = String(req.body?.mode || '')
    if (!['pool', 'assigned', 'mix'].includes(mode)) {
      return res.status(400).json({ error: 'mode harus pool|assigned|mix' })
    }
    const tenant = await (require('../prisma')).tenant.update({ where: { id: req.tenantId }, data: { waMode: mode } })
    res.json({ waMode: tenant.waMode })
  } catch (e) {
    console.error('[WA route] mode error:', e)
    res.status(500).json({ error: e.message || 'Internal server error' })
  }
})

module.exports = router