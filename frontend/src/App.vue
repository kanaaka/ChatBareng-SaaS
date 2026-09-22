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
import ToastStack from './components/ToastStack.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import { watchSystemTheme } from './utils/theme'
import { initPushInAppListener } from './utils/pushInapp'
import { syncThemeColorMeta } from './utils/themeColor'
import { loadAndApplyTenantTheme, clearTenantTheme } from './utils/tenantTheme'
import axios from 'axios'

const API = import.meta.env.VITE_API_URL || ''

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
    auth.fetchMe().then(() => {
      // v3.1 — tema aksen tenant di-apply RUNTIME setelah sesi valid (auth GET
      // /api/appearance resolve tenant dari JWT; tenantId tidak pernah bocor).
      // super_admin tanpa tenant → dilewati (netral platform).
      loadAndApplyTenantTheme()
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
  }
})
</script>
