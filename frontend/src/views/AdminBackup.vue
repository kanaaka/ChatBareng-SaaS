<template>
  <PageShell title="Backup Drive" back-to="/admin">
    <header class="hidden md:flex m3-topbar px-4 py-3 items-center justify-between">
      <div class="flex items-center gap-3">
        <h1 class="text-lg font-semibold">Backup Drive</h1>
      </div>
      <div class="flex items-center gap-4">
        <button @click="handleLogout" class="text-sm hover:underline">Logout</button>
      </div>
    </header>

    <div class="max-w-4xl mx-auto w-full p-4 sm:p-6 space-y-4">
      <!-- Kartu status koneksi -->
      <div class="bg-white rounded-lg shadow-sm p-4 sm:p-6">
        <h2 class="font-semibold text-gray-900">Status Koneksi</h2>

        <!-- OAuth belum dikonfigurasi di server -->
        <div v-if="status.oauthConfigured === false" class="mt-3 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
          ⚠️ OAuth Google belum dikonfigurasi di server (env <code>GDRIVE_CLIENT_ID</code>/<code>GDRIVE_CLIENT_SECRET</code> kosong). Hubungi admin sistem.
        </div>

        <!-- Belum terhubung -->
        <template v-else-if="!status.linked">
          <p class="text-sm text-gray-500 mt-2">
            Hubungkan akun Google pribadi — backup CSV chat otomatis diupload ke folder "ChatBareng Backups" di Drive Anda.
          </p>
          <button
            @click="connect"
            :disabled="connecting"
            class="mt-4 px-5 py-2.5 bg-wa-green text-white rounded-lg text-sm font-medium hover:bg-green-600 disabled:opacity-50"
          >
            {{ connecting ? 'Membuka Google...' : '🔗 Hubungkan Google Drive' }}
          </button>
        </template>

        <!-- Terhubung -->
        <template v-else>
          <div class="mt-3 space-y-1 text-sm">
            <p class="text-gray-900">
              ✅ Terhubung sebagai <span class="font-semibold">{{ status.link?.email }}</span>
            </p>
            <p class="text-gray-500 text-xs">
              Backup terakhir:
              <span v-if="status.link?.lastBackupAt">{{ fmtDateTime(status.link.lastBackupAt) }}</span>
              <span v-else>belum pernah</span>
              <span v-if="status.link?.lastBackupStatus === 'success'" class="text-green-600"> (sukses)</span>
              <span v-else-if="status.link?.lastBackupStatus === 'error'" class="text-red-600"> (error)</span>
            </p>
            <p v-if="status.link?.lastBackupError" class="text-red-600 text-xs">{{ status.link.lastBackupError }}</p>
          </div>
          <div class="mt-4 flex flex-wrap gap-2">
            <button
              @click="backupNow"
              :disabled="backingUp"
              class="px-5 py-2.5 bg-wa-green text-white rounded-lg text-sm font-medium hover:bg-green-600 disabled:opacity-50"
            >
              {{ backingUp ? 'Memulai...' : '⬆️ Backup sekarang' }}
            </button>
            <button
              @click="disconnect"
              :disabled="disconnecting"
              class="px-5 py-2.5 bg-red-50 text-red-600 border border-red-200 rounded-lg text-sm font-medium hover:bg-red-100 disabled:opacity-50"
            >
              {{ disconnecting ? 'Memutus...' : '🔌 Putuskan' }}
            </button>
          </div>
        </template>
      </div>

      <!-- Kartu pengaturan jadwal -->
      <div class="bg-white rounded-lg shadow-sm p-4 sm:p-6">
        <label class="flex items-center justify-between cursor-pointer">
          <div>
            <h2 class="font-semibold text-gray-900">Backup Otomatis</h2>
            <p class="text-xs text-gray-500">Jadwal otomatis sesuai pengaturan di bawah (waktu WIB)</p>
          </div>
          <input v-model="form.enabled" type="checkbox" class="w-5 h-5 accent-green-600" />
        </label>

        <div class="mt-4 space-y-3">
          <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 py-1 border-b border-gray-100">
            <span class="text-sm text-gray-800">Frekuensi</span>
            <!-- v0.8.0 mobile-friendly: 1 grup flex shrink-0 (pola v0.7.1) -->
            <div class="flex items-center gap-1 shrink-0">
              <select v-model="form.frequency" class="px-2 py-1.5 border border-gray-300 rounded-lg text-sm">
                <option value="daily">Harian</option>
                <option value="weekly">Mingguan</option>
                <option value="monthly">Bulanan</option>
              </select>
            </div>
          </div>

          <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 py-1 border-b border-gray-100">
            <span class="text-sm text-gray-800">Jam (WIB)</span>
            <div class="flex items-center gap-1 shrink-0">
              <input v-model.number="form.hour" type="number" min="0" max="23" class="w-20 px-2 py-1.5 border border-gray-300 rounded-lg text-sm" />
              <span class="text-gray-400 text-sm">:00</span>
            </div>
          </div>

          <div v-if="form.frequency === 'weekly'" class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 py-1 border-b border-gray-100">
            <span class="text-sm text-gray-800">Hari</span>
            <div class="flex items-center gap-1 shrink-0">
              <select v-model.number="form.dayOfWeek" class="px-2 py-1.5 border border-gray-300 rounded-lg text-sm">
                <option :value="0">Minggu</option>
                <option :value="1">Senin</option>
                <option :value="2">Selasa</option>
                <option :value="3">Rabu</option>
                <option :value="4">Kamis</option>
                <option :value="5">Jumat</option>
                <option :value="6">Sabtu</option>
              </select>
            </div>
          </div>

          <div v-if="form.frequency === 'monthly'" class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 py-1 border-b border-gray-100">
            <span class="text-sm text-gray-800">Tanggal</span>
            <div class="flex items-center gap-1 shrink-0">
              <select v-model.number="form.dayOfMonth" class="px-2 py-1.5 border border-gray-300 rounded-lg text-sm">
                <option v-for="d in 28" :key="d" :value="d">{{ d }}</option>
              </select>
              <span class="text-gray-400 text-xs">1–28</span>
            </div>
          </div>

          <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 py-1">
            <span class="text-sm text-gray-800">Simpan backup terakhir</span>
            <div class="flex items-center gap-1 shrink-0">
              <input v-model.number="form.retentionCount" type="number" min="1" class="w-20 px-2 py-1.5 border border-gray-300 rounded-lg text-sm" />
              <span class="text-gray-400 text-sm">file</span>
            </div>
          </div>
          <p class="text-xs text-gray-400">File di luar N terakhir otomatis dihapus dari Drive (retensi).</p>
        </div>

        <div class="flex justify-end mt-4">
          <button
            @click="save"
            :disabled="saving"
            class="px-6 py-2.5 bg-wa-green text-white rounded-lg text-sm font-medium hover:bg-green-600 disabled:opacity-50"
          >
            {{ saving ? 'Menyimpan...' : 'Simpan' }}
          </button>
        </div>
      </div>

      <!-- Kartu riwayat backup -->
      <div class="bg-white rounded-lg shadow-sm p-4 sm:p-6">
        <h2 class="font-semibold text-gray-900">Riwayat Backup</h2>
        <p class="text-xs text-gray-500 mt-1">20 backup terakhir</p>
        <div v-if="!status.logs?.length" class="text-sm text-gray-400 mt-3">Belum ada backup.</div>
        <div v-else class="mt-3 overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-xs text-gray-400 border-b border-gray-100">
                <th class="py-2 pr-3 font-medium">Waktu</th>
                <th class="py-2 pr-3 font-medium">File</th>
                <th class="py-2 pr-3 font-medium">Ukuran</th>
                <th class="py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="log in status.logs" :key="log.id" class="border-b border-gray-50 last:border-0 align-top">
                <td class="py-2 pr-3 whitespace-nowrap text-gray-600">{{ fmtDateTime(log.uploadedAt) }}</td>
                <td class="py-2 pr-3 text-gray-800 break-all">{{ log.fileName }}</td>
                <td class="py-2 pr-3 whitespace-nowrap text-gray-600">{{ fmtSize(log.sizeBytes) }}</td>
                <td class="py-2">
                  <span v-if="log.status === 'success'" class="text-green-600">✅ sukses</span>
                  <span v-else class="text-red-600">❌ error</span>
                  <div v-if="log.error" class="text-xs text-red-500 max-w-xs">{{ log.error }}</div>
                </td>
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
import { fmtBytes } from '../utils/format' // v4.6.1 — shared byte formatter (KB→MB→GB→TB)
import { ref, onMounted } from 'vue'
import { useAuthStore } from '../stores/auth'
import { useConfirm } from '../utils/confirm'
import { useToastStore } from '../stores/toast'
import PageShell from '../components/PageShell.vue'

