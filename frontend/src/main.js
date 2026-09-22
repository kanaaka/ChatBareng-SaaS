import { createApp } from 'vue'
import { createPinia } from 'pinia'
import router from './router'
import App from './App.vue'
import './style.css'

// v3.4 — Impersonate boot shim: tab baru dibuka oleh SuperAdmin (window.open) membawa
// token view-as di sessionStorage.__impersonate_boot. localStorage SHARED antar tab
// (akan menimpa sesi superadmin!) → di-promote SEBELUM auth store terbentuk, lalu
// flag dihapus. Tanpa shim, token view-as tidak pernah sampai ke store tab baru.
try {
  const boot = sessionStorage.getItem('__impersonate_boot')
  if (boot) {
    const { token, user } = JSON.parse(boot)
    if (token && user) {
      localStorage.setItem('token', token)
      localStorage.setItem('user', JSON.stringify(user))
      localStorage.removeItem('tenants')
    }
    sessionStorage.removeItem('__impersonate_boot')
  }
} catch {}

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')

// v0.4.0 — PWA: capture beforeinstallprompt + register service worker (production only)
import { usePwaStore } from './stores/pwa'
const pwa = usePwaStore()
pwa.init()

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(e => {
      console.error('SW registration failed:', e)
    })
  })
}