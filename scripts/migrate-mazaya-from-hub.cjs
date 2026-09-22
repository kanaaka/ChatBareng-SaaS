// MIGRASI wa-cs-hub (non-SaaS) → wa-cs-hub-saas-v3 tenant "Mazaya"
//
// Sumber: /home/kanakxxx/.openclaw/workspace/wa-cs-hub (SQLite, Chat.id = JID string)
// Target: /home/kanakxxx/.openclaw/workspace/wa-cs-hub-saas-v3 tenant BARU "Mazaya"
//
// Transformasi kunci:
//   - Chat.id JID string → Chat.id Int baru (map JID → newId), tenantId = Mazaya
//   - User: password hash IKUT (login tetap jalan); ID baru per tenant (map lama→baru)
//   - Pesan/konten: MSG_ENCRYPTION_KEY beda → SEMUA nilai enc:v1:* di-DEKRIPSI dgn key
//     lama → di-RE-ENKRIPSI dgn key SaaS; plaintext (legacy) langsung re-encrypt.
//   - Media file: copy fisik ke data/media SaaS, path ditulis ulang (map path).
//   - Idempoten: kalau tenant "Mazaya" sudah ada → exit (jangan dobel).
//
// Yang DIPINDAHKAN: users, chats, messages, contacts, contactTags, tags, chatTags,
// chatNotes, chatEvents, templates, announcements (+reads), blasts (+logs),
// sharedFolders/Files, scheduledMessages, csatSurveys, groupActionLogs,
// appConfig/autoReply/csat/menuGateway(+options)/appearance configs, purgeLog.
// Yang GAK dipindah: pushSubscription (device-bound), gDriveLink (kredensial),
// backupLog (operasional), favoriteMessage (0 row).
const path = require('path')
const fs = require('fs')
const PROJ_HUB = '/home/kanakxxx/.openclaw/workspace/wa-cs-hub'
const PROJ_SAAS = '/home/kanakxxx/.openclaw/workspace/wa-cs-hub-saas-v3'
const ENC_RE = /^enc:v1:/

const hubPkg = path.join(PROJ_HUB, 'node_modules')
const saasPkg = path.join(PROJ_SAAS, 'node_modules')
require(path.join(hubPkg, 'dotenv')).config({ path: path.join(PROJ_HUB, '.env') })
const saasEnv = require(path.join(saasPkg, 'dotenv')).config({ path: path.join(PROJ_SAAS, '.env') }).parsed || {}

const crypto = require('crypto')
function keyBuf(raw) {
  // config.js non-SaaS & SaaS: createCipheriv('aes-256-gcm', Buffer.from(key,'hex')/raw?)
  // — ikuti implementasi textCrypto masing-masing: cek cepat saat runtime.
  return raw
}
// Ambil langsung implementasi resmi masing-masing project:
const hubTextCrypto = require(path.join(PROJ_HUB, 'src', 'services', 'textCrypto.js'))
const hubCrypto = require(path.join(PROJ_HUB, 'src', 'utils', 'crypto.js'))
const saasTextCryptoPath = path.join(PROJ_SAAS, 'src', 'services', 'textCrypto.js')
// textCrypto SaaS membaca MSG_ENCRYPTION_KEY saat require — set env dulu!
process.env.MSG_ENCRYPTION_KEY = saasEnv.MSG_ENCRYPTION_KEY
process.env.MEDIA_ENCRYPTION_KEY = saasEnv.MEDIA_ENCRYPTION_KEY
const saasTextCrypto = require(saasTextCryptoPath)
const saasMediaCrypto = require(path.join(PROJ_SAAS, 'src', 'utils', 'crypto.js'))

const { PrismaClient: HubClient } = require(path.join(PROJ_HUB, 'node_modules', '@prisma', 'client'))
const { PrismaClient: SaasClient } = require(path.join(PROJ_SAAS, 'node_modules', '@prisma', 'client'))
const hub = new HubClient({ datasources: { db: { url: `file:${path.join(PROJ_HUB, 'prisma', 'data', 'wa-cs-hub.db')}` } } })
const saas = new SaasClient({ datasources: { db: { url: saasEnv.DATABASE_URL.startsWith('file:') && !saasEnv.DATABASE_URL.includes('/') ? `file:${path.join(PROJ_SAAS, 'prisma', saasEnv.DATABASE_URL.slice(5))}` : saasEnv.DATABASE_URL.replace('file:./data/', `file:${path.join(PROJ_SAAS, 'prisma', 'data', '/')}`).replace('file:./', `file:${path.join(PROJ_SAAS, 'prisma', '/')}`) } } })

