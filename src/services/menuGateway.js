/**
 * v0.13.0 — Menu Gateway (Auto Reply Triage) service.
 *
 * Spec: wa-cs-hub-v0.13.0-menu-gateway-spec.md (D1–D12 locked).
 *
 * Aturan utama:
 * - Chat "awaiting" = limbo: TIDAK masuk queue/count/take/notif (invariant §4.1).
 * - TIDAK ada loop menu: max 1 intro per trigger; semua jalur berakhir "done".
 * - SEMUA transisi state pakai updateMany berkondisi menuState:"awaiting" (race-safe;
 *   count=0 = kalah race = skip) — pola claim greeting v0.7.0.
 * - Pesan auto: senderId=null, isAuto=true, TIDAK mengisi firstResponse (pola v0.7.0).
 * - Timeout efektif detik: unit=seconds ? v : v*60, clamp 10..3600.
 * - Tag menempel di kontak (ContactTag source="menu", idempoten) + mirror ChatTag (D4).
 * - Repeat frequency: per_chat / daily / weekly via Contact.lastMenuShownAt (D6).
 * - Outside-hours SELALU menang (D5) — diperiksa di autoReply.js sebelum delegasi startFlow.
 */

const prisma = require('../prisma')
const broadcast = require('../socket/broadcast')
const { encryptText, decryptTextSafe } = require('./textCrypto')
// v0.13.3 (F4) — repeatAllows SATU implementasi (di autoReply.js, marker BERSAMA
// Contact.lastMenuShownAt utk menu & teks); di sini hanya re-export.
const { wibDateString, personalizeText, stripUnknownPlaceholders, repeatAllows } = require('./autoReply')

// v3.9.25 — LLM classifier (lazy require di dalam classifyRoute utk hindari
// circular import — llm.js tidak require menuGateway, tapi jaga kebiasaan aman).
const AI_CLASSIFY_TIMEOUT_MS = 8000 // spec D6 — timeout LLM; gagal → fallback lama
const AI_CLASSIFY_MAX_HISTORY = 8 // spec D9 — max 8 pesan terakhir (teks; media → "[media]")
const AI_DESC_MAX_LEN = 200 // spec D8 — aiDescription per opsi ≤200 char
const AI_THRESHOLD_MIN = 0.5
const AI_THRESHOLD_MAX = 0.95

const SENDER_NAME = 'Auto Reply'
const SWEEP_INTERVAL_MS = 30 * 1000 // sweep timeout tiap 30 detik (spec §4)

// ─── Config cache PER-TENANT (in-memory, invalidate saat PUT — pola appConfig.js) ──
// v3.0 — Map tenantId → { config, options } (MenuGatewayConfig @@unique([tenantId])).
const configCache = new Map()

/**
 * Ambil config per tenant + options (seed idempotent via tenantSeed saat tenant
 * dibuat; di sini tetap create-catch-race utk tenant lama tanpa seed).
 * Hasil di-cache; menuGateway.invalidateConfig(tenantId) dipanggil route PUT.
 */
async function getConfig(tenantId) {
  const tid = Number(tenantId)
  if (!Number.isFinite(tid)) throw new Error('menuGateway.getConfig butuh tenantId')
  if (configCache.has(tid)) return configCache.get(tid)
  // v3.9 fix BUG-1 (+ compound-NULL): Prisma menolak compound key dgn NULL → findFirst
  let cfg = await prisma.menuGatewayConfig.findFirst({
    where: { tenantId: tid, numberSlot: null },
    include: { options: { orderBy: { position: 'asc' } } },
  })
  if (!cfg) {
    cfg = await prisma.menuGatewayConfig.create({
      data: { tenantId: tid, numberSlot: null },
      include: { options: { orderBy: { position: 'asc' } } },
    }).catch(async (e) => {
      if (e.code === 'P2002') {
        return prisma.menuGatewayConfig.findFirst({
          where: { tenantId: tid, numberSlot: null },
          include: { options: { orderBy: { position: 'asc' } } },
        })
      }
      throw e
    })
  }
  configCache.set(tid, cfg)
  return cfg
}

/**
 * v3.9 — resolve config untuk SLOT: baris dgn numberSlot = slot → menang;
 * tidak ada → fallback shared (null = link-all). Cache key "tenantId:slot".
 */
async function getConfigForSlot(tenantId, slot = 0) {
  const tid = Number(tenantId)
  const s = Number(slot) || 0
  const key = `${tid}:${s}`
  if (configCache.has(key)) return configCache.get(key)
  let cfg = await prisma.menuGatewayConfig.findFirst({
    where: { tenantId: tid, OR: [{ numberSlot: s }, { numberSlot: null }] },
    orderBy: [{ numberSlot: 'desc' }],
    include: { options: { orderBy: { position: 'asc' } } },
  })
  if (!cfg) cfg = await getConfig(tid)
  configCache.set(key, cfg)
  return cfg
}

function invalidateConfig(tenantId) {
  // v3.9 — cache key bisa tenantId ATAU "tenantId:slot" → clear semua (entry kecil)
  configCache.clear()
}

/**
 * Timeout efektif detik: unit=seconds ? v : v*60, clamp 10..3600 (invariant §4.6).
 */
function effectiveTimeoutSeconds(cfg) {
  const v = Math.max(1, parseInt(cfg.timeoutValue, 10) || 0)
  const eff = cfg.timeoutUnit === 'seconds' ? v : v * 60
  return Math.min(3600, Math.max(10, eff))
}

