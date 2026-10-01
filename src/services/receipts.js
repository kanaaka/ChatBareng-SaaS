/**
 * v0.12.9 — Read receipts (blue tick) helper.
 * Gate: AppConfig.readReceiptsEnabled (admin tenant, default OFF).
 * markIncomingRead(tenantId, chatId) → kirim read receipt utk SEMUA pesan masuk
 * chat itu yang belum di-receipt (idempoten: DB status di-set 'read' pasca kirim).
 *
 * Catatan teknis:
 * - Baileys v6: sock.readMessages(keys) gak dipakai — dia ikut privacy setting
 *   akun (readreceipts != 'all' → type 'read-self' = gak kelihatan pelanggan).
 *   Kita pakai sock.sendReceipts(keys, 'read') eksplisit → toggle app = sumber
 *   keputusan, deterministik.
 * - Key format: { remoteJid: waJid, id: waMessageId, fromMe: false } — pakai
 *   remoteJid SAMA dengan key pesan asli (termasuk chat @lid).
 * - v3.0 — socket diambil dari pool per-tenant; chatId Int, waJid dari row chat.
 */
const prisma = require('../prisma')
const appConfig = require('./appConfig')
const broadcast = require('../socket/broadcast')

async function markIncomingRead(tenantId, chatId, { limit = 50 } = {}) {
  try {
    const tid = Number(tenantId)
    const cid = Number(chatId)
    if (!Number.isFinite(tid) || !Number.isFinite(cid)) return { sent: 0, skipped: true }

    const cfg = await appConfig.getConfig(tid)
    if (!cfg.readReceiptsEnabled) return { sent: 0, skipped: true }

    const chat = await prisma.chat.findFirst({
      where: { id: cid, tenantId: tid },
      select: { waJid: true },
    })
    if (!chat) return { sent: 0 }

    const msgs = await prisma.message.findMany({
      where: {
        tenantId: tid,
        chatId: cid,
        direction: 'in',
        waMessageId: { not: null },
        NOT: { status: 'read' },
      },
      orderBy: { timestamp: 'asc' },
      take: limit,
      select: { id: true, waMessageId: true },
    })
    if (!msgs.length) return { sent: 0 }

    const wa = require('../wa/pool') // lazy — circular dep guard
    const sock = wa.getSocketForTenant(tid)
    if (!sock) return { sent: 0, offline: true }

    const keys = msgs.map(m => ({ remoteJid: chat.waJid, id: m.waMessageId, fromMe: false }))
    await sock.sendReceipts(keys, 'read')

    // Idempotensi: tandai sudah di-receipt agar tidak dikirim ulang + sync UI agent
    await prisma.message.updateMany({
      where: { tenantId: tid, chatId: cid, direction: 'in', waMessageId: { in: msgs.map(m => m.waMessageId) } },
      data: { status: 'read' },
    })
    for (const m of msgs) {
      broadcast.emitToTenant(tid, 'message_status', { chatId: cid, messageId: m.id, status: 'read' })
    }
    return { sent: keys.length }
  } catch (e) {
    console.error('[Receipts] markIncomingRead error:', e.message)
    return { sent: 0, error: e.message }
  }
}

module.exports = { markIncomingRead }