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
              <span class="flex items-center gap-2 min-w-0">
                <span :class="['w-3 h-3 rounded-full', tagDotClass(tag.color)]"></span>
                {{ tag.name }}
                <span v-if="tag.excludeFromQueue" class="text-[10px] text-gray-400 bg-gray-100 rounded px-1 py-0.5" title="Kontak ber-tag ini dikecualikan dari antrean (silent block)">🚫</span>
              </span>
              <span class="flex items-center gap-1 flex-shrink-0">
                <!-- v4.4.0 F3 — toggle admin exclude-from-queue langsung dari menu filter -->
                <button
                  v-if="auth.isAdmin"
                  type="button"
                  @click.stop="toggleTagExclude(tag)"
                  :class="['text-[10px] rounded px-1.5 py-0.5 border', tag.excludeFromQueue ? 'border-gray-300 bg-gray-100 text-gray-600' : 'border-gray-200 text-gray-400 hover:text-wa-green']"
                  :title="tag.excludeFromQueue
                    ? 'AKTIF: kontak ber-tag ini TIDAK masuk antrean — klik untuk izinkan lagi'
                    : 'Kecualikan kontak ber-tag ini dari antrean (silent block)'"
                >🚫 {{ tag.excludeFromQueue ? 'on' : 'off' }}</button>
                <span v-if="filterTagIds.includes(tag.id)" class="text-green-600">✓</span>
              </span>
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

    <!-- v4.5.0 B — batch action bar (tampil hanya saat mode seleksi) -->
    <div v-if="selectionMode" class="border-b border-gray-200 px-3 py-2 flex-shrink-0" style="padding-bottom: max(8px, env(safe-area-inset-bottom, 0px))">
      <div class="flex items-center gap-2 flex-wrap md:flex-nowrap overflow-x-auto no-scrollbar">
        <label class="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none flex-shrink-0">
          <input type="checkbox" class="accent-wa-green" :checked="allVisibleSelected" @change="toggleSelectAll" />
          Semua
        </label>
        <span class="text-xs text-gray-500 flex-shrink-0">{{ selectedIds.size }} dipilih</span>
        <button
          :disabled="selectedIds.size === 0 || batchBusy"
          @click="batchResolveSelected"
          class="text-xs px-2.5 py-1.5 rounded-lg font-medium bg-green-100 text-green-700 hover:bg-green-200 disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
        >✓ Resolve</button>
        <button
          :disabled="selectedIds.size === 0 || batchBusy"
          @click="batchMarkReadSelected"
          class="text-xs px-2.5 py-1.5 rounded-lg font-medium bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
        >📖 Dibaca</button>
        <button
          :disabled="selectedIds.size === 0"
          @click="batchMarkUnreadSelected"
          class="text-xs px-2.5 py-1.5 rounded-lg font-medium bg-blue-50 text-blue-600 hover:bg-blue-100 disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
        >🔵 Belum dibaca</button>
        <button
          @click="exitSelectionMode"
          class="text-xs px-2 py-1.5 rounded-lg text-gray-400 hover:bg-gray-100 flex-shrink-0 ml-auto"
          title="Keluar mode pilih"
        >✕</button>
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
          @click="selectionMode ? toggleChatSelection(chat.id) : $emit('select', chat)"
          @mouseenter="hoveredChatId = chat.id"
          @mouseleave="hoveredChatId = null"
          @contextmenu.prevent="openManualUnreadMenu($event, chat)"
          @touchstart.passive="onChatTouchStart($event, chat)"
          @touchend.passive="onChatTouchEnd"
          @touchmove.passive="onChatTouchCancel"
          @touchcancel.passive="onChatTouchCancel"
          :class="[
            'p-3 border-b border-gray-100 cursor-pointer active:bg-gray-100',
            chat.transferUnseen ? 'bg-amber-50 border-l-4 border-amber-400 hover:bg-amber-100' : (activeChatId === chat.id ? 'bg-green-50 hover:bg-gray-50' : 'hover:bg-gray-50')
          ]"
        >
          <div class="flex items-center justify-between">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <div class="relative w-10 h-10 rounded-full bg-wa-dark text-white flex items-center justify-center text-sm font-semibold flex-shrink-0">
                  {{ getInitials(chat.contactName || chat.contactPhone) }}
                  <!-- v4.1.3.1 D3 — dot biru "belum dibaca" manual: HANYA bila marker
                       aktif DAN unreadCount==0 (unread asli >0 → badge WA menang, dot
                       TIDAK dobel). w-2.5 h-2.5 di pojok kanan-atas avatar. -->
                  <span
                    v-if="isManualUnread(chat.id) && !(chat.unreadCount > 0)"
                    class="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-blue-500 border-2 border-white dark:border-[var(--md-sys-color-surface-container-lowest)]"
                    title="Ditandai belum dibaca"
                  ></span>
                  <!-- v4.5.0 B — tickbox multi-select: muncul saat hover (desktop) ATAU
                       mode seleksi aktif ATAU row ini terpilih. Klik = stop (jangan
                       open chat); klik pertama mengaktifkan selectionMode. Checked =
                       solid hijau (menimpa dot saat overlap — kembali saat keluar). -->
                  <button
                    v-if="(isDesktopVP && hoveredChatId === chat.id) || selectionMode || isChatSelected(chat.id)"
                    type="button"
                    @click.stop="toggleChatSelection(chat.id)"
                    :class="['absolute -top-1 -right-1 w-5 h-5 rounded-full border-2 flex items-center justify-center text-[10px] font-bold transition-colors',
                      isChatSelected(chat.id) ? 'bg-wa-green border-wa-green text-white' : 'bg-white border-gray-400 text-transparent']"
                    :title="isChatSelected(chat.id) ? 'Batalkan pilihan' : 'Pilih chat'"
                  >✓</button>
                </div>
                <div class="min-w-0">
                  <div class="flex items-center gap-1">
                    <!-- v4.1.3.1 D3 — nama font-semibold saat marker aktif (unread asli menang) -->
                    <!-- v4.6.8 D2 — nama kontak flex-1 min-w-0 truncate: SELALU
                         terlihat penuh (ellipsis) walau di kanannya banyak badge
                         (transfer/slot/AI) — badge shrink-0 TIDAK PERNAH memakan
                         lebar nama (fix badge overlap v4.6.8). -->
                    <span :class="['text-sm truncate flex-1 min-w-0', isManualUnread(chat.id) && !(chat.unreadCount > 0) ? 'font-semibold' : 'font-medium']">{{ chat.contactName || chat.contactPhone }}</span>
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
                    <!-- v4.6.8 — chip "🆕 Baru diambil" zona float DIHAPUS (spec
                         docs/spec-v4.6.8-floatzone-v2.md K3): urutan Mine sudah
                         ekspresif (take naik sekali, aktivitas menang) — chip tidak
                         diperlukan lagi + field float-zone lama dihapus dari BE. -->
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
            <!-- v4.6.8 D2 — kolom kanan shrink-0: timestamp/badge/@user tidak pernah
                 tumbuh ke kiri (tidak menutupi nama kontak). -->
            <div class="flex flex-col items-end gap-1 ml-2 shrink-0">
              <!-- v3.9.22 — timestamp pesan terakhir di chat list (konvensi WA: hari ini = jam, kemarin/dst = tanggal) -->
              <span v-if="chat.lastMessageAt" class="text-[11px] text-gray-400 whitespace-nowrap">{{ formatListTime(chat.lastMessageAt) }}</span>
              <!-- v4.6.8 D2 — badge unread shrink-0: tidak pernah tumbuh ke kiri
                   (tidak menutupi nama kontak walau unread>9). -->
              <span v-if="chat.unreadCount > 0" class="shrink-0 bg-wa-green text-white text-xs px-2 py-0.5 rounded-full">
                {{ chat.unreadCount }}
              </span>
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

    <!-- v4.1.3.1 D1/D2 — menu kontekstual "Tandai belum dibaca" (backdrop v-if: TIDAK boleh selalu render — fixed inset-0 selalu-ada nge-block semua klik di bawahnya) -->
    <div v-if="showManualUnreadMenu" class="chat-unread-ctxmenu fixed inset-0 z-40" @click="closeManualUnreadMenu" @contextmenu.prevent="closeManualUnreadMenu"></div>
    <div
      class="fixed z-50 w-56 rounded-lg border border-[var(--md-sys-color-outline-variant)] bg-[var(--md-sys-color-surface-container)] shadow-xl overflow-hidden py-1"
      :style="manualUnreadMenuStyle"
      role="menu"
      aria-label="Menu chat"
    >
      <!-- v4.5.0 B — masuk mode multi-select dari long-press (entry mobile natural) -->
      <button
        v-if="manualUnreadTarget && !selectionMode"
        type="button"
        class="w-full text-left px-3 py-2.5 text-sm text-[var(--md-sys-color-on-surface)] hover:bg-[var(--md-sys-color-surface-container-high)] flex items-center gap-2.5"
        @click="enterSelectionModeFromMenu"
      >
        📋 Pilih chat
      </button>
      <!-- v4.5.0 B — saat SUDAH mode seleksi → item jadi keluar mode (clear + exit, spec §2) -->
      <button
        v-else-if="manualUnreadTarget && selectionMode"
        type="button"
        class="w-full text-left px-3 py-2.5 text-sm text-amber-600 hover:bg-amber-50 font-medium flex items-center gap-2.5"
        @click="closeManualUnreadMenu(); exitSelectionMode()"
      >
        ✕ Keluar mode pilih ({{ selectedIds.size }} terpilih)
      </button>
      <button
        v-if="manualUnreadTarget && !isManualUnread(manualUnreadTarget.id)"
        type="button"
        class="w-full text-left px-3 py-2.5 text-sm text-[var(--md-sys-color-on-surface)] hover:bg-[var(--md-sys-color-surface-container-high)] flex items-center gap-2.5"
        @click="markManualUnread"
      >
        <span class="w-2.5 h-2.5 rounded-full bg-blue-500 flex-shrink-0"></span>
        Tandai belum dibaca
      </button>
      <button
        v-else-if="manualUnreadTarget"
        type="button"
        class="w-full text-left px-3 py-2.5 text-sm text-[var(--md-sys-color-on-surface)] hover:bg-[var(--md-sys-color-surface-container-high)] flex items-center gap-2.5"
        @click="unmarkManualUnread"
      >
        <span class="w-2.5 h-2.5 rounded-full border-2 border-[var(--md-sys-color-on-surface-variant)] flex-shrink-0"></span>
        Tandai sudah dibaca
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import axios from 'axios'
import { useAuthStore } from '../stores/auth'
import { useChatsStore } from '../stores/chats'
import { getInitials, formatTime, formatListTime, tagColorClass, tagDotClass, highlightSearchTerm } from '../utils/format'
// v4.4.0 F3 — toast feedback toggle "kecualikan dari antrean"
import { useToastStore } from '../stores/toast'
// v4.5.0 B — confirm dialog batch resolve (pola confirmRelease Dashboard)
import { useConfirm } from '../utils/confirm'
// v4.1.3.1 — "Tandai belum dibaca" (FE-only, localStorage cb_manual_unread)
import { list as manualUnreadList, add as manualUnreadAdd, remove as manualUnreadRemove } from '../utils/manualUnread'
// v4.1.3.1 hotfix — reactivity: marker harus sync SEGERA (dot hilang saat dibales,
// label menu ikut state terkini). Sync dari event util + storage cross-tab.
function onManualUnreadChanged() {
  manualUnreadMap.value = { ...manualUnreadList() }
}
import M3TextField from '../components/M3TextField.vue'