// ── helpers ─────────────────────────────────────────────────────────
function hubDecrypt(v) {
  if (v == null) return v
  if (!ENC_RE.test(v)) return v // legacy plaintext
  try { return hubTextCrypto.decryptText(v) } catch (e) { return '[migrasi: decrypt gagal]' }
}
function saasEncrypt(v) {
  if (v == null) return v
  return saasTextCrypto.encryptText(v)
}
function saasDecrypt(v) {
  if (v == null) return v
  if (!ENC_RE.test(v)) return v
  try { return saasTextCrypto.decryptTextSafe(v) } catch (e) { return null }
}
function copyMediaFile(srcPath) {
  if (!srcPath) return null
  const src = path.isAbsolute(srcPath) ? srcPath : path.join(PROJ_HUB, srcPath)
  if (!fs.existsSync(src)) return null
  const fname = path.basename(src)
  const dest = path.join(PROJ_SAAS, 'data', 'media', `mz-${Date.now()}-${fname}`)
  fs.copyFileSync(src, dest)
  return dest
}

const MEDIA_DIR_HUB = path.join(PROJ_HUB, 'data', 'media')
const MEDIA_DIR_SAAS = path.join(PROJ_SAAS, 'data', 'media')

// path hub absolut → path saas absolut (copy fisik + map)
const mediaPathMap = new Map()
function mapMediaPath(p) {
  if (!p) return p
  if (mediaPathMap.has(p)) return mediaPathMap.get(p)
  const src = p.startsWith('/') ? p : path.join(PROJ_HUB, p)
  if (!fs.existsSync(src)) { mediaPathMap.set(p, null); return null }
  const fname = path.basename(src)
  const dest = path.join(MEDIA_DIR_SAAS, `mz-${fname}`)
  if (!fs.existsSync(dest)) {
    // File media terenkripsi dgn key hub — decrypt + re-encrypt dgn key SaaS
    let plain = null
    try {
      plain = hubCrypto.decrypt(fs.readFileSync(src))
      fs.writeFileSync(dest, saasMediaCrypto.encrypt(plain))
    } catch (e) {
      // legacy plaintext / format lama — copy apa adanya
      fs.copyFileSync(src, dest)
    }
  }
  mediaPathMap.set(p, dest)
  return dest
}

const DRY = process.argv.includes('--dry')

