<template>
  <!--
    v0.10.0 Fitur B — Panel Catatan Internal per chat (shared, TIDAK terkirim ke pelanggan).
    Desktop: section di panel kanan chat detail. Mobile: collapsible di atas composer.
    Kartu note = surface-variant M3; delete hanya penulis/admin; real-time via socket
    note_added/note_deleted (listener di Dashboard, state di sini via props).
  -->
  <div class="m3-card p-3 flex flex-col min-h-0" :class="compact ? '' : 'h-full'">
    <button
      v-if="collapsible"
      type="button"
      class="w-full flex items-center justify-between py-1 text-left"
      style="min-height: 44px;"
      @click="expanded = !expanded"
    >
      <span class="text-sm font-semibold text-gray-800">📝 Catatan <span class="text-xs font-normal text-gray-400">({{ notes.length }})</span></span>
      <svg class="w-4 h-4 text-gray-400 transition-transform" :class="expanded ? 'rotate-180' : ''" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
      </svg>
    </button>
    <div v-else class="text-sm font-semibold text-gray-800 mb-2">📝 Catatan</div>

    <div v-show="!collapsible || expanded" class="flex flex-col min-h-0 flex-1">
      <!-- List notes (terbaru di bawah — spec: "urut terbaru di bawah")
           v0.12.12 — maks ~2 kartu kelihatan, sisanya scroll (mobile + desktop, permintaan
           Kanaka: 3+ catatan menumpuk makan space). Body kartu di-clamp 2 baris biar
           tinggi kartu seragam. -->
      <div class="overflow-y-auto flex-1 min-h-0 space-y-2 mb-2" style="max-height: 152px;">
        <div v-if="loading" class="text-center text-xs text-gray-400 py-2">Memuat catatan...</div>
        <div v-else-if="sortedNotes.length === 0" class="text-center text-xs text-gray-400 py-3">
          Belum ada catatan. Catatan hanya terlihat tim — tidak dikirim ke pelanggan.
        </div>
        <div
          v-for="note in sortedNotes"
          :key="note.id"
          class="rounded-lg px-3 py-2 text-sm"
          style="background: var(--md-sys-color-surface-container-high, #f3f0f7);"
        >
          <div class="flex items-center justify-between gap-2 mb-0.5">
            <span class="text-xs font-medium text-gray-700 truncate">@{{ note.user?.username || '?' }}</span>
            <span class="flex items-center gap-1 flex-shrink-0">
              <span class="text-[10px] text-gray-400">{{ formatNoteTime(note.createdAt) }}</span>
              <button
                v-if="canDelete(note)"
                @click="$emit('delete-note', note.id)"
                class="text-gray-400 hover:text-red-500 p-0.5"
                :title="note.userId === auth.user.id ? 'Hapus catatan' : 'Hapus (admin)'"
                style="min-width: 24px; min-height: 24px;"
              >🗑</button>
            </span>
          </div>
          <div class="text-gray-800 whitespace-pre-wrap break-words line-clamp-2" :title="note.body">{{ note.body }}</div>
        </div>
      </div>

      <!-- Input tambah — v0.12.12: tombol selaras penuh dgn textarea (items-stretch),
           counter dipindah ke bawah row (dulu ikut di flex row → tombol "tenggelam" nggak lurus) -->
      <div v-if="canWrite">
        <div class="flex items-stretch gap-2">
          <textarea
            :value="draft"
            @input="$emit('update:draft', $event.target.value)"
            @keydown.enter.exact.prevent="$emit('add-note')"
            rows="2"
            maxlength="2000"
            placeholder="Tulis catatan internal..."
            class="flex-1 min-w-0 px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-wa-green resize-none"
          ></textarea>
          <button
            @click="$emit('add-note')"
            :disabled="!(draft || '').trim() || adding"
            class="m3-btn m3-btn--filled !min-h-[44px] !px-4 flex-shrink-0 self-stretch inline-flex items-center justify-center"
          >
            {{ adding ? '...' : 'Simpan' }}
          </button>
        </div>
        <div class="text-[10px] text-gray-400 text-right mt-0.5">{{ (draft || '').length }}/2000</div>
      </div>
      <div v-else class="text-xs text-gray-400 italic py-1">
        Hanya CS yang pegang chat atau admin yang bisa menambah catatan.
      </div>
    </div>
  </div>
</template>

<script setup>
// v0.10.0 — Semua aksi di-emit ke Dashboard (satu sumber state/logika).
import { ref, computed } from 'vue'
import { useAuthStore } from '../stores/auth'
import { formatTime } from '../utils/format'

const props = defineProps({
  notes: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  adding: { type: Boolean, default: false },
  draft: { type: String, default: '' },
  canWrite: { type: Boolean, default: false },
  collapsible: { type: Boolean, default: false },
  compact: { type: Boolean, default: false },
})
defineEmits(['add-note', 'delete-note', 'update:draft'])

const auth = useAuthStore()
const expanded = ref(false)

// Terbaru di bawah (urut kronologis naik)
const sortedNotes = computed(() => [...props.notes].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)))

function canDelete(note) {
  return auth.isAdmin || note.userId === auth.user.id
}
function formatNoteTime(ts) {
  return formatTime(ts) + ' · ' + new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' })
}
</script>