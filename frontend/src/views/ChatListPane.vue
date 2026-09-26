<template>
  <!--
    v0.2.0 ChatListPane — seluruh chatlist dari Dashboard.vue v0.1.x, dipecah jadi
    komponen. Dipakai Dashboard (mobile: full pane; desktop: sidebar split).
    Semua state list (filter/search/tags/filters) tetap di sini — logika identik.
  -->
  <div class="flex flex-col h-full bg-white">
    <!-- Search — v0.13.6 r6: pill ala admin sidebar (M3 Expressive, request Kanaka 11:51) -->
    <div class="p-3 border-b border-gray-200">
      <div class="chat-search">
        <input
          v-model="search"
          type="text"
          class="chat-search__input"
          placeholder="Cari chat…"
          autocomplete="off"
          aria-label="Cari chat"
        />
      </div>
    </div>

    <!-- v3.9.2 K1-A — badge nomor asal (label slot) per chat: user harus selalu tau
         chat ini lewat nomor mana. Data slot di-fetch dari /api/wa/status (label + slot). -->

    <!-- Filters section -->
    <div class="border-b border-gray-200">
      <button
        @click="showFilters = !showFilters"
        class="w-full px-3 py-2 flex items-center justify-between text-sm text-gray-600 hover:bg-gray-50"
      >
        <span class="flex items-center gap-1">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
          </svg>
          Filters
          <span v-if="activeFilterCount > 0" class="bg-wa-green text-white text-xs px-1.5 py-0.5 rounded-full leading-none">{{ activeFilterCount }}</span>
        </span>
        <svg class="w-4 h-4 transition-transform" :class="showFilters ? 'rotate-180' : ''" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      <!-- Expanded filter controls -->
      <div v-if="showFilters" class="px-3 pb-3 space-y-2">
        <div v-if="filterTagIds.length > 0" class="flex flex-wrap gap-1">
          <span
            v-for="tagId in filterTagIds"
            :key="tagId"
            :class="['inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium', tagColorClass(getTagById(tagId)?.color || 'blue')]"
          >
            {{ getTagById(tagId)?.name || 'Unknown' }}
            <button @click="removeFilterTag(tagId)" class="ml-0.5 hover:text-red-500">×</button>
          </span>
        </div>

        <div class="relative">
          <button
            @click.stop="showTagFilterMenu = !showTagFilterMenu"
            class="w-full text-left px-2 py-1.5 text-xs border border-gray-200 rounded-lg hover:bg-gray-50 text-gray-600"
          >
            {{ filterTagIds.length > 0 ? `Tags (${filterTagIds.length})` : 'Filter by tag...' }}
          </button>
          <div v-if="showTagFilterMenu" @click.stop class="absolute left-0 right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-20 max-h-[200px] overflow-y-auto">
            <div v-if="allTags.length === 0" class="px-3 py-2 text-xs text-gray-400">No tags available</div>
            <div
              v-for="tag in allTags"
              :key="tag.id"
              @click="toggleFilterTag(tag.id)"
              :class="['px-3 py-2 text-sm cursor-pointer hover:bg-gray-50 flex items-center justify-between', filterTagIds.includes(tag.id) ? 'bg-green-50' : '']"
            >
              <span class="flex items-center gap-2">
                <span :class="['w-3 h-3 rounded-full', tagDotClass(tag.color)]"></span>
                {{ tag.name }}
              </span>
              <span v-if="filterTagIds.includes(tag.id)" class="text-green-600">✓</span>
            </div>
          </div>
        </div>

        <select
          v-model="filterHandlerId"
          @change="onFilterChange"
          class="w-full px-2 py-1.5 text-xs border border-gray-200 rounded-lg focus:ring-1 focus:ring-wa-green focus:border-transparent text-gray-600"
        >
          <option :value="null">All handlers</option>
          <option v-for="agent in agentList" :key="agent.id" :value="agent.id">@{{ agent.username }}</option>
        </select>

        <!-- v3.9.17 — Filter by nomor penerima (numberSlot): muncul hanya bila tenant
             punya >1 nomor terdaftar. Data = waSlots (badge data yang sama). -->
        <select
          v-if="waSlots.length > 1"
          v-model="filterNumberSlot"
          @change="onFilterChange"
          class="w-full px-2 py-1.5 text-xs border border-gray-200 rounded-lg focus:ring-1 focus:ring-wa-green focus:border-transparent text-gray-600"
        >
          <option :value="null">All numbers</option>
          <option v-for="s in waSlots" :key="s.slot" :value="s.slot">
            {{ slotBadgeLabel(s.slot) }}{{ s.status?.connected ? ' ✓' : '' }}
          </option>
        </select>

        <div class="flex items-center gap-1">
          <input
            v-model="filterDateFrom"
            @change="onFilterChange"
            type="date"
            class="flex-1 px-2 py-1.5 text-xs border border-gray-200 rounded-lg focus:ring-1 focus:ring-wa-green focus:border-transparent text-gray-600"
            placeholder="From"
          />
          <span class="text-gray-400 text-xs">→</span>
          <input
            v-model="filterDateTo"
            @change="onFilterChange"
            type="date"
            class="flex-1 px-2 py-1.5 text-xs border border-gray-200 rounded-lg focus:ring-1 focus:ring-wa-green focus:border-transparent text-gray-600"
            placeholder="To"
          />
        </div>

        <button
          v-if="activeFilterCount > 0"
          @click="clearFilters"
          class="w-full text-xs text-gray-500 hover:text-red-500 py-1"
        >
          Clear all filters
        </button>
      </div>
    </div>

    <!-- Chat list -->
    <div class="flex-1 overflow-y-auto overscroll-contain">
      <div v-if="loadingChats" class="p-4 text-center text-gray-400">Loading chats...</div>
      <template v-else>
        <div v-if="search && search.length >= 1" class="px-3 pt-2 pb-1 text-xs font-semibold text-gray-400 uppercase tracking-wide">
          Contacts ({{ filteredChats.length }})
        </div>
        <div v-if="filteredChats.length === 0 && search && search.length >= 1" class="p-3 text-center text-xs text-gray-400">
          No contacts found
        </div>
        <div
          v-for="chat in filteredChats"
          :key="chat.id"
          @click="$emit('select', chat)"
          :class="[
            'p-3 border-b border-gray-100 cursor-pointer active:bg-gray-100',
            chat.transferUnseen ? 'bg-amber-50 border-l-4 border-amber-400 hover:bg-amber-100' : (activeChatId === chat.id ? 'bg-green-50 hover:bg-gray-50' : 'hover:bg-gray-50')
          ]"
        >
          <div class="flex items-center justify-between">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <div class="w-10 h-10 rounded-full bg-wa-dark text-white flex items-center justify-center text-sm font-semibold flex-shrink-0">
                  {{ getInitials(chat.contactName || chat.contactPhone) }}
                </div>
                <div class="min-w-0">
                  <div class="flex items-center gap-1">
                    <span class="font-medium text-sm truncate">{{ chat.contactName || chat.contactPhone }}</span>
                    <span v-if="chat.status === 'resolved'" class="text-green-500 text-xs flex-shrink-0" title="Resolved">✓</span>
                    <!-- v0.5.1 — badge "transfer belum dibaca" -->
                    <span v-if="chat.transferUnseen" class="inline-flex items-center gap-0.5 bg-amber-100 text-amber-700 text-[10px] font-medium px-1.5 py-0.5 rounded flex-shrink-0">📤 Transfer</span>
                    <!-- v3.9.2 K1-A — badge nomor asal (label slot) — tampil bila tenant punya >1 slot -->
                    <span
                      v-if="waSlots.length > 1"
                      class="inline-flex items-center gap-0.5 bg-indigo-100 text-indigo-700 text-[10px] font-medium px-1.5 py-0.5 rounded flex-shrink-0"
                      :title="slotBadgeTitle(chat.numberSlot)"
                    >{{ slotBadgeLabel(chat.numberSlot) }}</span>
                    <!-- v4.0.0 — badge "🤖 ×N" (window AI hidup: lastAiReplyAt < 24 jam) —
                         agent langsung lihat berapa kali AI sudah bales sebelum take -->
                    <span
                      v-if="aiWindowCount(chat) > 0"
                      class="inline-flex items-center gap-0.5 bg-purple-100 text-purple-700 text-[10px] font-medium px-1.5 py-0.5 rounded flex-shrink-0"
                      title="AI sudah membalas chat ini (window 24 jam)"
                    >🤖 ×{{ aiWindowCount(chat) }}</span>
                  </div>
                  <div class="flex items-center gap-1">
                    <span class="text-xs text-gray-500 truncate">{{ chat.lastMessagePreview || 'No messages' }}</span>
                  </div>
                  <div v-if="chat.tags && chat.tags.length > 0" class="flex gap-1 mt-0.5">
                    <span
                      v-for="ct in chat.tags.slice(0, 2)"
                      :key="ct.tag.id"
                      :class="['inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium truncate max-w-[60px]', tagColorClass(ct.tag.color)]"
                    >
                      {{ ct.tag.name }}
                    </span>
                    <span v-if="chat.tags.length > 2" class="text-[10px] text-gray-400">+{{ chat.tags.length - 2 }}</span>
                  </div>
                </div>
              </div>
            </div>
            <div class="flex flex-col items-end gap-1 ml-2">
              <!-- v3.9.22 — timestamp pesan terakhir di chat list (konvensi WA: hari ini = jam, kemarin/dst = tanggal) -->
              <span v-if="chat.lastMessageAt" class="text-[11px] text-gray-400 whitespace-nowrap">{{ formatListTime(chat.lastMessageAt) }}</span>
              <span v-if="chat.unreadCount > 0" class="bg-wa-green text-white text-xs px-2 py-0.5 rounded-full">
                {{ chat.unreadCount }}
              </span>
              <span v-if="chat.assignedTo" class="text-xs text-blue-500">@{{ chat.assignedTo.username }}</span>
            </div>
          </div>
        </div>

        <!-- Messages section (global search results) -->
        <div v-if="globalSearchLoading" class="px-3 py-3 flex items-center gap-2 text-xs text-gray-400">
          <svg class="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v1m6 0v1m-6 2h6m-6 2h6m-6 2h6M6 8h.01M6 12h.01M6 16h.01" />
          </svg>
          Searching messages...
        </div>
        <template v-else-if="globalSearchResults.length > 0">
          <div class="px-3 pt-2 pb-1 text-xs font-semibold text-gray-400 uppercase tracking-wide border-t border-gray-100">
            Messages ({{ globalSearchTotalMessages }})
          </div>
          <div v-for="result in globalSearchResults" :key="result.chat.id" class="border-b border-gray-100">
            <div class="px-3 pt-2 pb-1 flex items-center gap-2">
              <div class="w-6 h-6 rounded-full bg-wa-dark text-white flex items-center justify-center text-[10px] font-semibold flex-shrink-0">
                {{ getInitials(result.chat.contactName || result.chat.contactPhone) }}
              </div>
              <span class="text-sm font-medium truncate">{{ result.chat.contactName || result.chat.contactPhone }}</span>
              <span class="text-xs text-gray-400 ml-auto">{{ result.matchCount }} match{{ result.matchCount === 1 ? '' : 'es' }}</span>
            </div>
            <div
              v-for="msg in result.messages.slice(0, 3)"
              :key="msg.id"
              @click="$emit('select-search', result.chat, msg.id)"
              class="px-3 py-1.5 ml-8 mr-3 cursor-pointer hover:bg-blue-50 active:bg-blue-100 rounded-lg mb-0.5"
            >
              <div class="flex items-center gap-1">
                <span :class="['text-xs font-medium', msg.direction === 'in' ? 'text-gray-500' : 'text-green-600']">
                  {{ msg.direction === 'in' ? 'Customer' : '@' + msg.senderName }}
                </span>
                <span class="text-xs text-gray-400 ml-auto">{{ formatTime(msg.timestamp) }}</span>
              </div>
              <div class="text-xs text-gray-700 truncate" v-html="highlightSearchTerm(msg.content || '[' + (msg.mediaType || 'media') + ']', search)"></div>
            </div>
            <div v-if="result.matchCount > 3" class="px-3 pb-1 ml-8 text-[10px] text-gray-400">
              +{{ result.matchCount - 3 }} more match{{ result.matchCount - 3 === 1 ? '' : 'es' }}
            </div>
          </div>
        </template>
        <div v-else-if="search && search.length >= 2 && !globalSearchLoading" class="px-3 py-2 text-center text-xs text-gray-400 border-t border-gray-100">
          No messages found
        </div>

        <div v-if="!search && filteredChats.length === 0" class="p-4 text-center text-gray-400">No chats found</div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import axios from 'axios'
