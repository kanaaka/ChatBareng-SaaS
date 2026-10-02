// v0.5.0 — Presence store: subscribe event `presence_update` dari socket,
// simpan Set onlineUserIds, expose isOnline(id). Dipakai transfer dialog +
// indikator titik hijau. Socket store di-init sebelum store ini dipakai.
import { defineStore } from 'pinia'
import { useSocketStore } from './socket'

export const usePresenceStore = defineStore('presence', {
  state: () => ({
    onlineUserIds: [],
    _subscribed: false,
  }),
  getters: {
    onlineSet: (state) => new Set(state.onlineUserIds),
  },
  actions: {
    isOnline(id) {
      return this.onlineSet.has(Number(id))
    },
    // Pasang listener sekali per session (idempotent)
    subscribe() {
      if (this._subscribed) return
      const socketStore = useSocketStore()
      socketStore.on('presence_update', (data) => {
        if (data && Array.isArray(data.onlineUserIds)) {
          this.onlineUserIds = data.onlineUserIds
        }
      })
      this._subscribed = true
    },
    // Sinkron awal (opsional, kalau socket belum kirim event)
    async fetchInitial() {
      try {
        const { default: axios } = await import('axios')
        const API = import.meta.env.VITE_API_URL || ''
        const res = await axios.get(`${API}/api/users/online`)
        if (Array.isArray(res.data.onlineUserIds)) {
          this.onlineUserIds = res.data.onlineUserIds
        }
      } catch (e) {
        console.error('Fetch online users error:', e)
      }
    },
  },
})