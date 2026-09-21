<template>
  <PageShell title="Pengaturan">
    <header class="hidden md:flex m3-topbar px-4 py-3 items-center justify-between">
      <div class="flex items-center gap-3">
        <router-link to="/" class="text-sm hover:underline m3-topbar__link">← Dashboard</router-link>
        <h1 class="text-lg font-semibold">Pengaturan</h1>
      </div>
      <button @click="handleLogout" class="text-sm hover:underline">Logout</button>
    </header>

    <div class="max-w-4xl mx-auto w-full p-6 space-y-6">
      <!-- v0.12.0 — link ke Guidebook (spec §2.1) -->
      <router-link
        to="/guidebook"
        class="m3-card m3-card--elevated p-6 flex items-center gap-4 transition-shadow hover:shadow-[var(--md-sys-elevation-2)] active:opacity-90"
        style="min-height: 44px;"
      >
        <div class="text-3xl flex-shrink-0">📖</div>
        <div class="min-w-0">
          <div class="font-semibold text-gray-900">Panduan Penggunaan</div>
          <div class="text-sm text-gray-500">Cara pakai semua fitur ChatBareng — per CS, Admin &amp; Cabang</div>
        </div>
        <div class="ml-auto text-gray-400 flex-shrink-0">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
          </svg>
        </div>
      </router-link>

      <!-- v0.9.0 — Theme toggle 3 mode (Light/Dark/System), spec §2 -->
      <div class="m3-card p-6">
        <h2 class="text-lg font-semibold mb-1">Tampilan</h2>
        <p class="text-sm text-gray-500 mb-4">Mode tema — "Sistem" mengikuti pengaturan perangkat/OS secara real-time.</p>
        <ThemeToggle />
      </div>

      <!-- Profile -->
      <div class="m3-card p-6">
        <h2 class="text-lg font-semibold mb-4">Profile</h2>
        <div class="flex items-center gap-4">
          <div class="w-16 h-16 rounded-full bg-wa-dark text-white flex items-center justify-center text-xl font-semibold">
            {{ auth.user?.username?.[0]?.toUpperCase() }}
          </div>
          <div>
            <div class="font-medium">{{ auth.user?.username }}</div>
            <div class="text-sm text-gray-500">Role: {{ auth.user?.role }}</div>
          </div>
        </div>
      </div>

      <!-- Change Password -->
      <div class="m3-card p-6">
        <h2 class="text-lg font-semibold mb-4">Change Password</h2>
        <form @submit.prevent="changePassword" class="space-y-3">
          <div>
            <label class="block text-sm font-medium text-[var(--md-sys-color-on-surface-variant)] mb-1">Current Password</label>
            <input v-model="pwForm.current" type="password" required class="w-full px-3 py-2 border border-[var(--md-sys-color-outline)] rounded-lg text-sm text-[var(--md-sys-color-on-surface)] bg-[var(--md-sys-color-surface-container-lowest)] focus:outline-none focus:ring-2 focus:ring-wa-green" />
          </div>
          <div>
            <label class="block text-sm font-medium text-[var(--md-sys-color-on-surface-variant)] mb-1">New Password</label>
            <input v-model="pwForm.new" type="password" required minlength="6" class="w-full px-3 py-2 border border-[var(--md-sys-color-outline)] rounded-lg text-sm text-[var(--md-sys-color-on-surface)] bg-[var(--md-sys-color-surface-container-lowest)] focus:outline-none focus:ring-2 focus:ring-wa-green" />
          </div>
          <div>
            <label class="block text-sm font-medium text-[var(--md-sys-color-on-surface-variant)] mb-1">Confirm New Password</label>
            <input v-model="pwForm.confirm" type="password" required class="w-full px-3 py-2 border border-[var(--md-sys-color-outline)] rounded-lg text-sm text-[var(--md-sys-color-on-surface)] bg-[var(--md-sys-color-surface-container-lowest)] focus:outline-none focus:ring-2 focus:ring-wa-green" />
          </div>
          <div v-if="pwError" class="text-[var(--md-sys-color-error)] text-sm">{{ pwError }}</div>
          <div v-if="pwSuccess" class="text-green-600 text-sm">{{ pwSuccess }}</div>
          <button type="submit" class="px-4 py-2 bg-wa-green text-white rounded-lg text-sm hover:bg-green-600">
            Change Password
          </button>
        </form>
      </div>

      <!-- Notifications (v0.4.0) -->
      <div class="m3-card p-6">
        <h2 class="text-lg font-semibold mb-4">Notifikasi</h2>

        <div class="space-y-2 text-sm mb-4">
          <div class="flex items-center justify-between">
            <span class="text-gray-500">Didukung browser</span>
            <span :class="pushSupported ? 'text-green-600' : 'text-red-600'">{{ pushSupported ? '✓ Ya' : '✕ Tidak' }}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-gray-500">Izin notifikasi</span>
            <span :class="permissionClass">{{ permissionLabel }}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-gray-500">Status subscribe</span>
            <span :class="pushSubscribed ? 'text-green-600' : 'text-gray-400'">{{ pushSubscribed ? '✓ Aktif' : 'Belum aktif' }}</span>
          </div>
        </div>

        <div class="flex flex-wrap gap-2">
          <button
            v-if="!pushSubscribed"
            @click="enablePush"
            :disabled="pushBusy || !pushSupported"
            class="px-4 py-2 bg-wa-green text-white rounded-lg text-sm hover:bg-green-600 disabled:opacity-50"
          >
            {{ pushBusy ? 'Memproses…' : '🔔 Aktifkan Notifikasi' }}
          </button>
          <button
            v-else
            @click="disablePushAction"
            :disabled="pushBusy"
            class="px-4 py-2 bg-gray-100 text-gray-700 border border-gray-300 rounded-lg text-sm hover:bg-gray-200 disabled:opacity-50"
          >
            {{ pushBusy ? 'Memproses…' : 'Nonaktifkan' }}
          </button>
          <button
            v-if="auth.isAdmin && pushSubscribed"
            @click="sendTestPush"
            :disabled="pushBusy"
            class="px-4 py-2 bg-blue-50 text-blue-600 border border-blue-200 rounded-lg text-sm hover:bg-blue-100 disabled:opacity-50"
          >
            {{ testSent ? '✓ Test terkirim' : 'Kirim test notifikasi' }}
          </button>
        </div>

        <p v-if="pushError" class="text-red-600 text-sm mt-3">{{ pushError }}</p>
        <p v-if="pushInfo" class="text-green-600 text-sm mt-3">{{ pushInfo }}</p>
        <p v-if="!pushSupported" class="text-gray-500 text-xs mt-3">
          Browser ini tidak mendukung Web Push{{ pwa.isIOS ? ' — di iOS, install app dulu ke Home Screen (lihat di bawah), lalu buka dari ikonnya.' : '.' }}
        </p>
      </div>

      <!-- PWA Install (v0.4.0) -->
      <div class="m3-card p-6">
        <h2 class="text-lg font-semibold mb-4">Aplikasi (PWA)</h2>
        <p v-if="pwa.installed" class="text-sm text-green-600 mb-2">✓ App ter-install di perangkat ini</p>
        <button
          v-if="pwa.canInstall"
          @click="installApp"
          class="px-4 py-2 bg-wa-dark text-white rounded-lg text-sm hover:opacity-90"
        >
          📲 Install Aplikasi
        </button>
        <div v-else-if="pwa.isIOS && !pwa.installed" class="text-sm text-gray-600 space-y-1">
          <p>Di iPhone/iPad, install manual:</p>
          <ol class="list-decimal list-inside text-gray-500">
            <li>Buka di Safari</li>
            <li>Tap tombol <strong>Share</strong> ⬆️</li>
            <li>Pilih <strong>“Add to Home Screen”</strong></li>
          </ol>
        </div>
        <p v-else class="text-sm text-gray-400">Prompt install belum tersedia — buka app beberapa kali dulu atau cek kembali nanti.</p>
      </div>

      <!-- Logout (v0.2.7 — sebelumnya cuma di header desktop, mobile gak punya tombol logout) -->
      <div class="m3-card p-6">
        <button
          @click="handleLogout"
          class="w-full px-4 py-2.5 bg-red-50 text-red-600 border border-red-200 rounded-lg text-sm font-medium hover:bg-red-100 active:bg-red-200"
        >
          🚪 Logout
        </button>
      </div>
    </div>
  </PageShell>