import { useAuthStore } from '../stores/auth'
import { useChatsStore } from '../stores/chats'
import { getInitials, formatTime, formatListTime, tagColorClass, tagDotClass, highlightSearchTerm } from '../utils/format'
import M3TextField from '../components/M3TextField.vue'

const API = import.meta.env.VITE_API_URL || ''

const props = defineProps({
  activeChatId: { type: String, default: null },
})
const emit = defineEmits(['select', 'select-search', 'filter-params'])

const auth = useAuthStore()
const chats = useChatsStore()

const search = ref('')
const loadingChats = computed(() => chats.loadingChats)

// Filter state (dulu lokal Dashboard v0.1.x — tetap lokal di pane ini)
const showFilters = ref(false)
const filterTagIds = ref([])
const filterHandlerId = ref(null)
const filterDateFrom = ref('')
const filterDateTo = ref('')
// v3.9.17 — filter nomor penerima (null = semua nomor; 0..2 = slot)
const filterNumberSlot = ref(null)
const showTagFilterMenu = ref(false)
const agentList = ref([])

// Tag data untuk filter dropdown
const allTags = ref([])

// v3.9.2 K1-A — badge nomor asal: slot list dari /api/wa/status (label slot);
// refresh saat wa_status broadcast. Zero-change: tenant 1 nomor → badge tidak tampil.
const waSlots = ref([])

