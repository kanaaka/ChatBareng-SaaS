<template>
  <!--
    v0.9.0 — QueueBanner reskin M3: logika v0.2.0 TIDAK berubah (v-if="count > 0",
    canTake dari store — banner tersembunyi saat antrean kosong). Position tetap
    fixed bottom DI ATAS homerow; tombol M3 filled dengan target ≥44px.
  -->
  <div
    v-if="count > 0 && canTake"
    class="md:hidden fixed left-0 right-0 z-40 px-3"
    style="bottom: calc(56px + env(safe-area-inset-bottom, 0px));"
  >
    <div class="elev-2 rounded-[var(--md-sys-shape-corner-m)] px-4 py-3 flex items-center justify-between"
      :style="{ background: 'var(--md-sys-color-primary-container)', color: 'var(--md-sys-color-on-primary-container)' }"
    >
      <span class="text-sm font-medium">📨 {{ count }} chat baru di antrean</span>
      <button
        @click="$emit('take')"
        :disabled="taking"
        class="m3-btn m3-btn--filled !min-h-[44px] !px-5 text-sm disabled:opacity-50"
      >
        {{ taking ? 'Taking...' : 'Take' }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useAuthStore } from '../stores/auth'

defineProps({
  count: { type: Number, default: 0 },
  taking: { type: Boolean, default: false },
})
defineEmits(['take'])

// v0.2.0 — canTake dari auth store (relay/Cabang tidak bisa take)
const auth = useAuthStore()
const canTake = computed(() => auth.canTake)
</script>