const API = import.meta.env.VITE_API_URL || ''
const auth = useAuthStore()
const { confirmAction } = useConfirm()
const toast = useToastStore()

const loading = ref(true)
const connecting = ref(false)
const backingUp = ref(false)
const disconnecting = ref(false)
const saving = ref(false)

const status = ref({ linked: false, link: null, config: {}, logs: [], oauthConfigured: true })

const form = ref({
  frequency: 'daily',
  hour: 23,
  dayOfWeek: 1,
  dayOfMonth: 1,
  retentionCount: 30,
  enabled: false,
})

function fmtDateTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return String(iso)
  return d.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })
}

// v4.6.1 — fmtSize delegasi ke shared fmtBytes (ladder KB/MB/GB/TB — raw B off)
const fmtSize = fmtBytes

async function fetchStatus() {
  try {
    const res = await axios.get(`${API}/api/gdrive/status`)
    status.value = res.data
    const cfg = res.data.config || {}
    form.value.frequency = cfg.frequency || 'daily'
    form.value.hour = cfg.hour ?? 23
    form.value.dayOfWeek = cfg.dayOfWeek ?? 1
    form.value.dayOfMonth = cfg.dayOfMonth ?? 1
    form.value.retentionCount = cfg.retentionCount ?? 30
    form.value.enabled = !!cfg.enabled
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Gagal memuat', message: e.response?.data?.error || 'Status backup tidak bisa dimuat' })
  } finally {
    loading.value = false
  }
}

