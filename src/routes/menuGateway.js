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
  'timeoutValue', 'timeoutUnit', 'repeatFrequency',
  'numberSlot', 'numberSlots', // v3.9.4 — tick-box scope (fix: sebelumnya ditolak 400 "Field tidak dikenal" — QA #5)
  'aiHybrid', 'aiThreshold', // v3.9.25 — AI Hybrid Routing (spec D3/D5)
  'options',
])
// v4.0.0 — §7b CB-AI per-opsi (D9): answerMode + aiDocIds (≤200 char, id divalidasi milik tenant)
const ALLOWED_OPTION_FIELDS = new Set(['position', 'label', 'aliases', 'replyText', 'tagId', 'aiDescription', 'answerMode', 'aiDocIds'])
const ANSWER_MODES = ['text', 'ai_knowledge']
const AI_DOC_IDS_MAX = 200

// v3.9.25 — batas AI Hybrid (spec D3/D8): threshold 0.50–0.95, aiDescription ≤200 char
const AI_THRESHOLD_MIN = 0.5
const AI_THRESHOLD_MAX = 0.95
const AI_DESC_MAX_LEN = 200

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

  // ── v3.9.25 — AI Hybrid Routing (validasi ketat spec D3/D5) ──
  // aiHybrid: boolean STRICT ("yes"/1/null → 400). aiThreshold: angka 0.50–0.95
  // (string "0.7"/out-of-range → 400). aiThreshold boleh diset walau aiHybrid OFF
  // (pre-set sebelum menyalakan). aiHybrid itu sendiri TIDAK digate plan di sini —
  // gate plan (403 upsell) ada di PUT handler (bisa lihat req/res).
  if (body.aiHybrid !== undefined) {
    if (typeof body.aiHybrid !== 'boolean') {
      errors.push('aiHybrid harus boolean')
    } else {
      data.aiHybrid = body.aiHybrid
    }
  }
  if (body.aiThreshold !== undefined) {
    if (typeof body.aiThreshold !== 'number' || !Number.isFinite(body.aiThreshold)) {
      errors.push(`aiThreshold harus angka ${AI_THRESHOLD_MIN}–${AI_THRESHOLD_MAX}`)
    } else if (body.aiThreshold < AI_THRESHOLD_MIN || body.aiThreshold > AI_THRESHOLD_MAX) {
      errors.push(`aiThreshold harus ${AI_THRESHOLD_MIN}–${AI_THRESHOLD_MAX} (nilai ekstrem diblokir — lebih aman gagal ke antrean CS daripada salah kamar)`)
    } else {
      data.aiThreshold = body.aiThreshold
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
        // v3.9.25 — aiDescription (D8): string ≤200, trim; kosong = prompt pakai label+aliases
        let aiDescription = ''
        if (o.aiDescription !== undefined && o.aiDescription !== null) {
          if (typeof o.aiDescription !== 'string') {
            errors.push(`options[${i}].aiDescription harus berupa teks`)
          } else {
            aiDescription = o.aiDescription.trim()
            if (aiDescription.length > AI_DESC_MAX_LEN) {
              errors.push(`options[${i}].aiDescription maksimal ${AI_DESC_MAX_LEN} karakter`)
            }
          }
        }
        // ── v4.0.0 — §7b: answerMode + aiDocIds (D9) ──
        let answerMode = 'text'
        if (o.answerMode !== undefined && o.answerMode !== null) {
          if (typeof o.answerMode !== 'string' || !ANSWER_MODES.includes(o.answerMode)) {
            errors.push(`options[${i}].answerMode harus "text" atau "ai_knowledge"`)
          } else {
            answerMode = o.answerMode
          }
        }
        let aiDocIds = ''
        if (o.aiDocIds !== undefined && o.aiDocIds !== null) {
          if (typeof o.aiDocIds !== 'string') {
            errors.push(`options[${i}].aiDocIds harus csv string id dokumen (mis. "1,2")`)
          } else {
            aiDocIds = o.aiDocIds.trim()
            if (aiDocIds.length > AI_DOC_IDS_MAX) {
              errors.push(`options[${i}].aiDocIds maksimal ${AI_DOC_IDS_MAX} karakter`)
            } else if (aiDocIds) {
              // Format ketat: csv integer — elemen selain digit → 400
              const items = aiDocIds.split(',').map((s) => s.trim())
              if (items.some((s) => s && !/^\d+$/.test(s))) {
                errors.push(`options[${i}].aiDocIds harus csv id angka (mis. "1,2")`)
              }
            }
          }
        }
        parsed.push({ position: o.position, label: o.label, aliases, replyText, tagId, aiDescription, answerMode, aiDocIds })
      }

      // ≥1 opsi wajib punya replyText non-kosong (§8)
      if (!parsed.some(o => (o.replyText || '').trim().length > 0)) {
        errors.push('Minimal 1 opsi wajib punya replyText')
      }

      if (errors.length > 0) return null
      // v4.0.0 — OWNERSHIP aiDocIds divalidasi di PUT handler (butuh req.tenantId)
      // Urutkan by position — deterministik terhadap urutan input
      parsed.sort((a, b) => a.position - b.position)
      data.options = parsed
    }
  }

  if (errors.length > 0) return null
  return { data }
}

// ── GET /api/menu-gateway (admin) ───────────────────────────────────────
// v3.9.25 — + aiUsage: {calls, costUsd, costRp} bulan WIB berjalan dari AiUsageLog
// source='gateway' tenant ini (D7). Plan ✗ → aiUsage null (fitur bukan miliknya).
function wibMonthStartUtc(now = new Date()) {
  const ym = new Date(now.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 7) // ym dalam WIB
  return new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1, -7)) // 00:00 WIB = 17:00 UTC sehari sebelumnya (audit MEDIUM-A fix)
}
async function aiUsageForTenant(tenantId) {
  try {
    const since = wibMonthStartUtc()
    const agg = await prisma.aiUsageLog.aggregate({
      where: { tenantId, source: 'gateway', createdAt: { gte: since } },
      _count: { id: true },
      _sum: { costUsd: true },
    })
    const calls = Number(agg._count?.id) || 0
    const costUsd = Number(agg._sum?.costUsd) || 0
    const cfg = await prisma.aiConfig.findUnique({ where: { id: 1 }, select: { usdToIdr: true } })
    const rate = Number(cfg?.usdToIdr)
    const usdToIdr = Number.isFinite(rate) && rate > 0 ? rate : 16000
    return { calls, costUsd, costRp: Math.round(costUsd * usdToIdr), usdToIdr }
  } catch (e) {
    console.error('[MenuGateway] aiUsageForTenant error (non-fatal):', e.message)
    return { calls: 0, costUsd: 0, costRp: 0, usdToIdr: 16000 }
  }
}

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
    const autoCfg = await prisma.autoReplyConfig.findFirst({ where: { tenantId: req.tenantId, numberSlot: null }, select: { greetEnabled: true, greetMode: true } })
    // v3.9.4 — info tick-box: slot dgn row menu sendiri (dikelola di sini) + slot
    // yang greet-nya dikelola halaman Auto Reply mode teks (dilindungi dari save sini)
    const [mgRows, arRows] = await Promise.all([
      prisma.menuGatewayConfig.findMany({ where: { tenantId: req.tenantId, numberSlot: { not: null }, enabled: true }, select: { numberSlot: true } }),
      // v3.9.4 — auto-reply-managed = row TEKS dgn trigger AKTIF (menu rows = menu-managed)
      prisma.autoReplyConfig.findMany({ where: { tenantId: req.tenantId, numberSlot: { not: null }, greetMode: { not: 'menu' }, OR: [{ greetEnabled: true }, { outsideHoursEnabled: true }] }, select: { numberSlot: true } }),
    ])
    res.json({
      config: cfg,
      waitingCount,
      greetEnabled: autoCfg?.greetEnabled ?? false,
      greetMode: autoCfg?.greetMode ?? 'text',
      numberSlot: cfg.numberSlot ?? null,
      menuManagedSlots: mgRows.map(r => Number(r.numberSlot)).sort((a, b) => a - b),
      arManagedSlots: arRows.map(r => Number(r.numberSlot)).sort((a, b) => a - b),
      // v3.9.25 — AI Hybrid: plan ✗ → aiUsage null (spec D7)
      aiUsage: (await plans.getPlan(req.tenantId))?.featAiRouting ? await aiUsageForTenant(req.tenantId) : null,
    })
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
    // v3.9.4 — TICK-BOX: numberSlots = array slot tercentang (legacy numberSlot tetap
    // jalan). Mixed (all + slot) ditolak.
    const targetSlotRaw = body.numberSlot
    let targetSlots = null // null = link-all/shared (compat)
    if (body.numberSlots !== undefined) {
      if (body.numberSlots === null || body.numberSlots === 'all' || body.numberSlots === '') {
        targetSlots = null
      } else if (Array.isArray(body.numberSlots)) {
        const parsed = body.numberSlots.map((v) => parseInt(v, 10))
        if (parsed.some((s) => !Number.isFinite(s) || s < 0 || s > 2)) {
          return res.status(400).json({ error: 'numberSlots berisi slot tidak valid (harus 0..2)' })
        }
        // v3.9.4 fix audit MEDIUM-2 — array KOSONG = niat "tidak ada tercentang",
        // BUKAN link-all; tulis shared row justru kebalik. Tolak 400 (mirror autoreply).
        if (parsed.length === 0) {
          return res.status(400).json({ error: 'Centang minimal satu nomor (atau Semua nomor)' })
        }
        targetSlots = [...new Set(parsed)].sort((a, b) => a - b)
      } else {
        return res.status(400).json({ error: 'numberSlots harus null/all atau array slot 0..2' })
      }
    } else if (targetSlotRaw !== undefined && targetSlotRaw !== null && targetSlotRaw !== '' && targetSlotRaw !== 'all') {
      const s = parseInt(targetSlotRaw, 10)
      if (!Number.isFinite(s) || s < 0 || s > 2) {
        return res.status(400).json({ error: 'numberSlot tidak valid (all / 0..2)' })
      }
      targetSlots = [s]
    }
    let targetList = Array.isArray(targetSlots) && targetSlots.length > 0 ? targetSlots : null

    // v3.9.5 QA-2 — "Semua nomor" dari UI (numberSlots eksplisit null) + enabled !== false
    // → EXPAND ke semua slot terdaftar (row per-slot eksplisit, bukan fallback shared).
    // Akar QA-2: slot dgn row scoped lama (mis. AR teks yang sudah dimatikan) TIDAK
    // pernah dapat menu via fallback shared → "tick gateway semua nomor" gak jalan.
    if (targetList === null && body.numberSlots !== undefined && body.enabled !== false) {
      const nums = await prisma.tenantNumber.findMany({ where: { tenantId: req.tenantId, slot: { in: [0, 1, 2] } }, select: { slot: true }, orderBy: { slot: 'asc' } })
      targetSlots = nums.map(n => Number(n.slot))
      if (targetSlots.length === 0) targetSlots = [0] // tenant fresh (slot-0 sintetis)
      targetList = targetSlots
    }

    // v3.9.4 fix audit MEDIUM-1 — proteksi link-all: enabled=true via link-all memindahkan
    // SEMUA slot "pengikut shared" ke mode menu. Bila shared AR masih punya trigger teks
    // aktif → 409 (hormati transisi sadar via halaman Auto Reply dulu).
    if (!targetList && body.enabled === true) {
      const sharedAR = await prisma.autoReplyConfig.findFirst({
        where: { tenantId: req.tenantId, numberSlot: null },
        select: { greetEnabled: true, outsideHoursEnabled: true },
      })
      if (sharedAR && (sharedAR.greetEnabled || sharedAR.outsideHoursEnabled)) {
        return res.status(409).json({
          error: "Auto Reply 'Semua nomor' masih aktif (greeting/outside-hours). Matikan dulu di halaman Auto Reply (atau matikan menunya per-slot di sini), lalu aktifkan link-all di sini. Aktifkan per-slot via tick-box kalau mau hybrid.",
        })
      }
    }

    const { data } = (await validatePayload(body, errors)) || {}
    if (!data) {
      return res.status(400).json({ error: topMessage(errors), errors })
    }

    // ── v3.9.25 — Plan gate AI Hybrid (D5/D5a): BERLAKU utk SEMUA aktor ──
    // Super_admin via ?tenant= JUGA terkena (plan ✗ → 403; plan gate menang di atas
    // SA — amandemen D5a: SA boleh toggle, tapi TIDAK ada backdoor plan).
    // aiHybrid=true eksplisit → cek plan; aiHybrid=false/absent → bebas (matikan
    // toggle tidak boleh diblokir plan). Pola pesan = featMenuGatewayGate (403 ramah + upsell).
    if (data.aiHybrid === true) {
      const plan = await plans.getPlan(req.tenantId)
      if (!plan || plan.featAiRouting === false) {
        return res.status(403).json({
          error: 'AI Hybrid Routing tidak tersedia di paket Anda. Hubungi admin platform untuk upgrade.',
          feature: 'featAiRouting',
        })
      }
    }

    // ═══ v4.0.0 — Plan gate CB-AI knowledge (D9/D8 — NO BACKDOOR, semua aktor) ═══
    // SET opsi answerMode='ai_knowledge' + plan featAiKnowledge ✗ → 403 upsell ramah
    // (admin & SA ?tenant=). Set balik ke 'text' SELALU bebas (matikan tidak diblokir).
    if (Array.isArray(data.options) && data.options.some((o) => o.answerMode === 'ai_knowledge')) {
      const plan = await plans.getPlan(req.tenantId)
      if (!plan || plan.featAiKnowledge === false) {
        return res.status(403).json({
          error: 'ChatBareng AI (Auto Reply) tidak tersedia di paket Anda. Hubungi admin platform untuk upgrade.',
          feature: 'featAiKnowledge',
        })
      }
      // OWNERSHIP: setiap id di aiDocIds HARUS milik tenant ini (ada di KB-nya)
      const allIds = new Set()
      for (const o of data.options) {
        for (const s of String(o.aiDocIds || '').split(',')) {
          const v = s.trim()
          if (v) allIds.add(parseInt(v, 10))
        }
      }
      if (allIds.size > 0) {
        const rows = await prisma.aiKnowledgeDoc.findMany({ where: { tenantId: req.tenantId, id: { in: [...allIds] } }, select: { id: true } })
        const owned = new Set(rows.map((r) => r.id))
        for (const o of data.options) {
          const missing = String(o.aiDocIds || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number).filter((v) => !owned.has(v))
          if (missing.length > 0) {
            return res.status(400).json({ error: `options[${o.position}].aiDocIds berisi id dokumen yang bukan milik tenant ini / tidak ada: ${missing.join(',')}` })
          }
        }
      }
    }

    // v3.9.4 — proteksi dua arah (kawan Auto Reply 409): slot yang punya auto-reply
    // TEKS aktif tidak boleh ditimpa menu — admin diminta matikan dulu di Auto Reply.
    if (targetList && body.enabled === true) {
      const active = await prisma.autoReplyConfig.findMany({
        where: { tenantId: req.tenantId, numberSlot: { in: targetList }, OR: [{ greetEnabled: true }, { outsideHoursEnabled: true }] },
        select: { numberSlot: true, greetMode: true },
      })
      const textActive = active.filter((r) => r.greetMode !== 'menu').map((r) => Number(r.numberSlot)).sort((a, b) => a - b)
      if (textActive.length > 0) {
        return res.status(409).json({
          error: `Slot ${textActive.join(', ')} punya auto-reply teks aktif — matikan dulu di halaman Auto Reply (uncentang slot itu atau matikan trigger-nya), lalu aktifkan menu di sini.`,
          slots: textActive,
        })
      }
    }

    const configData = { ...data }
    delete configData.options
    const options = data.options

    // v3.9.4 — tulis scope: per-slot (list) → row per slot dibuat on-demand lalu
    // di-update + options di-replace PER ROW (transaksi per slot); link-all → shared.
    if (targetList) {
      for (const s of targetList) {
        await prisma.menuGatewayConfig.create({ data: { tenantId: req.tenantId, numberSlot: s } }).catch(async (e) => {
          if (e.code !== 'P2002') throw e
        })
      }
    } else {
      const sharedRow = await prisma.menuGatewayConfig.findFirst({ where: { tenantId: req.tenantId, numberSlot: null }, select: { id: true } })
      if (!sharedRow) {
        await prisma.menuGatewayConfig.create({ data: { tenantId: req.tenantId, numberSlot: null } }).catch(async (e) => {
          if (e.code !== 'P2002') throw e
        })
      }
    }
    let cfg = null
    for (const s of targetList || [null]) {
      const whereKey = s === null
        ? { id: (await prisma.menuGatewayConfig.findFirst({ where: { tenantId: req.tenantId, numberSlot: null }, select: { id: true } }))?.id }
        : { tenantId_numberSlot: { tenantId: req.tenantId, numberSlot: s } }
      cfg = await prisma.$transaction(async (tx) => {
        const cfgRow = await tx.menuGatewayConfig.findUnique({ where: whereKey })
        const cfgId = cfgRow?.id
        if (!cfgId) throw new Error('Config row hilang saat transaksi')
        await tx.menuGatewayConfig.update({ where: whereKey, data: { ...configData, updatedById: req.user.id } })
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
              aiDescription: o.aiDescription || '', // v3.9.25 — D8
              answerMode: o.answerMode || 'text', // v4.0.0 — §7b D9
              aiDocIds: o.aiDocIds || '', // v4.0.0 — §7b D9 (kosong = whole KB)
            })),
          })
        }
        return tx.menuGatewayConfig.findUnique({ where: whereKey, include: { options: { orderBy: { position: 'asc' } } } })
      }, { timeout: 15000, maxWait: 5000 })
    }

    // Cache service invalid → config baru aktif (pola appConfig/autoreply)
    menuGateway.invalidateConfig(req.tenantId)

    // v0.13.2 sync — v3.9.4 SCOPED (bug lama: updateMany SEMUA row → config slot lain
    // ketimpa, hybrid mustahil — QA #6). enable → autoReply.enableGreetForScope (HANYA
    // slot scope; slot dgn config sendiri tidak disentuh); disable → scoped + release
    // awaiting MILIK slot itu saja.
    let greetSync = null
    const autoSvc = require('../services/autoReply')
    if (body.enabled === true) {
      await autoSvc.enableGreetForScope(req.tenantId, targetList ? [...targetList] : null, req.user.id)
      // v3.9.4 — tick-box menu eksplisit: shared menu (legacy link-all) dinetralkan
      // supaya slot DI LUAR centangan tidak lagi dapat menu via fallback shared
      // (slot dgn row menu sendiri tidak terdampak — punya row sendiri).
      if (targetList) {
        await prisma.autoReplyConfig.updateMany({
          where: { tenantId: req.tenantId, numberSlot: null, greetMode: 'menu' },
          data: { greetEnabled: false, greetMode: 'text', updatedById: req.user.id },
        })
        // v3.9.4 fix — shared MenuGatewayConfig juga dimatikan (kalau tidak, slot
        // tanpa row masih dapat menu via getConfigForSlot fallback shared enabled).
        await prisma.menuGatewayConfig.updateMany({
          where: { tenantId: req.tenantId, numberSlot: null, enabled: true },
          data: { enabled: false, updatedById: req.user.id },
        })
        autoSvc.invalidateConfig(req.tenantId)
        menuGateway.invalidateConfig(req.tenantId)
      }
      greetSync = 'menu'
    } else if (body.enabled === false) {
      // v3.9.5 QA-UX — master OFF = MATI TOTAL (tidak tergantung tick-box):
      // semua row MenuGatewayConfig tenant OFF + AR rows mode-menu dimatikan
      // (mode text, greeting off). Tick-box UI di-disable saat toggle OFF.
      await prisma.menuGatewayConfig.updateMany({ where: { tenantId: req.tenantId }, data: { enabled: false, updatedById: req.user.id } })
      await prisma.autoReplyConfig.updateMany({ where: { tenantId: req.tenantId, greetMode: 'menu' }, data: { greetEnabled: false, greetMode: 'text', updatedById: req.user.id } })
      greetSync = 'text'
    }
    if (greetSync) {
      autoSvc.invalidateConfig(req.tenantId)
      menuGateway.invalidateConfig(req.tenantId)
    }

    // D12 (v3.9.5) — enabled=false = master-off → release awaiting SEMUA slot
    // (semua row menu sudah dimatikan di atas, tidak ada slot yang masih menu-enabled)
    if (body.enabled === false) {
      try {
        await menuGateway.releaseAwaiting(req.tenantId, false)
      } catch (relErr) {
        console.error('MenuGateway releaseAwaiting error (non-fatal):', relErr)
      }
    }

    // v3.9.25 — sinkron AutoReplyConfig (radio Mode greeting) dgn status menu efektif:
    // bila ada row menu gateway tenant yang enabled → greetMode='menu' + greetEnabled
    // true (mirror AutoReply PUT mode-menu memaksa ON); bila TIDAK ada yang enabled →
    // greetMode='text' + greetEnabled=false (radio kembali teks). Tanpa ini radio di
    // AutoReply kelihatan "Menu gateway" padahal menu OFF (stale — QA E2E v3925).
    try {
      const anyEnabled = await prisma.menuGatewayConfig.findFirst({ where: { tenantId: req.tenantId, enabled: true }, select: { id: true } })
      const menuOn = !!anyEnabled
      const autoCfgRow = await prisma.autoReplyConfig.findFirst({ where: { tenantId: req.tenantId, numberSlot: null }, select: { id: true, greetMode: true } })
      if (autoCfgRow) {
        const menuModeNow = autoCfgRow.greetMode === 'menu'
        if (menuOn && !menuModeNow) {
          await prisma.autoReplyConfig.update({ where: { id: autoCfgRow.id }, data: { greetMode: 'menu', greetEnabled: true, updatedById: req.user.id } })
        } else if (!menuOn && menuModeNow) {
          await prisma.autoReplyConfig.update({ where: { id: autoCfgRow.id }, data: { greetMode: 'text', greetEnabled: false, updatedById: req.user.id } })
        }
        require('../services/autoReply').invalidateConfig(req.tenantId)
      }
    } catch (syncErr) {
      console.error('MenuGateway autoreply-sync error (non-fatal):', syncErr)
    }

    res.json({ config: cfg, greetMode: greetSync })
  } catch (e) {
    console.error('MenuGateway PUT error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router