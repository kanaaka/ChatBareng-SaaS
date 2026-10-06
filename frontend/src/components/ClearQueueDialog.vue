<template>
  <!--
    v4.6.6 — Admin Clear Queue (spec docs/spec-v4.6.6-clear-queue.md §A2)
    Modal konfirmasi 2 langkah: (1) ringkasan live count + penjelasan semantik,
    (2) klik "Ya, kosongkan" → POST /api/chats/clear-queue { confirm:true }.
    HANYA admin tenant (dipasang dari Dashboard dgn v-if role admin). Pasca-sukses
    parent me-refresh list + queue count (socket queue_update + refetch eksplisit);
    remaining > 0 → modal dibuka lagi dengan sisa count (rolling clear, cap 2000).
    TIDAK mengirim pesan/CSAT apa pun ke pelanggan (housekeeping saja).
  -->
  <Teleport to="body">
    <Transition name="m3-fade">
      <div v-if="open" class="m3-dialog-backdrop" @click.self="close">
        <div
          role="alertdialog"
          aria-modal="true"
          aria-label="Kosongkan Antrean"
          class="m3-dialog"
          style="max-width: 380px"
        >
          <h2 class="m3-dialog__headline">Kosongkan Antrean</h2>

          <div class="m3-dialog__body">
            <template v-if="!result">
              <p class="text-sm text-gray-800 mb-2">
                Kosongkan <strong>{{ count.toLocaleString('id-ID') }}</strong> chat dari antrean?
              </p>
              <p class="text-xs text-gray-500">
                Semua chat di antrean akan <strong>di-resolusi &amp; di-assign ke kamu (admin)</strong> —
                muncul di history Resolved. <strong>TIDAK mengirim pesan/CSAT ke pelanggan.</strong>
              </p>
              <p v-if="error" class="text-xs mt-2" style="color: var(--md-sys-color-error)">{{ error }}</p>
            </template>
            <template v-else>
              <p class="text-sm text-gray-800">
                ✅ <strong>{{ result.cleared.toLocaleString('id-ID') }}</strong> chat diresolusi.
              </p>
              <p v-if="result.skipped?.length" class="text-xs text-gray-500 mt-1">
                {{ result.skipped.length }} chat di-skip (diambil agent lain / error).
              </p>
              <p v-if="result.remaining > 0" class="text-xs mt-2" style="color: var(--md-sys-color-error)">
                <strong>{{ result.remaining.toLocaleString('id-ID') }}</strong> chat belum terproses (batas 2.000 per klik / sedang diambil agent lain).
              </p>
            </template>
          </div>

          <div class="m3-dialog__actions">
            <button type="button" class="m3-btn m3-btn--text" :disabled="busy" @click="close">
              {{ result ? 'Tutup' : 'Batal' }}
            </button>
            <button
              v-if="!result || result.remaining > 0"
              type="button"
              class="m3-btn m3-btn--filled"
              :disabled="busy || count === 0"
              @click="clear"
            >
              {{ busy ? 'Memproses…' : 'Ya, kosongkan' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { ref, watch } from 'vue'
import axios from 'axios'
import { useToastStore } from '../stores/toast'

const API = import.meta.env.VITE_API_URL || ''

const props = defineProps({
  open: { type: Boolean, default: false },
  count: { type: Number, default: 0 },
})
const emit = defineEmits(['close', 'cleared'])

const toastStore = useToastStore()
const busy = ref(false)
const error = ref('')
const result = ref(null)

watch(() => props.open, (o) => {
  if (o) { error.value = ''; result.value = null }
})

function close() {
  if (busy.value) return
  emit('close')
}

async function clear() {
  if (busy.value || props.count === 0) return
  busy.value = true
  error.value = ''
  try {
    const res = await axios.post(`${API}/api/chats/clear-queue`, { confirm: true })
    result.value = res.data
    // Spec §A2 — pasca-sukses: toast "N chat diresolusi"
    toastStore.show({
      icon: '🧹',
      title: 'Antrean dikosongkan',
      message: `${res.data.cleared} chat diresolusi${res.data.remaining > 0 ? ` — sisa ${res.data.remaining}` : ''}`,
    })
    emit('cleared', res.data)
  } catch (e) {
    error.value = e.response?.data?.error || e.message || 'Gagal mengosongkan antrean'
  } finally {
    busy.value = false
  }
}
</script>