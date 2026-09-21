<template>
  <!--
    v0.9.0 — Admin Appearance (spec §1a): kartu "🎨 Tampilan" sebagai halaman sendiri.
    Preset swatches (Ungu Parahita/Merah Kreatr/Hijau WA/Biru/Teal/Orange) + custom hex
    + preview mini light/dark. PUT /api/appearance (admin) → server generate skema →
    GET /theme.css berubah global TANPA rebuild frontend.
  -->
  <PageShell title="Tampilan" back-to="/admin">
    <header class="hidden md:flex m3-topbar px-4 py-3 items-center justify-between">
      <div class="flex items-center gap-3">
        <h1 class="text-lg font-semibold">Tampilan</h1>
      </div>
      <div class="flex items-center gap-4">
        <button @click="handleLogout" class="text-sm hover:underline m3-topbar__link">Logout</button>
      </div>
    </header>

    <div class="max-w-3xl mx-auto w-full p-6 space-y-4">
      <div class="m3-card p-6">
        <h2 class="text-lg font-semibold mb-1">Warna Aksen</h2>
        <p class="text-sm text-gray-500 mb-4">
          Skema light + dark di seluruh aplikasi diregenerasi otomatis dari warna ini — tanpa rebuild.
        </p>

        <!-- Preset swatches -->
        <div class="flex flex-wrap gap-3 mb-6">
          <button
            v-for="p in presets"
            :key="p.hex"
            type="button"
            class="m3-btn m3-btn--outlined !px-3 !min-h-[44px] text-sm"
            :class="{ 'ring-2': current === p.hex }"
            :style="current === p.hex ? { borderColor: 'var(--md-sys-color-primary)' } : {}"
            @click="selectPreset(p)"
          >
            <span class="w-5 h-5 rounded-full inline-block border border-gray-300" :style="{ background: p.hex }"></span>
            {{ p.name }}
          </button>
        </div>

        <!-- Custom hex — v0.9.0-r2 (audit fix #1): M3TextField floating label -->
        <label class="block text-sm font-medium mb-1">Warna khusus (hex)</label>
        <div class="flex items-center gap-2 mb-6">
          <M3TextField
            v-model="customHex"
            label="Hex (#6D28D9)"
            type="text"
            maxlength="7"
            class="w-44"
            @update:model-value="current = customHex.trim()"
          />
          <input
            type="color"
            :value="safeColor"
            class="w-12 h-11 rounded cursor-pointer bg-transparent"
            aria-label="Pilih warna"
            @input="customHex = $event.target.value.toUpperCase(); current = customHex"
          />
          <button
            type="button"
            class="m3-btn m3-btn--filled"
            :disabled="!isValidHex || saving || current === savedSeed"
            @click="save"
          >
            {{ saving ? 'Menyimpan…' : 'Terapkan' }}
          </button>
        </div>

        <!-- Preview mini light/dark -->
        <div class="grid grid-cols-2 gap-3">
          <div class="rounded-[var(--md-sys-shape-corner-m)] border border-gray-200 p-4" :style="{ background: previewLight.surface }">
            <div class="text-[10px] font-semibold uppercase tracking-wide mb-2" :style="{ color: previewLight.outline }">Preview — Light</div>
            <div class="rounded-full px-3 py-1.5 text-xs font-medium inline-block mb-2" :style="{ background: previewLight.primary, color: previewLight.onPrimary }">Tombol utama</div>
            <div class="rounded-[var(--md-sys-shape-corner-s)] p-2 text-xs" :style="{ background: previewLight.primaryContainer, color: previewLight.onPrimaryContainer }">Primary container</div>
          </div>
          <div class="rounded-[var(--md-sys-shape-corner-m)] border border-gray-200 p-4" :style="{ background: previewDark.surface }">
            <div class="text-[10px] font-semibold uppercase tracking-wide mb-2" :style="{ color: previewDark.outline }">Preview — Dark</div>
            <div class="rounded-full px-3 py-1.5 text-xs font-medium inline-block mb-2" :style="{ background: previewDark.primary, color: previewDark.onPrimary }">Tombol utama</div>
            <div class="rounded-[var(--md-sys-shape-corner-s)] p-2 text-xs" :style="{ background: previewDark.primaryContainer, color: previewDark.onPrimaryContainer }">Primary container</div>
          </div>
        </div>

        <p v-if="info" class="text-sm mt-4" :style="{ color: 'var(--md-sys-color-success)' }">✓ {{ info }}</p>
        <p v-if="error" class="text-sm mt-4" :style="{ color: 'var(--md-sys-color-error)' }">⚠️ {{ error }}</p>
      </div>
    </div>
  </PageShell>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import axios from 'axios'
import PageShell from '../components/PageShell.vue'
import M3TextField from '../components/M3TextField.vue'
import { useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'
import { buildPreview } from '../utils/appearancePreview'
import { syncThemeColorMeta } from '../utils/themeColor'

const API = import.meta.env.VITE_API_URL || ''
const auth = useAuthStore()
const toast = useToastStore()

const presets = [
  { name: 'Ungu Parahita', hex: '#6D28D9' },
  { name: 'Merah Kreatr', hex: '#C72C48' },
  { name: 'Hijau WA', hex: '#25D366' },
  { name: 'Biru', hex: '#1565C0' },
  { name: 'Teal', hex: '#00897B' },
  { name: 'Orange', hex: '#EF6C00' },
]

const current = ref('#6D28D9')
const customHex = ref('#6D28D9')
const savedSeed = ref('#6D28D9')
const saving = ref(false)
const info = ref('')
const error = ref('')

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
const isValidHex = computed(() => HEX_RE.test((current.value || '').trim()))
const safeColor = computed(() => isValidHex.value ? current.value : '#6D28D9')

const previewLight = computed(() => buildPreview(current.value, false))
const previewDark = computed(() => buildPreview(current.value, true))

function selectPreset(p) {
  current.value = p.hex
  customHex.value = p.hex
}

async function save() {
  info.value = ''
  error.value = ''
  if (!isValidHex.value) {
    error.value = 'Format hex tidak valid — contoh #6D28D9'
    return
  }
  saving.value = true
  try {
    const seed = current.value.trim().toUpperCase()
    const res = await axios.put(`${API}/api/appearance`, { accentSeed: seed })
    savedSeed.value = res.data.config.accentSeed
    info.value = `Accent diterapkan: ${savedSeed.value} — reload halaman untuk melihat di seluruh app.`
    // v0.12.7 — meta theme-color di-update live (status bar Android ikut tanpa reload);
    // manifest dinamis ikut berubah via server (invalidate cache /theme.css + max-age=60)
    syncThemeColorMeta()
    toast.show({ icon: '🎨', title: 'Tersimpan', message: `Accent ${savedSeed.value} aktif` })
  } catch (e) {
    error.value = e.response?.data?.error || 'Gagal menyimpan accent'
  } finally {
    saving.value = false
  }
}

async function load() {
  try {
    const res = await axios.get(`${API}/api/appearance`)
    const seed = res.data.config.accentSeed
    current.value = seed
    customHex.value = seed
    savedSeed.value = seed
  } catch (e) {
    console.error('Load appearance error:', e)
  }
}

function handleLogout() {
  auth.logout()
  window.location.href = '/login'
}

onMounted(load)
</script>
