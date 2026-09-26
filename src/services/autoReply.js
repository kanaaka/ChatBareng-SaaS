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
// v4.0.0 — CB-AI constants (window 24 jam + validasi mode)
const CBAI_MODES = ['text', 'cbai'] // outsideHoursMode (D4); greetMode extended: 'cbai'
const GREET_MODES_V4 = ['text', 'menu', 'cbai'] // greetMode (extend value "cbai" — kolom existing)
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
  // v3.9 fix BUG-1 (+ compound-NULL fix): Prisma menolak compound key dgn NULL → findFirst
  let cfg = await prisma.autoReplyConfig.findFirst({ where: { tenantId: tid, numberSlot: null } })
  if (!cfg) {
    cfg = await prisma.autoReplyConfig.create({ data: { tenantId: tid, numberSlot: null } }).catch(async (e) => {
      // Race dengan server lain — baca ulang
      if (e.code === 'P2002') return prisma.autoReplyConfig.findFirst({ where: { tenantId: tid, numberSlot: null } })
      throw e
    })
  }
  configCache.set(tid, cfg)
  return cfg
}

/**
 * v3.9 — resolve config untuk SLOT tertentu: baris dgn numberSlot = slot → menang;
 * tidak ada → fallback config shared (numberSlot null = link-all). Cache per
 * (tenantId:slot) — invalidateConfig tetap membersihkan semuanya.
 */
async function getConfigForSlot(tenantId, slot = 0) {
  const tid = Number(tenantId)
  const s = Number(slot) || 0
  const key = `${tid}:${s}`
  if (configCache.has(key)) return configCache.get(key)
  // v3.9.4 — semantik tick-box: slot dgn row sendiri → pakai row itu; tanpa row →
  // fallback shared (numberSlot null). Mode per-slot aktif dinetralkan lewat shared
  // row (trigger OFF) oleh PUT — bukan lewat proto OFF di sini, supaya slot yang
  // sengaja tidak dicentang tetap mengikuti baseline "Semua nomor" yang berlaku.
  let cfg = await prisma.autoReplyConfig.findFirst({
    where: { tenantId: tid, OR: [{ numberSlot: s }, { numberSlot: null }] },
    orderBy: [{ numberSlot: 'desc' }], // slot-spesifik (non-null) menang di atas null
  })
  if (!cfg) cfg = await getConfig(tid) // fallback seed/compat
  configCache.set(key, cfg)
  return cfg
}

/**
 * v3.9.4 — daftar slot yang PUNYA row config sendiri (utk UI tick-box).
 * scoped      = slot dgn row mode text (dikelola halaman Auto Reply).
 * menuManaged = slot dgn row mode menu (dikelola halaman Menu Gateway — dilindungi
 *               dari save Auto Reply supaya rules menu tidak menabrak rules teks).
 */
async function listSlotsWithConfig(tenantId) {
  const rows = await prisma.autoReplyConfig.findMany({
    where: { tenantId: Number(tenantId), numberSlot: { not: null } },
    select: { numberSlot: true, greetMode: true },
  })
  const scoped = []
  const menuManaged = []
  for (const r of rows) {
    const s = Number(r.numberSlot)
    if (r.greetMode === 'menu') menuManaged.push(s)
    else scoped.push(s)
  }
  return {
    scoped: scoped.sort((a, b) => a - b),
    menuManaged: menuManaged.sort((a, b) => a - b),
  }
}

