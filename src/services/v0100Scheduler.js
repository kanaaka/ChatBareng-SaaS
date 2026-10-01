/**
 * v0.10.0 — "Empat Fitur": Scheduler gabungan in-process (interval menit WIB)
 *
 * Aturan utama (spec wa-cs-hub-v0.10.0-spec.md):
 * - SATU interval menit (pola gdriveBackup v0.8.0 — in-process, BUKAN cron eksternal)
 *   menjalankan 3 job: (A) snooze expiry, (C) CSAT survey yang belum terkirim, (D) pesan terjadwal.
 * - Anti kirim dobel: job D pakai atomic claim updateMany (status pending → sent sebelum kirim)
 *   sehingga dua tick / restart tidak pernah mengirim dua kali.
 * - Waktu WIB eksplisit (Asia/Jakarta), bukan timezone server.
 * - Semua send gagal → tidak crash; status error dicatat; toast dikirim ke creator.
 * - TIDAK mengubah antrean (queuedAt/assignment) dan TIDAK mengisi
 *   firstResponseAt/firstResponseById — konsisten pola autoReply v0.7.0.
 */

const prisma = require('../prisma')
const broadcast = require('../socket/broadcast')
const { encryptText, decryptTextSafe } = require('./textCrypto') // v0.11.0 — enkripsi at-rest isi pesan

const TIMEZONE = 'Asia/Jakarta'
const CHECK_INTERVAL_MS = 30 * 1000 // 2× per menit — sama dgn gdriveBackup v0.8.0
const CSAT_EXPIRE_DAYS = 7 // pending > 7 hari → expired (spec §3, opsional tapi aman)
const MAX_TICK_MS = 8000 // guard tick overlap (tick > 8s dianggap masih jalan → skip)

