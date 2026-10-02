<!--
  v3.9.23 — Summary Sesi (AI Chat Summary): modal hasil.
  Dipakai ChatDetail.vue — tombol 🤖 dirender ChatDetail (desktop quick-actions
  + mobile header baris kedua); komponen ini CUMA modal + logika generate,
  JANGAN render tombol sendiri (fix duplikat tombol versi abort Dory).
  Render summaryText APA ADANYA ({{ }} — NO v-html,
  pola audit v3.9.19); template 'standard' → baris heading "NAMA:" di-bold
  via parsing sederhana per baris (tetap text interpolation).
  Footer: model · template · via fallback · Xs. Aksi: Salin Semua / Simpan ke
  Catatan (endpoint ChatNote existing, parent yang panggil via emit) /
  Regenerate (429 → tampil sisa detik) / Tutup.
-->
<template>
  <Teleport to="body">
    <div v-if="openState" class="fixed inset-0 z-50 flex items-center justify-center p-3" style="background: rgba(0,0,0,0.45);" @click.self="close">
      <div class="bg-white rounded-xl shadow-2xl w-full max-w-lg flex flex-col" style="max-height: 85vh;">
        <div class="px-4 py-3 border-b border-gray-100 flex items-center justify-between flex-shrink-0">
          <h3 class="font-semibold text-gray-900 flex items-center gap-2">🤖 Summary Sesi</h3>
          <button @click="close" class="text-gray-400 hover:text-gray-600 p-1" title="Tutup">✕</button>
        </div>

        <div class="px-4 py-4 overflow-y-auto flex-1 min-h-0">
          <!-- Loading -->
          <div v-if="loading" class="flex items-center justify-center gap-2 py-10 text-gray-500">
            <svg class="w-5 h-5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v1m6 0v1m-6 2h6m-6 2h6m-6 2h6M6 8h.01M6 12h.01M6 16h.01" />
            </svg>
            <span>Merangkum…</span>
          </div>

          <!-- Error inline per code -->
          <div v-else-if="errorMsg" class="rounded-lg p-3 text-sm" style="background: var(--md-sys-color-error-container); color: var(--md-sys-color-on-error-container);">
            {{ errorMsg }}
            <div class="mt-2" v-if="canRetry">
              <button @click="generate" class="px-3 py-1.5 rounded bg-white/60 text-xs font-medium hover:bg-white/80">Coba lagi</button>
            </div>
          </div>

          <!-- 429 cooldown → sisa detik -->
          <div v-else-if="cooldownLeft > 0" class="rounded-lg p-3 text-sm bg-amber-50 text-amber-800">
            Tunggu {{ cooldownLeft }} detik lagi sebelum merangkum ulang chat ini.
          </div>

          <!-- Hasil -->
          <div v-else-if="result">
            <div class="text-sm text-gray-800 whitespace-pre-line break-words" style="overflow-wrap: anywhere;">
              <template v-for="(line, i) in summaryLines" :key="i">
                <span v-if="line.bold" class="font-semibold">{{ line.text }}</span>
                <template v-else>{{ line.text }}</template>
              </template>
            </div>
            <div class="mt-3 pt-2 border-t border-gray-100 text-xs text-gray-400 flex flex-wrap gap-x-1">
              <span>{{ result.model }}</span><span>·</span>
              <span>template {{ templateLabel }}</span>
              <template v-if="result.viaFallback"><span>·</span><span>via fallback lokal</span></template>
              <span>·</span><span>{{ ((result.latencyMs || 0) / 1000).toFixed(1) }}s</span>
            </div>
          </div>

          <!-- Empty state -->
          <div v-else class="text-center text-gray-400 py-6 text-sm">
            Klik "Buat Ringkasan" untuk merangkum sesi ini dengan AI.
            <div class="mt-3">
              <button @click="generate" class="px-4 py-2 rounded-lg bg-wa-green text-white text-sm font-medium hover:bg-green-600">Buat Ringkasan</button>
            </div>
          </div>
        </div>

        <div class="px-4 py-3 border-t border-gray-100 flex flex-wrap items-center gap-2 flex-shrink-0" style="padding-bottom: max(12px, env(safe-area-inset-bottom, 0px));">
          <button
            @click="copyAll"
            :disabled="!result"
            class="px-3 py-1.5 rounded-lg bg-gray-100 text-gray-700 text-xs font-medium hover:bg-gray-200 disabled:opacity-50"
          >{{ copied ? '✓ Tersalin' : 'Salin Semua' }}</button>
          <button
            v-if="canWriteNotes"
            @click="saveAsNote"
            :disabled="!result || savingNote"
            class="px-3 py-1.5 rounded-lg bg-purple-100 text-purple-700 text-xs font-medium hover:bg-purple-200 disabled:opacity-50"
          >{{ savingNote ? 'Menyimpan…' : 'Simpan ke Catatan' }}</button>
          <button
            @click="generate"
            :disabled="loading || cooldownLeft > 0"
            class="px-3 py-1.5 rounded-lg bg-blue-100 text-blue-700 text-xs font-medium hover:bg-blue-200 disabled:opacity-50"
          >{{ cooldownLeft > 0 ? `Tunggu ${cooldownLeft}s` : 'Regenerate' }}</button>
          <button @click="close" class="ml-auto px-3 py-1.5 rounded-lg text-gray-500 text-xs font-medium hover:bg-gray-100">Tutup</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed, onUnmounted } from 'vue'
