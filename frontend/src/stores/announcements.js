import { defineStore } from 'pinia'
import axios from 'axios'
import { useSocketStore } from './socket'
import { useToastStore } from './toast'

const API = import.meta.env.VITE_API_URL || ''

export const useAnnouncementsStore = defineStore('announcements', {
  state: () => ({
    list: [],
    loading: false,
    initialized: false,
  }),
  getters: {
    unread: (state) => {
      return state.list
        .filter(a => !a.readByMe)
        .sort((a, b) => {
          if (a.pinned === b.pinned) return new Date(b.createdAt) - new Date(a.createdAt)
          return a.pinned ? -1 : 1
        })
    },
    unreadCount: (state) => {
      return state.list.filter(a => !a.readByMe).length
    },
  },
  actions: {
    async fetchAll() {
      this.loading = true
      try {
        const res = await axios.get(`${API}/api/announcements`)
        this.list = res.data.announcements || []
        this.initialized = true
      } catch (e) {
        console.error('Fetch announcements error:', e)
      } finally {
        this.loading = false
      }
    },

    async markRead(id) {
      const item = this.list.find(a => a.id === id)
      if (item && item.readByMe) return
      if (item) item.readByMe = true
      try {
        await axios.post(`${API}/api/announcements/${id}/read`)
      } catch (e) {
        console.error('Mark read error:', e)
        if (item) item.readByMe = false
      }
    },

    handleNew({ announcement }) {
      if (!announcement) return
      const exists = this.list.find(a => a.id === announcement.id)
      if (!exists) {
        this.list.push({ ...announcement, readByMe: false })
        const toast = useToastStore()
        toast.show({
          icon: '📢',
          title: 'Pengumuman baru',
          message: announcement.title,
          timeout: 6000,
          onClick: () => {
            window.dispatchEvent(new CustomEvent('open-announcements-bell'))
          },
        })
      }
    },

    handleUpdate({ announcement }) {
      if (!announcement) return
      const idx = this.list.findIndex(a => a.id === announcement.id)
      const wasRead = idx >= 0 ? this.list[idx].readByMe : false
      if (idx >= 0) {
        this.list[idx] = { ...this.list[idx], ...announcement, readByMe: wasRead }
      } else if (announcement.isActive && (!announcement.expiresAt || new Date(announcement.expiresAt) > new Date())) {
        this.list.push({ ...announcement, readByMe: false })
      }
    },

    handleDelete({ id }) {
      this.list = this.list.filter(a => a.id !== id)
    },

    initSockets() {
      const socket = useSocketStore()
      socket.on('announcement_new', this.handleNew)
      socket.on('announcement_update', this.handleUpdate)
      socket.on('announcement_delete', this.handleDelete)
    },
  },
})