const API = import.meta.env.VITE_API_URL || ''

const props = defineProps({
  activeChatId: { type: String, default: null },
})
const emit = defineEmits(['select', 'select-search', 'filter-params'])

const auth = useAuthStore()
const chats = useChatsStore()
// v4.4.0 F3 — feedback toggle tag exclude
const toastStore = useToastStore()
// v4.5.0 B — confirm dialog
const { confirmAction } = useConfirm()

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

// ── v4.1.3.1 — "Tandai belum dibaca" (D1/D2/D3): menu kontekstual + indikator ──
// Marker = localStorage `cb_manual_unread` (personal per-device, pola WhatsApp).
// State di-copy ke reactive ref manualUnreadMap supaya list re-render reaktif
// (bukan hard refresh) saat add/remove.
const manualUnreadMap = ref({})
const manualUnreadTarget = ref(null)
const manualUnreadPos = ref({ x: 0, y: 0 })
const showManualUnreadMenu = ref(false)

const manualUnreadMenuStyle = computed(() => {
  if (!showManualUnreadMenu.value) return 'display: none;'
  const mw = 224 // w-56
  const mh = 46 // 1 item menu ≈ 44px + py-1 (2×4)
  const pad = 8
  const x = Math.max(pad, Math.min(manualUnreadPos.value.x, (window.innerWidth || 0) - mw - pad))
  const y = Math.max(pad, Math.min(manualUnreadPos.value.y, (window.innerHeight || 0) - mh - pad))
  return `left:${x}px; top:${y}px;`
})