async function fetchWaSlots() {
  try {
    const res = await axios.get(`${API}/api/wa/status`)
    waSlots.value = res.data.slots || []
  } catch (e) {
    console.error('Fetch WA slots for badges:', e)
  }
}

function slotInfo(slot) {
  const s = Number(slot) || 0
  return waSlots.value.find(x => Number(x.slot) === s) || null
}

function slotBadgeLabel(slot) {
  const info = slotInfo(slot)
  return info?.label ? info.label.slice(0, 12) : `Slot ${Number(slot) || 0}`
}

function slotBadgeTitle(slot) {
  const info = slotInfo(slot)
  const s = Number(slot) || 0
  return info?.label ? `Via nomor: ${info.label} (slot ${s})` : `Via nomor slot ${s}`
}

// ── v4.0.0 — badge "🤖 ×N": berapa kali AI sudah bales (window 24 jam hidup) ──
// chat.aiReplyCount + chat.lastAiReplyAt dibawa GET /api/chats (additive kolom).
// window ≥24h → badge hilang (budget segar); tick 60s utk peredupan realtime.
const nowMs = ref(Date.now())
let nowTimer = null
function aiWindowCount(chat) {
  const last = chat?.lastAiReplyAt ? new Date(chat.lastAiReplyAt).getTime() : 0
  if (!last) return 0
  void nowMs.value // dependensi reaktif — badge mati otomatis saat window lewat
  if (Date.now() - last >= 24 * 60 * 60 * 1000) return 0
  return Math.max(0, Number(chat?.aiReplyCount) || 0)
}

