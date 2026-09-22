<template>
  <router-view />
  <ToastStack />
  <ConfirmDialog />
</template>

<script setup>
import { onMounted, onUnmounted } from 'vue'
import { useAuthStore } from './stores/auth'
import { useSocketStore } from './stores/socket'
import { useAnnouncementsStore } from './stores/announcements'
import { useToastStore } from './stores/toast'
import ToastStack from './components/ToastStack.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import { watchSystemTheme } from './utils/theme'
import { initPushInAppListener } from './utils/pushInapp'
import { syncThemeColorMeta } from './utils/themeColor'
import { loadAndApplyTenantTheme, clearTenantTheme } from './utils/tenantTheme'
import { loadBrandingAndPlan, clearBranding } from './utils/branding' // v3.4
import router from './router'
import axios from 'axios'

const API = import.meta.env.VITE_API_URL || ''

// v3.4 — Axios interceptor global: 403 feature gate ("tidak tersedia di paket Anda")
// → toast pesan backend apa adanya (JANGAN swallow, spec §8) + redirect '/' bila
// sedang di halaman yang di-gate. Pesan lain tidak diutak-atik.
axios.interceptors.response.use(
  (res) => res,
  (err) => {
    const status = err.response?.status
    const msg = err.response?.data?.error
    if (status === 403 && typeof msg === 'string' && msg.includes('tidak tersedia di paket Anda')) {
      try {
        const toast = useToastStore()
        toast.show({ icon: '🔒', title: 'Fitur terkunci', message: msg, timeout: 6000 })
      } catch {}
      const gated = ['/blast', '/admin/analytics', '/admin/menu-gateway', '/admin/csat', '/admin/backup', '/admin/history', '/announcements']
      const path = window.location.pathname
      if (gated.some((g) => path.startsWith(g))) router.push('/')
    }
    return Promise.reject(err)
  }
)

// v0.9.0 — live listener: mode System mengikuti prefers-color-scheme real-time
const stopThemeWatch = watchSystemTheme()
onUnmounted(() => stopThemeWatch())
// v0.12.7 — push saat app visible → in-app toast (semua kind; handler global SW message)
const stopPushInApp = initPushInAppListener()
onUnmounted(() => stopPushInApp())
// v0.12.7 — meta theme-color ikut accentSeed live (status bar Android saat app jalan;
// manifest dinamis di-handle server, meta runtime di sini, tanpa reload)
syncThemeColorMeta()

onMounted(() => {
  const auth = useAuthStore()
  if (auth.token) {
    axios.defaults.headers.common['Authorization'] = `Bearer ${auth.token}`
    auth.fetchMe().then(async () => {
      // v3.1 — tema aksen tenant di-apply RUNTIME setelah sesi valid (auth GET
      // /api/appearance resolve tenant dari JWT; tenantId tidak pernah bocor).
      // super_admin tanpa tenant → dilewati (netral platform).
      loadAndApplyTenantTheme()
      // v3.4 — branding (brandName + logo) + plan.features utk menu gating
      await loadBrandingAndPlan()
      const socket = useSocketStore()
      socket.init(auth.token)
      const announcements = useAnnouncementsStore()
      announcements.initSockets()
      announcements.fetchAll()
    })
  } else {
    // v3.1 — tanpa sesi: pastikan tidak ada style tema tenant nyangkut (logout di
    // tab lain / sesi kadaluarsa) → permukaan kembali netral.
    clearTenantTheme()
    clearBranding()
  }
})
</script>