async function main() {
  // 0) Guard idempoten
  const existing = await saas.tenant.findUnique({ where: { name: 'Mazaya' } })
  if (existing && !DRY) {
    console.log('ABORT: tenant "Mazaya" sudah ada (id ' + existing.id + ') — migrasi tidak diulang.')
    return
  }

  // 1) Tenant + admin baru
  let tenant
  if (DRY) { tenant = { id: -1 } } else {
    tenant = await saas.tenant.create({ data: { name: 'Mazaya' } })
    console.log('TENANT_CREATED id=' + tenant.id)
  }
  const tid = tenant.id

  // Superadmin SaaS = pemegang tuas (id 1)
  const saasSuper = await saas.user.findFirst({ where: { role: 'super_admin' } })
  const SUPER_ID = saasSuper.id

  // 2) Users (hash password ikut — login tetap jalan)
  const hubUsers = await hub.user.findMany({ orderBy: { id: 'asc' } })
  const userMap = new Map() // hubId → saasId
  for (const u of hubUsers) {
    if (DRY) { userMap.set(u.id, u.id); continue }
    const nu = await saas.user.create({
      data: {
        tenantId: tid,
        username: u.username,
        passwordHash: u.passwordHash,
        role: u.role === 'super_admin' ? 'admin' : u.role,
        status: u.status,
        lastLogin: u.lastLogin,
      },
    })
    userMap.set(u.id, nu.id)
    console.log(`USER ${u.username} (${u.role}) ${u.id}→${nu.id}`)
  }

  // 3) Tags (name unik global di hub, scope tenant di SaaS)
  const tagMap = new Map()
  for (const t of await hub.tag.findMany()) {
    if (DRY) { tagMap.set(t.id, t.id); continue }
    const nt = await saas.tag.create({ data: { tenantId: tid, name: t.name, color: t.color, createdBy: t.createdBy ? userMap.get(t.createdBy) : null } })
    tagMap.set(t.id, nt.id)
  }
  console.log('TAGS=' + tagMap.size)

  // 4) Chats (JID string → Int) + contact
  const hubChats = await hub.chat.findMany()
  const chatMap = new Map() // JID → saas chat id
  const chatCreated = []
  for (const ch of hubChats) {
    if (DRY) { chatMap.set(ch.id, 0); continue }
    const nc = await saas.chat.create({
      data: {
        tenantId: tid,
        waJid: ch.id,
        contactName: ch.contactName,
        contactPhone: ch.contactPhone,
        phoneJid: ch.phoneJid,
        unreadCount: ch.unreadCount,
        assignedToId: ch.assignedToId ? userMap.get(ch.assignedToId) : null,
        lastMessageAt: ch.lastMessageAt,
        // lastMessagePreview dihub = plaintext legacy (sample: false) → re-encrypt
        lastMessagePreview: ch.lastMessagePreview ? saasEncrypt(hubDecrypt(ch.lastMessagePreview)) : null,
        status: ch.status,
        resolvedAt: ch.resolvedAt,
        firstIncomingAt: ch.firstIncomingAt,
        firstAssignedAt: ch.firstAssignedAt,
        lastAssignedAt: ch.lastAssignedAt,
        firstResponseAt: ch.firstResponseAt,
        firstResponseById: ch.firstResponseById ? userMap.get(ch.firstResponseById) : null,
        csMessagesSent: ch.csMessagesSent,
        messagesBeforeResolve: ch.messagesBeforeResolve,
        reopenedCount: ch.reopenedCount,
        resolvedById: ch.resolvedById ? userMap.get(ch.resolvedById) : null,
        queuedAt: ch.queuedAt,
        lastAutoGreetDate: ch.lastAutoGreetDate,
        snoozedUntil: ch.snoozedUntil,
        snoozedBy: ch.snoozedBy ? userMap.get(ch.snoozedBy) : null,
        menuState: ch.menuState,
        menuRequestedAt: ch.menuRequestedAt,
        menuOptionId: ch.menuOptionId, // → dipatch ulang setelah menuGatewayOption dibuat
        picUserId: ch.picUserId ? userMap.get(ch.picUserId) : null,
      },
    })
    chatMap.set(ch.id, nc.id)
    chatCreated.push(nc.id)
  }
  console.log('CHATS=' + chatMap.size)

  // 5) Messages (re-encrypt content) — batch per chat via createMany? createMany tidak balikin id;
  //    FavoriteMessage=0, jadi aman pakai createMany. TAPI waMessageId unik? cek schema: tidak @unique di v3? cek.
  let msgTotal = 0
  const hubMessages = await hub.message.findMany({ orderBy: { id: 'asc' } })
  if (!DRY) {
    const rows = hubMessages.map((m) => {
      const dec = hubDecrypt(m.content)
      return {
        tenantId: tid,
        chatId: chatMap.get(m.chatId),
        direction: m.direction,
        content: dec == null ? null : saasEncrypt(dec),
        mediaPath: m.mediaPath ? mapMediaPath(m.mediaPath) : null,
        mediaType: m.mediaType,
        mediaMime: m.mediaMime,
        mediaSize: m.mediaSize,
        senderName: m.senderName,
        senderId: m.senderId ? userMap.get(m.senderId) : null,
        timestamp: m.timestamp,
        status: m.status,
        waMessageId: m.waMessageId,
        purged: m.purged,
        isAuto: m.isAuto,
        participantJid: m.participantJid,
      }
    }).filter((r) => r.chatId)
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500)
      await saas.message.createMany({ data: chunk })
      msgTotal += chunk.length
    }
  } else msgTotal = hubMessages.length
  console.log('MESSAGES=' + msgTotal)

  // 6) Contacts + contactTags
  const hubContacts = await hub.contact.findMany()
  let contactTotal = 0
  const contactMap = new Map()
  if (!DRY) {
    for (const ct of hubContacts) {
      const nc = await saas.contact.create({
        data: {
          tenantId: tid,
          chatId: ct.chatId ? chatMap.get(ct.chatId) ?? null : null,
          source: ct.source || 'chat',
          phone: ct.phone,
          name: ct.name,
          birthDate: ct.birthDate,
          gender: ct.gender,
          city: ct.city,
          note: ct.note,
          lastMenuShownAt: ct.lastMenuShownAt,
        },
      })
      contactMap.set(ct.id, nc.id)
      contactTotal++
    }
    const ctRows = (await hub.contactTag.findMany()).map((j) => ({ tenantId: tid, contactId: contactMap.get(j.contactId), tagId: tagMap.get(j.tagId), addedById: j.addedById ? userMap.get(j.addedById) : null })).filter((r) => r.contactId && r.tagId)
    for (let i = 0; i < ctRows.length; i += 500) {
      await saas.contactTag.createMany({ data: ctRows.slice(i, i + 500) })
    }
  } else contactTotal = hubContacts.length
  console.log('CONTACTS=' + contactTotal + ' CONTACT_TAGS=' + (DRY ? (await hub.contactTag.count()) : ''))

  // 7) ChatTags
  const hubChatTags = await hub.chatTag.findMany()
  if (!DRY) {
    const rows = hubChatTags.map((j) => ({ chatId: chatMap.get(j.chatId), tagId: tagMap.get(j.tagId) })).filter((r) => r.chatId)
    for (let i = 0; i < rows.length; i += 500) {
      await saas.chatTag.createMany({ data: rows.slice(i, i + 500) })
    }
  }
  console.log('CHAT_TAGS=' + hubChatTags.length)

  // 8) Notes, events, groupActionLogs
  let noteTotal = 0, evTotal = 0, galTotal = 0
  if (!DRY) {
    for (const n of await hub.chatNote.findMany()) {
      const cid = chatMap.get(n.chatId)
      if (!cid) continue
      await saas.chatNote.create({ data: { tenantId: tid, chatId: cid, userId: userMap.get(n.userId) || SUPER_ID, body: (() => { const d = hubDecrypt(n.body); return d == null ? '' : saasEncrypt(d) })(), createdAt: n.createdAt } })
      noteTotal++
    }
    for (const ev of await hub.chatEvent.findMany()) {
      const cid = chatMap.get(ev.chatId)
      if (!cid) continue
      await saas.chatEvent.create({ data: { tenantId: tid, chatId: cid, userId: ev.userId ? (userMap.get(ev.userId) || null) : null, type: ev.type, createdAt: ev.createdAt } })
      evTotal++
    }
    let galSkipped = 0
    for (const g of await hub.groupActionLog.findMany()) {
      const cid = chatMap.get(g.chatId)
      if (!cid) { galSkipped++; continue } // audit yatim (chat asal sudah dihapus di hub) — skip
      await saas.groupActionLog.create({ data: { tenantId: tid, chatId: cid, actorUserId: userMap.get(g.actorUserId) || SUPER_ID, action: g.action, detail: g.detail, createdAt: g.createdAt } })
      galTotal++
    }
    if (galSkipped) console.log('GAL_SKIPPED_ORPHAN=' + galSkipped)
  } else { noteTotal = await hub.chatNote.count(); evTotal = await hub.chatEvent.count(); galTotal = await hub.groupActionLog.count() }
  console.log('NOTES=' + noteTotal + ' EVENTS=' + evTotal + ' GAL=' + galTotal)

  // 9) Templates
  let tplTotal = 0
  if (!DRY) {
    for (const t of await hub.messageTemplate.findMany()) {
      const d = hubDecrypt(t.content)
      await saas.messageTemplate.create({ data: { tenantId: tid, name: t.name, keyword: t.keyword, content: d == null ? t.content : saasEncrypt(d), createdBy: userMap.get(t.createdBy) || SUPER_ID } })
      tplTotal++
    }
  } else tplTotal = await hub.messageTemplate.count()
  console.log('TEMPLATES=' + tplTotal)

  // 10) Announcements + reads
  let annTotal = 0, annReadTotal = 0
  if (!DRY) {
    for (const a of await hub.announcement.findMany()) {
      const d = hubDecrypt(a.content)
      const na = await saas.announcement.create({ data: { tenantId: tid, title: a.title, content: d == null ? a.content : saasEncrypt(d), pinned: a.pinned, isActive: a.isActive, expiresAt: a.expiresAt, createdById: userMap.get(a.createdById) || SUPER_ID, createdAt: a.createdAt, updatedAt: a.updatedAt } })
      annTotal++
      for (const r of await hub.announcementRead.findMany({ where: { announcementId: a.id } })) {
        const uid = userMap.get(r.userId)
        if (!uid) continue
        await saas.announcementRead.create({ data: { announcementId: na.id, userId: uid, readAt: r.readAt } })
        annReadTotal++
      }
    }
  } else { annTotal = await hub.announcement.count(); annReadTotal = await hub.announcementRead.count() }
  console.log('ANNOUNCEMENTS=' + annTotal + ' READS=' + annReadTotal)

  // 11) Blasts + logs
  const blastMap = new Map()
  let blastTotal = 0, blastLogTotal = 0
  if (!DRY) {
    for (const b of await hub.blast.findMany()) {
      const d = hubDecrypt(b.message)
      const mediaPath = b.mediaPath ? mapMediaPath(b.mediaPath) : null
      const nb = await saas.blast.create({ data: { tenantId: tid, name: b.name, message: d == null ? b.message : saasEncrypt(d), mediaPath, startedAt: b.startedAt, completedAt: b.completedAt, createdBy: userMap.get(b.createdBy) || SUPER_ID } })
      blastMap.set(b.id, nb.id)
      blastTotal++
      for (const l of await hub.blastLog.findMany({ where: { blastId: b.id } })) {
        await saas.blastLog.create({ data: { blastId: nb.id, chatId: l.chatId ? chatMap.get(l.chatId) ?? null : null, phoneNumber: l.phoneNumber, contactName: l.contactName, status: l.status, error: l.error, sentAt: l.sentAt } })
        blastLogTotal++
      }
    }
  } else { blastTotal = await hub.blast.count(); blastLogTotal = await hub.blastLog.count() }
  console.log('BLASTS=' + blastTotal + ' BLAST_LOGS=' + blastLogTotal)

  // 12) Shared folders/files (storagePath dimap)
  let folderTotal = 0, fileTotal = 0
  const folderMap = new Map()
  if (!DRY) {
    for (const f of await hub.sharedFolder.findMany()) {
      const nf = await saas.sharedFolder.create({ data: { tenantId: tid, name: f.name, createdBy: f.createdBy ? userMap.get(f.createdBy) : null, createdAt: f.createdAt } })
      folderMap.set(f.id, nf.id)
      folderTotal++
    }
    for (const f of await hub.sharedFile.findMany()) {
      await saas.sharedFile.create({ data: {
        tenantId: tid,
        filename: f.filename,
        title: f.title,
        type: f.type,
        mimeType: f.mimeType,
        size: f.size,
        url: f.url,
        caption: f.caption,
        storagePath: f.storagePath ? mapMediaPath(f.storagePath) : null,
        folderId: f.folderId ? folderMap.get(f.folderId) : null,
        uploadedBy: userMap.get(f.uploadedBy) || SUPER_ID,
        createdAt: f.createdAt,
      } })
      fileTotal++
    }
  } else { folderTotal = await hub.sharedFolder.count(); fileTotal = await hub.sharedFile.count() }
  console.log('FOLDERS=' + folderTotal + ' FILES=' + fileTotal)

  // 13) Scheduled messages + CSAT surveys
  let schedTotal = 0, csatTotal = 0
  if (!DRY) {
    for (const s of await hub.scheduledMessage.findMany()) {
      const d = hubDecrypt(s.body)
      await saas.scheduledMessage.create({ data: { tenantId: tid, chatId: chatMap.get(s.chatId), createdById: userMap.get(s.createdById), body: d == null ? s.body : saasEncrypt(d), scheduledAt: s.scheduledAt, status: s.status, sentAt: s.sentAt, error: s.error, createdAt: s.createdAt } })
      schedTotal++
    }
    for (const s of await hub.csatSurvey.findMany()) {
      await saas.csatSurvey.create({ data: { tenantId: tid, chatId: chatMap.get(s.chatId), token: s.token, sentAt: s.sentAt, rating: s.rating, respondedAt: s.respondedAt, createdById: userMap.get(s.createdById) || SUPER_ID, userId: s.userId ? (userMap.get(s.userId) || null) : null, createdAt: s.createdAt } })
      csatTotal++
    }
  } else { schedTotal = await hub.scheduledMessage.count(); csatTotal = await hub.csatSurvey.count() }
  console.log('SCHEDULED=' + schedTotal + ' CSAT=' + csatTotal)

  // 14) PurgeLog (riwayat purge lama — riwayat, bukan data aktif)
  let purgeLogTotal = 0
  if (!DRY) {
    for (const p of await hub.purgeLog.findMany()) {
      await saas.purgeLog.create({ data: { tenantId: tid, purgeDate: p.purgeDate, purgedById: userMap.get(p.purgedById) || SUPER_ID, chatCount: p.chatCount, messageCount: p.messageCount, reason: p.reason } })
      purgeLogTotal++
    }
  } else purgeLogTotal = await hub.purgeLog.count()
  console.log('PURGE_LOGS=' + purgeLogTotal)

  // 15) Configs (singleton → tenantId = Mazaya; menuOption tagId dipatch)
  let cfgNote = ''
  if (!DRY) {
    const ac = await hub.appConfig.findFirst()
    if (ac) await saas.appConfig.create({ data: { tenantId: tid, readReceiptsEnabled: ac.readReceiptsEnabled, updatedById: ac.updatedById ? userMap.get(ac.updatedById) : null } })
    const ar = await hub.autoReplyConfig.findFirst()
    if (ar) await saas.autoReplyConfig.create({ data: {
      tenantId: tid, outsideHoursEnabled: ar.outsideHoursEnabled, outsideHoursText: ar.outsideHoursText,
      greetEnabled: ar.greetEnabled, greetText: ar.greetText, greetMode: ar.greetMode,
      monFriEnabled: ar.monFriEnabled, monFriStart: ar.monFriStart, monFriEnd: ar.monFriEnd,
      satEnabled: ar.satEnabled, satStart: ar.satStart, satEnd: ar.satEnd,
      sunEnabled: ar.sunEnabled, sunStart: ar.sunStart, sunEnd: ar.sunEnd,
      updatedById: ar.updatedById ? userMap.get(ar.updatedById) : null,
    } })
    const ap = await hub.appearanceConfig.findFirst()
    if (ap) await saas.appearanceConfig.create({ data: { tenantId: tid, accentSeed: ap.accentSeed, themeCss: ap.themeCss, updatedById: ap.updatedById ? userMap.get(ap.updatedById) : null } })
    const cs = await hub.csatConfig.findFirst()
    if (cs) await saas.csatConfig.create({ data: { tenantId: tid, enabled: cs.enabled, message: cs.message, cooldownMode: cs.cooldownMode, cooldownHours: cs.cooldownHours, updatedById: cs.updatedById ? userMap.get(cs.updatedById) : null } })
    const bc = await hub.backupConfig.findFirst()
    if (bc) await saas.backupConfig.create({ data: { tenantId: tid, frequency: bc.frequency, hour: bc.hour, dayOfWeek: bc.dayOfWeek, dayOfMonth: bc.dayOfMonth, retentionCount: bc.retentionCount, enabled: bc.enabled } })
    const mg = await hub.menuGatewayConfig.findFirst({ include: { options: true } })
    if (mg) {
      const nmg = await saas.menuGatewayConfig.create({ data: { tenantId: tid, enabled: mg.enabled, introText: mg.introText, fallbackText: mg.fallbackText, fallbackTagId: mg.fallbackTagId ? tagMap.get(mg.fallbackTagId) : null, timeoutValue: mg.timeoutValue, timeoutUnit: mg.timeoutUnit, repeatFrequency: mg.repeatFrequency, updatedById: mg.updatedById ? userMap.get(mg.updatedById) : null } })
      for (const o of mg.options) {
        await saas.menuGatewayOption.create({ data: { tenantId: tid, configId: nmg.id, position: o.position, label: o.label, aliases: o.aliases, replyText: o.replyText, tagId: o.tagId ? tagMap.get(o.tagId) : null } })
      }
      // Patch chat.menuOptionId lama → id opsi baru (match by position+label)
      for (const o of mg.options) {
        const nopt = await saas.menuGatewayOption.findFirst({ where: { tenantId: tid, configId: nmg.id, position: o.position } })
        if (nopt) await saas.chat.updateMany({ where: { tenantId: tid, menuOptionId: o.id }, data: { menuOptionId: nopt.id } })
      }
      cfgNote = 'configs OK (app/autoReply/appearance/csat/backup/menuGw+' + mg.options.length + ' opsi)'
    }
  } else cfgNote = 'DRY'
  console.log('CONFIGS=' + cfgNote)

  console.log('DRY=' + DRY)
  await hub.$disconnect(); await saas.$disconnect()
  console.log('MIGRATION_DONE')
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })