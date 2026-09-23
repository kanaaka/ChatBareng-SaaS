/**
 * v0.7.0 — Auto Reply config API (admin only)
 * GET  /api/autoreply — baca config singleton
 * PUT  /api/autoreply — update config (validasi HH:mm, start<end, teks ≤1000 char,
 *                       placeholder diizinkan hanya {name})
 */
const express = require('express')
const router = express.Router()
const prisma = require('../prisma')
const { requireAuth, requireAdmin, requireTenant } = require('../auth')

// v3.0 — Isolasi tenant: AutoReply config = per-tenant
const rt = [requireAuth, requireTenant, requireAdmin]  // requireTenant dulu — super_admin wajib ?tenant= sebelum cek admin
const {
  getConfig,
  invalidateConfig,
  stripUnknownPlaceholders,
  TIME_RE,
  MAX_TEXT_LEN,
} = require('../services/autoReply')

// Validasi pasangan jam kerja per tipe hari
function validateHours(body, prefix, errors) {
  const enabled = body[`${prefix}Enabled`]
  if (enabled === undefined) return null
  const result = {}
  if (enabled !== undefined) result[`${prefix}Enabled`] = !!enabled

  const start = body[`${prefix}Start`]
  const end = body[`${prefix}End`]
  if (start !== undefined || end !== undefined) {
    if (typeof start !== 'string' || !TIME_RE.test(start)) {
      errors.push(`Jam mulai ${prefix.replace('Enabled', '')} tidak valid (format HH:mm)`)
    }
    if (typeof end !== 'string' || !TIME_RE.test(end)) {
      errors.push(`Jam selesai ${prefix.replace('Enabled', '')} tidak valid (format HH:mm)`)
    }
    if (errors.length === 0 && typeof start === 'string' && typeof end === 'string') {
      const [sh, sm] = start.split(':').map(Number)
      const [eh, em] = end.split(':').map(Number)
      if (sh * 60 + sm >= eh * 60 + em) {
        errors.push(`Jam mulai harus lebih kecil dari jam selesai (${prefix.replace('Enabled', '')})`)
      }
    }
    if (start !== undefined) result[`${prefix}Start`] = start
    if (end !== undefined) result[`${prefix}End`] = end
  }
  return result
}

function validateTextField(body, field, label, errors) {
  const raw = body[field]
  if (raw === undefined) return null
  if (typeof raw !== 'string') {
    errors.push(`${label} harus berupa teks`)
    return null
  }
  // Placeholder yang diizinkan hanya {name} — sisanya di-strip
  const cleaned = stripUnknownPlaceholders(raw)
  if (cleaned.length > MAX_TEXT_LEN) {
    errors.push(`${label} maksimal ${MAX_TEXT_LEN} karakter`)
    return null
  }
  return { [field]: cleaned }
}

// v0.13.0 — greetMode (D9): "text" (default, perilaku lama) | "menu" (delegasi ke Menu Gateway)
const GREET_MODES = ['text', 'menu']