function invalidateConfig(tenantId) {
  // v3.9 — cache key kini bisa tenantId ATAU "tenantId:slot" → clear semua
  // (jumlah entry kecil; paling aman untuk kedua bentuk key).
  configCache.clear()
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
async function menuGatewayConfigSafe(tenantId, slot = null) {
  try {
    const menuGateway = require('./menuGateway') // lazy — hindari circular require
    // v3.9.5 fix QA-2 — slot-aware: menu per-slot (tick-box) dibaca per slot asal chat.
    // Bug lama: selalu getConfig(shared) → gateway per-slot TIDAK PERNAH terbaca
    // (shared disabled) → intro tak terkirim walau MG slot enabled. Jalur (c) freq
    // juga ikut config efektif slot.
    if (slot !== null && slot !== undefined) return await menuGateway.getConfigForSlot(tenantId, slot)
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
    // v3.9 — via nomor asal chat (numberSlot; null = slot-0 compat) — JANGAN fallback.
    const wa = require('../wa/pool')
    await wa.sendMessageForTenant(tenantId, chat.waJid, finalText, { slot: Number(chat.numberSlot) || 0 })
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

// ─── v4.0.0 — CB-AI counter/window (D5/D6) ─────────────────────────────
/**
 * v4.0.0 fix audit MEDIUM-1 (TOCTOU) — RESERVE 1 slot budget ATOMIK SEBELUM LLM
 * (reserve-then-revert, pola claim marker v0.7.0). Guard `aiReplyCount < limit`
 * di dalam updateMany → dua pesan beruntun gak bisa lagi sama-sama lewat limit
 * (.count===0 = kalah race). Pesan gagal terkirim → revert via revertAiCounter.
 * Return { ok:true, prev } | { ok:false } — prev = snapshot utk revert.
 */
async function reserveAiSlot(chat, limit) {
  const aiKnowledge = require('./aiKnowledge') // lazy — hindari circular require
  const now = new Date()
  const lim = Math.min(aiKnowledge.CBAI_LIMIT_MAX, Math.max(aiKnowledge.CBAI_LIMIT_MIN, Number(limit) || 3))
  const fresh = await prisma.chat.findUnique({ where: { id: chat.id }, select: { aiReplyCount: true, lastAiReplyAt: true } }).catch(() => null)
  const b = aiKnowledge.cbaiBudget(fresh || chat, now)
  const cutoff = new Date(now.getTime() - aiKnowledge.AI_WINDOW_MS)
  let res
  if (b.resetBudget) {
    // Window habis → reset ATOMIK (guard: marker memang NULL/kedaluwarsa)
    res = await prisma.chat.updateMany({
      where: { id: chat.id, tenantId: chat.tenantId, OR: [{ lastAiReplyAt: null }, { lastAiReplyAt: { lt: cutoff } }] },
      data: { aiReplyCount: 1, lastAiReplyAt: now },
    })
  } else {
    res = await prisma.chat.updateMany({
      where: { id: chat.id, tenantId: chat.tenantId, aiReplyCount: { lt: lim } },
      data: { aiReplyCount: { increment: 1 }, lastAiReplyAt: now },
    })
  }
  if (res.count === 0) return { ok: false } // kalah race / limit habis
  return { ok: true, prev: { count: b.resetBudget ? 0 : b.count, lastAiReplyAt: fresh?.lastAiReplyAt || null } }
}

/**
 * Tandai balasan AI (jawaban ATAU fallback — D5): aiReplyCount++ + lastAiReplyAt=now.
 * v4.0.0 fix audit MEDIUM-1 — increment ATOMIK dengan guard `aiReplyCount < limit`
 * (counter gak pernah lewat limit walau race; kalah race → counter tetap = limit).
 * Window ≥24h → counter direset 1 (budget segar).
 */
async function bumpAiCounter(chat, limit = null) {
  const aiKnowledge = require('./aiKnowledge') // lazy — hindari circular require
  const now = new Date()
  const lim = limit === null
    ? aiKnowledge.CBAI_LIMIT_MAX
    : Math.min(aiKnowledge.CBAI_LIMIT_MAX, Math.max(aiKnowledge.CBAI_LIMIT_MIN, Number(limit) || 3))
  const fresh = await prisma.chat.findUnique({ where: { id: chat.id }, select: { aiReplyCount: true, lastAiReplyAt: true } }).catch(() => null)
  const b = aiKnowledge.cbaiBudget(fresh || chat, now)
  if (b.resetBudget) {
    await prisma.chat.updateMany({ where: { id: chat.id, tenantId: chat.tenantId }, data: { aiReplyCount: 1, lastAiReplyAt: now } })
    return 1
  }
  const res = await prisma.chat.updateMany({
    where: { id: chat.id, tenantId: chat.tenantId, aiReplyCount: { lt: lim } },
    data: { aiReplyCount: { increment: 1 }, lastAiReplyAt: now },
  })
  if (res.count === 0) {
    // Kalah race (counter = limit) → refresh marker window saja (tetap bisu sesuai design)
    await prisma.chat.updateMany({ where: { id: chat.id, tenantId: chat.tenantId }, data: { lastAiReplyAt: now } }).catch(() => {})
    return lim
  }
  return (b.count || 0) + 1
}

/** Revert counter/marker setelah send gagal (pola sendAutoText revert marker) — baca ulang dulu. */
async function revertAiCounter(chat, prev) {
  try {
    await prisma.chat.updateMany({
      where: { id: chat.id, tenantId: chat.tenantId },
      data: { aiReplyCount: prev.count, lastAiReplyAt: prev.lastAiReplyAt },
    })
  } catch (e) {
    console.error('[AutoReply] revert AI counter gagal:', e.message)
  }
}

/**
 * Ekstrak plaintext pesan customer dari msg baileys (pola extractText pool):
 * conversation / extendedTextMessage / caption. Media tanpa caption → '' (AI QA
 * teks-only — media TIDAK dijawab CB-AI, jatuh ke jalur lama).
 */
function effectiveTextForCbai(msg) {
  try {
    const m = msg?.message || {}
    return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption || ''
  } catch {
    return ''
  }
}

/**
 * cbaiReplyForMessage(chat, cfg, today, { outside, customerText, kbSvc }) →
 *   { sent: boolean, used: boolean }
 * - used=true  → jalur CB-AI selesai (kirim ATAU bisu-by-design) → pemanggil return
 * - used=false → guard gagal → jatuh ke jalur lama PERSIS (outside: away existing;
 *   in-hours: greet text/menu existing)
 *
 * Detail (spec §7):
 * - Window 24 jam + counter shared (lastAiReplyAt/aiReplyCount — D5/D6).
 * - limit habis + window hidup → DEGRADE: outside → away text TANPA counter;
 *   in-hours → BISU {sent:false, used:true} (queue normal).
 * - Guard berlapis di answerFromKnowledge: plan + KB aktif + AiConfig hasKey.
 * - covered → sendAutoText + counter++/marker; no_answer/gagal → fallback
 *   DETERMINISTIK + DIHITUNG (D5/Q1 final): outside → outsideHoursText;
 *   in-hours → greetText.
 * - Send gagal → counter/marker di-revert (pola sendAutoText revert marker).
 * - Chat TIDAK di-set resolved/taken — tetap di queue (D7).
 */
async function cbaiReplyForMessage(chat, cfg, today, { outside = false, customerText = '', kbSvc = null } = {}) {
  const chatId = chat.id
  const tenantId = chat.tenantId
  const aiKb = kbSvc || require('./aiKnowledge') // lazy — hindari circular require
  let resv = { ok: false, prev: null } // fix audit MEDIUM-1 — snapshot reserve utk revert di catch
  try {
    // ── Fix audit MEDIUM-1 (TOCTOU): RESERVE slot budget ATOMIK SEBELUM LLM ──
    // (reserve-then-revert, pola claim marker). Gagal reserve (limit habis/kalah
    // race) → degrade TANPA LLM call (0 cost); LLM/send gagal → revert ke prev.
    const limit = Math.min(aiKb.CBAI_LIMIT_MAX, Math.max(aiKb.CBAI_LIMIT_MIN, Number(cfg.cbaiLimit) || 3))
    resv = await reserveAiSlot(chat, limit)
    if (!resv.ok) {
      // Limit habis / kalah race → degrade (TIDAK ada LLM call, 0 cost — N5/N8):
      //   outside → away text per pesan TANPA counter (deterministik — Q2 final);
      //   in-hours → bisu (queue normal, pesan customer utk di-take agent).
      if (outside) {
        const awaySent = await sendAutoText(chat, cfg.outsideHoursText, today)
        return { sent: !!awaySent, used: true } // jalur CB-AI selesai (degrade away) — TIDAK jatuh ke jalur lain
      }
      console.log(`[AutoReply] CB-AI budget habis (race-safe reserve) → in-hours bisu: chat=${chatId}`)
      return { sent: false, used: true }
    }
    const prev = resv.prev

    // ── QA closed-book (§6) — guard plan/doc/AiConfig di dalam service ──
    const freshChat = await prisma.chat.findUnique({ where: { id: chatId }, include: { contact: true } })
    const r = await aiKb.answerFromKnowledge({
      tenantId,
      chat: freshChat || chat,
      customerText,
      mode: 'cbai',
      cbaiInfoFooter: cfg.cbaiInfoFooter !== false,
    })
    if (!r.ok) {
      // Guard gagal (plan ✗/0 doc/NO_CONFIG/error) → jalur lama PERSIS (deterministik).
      // Reserve dikembalikan (tidak ada pesan keluar dari tier AI).
      await revertAiCounter(chat, prev)
      // outside → away existing; in-hours → greet text/menu existing (pemanggil lanjut).
      return { sent: false, used: false }
    }

    if (r.covered) {
      // ── Jawaban AI + counter SUDAH direserve (fix MEDIUM-1) + lastAiReplyAt=now (D5) ──
      const sent = await sendAutoText(chat, r.answer, today)
      if (sent) {
        console.log(`[AutoReply] CB-AI jawaban terkirim (covered) chat=${chatId} counter→${prev.count + 1}`)
        return { sent: true, used: true }
      }
      // Send gagal → counter/marker di-revert (reserve dikembalikan)
      await revertAiCounter(chat, prev)
      return { sent: false, used: false }
    }

    // ── no_answer / parse fail / LLM gagal → fallback DETERMINISTIK + DIHITUNG (D5) ──
    const fallbackText = outside ? cfg.outsideHoursText : cfg.greetText
    if (!fallbackText || !String(fallbackText).trim()) {
      // Fallback kosong → tidak ada yang dikirim; reserve dikembalikan (TIDAK dihitung).
      await revertAiCounter(chat, prev)
      return { sent: false, used: false }
    }
    const sent = await sendAutoText(chat, fallbackText, today)
    if (sent) {
      console.log(`[AutoReply] CB-AI no_answer → fallback ${outside ? 'outsideHoursText' : 'greetText'} terkirim + counter→${prev.count + 1}: chat=${chatId}`)
      return { sent: true, used: true }
    }
    // Send gagal → revert (counter tidak naik)
    await revertAiCounter(chat, prev)
    return { sent: false, used: false }
  } catch (e) {
    console.error('[AutoReply] cbaiReplyForMessage error (non-fatal):', e.message)
    if (resv && resv.ok) await revertAiCounter(chat, resv.prev).catch(() => {}) // reserve dikembalikan
    return { sent: false, used: false }
  }
}

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
    // v3.9 — config resolved per SLOT asal chat (link-all null = fallback shared)
    const cfg = await getConfigForSlot(tenantId, chat.numberSlot)

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
    // v4.0.0 (spec §7): bila SALAH SATU mode CB-AI aktif, claim marker DILEWATI —
    // anti-spam CB-AI = budget limit+jendela 24 jam (D5), BUKAN throttle 1×/hari
    // (spec: "CB-AI in-hours TIDAK pakai repeat-gate / anti-spam = limit+window").
    const kbSvc0 = require('./aiKnowledge')
    const plansSvc0 = require('../services/plans')
    const plan0 = await plansSvc0.getPlan(tenantId).catch(() => null)
    const planOk0 = !!(plan0 && plan0.featAiKnowledge === true)
    const outside0 = isOutsideHours(cfg, dbTimestamp)
    const cbaiActive0 = planOk0 && ((outside0 && cfg.outsideHoursMode === 'cbai') || (!outside0 && cfg.greetEnabled && cfg.greetMode === 'cbai'))
    let claimed = true // CB-AI path: tanpa marker 1×/hari (budget sendiri)
    let claimReverted = false
    if (!cbaiActive0) {
      const claim = await prisma.chat.updateMany({
        where: { id: chatId, tenantId, OR: [{ lastAutoGreetDate: null }, { lastAutoGreetDate: { not: today } }] },
        data: { lastAutoGreetDate: today },
      })
      if (claim.count === 0) return { sent: false } // sudah ada auto message hari ini → throttle
    } else {
      // claim tercatat sebagai "sudah diklaim" — jalur CB-AI TIDAK menyentuh marker;
      // jalur lama (degrade) di bawah tetap jalan TANPA claim/revert (diem/away pun
      // tidak akan tercapai bila cbaiActive — kecuali guard CB-AI gagal, lihat bawah).
      claimReverted = true
    }

    // Revert klaim — dipanggil bila tidak ada jalur yang mengirim (pola v0.7.0).
    // Fix audit LOW-1: bila CB-AI aktif kita TIDAK meng-claim (claimReverted=true) →
    // JANGAN men-null marker `lastAutoGreetDate` yang mungkin diset jalur lain hari itu.
    const revertClaim = async () => {
      if (cbaiActive0 || claimReverted) return
      await prisma.chat.updateMany({
        where: { id: chatId, tenantId, lastAutoGreetDate: today },
        data: { lastAutoGreetDate: null },
      }).catch((e) => console.error('[AutoReply] revert marker gagal:', e.message))
    }

    const outside = isOutsideHours(cfg, dbTimestamp)

    // v3.5 (§3) — Greeting/away SKIP bila agen sudah menyapa/balas duluan hari itu
    // (pesan out non-auto dari CS manusia di chat yang sama, hari WIB sama).
    // Berlaku utk SEMUA jalur auto (away text, menu, greet text) — v4.0.0: CB-AI JUGA
    // ditutup di sini (D6: human bales ≠ reset, skip SEMUA auto hari itu).
    if (await hasHumanOutMessageToday(tenantId, chatId, dbTimestamp)) {
      await prisma.chat.updateMany({
        where: { id: chatId, tenantId, lastAutoGreetDate: { not: today } },
        data: { lastAutoGreetDate: today },
      }).catch((e) => console.error('[AutoReply] set marker skip gagal:', e.message))
      console.log(`[AutoReply] greeting skip — agent sudah menyapa duluan hari ini: chat=${chatId}`)
      return { sent: false }
    }

    // v4.0.0 — CB-AI PRECEDENCE (spec §3): mode 'cbai' + plan OK → jalur AI (outside &
    // in-hours); SELAIN itu → jalur lama PERSIS. (plan/mode dihitung di claim block atas
    // — cbaiActive0; guard berlapis sisanya di dalam cbaiReplyForMessage.)
    if (cbaiActive0) {
      const r = await cbaiReplyForMessage(chat, cfg, today, { outside, customerText: effectiveTextForCbai(msg), kbSvc: kbSvc0 })
      // used=true → jalur CB-AI selesai (kirim/bisu-by-design) → return (tidak jatuh ke greeting lain).
      // used=false → guard gagal/limit-degrade → lanjut jalur lama di bawah (outside: away
      // existing; in-hours: greet text/menu existing — perilaku degrade PERSIS jalur lama).
      // CATATAN outside-degrade: away sudah terkirim di dalam cbaiReplyForMessage →
      // di sini KITA return (jalur (a) away existing TIDAK kirim dobel). used=true +
      // sent=false (in-hours bisu) juga return — pesan customer sudah tersimpan queue.
      if (r && r.used) return { sent: !!r.sent }
    }

    // v3.5 — human-out skip SUDAH di-evaluasi di atas (SEBELUM CB-AI) — jalur lama di
    // bawah hanya dijangkau bila TIDAK ada human out hari itu (atau CB-AI idle dgn
    // used=false → skip check tidak men-trigger; satu-satunya jalan ke sini adalah
    // sudah lolos skip check). Marker skip tetap ter-set utk kedua jalur.

    // ── (a) Luar jam + away ON → away text (D5). Queue TIDAK disentuh. ──

    // ── (a) Luar jam + away ON → away text (D5). Queue TIDAK disentuh. ──
    if (cfg.outsideHoursEnabled && outside) {
      const awaySent = await sendAutoText(chat, cfg.outsideHoursText, today)
      // Send gagal → marker sudah di-revert di dalam sendAutoText.
      return { sent: !!awaySent }
    }

    // ── (b) Dalam jam + greetMode 'menu' → startFlow (intro + awaiting) ──
    // v0.13.3 (F2): menu HANYA dalam jam kerja (di luar jam = jalur (a)/(d) saja).
    if (!outside && cfg.greetEnabled && cfg.greetMode === 'menu') {
      // v3.9.5 — config MG EFEKTIF utk slot asal chat (per-slot tick-box), bukan shared
      const menuGW = await menuGatewayConfigSafe(tenantId, chat.numberSlot)
      const gatewayOn = !!(menuGW && menuGW.enabled)
      if (gatewayOn && repeatAllows(contact, cfg.repeatFrequency ?? menuGW?.repeatFrequency ?? 'daily', dbTimestamp)) {
        // v4.0.0b hotfix (QA Kanaka 09:15) — repeatFrequency kini milik AutoReplyConfig (D10);
        // NULL = tenant belum save via UI baru → fallback ke MG config (setting lama tetap hidup).
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
      // v3.9.5 — freq ikut config MG efektif slot (per-slot repeatFrequency)
      // v4.0.0b hotfix — D10: freq utama = AR config (kolom baru); MG = fallback back-compat
      const menuGW = await menuGatewayConfigSafe(tenantId, chat.numberSlot)
      const freq = cfg.repeatFrequency ?? (menuGW ? menuGW.repeatFrequency : null) ?? 'daily'
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

// ─── v3.9.4 — Sync saklar greeting SCOPED (dipakai routes/menuGateway.js) ───
/**
 * v3.9.4 — enableGreetForScope(tenantId, slots, userId):
 *   slots = null → link-all: HANYA shared row → greetEnabled=true, greetMode='menu'
 *   (row per-slot TIDAK disentuh — konfigurasi eksplisit slot lain dilindungi).
 *   slots = [0,1] → row per-slot tsb → menu; row belum ada → dibuat MINIMAL
 *   (default schema + greet fields) — BUKAN clone shared, supaya slot menu murni
 *   tidak ikut mewarisi rules teks tenant.
 */
async function enableGreetForScope(tenantId, slots, userId = null) {
  const tid = Number(tenantId)
  const data = { greetEnabled: true, greetMode: 'menu', updatedById: userId }
  if (slots == null) {
    const shared = await prisma.autoReplyConfig.findFirst({ where: { tenantId: tid, numberSlot: null }, select: { id: true } })
    if (shared) {
      await prisma.autoReplyConfig.update({ where: { id: shared.id }, data })
    } else {
      await prisma.autoReplyConfig.create({ data: { tenantId: tid, numberSlot: null, ...data } }).catch(async (e) => {
        if (e.code !== 'P2002') throw e
        const again = await prisma.autoReplyConfig.findFirst({ where: { tenantId: tid, numberSlot: null }, select: { id: true } })
        if (again) await prisma.autoReplyConfig.update({ where: { id: again.id }, data })
      })
    }
    invalidateConfig(tid)
    return
  }
  for (const s of slots) {
    const existing = await prisma.autoReplyConfig.findUnique({ where: { tenantId_numberSlot: { tenantId: tid, numberSlot: s } } })
    if (existing) {
      await prisma.autoReplyConfig.update({ where: { id: existing.id }, data })
      continue
    }
    // v3.9.4 — row MINIMAL untuk slot menu: jam operasional 24/7 (menu hanya jalan
    // "dalam jam kerja" — F2; row tanpa jam aktif = selalu outside = menu tak pernah
    // terkirim). Trigger teks OFF — slot murni menu.
    await prisma.autoReplyConfig.create({
      data: {
        tenantId: tid, numberSlot: s,
        greetEnabled: true, greetMode: 'menu', updatedById: userId,
        outsideHoursEnabled: false, outsideHoursText: '',
        monFriEnabled: true, monFriStart: '00:00', monFriEnd: '23:59',
        satEnabled: true, satStart: '00:00', satEnd: '23:59',
        sunEnabled: true, sunStart: '00:00', sunEnd: '23:59',
      },
    }).catch(async (e) => {
      if (e.code !== 'P2002') throw e
      await prisma.autoReplyConfig.update({ where: { tenantId_numberSlot: { tenantId: tid, numberSlot: s } }, data })
    })
  }
  invalidateConfig(tid)
}

/**
 * v3.9.4 — disableGreetForScope(tenantId, slots, userId): set greetMode='text'
 * pada row scope (shared bila link-all; row per-slot HANYA bila ada — tidak
 * create row baru supaya slot yang memang tanpa config tidak ikut hidup).
 */
async function disableGreetForScope(tenantId, slots, userId = null) {
  const tid = Number(tenantId)
  // v3.9.4 — greetEnabled ikut OFF: tanpa ini, slot bekas menu langsung menyapa
  // pakai greetText default (surprise message) — lebih aman mati total; admin
  // tinggal centang ulang greeting di halaman Auto Reply kalau mau teks.
  const data = { greetEnabled: false, greetMode: 'text', updatedById: userId }
  if (slots == null) {
    await prisma.autoReplyConfig.updateMany({ where: { tenantId: tid, numberSlot: null }, data })
  } else {
    for (const s of slots) {
      await prisma.autoReplyConfig.updateMany({ where: { tenantId: tid, numberSlot: s }, data })
    }
  }
  invalidateConfig(tid)
}

module.exports = {
  getConfig,
  getConfigForSlot, // v3.9.2 K1-A — dipakai menuGateway.startFlow (resolve per-slot)
  listSlotsWithConfig, // v3.9.4 — UI tick-box
  enableGreetForScope, // v3.9.4 — sync saklar scoped
  disableGreetForScope, // v3.9.4 — sync saklar scoped
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
  // v4.0.0 — CB-AI (export utk E2E/unit parity)
  cbaiReplyForMessage,
  reserveAiSlot,
  bumpAiCounter,
  revertAiCounter,
  cbaiBudgetProxy: (c) => require('./aiKnowledge').cbaiBudget(c),
  wibDateString,
  TIME_RE,
  MAX_TEXT_LEN,
}