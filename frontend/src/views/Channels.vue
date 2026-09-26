<template>
  <!--
    v4.1.0 — Channels (WA Channel archive, read-only) — spec §5.1.
    PageShell "Channel" — list channel → klik → detail postingan read-only di dalam
    ChannelListPanel. ADMIN-ONLY (D5): guard halaman level (redirect bila !isAdmin,
    pola halaman lain). READ-ONLY TOTAL: TANPA kirim/edit/hapus, TANPA v-html.
  -->
  <PageShell title="Channel">
    <!-- Desktop header (konsisten Contacts.vue/Groups.vue) -->
    <header class="hidden md:flex m3-topbar px-4 py-3 items-center justify-between">
      <div class="flex items-center gap-3">
        <router-link to="/" class="text-sm hover:underline m3-topbar__link">← Dashboard</router-link>
        <h1 class="text-lg font-semibold">Channel</h1>
      </div>
      <div class="flex items-center gap-4">
        <router-link v-if="auth.isAdmin" to="/admin" class="text-sm hover:underline m3-topbar__link">Admin Panel</router-link>
        <router-link to="/settings" class="text-sm hover:underline m3-topbar__link">{{ auth.user?.username }}</router-link>
        <button @click="handleLogout" class="text-sm hover:underline">Logout</button>
      </div>
    </header>

    <div class="max-w-4xl mx-auto w-full p-6">
      <!-- Admin-only (D5): CS/relay → kartu ramah (route guard juga redirect) -->
      <div v-if="!auth.isAdmin" class="bg-white rounded-lg shadow-sm p-8 text-center">
        <div class="text-3xl mb-2">🔒</div>
        <p class="text-sm text-gray-500">Halaman Channel hanya untuk admin.</p>
      </div>
      <ChannelListPanel v-else />
    </div>
  </PageShell>
</template>

<script setup>
// v4.1.0 — Channels halaman (desktop + mobile sama-sama memakai panel read-only).
// Mobile: halaman ini tetap bisa dibuka, tapi jalur utama mobile = tab "Channel"
// di Kontak (D4b) — persis pola Grup.
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import PageShell from '../components/PageShell.vue'
import ChannelListPanel from '../components/ChannelListPanel.vue'

const auth = useAuthStore()
const router = useRouter()

// Guard admin di halaman level (pola halaman lain): non-admin → dashboard
onMounted(() => {
  if (!auth.isAdmin) router.replace('/')
})

function handleLogout() {
  auth.logout()
  window.location.href = '/login'
}
</script>