// ── GET /api/autoreply (admin only) ──
router.get('/', ...rt, async (req, res) => {
  try {
    // v3.9 — ?slot= → config per-slot (fallback shared); tanpa slot = shared (compat)
    const slotRaw = req.query.slot
    if (slotRaw !== undefined) {
      const s = parseInt(slotRaw, 10)
      if (!Number.isFinite(s) || s < 0 || s > 2) return res.status(400).json({ error: 'Slot tidak valid (0..2)' })
      const svc = require('../services/autoReply')
      const cfg = await svc.getConfigForSlot(req.tenantId, s)
      return res.json({ config: cfg, numberSlot: cfg.numberSlot ?? null })
    }
    const cfg = await getConfig(req.tenantId)
    res.json({ config: cfg })
  } catch (e) {
    console.error('AutoReply GET error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/autoreply (admin only)
router.put('/', ...rt, async (req, res) => {
  try {
    const body = req.body || {}
    const errors = []

    await getConfig(req.tenantId) // pastikan config tenant ter-seed

    const data = {}

    // v3.9 — numberSlot: null/undefined = tetap; null = link-all (Semua nomor);
    // 0..2 = config Nomor ini saja. Row per-slot dibuat on-demand (upsert).
    let numberSlotSpecified = false
    let numberSlotValue = null
    if (body.numberSlot !== undefined) {
      numberSlotSpecified = true
      if (body.numberSlot === null || body.numberSlot === '' || body.numberSlot === 'all') {
        numberSlotValue = null // link-all
      } else {
        const s = parseInt(body.numberSlot, 10)
        if (!Number.isFinite(s) || s < 0 || s > 2) {
          return res.status(400).json({ error: 'numberSlot tidak valid (null / 0..2)' })
        }
        numberSlotValue = s
      }
    }

    // Toggle fitur
    if (body.outsideHoursEnabled !== undefined) data.outsideHoursEnabled = !!body.outsideHoursEnabled
    if (body.greetEnabled !== undefined) data.greetEnabled = !!body.greetEnabled

    // v0.13.0 — greetMode: opsional; validasi enum, simpan apa adanya (D9)
    if (body.greetMode !== undefined) {
      if (!GREET_MODES.includes(body.greetMode)) {
        return res.status(400).json({ error: 'greetMode harus "text" atau "menu"' })
      }
      data.greetMode = body.greetMode
      // v0.13.2 — menu hanya jalan lewat First-of-Day Greeting → mode menu = greeting nyala
      data.greetEnabled = true
    }

    // Teks (≤1000 char, placeholder hanya {name})
    const ohText = validateTextField(body, 'outsideHoursText', 'Teks Outside Hours', errors)
    if (ohText) Object.assign(data, ohText)
    const greetText = validateTextField(body, 'greetText', 'Teks Greeting', errors)
    if (greetText) Object.assign(data, greetText)

    // Jam operasional 3 tipe hari
    for (const prefix of ['monFri', 'sat', 'sun']) {
      const hours = validateHours(body, prefix, errors)
      if (hours) Object.assign(data, hours)
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: errors[0], errors })
    }

    // v3.9 — numberSlot mode: tulis ke row slot-spesifik (create on-demand) —
    // JANGAN menimpa config shared. Tanpa mode itu → update config shared (compat).
    let cfg
    if (numberSlotSpecified && numberSlotValue !== null) {
      cfg = await prisma.autoReplyConfig.upsert({
        where: { tenantId: req.tenantId },
        update: {},
        create: { tenantId: req.tenantId },
      })
      // Bila row shared JUGA belum ada → salin nilai lama dulu (clone), lalu update
      cfg = await prisma.autoReplyConfig.create({
        data: { tenantId: req.tenantId, numberSlot: numberSlotValue, ...data, updatedById: req.user.id },
      }).catch(async (e) => {
        if (e.code !== 'P2002') throw e
        // row per-slot sudah ada → update dia
        return prisma.autoReplyConfig.update({
          where: { tenantId_numberSlot: { tenantId: req.tenantId, numberSlot: numberSlotValue } },
          data: { ...data, updatedById: req.user.id },
        })
      })
    } else {
      if (numberSlotSpecified) data.numberSlot = null // eksplisit link-all
      cfg = await prisma.autoReplyConfig.update({
        where: { tenantId: req.tenantId },
        data: { ...data, updatedById: req.user.id },
      })
    }

    invalidateConfig(req.tenantId) // cache service invalid → config baru aktif

    // v0.13.2 — SINKRON 2 ARAH (feedback Kanaka 02:44): radio greeting = satu saklar
    // efektif bersama toggle di Menu Gateway. mode menu → gateway ON; mode text →
    // gateway OFF + release chat yang masih menunggu menu (konsisten D12).
    let menuGatewayEnabled = null
    if (data.greetMode !== undefined) {
      const menuGatewaySvc = require('../services/menuGateway')
      if (data.greetMode === 'menu') {
        await prisma.menuGatewayConfig.upsert({
          where: { tenantId: req.tenantId },
          update: { enabled: true, updatedById: req.user.id },
          create: { tenantId: req.tenantId, enabled: true, updatedById: req.user.id },
        })
        menuGatewayEnabled = true
      } else {
        const off = await prisma.menuGatewayConfig.updateMany({ where: { tenantId: req.tenantId }, data: { enabled: false } })
        menuGatewayEnabled = false
        if (off.count > 0) {
          await menuGatewaySvc.releaseAwaiting(req.tenantId, false).catch(e => console.error('[AutoReply] releaseAwaiting:', e.message))
        }
      }
      menuGatewaySvc.invalidateConfig(req.tenantId)
    }

    res.json({ config: cfg, menuGatewayEnabled })
  } catch (e) {
    console.error('AutoReply PUT error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router