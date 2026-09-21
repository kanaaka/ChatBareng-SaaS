<template>
  <div :class="embedded ? '' : 'min-h-screen'" class="bg-gray-100">
    <!-- Top bar (hidden ketika embedded di Blast tab page) -->
    <header v-if="!embedded" class="m3-topbar px-4 py-3 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <router-link to="/" class="text-sm hover:underline">← Dashboard</router-link>
        <h1 class="text-lg font-semibold">Blast History</h1>
      </div>
      <div class="flex items-center gap-4">
        <router-link to="/blast" class="text-sm hover:underline">New Blast</router-link>
        <router-link to="/settings" class="text-sm hover:underline">{{ auth.user?.username }}</router-link>
        <button @click="handleLogout" class="text-sm hover:underline">Logout</button>
      </div>
    </header>

    <div :class="embedded ? 'p-4 md:p-6' : 'max-w-6xl mx-auto p-6'">
      <!-- Blast List View -->
      <div v-if="!selectedBlast" class="bg-white rounded-lg shadow-sm overflow-hidden">
        <!-- v0.2.3 — mobile: kartu; desktop: tabel -->
        <div class="md:hidden divide-y divide-gray-100">
          <div v-if="loading" class="py-4 text-center text-gray-400 text-sm">Loading...</div>
          <div v-else-if="blasts.length === 0" class="p-8 text-center text-gray-400 text-sm">No blasts yet</div>
          <div v-for="b in blasts" :key="b.id" @click="viewBlast(b.id)" class="p-3 border-b border-gray-100 active:bg-gray-50 cursor-pointer">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <div class="text-sm font-medium truncate">{{ b.name || `Blast #${b.id}` }}</div>
                <div class="text-xs text-gray-500 truncate">{{ b.message }}</div>
                <div class="text-xs text-gray-400 mt-1">{{ formatDate(b.createdAt) }} · {{ b.createdByUser?.username || '-' }}</div>
              </div>
              <div class="text-right flex-shrink-0">
                <span :class="statusBadge(b.status)">{{ b.status }}</span>
                <div class="text-xs mt-1"><span class="text-green-600">{{ b.totalSent }}</span>/<span class="text-red-600">{{ b.totalFailed }}</span>/{{ b.totalRecipients }}</div>
              </div>
            </div>
          </div>
        </div>
        <div class="hidden md:block">
        <table class="w-full">
          <thead class="bg-gray-50 border-b border-gray-200">
            <tr>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Message</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Sent / Failed</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Created By</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-200">
            <tr v-if="loading" class="text-center text-gray-400">
              <td colspan="6" class="py-4">Loading...</td>
            </tr>
            <tr v-else-if="blasts.length === 0">
              <td colspan="6" class="py-8 text-center text-gray-400">No blasts yet</td>
            </tr>
            <tr v-for="b in blasts" :key="b.id" @click="viewBlast(b.id)" class="hover:bg-gray-50 cursor-pointer">
              <td class="px-4 py-3 text-sm">{{ b.name || `Blast #${b.id}` }}</td>
              <td class="px-4 py-3 text-sm text-gray-500 truncate max-w-xs">{{ b.message }}</td>
              <td class="px-4 py-3 text-sm">
                <span class="text-green-600">{{ b.totalSent }}</span> / <span class="text-red-600">{{ b.totalFailed }}</span>
                / {{ b.totalRecipients }}
              </td>
              <td class="px-4 py-3">
                <div class="flex items-center gap-2">
                  <span :class="statusBadge(b.status)">{{ b.status }}</span>
                  <button v-if="['running', 'paused'].includes(b.status)" @click.stop="router.push(`/blast/progress/${b.id}`)" class="text-xs text-indigo-600 hover:underline font-medium">View Progress</button>
                </div>
              </td>
              <td class="px-4 py-3 text-sm">{{ b.createdByUser?.username || '-' }}</td>
              <td class="px-4 py-3 text-sm text-gray-500">{{ formatDate(b.createdAt) }}</td>
            </tr>
          </tbody>
        </table>

        <!-- Pagination -->
        <div v-if="pagination.pages > 1" class="flex items-center justify-between px-4 py-3 border-t border-gray-200">
          <span class="text-sm text-gray-500">Page {{ pagination.page }} of {{ pagination.pages }}</span>
          <div class="flex gap-2">
            <button v-if="pagination.page > 1" @click="fetchBlasts(pagination.page - 1)" class="text-sm px-3 py-1 border border-gray-300 rounded-lg hover:bg-gray-50">← Prev</button>
            <button v-if="pagination.page < pagination.pages" @click="fetchBlasts(pagination.page + 1)" class="text-sm px-3 py-1 border border-gray-300 rounded-lg hover:bg-gray-50">Next →</button>
          </div>
        </div>
        </div>
      </div>

      <!-- Blast Detail View -->
      <div v-else>
        <button @click="selectedBlast = null" class="text-sm text-gray-600 hover:underline mb-4">← Back to list</button>

        <!-- Blast Info Card -->
        <div class="bg-white rounded-lg shadow-sm p-6 mb-4">
          <div class="flex items-start justify-between mb-4">
            <div>
              <h2 class="text-lg font-semibold">{{ selectedBlast.name || `Blast #${selectedBlast.id}` }}</h2>
              <p class="text-sm text-gray-500 mt-1">{{ formatDate(selectedBlast.createdAt) }} by {{ selectedBlast.createdByUser?.username }}</p>
            </div>
            <div class="flex gap-2">
              <!-- Owner or Admin controls -->
              <template v-if="auth.isAdmin || selectedBlast.createdBy === auth.user?.id">
                <button v-if="selectedBlast.status === 'running'" @click="pauseBlast" class="bg-yellow-500 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-yellow-600">Pause</button>
                <button v-if="selectedBlast.status === 'paused'" @click="resumeBlast" class="bg-blue-500 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-blue-600">Resume</button>
                <button v-if="['running', 'paused', 'pending'].includes(selectedBlast.status)" @click="cancelBlast" class="bg-red-600 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-red-700">Cancel</button>
                <button v-if="['running', 'paused'].includes(selectedBlast.status)" @click="goToProgress" class="bg-indigo-500 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-indigo-600">View Progress</button>
                <button @click="exportResults" class="bg-green-600 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-green-700">Export CSV</button>
                <button v-if="auth.isAdmin" @click="deleteBlast" class="bg-gray-500 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-gray-600">Delete</button>
              </template>
            </div>
          </div>

          <!-- Message -->
          <div class="bg-gray-50 rounded-lg p-3 text-sm whitespace-pre-wrap mb-4">{{ selectedBlast.message }}</div>

          <!-- Stats -->
          <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
            <div class="text-center">
              <div class="text-2xl font-bold text-gray-700">{{ selectedBlast.totalRecipients }}</div>
              <div class="text-xs text-gray-500">Recipients</div>
            </div>
            <div class="text-center">
              <div class="text-2xl font-bold text-green-600">{{ selectedBlast.totalSent }}</div>
              <div class="text-xs text-gray-500">Sent</div>
            </div>
            <div class="text-center">
              <div class="text-2xl font-bold text-red-600">{{ selectedBlast.totalFailed }}</div>
              <div class="text-xs text-gray-500">Failed</div>
            </div>
            <div class="text-center">
              <span :class="statusBadge(selectedBlast.status)">{{ selectedBlast.status }}</span>
            </div>
          </div>

          <!-- Progress Bar -->
          <div v-if="['running', 'paused', 'completed'].includes(selectedBlast.status)">
            <div class="flex justify-between text-xs text-gray-500 mb-1">
              <span>Progress</span>
              <span>{{ progressPercent }}%</span>
            </div>
            <div class="w-full bg-gray-200 rounded-full h-3 overflow-hidden">
              <div :class="['h-full transition-all duration-500', selectedBlast.status === 'completed' ? 'bg-green-500' : selectedBlast.status === 'paused' ? 'bg-yellow-500' : 'bg-blue-500']" :style="`width: ${progressPercent}%`"></div>
            </div>
            <div v-if="currentRecipient && selectedBlast.status === 'running'" class="mt-1 text-xs text-gray-500">
              Sending to: {{ currentRecipient }}
            </div>
          </div>
        </div>

        <!-- Logs Table -->
        <div class="bg-white rounded-lg shadow-sm overflow-hidden">
          <div class="px-4 py-3 border-b border-gray-200">
            <h3 class="text-sm font-semibold">Recipient Log</h3>
          </div>
          <div class="overflow-x-auto">
          <table class="w-full min-w-[640px]">
            <thead class="bg-gray-50 border-b border-gray-200">
              <tr>
                <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
                <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Phone / Chat ID</th>
                <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Error</th>
                <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Sent At</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-200">
              <tr v-for="log in logs" :key="log.id" class="hover:bg-gray-50">
                <td class="px-4 py-2 text-sm">{{ log.contactName || 'Pelanggan' }}</td>
                <td class="px-4 py-2 text-sm text-gray-500">{{ log.phoneNumber || log.chatId }}</td>
                <td class="px-4 py-2">
                  <span v-if="log.status === 'sent'" class="inline-flex items-center gap-1 text-xs text-green-600">✅ Sent</span>
                  <span v-else-if="log.status === 'failed'" class="inline-flex items-center gap-1 text-xs text-red-600">❌ Failed</span>
                  <span v-else class="inline-flex items-center gap-1 text-xs text-gray-400">⏳ Pending</span>
                </td>
                <td class="px-4 py-2 text-sm text-red-500 truncate max-w-xs">{{ log.error || '-' }}</td>
                <td class="px-4 py-2 text-sm text-gray-500">{{ log.sentAt ? formatDate(log.sentAt) : '-' }}</td>
              </tr>
            </tbody>
          </table>
          </div>

          <!-- Log Pagination -->
          <div v-if="logPagination.pages > 1" class="flex items-center justify-between px-4 py-3 border-t border-gray-200">
            <span class="text-sm text-gray-500">Page {{ logPagination.page }} of {{ logPagination.pages }}</span>
            <div class="flex gap-2">
              <button v-if="logPagination.page > 1" @click="fetchBlastDetail(selectedBlast.id, logPagination.page - 1)" class="text-sm px-3 py-1 border border-gray-300 rounded-lg hover:bg-gray-50">← Prev</button>
              <button v-if="logPagination.page < logPagination.pages" @click="fetchBlastDetail(selectedBlast.id, logPagination.page + 1)" class="text-sm px-3 py-1 border border-gray-300 rounded-lg hover:bg-gray-50">Next →</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { useSocketStore } from '../stores/socket'