function isManualUnread(chatId) {
  // v4.1.3.1 hotfix — REACTIVE source: manualUnreadMap (di-sync dari event util),
  // BUKAN baca localStorage langsung (gak ter-track Vue → dot/label stale).
  if (chatId == null) return false
  return Object.prototype.hasOwnProperty.call(manualUnreadMap.value, String(chatId))
}

function openManualUnreadMenu(event, chat) {
  if (!chat?.id) return
  manualUnreadTarget.value = chat
  manualUnreadPos.value = { x: event.clientX || event.pageX || 0, y: event.clientY || event.pageY || 0 }
  showManualUnreadMenu.value = true
  // re-sync dari localStorage (tab lain bisa berubah)
  manualUnreadMap.value = { ...manualUnreadList() }
}

// ── D2 — long-press mobile 500ms; cancel saat touchmove/touchend sebelum 500ms;
// tap normal (buka chat) TIDAK diganggu (touchend <500ms = tap biasa).
let manualUnreadTouchTimer = null
let manualUnreadTouchMoved = false
const MANUAL_UNREAD_LONGPRESS_MS = 500

function onChatTouchStart(event, chat) {
  if (!chat?.id) return
  manualUnreadTouchMoved = false
  clearTimeout(manualUnreadTouchTimer)
  const touch = event.touches?.[0]
  if (!touch) return
  manualUnreadTouchTimer = setTimeout(() => {
    if (!manualUnreadTouchMoved) {
      manualUnreadTarget.value = chat
      manualUnreadPos.value = { x: touch.clientX || 0, y: touch.clientY || 0 }
      showManualUnreadMenu.value = true
      manualUnreadMap.value = { ...manualUnreadList() }
    }
  }, MANUAL_UNREAD_LONGPRESS_MS)
}

