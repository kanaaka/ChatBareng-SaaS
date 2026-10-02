<template>
  <!--
    v0.10.0 Fitur A — Dialog Snooze (M3 v0.9.0 design system).
    Preset chip: 15 menit · 1 jam · 3 jam · Besok 08:00 · Custom (datetime-local input).
    Emit 'confirm' { until: ISO string } / 'close'. Akses: assigned CS/admin (server juga cek).
  -->
  <Teleport to="body">
    <div class="m3-dialog-backdrop" @click.self="$emit('close')">
      <div role="dialog" aria-modal="true" aria-label="Snooze chat" class="m3-dialog" style="max-width: 420px; width: calc(100vw - 32px);">
        <h2 class="m3-dialog__headline">😴 Snooze chat</h2>
        <div class="m3-dialog__body">
          Tunda chat ini sampai waktu tertentu. Chat hilang dari list utama dan
          kembali otomatis tepat waktu.
        </div>

        <div class="flex flex-wrap gap-2 mb-3">
          <button
            v-for="p in presets"
            :key="p.label"
            type="button"
            :class="['m3-chip !min-h-[36px] !px-4 text-sm', selected === p.label ? 'm3-chip--selected' : '']"
            @click="choosePreset(p)"
          >
            {{ p.label }}
          </button>
        </div>

        <!-- Custom datetime -->
        <div v-if="isCustom" class="mb-3">
          <label class="block text-xs font-medium text-gray-600 mb-1">Waktu custom (WIB)</label>
          <input
            v-model="customValue"
            type="datetime-local"
            class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-wa-green min-h-[44px]"
            @keydown.enter="confirmCustom"
          />
        </div>

        <div v-if="error" class="text-xs text-red-600 mb-2">{{ error }}</div>

        <div class="m3-dialog__actions">
          <button type="button" class="m3-btn m3-btn--text" @click="$emit('close')">Batal</button>
          <button
            type="button"
            class="m3-btn m3-btn--filled"
            :disabled="!!(!selectedValue || (isCustom && !customValue))"
            @click="confirm"
          >
            Snooze
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
// v0.10.0 — Flatpickr belum ada di stack (dicek: tidak ada dependency flatpickr di
// frontend/package.json) → custom pakai <input type="datetime-local"> native (mobile-friendly,
// touch target ≥44px). Preset tetap chip M3 sesuai spec. WIB dihitung eksplisit.
import { ref, computed, onMounted, onUnmounted } from 'vue'

const props = defineProps({
  chat: { type: Object, default: null },
})
const emit = defineEmits(['confirm', 'close'])

const presets = [
  { label: '15 menit', minutes: 15 },
  { label: '1 jam', minutes: 60 },
  { label: '3 jam', minutes: 180 },
  { label: 'Besok 08:00', nextDay8: true },
  { label: 'Custom', custom: true },
]

const selected = ref('15 menit')
const customValue = ref('')
const error = ref('')
const isCustom = computed(() => selected.value === 'Custom')
const selectedValue = computed(() => {
  const p = presets.find(p => p.label === selected.value)
  if (!p) return null
  if (p.custom) return customValue.value || null
  return computePresetIso(p)
})

/** Preset → ISO. "Besok 08:00" dihitung di zona WIB eksplisit (bukan timezone server). */
function computePresetIso(p) {
  const now = new Date()
  if (p.minutes) return new Date(now.getTime() + p.minutes * 60 * 1000).toISOString()
  if (p.nextDay8) {
    // Tanggal besok di WIB
    const wibNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }))
    const besok = new Date(wibNow)
    besok.setDate(besok.getDate() + 1)
    besok.setHours(8, 0, 0, 0)
    // Konversi balik: WIB = UTC+7
    return new Date(besok.getTime() - 7 * 60 * 60 * 1000).toISOString()
  }
  return null
}

function choosePreset(p) {
  selected.value = p.label
  error.value = ''
  if (!p.custom) {
    // langsung konfirmasi untuk preset cepat (UX: sekali klik)
    emit('confirm', { until: computePresetIso(p) })
  }
}

function confirm() {
  if (isCustom.value) {
    if (!customValue.value) return
    // datetime-local (lokal browser) → anggap WIB user (Indonesia) — konversi ke ISO
    const d = new Date(customValue.value)
    if (isNaN(d.getTime())) {
      error.value = 'Waktu tidak valid'
      return
    }
    if (d.getTime() <= Date.now()) {
      error.value = 'Waktu harus di masa depan'
      return
    }
    emit('confirm', { until: d.toISOString() })
    return
  }
  if (selectedValue.value) emit('confirm', { until: selectedValue.value })
}
function confirmCustom() { if (isCustom.value) confirm() }

function onKeydown(e) {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => document.addEventListener('keydown', onKeydown))
onUnmounted(() => document.removeEventListener('keydown', onKeydown))
</script>