// ─── Tagging D4 — upsert ContactTag + mirror ChatTag ────────────────────
/**
 * Lekatkan tag ke KONTAK (persistent) + mirror ke chat (filter ChatTag existing tetap jalan).
 * Idempoten: ContactTag @@unique([contactId, tagId]) → upsert; ChatTag PK composite → create-catch.
 * TIDAK menghapus tag lama (additive saja).
 */
async function tagContactAndMirror(tenantId, contactId, tagId, chatId, addedById = null) {
  if (!tagId || !contactId) return
  try {
    // Cek tag masih ada (tag bisa sudah dihapus admin — jangan create row dangling)
    const tag = await prisma.tag.findFirst({ where: { id: tagId, tenantId } })
    if (!tag) return

    // Upsert ContactTag — idempoten via @@unique([contactId, tagId])
    await prisma.contactTag.upsert({
      where: { contactId_tagId: { contactId, tagId } },
      update: {}, // tidak menimpa source manual lama — additive saja
      create: { tenantId, contactId, tagId, source: 'menu', addedById },
    })

    // Mirror ChatTag (idempoten: composite PK → P2002 di-skip)
    if (chatId) {
      try {
        await prisma.chatTag.create({ data: { chatId, tagId } })
      } catch (e) {
        if (e.code !== 'P2002') throw e
      }
      broadcast.emitToTenant(tenantId, 'chat_update', { chatId, tagAdded: tag })
    }
  } catch (e) {
    console.error('[MenuGateway] tagContactAndMirror error:', e.message)
  }
}

// ─── Queue-kan chat (transisi "done" milik gateway) ─────────────────────
/**
 * Queue-kan chat milik gateway: queuedAt=now (FIFO key), status open, broadcast.
 * Pemanggil WAJIB sudah meng-claim transisi menuState awaiting→done via updateMany
 * (race-safe). Tidak mengisi firstResponse (invariant §4).
 */
async function queueChatAfterMenu(chat) {
  const chatId = chat.id
  const tenantId = chat.tenantId
  await prisma.chat.updateMany({
    where: { id: chatId, tenantId, assignedToId: null, status: 'open' },
    data: { queuedAt: new Date() },
  })
  broadcast.emitToTenant(tenantId, 'chat_update', { chatId, queuedAt: new Date(), menuState: 'done' })
  const queue = require('../socket/queue')
  queue.emitQueueUpdate(tenantId)
}

// ─── Compose intro pesan (v0.12.13) — introText + list otomatis dari Opsi Menu ──
/**
 * introText = kalimat pembuka SAJA (tanpa list — list di textarea lama di-IGNORE).
 * List bernomor di-generate dari opsi aktif → preview UI & pesan asli 1:1.
 * Kompatibel: introText lama yang masih mengandung list di-RE (regex buang baris
 * "N. ..." berurutan di akhir) supaya tidak dobel list.
 */
function composeMenuIntro(cfg) {
  let intro = String(cfg.introText || '').trim()
  // Strip list bernomor yang menempel di akhir intro (data lama v0.13.0)
  intro = intro.replace(/(?:\s*\d+\.\s*[^\n]+)+\s*$/, '').trim()
  const lines = cfg.options
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((o, i) => `${i + 1}. ${o.label || '…'}`)
  return lines.length ? `${intro}\n\n${lines.join('\n')}` : intro
}

// ─── Kirim pesan auto menu (pola autoReply v0.7.0) ──────────────────────
/**
 * Kirim teks via WA + simpan Message (senderId=null, isAuto=true, TIDAK isi firstResponse).
 * @returns {Promise<boolean>} true = terkirim & tersimpan
 */
async function sendAutoMessage(chat, text, contactName = null) {
  const chatId = chat.id
  const tenantId = chat.tenantId
  const finalText = personalizeText(text, contactName)
  try {
    // Lazy require pool per-tenant (v3 — sendMessage legacy global dihapus)
    // v3.9 — via nomor asal chat (numberSlot; null = slot-0 compat) — JANGAN fallback.
    const wa = require('../wa/pool')
    await wa.sendMessageForTenant(tenantId, chat.waJid, finalText, { slot: Number(chat.numberSlot) || 0 })
  } catch (sendErr) {
    console.error(`[MenuGateway] send gagal untuk chat=${chatId} (tenant ${tenantId}):`, sendErr.message)
    return false
  }
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
  broadcast.emitToTenant(tenantId, 'new_message', { chatId, assignedToId: null, status: 'open', message: { ...dbMsg, content: decryptTextSafe(dbMsg.content) } })
  broadcast.emitToTenant(tenantId, 'chat_update', { chatId, lastMessage: finalText, lastMessageAt: dbMsg.timestamp })

  // v0.12.9 — implied read (fire-and-forget; gate AppConfig di dalam service)
  try {
    const receipts = require('./receipts')
    receipts.markIncomingRead(tenantId, chatId).catch(re => console.error('[Receipts] menuGateway:', re.message))
  } catch { /* fire-and-forget */ }

  return true
}

// ─── Repeat frequency (D6/F4) — lihat autoReply.repeatAllows ─────────────
// v0.13.3: implementasi dipindah ke autoReply.js (marker BERSAMA menu & teks);
// fungsi di-import di atas dan di-re-export di module.exports bawah.

// ─── [B] startFlow — trigger intro (dipanggil autoReply first-of-day, greetMode=menu) ──
/**
 * Mulai flow menu pada chat. DIPANGGIL dari autoReply.maybeAutoReply saat
 * greetMode="menu" + gateway enabled + repeat mengizinkan (outside hours SUDAH
 * dievaluasi pemanggil — D5: outside-hours selalu menang, tanpa menu).
 *
 * Return true = handled (intro terkirim / sudah pernah diflow) → autoReply berhenti.
 * Return false = bukan jalanku (greetMode=text dsb.) → autoReply jalur lama.
 *
 * @param {object} chat - row Chat terbaru (dengan include contact bila tersedia)
 */