import { useToastStore } from '../stores/toast'
import { useConfirm } from '../utils/confirm'
import axios from 'axios'

const API = import.meta.env.VITE_API_URL || ''
const router = useRouter()
const auth = useAuthStore()
const toast = useToastStore()
const { confirmAction } = useConfirm()
const socketStore = useSocketStore()

// v0.2.0 — embedded mode: dirender dalam tab Blast.vue (tanpa top bar sendiri)
defineProps({
  embedded: { type: Boolean, default: false },
})

const blasts = ref([])
const loading = ref(false)
const pagination = ref({ page: 1, limit: 20, total: 0, pages: 0 })
const selectedBlast = ref(null)
const logs = ref([])
const logPagination = ref({ page: 1, limit: 50, total: 0, pages: 0 })
const currentRecipient = ref('')

const progressPercent = computed(() => {
  if (!selectedBlast.value || selectedBlast.value.totalRecipients === 0) return 0
  const done = (selectedBlast.value.totalSent || 0) + (selectedBlast.value.totalFailed || 0)
  return Math.round((done / selectedBlast.value.totalRecipients) * 100)
})

function statusBadge(status) {
  const classes = {
    pending: 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700',
    running: 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700',
    paused: 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-700',
    completed: 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700',
    cancelled: 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700',
    failed: 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700',
  }
  return classes[status] || classes.pending
}

