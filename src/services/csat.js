/**
 * v0.10.0 — CSAT (Customer Satisfaction Rating)
 *
 * Aturan (spec §3):
 * - Trigger: handleResolve sukses + CsatConfig.enabled + chat punya nomor pelanggan
 *   → buat CsatSurvey (token unik) → kirim via sendMessage (isAuto:true, senderId:null).
 * - TIDAK mengisi firstResponseAt/firstResponseById (konsisten autoReply v0.7.0).
 * - Parse balasan inbound: angka 1–5 ATAU ⭐ tunggal/variatif (⭐⭐⭐ = 3).
 *   Teks lain → diabaikan (survey tetap pending).
 * - Pesan pelanggan tetap tampil normal di chat (transparan) — parse tidak mengubah flow.
 * - Anti-spam: 1 survey per event resolve; reopen → resolve lagi → survey baru.
 * - v0.14.5 — Pending expiry: survey terkirim-tapi-tak-dijawab > 48 jam dianggap
 *   expired → tidak memblokir survey baru (fix "CSAT nggak kekirim" 18 Sep).
 */

const prisma = require('../prisma')
const broadcast = require('../socket/broadcast')
const crypto = require('crypto')
const { encryptText, decryptTextSafe } = require('./textCrypto') // v0.11.0 — enkripsi at-rest isi pesan

const TIMEZONE = 'Asia/Jakarta'
const SENDER_NAME = 'CSAT Survey'
const MAX_TEXT_LEN = 1000

// v0.14.5 — Expiry survey pending: survey terkirim-tapi-belum-dijawab yang lebih
// tua dari ini dianggap EXPIRED oleh guard blokir (tidak lagi memblokir survey
// baru). Sebelumnya pending nangkring selamanya → semua resolve berikutnya
// gak pernah bikin survey (lapor Kanaka 18 Sep: "CSAT nggak kekirim").
// Balasan rating customer tetap dialokasikan ke survey TERBARU yang terkirim
// (consumePendingRating orderBy id desc) — reply ke survey lama tetap terekam.
const PENDING_EXPIRY_HOURS = 48

// ─── Config PER-TENANT (pola AutoReplyConfig / gdriveBackup) ────────────
// v3.0 — Map tenantId → config (CsatConfig @@unique([tenantId])).
const configCache = new Map()

async function getConfig(tenantId) {
  const tid = Number(tenantId)
  if (!Number.isFinite(tid)) throw new Error('csat.getConfig butuh tenantId')
  if (configCache.has(tid)) return configCache.get(tid)
  let cfg = await prisma.csatConfig.findUnique({ where: { tenantId: tid } })
  if (!cfg) {
    cfg = await prisma.csatConfig.create({ data: { tenantId: tid } }).catch(async (e) => {
      if (e.code === 'P2002') return prisma.csatConfig.findUnique({ where: { tenantId: tid } })
      throw e
    })
    console.log(`[CSAT] Seeded CsatConfig (tenant ${tid}, enabled=false)`)
  }
  configCache.set(tid, cfg)
  return cfg
}

function invalidateConfig(tenantId) {
  if (tenantId === undefined) configCache.clear()
  else configCache.delete(Number(tenantId))
}

/** Strip placeholder selain {name} (pola autoReply). */
function stripUnknownPlaceholders(text) {
  return String(text || '').replace(/\{(?!name\})[^{}]*\}/g, '')
}

/** Personalisasi {name} (pola blast/autoReply). */
function personalizeText(template, contactName) {
  if (contactName && String(contactName).trim()) {
    return template.replace(/\{name\}/g, contactName)
  }
  let result = template.replace(/\{name\}/g, '')
  result = result.replace(/  +/g, ' ')
  result = result.replace(/\s+,/g, ',').replace(/\s+\./g, '.')
  return result.trim()
}

// ─── Buat + kirim survey setelah resolve ────────────────────────────────
/**
 * Dipanggil dari route resolve (hook titik satu-satunya yang spec izinkan).
 * Fire-and-forget aman: error tidak pernah menggagalkan resolve.
 * @param {object} chat - Chat row TERBARU (status sudah resolved)
 * @param {number} resolvedById - userId CS/admin yang resolve
 */