async function startFlow(chat) {
  const chatId = chat.id
  const tenantId = chat.tenantId
  try {
    // v3.9 — config resolved per SLOT asal chat (link-all null = fallback shared)
    const cfg = await getConfigForSlot(tenantId, chat.numberSlot)

    // Guard total: gateway OFF → bukan jalur menu (caller memutuskan jalur lama)
    if (!cfg.enabled) return false
    // greetMode menu-nya di-evaluasi caller; defense-in-depth: cek lagi di sini
    // v3.9.2 K1-A — resolve per SLOT asal chat (fallback shared null) — bukan selalu shared.
    const autoCfg = await require('./autoReply').getConfigForSlot(tenantId, chat.numberSlot)
    if (!autoCfg || !autoCfg.greetEnabled || autoCfg.greetMode !== 'menu') return false

    // Repeat frequency (D6/F4) — CEK SEBELUM claim (anti-orphan v0.13.3): repeat
    // blocked TIDAK boleh meninggalkan chat awaiting tanpa intro. Bila chat belum
    // queued (bawaan E0) → queue-kan dulu (chat lanjut alur biasa, tidak limbo).
    let contact = chat.contact || null
    if (!contact) {
      contact = await prisma.contact.findUnique({ where: { chatId } })
    }
    // v4.0.0b hotfix (QA Kanaka 09:15) — D10: freq utama = AR config (kolom baru);
    // fallback MG config (setting lama tetap hidup sampai disimpan via UI baru).
    if (!repeatAllows(contact, autoCfg.repeatFrequency ?? cfg.repeatFrequency)) {
      const { ensureChatQueued } = require('./autoReply')
      await ensureChatQueued(chatId)
      return false
    }

    // STATE GUARD (invariant §4.2 + §4.3): chat yang pernah diflow tidak dikirim
    // menu lagi; chat assigned/open-lain TIDAK pernah dapat menu. Claim atomik:
    // hanya chat menuState NULL + unassigned + open yang bisa di-claim (menutup
    // race take-next vs startFlow — kalah claim = tanpa menu, alur biasa).
    const claim = await prisma.chat.updateMany({
      where: { id: chatId, tenantId, menuState: null, assignedToId: null, status: 'open' },
      data: { menuState: 'awaiting', menuRequestedAt: new Date() },
    })
    if (claim.count === 0) {
      // Sudah pernah diflow (awaiting/done) ATAU kalah race (di-take CS/di-sweep)
      // → handled, jangan menu 2x; chat lanjut alurnya masing-masing.
      return true
    }

    // Kirim intro — v0.12.13: introText = kalimat pembuka SAJA (tanpa list);
    // list bernomor di-generate dari Opsi Menu (preview UI = pesan asli 1:1).
    const sent = await sendAutoMessage(chat, composeMenuIntro(cfg), chat.contactName)
    if (!sent) {
      // Send gagal → revert state (pelanggan bisa dapat menu di pesan berikutnya)
      await prisma.chat.updateMany({
        where: { id: chatId, tenantId, menuState: 'awaiting' },
        data: { menuState: null, menuRequestedAt: null },
      })
      // v0.13.3 — anti-orphan: bila chat belum queued (bawaan E0) → queue-kan agar
      // tidak hilang dari radar CS (spec F1 matrix (b)).
      const { ensureChatQueued } = require('./autoReply')
      await ensureChatQueued(chatId)
      return false
    }

    // Marker kontak (D6): setelah intro TERKIRIM
    if (contact) {
      await prisma.contact.updateMany({
        where: { id: contact.id, tenantId },
        data: { lastMenuShownAt: new Date() },
      })
    }

    // v0.13.3 — broadcast chat_update wajib bawa queuedAt:null + menuState:'awaiting'
    // agar UI admin sinkron (spec F1 catatan implementasi).
    broadcast.emitToTenant(tenantId, 'chat_update', { chatId, queuedAt: null, menuState: 'awaiting' })
    broadcast.emitToTenant(tenantId, 'menu_waiting_update', { count: await countWaiting(tenantId) })
    console.log(`[MenuGateway] intro terkirim → awaiting: chat=${chatId} (tenant ${tenantId})`)
    return true
  } catch (e) {
    console.error('[MenuGateway] startFlow error:', e)
    // Safety: jangan biarkan chat terjebak awaiting tanpa intro
    await prisma.chat.updateMany({
      where: { id: chatId, tenantId, menuState: 'awaiting', menuRequestedAt: null },
      data: { menuState: null },
    }).catch(() => {})
    // v0.13.3 — anti-orphan: jangan biarkan chat hilang dari radar CS
    const { ensureChatQueued } = require('./autoReply')
    await ensureChatQueued(chatId).catch(() => {})
    return false
  }
}

// ─── §5 — Pencocokan jawaban (deterministik, tanpa AI) ──────────────────
/**
 * Normalisasi input: trim, lowercase, buang prefix .,):\- pada token pertama.
 * Return token pertama + full string ternormalisasi.
 */
function normalizeAnswer(raw) {
  const trimmed = String(raw || '').trim().toLowerCase()
  if (!trimmed) return { first: '', full: '' }
  const tokens = trimmed.split(/\s+/)
  const first = tokens[0].replace(/^[.,):\\\-]+/, '')
  return { first, full: trimmed }
}

