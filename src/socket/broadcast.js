let io = null

function init(socketIO) {
  io = socketIO
}

// v3.0 — JANGAN dipakai untuk event berisi data tenant (chat_update, new_message,
// queue_update, dst) — semua broadcast data tenant WAJIB lewat emitToTenant.
function emit(event, data) {
  if (!io) return
  io.emit(event, data)
}

// v3.0 — SEMUA broadcast data tenant WAJIB lewat sini (room per tenant).
function emitToTenant(tenantId, event, data) {
  if (!io) return
  io.to(`tenant:${Number(tenantId)}`).emit(event, data)
}

function emitToRoom(room, event, data) {
  if (!io) return
  io.to(room).emit(event, data)
}

// Emit to all clients EXCEPT the one identified by socketId
function emitExceptSocket(socketId, event, data) {
  if (!io) return
  io.except(socketId).emit(event, data)
}

function getIO() {
  return io
}

module.exports = { init, emit, emitToTenant, emitToRoom, emitExceptSocket, getIO }