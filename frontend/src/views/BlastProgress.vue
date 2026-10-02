<template>
  <div class="min-h-screen bg-gray-100">
    <!-- Top bar -->
    <header class="m3-topbar px-4 py-3 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <router-link to="/" class="text-sm hover:underline">← Dashboard</router-link>
        <h1 class="text-lg font-semibold">Blast Progress</h1>
      </div>
      <div class="flex items-center gap-4">
        <router-link to="/blast/history" class="text-sm hover:underline">History</router-link>
        <router-link to="/settings" class="text-sm hover:underline">{{ auth.user?.username }}</router-link>
        <button @click="handleLogout" class="text-sm hover:underline">Logout</button>
      </div>
    </header>

    <div class="max-w-4xl mx-auto p-6">
      <!-- Loading state -->
      <div v-if="loading" class="bg-white rounded-lg shadow-sm p-8 text-center text-gray-400">
        Loading blast...
      </div>

      <!-- Error state -->
      <div v-else-if="error" class="bg-white rounded-lg shadow-sm p-8 text-center text-red-500">
        {{ error }}
      </div>

      <!-- Blast Progress Content -->
      <div v-else-if="blast" class="space-y-4">
        <!-- Blast Info + Status -->
        <div class="bg-white rounded-lg shadow-sm p-6">
          <div class="flex items-start justify-between mb-4">
            <div>
              <h2 class="text-lg font-semibold">{{ blast.name || `Blast #${blast.id}` }}</h2>
              <p class="text-sm text-gray-500 mt-1">
                {{ formatDate(blast.createdAt) }} by {{ blast.createdByUser?.username }}
              </p>
            </div>
            <span :class="statusBadge(blast.status)">{{ blast.status }}</span>
          </div>

          <!-- Message -->
          <div class="bg-gray-50 rounded-lg p-3 text-sm whitespace-pre-wrap mb-4">{{ blast.message }}</div>

          <!-- Stats Grid -->
          <div class="grid grid-cols-4 gap-4 mb-4">
            <div class="text-center">
              <div class="text-2xl font-bold text-gray-700">{{ blast.totalRecipients }}</div>
              <div class="text-xs text-gray-500">Total</div>
            </div>
            <div class="text-center">
              <div class="text-2xl font-bold text-green-600">{{ stats.sent }}</div>
              <div class="text-xs text-gray-500">Sent</div>
            </div>
            <div class="text-center">
              <div class="text-2xl font-bold text-red-600">{{ stats.failed }}</div>
              <div class="text-xs text-gray-500">Failed</div>
            </div>
            <div class="text-center">
              <div class="text-2xl font-bold text-gray-400">{{ stats.pending }}</div>
              <div class="text-xs text-gray-500">Pending</div>
            </div>
          </div>

          <!-- Progress Bar -->
          <div>
            <div class="flex justify-between text-xs text-gray-500 mb-1">
              <span>Progress</span>
              <span>{{ progressPercent }}%</span>
            </div>
            <div class="w-full bg-gray-200 rounded-full h-3 overflow-hidden">
              <div
                :class="['h-full transition-all duration-500', blast.status === 'completed' ? 'bg-green-500' : blast.status === 'paused' ? 'bg-yellow-500' : blast.status === 'cancelled' ? 'bg-red-500' : 'bg-blue-500 animate-pulse']"
                :style="`width: ${progressPercent}%`"
              ></div>
            </div>

            <!-- Current recipient + ETA -->
            <div class="flex items-center justify-between mt-2 text-xs text-gray-500">
              <span v-if="currentRecipient && ['running', 'paused'].includes(blast.status)">
                Sending to: <strong>{{ currentRecipient.name }}</strong> ({{ currentRecipient.phone }})
              </span>
              <span v-else-if="blast.status === 'completed'" class="text-green-600">
                ✓ Completed — {{ stats.sent }} sent, {{ stats.failed }} failed
              </span>
              <span v-else-if="blast.status === 'cancelled'" class="text-red-500">
                ✕ Cancelled — {{ stats.sent }} sent, {{ stats.failed }} failed, {{ stats.pending }} remaining
              </span>

              <span v-if="etaSeconds > 0 && ['running', 'paused'].includes(blast.status)">
                ETA: ~{{ etaText }}
              </span>
            </div>
          </div>
        </div>

        <!-- Action Buttons -->
        <div class="bg-white rounded-lg shadow-sm p-4 flex flex-wrap gap-3 justify-between items-center">
          <div class="flex gap-2">
            <!-- Owner or Admin controls -->
            <template v-if="canControl">
              <button
                v-if="blast.status === 'running'"
                @click="pauseBlast"
                class="bg-yellow-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-yellow-600"
              >⏸ Pause</button>

              <button
                v-if="blast.status === 'paused'"
                @click="resumeBlast"
                class="bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-600"
              >▶ Resume</button>

              <button
                v-if="['running', 'paused', 'pending'].includes(blast.status)"
                @click="cancelBlast"
                class="bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-700"
              >✕ Cancel</button>
            </template>

            <button
              v-if="auth.isAdmin"
              @click="deleteBlast"
              class="bg-gray-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-600"
            >Delete</button>
            
            <button
              @click="exportResults"
              class="bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-700"
            >Export CSV</button>
          </div>

          <div class="flex gap-2">
            <button
              @click="runInBackground"
              class="bg-gray-100 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-200"
            >🏠 Run in Background</button>
            <router-link
              to="/blast/history"
              class="bg-gray-100 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-200 inline-flex items-center"
            >📋 History</router-link>
          </div>
        </div>

        <!-- Recipient List (single, updates in place) -->
        <div class="bg-white rounded-lg shadow-sm overflow-hidden">
          <div class="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
            <h3 class="text-sm font-semibold">Recipients</h3>
            <span class="text-xs text-gray-400">{{ recipients.length }} total · {{ recipients.filter(r => r.status === 'sent').length }} sent · {{ recipients.filter(r => r.status === 'failed').length }} failed</span>
          </div>
          <div ref="logContainer" class="max-h-96 overflow-y-auto">
            <div v-if="recipients.length === 0" class="p-4 text-center text-gray-400 text-sm">
              No recipients yet.
            </div>
            <div
              v-for="recipient in recipients"
              :key="recipient.id"
              class="px-4 py-2 border-b border-gray-100 flex items-center justify-between text-sm"
            >
              <div class="flex items-center gap-2">
                <span v-if="recipient.status === 'sent'" class="text-green-600">✅</span>
                <span v-else-if="recipient.status === 'failed'" class="text-red-600">❌</span>
                <span v-else class="text-gray-400">⏳</span>
                <span class="font-medium">{{ recipient.name }}</span>
                <span class="text-gray-400 text-xs">{{ recipient.phone }}</span>
              </div>
              <div class="flex items-center gap-2">
                <span v-if="recipient.error" class="text-xs text-red-400 truncate max-w-xs">{{ recipient.error }}</span>
                <span v-if="recipient.updatedAt" class="text-xs text-gray-400">{{ recipient.updatedAt }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Cancel confirmation modal -->
    <div v-if="showCancelConfirm" class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div class="bg-white rounded-lg p-6 max-w-md">
        <h3 class="text-lg font-semibold mb-2">Cancel Blast?</h3>
        <p class="text-sm text-gray-600 mb-4">
          {{ stats.pending }} recipients will not be sent. This cannot be undone.
        </p>
        <div class="flex gap-3 justify-end">
          <button @click="showCancelConfirm = false" class="text-gray-600 px-4 py-2 rounded-lg text-sm hover:bg-gray-100">No, keep going</button>
          <button @click="confirmCancel" class="bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-700">Yes, cancel</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { useSocketStore } from '../stores/socket'
import { useToastStore } from '../stores/toast'
import { useConfirm } from '../utils/confirm'
import axios from 'axios'

const API = import.meta.env.VITE_API_URL || ''
const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const toast = useToastStore()
const { confirmAction } = useConfirm()
const socketStore = useSocketStore()

const blast = ref(null)
const loading = ref(true)
const error = ref('')
const currentRecipient = ref(null)
const recipients = ref([])  // single list, updates in place
const logContainer = ref(null)
const showCancelConfirm = ref(false)

const stats = computed(() => ({
  sent: blast.value?.totalSent || 0,
  failed: blast.value?.totalFailed || 0,
  pending: blast.value ? Math.max(0, blast.value.totalRecipients - (blast.value.totalSent || 0) - (blast.value.totalFailed || 0)) : 0,
}))

const progressPercent = computed(() => {
  if (!blast.value || blast.value.totalRecipients === 0) return 0
  const done = (blast.value.totalSent || 0) + (blast.value.totalFailed || 0)
  return Math.round((done / blast.value.totalRecipients) * 100)
})

const canControl = computed(() => {
  if (!blast.value) return false
  return auth.isAdmin || blast.value.createdBy === auth.user?.id
})

const etaSeconds = computed(() => {
  if (!blast.value || !['running', 'paused'].includes(blast.value.status)) return 0
  const remaining = stats.value.pending
  if (remaining === 0) return 0
  const delayPerMsg = blast.value.delayPerMsg || 5
  const delayPerGroup = blast.value.delayPerGroup || 60
  const groupSize = blast.value.groupSize || 100
  const remainingGroups = Math.ceil(remaining / groupSize)
  return remaining * delayPerMsg + (remainingGroups - 1) * delayPerGroup
})

const etaText = computed(() => {
  const sec = etaSeconds.value
  if (sec <= 0) return '—'
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
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
  return new Date(d).toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatTimeNow() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function getRecipientIcon(status) {
  if (status === 'sent') return '✅'
  if (status === 'failed') return '❌'
  return '⏳'
}

function handleLogout() {
  auth.logout()
  router.push('/login')
}

async function fetchBlast() {
  const id = route.params.id
  try {
    const res = await axios.get(`${API}/api/blast/${id}`, { params: { page: 1, limit: 200 } })
    blast.value = res.data.blast
    // Populate the single recipient list from existing blast logs
    recipients.value = res.data.logs.map(log => ({
      id: log.id,
      name: log.contactName || log.phoneNumber || 'Pelanggan',
      phone: log.phoneNumber || log.chatId || '',
      status: log.status || 'pending',
      error: log.error || null,
      updatedAt: log.sentAt ? formatDate(log.sentAt) : '',
    }))
    loading.value = false
    scrollToBottom()
  } catch (e) {
    if (e.response?.status === 403) {
      error.value = 'Access denied — you can only view your own blasts.'
    } else if (e.response?.status === 404) {
      error.value = 'Blast not found.'
    } else {
      error.value = 'Failed to load blast: ' + (e.response?.data?.error || e.message)
    }
    loading.value = false
  }
}

function scrollToBottom() {
  nextTick(() => {
    if (logContainer.value) {
      logContainer.value.scrollTop = logContainer.value.scrollHeight
    }
  })
}

// Socket.IO handlers
function onBlastProgress(data) {
  if (!blast.value || data.blastId !== blast.value.id) return

  // Update blast totals from the event payload (backend sends sent/failed, not totalSent/totalFailed)
  if (data.sent !== undefined) blast.value.totalSent = data.sent
  if (data.failed !== undefined) blast.value.totalFailed = data.failed
  if (data.status) blast.value.status = data.status

  // Update current recipient indicator
  if (data.currentRecipient) {
    currentRecipient.value = {
      name: data.currentRecipient.name || '',
      phone: data.currentRecipient.phone || '',
    }

    // Update the matching recipient's status IN PLACE (no duplication)
    if (data.currentRecipient) {
      const recipient = recipients.value.find(r =>
        r.phone === data.currentRecipient.phone ||
        r.name === data.currentRecipient.name
      )
      if (recipient) {
        recipient.status = data.lastStatus || 'sent'
        recipient.error = data.lastError || null
        recipient.updatedAt = formatTimeNow()
      }
      scrollToBottom()
    }
  }
}

function onBlastComplete(data) {
  if (!blast.value || data.blastId !== blast.value.id) return
  blast.value.totalSent = data.totalSent
  blast.value.totalFailed = data.totalFailed
  blast.value.status = data.status
  blast.value.completedAt = new Date().toISOString()
  currentRecipient.value = null
  // Refresh full data
  fetchBlast()
}

function onBlastError(data) {
  if (!blast.value || data.blastId !== blast.value.id) return
  error.value = data.error || 'Blast encountered an error'
}

// Actions
async function pauseBlast() {
  try {
    await axios.post(`${API}/api/blast/${blast.value.id}/pause`)
    blast.value.status = 'paused'
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Gagal pause', message: e.response?.data?.error || e.message })
  }
}

async function resumeBlast() {
  try {
    await axios.post(`${API}/api/blast/${blast.value.id}/resume`)
    blast.value.status = 'running'
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Gagal resume', message: e.response?.data?.error || e.message })
  }
}

function cancelBlast() {
  showCancelConfirm.value = true
}

async function confirmCancel() {
  showCancelConfirm.value = false
  try {
    await axios.post(`${API}/api/blast/${blast.value.id}/cancel`)
    blast.value.status = 'cancelled'
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
    await axios.delete(`${API}/api/blast/${blast.value.id}`)
    router.push('/blast/history')
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Gagal menghapus', message: e.response?.data?.error || e.message })
  }
}

function runInBackground() {
  router.push('/')
}

async function exportResults() {
  try {
    const res = await axios.get(`${API}/api/blast/${blast.value.id}/export`, { responseType: 'blob' })
    const url = URL.createObjectURL(res.data)
    const a = document.createElement('a')
    a.href = url
    a.download = `blast_${blast.value.id}_results.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Gagal export', message: e.response?.data?.error || e.message })
  }
}

onMounted(() => {
  fetchBlast()
  socketStore.on('blast_progress', onBlastProgress)
  socketStore.on('blast_complete', onBlastComplete)
  socketStore.on('blast_error', onBlastError)
})

onUnmounted(() => {
  socketStore.off('blast_progress', onBlastProgress)
  socketStore.off('blast_complete', onBlastComplete)
  socketStore.off('blast_error', onBlastError)
})
</script>