/**
 * Tentukan opsi dari jawaban pelanggan (§5):
 * 1. Exact number: token pertama /^(\d+)$/ → 1..N (posisi) → opsi tsb; 0/>N → null (fallback D2).
 * 2. Alias: token pertama (atau input penuh) == alias opsi (case-insensitive) → opsi; tie → position terkecil.
 * 3. Gagal keduanya → null → fallback.
 */
function matchOption(text, options) {
  const { first, full } = normalizeAnswer(text)
  if (!first) return null

  // 1. Exact number (posisi opsi 1..N)
  const numMatch = first.match(/^(\d+)$/)
  if (numMatch) {
    const num = parseInt(numMatch[1], 10)
    if (num >= 1 && num <= options.length) {
      const opt = options.find(o => o.position === num)
      if (opt) return opt
    }
    return null // 0 atau >N → fallback (D2)
  }

  // 2. Alias: cek token pertama, lalu input penuh — tie → position terkecil
  const candidates = [first, full].filter(Boolean)
  for (const cand of candidates) {
    const hit = options
      .filter(o => String(o.aliases || '')
        .split(',')
        .map(a => a.trim().toLowerCase())
        .filter(Boolean)
        .includes(cand))
      .sort((a, b) => a.position - b.position)
    if (hit.length > 0) return hit[0]
  }
  return null
}

// ─── [A] handleChoice — jawaban pelanggan saat awaiting ─────────────────
/**
 * Evaluasi jawaban pelanggan terhadap config TERBARU (cache invalidated on save).
 * Hasil SELALU transisi "done" (tidak pernah re-prompt, D2):
 *   cocok → reply opsi → tag → queue
 *   tak cocok → fallbackText → tag "Lainnya" (bila diset) → queue
 * Race-safe: transisi awaiting→done pakai updateMany kondisional; count=0 = kalah
 * race (sudah di-sweep/direlease) → pesan jadi pesan biasa, SKIP.
 *
 * @param {string} chatId
 * @param {string} plaintextText - plaintext dari variabel `text` lokal baileys
 *   (JANGAN dekrip dari DB — Message.content tersimpan ciphertext AES)
 * @returns {Promise<boolean>} true = chat adalah milik gateway & transisi terjadi
 */
async function handleChoice(chatId, plaintextText) {
  return handleChoiceWithText(chatId, plaintextText, null)
}

/**
 * v4.0.0 — handleChoiceWithText: varian handleChoice yang meneruskan plaintext
 * customer ke executeGatewayChoice (§7b CB-AI QA butuh PERTANYAAN asli).
 * plaintextText non-null → dipakai utk prompt KB; null → jalur v3.9.25 (classifier
 * saja, opsi text — PERSIS perilaku lama).
 */
async function handleChoiceWithText(chatId, plaintextText, customerTextForKb = null) {
  try {
    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      include: { contact: true },
    })
    if (!chat || chat.menuState !== 'awaiting') return false // bukan limbo → bukan jalur gateway

    const tenantId = chat.tenantId
    // v3.9 — config resolved per SLOT asal chat (link-all null = fallback shared)
    const cfg = await getConfigForSlot(tenantId, chat.numberSlot)

    // ATOMIC CLAIM transisi awaiting→done (race-safe vs sweep/release/pesan kedua).
    // Semua jalur di bawah berakhir "done" — claim lebih dulu = jaminan 1 transisi.
    const claimed = await prisma.chat.updateMany({
      where: { id: chatId, tenantId, menuState: 'awaiting' },
      data: {
        menuState: 'done',
        menuOptionId: null, // di-set ulang bila cocok, di bawah
      },
    })
    if (claimed.count === 0) return false // kalah race (timeout/release lebih dulu) → skip

    const opt = matchOption(plaintextText, cfg.options)
    let aiOpt = null // v3.9.25 — opsi terpilih via AI classifier (null = fallback lama)

    if (opt) {
      await executeGatewayChoice(chat, cfg, opt, 'keyword', customerTextForKb)
    } else {
      // ═══ v3.9.25 — AI Hybrid Routing (D1–D6): LLM classifier fallback ═══
      // HANYA saat: toggle ON + plan featAiRouting ✓ + AiConfig ada key. LLM dipanggil
      // SEBELUM fallbackText supaya pilihan AI dieksekusi SAMA dgn pilihan normal.
      // Kegagalan apapun (NO_CONFIG/timeout/error/confidence kurang/parse gagal) →
      // path lama persis: fallbackText + fallbackTagId + antrean (D6 graceful).
      try {
        aiOpt = cfg.aiHybrid ? await classifyAiRoute(tenantId, chat, cfg, plaintextText) : null
      } catch (aiErr) {
        console.error('[MenuGateway] AI classify error (non-fatal, fallback lama):', aiErr.message)
      }
      if (aiOpt) {
        await executeGatewayChoice(chat, cfg, aiOpt, 'ai', customerTextForKb)
      } else {
        // ── Fallback (D2): TIDAK ada loop menu → tag "Lainnya" + queue ──
        const sent = await sendAutoMessage(chat, cfg.fallbackText, chat.contactName)
        if (!sent) console.error(`[MenuGateway] fallbackText gagal terkirim (chat=${chatId}) — tag & queue tetap jalan`)
        if (cfg.fallbackTagId && chat.contact) {
          await tagContactAndMirror(tenantId, chat.contact.id, cfg.fallbackTagId, chatId, null)
        }
      }
    }

    // Queue-kan (FIFO key baru) + broadcast
    await queueChatAfterMenu(chat)
    broadcast.emitToTenant(tenantId, 'menu_waiting_update', { count: await countWaiting(tenantId) })
    console.log(`[MenuGateway] ${opt ? `opsi ${opt.position} (${opt.label})` : (aiOpt ? `opsi ${aiOpt.position} (${aiOpt.label}) via AI` : 'fallback')} → done & queued: chat=${chatId} (tenant ${tenantId})`)
    return true
  } catch (e) {
    console.error('[MenuGateway] handleChoice error:', e)
    return false
  }
}

