<template>
  <!--
    v0.9.0 — FilterChips reskin M3: logika tab/role TIDAK berubah (CS: Mine|Resolved;
    admin/semua: 4 tab). Desktop = 4-segmen indicator primary; mobile = M3 chips.
  -->
  <div class="border-b border-gray-200 bg-white">
    <!-- Desktop (>=768px): same 4-segmen layout -->
    <div class="hidden md:flex">
      <button
        v-for="tab in tabs"
        :key="tab.value"
        @click="$emit('change', tab.value)"
        :class="['flex-1 py-3 text-sm font-medium border-b-2 transition-colors', modelValue === tab.value ? 'text-wa-green border-wa-green' : 'text-gray-500 border-transparent hover:text-gray-700']"
        style="min-height: 44px;"
      >
        {{ tab.label }}
      </button>
    </div>
    <!-- Mobile: horizontal scrollable chips -->
    <div class="md:hidden flex gap-2 px-3 py-2 overflow-x-auto no-scrollbar safe-left safe-right">
      <button
        v-for="tab in tabs"
        :key="tab.value"
        @click="$emit('change', tab.value)"
        :class="['m3-chip !min-h-[36px] !px-4 !py-1.5 text-sm', modelValue === tab.value ? 'm3-chip--selected' : '']"
      >
        {{ tab.label }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useAuthStore } from '../stores/auth'

const props = defineProps({
  modelValue: { type: String, required: true },
  snoozedCount: { type: Number, default: 0 }, // v0.10.0 — tampil chip 😴 Snoozed hanya jika > 0
})
defineEmits(['change'])

const auth = useAuthStore()

// v0.10.0 — Fitur A: chip "😴 Snoozed" (muncul hanya kalau ada chat snoozed aktif).
// Nilai 'snoozed' bukan filter server biasa — Dashboard fetch ?snoozed=1.
const allTabs = [
  { label: 'Mine', value: 'mine' },
  { label: 'Unassigned', value: 'unassigned' },
  { label: 'All', value: 'all' },
  { label: 'Resolved', value: 'resolved' },
  { label: '😴 Snoozed', value: 'snoozed' },
]

// v0.1.21 — CS hanya Mine|Resolved; admin semua.
// v0.5.0 — relay (Cabang) juga cuma Mine|Resolved — dia gak bisa take antrean,
// jadi tab Unassigned/All gak relevan.
// v0.10.0 — chip Snoozed ikut semua role (CS boleh lihat chat miliknya yang snoozed).
const tabs = computed(() => {
  const base = auth.isAdmin ? allTabs : [allTabs[0], allTabs[3]]
  // Tampilkan Snoozed hanya kalau ada isinya (count di-pass parent via prop count)
  if (!props.snoozedCount) return base.filter(t => t.value !== 'snoozed')
  return base
})
</script>