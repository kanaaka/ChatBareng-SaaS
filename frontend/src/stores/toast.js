import { defineStore } from 'pinia'

export const useToastStore = defineStore('toast', {
  state: () => ({
    items: [],
  }),
  actions: {
    show({ icon = '', title = '', message = '', timeout = 5000, onClick = null }) {
      const id = Date.now() + Math.random()
      const toast = { id, icon, title, message, onClick }
      this.items.push(toast)
      if (timeout) {
        setTimeout(() => this.dismiss(id), timeout)
      }
      return id
    },
    dismiss(id) {
      this.items = this.items.filter(t => t.id !== id)
    },
  },
})