/**
 * v3.9.25 — Eksekusi pilihan (D1/D2: SATU kode utk pilihan keyword ATAU AI).
 * Pindahan persis dari blok "Pilihan valid (D10)" lama di handleChoice — logic
 * TIDAK diubah: set menuOptionId → ChatEvent menu_choice → sendAutoMessage(replyText)
 * → tagContactAndMirror. LLM TIDAK PERNAH menyusun pesan ke customer (D2).
 *
 * v4.0.0 — §7b CB-AI per-opsi (D9 all-in-one): opsi answerMode='ai_knowledge' + plan
 * featAiKnowledge ✓ + AiConfig hasKey → QA scoped buildKnowledgeBlock(opt.aiDocIds ||
 * null) → covered → kirim JAWABAN AI (counter++ shared CB-AI, metering source='knowledge');
 * !covered / LLM gagal / plan ✗ / 0 doc aktif → kirim option.replyText PERSIS (fallback
 * deterministic, DIHITUNG). Mechanics menuState/timeout/tag TIDAK berubah — AI answer
 * mengganti ISI pesan opsi, bukan alurnya. Classifier (viaLabel='ai') TIDAK kehitung.
 */
const CBAI_REPLY_FALLBACK_LIMIT = 600 // jawaban AI ≤600 char + footer (mirror ANSWER_MAX_CHARS)
async function executeGatewayChoice(chat, cfg, opt, viaLabel, customerTextForKb = null) {
  const chatId = chat.id
  const tenantId = chat.tenantId
  if (chat.menuOptionId !== opt.id) {
    await prisma.chat.updateMany({
      where: { id: chatId, tenantId, menuState: 'done' },
      data: { menuOptionId: opt.id },
    })
  }
  // Spec §14 rekomendasi: catat ChatEvent menu_choice (analytics menyusul)
  await prisma.chatEvent.create({
    data: { tenantId, chatId, userId: null, type: 'menu_choice', createdAt: new Date() },
  }).catch(e => console.error('[MenuGateway] chatEvent error (non-fatal):', e.message))

  // ═══ v4.0.0 — §7b: answerMode='ai_knowledge' → QA KB scoped ═══
  let sent = false
  let aiAnswered = false
  let textToSend = opt.replyText || cfg.fallbackText
  let reserved = { ok: false, prev: null } // fix audit MEDIUM-1 — reserve ATOMIK sebelum LLM
  if (opt.answerMode === 'ai_knowledge') {
    let planOk = false
    try {
      const plans = require('./plans')
      const plan = await plans.getPlan(tenantId)
      planOk = !!(plan && plan.featAiKnowledge === true)
    } catch {}
    if (planOk) {
      try {
        const aiKb = require('./aiKnowledge') // lazy — hindari circular require
        const autoCfg = await require('./autoReply').getConfigForSlot(tenantId, chat.numberSlot)
        const cfgAi = await prisma.aiConfig.findUnique({ where: { id: 1 }, select: { apiKeyEnc: true } })
        const aiCfgOk = !!(cfgAi && cfgAi.apiKeyEnc)
        const fresh = await prisma.chat.findUnique({ where: { id: chatId } })
        if (fresh && aiCfgOk) {
          const docIds = String(opt.aiDocIds || '').split(',').map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite)
          // Fix audit MEDIUM-2: keyword fast-path → pertanyaan QA = label + aliases
          // (bukan digit/keyword mentah "1" — semantik: customer menanyakan topik ini).
          // Classifier (viaLabel='ai') → plaintext customer asli (pertanyaan bebas).
          const qaText = viaLabel === 'keyword'
            ? [opt.label, String(opt.aliases || '').trim()].filter(Boolean).join(' — ')
            : (customerTextForKb || '')
          const limit = Math.min(aiKb.CBAI_LIMIT_MAX, Math.max(aiKb.CBAI_LIMIT_MIN, Number(autoCfg?.cbaiLimit) || 3))
          const { reserveAiSlot } = require('./autoReply')
          reserved = await reserveAiSlot(chat, limit) // race-safe (fix MEDIUM-1)
          if (reserved.ok) {
            const r = await aiKb.answerFromKnowledge({
              tenantId,
              chat: fresh,
              customerText: qaText,
              mode: 'ai_knowledge',
              docIds: docIds.length ? docIds : null, // kosong = whole KB
              cbaiInfoFooter: autoCfg?.cbaiInfoFooter !== false,
              personaCfg: autoCfg, // v4.1.1 — persona (D2/D3); kosong = prompt persis v4.1.0
            })
            if (r.ok && r.covered && r.answer) {
              // v4.1.2 D3 — disclaimer append oleh KODE SEBELUM textToSend (jalur LLM
              // ai_knowledge; classifier/keyword fast-path TIDAK lewat sini).
              textToSend = aiKb.appendDisclaimer(r.answer, autoCfg).slice(0, CBAI_REPLY_FALLBACK_LIMIT)
              aiAnswered = true
            }
          }
        }
      } catch (aiErr) {
        console.error('[MenuGateway] CB-AI option error (non-fatal → replyText fallback):', aiErr.message)
        reserved = { ok: false, prev: null } // aman: tak ada reserve yang bocor
      }
    }
  }

  sent = await sendAutoMessage(chat, textToSend, chat.contactName)
  if (!sent) console.error(`[MenuGateway] reply opsi gagal terkirim (chat=${chatId}) — tag & queue tetap jalan`)

  // v4.0.0 — counter shared CB-AI: HANYA jawaban generate yang kehitung (D5);
  // classifier (viaLabel='ai') TIDAK kehitung; fallback replyText DIHITUNG.
  // Fix audit MEDIUM-1: reserve ATOMIK sudah jalan sebelum LLM — bila terkirim,
  // slot sudah dibayar (tanpa bump lagi); bila GAGAL kirim → reserve di-revert.
  if (opt.answerMode === 'ai_knowledge') {
    try {
      const { revertAiCounter } = require('./autoReply')
      if (sent && reserved.ok) {
        // counter sudah direserve — snapshot marker window terbaru (marker ditulis di reserve)
      } else if (!sent && reserved.ok) {
        await revertAiCounter(chat, reserved.prev) // tidak ada pesan → slot dikembalikan
      } else if (!reserved.ok) {
        // fallback replyText TANPA reserve (limit habis) → TIDAK dihitung (nol LLM call — spec Q2)
      }
    } catch (e) {
      console.error('[MenuGateway] revertAiCounter error (non-fatal):', e.message)
    }
  }

  // Tag kontak (persistent) + mirror chat — bila opsi punya tag
  if (opt.tagId && chat.contact) {
    await tagContactAndMirror(tenantId, chat.contact.id, opt.tagId, chatId, null)
  }
  if (viaLabel === 'ai') {
    console.log(`[MenuGateway] opsi ${opt.position} (${opt.label}) dipilih via AI classifier (chat=${chatId})`)
  } else if (aiAnswered) {
    console.log(`[MenuGateway] opsi ${opt.position} (${opt.label}) dijawab CB-AI dari KB (chat=${chatId})`)
  }
}

