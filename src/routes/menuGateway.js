/**
 * v0.13.0 — Menu Gateway (Auto Reply Triage) API (admin only).
 *
 * Spec: wa-cs-hub-v0.13.0-menu-gateway-spec.md §8/§9.
 * GET    /api/menu-gateway          → { config: { ...cfg, options: [...] }, waitingCount }
 * PUT    /api/menu-gateway          → validasi keras (§8), upsert transaksional,
 *                                   invalidate cache; enabled=false → releaseAwaiting.
 * GET    /api/menu-gateway/waiting  → { count, chats: [...] } (chip + flyout dashboard).
 *
 * Konvensi pola: routes/autoreply.js + routes/appConfig.js (requireAuth+requireAdmin,
 * validate-first, 400 { error, errors }, 500 internal). Unknown field DITOLAK (400).
 * GreetMode TIDAK di endpoint ini — di PUT /api/autoreply (spec §8).
 */
const express = require('express')
const router = express.Router()
const prisma = require('../prisma')
const { requireAuth, requireAdmin, requireTenant } = require('../auth')

// v3.0 — Isolasi tenant: Menu Gateway = per-tenant
const plans = require('../services/plans') // v3.4 — feature gate Menu Gateway (plan per-tenant)
const featMenuGatewayGate = plans.requireFeature('featMenuGateway') // 403 ramah + upsell bila fitur OFF
const rt = [requireAuth, requireTenant, requireAdmin]  // requireTenant dulu — super_admin wajib ?tenant= sebelum cek admin
const menuGateway = require('../services/menuGateway')
const { stripUnknownPlaceholders } = require('../services/autoReply')

// ── Batas validasi (spec §3/§8) ─────────────────────────────────────────
const LIMITS = {
  introText: 1000, // {name}-only placeholder
  fallbackText: 500,
  label: 50,
  aliases: 200,
  aliasItems: 5,
  replyText: 500,
  optionsMin: 2,
  optionsMax: 8,
  timeoutSeconds: { min: 10, max: 3600 },
  timeoutMinutes: { min: 1, max: 60 },
}
const TIMEOUT_UNITS = ['seconds', 'minutes']
const REPEAT_FREQUENCIES = ['per_chat', 'daily', 'weekly']

const ALLOWED_TOP_FIELDS = new Set([
  'enabled', 'introText', 'fallbackText', 'fallbackTagId',
  'timeoutValue', 'timeoutUnit', 'repeatFrequency', 'options',
])
const ALLOWED_OPTION_FIELDS = new Set(['position', 'label', 'aliases', 'replyText', 'tagId'])

// Fallback field-level → message top-level (kontrak 400 { error, errors })
function topMessage(errors) {
  return (errors.find(e => e.startsWith('Field tidak dikenal')) || errors[0] || 'Payload tidak valid')
}

async function validateTagId(value, label, errors) {
  if (value === null || value === undefined) return null
  if (!Number.isInteger(value)) {
    errors.push(`${label} harus integer atau null`)
    return null
  }
  const tag = await prisma.tag.findUnique({ where: { id: value } })
  if (!tag) {
    errors.push(`${label} tidak valid — tag tidak ditemukan`)
    return null
  }
  return value
}

