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
const plans = require('../services/plans') // v4.0.0 — plan gate CB-AI (featAiKnowledge)

// v3.0 — Isolasi tenant: AutoReply config = per-tenant
const rt = [requireAuth, requireTenant, requireAdmin]  // requireTenant dulu — super_admin wajib ?tenant= sebelum cek admin
const {
  getConfig,
  invalidateConfig,
  listSlotsWithConfig, // v3.9.4 — info tick-box (scoped vs menu-managed)
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
// v4.0.0 (D4) — greetMode extended value "cbai"; outsideHoursMode baru "text" | "cbai"
const GREET_MODES = ['text', 'menu', 'cbai']
const OUTSIDE_MODES = ['text', 'cbai']

// ── GET /api/autoreply (admin only) ──
router.get('/', ...rt, async (req, res) => {
  // v4.1.1 — GET echo persona (cbaiBotName/cbaiBotRole/cbaiHumanAgentLabel) otomatis
  // ikut di {...cfg} (full row) — baik jalur slot maupun shared. Tanpa perubahan bentuk.
  try {
    // v3.9 — ?slot= → config per-slot (fallback shared); tanpa slot = shared (compat)
    const slotRaw = req.query.slot
    if (slotRaw !== undefined) {
      const s = parseInt(slotRaw, 10)
      if (!Number.isFinite(s) || s < 0 || s > 2) return res.status(400).json({ error: 'Slot tidak valid (0..2)' })
      const svc = require('../services/autoReply')
      const cfg = await svc.getConfigForSlot(req.tenantId, s)
      // v4.0.0b hotfix — echo repeatFrequency efektif (AR ?? MG ?? 'daily')
      const mg = await require('../services/menuGateway').getConfigForSlot(req.tenantId, s).catch(() => null)
      return res.json({ config: { ...cfg, repeatFrequency: cfg.repeatFrequency ?? mg?.repeatFrequency ?? 'daily' }, numberSlot: cfg.numberSlot ?? null })
    }
    const cfg = await getConfig(req.tenantId)
    // v3.9.4 — info tick-box utk UI: slot dgn row sendiri mode text (dikelola halaman
    // ini) + slot menu-managed (dikelola Menu Gateway — dilindungi dari save di sini).
    const scopedInfo = await listSlotsWithConfig(req.tenantId)
    // v4.0.0b hotfix — echo repeatFrequency efektif (AR ?? MG ?? 'daily')
    const mg = await require('../services/menuGateway').getConfig(req.tenantId).catch(() => null)
    res.json({ config: { ...cfg, repeatFrequency: cfg.repeatFrequency ?? mg?.repeatFrequency ?? 'daily' }, numberSlots: scopedInfo.scoped, menuManagedSlots: scopedInfo.menuManaged })
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

    // v4.0.0 — ALLOWED whitelist (spec §8: field asing → 400 — ketat)
    const ALLOWED_AUTOREPLY_FIELDS = new Set([
      'numberAll', 'numberSlot', 'numberSlots',
      'outsideHoursEnabled', 'outsideHoursText', 'outsideHoursMode',
      'greetEnabled', 'greetMode', 'greetText',
      'cbaiLimit', 'cbaiInfoFooter', // v4.0.0 — CB-AI
      'cbaiBotName', 'cbaiBotRole', 'cbaiHumanAgentLabel', // v4.1.1 — persona (D1)
      'cbaiUpsellEnabled', 'cbaiUpsellDocId', 'cbaiDisclaimer', // v4.1.2 — upselling + disclaimer (D7)
      // v4.0.0a hotfix (QA Kanaka 09:15) — repeatFrequency PINDAH ke halaman ini (D10):
      // FE kirim full-form → tanpa ini SEMUA save Auto Reply 400 "Field tidak dikenal".
      // Validasi ketat di bawah (enum, GREET_MODES-style) — bukan cuma whitelist.
      'repeatFrequency',
      'monFriEnabled', 'monFriStart', 'monFriEnd',
      'satEnabled', 'satStart', 'satEnd',
      'sunEnabled', 'sunStart', 'sunEnd',
    ])
    for (const key of Object.keys(body)) {
      if (!ALLOWED_AUTOREPLY_FIELDS.has(key)) {
        return res.status(400).json({ error: `Field tidak dikenal: ${key}` })
      }
    }

    const data = {}

    // v3.9.4 — target scope TICK-BOX: numberAll (bool) + numberSlots (array slot
    // tercentang). ATAU legacy numberSlot (null | 0..2). Mixed (all + slot) → 400.
    let slotFieldsProvided = false
    let numberAll = body.numberAll === true
    let targets = null // null = link-all (Semua nomor)
    const parseSlot = (v) => {
      const s = parseInt(v, 10)
      return Number.isFinite(s) && s >= 0 && s <= 2 ? s : null
    }
    if (body.numberSlots !== undefined) {
      slotFieldsProvided = true
      if (body.numberSlots === null || body.numberSlots === 'all' || body.numberSlots === '') {
        targets = null
        numberAll = true
      } else if (Array.isArray(body.numberSlots)) {
        const parsed = body.numberSlots.map(parseSlot)
        if (parsed.includes(null)) {
          return res.status(400).json({ error: 'numberSlots berisi slot tidak valid (harus 0..2)' })
        }
        targets = [...new Set(parsed)].sort((a, b) => a - b)
      } else {
        return res.status(400).json({ error: 'numberSlots harus null/all atau array slot 0..2' })
      }
    } else if (body.numberSlot !== undefined) {
      slotFieldsProvided = true
      if (body.numberSlot === null || body.numberSlot === '' || body.numberSlot === 'all') {
        targets = null
        numberAll = true
      } else {
        const s = parseSlot(body.numberSlot)
        if (s === null) {
          return res.status(400).json({ error: 'numberSlot tidak valid (null / 0..2)' })
        }
        targets = [s]
      }
    }
    if (numberAll && Array.isArray(targets) && targets.length > 0) {
      return res.status(400).json({ error: "Pilih 'Semua nomor (linked)' ATAU slot tertentu — tidak keduanya" })
    }
    if (slotFieldsProvided && !numberAll && (!Array.isArray(targets) || targets.length === 0)) {
      return res.status(400).json({ error: 'Centang minimal satu nomor (atau Semua nomor)' })
    }

    // v3.9.4 — PROTEKSI slot menu-managed: row dgn greetMode 'menu' dikelola halaman
    // Menu Gateway — save di sini tidak boleh menimpa rules menu-nya (akar bug hybrid
    // QA #6: sinkronisasi lama menimpa SEMUA row).
    if (targets && targets.length > 0) {
      const menuRows = await prisma.autoReplyConfig.findMany({
        where: { tenantId: req.tenantId, numberSlot: { in: targets }, greetMode: 'menu' },
        select: { numberSlot: true },
      })
      if (menuRows.length > 0) {
        const slots = menuRows.map((r) => r.numberSlot).sort((a, b) => a - b).join(', ')
        return res.status(409).json({
          error: `Slot ${slots} sedang dikelola Menu Gateway — matikan menu untuk slot itu di halaman Menu Gateway dulu, lalu simpan ulang di sini.`,
          slots: menuRows.map((r) => r.numberSlot),
        })
      }
    }

    // Toggle fitur
    if (body.outsideHoursEnabled !== undefined) data.outsideHoursEnabled = !!body.outsideHoursEnabled
    if (body.greetEnabled !== undefined) data.greetEnabled = !!body.greetEnabled

    // ── v4.0.0 — CB-AI fields (spec §8: ALLOWED + validasi ketat, field asing → 400) ──
    // greetMode: "text" | "menu" | "cbai" (extend value — D4). cbai boleh diset walau
    // plan ✗ (pre-set); PLAN GATE ada di handler (bisa lihat req/res) — pola menuGateway D5.
    if (body.greetMode !== undefined) {
      if (typeof body.greetMode !== 'string' || !GREET_MODES.includes(body.greetMode)) {
        return res.status(400).json({ error: 'greetMode harus "text", "menu", atau "cbai"' })
      }
      data.greetMode = body.greetMode
      // v0.13.2 — mode menu = greeting nyala (menu hanya jalan lewat greeting).
      // v3.9.4 fix — HANYA menu yang memaksa ON; mode 'text' HORMAT ke checkbox
      // (bug lama: selalu dipaksa true → user uncheck greeting = nyala lagi sendiri,
      // ketahuan di E2E T3: greetEnabled:false terkirim tapi tersimpan true).
      // v4.0.0 — mode 'cbai' juga memaksa greetEnabled=true (radio CB-AI = greeting hidup).
      if (body.greetMode === 'menu' || body.greetMode === 'cbai') data.greetEnabled = true
    }
    if (body.outsideHoursMode !== undefined) {
      if (typeof body.outsideHoursMode !== 'string' || !OUTSIDE_MODES.includes(body.outsideHoursMode)) {
        return res.status(400).json({ error: 'outsideHoursMode harus "text" atau "cbai"' })
      }
      data.outsideHoursMode = body.outsideHoursMode
    }
    if (body.cbaiLimit !== undefined) {
      if (!Number.isInteger(body.cbaiLimit) || body.cbaiLimit < 1 || body.cbaiLimit > 10) {
        return res.status(400).json({ error: 'cbaiLimit harus integer 1..10' })
      }
      data.cbaiLimit = body.cbaiLimit
    }
    if (body.cbaiInfoFooter !== undefined) {
      if (typeof body.cbaiInfoFooter !== 'boolean') {
        return res.status(400).json({ error: 'cbaiInfoFooter harus boolean' })
      }
      data.cbaiInfoFooter = body.cbaiInfoFooter
    }
    // v4.1.1 — persona (D1): string STRICT (bukan string → 400), trim, cap 120.
    // Kosong '' = reset (perilaku v4.1.0). Validasi SEBELUM plan-gate — 400 liar
    // selalu menang atas 403 plan (pola validasi-first).
    for (const pf of ['cbaiBotName', 'cbaiBotRole', 'cbaiHumanAgentLabel']) {
      if (body[pf] !== undefined) {
        if (typeof body[pf] !== 'string') {
          return res.status(400).json({ error: `${pf} harus berupa teks` })
        }
        const v = body[pf].trim()
        if (v.length > 120) {
          return res.status(400).json({ error: `${pf} maksimal 120 karakter` })
        }
        data[pf] = v
      }
    }
    // v4.1.2 — upselling + disclaimer (D2/D3/D7): whitelist +3 field, validasi ketat
    // SEBELUM plan-gate (400 liar selalu menang atas 403 plan — pola persona v4.1.1).
    // - cbaiUpsellEnabled / cbaiDisclaimer: boolean STRICT (typeof === 'boolean').
    // - cbaiUpsellDocId: null ATAU integer positif; doc HARUS milik tenant & exists.
    if (body.cbaiUpsellEnabled !== undefined) {
      if (typeof body.cbaiUpsellEnabled !== 'boolean') {
        return res.status(400).json({ error: 'cbaiUpsellEnabled harus boolean' })
      }
      data.cbaiUpsellEnabled = body.cbaiUpsellEnabled
    }
    if (body.cbaiDisclaimer !== undefined) {
      if (typeof body.cbaiDisclaimer !== 'boolean') {
        return res.status(400).json({ error: 'cbaiDisclaimer harus boolean' })
      }
      data.cbaiDisclaimer = body.cbaiDisclaimer
    }
    if (body.cbaiUpsellDocId !== undefined) {
      if (body.cbaiUpsellDocId === null) {
        data.cbaiUpsellDocId = null
      } else if (!Number.isInteger(body.cbaiUpsellDocId) || body.cbaiUpsellDocId <= 0) {
        return res.status(400).json({ error: 'cbaiUpsellDocId harus null atau integer positif' })
      } else {
        const doc = await prisma.aiKnowledgeDoc.findFirst({ where: { id: body.cbaiUpsellDocId, tenantId: req.tenantId }, select: { id: true } })
        if (!doc) return res.status(400).json({ error: 'cbaiUpsellDocId tidak valid — dokumen tidak ditemukan di tenant ini' })
        data.cbaiUpsellDocId = body.cbaiUpsellDocId
      }
    }
    // v4.0.0a hotfix (QA Kanaka 09:15) — repeatFrequency PINDAH ke halaman ini (D10):
    // whitelist doang gak cukup — validasi enum + tulis data. NULL kolom (tenant
    // belum save) → runtime fallback ke MenuGatewayConfig (back-compat).
    if (body.repeatFrequency !== undefined) {
      if (typeof body.repeatFrequency !== 'string' || !['per_chat', 'daily', 'weekly'].includes(body.repeatFrequency)) {
        return res.status(400).json({ error: 'repeatFrequency harus "per_chat", "daily", atau "weekly"' })
      }
      data.repeatFrequency = body.repeatFrequency
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

    // ═══ v4.0.0 — Plan gate CB-AI (D8/D5a — pola D5a v3.9.25, NO BACKDOOR) ═══
    // PUT mode 'cbai' (jam kerja ATAU luar jam) + plan ✗ → 403 upsell ramah —
    // BERLAKU utk SEMUA aktor (admin MAUPUN super_admin via ?tenant=). Set balik ke
    // 'text'/'menu' SELALU bebas (matikan tidak diblokir plan).
    if (data.greetMode === 'cbai' || data.outsideHoursMode === 'cbai') {
      const plan = await plans.getPlan(req.tenantId)
      if (!plan || plan.featAiKnowledge === false) {
        return res.status(403).json({
          error: 'ChatBareng AI (Auto Reply) tidak tersedia di paket Anda. Hubungi admin platform untuk upgrade.',
          feature: 'featAiKnowledge',
        })
      }
    }

    // v3.9.4 — tulis scope:
    // - Per-slot: baseline shared DINETRALKAN (trigger OFF) → slot tanpa centang gak
    //   dapat auto-reply. MENU-PRESERVING: bila shared sedang menu-managed (legacy
    //   link-all menu), greet fields shared DIPERTAHANKAN supaya menu slot lain
    //   tidak ikut mati. Slot tercentang punya row sendiri (upsert).
    // - Link-all eksplisit: row standard-scoped dihapus (slot kembali ikut shared);
    //   row menu-managed DIPERTAHANKAN (proteksi).
    let cfg
    if (Array.isArray(targets) && targets.length > 0) {
      const sharedRow = await prisma.autoReplyConfig.findFirst({ where: { tenantId: req.tenantId, numberSlot: null } })
      const keepMenu = !!(sharedRow && sharedRow.greetMode === 'menu' && sharedRow.greetEnabled)
      if (sharedRow) {
        await prisma.autoReplyConfig.update({
          where: { id: sharedRow.id },
          data: keepMenu
            ? { outsideHoursEnabled: false, updatedById: req.user.id }
            : { outsideHoursEnabled: false, greetEnabled: false, greetMode: 'text', updatedById: req.user.id },
        })
      }
      // v3.9.4 — slot yang di-UNCHECK: row scoped-nya dihapus (kembali fallback ke
      // shared baseline) — tanpa ini, slot lama yang pernah dicentang tetap aktif.
      await prisma.autoReplyConfig.deleteMany({
        where: { tenantId: req.tenantId, numberSlot: { not: null, notIn: targets }, NOT: { greetMode: 'menu' } },
      })
      cfg = null
      for (const s of targets) {
        cfg = await prisma.autoReplyConfig.upsert({
          where: { tenantId_numberSlot: { tenantId: req.tenantId, numberSlot: s } },
          update: { ...data, updatedById: req.user.id },
          create: { tenantId: req.tenantId, numberSlot: s, ...data, updatedById: req.user.id },
        })
      }
    } else {
      if (slotFieldsProvided) {
        await prisma.autoReplyConfig.deleteMany({
          where: { tenantId: req.tenantId, numberSlot: { not: null }, NOT: { greetMode: 'menu' } },
        })
      }
      const shared = await prisma.autoReplyConfig.findFirst({ where: { tenantId: req.tenantId, numberSlot: null }, select: { id: true } })
      cfg = await prisma.autoReplyConfig.update({
        where: { id: shared?.id },
        data: { ...data, updatedById: req.user.id },
      })
    }

    invalidateConfig(req.tenantId) // cache service invalid → config baru aktif

    // v4.0.0b hotfix (QA Kanaka 09:15) — echo repeatFrequency efektif utk FE sync
    // (AR ?? MG ?? 'daily') — kolom baru nullable, FE select gak punya opsi kosong.
    const mgSvcEcho = require('../services/menuGateway')
    const mgEcho = (Array.isArray(targets) && targets.length > 0)
      ? await mgSvcEcho.getConfigForSlot(req.tenantId, targets[targets.length - 1])
      : await mgSvcEcho.getConfig(req.tenantId)

    // v0.13.2 sync — v3.9.4 SCOPED (bug lama: updateMany SEMUA row → config slot
    // lain ketimpa, hybrid mustahil). Jalur 'menu' = legacy (UI baru tidak mengirim;
    // mode menu kini dimiliki halaman Menu Gateway).
    let menuGatewayEnabled = null
    if (data.greetMode !== undefined) {
      const menuGatewaySvc = require('../services/menuGateway')
      if (data.greetMode === 'menu') {
        // v3.9.4 — shared-row enable HANYA saat link-all; mode per-slot → row slot
        // saja (shared yang enabled akan bocor ke slot lain via fallback).
        if (!Array.isArray(targets)) {
          const mgShared = await prisma.menuGatewayConfig.findFirst({ where: { tenantId: req.tenantId, numberSlot: null }, select: { id: true } })
          if (mgShared) {
            await prisma.menuGatewayConfig.update({ where: { id: mgShared.id }, data: { enabled: true, updatedById: req.user.id } })
          } else {
            await prisma.menuGatewayConfig.create({ data: { tenantId: req.tenantId, numberSlot: null, enabled: true, updatedById: req.user.id } }).catch(async (e) => {
              if (e.code !== 'P2002') throw e
              const again = await prisma.menuGatewayConfig.findFirst({ where: { tenantId: req.tenantId, numberSlot: null }, select: { id: true } })
              if (again) await prisma.menuGatewayConfig.update({ where: { id: again.id }, data: { enabled: true, updatedById: req.user.id } })
            })
          }
        }
        menuGatewayEnabled = true
        // v3.9.4 — per-slot tick-box: enable row MenuGateway PER SLOT (bukan cuma shared)
        if (Array.isArray(targets) && targets.length > 0) {
          for (const s of targets) {
            await prisma.menuGatewayConfig.upsert({
              where: { tenantId_numberSlot: { tenantId: req.tenantId, numberSlot: s } },
              update: { enabled: true, updatedById: req.user.id },
              create: { tenantId: req.tenantId, numberSlot: s, enabled: true, updatedById: req.user.id },
            })
          }
          // v3.9.4 fix audit HIGH-1 (Kimi-K3): neutralisasi shared MG — slot DI LUAR
          // centangan tidak boleh dapat menu via fallback shared (mirror jalur text).
          await prisma.menuGatewayConfig.updateMany({
            where: { tenantId: req.tenantId, numberSlot: null, enabled: true },
            data: { enabled: false, updatedById: req.user.id },
          })
        }
      } else {
        // Matikan menu SCOPED: link-all → shared row saja; per-slot → row slot tsb.
        if (targets == null) {
          await prisma.menuGatewayConfig.updateMany({ where: { tenantId: req.tenantId, numberSlot: null }, data: { enabled: false, updatedById: req.user.id } })
        } else {
          for (const s of targets) {
            await prisma.menuGatewayConfig.updateMany({ where: { tenantId: req.tenantId, numberSlot: s }, data: { enabled: false, updatedById: req.user.id } })
          }
        }
        // v3.9.4 — per-slot save: legacy shared menu (link-all) dinetralkan supaya
        // tidak bocor ke slot di luar centangan (tick-box = scope eksplisit).
        if (Array.isArray(targets) && targets.length > 0) {
          await prisma.menuGatewayConfig.updateMany({ where: { tenantId: req.tenantId, numberSlot: null, enabled: true }, data: { enabled: false, updatedById: req.user.id } })
        }
        menuGatewayEnabled = false
        // Release awaiting HANYA slot yang efektif tidak lagi menu-enabled (slot
        // menu-managed lain tidak disentuh — QA #6).
        try {
          const groups = await prisma.chat.groupBy({ by: ['numberSlot'], where: { tenantId: req.tenantId, menuState: 'awaiting' } })
          for (const g of groups) {
            const s = Number(g.numberSlot) || 0
            const eff = await menuGatewaySvc.getConfigForSlot(req.tenantId, s)
            if (!eff || !eff.enabled) await menuGatewaySvc.releaseAwaiting(req.tenantId, false, null, s)
          }
        } catch (e) {
          console.error('[AutoReply] releaseAwaiting scoped error (non-fatal):', e.message)
        }
      }
      menuGatewaySvc.invalidateConfig(req.tenantId)
    }

    res.json({ config: { ...cfg, repeatFrequency: cfg.repeatFrequency ?? mgEcho?.repeatFrequency ?? 'daily' }, menuGatewayEnabled })
  } catch (e) {
    console.error('AutoReply PUT error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
