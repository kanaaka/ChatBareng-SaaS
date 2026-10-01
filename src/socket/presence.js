// v0.5.0 — Online status / presence tracking (in-memory, per-process).
// v3.0 — Presence PER TENANT: Map tenantId → Map<userId, Set<socketId>>.
// super_admin (tanpa tenant) tidak ikut presence tenant manapun.
//
// addConnection(user, socketId): user = { id, role, tenantId } dari JWT handshake.
// Broadcast presence_update { onlineUserIds } scoped ke room `tenant:<id>`.

const prisma = require('../prisma')
const broadcast = require('./broadcast')

// tenantId (number) → Map<userId (number), Set<socketId (string)>>
const tenantConnections = new Map()

function mapFor(tenantId) {
  let m = tenantConnections.get(Number(tenantId))
  if (!m) {
    m = new Map()
    tenantConnections.set(Number(tenantId), m)
  }
  return m
}

function getOnlineUserIds(tenantId) {
  const m = tenantConnections.get(Number(tenantId))
  if (!m) return []
  const ids = []
  for (const [userId, sockets] of m) {
    if (sockets.size > 0) ids.push(userId)
  }
  return ids.sort((a, b) => a - b)
}

// Back-compat: pemanggil lama tanpa argumen → gabungan semua tenant (dipakai
// hanya oleh admin route yang sudah di-scope; jangan dipakai di jalur baru).
function getOnlineUserIdsAll() {
  const ids = new Set()
  for (const m of tenantConnections.values()) {
    for (const [userId, sockets] of m) {
      if (sockets.size > 0) ids.add(userId)
    }
  }
  return Array.from(ids).sort((a, b) => a - b)
}

function isOnline(tenantId, userId) {
  const m = tenantConnections.get(Number(tenantId))
  if (!m) return false
  const sockets = m.get(Number(userId))
  return !!sockets && sockets.size > 0
}

// Broadcast full list untuk satu tenant (jumlah user kecil — simpel)
function broadcastPresence(tenantId) {
  try {
    broadcast.emitToTenant(tenantId, 'presence_update', { onlineUserIds: getOnlineUserIds(tenantId) })
  } catch (e) {
    console.error('[Presence] broadcast error:', e.message)
  }
}

// Fire-and-forget: catat waktu user terakhir terlihat (dipanggil saat OFFLINE)
function touchLastSeen(userId) {
  prisma.user
    .update({ where: { id: userId }, data: { lastSeenAt: new Date() } })
    .catch((e) => console.error('[Presence] lastSeenAt update error:', e.message))
}

function addConnection(user, socketId) {
  if (!user || !Number.isFinite(Number(user.id))) return
  if (user.role === 'super_admin' || !Number.isFinite(Number(user.tenantId))) return // super_admin: no tenant presence
  const tid = Number(user.tenantId)
  const id = Number(user.id)
  const m = mapFor(tid)
  let sockets = m.get(id)
  if (!sockets) {
    sockets = new Set()
    m.set(id, sockets)
  }
  const wasOffline = sockets.size === 0
  sockets.add(socketId)
  if (wasOffline) broadcastPresence(tid)
}

function removeConnection(user, socketId) {
  if (!user || !Number.isFinite(Number(user.id))) return
  if (user.role === 'super_admin' || !Number.isFinite(Number(user.tenantId))) return
  const tid = Number(user.tenantId)
  const id = Number(user.id)
  const m = tenantConnections.get(tid)
  if (!m) return
  const sockets = m.get(id)
  if (!sockets) return
  sockets.delete(socketId)
  if (sockets.size === 0) {
    m.delete(id)
    touchLastSeen(id)
  }
  broadcastPresence(tid)
}

module.exports = {
  addConnection,
  removeConnection,
  isOnline,
  getOnlineUserIds,
  getOnlineUserIdsAll,
}