// Global message search state
const globalSearchResults = ref([])
const globalSearchLoading = ref(false)
const globalSearchTotalMessages = ref(0)
let globalSearchTimer = null

const filteredChats = computed(() => {
  let result = chats.chats
  if (search.value) {
    const q = search.value.toLowerCase()
    result = result.filter(c =>
      (c.contactName?.toLowerCase().includes(q) || c.contactPhone?.includes(q))
    )
  }
  return result
})

const activeFilterCount = computed(() => {
  let count = 0
  if (filterTagIds.value.length > 0) count += filterTagIds.value.length
  if (filterHandlerId.value !== null) count++
  if (filterNumberSlot.value !== null) count++ // v3.9.17
  if (filterDateFrom.value) count++
  if (filterDateTo.value) count++
  return count
})

function getTagById(id) {
  return allTags.value.find(t => t.id === id)
}

function buildFilterParams() {
  const params = {}
  if (filterTagIds.value.length > 0) {
    params.tagIds = filterTagIds.value.join(',')
  }
  if (filterHandlerId.value !== null) {
    params.handlerId = filterHandlerId.value
  }
  if (filterDateFrom.value) {
    params.dateFrom = filterDateFrom.value
  }
  if (filterDateTo.value) {
    params.dateTo = filterDateTo.value
  }
  // v3.9.17 — nomor penerima (numberSlot)
  if (filterNumberSlot.value !== null) {
    params.numberSlot = filterNumberSlot.value
  }
  return params
}

// v0.2.0 — expose filterParams ke parent (Dashboard) supaya handler socket
// (onChatUpdate/onNewMessage/onChatsPurged) bisa refetch dgn filter aktif,
// identik dgn perilaku v0.1.27
watch(buildFilterParams, (params) => {
  chats.filterParams = params
  emit('filter-params', params)
}, { immediate: true })

