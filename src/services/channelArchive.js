// ═══════════════════════════════════════════════════════════════════════
// v4.1.0 — Channels (WA Channel archive, read-only) — service layer (spec §2).
// Spec: docs/spec-v4.1.0-channels.md — GO Kanaka 12:44.
//
// Prinsip (D3 read-only total):
//  - Channel = one-way broadcast (JID `@newsletter`) — BUKAN percakapan customer.
//  - TANPA Chat row / Message / queue / unread / assignment / CSAT / auto-reply /
//    menuState / metering AI. Pesan postingan TIDAK masuk inbox CS.
//  - KONTRAK WAJIB: archiveNewsletterMessage TIDAK PERNAH throw ke runtime WA —
//    semua error di-catch + log (fail-closed); return null-ish supaya caller
//    `messages.upsert` langsung continue (tidak create chat — kontrak v4.0.0c).
//
// D1 auto-capture: postingan pertama dari JID @newsletter (per tenant+slot) →
//   auto-register archive + arsip postingan (tanpa registrasi manual).
// D2 nama best-effort: sock.newsletterMetadata('jid', jid) → propName (argumen
//   opsional dari caller/pool) → JID prefix. Gagal = tetap arsip (nama menyusul).
// D6 media: text tersimpan; media (image/video/doc) → simpan via pipeline media
//   existing (saveMedia terenkripsi) bila mudah — kalau rumah → metadata + flag
//   mediaOnly (content kosong + mediaType). Tidak scope-creep.
// D7: TANPA send capability (Baileys 7.0.0-rc14 gak punya method resmi; parked).
// D8: tanpa plan gate (archive-only, 0 cost LLM) — semua tenant aktif otomatis.
// ═══════════════════════════════════════════════════════════════════════

const prisma = require('../prisma')

// Cap teks postingan (proteksi DB; postingan channel bisa panjang)
const POST_TEXT_CAP = 20000

function log(tid, ...a) {
  console.log(`[ChannelArchive][t${tid}]`, ...a)
}
function logErr(tid, ...a) {
  console.error(`[ChannelArchive][t${tid}]`, ...a)
}

/** JID @newsletter? (guard utama + defense-in-depth caller) */
function isNewsletterJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@newsletter')
}

/**
 * Nama best-effort (D2): propName → JID prefix.
 * newsletterMetadata DIPANGGIL di sini (try/catch log-only) — hanya bila socket
 * tersedia; gagal = fallback JID prefix, arsip TETAP jalan.
 */
async function bestEffortName(sock, waJid, propName) {
  const fallback = String(waJid || '').split('@')[0] // JID prefix
  if (propName && String(propName).trim()) return String(propName).trim()
  if (!sock || sock.fake || typeof sock.newsletterMetadata !== 'function') return fallback
  try {
    const meta = await sock.newsletterMetadata('jid', waJid)
    const nm = meta?.name || meta?.thread_metadata?.name
    return nm && String(nm).trim() ? String(nm).trim() : fallback
  } catch (e) {
    return fallback // gagal metadata = JID prefix (nama menyusul bila ada event berikutnya)
  }
}

/**
 * archiveNewsletterMessage(tenantId, slot, msg, opts) → { archive, post } | null
 * Dipanggil dari pool.js jalur `@newsletter` (GANTI plain-skip v4.0.0c).
 *  1. resolve/create ChannelArchive by (tenantId, slot, waJid) — nama best-effort D2
 *  2. dedupe by (archiveId, serverId) — upsert-skip bila sudah ada (idempoten)
 *  3. simpan post (content/media per D6) — TANPA menyentuh Chat/queue/counter apapun
 *  4. SELALU return null-ish → caller `messages.upsert` continue (tidak create chat)
 * TIDAK BOLEH throw ke runtime path — try/catch log-only (fail-closed).
 */