function formatDate(d) {
  if (!d) return '-'
  const date = new Date(d)
  return date.toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function handleLogout() {
  auth.logout()
  router.push('/login')
}

function goToProgress() {
  if (selectedBlast.value) {
    router.push(`/blast/progress/${selectedBlast.value.id}`)
  }
}

async function fetchBlasts(page = 1) {
  loading.value = true
  try {
    const res = await axios.get(`${API}/api/blast`, { params: { page, limit: 20 } })
    blasts.value = res.data.blasts
    pagination.value = res.data.pagination
  } catch (e) {
    console.error('Fetch blasts error:', e)
  } finally {
    loading.value = false
  }
}

async function viewBlast(id) {
  await fetchBlastDetail(id, 1)
}

async function fetchBlastDetail(id, page = 1) {
  try {
    const res = await axios.get(`${API}/api/blast/${id}`, { params: { page, limit: 50 } })
    selectedBlast.value = res.data.blast
    logs.value = res.data.logs
    logPagination.value = res.data.pagination
  } catch (e) {
    console.error('Fetch blast detail error:', e)
    toast.show({ icon: '⚠️', title: 'Gagal memuat detail', message: 'Failed to load blast detail' })
  }
}

async function pauseBlast() {
  try {
    await axios.post(`${API}/api/blast/${selectedBlast.value.id}/pause`)
    selectedBlast.value.status = 'paused'
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Gagal pause', message: e.response?.data?.error || e.message })
  }
}

async function resumeBlast() {
  try {
    await axios.post(`${API}/api/blast/${selectedBlast.value.id}/resume`)
    selectedBlast.value.status = 'running'
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Gagal resume', message: e.response?.data?.error || e.message })
  }
}

async function cancelBlast() {
  // v0.9.0 — confirm() native → M3 dialog; handler cancel TIDAK berubah
  const okCancel = await confirmAction({
    title: 'Cancel blast ini?',
    message: 'Cancel this blast? Remaining recipients will not be sent.',
    confirmText: 'Cancel',
    danger: true,
  })
  if (!okCancel) return
  try {
    await axios.post(`${API}/api/blast/${selectedBlast.value.id}/cancel`)
    selectedBlast.value.status = 'cancelled'
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Gagal cancel', message: e.response?.data?.error || e.message })
  }
}

async function deleteBlast() {
  // v0.9.0 — confirm() native → M3 dialog; handler delete TIDAK berubah
  const ok = await confirmAction({
    title: 'Hapus blast ini?',
    message: 'Delete this blast and all its logs? This cannot be undone.',
    confirmText: 'Hapus',
    danger: true,
  })
  if (!ok) return
  try {
    await axios.delete(`${API}/api/blast/${selectedBlast.value.id}`)
    selectedBlast.value = null
    fetchBlasts(pagination.value.page)
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Gagal menghapus', message: e.response?.data?.error || e.message })
  }
}

async function exportResults() {
  try {
    const res = await axios.get(`${API}/api/blast/${selectedBlast.value.id}/export`, { responseType: 'blob' })
    const url = URL.createObjectURL(res.data)
    const a = document.createElement('a')
    a.href = url
    a.download = `blast_${selectedBlast.value.id}_results.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Gagal export', message: e.response?.data?.error || e.message })
  }
}

// Socket.IO listeners for real-time progress
function onBlastProgress(data) {
  // Update list if on list view
  if (!selectedBlast.value && data.blastId) {
    const b = blasts.value.find(b => b.id === data.blastId)
    if (b) {
      if (data.totalSent !== undefined) b.totalSent = data.totalSent
      if (data.totalFailed !== undefined) b.totalFailed = data.totalFailed
      if (data.status) b.status = data.status
    }
  }
  if (!selectedBlast.value || data.blastId !== selectedBlast.value.id) return
  if (data.totalSent !== undefined) selectedBlast.value.totalSent = data.totalSent
  if (data.totalFailed !== undefined) selectedBlast.value.totalFailed = data.totalFailed
  if (data.currentRecipient) currentRecipient.value = data.currentRecipient
  if (data.status) selectedBlast.value.status = data.status
  // Refresh logs periodically (every 10 msgs or on status change)
  if (data.sent % 10 === 0 || data.status === 'paused' || data.status === 'cancelled') {
    fetchBlastDetail(data.blastId, logPagination.value.page)
  }
}

function onBlastComplete(data) {
  // Update list if on list view
  if (!selectedBlast.value && data.blastId) {
    const b = blasts.value.find(b => b.id === data.blastId)
    if (b) {
      b.totalSent = data.totalSent
      b.totalFailed = data.totalFailed
      b.status = data.status
      b.completedAt = new Date().toISOString()
    }
  }
  if (!selectedBlast.value || data.blastId !== selectedBlast.value.id) return
  selectedBlast.value.totalSent = data.totalSent
  selectedBlast.value.totalFailed = data.totalFailed
  selectedBlast.value.status = data.status
  selectedBlast.value.completedAt = new Date().toISOString()
  currentRecipient.value = ''
  fetchBlastDetail(data.blastId, logPagination.value.page)
}

onMounted(() => {
  fetchBlasts()
  socketStore.on('blast_progress', onBlastProgress)
  socketStore.on('blast_complete', onBlastComplete)
})

onUnmounted(() => {
  socketStore.off('blast_progress', onBlastProgress)
  socketStore.off('blast_complete', onBlastComplete)
})
</script>
