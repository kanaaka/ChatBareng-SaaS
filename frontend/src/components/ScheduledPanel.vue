<template>
  <!--
    v0.10.0 Fitur D — Panel "⏰ Terjadwal" di chat detail (collapsible, pola NotesPanel).
    List pending chat itu; cancel oleh pemilik/admin. Real-time via socket
    scheduled_added/scheduled_updated (listener Dashboard, state lewat props).
  -->
  <div class="m3-card p-3 flex flex-col min-h-0">
    <button
      v-if="collapsible"
      type="button"
      class="w-full flex items-center justify-between py-1 text-left"
      style="min-height: 44px;"
      @click="expanded = !expanded"
    >
      <span class="text-sm font-semibold text-gray-800">⏰ Terjadwal <span class="text-xs font-normal text-gray-400">({{ scheduled.length }})</span></span>
      <svg class="w-4 h-4 text-gray-400 transition-transform" :class="expanded ? 'rotate-180' : ''" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
      </svg>
    </button>
    <div v-else class="text-sm font-semibold text-gray-800 mb-2">⏰ Terjadwal</div>

    <div v-show="!collapsible || expanded" class="flex flex-col min-h-0">
      <div class="space-y-2" style="max-height: 220px; overflow-y: auto;">
        <div v-if="loading" class="text-center text-xs text-gray-400 py-2">Memuat...</div>
        <div v-else-if="scheduled.length === 0" class="text-center text-xs text-gray-400 py-2">
          Tidak ada pesan terjadwal untuk chat ini.
        </div>
        <div
          v-for="sm in scheduled"
          :key="sm.id"
          class="rounded-lg px-3 py-2 text-sm flex items-start justify-between gap-2"
          style="background: var(--md-sys-color-surface-container-high, #f3f0f7);"
        >
          <div class="min-w-0 flex-1">
            <div class="text-xs text-gray-500 mb-0.5">
              🕐 {{ formatWhen(sm.scheduledAt) }} · oleh @{{ sm.user?.username || sm.createdById }}
            </div>
            <div class="text-gray-800 whitespace-pre-wrap break-words">{{ sm.body }}</div>
          </div>
          <button
            v-if="canCancel(sm)"
            @click="$emit('cancel', sm.id)"
            class="text-xs text-red-600 hover:text-red-700 flex-shrink-0 px-2 py-1.5 rounded-lg hover:bg-red-50"
            style="min-height: 44px; min-width: 44px;"
            title="Batalkan pesan terjadwal"
          >
            Batalkan
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useAuthStore } from '../stores/auth'

const props = defineProps({
  scheduled: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  collapsible: { type: Boolean, default: false },
})
defineEmits(['cancel'])

const auth = useAuthStore()
const expanded = ref(false)

const sorted = computed(() => [...props.scheduled].sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt)))

function canCancel(sm) {
  return auth.isAdmin || sm.createdById === auth.user.id
}
function formatWhen(ts) {
  const d = new Date(ts)
  return d.toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}
</script>