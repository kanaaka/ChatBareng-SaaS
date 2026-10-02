<template>
  <div class="relative" ref="panelRef">
    <!-- v0.9.0-r2 (audit fix #5): bell "broken" di light = text-white hardcoded di
         atas topbar terang → ganti warna token on-surface-variant + state layer netral.
         SVG bell-nya sendiri valid (M3 notification), jadi di-dark hanya state layer
         yang berubah. -->
    <button
      @click.stop="togglePanel"
      class="m3-bell-btn relative p-2 rounded-full"
      title="Pengumuman"
    >
      <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
      </svg>
      <span
        v-if="unreadCount > 0"
        class="absolute top-1 right-1 min-w-[18px] h-[18px] bg-red-500 text-white text-[10px] font-bold flex items-center justify-center rounded-full px-1"
      >
        {{ unreadCount > 99 ? '99+' : unreadCount }}
      </span>
    </button>

    <!-- Dropdown panel -->
    <div
      v-if="open"
      class="absolute right-0 top-full mt-2 w-80 sm:w-96 bg-white border border-gray-200 rounded-lg shadow-xl z-50 max-h-[80vh] flex flex-col"
    >
      <div class="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
        <span class="font-semibold text-sm text-gray-800">Pengumuman</span>
        <!-- v0.9.0-r2 (audit fix #2): aksi + aksen pakai token M3 -->
        <button v-if="unreadCount > 0" @click="markAllRead" class="text-xs hover:underline m3-ann-action">Tandai sudah dibaca</button>
      </div>

      <div class="overflow-y-auto flex-1 p-2">
        <div v-if="loading" class="p-4 text-center text-xs text-gray-400">Loading...</div>
        <div v-else-if="items.length === 0" class="p-6 text-center text-sm text-gray-400">
          Tidak ada pengumuman aktif.
        </div>
        <div v-else class="space-y-2">
          <div
            v-for="item in items"
            :key="item.id"
            @click="expandItem(item.id)"
            :class="['border rounded-lg p-3 cursor-pointer transition-colors m3-ann-item', item.readByMe ? 'opacity-70' : '']"
          >
            <div class="flex items-start gap-2">
              <span class="m3-ann-action">{{ item.pinned ? '📌' : '📢' }}</span>
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                  <span class="text-sm font-semibold text-gray-800 truncate">{{ item.title }}</span>
                  <span v-if="!item.readByMe" class="w-2 h-2 rounded-full m3-ann-dot"></span>
                </div>
                <div class="text-xs text-gray-500 mb-1">{{ formatDate(item.createdAt) }}</div>
                <div class="text-sm text-gray-700 whitespace-pre-line" :class="expandedId === item.id ? '' : 'line-clamp-2'">{{ item.content }}</div>
                <div v-if="expandedId === item.id && !item.readByMe" class="mt-2">
                  <button @click.stop="markRead(item.id)" class="text-xs bg-wa-green text-white px-3 py-1.5 rounded hover:bg-green-600">Tandai sudah dibaca</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useAnnouncementsStore } from '../stores/announcements'

const store = useAnnouncementsStore()
const open = ref(false)
const expandedId = ref(null)
const panelRef = ref(null)

const items = computed(() => {
  return [...store.list].sort((a, b) => {
    if (a.pinned === b.pinned) return new Date(b.createdAt) - new Date(a.createdAt)
    return a.pinned ? -1 : 1
  })
})

const unreadCount = computed(() => store.unreadCount)
const loading = computed(() => store.loading)

function togglePanel() {
  open.value = !open.value
  if (open.value && !store.initialized) {
    store.fetchAll()
  }
}

function expandItem(id) {
  if (expandedId.value === id) {
    expandedId.value = null
  } else {
    expandedId.value = id
    const item = store.list.find(a => a.id === id)
    if (item && !item.readByMe) {
      store.markRead(id)
    }
  }
}

function markRead(id) {
  store.markRead(id)
}

function markAllRead() {
  store.unread.forEach(a => store.markRead(a.id))
}

function formatDate(d) {
  if (!d) return ''
  const date = new Date(d)
  return date.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })
}

function closeOnClickOutside(e) {
  if (panelRef.value && !panelRef.value.contains(e.target)) {
    open.value = false
  }
}

function handleOpenEvent() {
  open.value = true
  if (!store.initialized) store.fetchAll()
}

onMounted(() => {
  document.addEventListener('click', closeOnClickOutside)
  window.addEventListener('open-announcements-bell', handleOpenEvent)
  store.fetchAll()
})

onUnmounted(() => {
  document.removeEventListener('click', closeOnClickOutside)
  window.removeEventListener('open-announcements-bell', handleOpenEvent)
})
</script>

<style scoped>
.m3-bell-btn { color: var(--md-sys-color-on-surface-variant); transition: background-color var(--md-sys-motion-duration-short) linear; }
.m3-bell-btn:hover { background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent); }
.line-clamp-2 {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
/* v0.9.0-r2 (audit fix #2) — bell dropdown pakai token M3 (bukan amber hardcoded) */
.m3-ann-action { color: var(--md-sys-color-tertiary); }
.m3-ann-item {
  background: var(--md-sys-color-surface-container-lowest);
  border-color: var(--md-sys-color-outline-variant);
}
.m3-ann-item:not(.opacity-70) { border-color: var(--md-sys-color-tertiary-container); }
.m3-ann-dot { background: var(--md-sys-color-tertiary); }
</style>
