<template>
  <PageShell title="Auto Reply" back-to="/admin">
    <header class="hidden md:flex m3-topbar px-4 py-3 items-center justify-between">
      <div class="flex items-center gap-3">
        <h1 class="text-lg font-semibold">Auto Reply</h1>
      </div>
      <div class="flex items-center gap-4">
        <button @click="handleLogout" class="text-sm hover:underline">Logout</button>
      </div>
    </header>

    <div class="max-w-4xl mx-auto w-full p-6 space-y-4">
      <!-- Badge status ringkas -->
      <div class="bg-white rounded-lg shadow-sm p-4">
        <span :class="['inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium', statusBadge.class]">
          {{ statusBadge.text }}
        </span>
        <p class="text-xs text-gray-400 mt-2">Auto message 1×/hari per pelanggan · tidak mengubah antrean · tidak dihitung sebagai first-response CS</p>
      </div>

      <!-- Outside Hours Reply -->
      <div class="bg-white rounded-lg shadow-sm p-6">
        <label class="flex items-center justify-between cursor-pointer">
          <div>
            <h2 class="font-semibold text-gray-900">Outside Hours Reply</h2>
            <p class="text-xs text-gray-500">Balasan otomatis saat pelanggan chat di luar jam operasional</p>
          </div>
          <input v-model="form.outsideHoursEnabled" type="checkbox" class="w-5 h-5 accent-green-600" />
        </label>
        <div v-if="form.outsideHoursEnabled" class="mt-4 space-y-2">
          <textarea
            v-model="form.outsideHoursText"
            rows="3"
            maxlength="1000"
            class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            placeholder="Teks balasan di luar jam kerja..."
          ></textarea>
          <p class="text-xs text-gray-500">
            Preview: <span class="italic text-gray-700">{{ preview(form.outsideHoursText) }}</span>
          </p>
        </div>
      </div>

      <!-- First-of-Day Greeting -->
      <div class="bg-white rounded-lg shadow-sm p-6">
        <label class="flex items-center justify-between cursor-pointer">
          <div>
            <h2 class="font-semibold text-gray-900">First-of-Day Greeting</h2>
            <p class="text-xs text-gray-500">Sapaan otomatis untuk pelanggan yang chat pertama kali di hari itu</p>
          </div>
          <input v-model="form.greetEnabled" type="checkbox" class="w-5 h-5 accent-green-600" />
        </label>
        <div v-if="form.greetEnabled" class="mt-4 space-y-2">
          <!-- v0.13.0 — mode greeting (D9): teks biasa (default) / menu gateway -->
          <div class="flex flex-wrap items-center gap-4 mb-2">
            <span class="text-xs text-gray-600">Mode greeting:</span>
            <label class="flex items-center gap-1.5 text-sm text-gray-800 cursor-pointer" style="min-height: 36px;">
              <input v-model="form.greetMode" type="radio" value="text" class="w-4 h-4 accent-green-600" />
              Teks biasa
            </label>
            <label class="flex items-center gap-1.5 cursor-pointer" style="min-height: 36px;">
              <input v-model="form.greetMode" type="radio" value="menu" class="w-4 h-4 accent-green-600" />
              <span class="text-sm text-gray-800">Menu gateway (pilihan topik)</span>
              <router-link to="/admin/menu-gateway" class="text-xs text-green-700 hover:underline">→ atur menu</router-link>
            </label>
          </div>
          <p v-if="form.greetMode === 'menu'" class="text-xs text-amber-600">
            Teks greeting di bawah TIDAK terkirim — pelanggan menerima intro dari Menu Gateway
            (yang otomatis menyala saat mode ini disimpan; mati lagi kalau radio kembali ke Teks biasa).
          </p>
          <textarea
            v-model="form.greetText"
            rows="3"
            maxlength="1000"
            class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            placeholder="Teks greeting..."
          ></textarea>
          <p class="text-xs text-gray-500">
            Preview: <span class="italic text-gray-700">{{ preview(form.greetText) }}</span>
          </p>
        </div>
      </div>

      <!-- Jam Operasional -->
      <div class="bg-white rounded-lg shadow-sm p-4 sm:p-6">
        <h2 class="font-semibold text-gray-900 mb-4">Jam Operasional <span class="text-xs font-normal text-gray-400">(WIB)</span></h2>
        <div class="space-y-1">
          <div v-for="row in hourRows" :key="row.prefix" class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 py-1.5 border-b border-gray-100 last:border-0">
            <label class="flex items-center gap-2 cursor-pointer">
              <input v-model="form[row.prefix + 'Enabled']" type="checkbox" class="w-4 h-4 accent-green-600" />
              <span class="text-sm text-gray-800">{{ row.label }}</span>
            </label>
            <!-- v0.7.1: start–end = SATU grup flex shrink-0 → wrap per grup, bukan per input (fix zigzag mobile) -->
            <div v-if="form[row.prefix + 'Enabled']" class="flex items-center gap-1 shrink-0">
              <input v-model="form[row.prefix + 'Start']" type="time" class="px-1.5 py-1 border border-gray-300 rounded-lg text-sm" />
              <span class="text-gray-400 text-sm">–</span>
              <input v-model="form[row.prefix + 'End']" type="time" class="px-1.5 py-1 border border-gray-300 rounded-lg text-sm" />
            </div>
            <span v-else class="text-xs text-gray-400">Off — dianggap di luar jam operasional</span>
          </div>
        </div>
      </div>

      <!-- Save -->
      <div class="flex justify-end">
        <button
          @click="save"
          :disabled="saving"
          class="px-6 py-2.5 bg-wa-green text-white rounded-lg text-sm font-medium hover:bg-green-600 disabled:opacity-50"
        >
          {{ saving ? 'Menyimpan...' : 'Simpan' }}
        </button>
      </div>
    </div>
  </PageShell>
