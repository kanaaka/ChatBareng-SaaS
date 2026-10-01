const broadcast = require('./broadcast')
const presence = require('./presence')
const { verifyToken } = require('../auth')

function setupHandlers(io) {
  io.on('connection', (socket) => {
    // ─── Presence + room tenant ─────────────────────────────────────
    // Frontend mengirim JWT via handshake auth (`io({ auth: { token } })`).
    // v3.0: setiap koneksi user tenant join room `tenant:<tenantId>` — SEMUA
    // broadcast tenant-scoped hanya sampai ke room tsb. super_admin TIDAK masuk
    // room tenant kecuali impersonasi eksplisit (handshake auth.tenant).
    const handshakeToken =
      socket.handshake?.auth?.token ||
      (socket.handshake?.headers?.authorization || '').replace(/^Bearer\s+/i, '')
    const authUser = handshakeToken ? verifyToken(handshakeToken) : null

    let tenantId = null
    if (authUser && authUser.id) {
      if (authUser.role === 'super_admin') {
        // super_admin boleh observe satu tenant via handshake auth.tenant (impersonasi)
        const t = parseInt(socket.handshake?.auth?.tenant, 10)
        if (Number.isFinite(t) && t > 0) tenantId = t
      } else if (Number.isFinite(Number(authUser.tenantId))) {
        tenantId = Number(authUser.tenantId)
      }

      if (tenantId != null) {
        socket.join(`tenant:${tenantId}`)
        presence.addConnection(authUser, socket.id)
        socket.on('disconnect', () => {
          presence.removeConnection(authUser, socket.id)
        })
        // Sinkron awal: kirim daftar online tenant ini ke socket yang baru connect
        socket.emit('presence_update', { onlineUserIds: presence.getOnlineUserIds(tenantId) })
      }
    }

    // Join a chat room to receive targeted events
    socket.on('join_chat', (chatId) => {
      socket.join(`chat:${chatId}`)
    })

    socket.on('leave_chat', (chatId) => {
      socket.leave(`chat:${chatId}`)
    })

    // ─── v0.14.0 — room per-user utk socket grup (PIC + admin) ──────────
    if (authUser && authUser.id) {
      socket.join(`user:${authUser.id}`)
      socket.on('disconnect', () => {
        // Socket.IO mengeluarkan socket dari semua room otomatis saat disconnect.
      })
    }

    // Typing indicators — scoped ke room chat (chatId sudah tenant-unique, Int)
    socket.on('typing', ({ chatId, userId, username }) => {
      broadcast.emitToRoom(`chat:${chatId}`, 'typing', { chatId, userId, username })
    })

    socket.on('stop_typing', ({ chatId, userId }) => {
      broadcast.emitToRoom(`chat:${chatId}`, 'stop_typing', { chatId, userId })
    })

    // Assign chat — broadcast ke room tenant pengirim
    socket.on('assign_chat', ({ chatId }) => {
      if (tenantId != null) {
        broadcast.emitToTenant(tenantId, 'chat_update', { chatId, assignedTo: true })
      }
    })
  })
}

module.exports = { setupHandlers }