function onChatTouchCancel() {
  manualUnreadTouchMoved = true
  clearTimeout(manualUnreadTouchTimer)
}

function onChatTouchEnd() {
  clearTimeout(manualUnreadTouchTimer)
}

function markManualUnread() {
  const chat = manualUnreadTarget.value
  if (chat) {
    manualUnreadAdd(chat.id)
    manualUnreadMap.value = { ...manualUnreadList() }
  }
  closeManualUnreadMenu()
}

function unmarkManualUnread() {
  const chat = manualUnreadTarget.value
  if (chat) {
    manualUnreadRemove(chat.id)
    manualUnreadMap.value = { ...manualUnreadList() }
  }
  closeManualUnreadMenu()
}

function closeManualUnreadMenu() {
  showManualUnreadMenu.value = false
  manualUnreadTarget.value = null
}

function onManualUnreadKeydown(e) {
  if (e.key === 'Escape') closeManualUnreadMenu()
}

function onManualUnreadScroll() {
  closeManualUnreadMenu()
}

function onManualUnreadRouteLeave() {
  closeManualUnreadMenu()
}

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

// v4.4.0 F3 — toggle admin "kecualikan dari antrean" utk tag existing.
// PATCH /api/tags/:id (admin-only) → backend emit tag_updated + queue_update
// (banner antrean refresh). UI update lokal juga segera (responsif walau socket lambat).
async function toggleTagExclude(tag) {
  if (!auth.isAdmin || !tag?.id) return
  try {
    const res = await axios.patch(`${API}/api/tags/${tag.id}`, { excludeFromQueue: !tag.excludeFromQueue })
    const updated = res.data.tag
    const idx = allTags.value.findIndex(t => t.id === tag.id)
    if (idx !== -1) allTags.value[idx] = { ...updated }
    // v4.4.0 audit M1 — refetch list: chat yang baru ter-exclude/ter-izinkan
    // langsung hilang/muncul di tab Unassigned (paritas banner == tab).
    fetchChatsWithFilters()
    toastStore.show({
      icon: '🚫',
      title: 'Antrean tag',
      message: updated.excludeFromQueue
        ? `"${updated.name}" dikecualikan dari antrean (silent block)`
        : `"${updated.name}" boleh masuk antrean lagi`,
    })
  } catch (e) {
    console.error('Toggle tag excludeFromQueue error:', e)
    toastStore.show({
      icon: '⚠️',
      title: 'Gagal mengubah tag',
      message: e.response?.data?.error || e.message,
    })
  }
}