// ─── v3.9.25 — AI Hybrid Routing: classifier murni (D2/D4/D6) ─────────────
/**
 * Parse ketat output LLM (D4): JSON {position:int, confidence:0..1}.
 * Invalid/out-of-range/parse-fail → null (perlakukan SAMA dgn no-match → fallback).
 * Strip code fence bila ada (provider kadang bungkus JSON); HANYA objek pertama
 * {..} yang dianggap — sisanya diabaikan (anti-injection kecil).
 */
function parseAiRouteJson(rawContent) {
  const raw = String(rawContent || '').trim()
  if (!raw) return null
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) return null
  let parsed
  try {
    parsed = JSON.parse(m[0])
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const position = parsed.position
  const confidence = parsed.confidence
  if (!Number.isInteger(position) || position < 0) return null
  const conf = Number(confidence)
  if (!Number.isFinite(conf) || conf < 0 || conf > 1) return null
  return { position, confidence: conf }
}

/**
 * classifAiRoute → opsi terpilih (row MenuGatewayOption) ATAU null.
 * - null = jatuh ke fallback lama (no-match/parse-fail/out-of-range/error/below-threshold).
 * - LLM dipanggil via aiChat source:'gateway' (metering AiUsageLog — D7).
 * - Graceful degradation (D6): SEMUA kegagalan di-catch di sini / pemanggil — tidak crash.
 */
async function classifyAiRoute(tenantId, chat, cfg, customerText) {
  const llm = require('./llm')
  const plans = require('./plans')

  // Guard 2 lapis pemanggil (defense-in-depth; handleChoice sudah cek toggle):
  if (!cfg.aiHybrid) return null
  const plan = await plans.getPlan(tenantId)
  if (!plan || !plan.featAiRouting) return null // plan ✗ → tanpa AI (juga plan belum ada)

  const aiCfg = await llm.getAiConfig()
  if (!aiCfg || !aiCfg.hasKey) return null // NO_CONFIG → fallback lama (0 cost, tanpa row)

  const options = Array.isArray(cfg.options) ? cfg.options : []
  if (options.length === 0) return null

  // ── Bangun prompt (spec §8): opsi bernomor + konteks ──
  const lines = options.map((o) => {
    const desc = String(o.aiDescription || '').trim()
    const context = desc || [String(o.label || '').trim(), String(o.aliases || '').trim()].filter(Boolean).join(' — ')
    return `${o.position}. ${o.label || '…'} — ${context}`
  })
  const system = [
    'Kamu classifier routing menu WA. Pilih nomor opsi yang paling cocok dengan pesan customer.',
    'Balas HANYA JSON: {"position": <int>, "confidence": <0..1>}.',
    'Tidak ada yang cocok → {"position": 0, "confidence": 0}.',
    'Daftar opsi:',
    ...lines,
  ].join('\n')

  // ── Konteks chat minimal (D9): max 8 pesan terakhir, teks saja; media → [media] ──
  const msgs = await prisma.message.findMany({
    where: { tenantId, chatId: chat.id, purged: false },
    select: { direction: true, content: true, mediaPath: true, timestamp: true },
    orderBy: { id: 'desc' },
    take: AI_CLASSIFY_MAX_HISTORY,
  })
  const history = msgs
    .reverse()
    .map((m) => {
      const who = m.direction === 'out' ? 'CS' : 'Customer'
      // content terenkripsi at-rest; plaintext dari socket ada di customerText.
      // Di sini aman: decryptTextSafe; plaintext pesan TERAKHIR = customerText (parameter).
      let text = m.mediaPath ? '[media]' : decryptTextSafe(m.content)
      text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300)
      return `${who}: ${text || '[media]'}`
    })
  const lastText = String(customerText || '').replace(/\s+/g, ' ').trim().slice(0, 300)
  const userContent = [history.join('\n'), `Pesan terakhir: "${lastText}"`].filter(Boolean).join('\n')

  const r = await llm.aiChat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userContent },
    ],
    timeoutMs: AI_CLASSIFY_TIMEOUT_MS,
    fallback: true,
    source: 'gateway', // D7 — metering AiUsageLog (whitelist logAiUsage)
    tenantId,
    chatId: chat.id,
  })
  if (!r.ok) return null // ok=false → row AiUsageLog ok=false tercatat (D6/D7) → fallback

  const parsed = parseAiRouteJson(r.content)
  if (!parsed) return null // parse gagal (D4) → fallback lama
  const { position, confidence } = parsed
  const opt = options.find(o => o.position === position)
  if (!opt || position < 1 || position > options.length) return null // out-of-range (D4)
  const threshold = Number(cfg.aiThreshold)
  const effThreshold = Number.isFinite(threshold) ? Math.min(AI_THRESHOLD_MAX, Math.max(AI_THRESHOLD_MIN, threshold)) : 0.7
  if (confidence < effThreshold) return null // D3 — di bawah gate → fallback perilaku lama
  return opt
}