let filterDebounceTimer = null
function onFilterChange() {
  clearTimeout(filterDebounceTimer)
  filterDebounceTimer = setTimeout(() => {
    fetchChatsWithFilters()
  }, 300)
}

function fetchChatsWithFilters() {
  return chats.fetchChats(buildFilterParams())
}

function toggleFilterTag(tagId) {
  const idx = filterTagIds.value.indexOf(tagId)
  if (idx > -1) filterTagIds.value.splice(idx, 1)
  else filterTagIds.value.push(tagId)
  onFilterChange()
}

function removeFilterTag(tagId) {
  const idx = filterTagIds.value.indexOf(tagId)
  if (idx > -1) {
    filterTagIds.value.splice(idx, 1)
    onFilterChange()
  }
}

function clearFilters() {
  filterTagIds.value = []
  filterHandlerId.value = null
  filterNumberSlot.value = null // v3.9.17
  filterDateFrom.value = ''
  filterDateTo.value = ''
  showTagFilterMenu.value = false
  fetchChatsWithFilters()
}

async function fetchAgentList() {
  try {
    const res = await axios.get(`${API}/api/users/agents`)
    agentList.value = res.data.users
  } catch (e) {
    console.error('Fetch agents for filter:', e)
  }
}

async function fetchAllTags() {
  try {
    const res = await axios.get(`${API}/api/tags`)
    allTags.value = res.data.tags
  } catch (e) {
    console.error('Fetch tags error:', e)
  }
}

// Public method untuk parent: changeFilter dipanggil dari FilterChips
function changeFilter(val) {
  chats.filter = val
  return chats.fetchChats(buildFilterParams())
}
defineExpose({ changeFilter, buildFilterParams, fetchChatsWithFilters })

// Watch sidebar search for global message search (logika identik v0.1.x)
watch(search, (newVal) => {
  clearTimeout(globalSearchTimer)
  if (!newVal || newVal.trim().length < 2) {
    globalSearchResults.value = []
    globalSearchTotalMessages.value = 0
    globalSearchLoading.value = false
    return
  }
  globalSearchLoading.value = true
  globalSearchTimer = setTimeout(async () => {
    try {
      const res = await axios.get(`${API}/api/chats/search-all?q=${encodeURIComponent(newVal.trim())}`)
      globalSearchResults.value = res.data.results || []
      globalSearchTotalMessages.value = res.data.totalMessages || 0
    } catch (e) {
      console.error('[Global Search] API error:', e.response?.status, e.response?.data || e.message)
      globalSearchResults.value = []
      globalSearchTotalMessages.value = 0
    } finally {
      globalSearchLoading.value = false
    }
  }, 300)
})

// Real-time tag sync (tag_created/tag_deleted) — sama seperti v0.1.x di Dashboard
function onTagCreated(data) {
  if (data.tag && !allTags.value.find(t => t.id === data.tag.id)) {
    allTags.value.push(data.tag)
  }
}
function onTagDeleted(data) {
  allTags.value = allTags.value.filter(t => t.id !== data.tagId)
}

import { useSocketStore } from '../stores/socket'
const socketStore = useSocketStore()

onMounted(() => {
  fetchAllTags()
  fetchAgentList()
  fetchWaSlots() // v3.9.2 K1-A — data badge nomor asal
  socketStore.on('tag_created', onTagCreated)
  socketStore.on('tag_deleted', onTagDeleted)
  // v3.9.2 — refresh slot badge saat status WA berubah (connect/logout)
  socketStore.on('wa_status', onWaStatusChanged)
  // v4.0.0 — tick 60s: badge "🤖 ×N" mati otomatis saat window 24 jam lewat
  nowTimer = setInterval(() => { nowMs.value = Date.now() }, 60 * 1000)
})
onUnmounted(() => {
  socketStore.off('tag_created', onTagCreated)
  socketStore.off('tag_deleted', onTagDeleted)
  socketStore.off('wa_status', onWaStatusChanged)
  if (nowTimer) { clearInterval(nowTimer); nowTimer = null }
})

// v3.9.2 K1-A — debounced refresh badge saat status WA berubah
let waStatusDebounce = null
function onWaStatusChanged() {
  clearTimeout(waStatusDebounce)
  waStatusDebounce = setTimeout(fetchWaSlots, 500)
}
</script>