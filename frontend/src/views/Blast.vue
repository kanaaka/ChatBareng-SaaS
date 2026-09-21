<template>
  <!--
    v0.2.0 Blast — satu halaman 2 tab: Kirim & Riwayat (spec §2).
    - Kirim = BlastComposer.vue (existing, dipakai apa adanya, header lama disembunyikan via CSS? TIDAK —
      BlastComposer tetap utuh; kita bungkus dengan slot-less embed dan tab bar di atas).
    - Riwayat = BlastHistory.vue (existing).
    - Deep-link lama: /blast/history → /blast?tab=riwayat (router redirect).
    BlastProgress tetap route sendiri (/blast/progress/:id) — halaman penuh.
  -->
  <PageShell title="Blast">
    <!-- Desktop header (mobile: PageShell topbar + homerow, konsisten v0.2.2) -->
    <header class="hidden md:flex m3-topbar px-4 py-3 items-center justify-between">
      <div class="flex items-center gap-3">
        <router-link to="/" class="text-sm hover:underline">← Dashboard</router-link>
        <h1 class="text-lg font-semibold">Blast</h1>
      </div>
      <div class="flex items-center gap-4">
        <router-link to="/contacts" class="text-sm hover:underline">Kontak</router-link>
        <AnnouncementBell />
        <router-link to="/settings" class="text-sm hover:underline">{{ auth.user?.username }}</router-link>
        <button @click="handleLogout" class="text-sm hover:underline">Logout</button>
      </div>
    </header>

    <!-- Tab bar (Kirim | Riwayat) — dua viewport; sticky di bawah topbar PageShell -->
    <div class="sticky top-[52px] md:top-0 z-20 bg-white border-b border-gray-200 px-4 pt-2 pb-0">
      <div class="max-w-4xl mx-auto flex gap-1">
        <button
          v-for="t in tabs"
          :key="t.id"
          @click="activeTab = t.id"
          :class="['px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
                  activeTab === t.id ? 'text-wa-green border-wa-green' : 'text-gray-500 border-transparent hover:text-gray-700']"
        >
          {{ t.label }}
        </button>
      </div>
    </div>

    <!-- Konten tab -->
    <div class="max-w-4xl mx-auto w-full min-w-0">
      <KeepAlive>
        <BlastComposer v-if="activeTab === 'kirim'" embedded />
        <BlastHistory v-else-if="activeTab === 'riwayat'" embedded />
      </KeepAlive>
    </div>

  </PageShell>
</template>

<script setup>
import { ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import PageShell from '../components/PageShell.vue'
import AnnouncementBell from '../components/AnnouncementBell.vue'
import BlastComposer from './BlastComposer.vue'
import BlastHistory from './BlastHistory.vue'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const tabs = [
  { id: 'kirim', label: '📣 Kirim' },
  { id: 'riwayat', label: '📋 Riwayat' },
]

const activeTab = ref(route.query.tab === 'riwayat' ? 'riwayat' : 'kirim')

// Sync tab ke query string (deep-link /blast?tab=riwayat)
watch(activeTab, (tab) => {
  if (route.query.tab !== tab) {
    router.replace({ query: { ...route.query, tab: tab === 'kirim' ? undefined : tab } })
  }
})

function handleLogout() {
  auth.logout()
  window.location.href = '/login'
}
</script>