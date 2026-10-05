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

// ═══ v4.6.4 — Client log capture (spec D3): error frontend → POST /api/client-log ═══
// WAJIB ter-autentikasi (JWT — tenant & username diambil server DARI TOKEN, bukan
// body). Vue errorHandler + window error/unhandledrejection (bubbles-only agar
// tidak dobel dgn errorHandler). Fire-and-forget: server balas 204 tanpa detail DB;
// rate limit 20/menit/user + dedup 10s di server — pengiriman murah & aman.
const __clientLogApi = (import.meta.env.VITE_API_URL || '') + '/api/client-log'
function __sendClientLog(message, stack, route) {
  try {
    const tok = localStorage.getItem('token')
    if (!tok) return // tanpa login → tidak bisa lapor (endpoint wajib JWT)
    const body = {
      message: String(message || '').slice(0, 500),
      stack: stack ? String(stack).slice(0, 2000) : undefined,
      module: 'frontend',
      route: route || (window.location && window.location.pathname) || undefined,
    }
    fetch(__clientLogApi, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => {}) // fire-and-forget — kegagalan lapor tidak boleh berisik
  } catch { /* best-effort total */ }
}
app.config.errorHandler = (err, _instance, info) => {
  __sendClientLog(`[Vue] ${err?.message || err} (${info})`, err?.stack)
  console.error(err) // perilaku konsol lama tetap
}
window.addEventListener('error', (ev) => {
  if (!ev) return
  // error resource (img/script load fail) tanpa message jelas → tetap lapor ringkas
  const msg = ev.message || `Resource error: ${ev.filename || 'unknown'}`
  __sendClientLog(msg, ev.error?.stack)
})
window.addEventListener('unhandledrejection', (ev) => {
  const r = ev?.reason
  __sendClientLog(`Unhandled promise: ${r?.message || String(r)}`, r?.stack)
})

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