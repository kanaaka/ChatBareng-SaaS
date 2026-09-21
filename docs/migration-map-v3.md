# Migration Map — v3 Phase 1 Multi-Tenant (ChatBareng v0.15.2 → SaaS)

> Ditulis Alita 2026-09-21 sebelum ngoding (WAJIB spec §1). Konvensi baru:
> - `Chat.id` = **Int autoincrement** (bukan JID). JID pindah ke `Chat.waJid` (String).
>   Lookup chat = `findUnique({ where: { tenantId_waJid: { tenantId, waJid } } })` atau
>   `findFirst({ where: { id, tenantId } })` dari Int id.
> - Semua model milik tenant dapat `tenantId Int` + `@@index([tenantId])`.
> - Model config singleton (AppConfig/AutoReplyConfig/MenuGatewayConfig(+Option)/
>   CsatConfig/AppearanceConfig/BackupConfig): `id` tetap autoincrement row-id,
>   constraint bisnis pindah ke `@@unique([tenantId])` — seed per-tenant via
>   `tenantSeed.seedTenantDefaults(tenantId)` saat tenant dibuat.
> - Socket: semua broadcast tenant-scoped via `broadcast.emitToTenant(tenantId, ...)`;
>   queue/presence per tenant.
> - Anti-grup `id endsWith '@g.us'` → `waJid endsWith '@g.us'`.

## 1. Prisma models (per titik)

| # | Titik | Lama (v0.15.2) | Baru (v3 Phase 1) |
|---|-------|----------------|-------------------|
| 1 | `Message.chatId` | String (JID), FK Chat.id | `chatId Int` FK Chat.id + `tenantId Int` + @@index([tenantId]) |
| 2 | `ChatEvent.chatId` | String (JID) | `chatId Int` FK + `tenantId Int` + @@index |
| 3 | `ChatTag.chatId` | String PK @id([chatId,tagId]) | `chatId Int` PK composite [chatId,tagId] + relasi Chat |
| 4 | `ChatNote.chatId` | String | `chatId Int` FK + `tenantId Int` |
| 5 | `CsatSurvey.chatId` | String | `chatId Int` FK + `tenantId Int` |
| 6 | `ScheduledMessage.chatId` | String | `chatId Int` FK + `tenantId Int` |
| 7 | `GroupActionLog.chatId` | String (loose, tanpa FK) | `chatId Int` + `tenantId Int` + @@index([tenantId]) (loose tetap — purge tak memblokir aksi) |
| 8 | `PurgeLog` | global | `tenantId Int` — inherit eksplisit dari actor (bukan via userId join); admin purge hanya tenant-nya |
| 9 | `FavoriteMessage.chatId` | String | `chatId Int` (denormalized ref, tanpa FK; tenant via join Message/User) — tanpa tenantId sendiri (pola v2 terbukti) |
| 10 | `Contact.chatId` | String? @unique | `chatId Int? @unique` FK Chat.id + `tenantId Int` + @@index([tenantId]) |
| 11 | `Blast` | — | + `tenantId Int` + @@index |
| 12 | `BlastLog.chatId` (recipient) | String? (JID) | `chatId Int?` (Int FK Chat.id) — phoneNumber tetap utk CSV cold numbers |
| 13 | `MessageTemplate` | name/keyword @unique global | + tenantId; unique jadi @@unique([tenantId,name]), @@unique([tenantId,keyword]) |
| 14 | `Tag` | name @unique global | + tenantId; @@unique([tenantId,name]) |
| 15 | `ContactTag.tenantId` | @default(1) dummy | tenantId real dari contact + @@index([tenantId]) |
| 16 | `MenuGatewayOption.tenantId` | @default(1) dummy | tenantId real (dari config), @@unique([configId,position]) tetap |
| 17 | `AppConfig` / `AutoReplyConfig` / `CsatConfig` / `AppearanceConfig` / `BackupConfig` | singleton id=1 | `@@unique([tenantId])`; `id` autoincrement biasa |
| 18 | `MenuGatewayConfig` | singleton id=1 | `@@unique([tenantId])` |
| 19 | `SharedFile` / `SharedFolder` | — | + tenantId; folder @@unique([tenantId,name]) |
| 20 | `Announcement` / `AnnouncementRead` | — | Announcement + tenantId; AnnouncementRead resolve via user (pola v2) |
| 21 | `PushSubscription` | — | resolve via userId (pola v2 — tanpa tenantId sendiri) |
| 22 | `GDriveLink` / `BackupLog` | per-user | tetap per-user (milik user tenant); tenant via userId — @@index([tenantId]) tidak perlu |
| 23 | `Tenant` (BARU) | — | { id, name @unique, status active\|suspended, waPhone?, waSessionDir?, createdAt, users[], chats[] } |
| 24 | `User` | role cs\|admin\|relay | role super_admin\|admin\|cs\|relay + `tenantId Int?` + @@index([tenantId]) (super_admin = NULL) |
| 25 | `Chat` | id String (JID) @id | `id Int @id @default(autoincrement())` + `tenantId Int` + `waJid String` + @@unique([tenantId,waJid]) + @@index([tenantId]) + @@index([tenantId,waJid]) |

