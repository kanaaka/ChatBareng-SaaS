/**
 * Blast Execution Engine
 * 
 * Sends mass messages with rate limiting, personalization, and real-time progress.
 * Supports pause/resume/cancel via status flags in the Blast record.
 * Phase 2: CSV recipients (phone-only) + media attachment (image with caption).
 */

const prisma = require('../prisma')
const broadcast = require('../socket/broadcast')
const wa = require('../wa/pool')
const { loadMedia } = require('../wa/media')
const { decryptTextSafe } = require('./textCrypto') // v0.12.4 — enkripsi scope 2: Blast.message
const fs = require('fs')

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Personalize a message by replacing {name} with contact name.
 * If no contact name, removes {name} cleanly (no double spaces, no " ," artifacts).
 * @param {string} template - Message template
 * @param {string|null} contactName - Contact name from DB or CSV
 * @param {string|null} phoneNumber - Phone number fallback
 * @returns {string} Personalized message
 */
function personalizeMessage(template, contactName, phoneNumber) {
  if (contactName && contactName.trim()) {
    // Has a name — replace {name} with it
    return template.replace(/\{name\}/g, contactName)
  }
  // No name — remove {name} and clean up artifacts
  let result = template.replace(/\{name\}/g, '')
  // Clean up double spaces
  result = result.replace(/  +/g, ' ')
  // Clean up space before punctuation (common artifact after removing {name})
  result = result.replace(/\s+,/g, ',').replace(/\s+\./g, '.')
  // Trim leading/trailing spaces
  result = result.trim()
  return result
}

/**
 * Run a blast to completion. Called in background (do not await from route).
 * @param {number} blastId - The Blast record ID
 */
