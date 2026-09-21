// v0.4.0 — PWA install prompt state (beforeinstallprompt capture)
import { defineStore } from 'pinia'

export const usePwaStore = defineStore('pwa', {
  state: () => ({
    deferredPrompt: null,   // beforeinstallprompt event, null kalau tidak tersedia
    installed: false,        // sudah ter-install sebagai standalone?
    isIOS: false,
  }),
  getters: {
    canInstall: (state) => !!state.deferredPrompt,
  },
  actions: {
    init() {
      if (typeof window === 'undefined') return
      const ua = window.navigator.userAgent || ''
      const isIOSDevice = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && 'ontouchend' in document)
      const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches
        || window.navigator.standalone === true
      this.isIOS = isIOSDevice
      this.installed = !!standalone

      window.addEventListener('beforeinstallprompt', (e) => {
        // Cegah prompt mini-infobar default; simpan untuk tombol "Install Aplikasi"
        e.preventDefault()
        this.deferredPrompt = e
      })

      window.addEventListener('appinstalled', () => {
        this.deferredPrompt = null
        this.installed = true
      })
    },
    async promptInstall() {
      if (!this.deferredPrompt) return 'unavailable'
      this.deferredPrompt.prompt()
      const { outcome } = await this.deferredPrompt.userChoice
      if (outcome === 'accepted') {
        this.installed = true
      }
      this.deferredPrompt = null
      return outcome // 'accepted' | 'dismissed'
    },
  },
})