// ═══ v4.5.0 B — multi-select + batch actions ═══
const selectionMode = ref(false)
const selectedIds = ref(new Set())
const hoveredChatId = ref(null)
const batchBusy = ref(false)
// tickbox hover = desktop viewport saja (mobile: entry via long-press menu)
const isDesktopVP = ref(typeof window !== 'undefined' ? window.innerWidth >= 768 : true)

function isChatSelected(chatId) {
  return selectedIds.value.has(chatId)
}
function toggleChatSelection(chatId) {
  if (chatId == null) return
  if (selectedIds.value.has(chatId)) {
    selectedIds.value.delete(chatId)
    if (selectedIds.value.size === 0) selectionMode.value = false
  } else {
    // v4.5.0 audit M-1 — klik tickbox PERTAMA (apapun row-nya) langsung mengunci
    // selectionMode: baris berubah jadi toggle + action bar muncul (spec B.2).
    selectionMode.value = true
    selectedIds.value.add(chatId)
  }
}
function exitSelectionMode() {
  selectionMode.value = false
  selectedIds.value = new Set()
}
const allVisibleSelected = computed(() =>
  filteredChats.value.length > 0 && filteredChats.value.every(c => selectedIds.value.has(c.id))
)
function toggleSelectAll() {
  if (allVisibleSelected.value) {
    selectedIds.value = new Set()
    // v4.5.0 audit L-3 — de-select semua = keluar mode (konsisten dgn toggle row)
    selectionMode.value = false
  } else {
    // Select-all = SEMUA chat yang TAMPIL di list — honoring filter aktif + search
    // (filteredChats); server list sendiri di-cap 100 → by construction ≤100.
    selectionMode.value = true
    selectedIds.value = new Set(filteredChats.value.slice(0, 100).map(c => c.id))
  }
}
function enterSelectionModeFromMenu() {
  const chat = manualUnreadTarget.value
  closeManualUnreadMenu()
  if (!chat?.id || selectionMode.value) return
  selectionMode.value = true
  selectedIds.value.add(chat.id)
}

async function batchResolveSelected() {
  const ids = [...selectedIds.value]
  if (!ids.length || batchBusy.value) return
  const ok = await confirmAction({
    title: 'Resolve chat terpilih?',
    message: `${ids.length} chat akan di-resolve. Chat milik agent lain / yang tidak boleh kamu akses akan dilewati.`,
    confirmText: 'Resolve',
    danger: false,
  })
  if (!ok) return
  batchBusy.value = true
  try {
    const data = await chats.batchResolve(ids)
    const n = (data.resolved || []).length
    const skipped = data.skipped || []
    const m = skipped.length
    const skipNote = m === 0 ? '' : ` — ${m} dilewati (${skipped[0]?.reason === 'not_allowed' ? 'chat agent lain' : skipped[0]?.reason || 'tidak bisa'})`
    toastStore.show({ icon: '✓', title: 'Batch resolve', message: `${n} chat resolved${skipNote}` })
    await fetchChatsWithFilters()
    exitSelectionMode()
  } catch (e) {
    toastStore.show({ icon: '⚠️', title: 'Batch resolve gagal', message: e.response?.data?.error || e.message })
  } finally {
    batchBusy.value = false
  }
}