async function runBlast(blastId) {
  try {
    // Fetch blast record
    const blast = await prisma.blast.findUnique({
      where: { id: blastId },
      include: { logs: true },
    })

    if (!blast) {
      console.error(`[Blast] Blast ${blastId} not found`)
      return
    }

    const tenantId = blast.tenantId

    // v3 — resolve waJid per BlastLog: map logId → waJid dari chat (chatId Int)
    const logChatIds = blast.logs.map((l) => l.chatId).filter((c) => c != null)
    const chatRows = logChatIdsToRows(await prisma, tenantId, logChatIds)
    const chatJidMap = new Map() // blastLog.id → waJid
    for (const log of blast.logs) {
      if (log.chatId != null && chatRows.has(log.chatId)) {
        chatJidMap.set(log.id, chatRows.get(log.chatId).waJid)
      }
    }

    // v0.12.4 — enkripsi scope 2: template tersimpan ciphertext → dekrip SEKALI
    // di sini; personalisasi {name} jalan di plaintext (jangan enkripsi hasil replace).
    const messageTemplate = decryptTextSafe(blast.message)

    // Update status to running
    await prisma.blast.update({
      where: { id: blastId },
      data: { status: 'running', startedAt: new Date() },
    })

    console.log(`[Blast] Starting blast ${blastId}: ${blast.totalRecipients} recipients`)

    // Group recipients
    const logs = blast.logs
    const groupSize = blast.groupSize || 100
    const groups = []
    for (let i = 0; i < logs.length; i += groupSize) {
      groups.push(logs.slice(i, i + groupSize))
    }

    let sentCount = 0
    let failedCount = 0
    const total = blast.totalRecipients

    // Check if media file exists (for media blasts)
    const hasMedia = blast.mediaPath && fs.existsSync(blast.mediaPath)

    for (let g = 0; g < groups.length; g++) {
      const group = groups[g]

      // Check blast status before starting a new group
      const currentBlast = await prisma.blast.findUnique({ where: { id: blastId } })
      if (currentBlast.status === 'cancelled') {
        console.log(`[Blast] Blast ${blastId} cancelled`)
        await finishBlast(blastId, sentCount, failedCount, 'cancelled')
        return
      }
      if (currentBlast.status === 'paused') {
        console.log(`[Blast] Blast ${blastId} paused, waiting...`)
        // Wait until resumed or cancelled
        while (true) {
          await sleep(2000)
          const check = await prisma.blast.findUnique({ where: { id: blastId } })
          if (check.status === 'running') {
            console.log(`[Blast] Blast ${blastId} resumed`)
            break
          }
          if (check.status === 'cancelled') {
            console.log(`[Blast] Blast ${blastId} cancelled during pause`)
            await finishBlast(blastId, sentCount, failedCount, 'cancelled')
            return
          }
        }
      }

      for (let i = 0; i < group.length; i++) {
        const log = group[i]

        // Check status before each send
        const check = await prisma.blast.findUnique({ where: { id: blastId } })
        if (check.status === 'cancelled') {
          console.log(`[Blast] Blast ${blastId} cancelled mid-group`)
          await finishBlast(blastId, sentCount, failedCount, 'cancelled')
          return
        }
        if (check.status === 'paused') {
          console.log(`[Blast] Blast ${blastId} paused mid-group, waiting...`)
          while (true) {
            await sleep(2000)
            const resume = await prisma.blast.findUnique({ where: { id: blastId } })
            if (resume.status === 'running') break
            if (resume.status === 'cancelled') {
              await finishBlast(blastId, sentCount, failedCount, 'cancelled')
              return
            }
          }
        }

        const recipient = chatJidMap.get(log.id) || (log.phoneNumber ? `${log.phoneNumber}@s.whatsapp.net` : null)
        const displayName = log.contactName || log.phoneNumber || 'Pelanggan'

        try {
          const personalizedMsg = personalizeMessage(messageTemplate, log.contactName, log.phoneNumber)

          // Determine the JID to send to
          // For CSV recipients: chatId null → pakai phoneNumber@s.whatsapp.net
          // For chat list/tag recipients: log.chatId Int → resolve waJid dari chat map
          const jid = recipient
          if (!jid) {
            throw new Error('No JID (chat hilang / CSV tanpa nomor) untuk recipient')
          }

          // Send message — via pool per-tenant (v3)
          if (hasMedia) {
            // Image with caption — decrypt the media file before sending
            // blast.mediaPath points to an ENCRYPTED file on disk; Baileys
            // needs the raw (decrypted) buffer, same as regular chat media.
            const mediaBuffer = loadMedia(blast.mediaPath)
            await wa.sendMediaForTenant(tenantId, jid, mediaBuffer, 'image', 'image/jpeg', personalizedMsg, null)
          } else {
            // Text only
            await wa.sendMessageForTenant(tenantId, jid, personalizedMsg)
          }

          // Update log
          await prisma.blastLog.update({
            where: { id: log.id },
            data: { status: 'sent', sentAt: new Date() },
          })

          sentCount++
        } catch (err) {
          console.error(`[Blast] Failed to send to ${recipient}:`, err.message)
          
          await prisma.blastLog.update({
            where: { id: log.id },
            data: { status: 'failed', error: err.message?.slice(0, 500) || 'Unknown error' },
          })

          failedCount++
        }

        // Determine the last recipient's send status for the progress event
        const lastLog = await prisma.blastLog.findUnique({ where: { id: log.id } })
        const lastStatus = lastLog ? lastLog.status : 'sent'
        const lastError = lastLog ? lastLog.error : null

        // Emit progress — tenant-scoped (room tenant:<id>)
        broadcast.emitToTenant(tenantId, 'blast_progress', {
          blastId,
          sent: sentCount,
          failed: failedCount,
          total,
          currentRecipient: {
            name: displayName,
            phone: log.phoneNumber || (log.chatId != null ? String(log.chatId) : ''),
          },
          lastStatus,     // 'sent' | 'failed' — status of the recipient just processed
          lastError,      // error message if failed, null otherwise
          currentGroup: g + 1,
          totalGroups: groups.length,
          status: 'running',
        })

        // Update blast totals periodically
        await prisma.blast.update({
          where: { id: blastId },
          data: { totalSent: sentCount, totalFailed: failedCount },
        })

        // Delay between messages (skip after last in group)
        if (i < group.length - 1) {
          await sleep((blast.delayPerMsg || 5) * 1000)
        }
      }

      // Delay between groups (skip after last group)
      if (g < groups.length - 1) {
        console.log(`[Blast] Group ${g + 1}/${groups.length} done, waiting ${blast.delayPerGroup}s...`)
        await sleep((blast.delayPerGroup || 60) * 1000)
      }
    }

    // Blast complete
    await finishBlast(blastId, sentCount, failedCount, 'completed')
    console.log(`[Blast] Blast ${blastId} complete: ${sentCount} sent, ${failedCount} failed`)

  } catch (err) {
    console.error(`[Blast] Blast ${blastId} error:`, err)
    await finishBlast(blastId, 0, 0, 'failed')
    const failed = await prisma.blast.findUnique({ where: { id: blastId }, select: { tenantId: true } }).catch(() => null)
    if (failed) broadcast.emitToTenant(failed.tenantId, 'blast_error', { blastId, error: err.message })
    else broadcast.emit('blast_error', { blastId, error: err.message })
  }
}

/**
 * v3 helper — resolve Chat rows (id Int) milik tenant → Map<chatId, chat>.
 * BlastLog.chatId kini Int FK Chat.id (dulu JID string).
 */
async function logChatIdsToRows(prisma, tenantId, chatIds) {
  const map = new Map()
  const ids = Array.from(new Set((chatIds || []).map(Number).filter(Number.isFinite)))
  if (!ids.length) return map
  const rows = await prisma.chat.findMany({
    where: { tenantId, id: { in: ids } },
    select: { id: true, waJid: true },
  })
  for (const r of rows) map.set(r.id, r)
  return map
}

/**
 * Finalize a blast — update status, totals, and emit completion event.
 */
async function finishBlast(blastId, sentCount, failedCount, status) {
  const blast = await prisma.blast.update({
    where: { id: blastId },
    data: {
      status,
      totalSent: sentCount,
      totalFailed: failedCount,
      completedAt: new Date(),
    },
  })

  broadcast.emitToTenant(blast.tenantId, 'blast_complete', {
    blastId,
    totalSent: sentCount,
    totalFailed: failedCount,
    status,
  })
}

module.exports = {
  runBlast,
  personalizeMessage,
}