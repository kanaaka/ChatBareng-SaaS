<template>
  <!--
    v0.10.0 Fitur C — Admin "⭐ CSAT Survey" (pola AdminAutoReply v0.7.0).
    Toggle ON/OFF + editor pesan (maks 1000 char, support {name}) + preview.
    Default OFF — pelanggan asli yang menerima pesan, jadi Kanaka yang menyalakan.
  -->
  <PageShell title="CSAT Survey" back-to="/admin">
    <header class="hidden md:flex m3-topbar px-4 py-3 items-center justify-between">
      <div class="flex items-center gap-3">
        <h1 class="text-lg font-semibold">CSAT Survey</h1>
      </div>
      <div class="flex items-center gap-4">
        <button @click="handleLogout" class="text-sm hover:underline">Logout</button>
      </div>
    </header>

    <div class="max-w-4xl mx-auto w-full p-6 space-y-4">
      <!-- Kartu toggle utama -->
      <div class="bg-white rounded-lg shadow-sm p-6">
        <div class="flex items-center justify-between gap-4">
          <div>
            <h2 class="font-semibold text-gray-900 flex items-center gap-2">⭐ CSAT Survey</h2>
            <p class="text-xs text-gray-500 mt-1">
              Setelah chat di-resolve, pelanggan otomatis menerima pesan survey rating 1–5.
              Balasan angka tersimpan ke dashboard Analytics.
            </p>
          </div>
          <M3Switch v-model="form.enabled" :disabled="saving" />
        </div>
        <div class="mt-3">
          <span :class="['inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium', form.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500']">
            {{ form.enabled ? '● Aktif — survey terkirim saat resolve' : '● Nonaktif — resolve TIDAK mengirim apa pun' }}
          </span>
        </div>
      </div>

      <!-- Editor pesan -->
      <div class="bg-white rounded-lg shadow-sm p-6">
        <h2 class="font-semibold text-gray-900 mb-2">Pesan Survey</h2>
        <p class="text-xs text-gray-500 mb-3">
          Maksimal 1000 karakter. Placeholder <code class="bg-gray-100 px-1 rounded">{name}</code> diganti nama pelanggan (dihapus + dibersihkan kalau kosong).
        </p>
        <textarea
          v-model="form.message"
          rows="4"
          maxlength="1000"
          class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          placeholder="Teks pesan survey..."
        ></textarea>
        <div class="flex items-center justify-between mt-1">
          <span class="text-xs text-gray-400">{{ (form.message || '').length }}/1000</span>
        </div>
        <div class="mt-3 p-3 rounded-lg text-sm" style="background: var(--md-sys-color-surface-container-high, #f3f0f7);">
          <div class="text-xs font-medium text-gray-500 mb-1">Preview:</div>
          <div class="italic text-gray-800">{{ preview(form.message) }}</div>
        </div>
      </div>

      <!-- v0.10.6 — Anti-spam (cooldown) configurable: mode + jam, ganti kapan pun tanpa Alita -->
      <div class="bg-white rounded-lg shadow-sm p-6">
        <h2 class="font-semibold text-gray-900 mb-2">Anti-Spam (Cooldown Survey)</h2>
        <p class="text-xs text-gray-500 mb-3">
          Aturan kapan chat yang sama boleh dapat survey lagi setelah di-resolve. Anti-spam, anti loop.
        </p>
        <div class="flex flex-col sm:flex-row gap-3">
          <label class="flex-1">
            <span class="text-xs text-gray-600 block mb-1">Mode</span>
            <select
              v-model="form.cooldownMode"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
              style="min-height: 44px;"
            >
              <option value="per_chat">Per chat (A) — 1 survey / N jam / chat</option>
              <option value="per_agent">Per agent (B) — beda agent boleh survey baru</option>
              <option value="hybrid">Hybrid (C) — beda agent boleh, agent sama cooldown</option>
            </select>
          </label>
          <label class="sm:w-36">
            <span class="text-xs text-gray-600 block mb-1">Jam cooldown</span>
            <input
              v-model.number="form.cooldownHours"
              type="number"
              min="0"
              max="168"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              style="min-height: 44px;"
            />
          </label>
        </div>
        <div class="mt-2 text-xs text-gray-400">
          {{ cooldownHint }} · 0 jam = cooldown mati (survey keluar tiap resolve)
        </div>
      </div>

      <!-- Simpan -->
      <div class="flex justify-end">
        <button
          @click="save"
          :disabled="saving"
          class="px-6 py-2.5 bg-wa-green text-white rounded-lg text-sm font-medium hover:bg-green-600 disabled:opacity-50"
          style="min-height: 44px;"
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
import M3Switch from '../components/M3Switch.vue'

const API = import.meta.env.VITE_API_URL || ''
const auth = useAuthStore()
const toast = useToastStore()

const saving = ref(false)
const form = ref({
  enabled: false,
  message: '',
  cooldownMode: 'per_chat',
  cooldownHours: 24,
})

const cooldownHint = computed(() => {
  const m = form.value.cooldownMode
  const h = form.value.cooldownHours
  if (m === 'per_chat') return `Chat yang sama hanya dapat survey baru setelah ${h} jam (apapun agent-nya)`
  if (m === 'per_agent') return `Survey baru boleh jika ditangani agent BERBEDA; agent sama tunggu ${h} jam`
  return `Agent sama tunggu ${h} jam; beda agent langsung boleh survey baru`
})

function preview(text) {
  return (text || '').replace(/\{name\}/g, 'Kakak')
}

async function fetchConfig() {
  try {
    const res = await axios.get(`${API}/api/csat/config`)
    form.value.enabled = res.data.config.enabled
    form.value.message = res.data.config.message
    form.value.cooldownMode = res.data.config.cooldownMode || 'per_chat'
    form.value.cooldownHours = res.data.config.cooldownHours ?? 24
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Gagal memuat', message: e.response?.data?.error || 'Config tidak bisa dimuat' })
  }
}

async function save() {
  saving.value = true
  try {
    const res = await axios.put(`${API}/api/csat/config`, {
      enabled: form.value.enabled,
      message: form.value.message,
      cooldownMode: form.value.cooldownMode,
      cooldownHours: form.value.cooldownHours,
    })
    form.value.enabled = res.data.config.enabled
    form.value.message = res.data.config.message
    form.value.cooldownMode = res.data.config.cooldownMode || 'per_chat'
    form.value.cooldownHours = res.data.config.cooldownHours ?? 24
    toast.show({ icon: '✅', title: 'Tersimpan', message: 'Config CSAT berhasil disimpan' })
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