async function archiveNewsletterMessage(tenantId, slot, msg, opts = {}) {
  const tid = Number(tenantId)
  try {
    const waJid = msg?.key?.remoteJid
    if (!Number.isFinite(tid) || tid <= 0 || !isNewsletterJid(waJid)) return null
    const numberSlot = Number(slot) || 0

    // Nama best-effort D2 (newsletterMetadata → propName → JID prefix)
    const name = await bestEffortName(opts.sock || null, waJid, opts.propName)

    // 1) resolve/create archive by (tenantId, slot, waJid) — race-safe:
    //    upsert dulu; P2002 (duel paralel) → find ulang (row sudah dibuat pemenang)
    let archive
    try {
      archive = await prisma.channelArchive.upsert({
        where: { tenantId_numberSlot_waJid: { tenantId: tid, numberSlot, waJid } },
        create: { tenantId: tid, numberSlot, waJid, name },
        update: {}, // nama TIDAK ditimpa di post berikutnya (best-effort sekali saat lahir)
      })
    } catch (e) {
      if (e?.code === 'P2002') {
        archive = await prisma.channelArchive.findUnique({
          where: { tenantId_numberSlot_waJid: { tenantId: tid, numberSlot, waJid } },
        })
      } else throw e
    }
    if (!archive) return null

    // 2+3) dedupe by (archiveId, serverId) → simpan post (D6)
    const serverId = msg?.key?.id ? String(msg.key.id) : null
    const mediaType = detectMediaType(msg)
    let content = extractText(msg) || ''
    let mediaPath = null
    let mediaMime = null
    if (mediaType) {
      const mediaMsg = msg.message[`${mediaType}Message`]
      mediaMime = mediaMsg?.mimetype || null
      if (mediaMsg?.caption) content = mediaMsg.caption
      else if (mediaType === 'document' && mediaMsg?.fileName) content = mediaMsg.fileName
      // D6 — simpan media via pipeline existing (saveMedia terenkripsi) BILA mudah:
      // butuh buffer via downloadMediaMessage (butuh sock nyata). Gagal = metadata
      // doang + mediaPath null (flag mediaOnly implisit: mediaType set + mediaPath null).
      const sock = opts.sock || null
      if (sock && !sock.fake && typeof sock === 'object') {
        try {
          const P = require('pino')
          const { downloadMediaMessage } = require('@whiskeysockets/baileys')
          const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: P({ level: 'silent' }) })
          if (buffer && buffer.length) {
            const { saveMedia } = require('../wa/media')
            const { getExtFromMime } = require('../wa/pool')
            mediaPath = await saveMedia(buffer, getExtFromMime(mediaMime))
          }
        } catch (me) {
          mediaPath = null // metadata doang (D6 — jangan scope-creep)
          logErr(tid, 'media download gagal (arsip metadata saja):', me.message)
        }
      }
    }
    content = content.slice(0, POST_TEXT_CAP)
    const msgTimestamp = msg.messageTimestamp ? new Date(Number(msg.messageTimestamp) * 1000) : null

    let post
    if (serverId) {
      // Dedupe: unique [archiveId, serverId] — sudah ada → skip (idempoten)
      try {
        post = await prisma.channelPost.create({
          data: { archiveId: archive.id, serverId, content, mediaPath, mediaType, mediaMime, fromMe: !!msg.key?.fromMe, msgTimestamp },
        })
      } catch (e) {
        if (e?.code === 'P2002') {
          // dup serverId — idempoten skip (return null-ish tetap, TANPA error)
          return { archive, post: null, deduped: true }
        }
        throw e
      }
    } else {
      // tanpa serverId (protocol eksotis) → simpan saja (dup tak terdeteksi, aman)
      post = await prisma.channelPost.create({
        data: { archiveId: archive.id, serverId: null, content, mediaPath, mediaType, mediaMime, fromMe: !!msg.key?.fromMe, msgTimestamp },
      })
    }

    log(tid, `arsip post channel ${waJid} (slot ${numberSlot})${name ? ` "${name}"` : ''}${serverId ? ` sid=${serverId}` : ''}${post ? '' : ' (dup skip)'}`)
    return { archive, post }
  } catch (e) {
    // KONTRAK: TIDAK PERNAH throw ke runtime WA — log saja, return null
    logErr(tid, 'archiveNewsletterMessage error (log-only, runtime WA aman):', e?.message || e)
    return null
  }
}

