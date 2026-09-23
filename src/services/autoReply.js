/**
 * v0.7.0 — Auto Reply (Outside Hours Reply + First-of-Day Greeting)
 * v0.13.3 — Gateway Entry Fix + Working-Hour Matrix + Unified Frequency (F4)
 *
 * Aturan utama (spec wa-cs-hub-v0.7.0-spec.md + wa-cs-hub-v0.13.3-spec.md):
 * - TIDAK menyentuh antrean: queuedAt / assignment / FIFO nihil perubahan.
 * - TIDAK mengisi firstResponseAt / firstResponseById (analytics hanya hitung CS manusia).
 * - 1 auto message per hari per pelanggan (marker Chat.lastAutoGreetDate, claim atomik).
 * - Dua trigger sama-sama kena → outside-hours menang (1 pesan saja).
 * - Jam kerja hard WIB (Asia/Jakarta), bukan timezone server.
 * - Send gagal → revert marker (pelanggan tetap bisa dapat greeting di pesan berikutnya).
 * - v0.13.3 (F2): greeting menu/text HANYA dalam jam kerja — luar jam satu-satunya
 *   suara adalah away text (bila ON). Luar jam + away OFF = diem total.
 * - v0.13.3 (F4): repeatFrequency Menu Gateway mengatur SEMUA jalur greeting
 *   (menu DAN teks); marker bersama Contact.lastMenuShownAt (upsert-or-skip).
 * - v0.13.3 (invariant §4.3): chat assigned (assignedToId != null) TIDAK pernah
 *   dapat auto message — guard ada di hook pemanggil (baileys.js).
 */

const prisma = require('../prisma')
const broadcast = require('../socket/broadcast')
const { encryptText, decryptTextSafe } = require('./textCrypto') // v0.11.0 — enkripsi at-rest isi pesan
// v3.7 — anti-duplicate re-link kontak orphan (helper shared C1–C4)
const { relinkOrphanContact } = require('../utils/contactRelink')
const TIMEZONE = 'Asia/Jakarta'
const SENDER_NAME = 'Auto Reply'
const MAX_TEXT_LEN = 1000
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

// ─── Config cache PER-TENANT (in-memory, invalidate saat PUT config) ─────
// v3.0 — Map tenantId → config row (AutoReplyConfig @@unique([tenantId])).
const configCache = new Map()

/**
 * Ambil config per tenant. Seed idempoten via tenantSeed (create saat tenant dibuat);
 * helper ini tetap create-catch-race utk keamanan (tenant lama tanpa seed).
 * Hasil di-cache; invalidateConfig(tenantId) dipanggil route PUT.
 */
async function getConfig(tenantId) {
  const tid = Number(tenantId)
  if (!Number.isFinite(tid)) throw new Error('autoReply.getConfig butuh tenantId')
  if (configCache.has(tid)) return configCache.get(tid)
  let cfg = await prisma.autoReplyConfig.findUnique({ where: { tenantId: tid } })
  if (!cfg) {
    cfg = await prisma.autoReplyConfig.create({ data: { tenantId: tid } }).catch(async (e) => {
      // Race dengan server lain — baca ulang
      if (e.code === 'P2002') return prisma.autoReplyConfig.findUnique({ where: { tenantId: tid } })
      throw e
    })
  }
  configCache.set(tid, cfg)
  return cfg
}

function invalidateConfig(tenantId) {
  if (tenantId === undefined) configCache.clear()
  else configCache.delete(Number(tenantId))
}

// ─── WIB helpers (Asia/Jakarta, bukan timezone server) ─────────────────
/**
 * "YYYY-MM-DD" WIB dari Date (default: sekarang).
 * Pakai Intl dengan timeZone eksplisit — server UTC tetap benar.
 */
function wibDateString(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

/**
 * Menit sejak midnight WIB (0–1439) dari Date (default: sekarang).
 */
function wibMinutesOfDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
  const [h, m] = parts.split(':').map(Number)
  return h * 60 + m
}

/**
 * 0 = Minggu ... 6 = Sabtu (getDay semantics), dihitung di zona WIB.
 */
function wibDayOfWeek(date = new Date()) {
  const s = wibDateString(date) // "YYYY-MM-DD"
  const [y, mo, d] = s.split('-').map(Number)
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay()
}

