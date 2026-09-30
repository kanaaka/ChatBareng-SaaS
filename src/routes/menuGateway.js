/**
 * v0.13.0 — Menu Gateway (Auto Reply Triage) API (admin only).
 *
 * Spec: wa-cs-hub-v0.13.0-menu-gateway-spec.md §8/§9.
 * GET    /api/menu-gateway          → { config: { ...cfg, options: [...] }, waitingCount }
 * PUT    /api/menu-gateway          → validasi keras (§8), upsert transaksional,
 *                                   invalidate cache; enabled=false → releaseAwaiting.
 * GET    /api/menu-gateway/waiting  → { count, chats: [...] } (chip + flyout dashboard).
 *
 * ═══ v4.2.1 — Menu Gateway PER-SLOT OVERRIDE (spec docs/spec-v4.2.1-menugateway-per-slot-override.md) ═══
 * GET    /api/menu-gateway/options    → { slots: [{slot,label,custom,menuManaged,enabled,arManaged}], defaultExists }
 *                                       (dropdown FE — pola autoreply/options v4.2.0; slot-0 sintetis unshift)
 * DELETE /api/menu-gateway/slot/:slot → "Reset ke Default": hapus row custom slot (+options transaksi) +
 *                                       delete AR row greetMode 'menu' slot itu + release awaiting slot itu.
 *                                       Tanpa row → 200 idempoten {ok, slot, deleted:0} (deviasi didokumenkan).
 * GET    /api/menu-gateway?slot=N     → + additive { custom, menuManaged } (pola v4.2.0 autoreply §2.5)
 * PUT    /                            → + whitelist flag `scopeDefault: true` (400 bila digabung
 *                                       numberSlot/numberSlots): tulis SHARED row SAJA — skip expand-ke-slot
 *                                       (QA-2 v3.9.5) + skip blok netralisasi (Default = shared itu sendiri);
 *                                       enabled=false = scoped master-off (hanya shared row + release pengikut).
 * Legacy tick-box GET/PUT byte-compat (regression e2e-v4121 + e2e-v420).
 *
 * Konvensi pola: routes/autoreply.js + routes/appConfig.js (requireAuth+requireAdmin,
 * validate-first, 400 { error, errors }, 500 internal). Unknown field DITOLAK (400).
 * GreetMode TIDAK di endpoint ini — di PUT /api/autoreply (spec §8).
 */
