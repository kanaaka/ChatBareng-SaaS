<template>
  <PageShell title="Purge" back-to="/admin">
    <header class="hidden md:flex m3-topbar px-4 py-3 items-center justify-between">
      <div class="flex items-center gap-3">
        <h1 class="text-lg font-semibold">Purge</h1>
      </div>
      <div class="flex items-center gap-4">
        <button @click="handleLogout" class="text-sm hover:underline">Logout</button>
      </div>
    </header>

    <div class="max-w-4xl mx-auto w-full p-6 space-y-4">
      <!-- Purge form -->
      <div class="bg-white rounded-lg shadow-sm p-6">
        <h2 class="text-lg font-semibold mb-4">Purge Messages</h2>
        <form @submit.prevent="purge" class="space-y-3">
          <div>
            <label class="block text-sm font-medium mb-1">Mode</label>
            <select v-model="purgeForm.mode" class="w-full sm:w-auto px-3 py-2 border border-gray-300 rounded-lg text-sm">
              <option value="soft">Soft (mark as purged, keep in DB)</option>
              <option value="hard">Hard (delete from DB + media files)</option>
            </select>
          </div>
          <div>
            <label class="block text-sm font-medium mb-1">Reason (optional)</label>
            <!-- v0.9.0-r2 (audit fix #1): M3TextField floating label -->
            <M3TextField v-model="purgeForm.reason" label="Alasan purge" type="text" />
          </div>
          <button type="submit" class="m3-btn m3-btn--filled !min-h-[44px] !px-5 text-sm" :style="{ background: 'var(--md-sys-color-error)', color: 'var(--md-sys-color-on-error)' }">
            Purge Messages
          </button>
          <div v-if="purgeResult" class="mt-3 p-3 bg-gray-50 rounded-lg text-sm">
            {{ purgeResult }}
          </div>
        </form>
      </div>

      <!-- Purge log -->
      <div class="bg-white rounded-lg shadow-sm p-6">
        <h2 class="text-lg font-semibold mb-4">Purge History</h2>
        <div v-if="purgeLogs.length === 0" class="text-sm text-gray-400">No purges yet</div>
        <!-- v0.3.0 — mobile: kartu; desktop: tabel (internal scroll) -->
        <div class="md:hidden space-y-2">
          <div v-for="log in purgeLogs" :key="log.id" class="border border-gray-100 rounded-lg p-3">
            <div class="flex items-center justify-between gap-2">
              <span class="text-sm font-medium">{{ log.purgedBy?.username || '-' }}</span>
              <span class="text-xs text-gray-400">{{ new Date(log.purgeDate).toLocaleString() }}</span>
            </div>
            <div class="text-xs text-gray-500 mt-1">{{ log.chatCount }} chat · {{ log.messageCount }} pesan</div>
            <div v-if="log.reason" class="text-xs text-gray-500 truncate">Alasan: {{ log.reason }}</div>
          </div>
        </div>
        <div class="hidden md:block overflow-x-auto">
          <table class="w-full min-w-[520px]">
            <thead class="border-b border-gray-200">
              <tr>
                <th class="text-left text-xs font-medium text-gray-500 px-2 py-2">Date</th>
                <th class="text-left text-xs font-medium text-gray-500 px-2 py-2">By</th>
                <th class="text-left text-xs font-medium text-gray-500 px-2 py-2">Chats</th>
                <th class="text-left text-xs font-medium text-gray-500 px-2 py-2">Messages</th>
                <th class="text-left text-xs font-medium text-gray-500 px-2 py-2">Reason</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100">
              <tr v-for="log in purgeLogs" :key="log.id">
                <td class="text-sm px-2 py-2">{{ new Date(log.purgeDate).toLocaleString() }}</td>
                <td class="text-sm px-2 py-2">{{ log.purgedBy?.username }}</td>
                <td class="text-sm px-2 py-2">{{ log.chatCount }}</td>
                <td class="text-sm px-2 py-2">{{ log.messageCount }}</td>
                <td class="text-sm px-2 py-2 text-gray-500">{{ log.reason || '-' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </PageShell>
</template>

<script setup>
import axios from 'axios'
import { ref, onMounted } from 'vue'
import { useAuthStore } from '../stores/auth'
import { useConfirm } from '../utils/confirm'
import PageShell from '../components/PageShell.vue'
import M3TextField from '../components/M3TextField.vue'

const API = import.meta.env.VITE_API_URL || ''
const auth = useAuthStore()
const { confirmAction } = useConfirm()

// Purge (dipindah dari Admin.vue v0.1.x — logika tidak berubah)
const purgeForm = ref({ mode: 'soft', reason: '' })
const purgeResult = ref('')
const purgeLogs = ref([])

async function purge() {
  // v0.9.0 — confirm() native → M3 dialog; handler purge TIDAK berubah
  const ok = await confirmAction({
    title: 'Purge messages?',
    message: `Purge messages with mode: ${purgeForm.value.mode}?`,
    confirmText: 'Purge',
    danger: true,
  })
  if (!ok) return
  try {
    const res = await axios.post(`${API}/api/purge`, {
      mode: purgeForm.value.mode,
      reason: purgeForm.value.reason,
    })
    purgeResult.value = `Purged ${res.data.messageCount} messages from ${res.data.chatCount} chats.`
    await fetchPurgeLogs()
  } catch (e) {
    purgeResult.value = e.response?.data?.error || 'Purge failed'
  }
}

async function fetchPurgeLogs() {
  try {
    const res = await axios.get(`${API}/api/purge/log`)
    purgeLogs.value = res.data.logs
  } catch (e) { console.error(e) }
}

function handleLogout() {
  auth.logout()
  window.location.href = '/login'
}

onMounted(fetchPurgeLogs)
</script>
