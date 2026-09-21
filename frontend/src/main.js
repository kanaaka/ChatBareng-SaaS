import { createApp } from 'vue'
import { createPinia } from 'pinia'
import router from './router'
import App from './App.vue'
import './style.css'

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