import axios from 'axios'
import { useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'

const props = defineProps({
  chatId: { type: Number, default: null },
  // window kosong (chat resolved tanpa pesan baru / tanpa pesan) → tombol disabled
  windowAvailable: { type: Boolean, default: true },
  isMobile: { type: Boolean, default: false },
  // Simpan-ke-Catatan hanya utk assigned CS/admin (same permission dgn notes panel)
  canWriteNotes: { type: Boolean, default: true },
})
const emit = defineEmits(['saved'])

const API = import.meta.env.VITE_API_URL || ''
const auth = useAuthStore()
const toast = useToastStore()

const openState = ref(false)
const loading = ref(false)
const errorMsg = ref('')
const errorCode = ref(null)
const result = ref(null)
const copied = ref(false)
const savingNote = ref(false)
const cooldownLeft = ref(0)
let cooldownTimer = null

const TEMPLATE_LABELS = {
  standard: 'standard', ringkas: 'ringkas', handoff: 'handoff',
  medis: 'medis', penjualan: 'penjualan', keluhan: 'keluhan', custom: 'instruksi sendiri',
}
const templateLabel = computed(() => TEMPLATE_LABELS[result.value?.templateUsed] || result.value?.templateUsed || '-')
const canRetry = computed(() => ['TIMEOUT', 'NETWORK', 'UPSTREAM_5XX'].includes(errorCode.value))

// NO v-html — baris 'RINGKASAN:' dll di-bold via parse sederhana (template standard 4 blok).
const HEADING_RE = /^(RINGKASAN|KEBUTUHAN CUSTOMER|TINDAKAN CS|STATUS & LANGKAH LANJUT)\s*:/
const summaryLines = computed(() => {
  const text = result.value?.summaryText || ''
  const out = []
  let boldRun = null
  for (const line of String(text).split('\n')) {
    const m = HEADING_RE.exec(line)
    if (m) {
      if (boldRun !== null) out.push({ text: boldRun, bold: false })
      boldRun = null
      out.push({ text: m[1] + ':', bold: true })
      out.push({ text: line.slice(m[0].length) + '\n', bold: false })
    } else {
      if (boldRun === null) boldRun = line
      else boldRun += '\n' + line
    }
  }
  if (boldRun !== null) out.push({ text: boldRun, bold: false })
  return out.length ? out : [{ text, bold: false }]
})

function startCooldown(seconds) {
  cooldownLeft.value = seconds
  clearInterval(cooldownTimer)
  cooldownTimer = setInterval(() => {
    cooldownLeft.value -= 1
    if (cooldownLeft.value <= 0) clearInterval(cooldownTimer)
  }, 1000)
}
onUnmounted(() => clearInterval(cooldownTimer))

function open() {
  openState.value = true
  if (!result.value && !loading.value && !errorMsg.value && cooldownLeft.value <= 0) generate()
}
function close() {
  openState.value = false
}

async function generate() {
  if (!props.chatId || loading.value || cooldownLeft.value > 0) return
  loading.value = true
  errorMsg.value = ''
  errorCode.value = null
  result.value = null
  try {
    const { data } = await axios.post(`${API}/api/chats/${props.chatId}/summary`, {}, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    result.value = data
  } catch (e) {
    const code = e.response?.data?.code
    const status = e.response?.status
    errorCode.value = code || null
    if (status === 429) {
      const ra = Number(e.response?.data?.retryAfter) || 30
      startCooldown(ra)
      errorMsg.value = `Baru saja merangkum — tunggu ${ra} detik lagi.`
    } else if (code === 'NO_CONFIG') {
      errorMsg.value = 'AI belum dikonfigurasi. Hubungi admin platform.'
    } else if (code === 'AUTH_401') {
      errorMsg.value = 'API key tidak valid. Hubungi admin platform.'
    } else if (code === 'TIMEOUT' || code === 'NETWORK' || code === 'UPSTREAM_5XX') {
      errorMsg.value = e.response?.data?.error || 'Server AI tidak bisa dihubungi — coba lagi.'
    } else if (code === 'EMPTY_WINDOW') {
      errorMsg.value = e.response?.data?.error || 'Tidak ada pesan untuk dirangkum di sesi ini.'
    } else if (status === 404) {
      errorMsg.value = 'Chat tidak ditemukan.'
    } else {
      errorMsg.value = e.response?.data?.error || 'Gagal membuat ringkasan — coba lagi.'
    }
  } finally {
    loading.value = false
  }
}

async function copyAll() {
  if (!result.value) return
  try {
    await navigator.clipboard.writeText(result.value.summaryText || '')
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch {
    toast.show({ icon: '⚠️', title: 'Gagal menyalin', message: 'Clipboard tidak tersedia — coba lagi.' })
  }
}

// Simpan ke Catatan = REUSE endpoint ChatNote existing (spec §D — ZERO schema baru).
async function saveAsNote() {
  if (!result.value || savingNote.value) return
  savingNote.value = true
  try {
    const stamp = `🤖 Summary Sesi (${new Date().toLocaleString('id-ID')}):`
    await axios.post(`${API}/api/chats/${props.chatId}/notes`, { body: `${stamp}\n${result.value.summaryText}` }, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    toast.show({ icon: '✅', title: 'Tersimpan ke catatan' })
    emit('saved')
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Gagal simpan catatan', message: e.response?.data?.error || e.message })
  } finally {
    savingNote.value = false
  }
}

defineExpose({ open, close, generate })
</script>