</template>

<script setup>
import PageShell from '../components/PageShell.vue'
import ThemeToggle from '../components/ThemeToggle.vue'
import { ref, computed, onMounted } from 'vue'
import axios from 'axios'
import { useAuthStore } from '../stores/auth'
import { usePwaStore } from '../stores/pwa'
import { useToastStore } from '../stores/toast'
import { pushSupported as checkPushSupported, isSubscribed, initPush, disablePush } from '../utils/push'

const API = import.meta.env.VITE_API_URL || ''
const auth = useAuthStore()
const pwa = usePwaStore()
const toast = useToastStore()

const pwForm = ref({ current: '', new: '', confirm: '' })
const pwError = ref('')
const pwSuccess = ref('')

// ── Push notification state ──
const pushBusy = ref(false)
const pushSubscribed = ref(false)
const pushError = ref('')
const pushInfo = ref('')
const testSent = ref(false)
const currentPermission = ref(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported')
const supported = checkPushSupported()
const pushSupported = supported

const permissionLabel = computed(() => {
  switch (currentPermission.value) {
    case 'granted': return '✓ Granted'
    case 'denied': return '✕ Ditolak'
    case 'unsupported': return '—'
    default: return 'Belum diminta'
  }
})
const permissionClass = computed(() => currentPermission.value === 'granted' ? 'text-green-600' : (currentPermission.value === 'denied' ? 'text-red-600' : 'text-gray-400'))

async function refreshPushState() {
  pushSubscribed.value = await isSubscribed()
  if (typeof Notification !== 'undefined') currentPermission.value = Notification.permission
}

async function enablePush() {
  pushError.value = ''
  pushInfo.value = ''
  pushBusy.value = true
  try {
    const result = await initPush()
    if (result.ok) {
      pushInfo.value = 'Notifikasi berhasil diaktifkan ✓'
      toast.show({ icon: '🔔', title: 'Notifikasi aktif', message: 'Push notification sudah diaktifkan di browser ini' })
    } else if (result.reason === 'denied') {
      pushError.value = 'Izin notifikasi ditolak. Izinkan lewat ikon 🔒 di address bar, lalu coba lagi.'
    } else if (result.reason === 'unsupported') {
      pushError.value = 'Browser ini tidak mendukung Web Push.'
    } else {
      pushError.value = 'Gagal mengaktifkan push. Coba lagi.'
    }
  } finally {
    pushBusy.value = false
    await refreshPushState()
  }
}

async function disablePushAction() {
  pushError.value = ''
  pushInfo.value = ''
  pushBusy.value = true
  try {
    await disablePush()
    pushInfo.value = 'Notifikasi dinonaktifkan'
  } finally {
    pushBusy.value = false
    await refreshPushState()
  }
}

async function sendTestPush() {
  pushError.value = ''
  pushInfo.value = ''
  pushBusy.value = true
  testSent.value = false
  try {
    await axios.post(`${API}/api/push/test`)
    testSent.value = true
    setTimeout(() => { testSent.value = false }, 4000)
  } catch (e) {
    pushError.value = e.response?.data?.error || 'Gagal mengirim test push'
  } finally {
    pushBusy.value = false
  }
}

async function installApp() {
  const outcome = await pwa.promptInstall()
  if (outcome === 'accepted') {
    toast.show({ icon: '📲', title: 'App ter-install', message: 'ChatBareng sekarang ada di Home Screen' })
  }
}

onMounted(refreshPushState)

async function changePassword() {
  pwError.value = ''
  pwSuccess.value = ''
  if (pwForm.value.new !== pwForm.value.confirm) {
    pwError.value = 'New passwords do not match'
    return
  }
  try {
    // v0.12.2 — self-service: endpoint khusus requireAuth dengan verifikasi current password
    // (sebelumnya salah pakai PUT /api/users/:id yang requireAdmin → CS biasa kena 403)
    await axios.post(`${API}/api/auth/change-password`, {
      currentPassword: pwForm.value.current,
      newPassword: pwForm.value.new,
    })
    pwSuccess.value = 'Password changed successfully'
    pwForm.value = { current: '', new: '', confirm: '' }
  } catch (e) {
    pwError.value = e.response?.data?.error || 'Failed to change password'
  }
}

function handleLogout() {
  auth.logout()
  window.location.href = '/login'
}
</script>