async function createSurveyAfterResolve(chat, resolvedById) {
  try {
    const tenantId = chat.tenantId
    // Guard: fitur OFF → tidak kirim apa pun
    const cfg = await getConfig(tenantId)
    if (!cfg.enabled) return null

    // Guard: chat harus punya nomor pelanggan yang valid (bukan grup)
    const chatId = chat.id
    if (!chatId || chat.waJid?.endsWith('@g.us')) return null
    const phone = (chat.contactPhone || '').replace(/\D/g, '')
    if (!phone || phone.length < 8) return null

    // Guard: hanya satu survey pending AKTIF per chat (yang lama tetap riwayat).
    // v0.14.5 — pending terkirim-tapi-tak-dijawab > PENDING_EXPIRY_HOURS =
    // EXPIRED: tidak memblokir survey baru. (Dulu: pending nangkring selamanya →
    // resolve berikutnya gak pernah bikin survey.)
    const pendingCutoff = new Date(Date.now() - PENDING_EXPIRY_HOURS * 3600e3)
    const activePending = await prisma.csatSurvey.findFirst({
      where: {
        tenantId,
        chatId,
        rating: null,
        sentAt: { not: null, gte: pendingCutoff },
      },
    })
    if (activePending) {
      console.log(`[CSAT] Survey pending masih aktif utk chat=${chatId} (tenant ${tenantId}) — skip buat baru`)
      return activePending
    }

    // v0.10.6 — Guard cooldown DYNAMIS dari config (lapor Kanaka: jangan hardcode;
    // admin bisa ganti mode/jam dari panel CSAT kapan pun):
    //   per_chat  (A): skip jika survey terakhir chat ini < N jam, apapun agent-nya
    //   per_agent (B): skip jika survey terakhir DARI AGENT YG SAMA < N jam (beda agent → boleh)
    //   hybrid    (C): seperti B + per-agent; 0 jam → cooldown mati
    // Guard "max 1 pending per chat" di atas tetap berlaku di semua mode (anti dobel-belum-dijawab).
    const lastSurvey = await prisma.csatSurvey.findFirst({
      where: { tenantId, chatId },
      orderBy: { id: 'desc' },
    })
    if (lastSurvey) {
      const hours = (Date.now() - new Date(lastSurvey.createdAt).getTime()) / 3600e3
      const hoursLimit = cfg.cooldownHours ?? 24
      const mode = cfg.cooldownMode || 'per_chat'
      if (hoursLimit > 0) {
        const sameAgent = lastSurvey.createdById === resolvedById
        let blocked = false
        if (mode === 'per_chat') blocked = hours < hoursLimit
        else if (mode === 'per_agent') blocked = sameAgent && hours < hoursLimit
        else blocked = sameAgent && hours < hoursLimit // hybrid
        if (blocked) {
          console.log(`[CSAT] Cooldown (${mode}, ${hoursLimit}h) — skip survey utk chat=${chatId} (${hours.toFixed(1)}h sejak terakhir, agent sama: ${sameAgent})`)
          return null
        }
      }
    }

    const token = crypto.randomBytes(16).toString('hex')
    const survey = await prisma.csatSurvey.create({
      data: { tenantId, chatId, token, createdById: resolvedById },
    })
    console.log(`[CSAT] Survey #${survey.id} dibuat utk chat=${chatId} (tenant ${tenantId})`)

    // Kirim segera (best-effort); kalau gagal → tetap pending, scheduler self-heal.
    await sendSurveyMessage(survey.id)
    return survey
  } catch (e) {
    console.error('[CSAT] createSurveyAfterResolve error:', e.message)
    return null
  }
}

/**
 * Kirim pesan survey untuk satu CsatSurvey (by id).
 * @returns {'sent'|'already_sent'|'wa_not_connected'|'no_phone'} status
 */
async function sendSurveyMessage(surveyId) {
  const survey = await prisma.csatSurvey.findUnique({ where: { id: surveyId } })
  if (!survey) return 'no_survey'
  if (survey.sentAt) return 'already_sent'

  const tenantId = survey.tenantId
  const cfg = await getConfig(tenantId)
  const chat = await prisma.chat.findFirst({
    where: { id: survey.chatId, tenantId },
    // v0.12.1 — +assignedToId/status utk payload toast gate frontend
    select: { waJid: true, contactName: true, contactPhone: true, assignedToId: true, status: true },
  })
  if (!chat) return 'no_phone'
  const phone = (chat.contactPhone || '').replace(/\D/g, '')
  if (!phone || phone.length < 8) return 'no_phone'

  const wa = require('../wa/pool')
  if (!wa.isTenantConnected(tenantId)) {
    console.log('[CSAT] WA belum connect — survey tetap pending (scheduler akan coba lagi)')
    return 'wa_not_connected'
  }

  const finalText = personalizeText(cfg.message, chat.contactName)
  await wa.sendMessageForTenant(tenantId, chat.waJid, finalText)

  // v0.12.9 — implied read: survey CSAT menjawab pelanggan → receipt biru
  try {
    const receipts = require('./receipts')
    receipts.markIncomingRead(tenantId, survey.chatId).catch(re => console.error('[Receipts] csat:', re.message))
  } catch (re) { /* fire-and-forget */ }

  await prisma.csatSurvey.update({
    where: { id: survey.id },
    data: { sentAt: new Date() },
  })

  // Simpan Message: isAuto true, senderId null — firstResponse NIHIL berubah
  const dbMsg = await prisma.message.create({
    data: {
      tenantId,
      chatId: survey.chatId,
      direction: 'out',
      content: encryptText(finalText),
      senderName: SENDER_NAME,
      senderId: null,
      isAuto: true,
      timestamp: new Date(),
      status: 'sent',
    },
  })
  // v0.12.1 — payload bawa assignedToId & status chat (toast gate frontend)
  broadcast.emitToTenant(tenantId, 'new_message', { chatId: survey.chatId, assignedToId: chat.assignedToId ?? null, status: chat.status, message: { ...dbMsg, content: decryptTextSafe(dbMsg.content) } }) // v0.11.0 plaintext
  broadcast.emitToTenant(tenantId, 'chat_update', {
    chatId: survey.chatId,
    lastMessage: finalText,
    lastMessageAt: dbMsg.timestamp,
  })

  console.log(`[CSAT] Survey #${survey.id} terkirim ke chat=${survey.chatId} (tenant ${tenantId})`)
  return 'sent'
}