## 2. Backend titik kode (file → old → new)

### src/wa/baileys.js (jadi lapisan tipis di atas pool stub)
| Titik | Lama | Baru |
|---|---|---|
| `processIncomingMessage(msg)` | chatId = remoteJid; lookup `prisma.chat.findUnique({ where: { id: chatId } })` | `processIncomingMessage(tenantId, msg)` — find-or-create by `tenantId_waJid` |
| `upsertChat(chat)` | create `{ id: chatId, ... }` | find-or-create `[tenantId, waJid]` (dipasang di pool per-tenant saat fase 2) |
| `shouldFlowGateway(chatId,...)` | `chatId.endsWith('@g.us')` guard | pakai waJid — unchanged semantics, arg jadi chat row |
| grup @g.us jalur terpisah | id-based | waJid-based (`chat.waJid.endsWith('@g.us')`) |
| `sendMessage(chatId, text)` | global sock | pool `sendMessageForTenant(tenantId, waJid, text)` |
| `sendMedia(...)` | global sock | pool `sendMediaForTenant(tenantId, waJid, ...)` |
| `syncContactFromChat(chatId)` | contact by chatId string | contact by `chatId Int` + tenantId |
| `messages.update` status | `findFirst({ where: { waMessageId } })` | `findFirst({ where: { tenantId, waMessageId } })` |
| `chats.upsert`/`contacts.upsert`/`chats.update`/`phoneNumberShare` | `updateMany({ where: { id: contact.id } })` | `updateMany({ where: { tenantId, waJid } })` |
| `getMessage` callback | findFirst by waMessageId | findFirst by waMessageId (per-socket = per-tenant di fase 2) |

### src/socket/queue.js
| Titik | Lama | Baru |
|---|---|---|
| `queueWhere()` | global; `NOT: { id: { endsWith: '@g.us' } }` | `queueWhere(tenantId)`; `NOT: { waJid: { endsWith: '@g.us' } }` |
| `getQueueCount()` / `emitQueueUpdate()` | broadcast.emit global | `(tenantId)`; `broadcast.emitToTenant(tenantId,'queue_update')` |

### src/socket/broadcast.js
| Titik | Lama | Baru |
|---|---|---|
| `emit(event,data)` | io.emit (global) | tetap ada (hanya utk event non-tenant; tenant events WAJIB emitToTenant) |
| — | — | + `emitToTenant(tenantId, event, data)` → io.to(`tenant:<id>`) |

### src/socket/presence.js
| Titik | Lama | Baru |
|---|---|---|
| `connections Map<userId,Set>` | global | `tenantConnections Map<tenantId,Map<userId,Set>>` |
| `addConnection(userId, socketId)` | — | `addConnection(user, socketId)` (user = JWT payload; super_admin → skip) |
| `getOnlineUserIds()` | global | `getOnlineUserIds(tenantId)` |
| `isOnline(userId)` | — | `isOnline(tenantId, userId)` |
| `broadcastPresence()` | global emit | per tenant room |

### src/socket/handler.js
| Titik | Lama | Baru |
|---|---|---|
| handshake auth | presence.addConnection(userId) | resolve tenantId dari JWT; super_admin hanya join kalau auth.tenant (impersonasi); join `tenant:<id>` + presence per tenant |
| `assign_chat` | broadcast.emit | `broadcast.emitToTenant(tenantId, 'chat_update', ...)` |

### src/push.js
| Titik | Lama | Baru |
|---|---|---|
| `sendToActiveRole(role)` | all tenants | + `tenantId` param → `sendToTenantActive` style (query tenantId) |

### src/services/*
| File | Titik | Baru |
|---|---|---|
| autoReply.js | getConfig() singleton id=1 | getConfig(tenantId) — @@unique([tenantId]), cache per-tenant Map |
| autoReply.js | sendAutoText(chat,...) `wa.sendMessage(chat.id,...)` | `wa.sendMessageForTenant(chat.tenantId, chat.waJid, ...)` |
| autoReply.js | chat.updateMany({ where: { id } }) | + tenantId |
| menuGateway.js | getConfig() id=1 | getConfig(tenantId) + options |
| menuGateway.js | sendAutoMessage(chatId,...) | ambil chat row → kirim via pool by tenantId |
| menuGateway.js | handleChoice/startFlow/releaseAwaiting/countWaiting/listWaiting | semua prisma.chat + tenantId (param tenantId) |
| csat.js | getConfig() id=1 | getConfig(tenantId) |
| csat.js | createSurveyAfterResolve(chat,...) | tenantId dari chat; survey + tenantId; send via pool |
| csat.js | consumePendingRating/maybeHandleCsatReply | + tenantId filter |
| blast.js | runBlast: wa.getSocket() | blast.tenantId → pool getSocketForTenant; log.chatId Int |
| blast.js | broadcast.emit blast_progress/complete/error | emitToTenant(blast.tenantId, ...) |
| groups.js | semua prisma.chat by id JID | tenantId param + waJid-based; logAction + tenantId |
| groups.js | wa.getSocket()/getStatus() | per-tenant pool (tenantId dari user JWT) |
| receipts.js | markIncomingRead(chatId) | markIncomingRead(tenantId, chatId) — chat Int id |
| v0100Scheduler.js | scheduled send wa.sendMessage(sm.chatId) | join chat → tenantId → pool; per-tenant query |
| gdriveBackup.js | BackupConfig singleton id=1 | per-tenant config (admin tenant) |
| appConfig.js | AppConfig singleton id=1 | getConfig(tenantId) |
| historyImport.js | processChat: chat by id JID | tenantId param; find-or-create `[tenantId, waJid]`; dedupKey(tenantId,...) |
| cekatConverter.js | chatId JID string payload | payload chatId = waJid (string) — engine yang translate ke Int |