// v4.3.0 — GET /options (D8): flag arTextManaged & outsideOnly (tetap emit arManaged utk
// back-compat). Enable-guard keluar outsideHoursEnabled dari predikat blokir; sisa
// teks-aktif per-slot → 200 {confirmRequired, slots} (bukan 409) — D3/D4. scope
// shared/default tetap modal wajib di BE (409) + tanda confirmRequired (D7).
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
  'scopeDefault', // v4.2.1 — tulis SHARED row saja (tanpa expand-ke-slot & tanpa netralisasi); 400 bila digabung numberSlot/numberSlots
  'confirm', // v4.3.0 (D4) — flag re-submit setelah modal konfirmasi FE (greeting teks slot → dimatikan sadar)
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
      // v4.2.1 — additive 2 flag (pola autoreply GET ?slot= v4.2.0 §2.5): custom = ada row
      // MenuGatewayConfig {tenantId, numberSlot: s} (enabled true/false sama saja — row = custom);
      // menuManaged = row itu enabled=true (menu di slot itu AKTIF dikelola di sini).
      const mgCustom = await prisma.menuGatewayConfig.findUnique({
        where: { tenantId_numberSlot: { tenantId: req.tenantId, numberSlot: s } },
        select: { enabled: true },
      })
      const cfgWithScope = { ...cfg, custom: !!mgCustom, menuManaged: !!mgCustom && mgCustom.enabled === true }
      cfg = cfgWithScope
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
    const planRow = await plans.getPlan(req.tenantId) // v4.0.1 hotfix — sekali fetch
    res.json({
      config: cfg,
      waitingCount,
      greetEnabled: autoCfg?.greetEnabled ?? false,
      greetMode: autoCfg?.greetMode ?? 'text',
      numberSlot: cfg.numberSlot ?? null,
      menuManagedSlots: mgRows.map(r => Number(r.numberSlot)).sort((a, b) => a - b),
      arManagedSlots: arRows.map(r => Number(r.numberSlot)).sort((a, b) => a - b),
      // v3.9.25 — AI Hybrid: plan ✗ → aiUsage null (spec D7)
      aiUsage: planRow?.featAiRouting ? await aiUsageForTenant(req.tenantId) : null,
      // v4.0.1 hotfix (quirk #2 QA Kanaka) — flag plan CB-AI utk FE (pola AutoReply);
      // plan null (SA impersonasi) → allow-safe true, konsisten requireFeature.
      cbaiPlanOk: !planRow || planRow.featAiKnowledge !== false,
    })
  } catch (e) {
    console.error('MenuGateway GET error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ═══════════════════════ v4.2.1 — BARU: GET /api/menu-gateway/options ═══════════════════════
// Data dropdown FE (pola persis GET /api/autoreply/options v4.2.0 — spec §1.1):
// slots[] = { slot, label (custom TenantNumber / null utk sintetis 0), custom (ada row
// MenuGatewayConfig per-slot — enabled true/false sama saja, row = custom), menuManaged
// (row itu enabled=true — menu slot AKTIF), enabled (nilai kolom row / false), arManaged
// (slot punya AR teks/outside aktif — dilindungi 409 saat enable menu slot itu) }
// + defaultExists (row shared ada). Gagal → 200 dgn array kosong-bijak (bukan 500 liar).
router.get('/options', ...rt, featMenuGatewayGate, async (req, res) => {
  try {
    const tid = req.tenantId
    // v4.2.1 — DB scope info di service (additive; DB queries SAJA — pola autoreply/options v4.2.0)
    // v4.3.0 (D8) — + arTextSet / outsideOnlySet (dipecah dari arSet; arSet tetap utk back-compat)
    const { customMap, arSet, arTextSet, outsideOnlySet, defaultExists } = await menuGateway.getSlotScopeInfo(tid)
    let slots = []
    try {
      const waSvc = require('../wa/pool')
      // Sumber slot+label = wa.listTenantNumbers — slot-0 SINTETIS unshift bila tanpa baris slot-0
      // (pola persis wa.js GET /status + autoreply/options v4.2.0 O3 — audit Kimi N1)
      const numbers = await waSvc.listTenantNumbers(tid)
      const seen = new Set(numbers.map((n) => Number(n.slot) || 0))
      slots = numbers.map((n) => {
        const slot = Number(n.slot) || 0
        const enabled = customMap.get(slot) === true
        return {
          slot, label: n.label || null, custom: customMap.has(slot), menuManaged: enabled, enabled,
          // v4.2.1 back-compat — arManaged = SEMUA slot dgn AR teks/outside aktif:
          arManaged: arSet.has(slot),
          // v4.3.0 (D8) — flag BARU utk FE: disable hanya arTextManaged; outsideOnly selectable:
          arTextManaged: arTextSet.has(slot),
          outsideOnly: outsideOnlySet.has(slot) && !arTextSet.has(slot),
        }
      })
      if (!seen.has(0)) {
        slots.unshift({
          slot: 0, label: null, custom: customMap.has(0), menuManaged: customMap.get(0) === true, enabled: customMap.get(0) === true,
          arManaged: arSet.has(0), arTextManaged: arTextSet.has(0), outsideOnly: outsideOnlySet.has(0) && !arTextSet.has(0),
        })
      }
    } catch (e) {
      // listTenantNumbers gagal → fallback minimal slot-0 sintetis (200 bijak, bukan 500)
      console.error('MenuGateway options listTenantNumbers error (non-fatal):', e.message)
      slots = [{
        slot: 0, label: null, custom: customMap.has(0), menuManaged: customMap.get(0) === true, enabled: customMap.get(0) === true,
        arManaged: arSet.has(0), arTextManaged: arTextSet.has(0), outsideOnly: outsideOnlySet.has(0) && !arTextSet.has(0),
      }]
    }
    let defaultExistsEcho = defaultExists
    try {
      // getConfig = seed idempotent (pola GET / wajib seed shared row) → defaultExists hampir selalu true
      const shared = await menuGateway.getConfig(tid)
      defaultExistsEcho = !!shared
    } catch (e) {
      console.error('MenuGateway options defaultExists error (non-fatal):', e.message)
      defaultExistsEcho = false
    }
    res.json({ slots, defaultExists: defaultExistsEcho })
  } catch (e) {
    console.error('MenuGateway options error:', e)
    res.status(200).json({ slots: [], defaultExists: false }) // gagal → 200 array kosong-bijak (pola autoreply options)
  }
})

// ═══════════════════════ v4.2.1 — BARU: DELETE /api/menu-gateway/slot/:slot ═══════════════════════
// "Reset ke Default" (spec §1.2): slot custom kembali MIRROR shared. Transaksi: hapus row
// MenuGatewayConfig slot (+options deleteMany EKSPLISIT dulu — menuGatewayConfig.options
// memang onDelete: Cascade, tapi eksplisit = self-documenting + aman utk DB lama), hapus row
// AutoReplyConfig slot greetMode 'menu' (slot AR kembali MIRROR shared — bukan set text —
// semantik override v4.2.0), release awaiting milik slot ITU (menuGateway.releaseAwaiting
// sudah punya param `slot` sejak v3.9.4). Shared row ATAU row slot lain TIDAK disentuh.
// Slot tanpa row → 200 idempoten { ok, slot, deleted: 0 } (pola v4.2.0 — deviasi didok).
router.delete('/slot/:slot', ...rt, featMenuGatewayGate, async (req, res) => {
  try {
    const s = parseInt(req.params.slot, 10)
    if (!Number.isFinite(s) || s < 0 || s > 2) return res.status(400).json({ error: 'Slot tidak valid (0..2)' })
    // Idempoten dgn deleteMany (compound key dgn NULL tidak bisa utk delete unique — pola v4.2.0)
    const del = await prisma.$transaction(async (tx) => {
      const cfgRow = await tx.menuGatewayConfig.findUnique({
        where: { tenantId_numberSlot: { tenantId: req.tenantId, numberSlot: s } },
        select: { id: true },
      })
      if (!cfgRow) return { deleted: 0, deletedMenuAR: 0 }
      await tx.menuGatewayOption.deleteMany({ where: { configId: cfgRow.id, tenantId: req.tenantId } })
      const delRow = await tx.menuGatewayConfig.deleteMany({ where: { tenantId: req.tenantId, numberSlot: s } })
      // Sync AR dua-arah: row AutoReplyConfig slot ini dgn greetMode 'menu' DIHAPUS
      // (kembali mirror shared AR — konsisten semantik override per-slot v4.2.0; BUKAN
      // set text: row slot menu TIDAK sedang memantau trigger teks — hapus lebih jujur).
      const delAR = await tx.autoReplyConfig.deleteMany({ where: { tenantId: req.tenantId, numberSlot: s, greetMode: 'menu' } })
      return { deleted: delRow.count, deletedMenuAR: delAR.count }
    }, { timeout: 15000, maxWait: 5000 })
    menuGateway.invalidateConfig(req.tenantId)
    require('../services/autoReply').invalidateConfig(req.tenantId)
    // Release awaiting milik SLOT INI saja (v3.9.4 — releaseAwaiting sudah terima param slot;
    // reuse mekanisme D12 scoped — slot menu-managed lain TIDAK disentuh; non-fatal).
    let releasedCount = 0
    try {
      const released = await menuGateway.releaseAwaiting(req.tenantId, false, null, s)
      releasedCount = released.released || 0
    } catch (relErr) {
      console.error('MenuGateway releaseAwaiting (reset slot) error (non-fatal):', relErr)
    }
    console.log(`[MenuGateway] reset slot ${s} (tenant ${req.tenantId}): deleted=${del.deleted} menuAR=${del.deletedMenuAR} released=${releasedCount}`)
    res.json({ ok: true, slot: s, deleted: del.deleted, deletedMenuAR: del.deletedMenuAR, releasedCount })
  } catch (e) {
    console.error('MenuGateway DELETE slot error:', e)
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

    // ═══ v4.2.1 — ADDITIVE #2 (whitelist): scopeDefault=true = tulis SHARED row SAJA ═══
    // (spec §2 — Default view save): TIDAK expand-ke-slot (v3.9.5 QA-2) & TIDAK netralisasi
    // (blok v3.9.4 L593-606 — Default = shared itu sendiri, bukan tick-box). 400 bila
    // dikombinasi numberSlot/numberSlots (satu flag utk SATU niat). Legacy body TANPA
    // flag = perilaku byte-compat persis (regression e2e-v4121/v420).
    const scopeDefaultOnly = body.scopeDefault === true
    if (scopeDefaultOnly && (targetSlotRaw !== undefined || body.numberSlots !== undefined)) {
      return res.status(400).json({ error: "scopeDefault tidak boleh digabung dengan numberSlot/numberSlots — pilih satu: 'Default (Semua nomor)' ATAU slot tertentu" })
    }

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
    // v4.2.1 — scopeDefault=shared row TETAP kena 409 (enable shared menu = mengubah seluruh
    // pengikut Default — proteksi semantik yang sama; spec §2: reuse validasi existing).
    if (!targetList && body.enabled === true) {
      const sharedAR = await prisma.autoReplyConfig.findFirst({
        where: { tenantId: req.tenantId, numberSlot: null },
        select: { greetEnabled: true, greetMode: true, outsideHoursEnabled: true },
      })
      // v4.3.0 (D3) — outsideHoursEnabled TIDAK lagi dianggap blokir (runtime D5 v0.13.0:
      // malam = away text, jam kerja = menu — koeksistensi legal). Yang menyisakan blokir
      // (konfirmasi wajib, D7) hanya GREETING teks/cbai aktif (greetEnabled, mode ≠ menu).
      const sharedTextGreet = !!(sharedAR && sharedAR.greetEnabled && sharedAR.greetMode !== 'menu')
      if (sharedTextGreet) {
        return res.status(409).json({
          error: "Auto Reply 'Semua nomor' masih punya greeting teks aktif — matikan/saklar dulu di halaman Auto Reply (atau di slot pengikutnya), lalu aktifkan link-all di sini. Aktifkan per-slot via tick-box kalau mau hybrid.",
          slots: ['default'],
          confirmRequired: true, // v4.3.0 — D7: semantik konfirmasi wajib (modal FE), bukan blokir teks
          slotsText: ['default'],
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
    // ═══ v4.3.0 (D3/D4) — BUKAN blokir lagi utk slot: greeting teks aktif → respons
    // 200 {confirmRequired: true, slots} — FE tampilkan modal konfirmasi lalu kirim ulang
    // persis body ini + flag confirm:true (BE eksekusi switch atomik). Yang tetap
    // terblokir 409: payload confirm TIDAK valid / scopeDefault (D7 — BE tetap keras).
    if (targetList && body.enabled === true) {
      const active = await prisma.autoReplyConfig.findMany({
        where: { tenantId: req.tenantId, numberSlot: { in: targetList }, OR: [{ greetEnabled: true }, { outsideHoursEnabled: true }] },
        select: { numberSlot: true, greetMode: true, greetEnabled: true, outsideHoursEnabled: true },
      })
      const textActive = active.filter((r) => r.greetMode !== 'menu').map((r) => Number(r.numberSlot)).sort((a, b) => a - b)
      // v4.3.0 (D3) — outsideOnly (hanya outside-hours aktif) TIDAK lagi menghalangi:
      // hanya slot dgn GREETING teks aktif yang butuh konfirmasi.
      const greetingActive = active.filter((r) => r.greetMode !== 'menu' && r.greetEnabled === true).map((r) => Number(r.numberSlot)).sort((a, b) => a - b)
      if (body.confirm === true) {
        // Payload konfirmasi (re-submit FE) → lanjut tanpa blok (switch sadar, D4).
        if (greetingActive.length > 0) console.log(`[MenuGateway] enable dengan confirm=true — greeting teks slot ${greetingActive.join(', ')} akan dimatikan (switch mode sadar)`)
      } else if (greetingActive.length > 0) {
        const detail = greetingActive.map((s) => `slot ${s} punya greeting teks aktif — akan dimatikan dan diganti menu (Outside-hours tetap jalan di luar jam kerja)`)
        return res.status(200).json({
          confirmRequired: true,
          slots: greetingActive,
          detail,
          error: `Slot ${greetingActive.join(', ')} punya greeting teks aktif — konfirmasi untuk menggantinya dengan menu (Outside-hours tetap jalan di luar jam kerja).`,
        })
      }
    }

    const configData = { ...data }
    delete configData.options
    const options = data.options

    // v3.9.4 — tulis scope: per-slot (list) → row per slot dibuat on-demand lalu
    // di-update + options di-replace PER ROW (transaksi per slot); link-all → shared.
    if (scopeDefaultOnly) {
      // v4.2.1 — Default view save: seed shared row bila belum ada, TANPA menyentuh row slot.
      const sharedRow0 = await prisma.menuGatewayConfig.findFirst({ where: { tenantId: req.tenantId, numberSlot: null }, select: { id: true } })
      if (!sharedRow0) {
        await prisma.menuGatewayConfig.create({ data: { tenantId: req.tenantId, numberSlot: null } }).catch(async (e) => {
          if (e.code !== 'P2002') throw e
        })
      }
      targetList = null // scopeDefault → tulis shared row SAJA (tulis-scope di bawah pakai [null])
    } else if (targetList) {
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
      // v4.3.0 (D3/D4) — payload confirm=true (re-submit setelah modal FE): greeting teks
      // slot-scope DIMATIKAN dalam transaksi yang sama (AR row slot → greetEnabled=false,
      // mode tetap; outside-hours TIDAK disentuh). Slot menu-managed lain zero-cascade.
      if (body.confirm === true) {
        // v4.3.0 (D4) — re-submit FE setelah modal: greeting teks yang akan ditimpa menu
        // dimatikan SADAR (scope-aware: slot-scope = slot itu; shared/scopeDefault = shared).
        const confirmedSlotWhere = targetList
          ? { tenantId: req.tenantId, numberSlot: { in: targetList }, greetMode: { not: 'menu' }, greetEnabled: true }
          : { tenantId: req.tenantId, numberSlot: null, greetMode: { not: 'menu' }, greetEnabled: true }
        const activeRows = await prisma.autoReplyConfig.findMany({ where: confirmedSlotWhere, select: { numberSlot: true } })
        const listConfirmed = [...new Set(activeRows.map((r) => Number(r.numberSlot) || 0))].sort((a, b) => a - b)
        if (listConfirmed.length > 0) {
          await prisma.$transaction(async (tx) => {
            for (const s of listConfirmed) {
              // v4.3.0 audit MED-2 — ternary duplikat whereKey disederhanakan (verdict GO-WITH-NOTES; perilaku identik)
              const whereKey = { tenantId: req.tenantId, numberSlot: s, greetMode: { not: 'menu' } }
              await tx.autoReplyConfig.updateMany({ where: whereKey, data: { greetEnabled: false, updatedById: req.user.id } })
              await tx.chat.updateMany({ where: { tenantId: req.tenantId, numberSlot: s, menuState: 'awaiting' }, data: { menuState: 'done', queuedAt: new Date() } })
            }
          }, { timeout: 15000, maxWait: 5000 }).catch(() => null)
          console.log(`[MenuGateway] switch konfirmasi: greeting teks slot ${listConfirmed.join(', ')} dimatikan (switch-sadar v4.3.0)`)
        }
      }
      await autoSvc.enableGreetForScope(req.tenantId, targetList ? [...targetList] : null, req.user.id)
      // v3.9.4 — tick-box menu eksplisit: shared menu (legacy link-all) dinetralkan
      // supaya slot DI LUAR centangan tidak lagi dapat menu via fallback shared
      // (slot dgn row menu sendiri tidak terdampak — punya row sendiri).
      // v4.2.1 — scopeDefault TIDAK netralisasi (spec §2 — CAREFUL blok ini): Default
      // view = shared itu sendiri; enable di Default harus tetap nyalakan shared row
      // (barusan ditulis enabled=true di atas) — netralisasi di sini justru mematikan
      // menu Default yang baru disetel.
      if (targetList && !scopeDefaultOnly) {
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
      if (scopeDefaultOnly) {
        // ═══ v4.2.1 — SCOPED master-off (Default view): HANYA shared row OFF (row slot
        // custom TIDAK disentuh!) + HANYA row AR menu SHARED dimatikan + release awaiting
        // pengikut shared (slot menu-managed lain tetap hidup — mirror master-off autoreply
        // legacy v3.9.4). DEVIASI terdokumen vs master-off lama (mati total semua) — spec §2.
        await prisma.menuGatewayConfig.updateMany({ where: { tenantId: req.tenantId, numberSlot: null }, data: { enabled: false, updatedById: req.user.id } })
        await prisma.autoReplyConfig.updateMany({ where: { tenantId: req.tenantId, numberSlot: null, greetMode: 'menu' }, data: { greetEnabled: false, greetMode: 'text', updatedById: req.user.id } })
        greetSync = 'text'
      } else {
      // v3.9.5 QA-UX — master OFF = MATI TOTAL (tidak tergantung tick-box):
      // semua row MenuGatewayConfig tenant OFF + AR rows mode-menu dimatikan
      // (mode text, greeting off). Tick-box UI di-disable saat toggle OFF.
      await prisma.menuGatewayConfig.updateMany({ where: { tenantId: req.tenantId }, data: { enabled: false, updatedById: req.user.id } })
      await prisma.autoReplyConfig.updateMany({ where: { tenantId: req.tenantId, greetMode: 'menu' }, data: { greetEnabled: false, greetMode: 'text', updatedById: req.user.id } })
      greetSync = 'text'
      }
    }
    if (greetSync) {
      autoSvc.invalidateConfig(req.tenantId)
      menuGateway.invalidateConfig(req.tenantId)
    }

    // D12 (v3.9.5) — enabled=false = master-off → release awaiting SEMUA slot
    // (semua row menu sudah dimatikan di atas, tidak ada slot yang masih menu-enabled)
    // v4.2.1 — scopeDefault (Default view) = SCOPED: hanya slot "pengikut shared"
    // (tanpa row menu sendiri) yang dilepas — slot custom menu-managed tetap hidup;
    // pola releaseAwaiting scoped yang sama dipakai DELETE slot di atas.
    if (body.enabled === false) {
      try {
        if (scopeDefaultOnly) {
          // Cari slot awaiting yang efektif TIDAK lagi menu-enabled (pengikut shared)
          const groups = await prisma.chat.groupBy({ by: ['numberSlot'], where: { tenantId: req.tenantId, menuState: 'awaiting' } })
          for (const g of groups) {
            const s = Number(g.numberSlot) || 0
            const eff = await menuGateway.getConfigForSlot(req.tenantId, s)
            if (!eff || !eff.enabled) await menuGateway.releaseAwaiting(req.tenantId, false, null, s)
          }
        } else {
          await menuGateway.releaseAwaiting(req.tenantId, false)
        }
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