// ── Validasi KERAS §8 — return { data } tanpa options, atau null (errors terisi) ──
async function validatePayload(body, errors) {
  const bodyKeys = Object.keys(body || {})
  for (const key of bodyKeys) {
    if (!ALLOWED_TOP_FIELDS.has(key)) errors.push(`Field tidak dikenal: ${key}`)
  }
  if (errors.length > 0) return null
  if (bodyKeys.length === 0) {
    errors.push('Tidak ada field yang valid untuk diupdate')
    return null
  }

  const data = {}

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') {
      errors.push('enabled harus boolean')
    } else {
      data.enabled = body.enabled
    }
  }

  if (body.introText !== undefined) {
    if (typeof body.introText !== 'string') {
      errors.push('introText harus berupa teks')
    } else {
      const cleaned = stripUnknownPlaceholders(body.introText) // placeholder {name}-only
      if (cleaned.length > LIMITS.introText) {
        errors.push(`introText maksimal ${LIMITS.introText} karakter`)
      } else if (cleaned.trim().length === 0) {
        errors.push('introText wajib diisi (menu intro yang dikirim ke pelanggan)')
      } else {
        data.introText = cleaned
      }
    }
  }

  if (body.fallbackText !== undefined) {
    if (typeof body.fallbackText !== 'string') {
      errors.push('fallbackText harus berupa teks')
    } else {
      const cleaned = stripUnknownPlaceholders(body.fallbackText)
      if (cleaned.length > LIMITS.fallbackText) {
        errors.push(`fallbackText maksimal ${LIMITS.fallbackText} karakter`)
      } else if (cleaned.trim().length === 0) {
        errors.push('fallbackText wajib diisi (dipakai saat jawaban tidak cocok)')
      } else {
        data.fallbackText = cleaned
      }
    }
  }

  if (body.fallbackTagId !== undefined) {
    data.fallbackTagId = await validateTagId(body.fallbackTagId, 'fallbackTagId', errors)
  }

  if (body.timeoutValue !== undefined && !Number.isInteger(body.timeoutValue)) {
    errors.push('timeoutValue harus integer')
  }
  if (body.timeoutUnit !== undefined && !TIMEOUT_UNITS.includes(body.timeoutUnit)) {
    errors.push('timeoutUnit harus "seconds" atau "minutes"')
  }
  // Range bergantung unit — cek hanya bila keduanya valid
  if (
    body.timeoutValue !== undefined && Number.isInteger(body.timeoutValue) &&
    (body.timeoutUnit === undefined || TIMEOUT_UNITS.includes(body.timeoutUnit))
  ) {
    const unit = body.timeoutUnit !== undefined ? body.timeoutUnit : 'minutes'
    const val = body.timeoutValue
    if (unit === 'seconds') {
      if (val < LIMITS.timeoutSeconds.min || val > LIMITS.timeoutSeconds.max) {
        errors.push(`timeoutValue untuk unit seconds harus ${LIMITS.timeoutSeconds.min}..${LIMITS.timeoutSeconds.max} detik`)
      }
    } else {
      if (val < LIMITS.timeoutMinutes.min || val > LIMITS.timeoutMinutes.max) {
        errors.push(`timeoutValue untuk unit minutes harus ${LIMITS.timeoutMinutes.min}..${LIMITS.timeoutMinutes.max} menit`)
      }
    }
    // v0.13.3 HOTFIX (bug report Kanaka 06:05) — PERSIST: timeoutValue/timeoutUnit
    // tervalidasi tapi tidak pernah ditulis ke `data` (bug sejak v0.13.0: PUT lulus
    // validasi, updatedAt berubah, field tidak tersimpan → UI selalu balik ke menit).
    // errors di sini tidak masalah: validatePayload return null di akhir bila ada
    // error → data dibuang juga.
    data.timeoutValue = val
    data.timeoutUnit = unit
  }

  if (body.repeatFrequency !== undefined) {
    if (!REPEAT_FREQUENCIES.includes(body.repeatFrequency)) {
      errors.push('repeatFrequency harus salah satu dari: per_chat, daily, weekly')
    } else {
      data.repeatFrequency = body.repeatFrequency
    }
  }

  // ── Options array 2..8 ──
  if (body.options !== undefined) {
    const options = body.options
    if (!Array.isArray(options)) {
      errors.push('options harus array')
    } else if (options.length < LIMITS.optionsMin) {
      errors.push(`options minimal ${LIMITS.optionsMin} item`)
    } else if (options.length > LIMITS.optionsMax) {
      errors.push(`options maksimal ${LIMITS.optionsMax} item`)
    } else {
      const seen = new Set()
      const parsed = []
      for (let i = 0; i < options.length; i++) {
        const o = options[i] || {}
        for (const key of Object.keys(o)) {
          if (!ALLOWED_OPTION_FIELDS.has(key)) errors.push(`Field tidak dikenal pada options[${i}]: ${key}`)
        }
        if (!Number.isInteger(o.position)) {
          errors.push(`options[${i}].position harus integer 1..${LIMITS.optionsMax}`)
        } else if (o.position < 1 || o.position > LIMITS.optionsMax) {
          errors.push(`options[${i}].position harus 1..${LIMITS.optionsMax}`)
        } else if (seen.has(o.position)) {
          errors.push(`options[${i}].position duplikat: ${o.position}`)
        } else {
          seen.add(o.position)
        }
        if (typeof o.label !== 'string' || o.label.trim().length === 0) {
          errors.push(`options[${i}].label wajib diisi (maks ${LIMITS.label} karakter)`)
        } else if (o.label.length > LIMITS.label) {
          errors.push(`options[${i}].label maksimal ${LIMITS.label} karakter`)
        }
        let aliases = ''
        if (o.aliases === undefined || o.aliases === null) {
          aliases = ''
        } else if (typeof o.aliases !== 'string') {
          errors.push(`options[${i}].aliases harus csv string`)
        } else {
          aliases = o.aliases
          if (aliases.length > LIMITS.aliases) {
            errors.push(`options[${i}].aliases maksimal ${LIMITS.aliases} karakter`)
          }
          const items = aliases.split(',').map(a => a.trim()).filter(Boolean)
          if (items.length > LIMITS.aliasItems) {
            errors.push(`options[${i}].aliases maksimal ${LIMITS.aliasItems} item (csv)`)
          }
        }
        let replyText = ''
        if (o.replyText === undefined || o.replyText === null) {
          replyText = ''
        } else if (typeof o.replyText !== 'string') {
          errors.push(`options[${i}].replyText harus berupa teks`)
        } else {
          replyText = stripUnknownPlaceholders(o.replyText)
          if (replyText.length > LIMITS.replyText) {
            errors.push(`options[${i}].replyText maksimal ${LIMITS.replyText} karakter`)
          }
        }
        let tagId = null
        if (o.tagId !== undefined && o.tagId !== null) {
          tagId = await validateTagId(o.tagId, `options[${i}].tagId`, errors)
        }
        parsed.push({ position: o.position, label: o.label, aliases, replyText, tagId })
      }

      // ≥1 opsi wajib punya replyText non-kosong (§8)
      if (!parsed.some(o => (o.replyText || '').trim().length > 0)) {
        errors.push('Minimal 1 opsi wajib punya replyText')
      }

      if (errors.length > 0) return null
      // Urutkan by position — deterministik terhadap urutan input
      parsed.sort((a, b) => a.position - b.position)
      data.options = parsed
    }
  }

  if (errors.length > 0) return null
  return { data }
}