/**
 * Apakah sekarang (WIB) di luar jam operasional menurut config.
 * Hari disabled (mis. Minggu OFF) → dianggap full outside hours.
 */
function isOutsideHours(cfg, date = new Date()) {
  const dow = wibDayOfWeek(date)
  let enabled, start, end
  if (dow === 0) {
    enabled = cfg.sunEnabled; start = cfg.sunStart; end = cfg.sunEnd
  } else if (dow === 6) {
    enabled = cfg.satEnabled; start = cfg.satStart; end = cfg.satEnd
  } else {
    enabled = cfg.monFriEnabled; start = cfg.monFriStart; end = cfg.monFriEnd
  }
  // Hari disabled → full outside hours
  if (!enabled) return true
  if (!TIME_RE.test(start || '') || !TIME_RE.test(end || '')) return true // config rusak → aman sisi outside
  const cur = wibMinutesOfDay(date)
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  return cur < sh * 60 + sm || cur > eh * 60 + em
}

// ─── Personalisasi {name} — pola blast (services/blast.js personalizeMessage) ───
function personalizeText(template, contactName) {
  if (contactName && String(contactName).trim()) {
    return template.replace(/\{name\}/g, contactName)
  }
  let result = template.replace(/\{name\}/g, '')
  result = result.replace(/  +/g, ' ') // double space
  result = result.replace(/\s+,/g, ',').replace(/\s+\./g, '.') // koma/titik menggantung
  return result.trim()
}

/**
 * Strip placeholder selain {name} (dipakai route PUT sebelum simpan).
 */
function stripUnknownPlaceholders(text) {
  return String(text || '').replace(/\{(?!name\})[^{}]*\}/g, '')
}

// ─── v0.13.3 (F4) — Repeat frequency tunggal (marker bersama kontak) ────
/**
 * Apakah kontak boleh dapat greeting lagi (menu ATAU teks — marker BERSAMA
 * Contact.lastMenuShownAt sejak F4)?
 * - per_chat: selalu (tiap chat baru)
 * - daily: lastMenuShownAt bukan hari kalender WIB ini
 * - weekly: ≥7 hari sejak lastMenuShownAt
 * - nilai asing/kosong → 'daily' (default konsisten Menu Gateway; dilindungi
 *   validasi PUT — hanya jalur defensif)
 * - contact null / row belum ada → true (chat baru selalu lolos — dipakai E0)
 * Satu implementasi untuk menu & teks; menuGateway.js re-export fungsi ini.
 * @param {object|null} contact - row Contact (bisa null)
 * @param {string|null} repeatFrequency - dari MenuGatewayConfig.repeatFrequency
 * @param {Date} [now] - waktu acuan (default: sekarang; test bisa inject)
 */
function repeatAllows(contact, repeatFrequency, now = new Date()) {
  if (!repeatFrequency || repeatFrequency === 'per_chat') return true
  if (repeatFrequency !== 'daily' && repeatFrequency !== 'weekly') repeatFrequency = 'daily'
  if (!contact || !contact.lastMenuShownAt) return true
  const last = new Date(contact.lastMenuShownAt)
  if (isNaN(last.getTime())) return true
  if (repeatFrequency === 'daily') {
    // bandingkan hari kalender WIB (format "YYYY-MM-DD", konsisten lastAutoGreetDate)
    return wibDateString(last) !== wibDateString(now)
  }
  // weekly
  return now.getTime() - last.getTime() >= 7 * 24 * 60 * 60 * 1000
}

// ─── v0.13.3 — helper F4: config Menu Gateway (safe; null bila error) ────
/**
 * Baca MenuGatewayConfig via lazy require (hindari circular dependency —
 * menuGateway.js require autoReply.js di top-level). Null bila gagal → pemanggil
 * memperlakukan frekuensi sebagai permissive (repeatAllows(null-freq) = true).
 */
async function menuGatewayConfigSafe(tenantId) {
  try {
    const menuGateway = require('./menuGateway') // lazy — hindari circular require
    return await menuGateway.getConfig(tenantId)
  } catch (e) {
    console.error('[AutoReply] menuGateway.getConfig error (non-fatal):', e.message)
    return null
  }
}

