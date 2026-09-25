import { defineStore } from 'pinia'
import axios from 'axios'

const API = import.meta.env.VITE_API_URL || ''

export const useChatsStore = defineStore('chats', {
  state: () => ({
    chats: [],
    currentChat: null,
    currentMessages: [],
    loadingChats: false,
    loadingMessages: false,
    filter: 'mine', // v0.1.21 — default 'mine' (CS gak boleh 'all'/'unassigned'; admin UI bisa switch)
    search: '',
    queueCount: 0, // v0.1.21 — jumlah chat di antrean (open + unassigned)
    taking: false, // v0.1.21 — loading state tombol Take
    // v0.2.0 — shared chatlist filter params (tag/handler/date) supaya ChatListPane
    // dan Dashboard punya sumber refetch yang sama (paritas perilaku dgn v0.1.x
    // di mana semua refetch pakai buildFilterParams() lokal milik Dashboard)
    filterParams: {},
    unreadTotal: 0, // v0.2.0 — total unread di list aktif (badge homerow)
  }),
  actions: {
    async fetchChats(extraParams = {}) {
      this.loadingChats = true
      try {
        // v0.2.0 — jika caller tidak kasih params, pakai shared filterParams;
        // kalau kasih object kosong eksplisit, itu berarti tanpa filter (semua
        // caller existing selalu pass params).
        const params = { filter: this.filter, ...(Object.keys(extraParams).length ? extraParams : this.filterParams) }
        const res = await axios.get(`${API}/api/chats`, { params })
        this.chats = res.data.chats
        this.unreadTotal = this.chats.reduce((n, c) => n + (c.unreadCount || 0), 0)
      } catch (e) {
        console.error('Fetch chats error:', e)
      } finally {
        this.loadingChats = false
      }
    },
    async fetchChat(chatId) {
      this.loadingMessages = true
      try {
        const res = await axios.get(`${API}/api/chats/${chatId}`)
        this.currentChat = res.data.chat
        this.currentMessages = res.data.messages
        return res.data
      } catch (e) {
        console.error('Fetch chat error:', e)
        // v0.1.24 — clear stale chat on fetch failure supaya guard di selectChat
        // bisa deteksi "chat tidak bisa dibuka" dengan benar
        this.currentChat = null
        this.currentMessages = []
      } finally {
        this.loadingMessages = false
      }
    },
    // v3.9.14 — replyToMessageId opsional utk quote reply
    async sendReply(chatId, content, replyToMessageId = null) {
      const res = await axios.post(`${API}/api/chats/${chatId}/reply`, { content, ...(replyToMessageId ? { replyToMessageId } : {}) })
      // Dedup: only push if not already added by socket event
      const exists = this.currentMessages.some(m =>
        m.id === res.data.message.id ||
        (res.data.message.waMessageId && m.waMessageId === res.data.message.waMessageId)
      )
      if (!exists) {
        this.currentMessages.push(res.data.message)
      }
      return res.data
    },
    async assignChat(chatId, userId) {
      const res = await axios.post(`${API}/api/chats/${chatId}/assign`, 
        userId ? { user_id: userId } : {})
      return res.data
    },
    async releaseChat(chatId) {
      const res = await axios.post(`${API}/api/chats/${chatId}/release`)
      return res.data
    },
    // v0.1.21 — Queue discipline
    async fetchQueueCount() {
      try {
        const res = await axios.get(`${API}/api/chats/queue-count`)
        this.queueCount = res.data.count
      } catch (e) {
        console.error('Fetch queue count error:', e)
      }
    },
    async takeNext() {
      // Returns { chat } on success; throws on 404 antrean kosong / error
      this.taking = true
      try {
        const res = await axios.post(`${API}/api/chats/take-next`)
        return res.data
      } finally {
        this.taking = false
      }
    },
    async resolveChat(chatId) {
      const res = await axios.post(`${API}/api/chats/${chatId}/resolve`)
      return res.data
    },
    async fetchTags() {
      const res = await axios.get(`${API}/api/tags`)
      return res.data.tags
    },
    async createTag(name, color) {
      const res = await axios.post(`${API}/api/tags`, { name, color })
      return res.data.tag
    },
    async addTagToChat(chatId, tagId) {
      const res = await axios.post(`${API}/api/chats/${chatId}/tags`, { tagId })
      return res.data.tag
    },
    async removeTagFromChat(chatId, tagId) {
      const res = await axios.delete(`${API}/api/chats/${chatId}/tags/${tagId}`)
      return res.data
    },
    async deleteTag(tagId) {
      const res = await axios.delete(`${API}/api/tags/${tagId}`)
      return res.data
    },
    async markRead(chatId) {
      await axios.post(`${API}/api/chats/${chatId}/read`)
    },
    addIncomingMessage(data) {
      // Add to messages if in current chat
      if (this.currentChat && data.chatId === this.currentChat.id) {
        this.currentMessages.push(data.message)
      }
      // Update chat in list
      const chat = this.chats.find(c => c.id === data.chatId)
      if (chat) {
        chat.lastMessagePreview = data.message.content || '[Media]'
        chat.lastMessageAt = data.message.timestamp
        if (this.currentChat?.id !== data.chatId) {
          chat.unreadCount = (chat.unreadCount || 0) + 1
        }
      }
    },
    updateChat(data) {
      const chat = this.chats.find(c => c.id === data.chatId)
      if (chat) {
        if (data.unreadCount !== undefined) chat.unreadCount = data.unreadCount
        if (data.assignedTo !== undefined) {
          chat.assignedTo = data.assignedTo
          chat.assignedToId = data.assignedTo?.id || null
        }
        if (data.lastMessage !== undefined) chat.lastMessagePreview = data.lastMessage
        if (data.lastMessageAt !== undefined) chat.lastMessageAt = data.lastMessageAt
        if (data.status !== undefined) chat.status = data.status
        if (data.resolvedAt !== undefined) chat.resolvedAt = data.resolvedAt
        // Real-time tag updates in chat list
        if (data.tagAdded !== undefined) {
          if (!chat.tags) chat.tags = []
          const exists = chat.tags.some(ct => ct.tag.id === data.tagAdded.id)
          if (!exists) chat.tags.push({ tag: data.tagAdded })
        }
        if (data.tagRemoved !== undefined) {
          if (chat.tags) {
            chat.tags = chat.tags.filter(ct => ct.tag.id !== data.tagRemoved)
          }
        }
      }
      // v0.2.0 — recompute unread badge (chat_update bisa bawa unreadCount)
      if (data.unreadCount !== undefined || data.tagAdded !== undefined || data.tagRemoved !== undefined || data.status !== undefined) {
        this.unreadTotal = this.chats.reduce((n, c) => n + (c.unreadCount || 0), 0)
      }
    },
    // v0.1.22 — hapus chat dari list setelah purge (event chats_purged)
    removeChats(chatIds) {
      const ids = new Set(chatIds || [])
      this.chats = this.chats.filter(c => !ids.has(c.id))
      if (this.currentChat && ids.has(this.currentChat.id)) {
        this.currentChat = null
        this.currentMessages = []
      }
      this.unreadTotal = this.chats.reduce((n, c) => n + (c.unreadCount || 0), 0)
    },
    updateCurrentChat(data) {
      if (!this.currentChat) return
      if (data.status !== undefined) this.currentChat.status = data.status
      if (data.resolvedAt !== undefined) this.currentChat.resolvedAt = data.resolvedAt
      if (data.assignedTo !== undefined) this.currentChat.assignedTo = data.assignedTo
      if (data.unreadCount !== undefined) this.currentChat.unreadCount = data.unreadCount
    },
  },
})