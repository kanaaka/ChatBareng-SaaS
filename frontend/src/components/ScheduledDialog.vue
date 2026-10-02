<template>
  <!--
    v0.10.0 Fitur D — Dialog Pesan Terjadwal (M3 v0.9.0 design system).
    Textarea prefill dari draft reply + datetime-local (WIB) + tombol "Jadwalkan".
    Validasi: scheduledAt > now + 2 menit (server juga validasi), body ≤ 4000 char.
  -->
  <Teleport to="body">
    <div class="m3-dialog-backdrop" @click.self="$emit('close')">
      <div role="dialog" aria-modal="true" aria-label="Jadwalkan pesan" class="m3-dialog" style="max-width: 460px; width: calc(100vw - 32px);">
        <h2 class="m3-dialog__headline">⏰ Jadwalkan pesan</h2>
        <div class="m3-dialog__body">
          Pesan dikirim otomatis pada waktu yang dipilih. Bisa dibatalkan sebelum terkirim.
        </div>

        <div class="space-y-3 mb-2">
          <div>
            <label class="block text-xs font-medium text-[var(--md-sys-color-on-surface-variant)] mb-1">Isi pesan</label>
            <textarea
              :value="body"
              @input="$emit('update:body', $event.target.value)"
              rows="4"
              maxlength="4000"
              placeholder="Isi pesan terjadwal..."
              class="w-full px-3 py-2.5 border border-[var(--md-sys-color-outline)] rounded-lg text-sm text-[var(--md-sys-color-on-surface)] placeholder:text-[var(--md-sys-color-on-surface-variant)] focus:outline-none focus:ring-2 focus:ring-wa-green resize-none"
            ></textarea>
            <div class="text-[10px] text-[var(--md-sys-color-on-surface-variant)] text-right">{{ (body || '').length }}/4000</div>
          </div>
          <div>
            <label class="block text-xs font-medium text-[var(--md-sys-color-on-surface-variant)] mb-1">Waktu kirim (WIB)</label>
            <input
              v-model="when"
              type="datetime-local"
              class="w-full px-3 py-2.5 border border-[var(--md-sys-color-outline)] rounded-lg text-sm text-[var(--md-sys-color-on-surface)] focus:outline-none focus:ring-2 focus:ring-wa-green min-h-[44px]"
            />
            <div v-if="when && minNote" class="text-[10px] text-[var(--md-sys-color-on-surface-variant)] mt-1">{{ minNote }}</div>
          </div>
        </div>

        <div v-if="error" class="text-xs text-red-600 mb-2">{{ error }}</div>

        <div class="m3-dialog__actions">
          <button type="button" class="m3-btn m3-btn--text" @click="$emit('close')">Batal</button>
          <button type="button" class="m3-btn m3-btn--filled" :disabled="busy || !canSubmit" @click="submit">
            {{ busy ? 'Menyimpan...' : 'Jadwalkan' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'

const props = defineProps({
  body: { type: String, default: '' },
  busy: { type: Boolean, default: false },
})
const emit = defineEmits(['confirm', 'close', 'update:body'])

const when = ref('')
const error = ref('')

const canSubmit = computed(() => {
  return (props.body || '').trim().length > 0 && !!when.value && !error.value
})

const minNote = computed(() => {
  if (!when.value) return null
  const d = new Date(when.value)
  if (isNaN(d.getTime())) return 'Waktu tidak valid'
  const diffMin = Math.round((d.getTime() - Date.now()) / 60000)
  if (diffMin <= 2) return 'Minimal 2 menit dari sekarang'
  return `Terkirim dalam ~${diffMin} menit`
})

function submit() {
  error.value = ''
  if (!(props.body || '').trim()) {
    error.value = 'Isi pesan tidak boleh kosong'
    return
  }
  if ((props.body || '').length > 4000) {
    error.value = 'Pesan maksimal 4000 karakter'
    return
  }
  const d = new Date(when.value)
  if (!when.value || isNaN(d.getTime())) {
    error.value = 'Waktu tidak valid'
    return
  }
  if (d.getTime() <= Date.now() + 2 * 60 * 1000) {
    error.value = 'Waktu terjadwal minimal 2 menit dari sekarang'
    return
  }
  emit('confirm', { body: props.body.trim(), scheduledAt: d.toISOString() })
}

function onKeydown(e) {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => document.addEventListener('keydown', onKeydown))
onUnmounted(() => document.removeEventListener('keydown', onKeydown))
</script>