// ── GET /api/menu-gateway (admin) ───────────────────────────────────────
router.get('/', ...rt, featMenuGatewayGate, async (req, res) => {
  try {
    // v3.9 — ?slot= → config per-slot (fallback shared); tanpa slot = shared (compat)
    const slotRaw = req.query.slot
    let cfg
    if (slotRaw !== undefined) {
      const s = parseInt(slotRaw, 10)
      if (!Number.isFinite(s) || s < 0 || s > 2) return res.status(400).json({ error: 'Slot tidak valid (0..2)' })
      cfg = await menuGateway.getConfigForSlot(req.tenantId, s)
    } else {
      cfg = await menuGateway.getConfig(req.tenantId)
    }
    const waitingCount = await menuGateway.countWaiting(req.tenantId)
    // v0.13.2 — greetMode/greetEnabled ikut dikirim (sumber tampilan radio Auto Reply;
    // enabled = satu saklar efektif bersama radio greeting — sync 2 arah)
    const autoCfg = await prisma.autoReplyConfig.findUnique({ where: { tenantId: req.tenantId }, select: { greetEnabled: true, greetMode: true } })
    res.json({ config: cfg, waitingCount, greetEnabled: autoCfg?.greetEnabled ?? false, greetMode: autoCfg?.greetMode ?? 'text', numberSlot: cfg.numberSlot ?? null })
  } catch (e) {
    console.error('MenuGateway GET error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /api/menu-gateway/waiting (admin) — chip + flyout dashboard ─────
router.get('/waiting', ...rt, featMenuGatewayGate, async (req, res) => {
  try {
    const count = await menuGateway.countWaiting(req.tenantId)
    const chats = await menuGateway.listWaiting(req.tenantId)
    res.json({ count, chats })
  } catch (e) {
    console.error('MenuGateway GET waiting error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── PUT /api/menu-gateway (admin) — upsert transaksional §8 ─────────────
router.put('/', ...rt, featMenuGatewayGate, async (req, res) => {
  try {
    const body = req.body || {}
    const errors = []
    await menuGateway.getConfig(req.tenantId) // pastikan config tenant ter-seed

    // v3.9 — target slot: 'all' (default) = shared row; 0..2 = row Nomor ini saja.
    const targetSlotRaw = body.numberSlot
    let targetSlot = null // null = link-all/shared (compat)
    let perSlot = false
    if (targetSlotRaw !== undefined && targetSlotRaw !== null && targetSlotRaw !== '' && targetSlotRaw !== 'all') {
      const s = parseInt(targetSlotRaw, 10)
      if (!Number.isFinite(s) || s < 0 || s > 2) {
        return res.status(400).json({ error: 'numberSlot tidak valid (all / 0..2)' })
      }
      targetSlot = s
      perSlot = true
    }

    const { data } = (await validatePayload(body, errors)) || {}
    if (!data) {
      return res.status(400).json({ error: topMessage(errors), errors })
    }

    const configData = { ...data }
    delete configData.options
    const options = data.options

    // Upsert transaksional: update singleton + deleteMany/createMany options
    // dalam SATU transaksi (opsi lama tidak pernah setengah-terhapus).
    // v3.9 — per-slot: row (tenantId, numberSlot=slot) dibuat on-demand (clone shared
    // bila belum ada), lalu di-update; shared row tidak tersentuh.
    if (perSlot) {
      await prisma.menuGatewayConfig.create({
        data: { tenantId: req.tenantId, numberSlot: targetSlot },
      }).catch(async (e) => {
        if (e.code !== 'P2002') throw e
      })
    }
    const whereKey = perSlot
      ? { tenantId_numberSlot: { tenantId: req.tenantId, numberSlot: targetSlot } }
      : { tenantId: req.tenantId }
    const cfg = await prisma.$transaction(async (tx) => {
      const cfgRow = await tx.menuGatewayConfig.findUnique({ where: whereKey })
      const cfgId = cfgRow?.id
      const updated = await tx.menuGatewayConfig.update({
        where: whereKey,
        data: { ...configData, updatedById: req.user.id },
      })
      if (options) {
        await tx.menuGatewayOption.deleteMany({ where: { configId: cfgId, tenantId: req.tenantId } })
        await tx.menuGatewayOption.createMany({
          data: options.map(o => ({
            tenantId: req.tenantId,
            configId: cfgId,
            position: o.position,
            label: o.label,
            aliases: o.aliases,
            replyText: o.replyText,
            tagId: o.tagId,
          })),
        })
      }
      return tx.menuGatewayConfig.findUnique({
        where: whereKey,
        include: { options: { orderBy: { position: 'asc' } } },
      })
    }, { timeout: 15000, maxWait: 5000 })

    // Cache service invalid → config baru aktif (pola appConfig/autoreply)
    menuGateway.invalidateConfig(req.tenantId)

    // v0.13.2 — SINKRON 2 ARAH (feedback Kanaka 02:44): toggle gateway & radio greeting
    // = satu saklar efektif. enabled=true → greeting ON + mode menu; enabled=false →
    // mode text (greeting checkbox dibiarkan — kontrol user sendiri).
    let greetSync = null
    if (body.enabled === true) {
      await prisma.autoReplyConfig.updateMany({ where: { tenantId: req.tenantId }, data: { greetEnabled: true, greetMode: 'menu' } })
      greetSync = 'menu'
    } else if (body.enabled === false) {
      await prisma.autoReplyConfig.updateMany({ where: { tenantId: req.tenantId }, data: { greetMode: 'text' } })
      greetSync = 'text'
    }
    if (greetSync) {
      require('../services/autoReply').invalidateConfig(req.tenantId)
    }

    // D12: enabled=false → release SEMUA chat awaiting → queue tanpa tag (idempoten)
    if (body.enabled === false) {
      try {
        await menuGateway.releaseAwaiting(req.tenantId, false)
      } catch (relErr) {
        console.error('MenuGateway releaseAwaiting error (non-fatal):', relErr)
      }
    }

    res.json({ config: cfg, greetMode: greetSync })
  } catch (e) {
    console.error('MenuGateway PUT error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router