async function batchMarkReadSelected() {
  const ids = [...selectedIds.value]
  if (!ids.length || batchBusy.value) return
  batchBusy.value = true
  try {
    const data = await chats.batchMarkRead(ids)
    const n = (data.marked || []).length
    const m = (data.skipped || []).length
    toastStore.show({ icon: '📖', title: 'Batch dibaca', message: m === 0 ? `${n} chat ditandai dibaca` : `${n} dibaca, ${m} dilewati` })
    await fetchChatsWithFilters()
    exitSelectionMode()
  } catch (e) {
    toastStore.show({ icon: '⚠️', title: 'Gagal', message: e.response?.data?.error || e.message })
  } finally {
    batchBusy.value = false
  }
}

function batchMarkUnreadSelected() {
  const ids = [...selectedIds.value]
  if (!ids.length) return
  for (const id of ids) manualUnreadAdd(id)
  toastStore.show({
    icon: '🔵',
    title: 'Batch belum dibaca',
    message: `${ids.length} chat ditandai belum dibaca (marker personal perangkat ini)`,
  })
  exitSelectionMode()
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
// v4.1.4 — tag_updated: rename/ganti warna tag di tempat lain → update in-place by id
function onTagCreated(data) {
  if (data.tag && !allTags.value.find(t => t.id === data.tag.id)) {
    allTags.value.push(data.tag)
  }
}
function onTagDeleted(data) {
  allTags.value = allTags.value.filter(t => t.id !== data.tagId)
}
function onTagUpdated(data) {
  if (!data.tag) return
  const idx = allTags.value.findIndex(t => t.id === data.tag.id)
  // v4.4.0 F3 — spread penuh: rename/warna/excludeFromQueue ikut ter-sync realtime
  if (idx !== -1) allTags.value[idx] = { ...data.tag }
}

import { useSocketStore } from '../stores/socket'
// v4.1.3.1 — pindah route → tutup menu kontekstual
import { useRoute } from 'vue-router'
const route = useRoute()
watch(() => route.fullPath, () => { if (showManualUnreadMenu.value) closeManualUnreadMenu() })
const socketStore = useSocketStore()

onMounted(() => {
  // v4.1.3.1 — load marker + listeners tutup menu (Esc / scroll / pindah route)
  manualUnreadMap.value = { ...manualUnreadList() }
  // v4.1.3.1 hotfix — reactivity: sync ulang saat add/remove (same-tab event) + cross-tab storage
  window.addEventListener('cb-manual-unread-changed', onManualUnreadChanged)
  window.addEventListener('storage', onManualUnreadChanged)
  window.addEventListener('keydown', onManualUnreadKeydown)
  window.addEventListener('scroll', onManualUnreadScroll, true)
  window.addEventListener('popstate', onManualUnreadRouteLeave)
  fetchAllTags()
  fetchAgentList()
  fetchWaSlots() // v3.9.2 K1-A — data badge nomor asal
  socketStore.on('tag_created', onTagCreated)
  socketStore.on('tag_deleted', onTagDeleted)
  socketStore.on('tag_updated', onTagUpdated) // v4.1.4 — edit tag realtime
  // v3.9.2 — refresh slot badge saat status WA berubah (connect/logout)
  socketStore.on('wa_status', onWaStatusChanged)
  // v4.0.0 — tick 60s: badge "🤖 ×N" mati otomatis saat window 24 jam lewat
  nowTimer = setInterval(() => { nowMs.value = Date.now() }, 60 * 1000)
})
onUnmounted(() => {
  // v4.1.3.1 — cleanup
  window.removeEventListener('cb-manual-unread-changed', onManualUnreadChanged)
  window.removeEventListener('storage', onManualUnreadChanged)
  window.removeEventListener('keydown', onManualUnreadKeydown)
  window.removeEventListener('scroll', onManualUnreadScroll, true)
  window.removeEventListener('popstate', onManualUnreadRouteLeave)
  clearTimeout(manualUnreadTouchTimer)
  socketStore.off('tag_created', onTagCreated)
  socketStore.off('tag_deleted', onTagDeleted)
  socketStore.off('tag_updated', onTagUpdated) // v4.1.4 — edit tag realtime
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