// ─── WIB helpers (pola autoReply.js v0.7.0) ─────────────────────────────
function wibDateString(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

// ─── Personalisasi {name} — pola blast/autoReply (kosong → bersihkan menggantung) ──
function personalizeText(template, contactName) {
  if (contactName && String(contactName).trim()) {
    return template.replace(/\{name\}/g, contactName)
  }
  let result = template.replace(/\{name\}/g, '')
  result = result.replace(/  +/g, ' ')
  result = result.replace(/\s+,/g, ',').replace(/\s+\./g, '.')
  return result.trim()
}

// ─── Job A — Snooze expiry ───────────────────────────────────────────────
/**
 * Chat dengan snoozedUntil <= now → kosongkan snoozedUntil/snoozedBy
 * + broadcast chat_update (chat kembali muncul di list sesuai state assignment-nya).
 */
async function processSnoozeExpiry() {
  const now = new Date()
  const due = await prisma.chat.findMany({
    where: { snoozedUntil: { not: null, lte: now } },
    select: { id: true, tenantId: true, contactName: true, contactPhone: true, snoozedUntil: true, snoozedBy: true },
    take: 200,
  })
  for (const chat of due) {
    try {
      // Atomic clear: hanya bila snoozedUntil masih sama (hindari race dgn cancel manual)
      const cleared = await prisma.chat.updateMany({
        where: { id: chat.id, tenantId: chat.tenantId, snoozedUntil: chat.snoozedUntil },
        data: { snoozedUntil: null, snoozedBy: null },
      })
      if (cleared.count === 0) continue
      console.log(`[Scheduler v0.10.0] Snooze selesai → chat kembali: chat=${chat.id} (tenant ${chat.tenantId})`)
      broadcast.emitToTenant(chat.tenantId, 'chat_update', {
        chatId: chat.id,
        snoozedUntil: null,
        snoozedBy: null,
        snoozeReturned: true, // flag utk frontend: toast "kembali dari snooze"
        snoozeContactName: chat.contactName || chat.contactPhone || chat.id,
      })
    } catch (e) {
      console.error('[Scheduler v0.10.0] snooze expiry error:', e.message)
    }
  }
  return due.length
}

// ─── Job C — CSAT survey kirim (bila scheduler tidak sempat saat resolve) ──
/**
 * Survey sentAt = null dan belum expired → coba kirim (self-heal:
 * biasanya terkirim langsung saat resolve; ini safety net + path restart).
 * Kalau WA tidak connect → biarkan pending (dicoba lagi tick berikutnya
 * sampai 7 hari, lalu expired).
 */
async function processCsatPending() {
  const deadline = new Date(Date.now() - CSAT_EXPIRE_DAYS * 24 * 60 * 60 * 1000)
  const pending = await prisma.csatSurvey.findMany({
    where: { sentAt: null, createdAt: { gte: deadline } },
    select: { id: true, chatId: true, tenantId: true, token: true },
    take: 50,
  })
  for (const survey of pending) {
    try {
      const chat = await prisma.chat.findFirst({
        where: { id: survey.chatId, tenantId: survey.tenantId },
        select: { contactName: true, status: true },
      })
      if (!chat || chat.status !== 'resolved') continue // chat di-reopen → jangan kirim
      const sent = await require('./csat').sendSurveyMessage(survey.id)
      if (sent === 'sent' || sent === 'already_sent') {
        console.log(`[Scheduler v0.10.0] CSAT survey #${survey.id} terkirim (self-heal)`)
      }
    } catch (e) {
      console.error(`[Scheduler v0.10.0] CSAT pending #${survey.id} error:`, e.message)
    }
  }
  return pending.length
}

// ─── Job D — Pesan terjadwal ─────────────────────────────────────────────
/**
 * Ambil ScheduledMessage status=pending & scheduledAt <= now → kirim via Baileys.
 * ATOMIC CLAIM: status pending → 'sending' dulu (updateMany where pending),
 * jadi dua tick/restart tidak akan mengirim dobel. Setelah kirim sukses → 'sent'.
 */
async function processScheduledMessages() {
  const now = new Date()
  const due = await prisma.scheduledMessage.findMany({
    where: { status: 'pending', scheduledAt: { lte: now } },
    include: {
      chat: { select: { waJid: true, tenantId: true, contactName: true, contactPhone: true, id: true, assignedToId: true, status: true } },
      user: { select: { id: true, username: true } },
    },
    take: 100,
    orderBy: { scheduledAt: 'asc' },
  })

  let sentCount = 0
  for (const sm of due) {
    // Atomic claim — hindari kirim dobel saat restart/overlap tick
    const claim = await prisma.scheduledMessage.updateMany({
      where: { id: sm.id, status: 'pending' },
      data: { status: 'sending' },
    })
    if (claim.count === 0) continue // sudah di-claim proses lain

    try {
      // v0.12.4 — enkripsi scope 2: body tersimpan ciphertext → dekrip sebelum kirim
      // & personalisasi {name} jalan di plaintext
      const finalText = personalizeText(decryptTextSafe(sm.body), sm.chat?.contactName)
      const tenantId = sm.chat?.tenantId || sm.tenantId
      const wa = require('../wa/pool')
      // v3.9 — via nomor asal chat (numberSlot; null = slot-0 compat)
      await wa.sendMessageForTenant(tenantId, sm.chat?.waJid, finalText, { slot: Number(sm.chat?.numberSlot) || 0 })

      // v0.12.9 — implied read: pesan terjadwal menjawab pelanggan → receipt biru
      try {
        const receipts = require('./receipts')
        receipts.markIncomingRead(tenantId, sm.chatId).catch(re => console.error('[Receipts] scheduled:', re.message))
      } catch (re) { /* fire-and-forget */ }

      const dbMsg = await prisma.message.create({
        data: {
          tenantId,
          chatId: sm.chatId,
          direction: 'out',
          content: encryptText(finalText),
          senderName: `${sm.user?.username || 'CS'} (terjadwal)`,
          senderId: null, // isAuto-style: bukan CS manusia (firstResponse nihil)
          isAuto: true,
          timestamp: new Date(),
          status: 'sent',
        },
      })

      await prisma.scheduledMessage.update({
        where: { id: sm.id },
        data: { status: 'sent', sentAt: new Date(), error: null },
      })

      // Broadcast — chat & list update realtime (pola existing, tenant-scoped)
      // v0.11.0 — broadcast membawa PLAINTEXT (dekrip payload ciphertext)
      // v0.12.1 — payload bawa assignedToId & status chat (toast gate frontend)
      broadcast.emitToTenant(tenantId, 'new_message', { chatId: sm.chatId, assignedToId: sm.chat?.assignedToId ?? null, status: sm.chat?.status ?? null, message: { ...dbMsg, content: decryptTextSafe(dbMsg.content) } })
      broadcast.emitToTenant(tenantId, 'chat_update', {
        chatId: sm.chatId,
        lastMessage: finalText,
        lastMessageAt: dbMsg.timestamp,
      })

      // Toast ke creator: pesan terjadwal terkirim
      broadcast.emitToTenant(tenantId, 'scheduled_sent', {
        id: sm.id,
        chatId: sm.chatId,
        createdById: sm.createdById,
        contactName: sm.chat?.contactName || sm.chat?.contactPhone || sm.chatId,
      })

      sentCount++
      console.log(`[Scheduler v0.10.0] Pesan terjadwal #${sm.id} terkirim ke chat=${sm.chatId} (tenant ${tenantId})`)
    } catch (e) {
      const errMsg = (e.message || 'Unknown error').slice(0, 500)
      console.error(`[Scheduler v0.10.0] Pesan terjadwal #${sm.id} GAGAL:`, errMsg)
      await prisma.scheduledMessage.update({
        where: { id: sm.id },
        data: { status: 'error', error: errMsg },
      }).catch(() => {})
      broadcast.emitToTenant(sm.tenantId, 'scheduled_error', {
        id: sm.id,
        chatId: sm.chatId,
        createdById: sm.createdById,
        error: errMsg,
      })
    }
  }
  return sentCount
}

// ─── Tick gabungan ───────────────────────────────────────────────────────
let tickRunning = false
async function tick() {
  if (tickRunning) return // guard overlap
  tickRunning = true
  const startedAt = Date.now()
  try {
    await processSnoozeExpiry()
    await processScheduledMessages()
    await processCsatPending()
  } catch (e) {
    console.error('[Scheduler v0.10.0] tick error:', e.message)
  } finally {
    tickRunning = false
  }
}

// ─── Init (dipanggil dari server.js) ─────────────────────────────────────
let schedulerTimer = null
function initV0100Scheduler() {
  if (schedulerTimer) return
  schedulerTimer = setInterval(() => {
    tick()
  }, CHECK_INTERVAL_MS)
  console.log(`[Scheduler v0.10.0] Started (interval ${CHECK_INTERVAL_MS / 1000}s, WIB ${TIMEZONE}) — snooze + scheduled + csat`)
}

function stopV0100Scheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer)
    schedulerTimer = null
    console.log('[Scheduler v0.10.0] Stopped')
  }
}

// Jalankan satu tick segera (untuk smoke test tanpa menunggu interval)
async function tickOnce() {
  return tick()
}

module.exports = {
  TIMEZONE,
  CHECK_INTERVAL_MS,
  personalizeText,
  wibDateString,
  processSnoozeExpiry,
  processScheduledMessages,
  processCsatPending,
  tickOnce,
  initV0100Scheduler,
  stopV0100Scheduler,
}