// Hubungkan Google Drive — same-tab ke /api/gdrive/oauth/start.
// oauth/start balikin JSON consentUrl → ikut redirect browser.
async function connect() {
  connecting.value = true
  try {
    const res = await axios.get(`${API}/api/gdrive/oauth/start`)
    if (res.data?.consentUrl) {
      window.location.href = res.data.consentUrl // same-tab sesuai spec
    }
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Gagal', message: e.response?.data?.error || 'Tidak bisa memulai OAuth' })
    connecting.value = false
  }
}

async function backupNow() {
  backingUp.value = true
  try {
    await axios.post(`${API}/api/gdrive/backup-now`)
    toast.show({ icon: '⏳', title: 'Backup dimulai', message: 'Sedang mengupload ke Drive — cek riwayat beberapa saat lagi.' })
    // Tunggu sebentar lalu refresh status (job async)
    setTimeout(async () => {
      await fetchStatus()
      backingUp.value = false
    }, 2500)
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Gagal', message: e.response?.data?.error || 'Backup gagal dimulai' })
    backingUp.value = false
  }
}

async function disconnect() {
  // v0.9.0 — window.confirm native → M3 dialog; handler disconnect TIDAK berubah
  const ok = await confirmAction({
    title: 'Putuskan koneksi Google Drive?',
    message: 'Token akan dicabut (revoke) di Google dan jadwal backup otomatis berhenti.',
    confirmText: 'Putuskan',
    danger: true,
  })
  if (!ok) return
  disconnecting.value = true
  try {
    await axios.delete(`${API}/api/gdrive/disconnect`)
    toast.show({ icon: '✅', title: 'Terputus', message: 'Google Drive sudah diputuskan' })
    await fetchStatus()
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Gagal', message: e.response?.data?.error || 'Tidak bisa memutuskan koneksi' })
  } finally {
    disconnecting.value = false
  }
}

async function save() {
  // Validasi ringan client
  const f = form.value
  const hour = Number(f.hour)
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    toast.show({ icon: '⚠️', title: 'Jam tidak valid', message: 'Jam harus angka 0–23' })
    return
  }
  const ret = Number(f.retentionCount)
  if (!Number.isInteger(ret) || ret < 1) {
    toast.show({ icon: '⚠️', title: 'Retensi tidak valid', message: 'Retensi harus angka ≥ 1' })
    return
  }
  saving.value = true
  try {
    const res = await axios.put(`${API}/api/gdrive/config`, {
      frequency: f.frequency,
      hour,
      dayOfWeek: Number(f.dayOfWeek),
      dayOfMonth: Number(f.dayOfMonth),
      retentionCount: ret,
      enabled: !!f.enabled,
    })
    const cfg = res.data.config
    form.value.frequency = cfg.frequency
    form.value.hour = cfg.hour
    form.value.dayOfWeek = cfg.dayOfWeek
    form.value.dayOfMonth = cfg.dayOfMonth
    form.value.retentionCount = cfg.retentionCount
    form.value.enabled = !!cfg.enabled
    toast.show({ icon: '✅', title: 'Tersimpan', message: 'Pengaturan backup berhasil disimpan' })
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Gagal simpan', message: e.response?.data?.error || 'Terjadi kesalahan' })
  } finally {
    saving.value = false
  }
}

function handleLogout() {
  auth.logout()
  window.location.href = '/login'
}

onMounted(() => {
  fetchStatus()
  // Query param linked=1 (dari OAuth callback) → toast sukses
  const params = new URLSearchParams(window.location.search)
  const hashQuery = window.location.hash.includes('?') ? window.location.hash.split('?')[1] : ''
  const linked = params.get('linked') || new URLSearchParams(hashQuery).get('linked')
  const oauthErr = params.get('error') || new URLSearchParams(hashQuery).get('error')
  if (linked === '1') {
    toast.show({ icon: '✅', title: 'Google Drive terhubung', message: 'Backup otomatis siap digunakan' })
    history.replaceState(null, '', window.location.pathname)
  } else if (linked === '0' || oauthErr) {
    toast.show({ icon: '⚠️', title: 'Gagal menghubungkan', message: 'OAuth gagal atau dibatalkan — coba lagi' })
    history.replaceState(null, '', window.location.pathname)
  }
})
</script>