### src/routes/* (23 file — semua requireTenant + filter tenantId)
| File | Poin utama |
|---|---|
| chats.js | semua `findUnique({ where: { id: chatId } })` → `findFirst({ where: { id, tenantId } })`; params `:id` Int; message create + tenantId; reply/media via pool `sendMessageForTenant(req.tenantId, chat.waJid, ...)`; queue/take-next scope tenant; emitToTenant; list `NOT: { waJid: { endsWith '@g.us' } }`; push url `/?chat=<Int>` |
| contacts.js | by-chat/:chatId Int; find-or-create chat by phone JID `[tenantId, waJid]`; contactToJson bawa waJid |
| groups.js | service groups(user) + tenantId dari JWT; group JID lookup by [tenantId, waJid] |
| templates.js | unique [tenantId,name]/[tenantId,keyword]; create + tenantId |
| tags.js | findUnique name → findFirst tenantId+name; create + tenantId; chat_update emitToTenant |
| tanganKanan.js | folders/files + tenantId; seed system folder per tenant; download flexible-auth resolve tenant |
| blast.js | preview/create scope tenant; blast.tenantId; logs chatId Int |
| analytics.js | semua query + tenantId; raw query tenantId literal |
| announcements.js | + tenantId; emitToTenant; push per tenant |
| csat.js | config per tenant; stats/list + tenantId join |
| autoreply.js | getConfig(tenantId); PUT upsert per tenant |
| menuGateway.js | config per tenant; autoReplyConfig per tenant sync |
| appConfig.js | upsert by tenantId unique |
| appearance.js | config per tenant; /theme.css + /manifest PUBLIC → tenant ?tenant= optional fallback default |
| history.js | export scope tenant (super_admin wajib ?tenant=); import tenant req.user; emitToTenant |
| cekatImport.js | engine per tenant; linkImportedContactsToTag scope tenant |
| media.js | flexible auth + tenant resolve; message findFirst tenantId |
| push.js | subscribe/unsubscribe per user (tenant via user); online per tenant |
| scheduled.js | semua + tenantId; kirim via pool (tenantId dari chat) |
| users.js | semua query + tenantId; create user selalu tenant admin; transfer lintas tenant 403 |
| purge.js | scope tenant; PurgeLog + tenantId |
| gdrive.js | config per tenant; link/log per user; generateBackupCsv scope tenant |
| wa.js | status per tenant → pool.getStatusForTenant; disabled → { connected:false, disabled:true } |
| auth.js (me) | me + tenantId; login: suspended tenant → 403; super_admin → tenants:[...] |

### Frontend
| Titik | Lama | Baru |
|---|---|---|
| query param `?chat=` | JID string | Int chat id (encode/decode tidak berubah — string "12") |
| localStorage `token`,`user` | — | sama; user.role bisa super_admin; + tenants list (login SA) |
| socket payload `chatId` | JID string | Int id |
| router guard | meta.admin only | + meta.superadmin; super_admin dilarang `/` tanpa impersonasi → redirect /superadmin |
| Login redirect | router.push('/') | super_admin → '/superadmin' |
| SuperAdmin.vue | — | halaman BARU minimal (daftar tenant, + Tenant, + Admin, suspend/activate, stats) |

### Boot/seed (server.js)
| Titik | Lama | Baru |
|---|---|---|
| seedSystemFolders | global | dihapus dari boot — masuk `tenantSeed.seedTenantDefaults(tenantId)` |
| seedAutoReplyConfig/Appearance/Csat id=1 | global | dihapus dari boot — per-tenant via seedTenantDefaults |
| BackupConfig/GDrive scheduler | global | per-tenant scheduler skip fase 1 (config per tenant; enabled=false default) |
| Baileys bootstrap | selalu connect | `config.waDisabled` → skip total + log "WA disabled"; pool stub connectAllTenants no-op |
| super_admin | — | auto-create dari env SUPERADMIN_USERNAME/PASSWORD kalau belum ada; TANPA default tenant/admin |