// ─── Chip admin: hitung chat awaiting (per tenant) ──────────────────────
async function countWaiting(tenantId) {
  return prisma.chat.count({ where: { tenantId, menuState: 'awaiting' } })
}

async function listWaiting(tenantId) {
  const chats = await prisma.chat.findMany({
    where: { tenantId, menuState: 'awaiting' },
    select: { id: true, contactName: true, contactPhone: true, numberSlot: true, menuRequestedAt: true },
    orderBy: { menuRequestedAt: 'asc' },
    take: 200,
  })
  // v3.9.8 — timeout efektif per-slot (angka "34 menit naik" = ELAPSED menunggu,
  // bukan countdown; UI kini dapat remainingSeconds agar jelas sisa waktunya).
  const slots = [...new Set(chats.map(c => Number(c.numberSlot) || 0))]
  const timeoutBySlot = {}
  for (const s of slots) {
    const cfg = await getConfigForSlot(tenantId, s)
    timeoutBySlot[s] = cfg && cfg.enabled ? effectiveTimeoutSeconds(cfg) : null
  }
  const now = Date.now()
  return chats.map(c => {
    const slot = Number(c.numberSlot) || 0
    const waitedSeconds = c.menuRequestedAt ? Math.max(0, Math.floor((now - new Date(c.menuRequestedAt).getTime()) / 1000)) : 0
    const ts = timeoutBySlot[slot] ?? null
    return {
      id: c.id,
      contactName: c.contactName,
      phone: c.contactPhone,
      waitedSeconds,
      remainingSeconds: ts !== null ? Math.max(0, ts - waitedSeconds) : null,
    }
  })
}

// ─── Release semua awaiting → queue TANPA tag (idempoten) ───────────────
/**
 * Dipanggil: (1) sweep timeout, (2) admin PUT enabled=false (D12).
 * Transisi SELALU updateMany berkondisi menuState:"awaiting" (race-safe, idempoten).
 * Timeout → queue TANPA tag (D11).
 * v3.9.4 — slot opsional: null = semua slot (compat); 0..2 = HANYA chat dari slot
 * itu (independensi hybrid QA #6 — release slot A tidak boleh nyenggol awaiting
 * milik slot B yang menunya masih aktif). return { released, ids }
 */
async function releaseAwaiting(tenantId, timeoutOnly = false, timeoutSeconds = null, slot = null) {
  const where = { tenantId, menuState: 'awaiting' }
  if (slot !== null && slot !== undefined) where.numberSlot = Number(slot) || 0
  if (timeoutOnly && timeoutSeconds) {
    where.menuRequestedAt = { lt: new Date(Date.now() - timeoutSeconds * 1000) }
  }

  // v3.9.9 — jalur TIMEOUT: klaim ATOMIK per-chat (pola updateMany berkondisi
  // menuState:'awaiting', sama dgn handleChoice). Chat yang kejawab pelanggan
  // tepat sebelum klaim TIDAK ikut ke-release & TIDAK dapat fallbackText; chat
  // yang kita klaim dijamin dapat fallback. Ids eksak → broadcast persis.
  let claimed = []
  if (timeoutOnly) {
    const candidates = await prisma.chat.findMany({
      where,
      select: { id: true, tenantId: true, waJid: true, numberSlot: true, contactName: true, contact: { select: { name: true } } },
      orderBy: { menuRequestedAt: 'asc' },
      // v3.9.9b (audit M1b) — take 100/tick: mass-timeout dilepas bertahap;
      // sisa ke-release tick berikutnya (fallback tetap terkirim per-batch).
      take: 100,
    })
    for (const c of candidates) {
      const r = await prisma.chat.updateMany({
        where: { id: c.id, tenantId, menuState: 'awaiting' },
        data: { menuState: 'done', queuedAt: new Date() },
      })
      if (r.count === 1) claimed.push(c)
    }
    if (!claimed.length) return { released: 0, ids: [] }
  } else {
    // Jalur manual (PUT enabled=false): bulk seperti semula (idempoten, race-safe).
    const result = await prisma.chat.updateMany({
      where,
      data: { menuState: 'done', queuedAt: new Date() },
    })
    if (result.count === 0) return { released: 0, ids: [] }
    const released = await prisma.chat.findMany({
      where: { tenantId, menuState: 'done', menuOptionId: null, menuRequestedAt: { not: null } },
      select: { id: true },
      orderBy: { menuRequestedAt: 'desc' },
      take: result.count,
    })
    claimed = released.map(c => ({ id: c.id }))
  }

  const ids = claimed.map(c => c.id)
  for (const id of ids) {
    broadcast.emitToTenant(tenantId, 'chat_update', { chatId: id, queuedAt: new Date(), menuState: 'done' })
  }
  const queue = require('../socket/queue')
  queue.emitQueueUpdate(tenantId)
  broadcast.emitToTenant(tenantId, 'menu_waiting_update', { count: await countWaiting(tenantId) })
  // v3.9.9b (audit M1c) — UI sinkron DULU: broadcast sebelum loop kirim fallback;
  // mass-timeout tidak menunda realtime antrean menunggu serial-send Baileys.
  // v3.9.9 — fallbackText terkirim ke chat yang ke-release karena TIMEOUT:
  // pelanggan yang tak bales menu tetap dapat kabar sebelum CS mengambil alih
  // (dulu silent release → kelihatannya diabaikan — lapor Kanaka 12:00).
  // Jalur release manual (PUT enabled=false) TIDAK mengirim: admin sadar
  // mematikan gateway; blast pesan ke semua awaiting justru membingungkan (D11).
  let sentFallback = 0
  if (timeoutOnly) {
    const cfg = slot !== null && slot !== undefined ? await getConfigForSlot(tenantId, slot) : await getConfig(tenantId)
    const fb = cfg && cfg.enabled ? String(cfg.fallbackText || '').trim() : ''
    // v3.9.9b (audit L1, didokumentasikan): admin disable di antara klaim & fetch
    // config → enabled=false → fb kosong → skip kirim; chat tetap ke-release (D11/D12).
    if (fb) {
      for (const chat of claimed) {
        try {
          const ok = await sendAutoMessage(chat, fb, chat.contact?.name || chat.contactName || null)
          if (ok) sentFallback++
        } catch (sendErr) {
          console.error(`[MenuGateway] fallbackText timeout gagal (chat=${chat.id}, tenant ${tenantId}):`, sendErr.message)
        }
      }
    }
  }

  console.log(`[MenuGateway] releaseAwaiting(${timeoutOnly ? 'timeout' : 'disabled'}, tenant ${tenantId}): ${ids.length} chat → queue tanpa tag${sentFallback ? `, fallbackText terkirim ke ${sentFallback}` : ''}`)
  return { released: ids.length, ids, sentFallback }
}

// ─── Sweep timeout PER-TENANT PER-SLOT (interval 30 dtk, mulai post-WA-connect) ──
let sweepTimer = null
let sweeping = false

async function sweepOnce() {
  // v3.9.9b (audit M1a) — anti-overlap: tick baru SKIP bila tick lama masih
  // jalan (loop kirim fallback serial bisa memanjang saat mass-timeout).
  if (sweeping) return
  sweeping = true
  try {
    // v3.9.4 — per-tenant PER-SLOT: efektif config tiap slot di-resolve (row
    // slot-spesifik menang, fallback shared link-all), lalu release awaiting
    // milik slot itu saja — timeout slot A gak ikut melepas chat slot B.
    const tenants = await prisma.menuGatewayConfig.findMany({
      where: { enabled: true },
      select: { tenantId: true },
      distinct: ['tenantId'],
    })
    for (const { tenantId } of tenants) {
      for (let slot = 0; slot <= 2; slot++) {
        const cfg = await getConfigForSlot(tenantId, slot)
        if (!cfg || !cfg.enabled) continue
        const eff = effectiveTimeoutSeconds(cfg)
        await releaseAwaiting(tenantId, true, eff, slot)
      }
    }
  } catch (e) {
    console.error('[MenuGateway] sweep error:', e.message)
  } finally {
    sweeping = false
  }
}

/**
 * Boot sweep — dipanggil server.js SAAT BOOT sejak v3.9.8 (idempoten).
 * Sebelumnya: rencana "post-WA-connect" tapi gak pernah ada caller → sweep mati.
 * Chat awaiting + server restart → state di DB, sweep lanjut; intro TIDAK dikirim ulang.
 */
function initMenuGatewaySweep() {
  if (sweepTimer) return
  sweepTimer = setInterval(sweepOnce, SWEEP_INTERVAL_MS)
  console.log(`[MenuGateway] Sweep timeout started (interval ${SWEEP_INTERVAL_MS / 1000}s)`)
}

function stopMenuGatewaySweep() {
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
}

module.exports = {
  getConfig,
  getConfigForSlot,
  invalidateConfig,
  effectiveTimeoutSeconds,
  repeatAllows,
  normalizeAnswer,
  matchOption,
  tagContactAndMirror,
  composeMenuIntro,
  startFlow,
  handleChoice,
  // v3.9.25 — AI Hybrid Routing (export utk E2E/unit parity): classifier + parse ketat
  classifyAiRoute,
  parseAiRouteJson,
  executeGatewayChoice,
  handleChoiceWithText, // v4.0.0 — §7b: meneruskan plaintext customer ke QA KB
  AI_CLASSIFY_TIMEOUT_MS,
  AI_CLASSIFY_MAX_HISTORY,
  AI_DESC_MAX_LEN,
  AI_THRESHOLD_MIN,
  AI_THRESHOLD_MAX,
  releaseAwaiting,
  countWaiting,
  listWaiting,
  sweepOnce,
  initMenuGatewaySweep,
  stopMenuGatewaySweep,
  personalizeText,
  stripUnknownPlaceholders,
  SWEEP_INTERVAL_MS,
  SENDER_NAME,
}