/** listArchives(tenantId) — utk FE: name, waJid, postCount, lastPostAt (spec §4) */
async function listArchives(tenantId) {
  const tid = Number(tenantId)
  const archives = await prisma.channelArchive.findMany({
    where: { tenantId: tid },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
  })
  if (!archives.length) return []
  const ids = archives.map((a) => a.id)
  const [postAgg, lastPosts] = await Promise.all([
    prisma.channelPost.groupBy({ by: ['archiveId'], where: { archiveId: { in: ids } }, _count: { id: true } }),
    Promise.all(
      archives.map((a) =>
        prisma.channelPost.findFirst({
          where: { archiveId: a.id },
          orderBy: [{ id: 'desc' }],
          select: { createdAt: true, msgTimestamp: true },
        })
      )
    ),
  ])
  const countBy = new Map(postAgg.map((p) => [p.archiveId, Number(p._count?.id) || 0]))
  return archives.map((a, i) => {
    const lp = lastPosts[i]
    return {
      id: a.id,
      name: a.name || String(a.waJid).split('@')[0],
      waJid: a.waJid,
      numberSlot: a.numberSlot,
      postCount: countBy.get(a.id) || 0,
      lastPostAt: lp ? lp.msgTimestamp || lp.createdAt : null,
      updatedAt: a.updatedAt,
    }
  })
}

/**
 * listPosts(archiveId, {limit, before}) — postingan terbaru dulu, cursor pagination
 * (GET /api/channels/:id/posts?limit=50&before=<id>). Archive WAJIB milik tenant
 * (validasi ownership oleh caller/routes).
 */
async function listPosts(tenantId, archiveId, { limit = 50, before = null } = {}) {
  const tid = Number(tenantId)
  const aid = Number(archiveId)
  const archive = await prisma.channelArchive.findFirst({
    where: { id: aid, tenantId: tid }, // tenant-scoped (isolasi ketat)
    select: { id: true, name: true, waJid: true, numberSlot: true },
  })
  if (!archive) return null
  const take = Math.max(1, Math.min(Number(limit) || 50, 100))
  const where = { archiveId: aid, ...(Number.isFinite(Number(before)) && Number(before) > 0 ? { id: { lt: Number(before) } } : {}) }
  const posts = await prisma.channelPost.findMany({
    where,
    orderBy: { id: 'desc' },
    take: take + 1, // +1 → deteksi hasMore
    select: { id: true, serverId: true, content: true, mediaPath: true, mediaType: true, mediaMime: true, fromMe: true, msgTimestamp: true, createdAt: true },
  })
  const hasMore = posts.length > take
  return { archive, posts: hasMore ? posts.slice(0, take) : posts, hasMore, nextBefore: hasMore ? posts[take - 1].id : null }
}

function detectMediaType(msg) {
  const m = msg?.message
  if (!m) return null
  if (m.imageMessage) return 'image'
  if (m.videoMessage) return 'video'
  if (m.audioMessage) return 'audio'
  if (m.stickerMessage) return 'sticker'
  if (m.documentMessage) return 'document'
  return null
}

function extractText(msg) {
  if (msg.message?.conversation) return msg.message.conversation
  if (msg.message?.extendedTextMessage?.text) return msg.message.extendedTextMessage.text
  return ''
}

module.exports = {
  isNewsletterJid,
  archiveNewsletterMessage,
  listArchives,
  listPosts,
  POST_TEXT_CAP,
}