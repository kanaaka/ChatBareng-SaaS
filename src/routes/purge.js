const express = require('express')
const router = express.Router()
const prisma = require('../prisma')
const { requireAuth, requireAdmin, requireTenant } = require('../auth')

// v3.0 — Isolasi tenant: purge = tenant-scoped (PurgeLog.tenantId eksplisit)
const rt = [requireAuth, requireTenant, requireAdmin]  // requireTenant dulu — super_admin wajib ?tenant= sebelum cek admin
const { purgeValidation } = require('../utils/validation')
const broadcast = require('../socket/broadcast')
const queue = require('../socket/queue')
// v0.11.0 — preview recompute: pesan aktif terakhir berisi ciphertext → enkripsi ulang
const { encryptText } = require('../services/textCrypto')
const fs = require('fs')
const config = require('../config')

// v0.12.4 — Purge = hapus byte dari disk: logical delete (flag purged / deleteMany)
// meninggalkan plaintext lama di slack space halaman SQLite (terbaca via strings/raw
// read sampai VACUUM). Jalankan VACUUM inline setelah SEMUA operasi purge yang
// menulis DB — file live (~250KB / 61 halaman) → VACUUM-nya milidetik.
// Gagal VACUUM TIDAK boleh gagalkan purge → log warning aja.
async function vacuumAfterPurge() {
  try {
    await prisma.$executeRawUnsafe('VACUUM')
    console.log('[PURGE] VACUUM ok — byte plaintext terhapus dari slack space disk')
  } catch (e) {
    console.error('[PURGE] VACUUM gagal (purge tetap sukses, byte nyangkut di slack space):', e.message)
  }
}

// POST /api/purge (admin only)
router.post('/', ...rt, purgeValidation, async (req, res) => {
  try {
    const { mode, chatIds, dateRange, reason } = req.body
    
    let where = { tenantId: req.tenantId, purged: false }
    
    if (chatIds && Array.isArray(chatIds) && chatIds.length > 0) {
      where.chatId = { in: chatIds }
    }
    
    if (dateRange && dateRange.start && dateRange.end) {
      where.timestamp = {
        gte: new Date(dateRange.start),
        lte: new Date(dateRange.end),
      }
    }
    
    const messages = await prisma.message.findMany({ where })

    if (mode === 'soft') {
      // Soft delete — mark as purged + NULL-kan konten/media (v0.12.4):
      // baris tetap ada (referensi backup/dedup purged flag aman), tapi plaintext
      // tidak disimpan lagi — kalau tidak, byte plaintext tetap LIVE di halaman
      // SQLite dan VACUUM tidak akan pernah menghapusnya (baris masih hidup).
      // Semua path aplikasi sudah filter purged:false → konten flagged tak pernah dibaca.
      await prisma.message.updateMany({
        where,
        data: { purged: true, content: null, mediaPath: null },
      })
      // v0.12.4 — purge = hapus byte dari disk (slack space halaman SQLite)
      await vacuumAfterPurge()
    } else if (mode === 'hard') {
      // Hard delete — delete from DB + delete media files
      // Collect media files before deletion
      const mediaFiles = messages.filter(m => m.mediaPath).map(m => m.mediaPath)
      
      // Delete messages from DB
      await prisma.message.deleteMany({ where })
      
      // Delete media files
      for (const filepath of mediaFiles) {
        try {
          if (fs.existsSync(filepath)) fs.unlinkSync(filepath)
        } catch {}
      }
      // v0.12.4 — purge = hapus byte dari disk (slack space halaman SQLite)
      await vacuumAfterPurge()
    } else {
      // v0.12.4 — mode tidak dikenal / tanpa operasi baris → tidak ada byte baru
      // nyangkut, tapi tetap VACUUM supaya purge SEBELUMNYA (sebelum v0.12.4)
      // ikut terhapus dari slack space.
      await vacuumAfterPurge()
    }

    const chatCount = new Set(messages.map(m => m.chatId)).size
    
    // Log purge
    await prisma.purgeLog.create({
      data: {
        tenantId: req.tenantId,
        purgedById: req.user.id,
        chatCount,
        messageCount: messages.length,
        reason: reason || null,
        purgeDate: new Date(),
      },
    })

    // v0.1.24 — REAL CLEAN: reset SEMUA operational state chat terdampak.
    // Bug: shell chat masih menyimpan binding agent lama (assignedToId) + status
    // resolved → pesan baru dari kontak yang sama nyantol ke agent lama & tidak
    // masuk antrean sebagai chat baru. Purge = fresh start total.
    const affectedChatIds = [...new Set(messages.map(m => m.chatId))]
    await prisma.chat.updateMany({
      where: { tenantId: req.tenantId, id: { in: affectedChatIds } },
      data: {
        status: 'open',
        assignedToId: null,
        resolvedAt: null,
        resolvedById: null,
        queuedAt: null,
        firstIncomingAt: null,
        firstAssignedAt: null,
        lastAssignedAt: null,
        firstResponseAt: null,
        firstResponseById: null,
        csMessagesSent: 0,
        messagesBeforeResolve: null,
        unreadCount: 0,
        // v0.13.4 — marker auto-reply ikut di-reset (purge = fresh start total):
        // tanpa ini QA/operasional terblokir "sudah kirim hari ini" tanpa terlihat.
        lastAutoGreetDate: null,
        menuState: null,
        menuRequestedAt: null,
        menuOptionId: null,
      },
    })
    // v0.13.4 — reset Contact.lastMenuShownAt utk kontak dengan chatId terdampak
    // (marker D6 menu intro — repeat frequency harus mulai segar setelah purge).
    await prisma.contact.updateMany({
      where: { tenantId: req.tenantId, chatId: { in: affectedChatIds } },
      data: { lastMenuShownAt: null },
    })
    // v0.1.22 — preview dihitung ulang dari pesan aktif yang tersisa (partial purge)
    for (const chatId of affectedChatIds) {
      const newest = await prisma.message.findFirst({
        where: { tenantId: req.tenantId, chatId, purged: false },
        orderBy: { timestamp: 'desc' },
      })
      const newPreview = newest ? (newest.content || '[Media]') : null
      await prisma.chat.update({
        where: { id: chatId },
        data: {
          lastMessagePreview: encryptText(newPreview), // v0.11.0 — preview terenkripsi at-rest
          lastMessageAt: newest ? newest.timestamp : null,
        },
      })
      broadcast.emitToTenant(req.tenantId, 'chat_update', { chatId, status: 'open', assignedTo: null, resolvedAt: null, lastMessage: newPreview, lastMessageAt: newest ? newest.timestamp : null })
    }
    broadcast.emitToTenant(req.tenantId, 'chats_purged', { chatIds: affectedChatIds })
    queue.emitQueueUpdate(req.tenantId)

    res.json({
      mode,
      chatCount,
      messageCount: messages.length,
      affectedChatIds,
    })
  } catch (e) {
    console.error('Purge error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/purge/log
router.get('/log', ...rt, async (req, res) => {
  try {
    const logs = await prisma.purgeLog.findMany({
      where: { tenantId: req.tenantId },
      include: {
        purgedBy: { select: { id: true, username: true } },
      },
      orderBy: { purgeDate: 'desc' },
      take: 50,
    })
    res.json({ logs })
  } catch (e) {
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router