// ─── Parse balasan inbound (hook messages.upsert) ────────────────────────
/**
 * Cek pesan teks pelanggan: angka 1–5 ATAU deretan ⭐ (1–5 bintang).
 * @returns {number|null} rating 1-5, atau null kalau bukan rating
 */
function parseRating(text) {
  if (!text) return null
  const trimmed = String(text).trim()
  if (!trimmed) return null
  // Angka 1–5 (toleran: "5", "5!", " 3 ")
  const m = trimmed.match(/^([1-5])[!.,,\s]*$/u)
  if (m) return parseInt(m[1], 10)
  // Bintang: hitung ⭐ (satu ⭐ = 1; ⭐⭐⭐⭐⭐ = 5). Harus 1–5, tidak lebih.
  const stars = (trimmed.match(/⭐/g) || []).length
  if (stars >= 1 && stars <= 5 && /^[⭐\s]+$/.test(trimmed)) return stars
  return null
}

/**
 * Hook dari baileys.js messages.upsert (AFTER flow existing, non-blocking).
 * Kalau chat punya CsatSurvey pending (rating null, sudah sent) dan pesan
 * pelanggan adalah rating valid → simpan rating + respondedAt + broadcast.
 * Pesan pelanggan TETAP diproses normal oleh flow utama (hook ini tidak
 * mengubah/menelan pesan).
 * @param {object} chat - Chat row terbaru dari DB
 * @param {string|null} text - isi teks pesan pelanggan
 */
/**
 * v0.10.5 — Silent consume: pesan pelanggan yang adalah JAWABAN SURVEY murni
 * (chat resolved + survey pending + teks = rating murni) → catat rating, return true.
 * Pemanggil (baileys.js, sebelum blok auto-reopen) memakai return ini utk menahan
 * reopen/queue: jawaban survey BUKAN chat baru. Pesan tetap disimpan (transparan).
 * @returns {Promise<boolean>} true jika pesan dikonsumsi sbg rating
 */
async function consumePendingRating(chatId, text) {
  try {
    const rating = parseRating(text)
    if (!rating) return false
    const pending = await prisma.csatSurvey.findFirst({
      where: { chatId, rating: null, sentAt: { not: null } },
      orderBy: { id: 'desc' },
    })
    if (!pending) return false
    const claimed = await prisma.csatSurvey.updateMany({
      where: { id: pending.id, rating: null },
      data: { rating, respondedAt: new Date() },
    })
    if (claimed.count === 0) return false
    console.log(`[CSAT] Rating ${rating} dikonsumsi (silent) utk chat=${chatId} (survey #${pending.id}) — chat tetap resolved`)
    broadcast.emitToTenant(pending.tenantId, 'csat_updated', { chatId, rating, surveyId: pending.id })
    return true
  } catch (e) {
    console.error('[CSAT] consumePendingRating error:', e.message)
    return false
  }
}

async function maybeHandleCsatReply(chat, text) {
  try {
    if (!chat || !chat.id || !text) return
    const rating = parseRating(text)
    if (!rating) return // teks biasa → diabaikan (bukan rating)

    const pending = await prisma.csatSurvey.findFirst({
      where: { chatId: chat.id, rating: null, sentAt: { not: null } },
      orderBy: { id: 'desc' },
    })
    if (!pending) return

    // Atomic claim: hanya update kalau rating masih null (anti race dobel)
    const claimed = await prisma.csatSurvey.updateMany({
      where: { id: pending.id, rating: null },
      data: { rating, respondedAt: new Date() },
    })
    if (claimed.count === 0) return

    const updated = await prisma.csatSurvey.findUnique({ where: { id: pending.id } })
    broadcast.emitToTenant(chat.tenantId, 'csat_updated', {
      chatId: chat.id,
      surveyId: pending.id,
      rating,
      respondedAt: updated.respondedAt,
    })
    console.log(`[CSAT] Rating ${rating} diterima utk chat=${chat.id} (survey #${pending.id})`)
  } catch (e) {
    console.error('[CSAT] maybeHandleCsatReply error:', e.message)
  }
}

module.exports = {
  TIMEZONE,
  SENDER_NAME,
  MAX_TEXT_LEN,
  getConfig,
  invalidateConfig,
  stripUnknownPlaceholders,
  personalizeText,
  createSurveyAfterResolve,
  sendSurveyMessage,
  parseRating,
  maybeHandleCsatReply,
  consumePendingRating,
}