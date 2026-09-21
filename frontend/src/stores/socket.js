import { defineStore } from 'pinia'
import axios from 'axios'
import io from 'socket.io-client'

const API = import.meta.env.VITE_API_URL || ''

export const useSocketStore = defineStore('socket', {
  state: () => ({
    socket: null,
    connected: false,
    onReconnectCb: null, // v0.12.8
  }),
  actions: {
    init(token) {
      if (this.socket) return
      this.socket = io({
        auth: { token },
      })
      this.socket.on('connect', () => {
        this.connected = true
        // v0.12.8 — notifikasi resume: socket nyambung (lagi) setelah app
        // dibekukan Android / reconnect → listener boleh refetch state stale
        try { this.onReconnectCb?.() } catch (e) { /* aman */ }
      })
      this.socket.on('disconnect', () => { this.connected = false })
    },
    // v0.12.8 — daftarkan callback yang dipanggil setiap event 'connect'
    // (termasuk reconnect setelah background). null = clear.
    onReconnect(cb) { this.onReconnectCb = cb },
    joinChat(chatId) {
      this.socket?.emit('join_chat', chatId)
    },
    leaveChat(chatId) {
      this.socket?.emit('leave_chat', chatId)
    },
    emitTyping(chatId, userId, username) {
      this.socket?.emit('typing', { chatId, userId, username })
    },
    emitStopTyping(chatId, userId) {
      this.socket?.emit('stop_typing', { chatId, userId })
    },
    on(event, handler) {
      this.socket?.on(event, handler)
    },
    off(event, handler) {
      this.socket?.off(event, handler)
    },
  },
})