// ─── v0.13.3 — helper F4: marker lastMenuShownAt (upsert-or-skip) ────────
/**
 * Set Contact.lastMenuShownAt = now — marker BERSAMA menu & greeting teks (F4):
 * kontak yang hari ini dapat MENU tidak dapat GREETING text lagi (dan sebaliknya).
 * Upsert-or-skip: row Contact belum ada → create minimal (chatId, source 'chat');
 * create gagal (race unique) → skip senyap; tanpa contact → skip.
 */
async function setContactMenuShown(contact, chat) {
  try {
    const chatId = chat.id
    const tenantId = chat.tenantId
    if (contact && contact.id) {
      await prisma.contact.updateMany({ where: { id: contact.id, tenantId }, data: { lastMenuShownAt: new Date() } })
      return
    }
    // v3.4 — kuota kontak: skip diam bila penuh (chat tetap jalan, spec §4)
    try {
      const plans = require('../services/plans')
      const quota = await plans.checkContactQuota(tenantId)
      if (!quota.ok) return
    } catch {}
    // v3.7 — ANTI-DOBEL: sebelum create minimal, coba re-link kontak orphan
    // (chatId=null, data utuh) by chat.contactPhone. Gagal/null → create baru.
    // LID nuansa: contactPhone invalid/kosong → relink null → biarkan create
    // minimal lama (mapping LID v3.5 yang handle identitas).
    let relinked = null
    if (chat.contactPhone) {
      relinked = await relinkOrphanContact(tenantId, String(chat.contactPhone), chatId, chat.contactName || null)
    }
    if (relinked) {
      await prisma.contact.updateMany({ where: { id: relinked, tenantId }, data: { lastMenuShownAt: new Date() } })
      return
    }
    const created = await prisma.contact.create({ data: { tenantId, chatId, source: 'chat' } }).catch(() => null)
    if (created) {
      await prisma.contact.updateMany({ where: { id: created.id }, data: { lastMenuShownAt: new Date() } })
    }
  } catch (e) {
    console.error('[AutoReply] setContactMenuShown error (non-fatal):', e.message)
  }
}

// ─── v0.13.3 — ANTI-ORPHAN: chat tidak boleh hilang dari radar CS ────────
/**
 * Dipanggil saat jalur menu (b) gagal mengirim apa pun ATAU jalur teks (c)
 * selesai: bila chat masih open+unassigned dan queuedAt masih null → queue-kan
 * (queuedAt=now) + queue_update. Normalnya auto-queue v0.1.21 sudah mengisi
 * queuedAt — helper ini menutup celah chat yang LEWAT dari auto-queue karena
 * E0 (kandidat gateway entry) tapi flow gagal, plus race config menu→text di
 * tengah handler. Idempoten + race-safe (updateMany berkondisi queuedAt null).
 */
async function ensureChatQueued(chatId) {
  try {
    const id = Number(chatId)
    const fresh = await prisma.chat.findUnique({
      where: { id },
      select: { queuedAt: true, status: true, assignedToId: true, tenantId: true },
    })
    if (!fresh || fresh.queuedAt || fresh.status !== 'open' || fresh.assignedToId != null) return
    const res = await prisma.chat.updateMany({
      where: { id, queuedAt: null, assignedToId: null, status: 'open' },
      data: { queuedAt: new Date() },
    })
    if (res.count > 0) {
      try { require('../socket/queue').emitQueueUpdate(fresh.tenantId) } catch { /* non-fatal */ }
      console.log(`[AutoReply] anti-orphan: chat belum queued → queue-kan: ${id}`)
    }
  } catch (e) {
    console.error('[AutoReply] ensureChatQueued error (non-fatal):', e.message)
  }
}

// ─── v3.5 — Greeting skip: agent sudah menyapa duluan hari itu? ──────────
/**
 * Cek apakah ada pesan keluar NON-AUTO (CS manusia, senderId terisi) dari
 * tenant ini di chat yang sama pada hari WIB yang sama.
 * Dipakai sebelum greeting first-of-day DAN outside-hours auto-reply —
 * kalau agen sudah balas/menyapa duluan hari itu, jangan dobel dengan auto.
 * @param {number} tenantId
 * @param {number} chatId
 * @param {Date} ts - waktu acuan (timestamp pesan, bukan waktu proses)
 */