</template>

<script setup>
import axios from 'axios'
import { ref, computed, onMounted } from 'vue'
import { useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'
import PageShell from '../components/PageShell.vue'

const API = import.meta.env.VITE_API_URL || ''
const auth = useAuthStore()
const toast = useToastStore()

const loading = ref(true)
const saving = ref(false)

const hourRows = [
  { prefix: 'monFri', label: 'Senin–Jumat' },
  { prefix: 'sat', label: 'Sabtu' },
  { prefix: 'sun', label: 'Minggu' },
]

const form = ref({
  outsideHoursEnabled: false,
  outsideHoursText: '',
  greetEnabled: false,
  greetText: '',
  greetMode: 'text', // v0.13.0 — "text" (default) | "menu"
  monFriEnabled: true, monFriStart: '08:00', monFriEnd: '17:00',
  satEnabled: true, satStart: '08:00', satEnd: '17:00',
  sunEnabled: true, sunStart: '08:00', sunEnd: '17:00',
})

// Badge status ringkas di atas
const statusBadge = computed(() => {
  const f = form.value
  if (!f.outsideHoursEnabled && !f.greetEnabled) {
    return { text: '● Nonaktif', class: 'bg-gray-100 text-gray-500' }
  }
  const parts = []
  if (f.outsideHoursEnabled) parts.push('Outside hours ON')
  if (f.greetEnabled) parts.push('Greeting ON')
  const days = []
  if (f.monFriEnabled) days.push(`Sen–Jum ${f.monFriStart}–${f.monFriEnd}`)
  if (f.satEnabled) days.push(`Sab ${f.satStart}–${f.satEnd}`)
  if (f.sunEnabled) days.push(`Min ${f.sunStart}–${f.sunEnd}`)
  const jam = days.length > 0 ? days.join(' · ') : 'Jam operasional kosong'
  return { text: `● Aktif · ${parts.join(' + ')} · ${jam}`, class: 'bg-green-100 text-green-700' }
})

// Preview {name} → contoh nama "Kakak"
function preview(text) {
  return (text || '').replace(/\{name\}/g, 'Kakak')
}

async function fetchConfig() {
  try {
    const res = await axios.get(`${API}/api/autoreply`)
    const cfg = res.data.config
    for (const key of Object.keys(form.value)) {
      if (cfg[key] !== undefined) form.value[key] = cfg[key]
    }
    // v0.13.0 — greetMode default "text" bila backend belum punya kolom
    if (!form.value.greetMode) form.value.greetMode = 'text'
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Gagal memuat', message: e.response?.data?.error || 'Config tidak bisa dimuat' })
  } finally {
    loading.value = false
  }
}

async function save() {
  // Validasi ringan di client sebelum PUT
  for (const row of hourRows) {
    if (form.value[row.prefix + 'Enabled'] && form.value[row.prefix + 'Start'] >= form.value[row.prefix + 'End']) {
      toast.show({ icon: '⚠️', title: 'Jam tidak valid', message: `${row.label}: jam mulai harus lebih kecil dari jam selesai` })
      return
    }
  }
  saving.value = true
  try {
    const res = await axios.put(`${API}/api/autoreply`, form.value)
    const cfg = res.data.config
    // v0.13.2 — sinkron otomatis: mode menu → gateway ON; mode text → gateway OFF
    if (res.data.menuGatewayEnabled === true) {
      toast.show({ icon: '🔗', title: 'Menu Gateway aktif', message: 'Saklar di halaman Menu Gateway ikut menyala otomatis' })
    }
    for (const key of Object.keys(form.value)) {
      if (cfg[key] !== undefined) form.value[key] = cfg[key]
    }
    toast.show({ icon: '✅', title: 'Tersimpan', message: 'Config Auto Reply berhasil disimpan' })
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

onMounted(fetchConfig)
</script>