async function hasHumanOutMessageToday(tenantId, chatId, ts = new Date()) {
  try {
    // Start-of-day WIB = 00:00 WIB (= 17:00 UTC sebelumnya, UTC+7)
    const day = wibDateString(ts)
    const [y, mo, d] = day.split('-').map(Number)
    const startOfDay = new Date(Date.UTC(y, mo - 1, d) - 7 * 60 * 60 * 1000) // 00:00 WIB
    const count = await prisma.message.count({
      where: {
        tenantId: Number(tenantId),
        chatId: Number(chatId),
        direction: 'out',
        isAuto: false,
        senderId: { not: null }, // bukan pesan auto/relay/scheduler
        timestamp: { gte: startOfDay },
      },
    })
    return count > 0
  } catch (e) {
    console.error('[AutoReply] hasHumanOutMessageToday error (fail-open=false):', e.message)
    return false
  }
}

// ─── Kirim satu auto message + simpan Message + broadcast (refactor v0.13.0) ──
/**
 * Refactor dari jalur tunggal maybeAutoReply dulu (behavior identik — teks,
 * Message row, broadcast, receipts semua sama) supaya jalur outside-hours dan
 * greeting text bisa dipakai ulang tanpa duplikasi.
 */
async function sendAutoText(chat, text, today) {
  const chatId = chat.id
  const tenantId = chat.tenantId
  const finalText = personalizeText(text, chat.contactName)

  try {
    // Kirim via pool per-tenant (v3 — sendMessage legacy global dihapus).
    const wa = require('../wa/pool')
    await wa.sendMessageForTenant(tenantId, chat.waJid, finalText)
  } catch (sendErr) {
    // Send gagal → revert marker + log (tidak hang selamanya).
    // Null-kan hanya jika marker masih = today (klaim kita sendiri) —
    // tidak pernah menimpa klaim proses lain yang lebih baru.
    console.error(`[AutoReply] send gagal untuk chat=${chatId} (tenant ${tenantId}):`, sendErr.message)
    await prisma.chat.updateMany({
      where: { id: chatId, tenantId, lastAutoGreetDate: today },
      data: { lastAutoGreetDate: null },
    }).catch((e) => console.error('[AutoReply] revert marker gagal:', e.message))
    return false
  }

  // Simpan Message: direction 'out', senderId NULL, senderName 'Auto Reply', isAuto true.
  // SENGaja TIDAK mengisi firstResponseAt/firstResponseById & tidak mengubah
  // queuedAt/assignment/unreadCount (direction 'out' juga tidak menaikkan unread).
  const dbMsg = await prisma.message.create({
    data: {
      tenantId,
      chatId,
      direction: 'out',
      content: encryptText(finalText),
      senderName: SENDER_NAME,
      senderId: null,
      isAuto: true,
      timestamp: new Date(),
      status: 'sent',
    },
  })

  // Broadcast socket existing — chat list & detail update realtime
  // v0.11.0 — broadcast membawa PLAINTEXT (dekrip payload ciphertext)
  // v0.12.1 — payload bawa assignedToId & status chat (toast gate frontend)
  broadcast.emitToTenant(tenantId, 'new_message', { chatId, assignedToId: chat.assignedToId ?? null, status: chat.status ?? null, message: { ...dbMsg, content: decryptTextSafe(dbMsg.content) } })
  broadcast.emitToTenant(tenantId, 'chat_update', {
    chatId,
    lastMessage: finalText,
    lastMessageAt: dbMsg.timestamp,
  })

  // v0.12.9 — implied read: auto-reply menjawab pelanggan → receipt biru ke pelanggan
  // (fire-and-forget; gate AppConfig di dalam service, default OFF)
  try {
    const receipts = require('./receipts')
    receipts.markIncomingRead(tenantId, chatId).catch(re => console.error('[Receipts] autoReply:', re.message))
  } catch (re) { /* fire-and-forget */ }

  console.log(`[AutoReply] auto message terkirim ke chat=${chatId} (tenant ${tenantId})`)
  return true
}

// ─── Trigger utama — dipanggil dari baileys.js messages.upsert ──────────
/**
 * v0.13.3 — matrix keputusan (F1/F2/F4). Dipanggil dari hook akhir handler
 * baileys.js (freshChat re-fetch) HANYA bila eligible:
 *   menuState==null && assignedToId==null && status=='open' && !consumedAsRating
 * (queuedAt SENGGAJA diabaikan — auto-queue/E0 boleh sudah mengisinya; invariant
 * §4.1 menjamin chat awaiting tetap tak terlihat di antrean).
 *
 * Klaim marker lastAutoGreetDate (atomic updateMany, pola v0.7.0) SEBELUM matrix;
 * revert bila tidak ada jalur yang mengirim ATAU send gagal.
 *
 * @param {object} chat - row Chat TERBARU dari DB (dgn include contact bila ada)
 * @param {object} msg - message baileys asli
 * @returns {Promise<{sent: boolean}>} sent=true bila ada auto message terkirim
 */
async function maybeAutoReply(chat, msg) {
  try {
    const chatId = chat.id
    const tenantId = chat.tenantId
    const cfg = await getConfig(tenantId)

    // OFF total → tidak lakukan apa-apa (tidak klaim marker)
    if (!cfg.outsideHoursEnabled && !cfg.greetEnabled && !(cfg.greetMode === 'menu')) return { sent: false }

    // Tanggal WIB dari timestamp PESAN (bukan waktu proses) — konsisten dengan
    // dbTimestamp yang dipakai flow upsert existing.
    const dbTimestamp = msg.messageTimestamp ? new Date(msg.messageTimestamp * 1000) : new Date()
    const today = wibDateString(dbTimestamp)

    // v0.13.3 (F4) — Contact row untuk repeat gate (marker lastMenuShownAt BERSAMA).
    // chat.contact bisa null (include belum terisi) → baca ulang byChatId.
    let contact = chat.contact || null
    if (!contact) {
      contact = await prisma.contact.findUnique({ where: { chatId } }).catch(() => null)
    }

    // ATOMIC CLAIM (race-safe): hanya update jika marker belum = today.
    // PENTING: `{ not: today }` saja TIDAK match row dengan marker NULL
    // (SQL: NULL <> 'x' = UNKNOWN) → harus di-OR dengan null eksplisit.
    const claim = await prisma.chat.updateMany({
      where: { id: chatId, tenantId, OR: [{ lastAutoGreetDate: null }, { lastAutoGreetDate: { not: today } }] },
      data: { lastAutoGreetDate: today },
    })
    if (claim.count === 0) return { sent: false } // sudah ada auto message hari ini → throttle

    // Revert klaim — dipanggil bila tidak ada jalur yang mengirim (pola v0.7.0).
    const revertClaim = async () => {
      await prisma.chat.updateMany({
        where: { id: chatId, tenantId, lastAutoGreetDate: today },
        data: { lastAutoGreetDate: null },
      }).catch((e) => console.error('[AutoReply] revert marker gagal:', e.message))
    }

    const outside = isOutsideHours(cfg, dbTimestamp)

    // v3.5 (§3) — Greeting/away SKIP bila agen sudah menyapa/balas duluan hari itu
    // (pesan out non-auto dari CS manusia di chat yang sama, hari WIB sama).
    // Berlaku utk SEMUA jalur auto (away text, menu, greet text).
    if (await hasHumanOutMessageToday(tenantId, chatId, dbTimestamp)) {
      await prisma.chat.updateMany({
        where: { id: chatId, tenantId, lastAutoGreetDate: { not: today } },
        data: { lastAutoGreetDate: today },
      }).catch((e) => console.error('[AutoReply] set marker skip gagal:', e.message))
      console.log(`[AutoReply] greeting skip — agent sudah menyapa duluan hari ini: chat=${chatId}`)
      return { sent: false }
    }

    // ── (a) Luar jam + away ON → away text (D5). Queue TIDAK disentuh. ──
    if (cfg.outsideHoursEnabled && outside) {
      const awaySent = await sendAutoText(chat, cfg.outsideHoursText, today)
      // Send gagal → marker sudah di-revert di dalam sendAutoText.
      return { sent: !!awaySent }
    }

    // ── (b) Dalam jam + greetMode 'menu' → startFlow (intro + awaiting) ──
    // v0.13.3 (F2): menu HANYA dalam jam kerja (di luar jam = jalur (a)/(d) saja).
    if (!outside && cfg.greetEnabled && cfg.greetMode === 'menu') {
      const menuGW = await menuGatewayConfigSafe(tenantId)
      const gatewayOn = !!(menuGW && menuGW.enabled)
      if (gatewayOn && repeatAllows(contact, menuGW.repeatFrequency, dbTimestamp)) {
        let handled = false
        try {
          const menuGateway = require('./menuGateway') // lazy — hindari circular require
          handled = await menuGateway.startFlow(chat)
        } catch (e) {
          console.error('[AutoReply] menuGateway.startFlow error (non-fatal):', e.message)
        }
        if (handled) {
          // Verifikasi intro benar-benar terkirim: startFlow me-revert menuState→null
          // bila send gagal. Awaiting = sukses; selain itu = gagal kirim.
          const post = await prisma.chat.findUnique({ where: { id: chatId }, select: { menuState: true } })
          if (post && post.menuState === 'awaiting') {
            // queue_update sesuai matrix (b) — count bisa berubah bila chat
            // sebelumnya terlihat di antrean (reopened → awaiting) atau memang
            // baru masuk limbo (E0 melongkahi auto-queue).
            try { require('../socket/queue').emitQueueUpdate(tenantId) } catch { /* non-fatal */ }
            return { sent: true }
          }
        }
        // handled=false (race/exception/config berubah) ATAU send gagal → jatuh ke
        // exit gagal di bawah (TANPA fallback greet text — matrix strict).
      }
      // Tidak ada jalur mengirim (gateway OFF / repeat blocked / startFlow gagal /
      // send gagal) → skip total TANPA fallback greet text + revert klaim +
      // ANTI-ORPHAN: bila chat belum queued (bawaan E0) → queue-kan + queue_update
      // (chat tidak boleh hilang dari radar CS — spec F1 matrix (b)).
      await revertClaim()
      await ensureChatQueued(chatId)
      return { sent: false }
    }

    // ── (c) Dalam jam + greetMode 'text' → greet text + queue utuh + marker ──
    // v0.13.3 (F4): frekuensi ikut MenuGatewayConfig.repeatFrequency (disatukan),
    // marker = Contact.lastMenuShownAt (sama dgn menu).
    if (!outside && cfg.greetEnabled && cfg.greetMode === 'text') {
      const menuGW = await menuGatewayConfigSafe(tenantId)
      const freq = menuGW ? menuGW.repeatFrequency : null
      if (!repeatAllows(contact, freq, dbTimestamp)) {
        // Repeat blocked → skip total (tanpa fallback greet).
        await revertClaim()
        await ensureChatQueued(chatId) // anti-orphan (race menu→text di tengah handler)
        return { sent: false }
      }
      const greetSent = await sendAutoText(chat, cfg.greetText, today)
      if (greetSent) {
        // Marker kontak HANYA bila teks benar-benar terkirim (F4 — kontak yang
        // greeting-nya gagal kirim tetap berhak dapat di pesan berikutnya).
        await setContactMenuShown(contact, chat)
      }
      // Queue utuh: normalnya auto-queue sudah mengisi queuedAt (E0 tidak lolos
      // utk greetMode text) — ensure menutup race config di tengah handler.
      await ensureChatQueued(chatId)
      return { sent: !!greetSent }
    }

    // ── (d) Selain itu → diem total (tanpa auto message) ──
    await revertClaim()
    return { sent: false }
  } catch (e) {
    console.error('[AutoReply] maybeAutoReply error:', e)
    return { sent: false }
  }
}

module.exports = {
  getConfig,
  invalidateConfig,
  isOutsideHours,
  personalizeText,
  stripUnknownPlaceholders,
  repeatAllows,
  menuGatewayConfigSafe,
  setContactMenuShown,
  ensureChatQueued,
  maybeAutoReply,
  hasHumanOutMessageToday, // v3.5
  wibDateString,
  TIME_RE,
  MAX_TEXT_LEN,
}