<template>
  <!--
    v0.9.0 — index.html: rebrand "ChatBareng" + anti-FOUC theme init SEBELUM Vue mount.
    Init script membaca localStorage themeMode (default system) → set data-theme
    pada <html> sebelum paint pertama (spec §2).
  -->
  <div class="h-vp flex flex-col overflow-hidden">
    <!-- Desktop top bar (>=768px) — layout tetap, reskin M3 (m3-topbar) -->
    <header class="hidden md:flex m3-topbar px-4 py-3 items-center justify-between flex-shrink-0">
      <div class="flex items-center gap-3">
        <BrandLogo size="lg" class="md-topbar-brand" suffix />
        <!-- v0.9.0-r2 (audit fix #4): chip status koneksi pakai token M3 —
             connected = success-container, menunggu QR/connecting = tertiary-container,
             disconnected = error-container. Merah hardcoded dihapus. -->
        <span v-if="waStatus.connected" class="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full"
          :style="{ background: 'var(--md-sys-color-success-container)', color: 'var(--md-sys-color-on-success-container)' }">
          <span class="w-2 h-2 rounded-full" :style="{ background: 'var(--md-sys-color-success)' }"></span> Connected
        </span>
        <span v-else-if="waStatus.qrNeeded" class="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full"
          :style="{ background: 'var(--md-sys-color-tertiary-container)', color: 'var(--md-sys-color-on-tertiary-container)' }">
          <span class="w-2 h-2 rounded-full" :style="{ background: 'var(--md-sys-color-tertiary)' }"></span> Menunggu QR
        </span>
        <span v-else class="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full"
          :style="{ background: 'var(--md-sys-color-error-container)', color: 'var(--md-sys-color-on-error-container)' }">
          <span class="w-2 h-2 rounded-full" :style="{ background: 'var(--md-sys-color-error)' }"></span> {{ waStatus.state === 'connecting' ? 'Connecting' : 'Disconnected' }}
        </span>
      </div>
      <div class="flex items-center gap-2">
        <router-link v-if="auth.isAdmin" to="/admin" class="text-sm hover:underline m3-topbar__link">Admin Panel</router-link>
        <router-link to="/contacts" class="text-sm hover:underline m3-topbar__link">Kontak</router-link>
        <!-- v0.14.0 — nav Grup (desktop topbar, setelah Kontak) -->
        <router-link to="/groups" class="text-sm hover:underline m3-topbar__link">Grup</router-link>
        <router-link to="/blast" class="text-sm hover:underline m3-topbar__link">Blast</router-link>
        <AnnouncementBell />
        <button
          @click="cycleTheme"
          class="m3-icon-btn !w-11 !h-11"
          :title="themeIcon.title"
          :aria-label="themeIcon.title"
        >{{ themeIcon.icon }}</button>
        <router-link to="/settings" class="text-sm hover:underline m3-topbar__link">{{ auth.user?.username }}</router-link>
        <button @click="handleLogout" class="text-sm hover:underline m3-topbar__link">Logout</button>
      </div>
    </header>

    <!-- Mobile top bar (list view only) -->
    <header
      v-if="!isMobileDetail"
      class="md:hidden sticky top-0 z-30 m3-topbar px-4 py-3 flex items-center justify-between flex-shrink-0"
      style="padding-top: calc(12px + env(safe-area-inset-top, 0px));"
    >
      <div class="flex items-center gap-2">
        <BrandLogo size="sm" />
        <!-- v0.9.0-r2 (audit fix #4): chip status mobile — token M3, map sama dgn desktop -->
        <span class="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full"
          :style="waStatus.connected
            ? { background: 'var(--md-sys-color-success-container)', color: 'var(--md-sys-color-on-success-container)' }
            : (waStatus.qrNeeded || waStatus.state === 'connecting')
              ? { background: 'var(--md-sys-color-tertiary-container)', color: 'var(--md-sys-color-on-tertiary-container)' }
              : { background: 'var(--md-sys-color-error-container)', color: 'var(--md-sys-color-on-error-container)' }">
          <span class="w-1.5 h-1.5 rounded-full" :style="{ background: waStatus.connected ? 'var(--md-sys-color-success)' : (waStatus.qrNeeded || waStatus.state === 'connecting') ? 'var(--md-sys-color-tertiary)' : 'var(--md-sys-color-error)' }"></span>
          {{ waStatus.connected ? 'Online' : waStatus.qrNeeded ? 'Menunggu QR' : waStatus.state === 'connecting' ? 'Connecting' : 'Offline' }}
        </span>
      </div>
      <div class="flex items-center gap-1">
        <button
          @click="cycleTheme"
          class="m3-icon-btn !w-11 !h-11"
          :aria-label="themeIcon.title"
        >{{ themeIcon.icon }}</button>
        <AnnouncementBell />
      </div>
    </header>

    <!-- Main area -->
    <div class="flex-1 flex overflow-hidden">
      <!-- ═══ Chat list pane ═══
           Mobile: full-width kalau bukan detail; hidden kalau detail terbuka.
           Desktop: sidebar 320px split (tetap). -->
      <div
        class="border-r border-gray-200 bg-white flex flex-col flex-shrink-0 overflow-hidden"
        :class="isMobileDetail ? 'hidden' : 'flex w-full md:w-80'"
      >
        <!-- Filter chips (Mine/All/Unassigned/Resolved) -->
        <FilterChips :model-value="filter" :snoozed-count="snoozedCount" @change="changeFilter" />

        <!-- v0.13.0 — chip admin "⏳ Menunggu menu (N)" (limbo, belum pilih menu) —
             klik = flyout daftar (read-only, tidak bisa take dari flyout). Realtime
             via menu_waiting_update + refetch on resume-sync. CS tidak melihat ini. -->
        <div
          v-if="auth.isAdmin && menuWaitingCount > 0"
          class="border-t border-amber-100 bg-amber-50 px-3 py-2 flex-shrink-0 relative"
        >
          <button @click="toggleMenuWaitingFlyout" class="text-sm text-amber-800 hover:underline" style="min-height: 36px;">
            ⏳ Menunggu menu ({{ menuWaitingCount }})
          </button>
          <div
            v-if="showMenuWaitingFlyout"
            class="absolute left-2 top-full mt-1 w-72 max-h-60 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg z-40 p-2"
          >
            <div v-if="menuWaitingList.length === 0" class="text-xs text-gray-400 p-2">Memuat…</div>
            <div v-else>
              <div v-for="w in menuWaitingList" :key="w.id" class="px-2 py-1.5 border-b border-gray-100 last:border-0">
                <div class="text-sm text-gray-800">{{ w.contactName || 'Tanpa nama' }}</div>
                <div class="text-xs text-gray-400">{{ w.phone || '—' }} · menunggu {{ Math.max(1, Math.round((w.waitedSeconds || 0) / 60)) }} mnt</div>
              </div>
            </div>
          </div>
        </div>

        <div class="flex-1 overflow-hidden flex flex-col">
          <ChatListPane
            ref="chatListPaneRef"
            :active-chat-id="currentChat?.id || null"
            @select="selectChat"
            @select-search="selectChatFromSearch"
          />
        </div>

        <!-- Desktop queue banner (dalam layout list, seperti v0.1.x) -->
        <!-- v0.5.0 — hidden untuk relay (Cabang): tidak bisa take dari antrean -->
        <div
          v-if="queueCount > 0 && !auth.isRelay"
          class="hidden md:flex border-t border-gray-200 bg-green-50 px-3 py-2 items-center justify-between flex-shrink-0"
        >
          <span class="text-sm text-green-800">📨 {{ queueCount }} chat baru di antrean</span>
          <button
            @click="handleTakeNext"
            :disabled="chats.taking"
            class="m3-btn m3-btn--filled !min-h-[36px] !px-4 text-xs disabled:opacity-50"
          >
            {{ chats.taking ? 'Taking...' : 'Take' }}
          </button>
        </div>
      </div>

      <!-- ═══ Chat detail + Tangan Kanan ═══
           Mobile: full-screen overlay; Desktop: pane kanan split. -->
      <div v-if="currentChat || isDesktop" class="flex-1 flex overflow-hidden relative">
        <div class="flex-1 flex flex-col overflow-hidden min-w-0 relative" :class="isMobileDetail ? 'fixed top-0 left-0 z-30 bg-gray-50 w-full h-vp' : ''">
          <!-- No chat selected (desktop empty state) -->
          <div v-if="!currentChat" class="flex-1 flex items-center justify-center text-gray-400">
            <div class="text-center">
              <svg class="w-16 h-16 mx-auto mb-4 text-gray-300" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 2C6.48 2 2 6.48 2 12c0 1.85.5 3.58 1.38 5.07L2 22l5.07-1.38C8.42 21.5 10.15 22 12 22c5.52 0 10-4.48 10-10S17.52 2 12 2zm0 18c-1.66 0-3.22-.45-4.55-1.24l-.34-.2-3.01.82.82-3.01-.2-.34C3.45 15.22 3 13.66 3 12c0-4.96 4.04-9 9-9s9 4.04 9 9-4.04 9-9 9z"/>
              </svg>
              <p>Select a chat to start messaging</p>
            </div>
          </div>

          <!-- Chat thread -->
          <ChatDetail
            v-else
            ref="chatDetailRef"
            :chat="currentChat"
            :messages="currentMessages"
            :loading-messages="loadingMessages"
            :typing-user="typingUser"
            :reply-text="replyText"
            :sending="sending"
            :sending-media="sendingMedia"
            :show-search-bar="showSearchBar"
            :search-query="searchQuery"
            :search-results="searchResults"
            :search-loading="searchLoading"
            :show-favorites-panel="showFavoritesPanel"
            :chat-favorites="chatFavorites"
            :favorites-loading="favoritesLoading"
            :favorited-msg-ids="favoritedMsgIds"
            :highlighted-msg-id="highlightedMsgId"
            :all-tags="allTags"
            :all-templates="allTemplates"
            :show-template-flyout="showTemplateFlyout"
            :template-matches="templateMatches"
            :selected-template-index="selectedTemplateIndex"
            :transfer-users="transferUsers"
            :is-snoozed="currentChat?.snoozedUntil ? new Date(currentChat.snoozedUntil) > new Date() : false"
            :notes="chatNotes"
            :notes-loading="notesLoading"
            :notes-adding="notesAdding"
            :note-draft="noteDraft"
            :scheduled="chatScheduled"
            :scheduled-loading="scheduledLoading"
            @update:replyText="replyText = $event"
            @update:noteDraft="noteDraft = $event"
            @update:searchQuery="searchQuery = $event; onSearchInput()"
            @send="sendReply"
            @upload-media="handleFileUpload"
            @reply-keydown="handleReplyKeydown"
            @insert-template="insertTemplateContent"
            @insert-template-flyout="insertTemplateFromFlyout"
            @transfer="handleTransfer"
            @release="confirmRelease"
            @take="handleAssign"
            @resolve="handleResolve"
            @tangan-kanan="openTanganKanan"
            @snooze="showSnoozeDialog = true"
            @cancel-snooze="handleCancelSnooze"
            @delete-chat="confirmDeleteChat"
            @schedule-message="openScheduledDialog"
            @cancel-scheduled="handleCancelScheduled"
            @add-note="addChatNote"
            @delete-note="deleteChatNote"
            @toggle-favorites="toggleFavoritesPanel"
            @toggle-favorite="toggleFavorite"
            @jump-to="jumpToMessage"
            @toggle-search="toggleSearchBar"
            @close-search="closeSearchBar"
            @add-tag="addTag"
            @remove-tag="removeTag"
            @create-tag="onCreateTag"
            @open-contact-edit="openContactEditForCurrentChat"
          />
        </div>

        <!-- Tangan Kanan sidebar — Desktop: rail toggle + panel samping (v0.1.x behavior) -->
        <template v-if="!isMobileDetail">
          <button
            v-if="!tkOpen"
            @click="tkOpen = true; saveTkState()"
            class="absolute top-1/2 -translate-y-1/2 right-0 z-10 bg-white border border-gray-200 border-r-0 rounded-l-lg w-7 h-14 flex items-center justify-center text-gray-400 hover:text-wa-green hover:bg-gray-50 shadow-sm"
            title="Open Tangan Kanan"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
    <TanganKanan
      v-if="tkOpen"
      :current-chat="currentChat"
      @close="tkOpen = false; saveTkState()"
    />
        </template>
      </div>
    </div>

    <!-- Mobile Tangan Kanan fullscreen sheet (spec §3.2) -->
    <Teleport to="body">
      <Transition name="fade">
        <div v-if="isMobileDetail && tkOpen" class="fixed inset-0 bg-black/40 z-50 md:hidden" @click="tkOpen = false"></div>
      </Transition>
      <Transition name="sheet">
        <div
          v-if="isMobileDetail && tkOpen"
          class="fixed left-0 right-0 bottom-0 z-50 bg-white rounded-t-2xl shadow-2xl md:hidden flex flex-col"
          style="height: 88vh; padding-top: env(safe-area-inset-top, 0px);"
        >
          <div class="pt-2 pb-1 flex justify-center flex-shrink-0">
            <div class="w-10 h-1 rounded-full bg-gray-300"></div>
          </div>
          <div class="px-4 pb-2 flex items-center justify-between border-b border-gray-100 flex-shrink-0">
            <span class="font-semibold text-sm text-gray-800">📎 Tangan Kanan</span>
            <button @click="tkOpen = false" class="p-1.5 rounded-full hover:bg-gray-100 text-gray-500">✕</button>
          </div>
          <div class="flex-1 overflow-hidden">
            <TanganKanan
              variant="mobile-full"
              :current-chat="currentChat"
              @close="tkOpen = false"
            />
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- Mobile Queue Banner — fixed bottom DI ATAS homerow (keputusan Kanaka 18:41) -->
    <!-- v0.5.0 — hidden untuk relay (Cabang): tidak bisa take -->
    <QueueBanner v-if="!auth.isRelay" :count="queueCount" :taking="chats.taking" @take="handleTakeNext" />

    <!-- Homerow — hanya mobile, list-level (hilang di chat detail) -->
    <Homerow :visible="!isMobileDetail" />

    <!-- Spacer mobile homerow (list view saja) -->
    <div v-if="!isMobileDetail" class="md:hidden flex-shrink-0" style="height: calc(56px + env(safe-area-inset-bottom, 0px));"></div>

    <!-- Lightbox modal for image zoom -->
    <div
      v-if="lightboxImage"
      @click="lightboxImage = null"
      class="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4 cursor-pointer"
    >
      <button @click.stop="lightboxImage = null" class="absolute top-4 right-4 text-white text-3xl hover:text-gray-300">✕</button>
      <img :src="lightboxImage" alt="image" @click.stop class="max-w-[90vw] max-h-[90vh] object-contain rounded-lg" />
    </div>

    <!-- Floating contact edit overlay -->
    <ContactEditModal
      v-if="showContactEdit"
      :contact="editingContact"
      :chat-id="contactEditChatId"
      @saved="handleContactSaved"
      @close="handleContactEditClose"
      @open-chat="handleContactOpenChat"
    />

    <!-- Release confirm dialog — v0.9.0: M3 ConfirmDialog (logika v0.1.21 TIDAK diubah:
         dialog ini hanya wadah; tombol konfirmasi tetap memanggil handleRelease persis
         seperti tombol dialog lama, tombol batal menutup dialog) -->
    <ConfirmDialog />

    <!-- v0.10.0 — Fitur A: dialog Snooze (preset + custom) -->
    <SnoozeDialog
      v-if="showSnoozeDialog && currentChat"
      :chat="currentChat"
      @confirm="handleSnoozeConfirm"
      @close="showSnoozeDialog = false"
    />

    <!-- v0.10.0 — Fitur D: dialog Pesan Terjadwal (prefill draft reply) -->
    <ScheduledDialog
      v-if="showScheduledDialog && currentChat"
      :body="scheduledDraft"
      :busy="scheduling"
      @update:body="scheduledDraft = $event"
      @confirm="handleScheduleConfirm"
      @close="showScheduledDialog = false"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import axios from 'axios'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { useChatsStore } from '../stores/chats'
import { useSocketStore } from '../stores/socket'
import { useToastStore } from '../stores/toast'
import { usePresenceStore } from '../stores/presence'
import { getThemeMode, applyTheme } from '../utils/theme'
import { useConfirm } from '../utils/confirm'
import ChatListPane from './ChatListPane.vue'
import ChatDetail from './ChatDetail.vue'
import FilterChips from '../components/FilterChips.vue'
import QueueBanner from '../components/QueueBanner.vue'
import Homerow from '../components/Homerow.vue'
import TanganKanan from '../components/TanganKanan.vue'
import AnnouncementBell from '../components/AnnouncementBell.vue'
import ContactEditModal from '../components/ContactEditModal.vue'
import BrandLogo from '../components/BrandLogo.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
// v0.10.0 — Empat Fitur
import SnoozeDialog from '../components/SnoozeDialog.vue'
import ScheduledDialog from '../components/ScheduledDialog.vue'

const API = import.meta.env.VITE_API_URL || ''

const auth = useAuthStore()
const chats = useChatsStore()
const socketStore = useSocketStore()
const toastStore = useToastStore()
const presenceStore = usePresenceStore()
const route = useRoute()
const router = useRouter()
const { confirmAction } = useConfirm()

// ── Layout state ─────────────────────────────────────
const isMobile = ref(typeof window !== 'undefined' ? window.innerWidth < 768 : false)
function onWindowResize() { isMobile.value = window.innerWidth < 768 }

// v0.9.0 — quick theme toggle di top bar: cycle light → dark → system
const themeSeq = ['light', 'dark', 'system']
const themeIcon = computed(() => {
  const m = getThemeMode()
  if (m === 'light') return { icon: '☀️', title: 'Tema: Terang (klik untuk Gelap)' }
  if (m === 'dark') return { icon: '🌙', title: 'Tema: Gelap (klick untuk Sistem)'.replace('klick', 'klik') }
  return { icon: '🖥️', title: 'Tema: Sistem (klik untuk Terang)' }
})
function cycleTheme() {
  const cur = getThemeMode()
  const next = themeSeq[(themeSeq.indexOf(cur) + 1) % themeSeq.length]
  applyTheme(next)
  toastStore.show({ icon: '🎨', title: 'Tema', message: next === 'system' ? 'Ikut sistem' : (next === 'dark' ? 'Mode gelap' : 'Mode terang') })
}

// Mobile detail aktif kalau route /chat/:id ATAU (desktop split memakai ?chat=)
const routeChatId = computed(() => route.params.id || null)
const isMobileDetail = computed(() => isMobile.value && !!currentChat.value)
const isDesktop = computed(() => !isMobile.value)

// ── Chat state (semua state lama Dashboard v0.1.x tetap di sini) ──
const currentChat = ref(null)
const currentMessages = ref([])
const loadingMessages = ref(false)
const replyText = ref('')
const sending = ref(false)
const sendingMedia = ref(false)
const typingUser = ref(null)
const waStatus = ref({ connected: false, state: 'connecting' })
const filter = ref('mine') // v0.1.21 — default 'mine'
const lightboxImage = ref(null)
const transferUsers = ref([])
const chatListPaneRef = ref(null)
const chatDetailRef = ref(null)

// ─── v0.10.0 — Empat Fitur: state ────────────────────────────────
// Fitur A — Snooze
const showSnoozeDialog = ref(false)
const snoozedCount = ref(0) // jumlah chat snoozed aktif (tampil chip 😴 Snoozed)
// Fitur B — Catatan internal (state dikonsumsi NotesPanel via ChatDetail props)
const chatNotes = ref([])
const notesLoading = ref(false)
const notesAdding = ref(false)
const noteDraft = ref('')
// Fitur C — CSAT (badge di ChatDetail baca currentChat.lastCsatRating dari GET /:id)
// Fitur D — Pesan terjadwal
const showScheduledDialog = ref(false)
const scheduledDraft = ref('')
const scheduling = ref(false)
const chatScheduled = ref([])
const scheduledLoading = ref(false)

// v0.1.21 — Queue discipline state (dialog release kini M3 ConfirmDialog)
const releasing = ref(false)
const queueCount = ref(0)

// v0.13.0 — chip admin "⏳ Menunggu menu": count realtime + flyout list read-only
const menuWaitingCount = ref(0)
const menuWaitingList = ref([])
const showMenuWaitingFlyout = ref(false)
function toggleMenuWaitingFlyout() {
  showMenuWaitingFlyout.value = !showMenuWaitingFlyout.value
  if (showMenuWaitingFlyout.value) fetchMenuWaiting()
}
async function fetchMenuWaiting() {
  if (!auth.isAdmin) return
  try {
    const res = await axios.get(`${API}/api/menu-gateway/waiting`)
    menuWaitingCount.value = res.data.count || 0
    menuWaitingList.value = res.data.chats || []
  } catch (e) { console.error('Fetch menu waiting error:', e) }
}
function onMenuWaitingUpdate(data) {
  if (data && typeof data.count === 'number') {
    menuWaitingCount.value = data.count
    if (showMenuWaitingFlyout.value) fetchMenuWaiting()
  }
}

// Favorites state
const showFavoritesPanel = ref(false)
const chatFavorites = ref([])
const favoritesLoading = ref(false)
const favoritedMsgIds = ref(new Set())

// Search state
const showSearchBar = ref(false)
const searchQuery = ref('')
const searchResults = ref([])
const searchLoading = ref(false)
const highlightedMsgId = ref(null)
let searchDebounceTimer = null
let pendingJumpMsgId = null

// Template state
const allTemplates = ref([])
const showTemplateFlyout = ref(false)
const templateMatches = ref([])
const selectedTemplateIndex = ref(0)

// Tag state (realtime sync — list tags milik pane, tapi handler di sini utk chat detail)
const allTags = ref([])

// Tangan Kanan sidebar state (desktop: localStorage; mobile: transient sheet)
const tkOpen = ref(!isMobile.value && localStorage.getItem('tanganKananOpen') === 'true')
function saveTkState() {
  localStorage.setItem('tanganKananOpen', String(tkOpen.value))
}
function openTanganKanan() {
  tkOpen.value = true
  if (!isMobile.value) saveTkState()
}

// Contact edit overlay state
const showContactEdit = ref(false)
const editingContact = ref(null)
const contactEditChatId = ref(null)

let typingTimer = null

// ── Filter change (dari FilterChips / ChatListPane) ──
function changeFilter(val) {
  filter.value = val
  chats.filter = val
  // v0.10.0 — Fitur A: tab "😴 Snoozed" pakai query ?snoozed=1 (server endpoint khusus)
  if (val === 'snoozed') {
    chats.fetchChats({ snoozed: '1' })
  } else {
    chats.fetchChats(chats.filterParams)
  }
  fetchSnoozedCount()
}

// ─── v0.10.0 — Fitur A: Snooze handlers ───────────────────────
async function fetchSnoozedCount() {
  try {
    const res = await axios.get(`${API}/api/chats`, { params: { filter: chats.filter === 'snoozed' ? 'all' : chats.filter, snoozed: '1' } })
    snoozedCount.value = (res.data.chats || []).length
  } catch (e) {
    // CS non-admin: endpoint list dibatasi — hitung dari response Mine+snoozed
    try {
      const res = await axios.get(`${API}/api/chats`, { params: { filter: 'mine', snoozed: '1' } })
      snoozedCount.value = (res.data.chats || []).length
    } catch { snoozedCount.value = 0 }
  }
}

async function handleSnoozeConfirm({ until }) {
  if (!currentChat.value || !until) return
  showSnoozeDialog.value = false
  try {
    await axios.post(`${API}/api/chats/${currentChat.value.id}/snooze`, { until }, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    const name = currentChat.value.contactName || currentChat.value.contactPhone
    currentChat.value.snoozedUntil = until
    currentChat.value.snoozedBy = auth.user.id
    toastStore.show({ icon: '😴', title: 'Chat di-snooze', message: `${name} kembali otomatis pada waktu yang dipilih` })
    chats.fetchChats(chats.filter === 'snoozed' ? { snoozed: '1' } : chats.filterParams)
    fetchSnoozedCount()
  } catch (e) {
    toastStore.show({ icon: '⚠️', title: 'Gagal snooze', message: e.response?.data?.error || e.message })
  }
}

async function handleCancelSnooze() {
  if (!currentChat.value) return
  try {
    await axios.delete(`${API}/api/chats/${currentChat.value.id}/snooze`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    currentChat.value.snoozedUntil = null
    currentChat.value.snoozedBy = null
    toastStore.show({ icon: '😴', title: 'Snooze dibatalkan', message: 'Chat kembali ke list utama' })
    chats.fetchChats(chats.filter === 'snoozed' ? { snoozed: '1' } : chats.filterParams)
    fetchSnoozedCount()
  } catch (e) {
    toastStore.show({ icon: '⚠️', title: 'Gagal batal snooze', message: e.response?.data?.error || e.message })
  }
}

// ─── v0.10.0 — Fitur B: Catatan internal handlers ─────────────
async function fetchChatNotes() {
  if (!currentChat.value) return
  notesLoading.value = true
  try {
    const res = await axios.get(`${API}/api/chats/${currentChat.value.id}/notes`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    chatNotes.value = res.data.notes
  } catch (e) {
    console.error('Fetch notes error:', e)
    chatNotes.value = []
  } finally {
    notesLoading.value = false
  }
}

async function addChatNote() {
  if (!currentChat.value || !noteDraft.value.trim()) return
  notesAdding.value = true
  try {
    const res = await axios.post(`${API}/api/chats/${currentChat.value.id}/notes`,
      { body: noteDraft.value.trim() },
      { headers: { Authorization: `Bearer ${auth.token}` } }
    )
    // Optimistic add; socket note_added dari user lain ter-dedup di handler
    if (!chatNotes.value.some(n => n.id === res.data.note.id)) {
      chatNotes.value.push(res.data.note)
    }
    noteDraft.value = ''
  } catch (e) {
    toastStore.show({ icon: '⚠️', title: 'Gagal simpan catatan', message: e.response?.data?.error || e.message })
  } finally {
    notesAdding.value = false
  }
}

async function deleteChatNote(noteId) {
  try {
    await axios.delete(`${API}/api/chats/notes/${noteId}`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    chatNotes.value = chatNotes.value.filter(n => n.id !== noteId)
  } catch (e) {
    toastStore.show({ icon: '⚠️', title: 'Gagal hapus catatan', message: e.response?.data?.error || e.message })
  }
}

// ─── v0.10.0 — Fitur D: Pesan terjadwal handlers ─────────────
function openScheduledDialog() {
  if (!currentChat.value) return
  scheduledDraft.value = replyText.value // prefill dari draft reply
  showScheduledDialog.value = true
}

async function fetchChatScheduled() {
  if (!currentChat.value) return
  scheduledLoading.value = true
  try {
    const res = await axios.get(`${API}/api/scheduled`, {
      params: { chatId: currentChat.value.id },
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    chatScheduled.value = res.data.scheduled
  } catch (e) {
    console.error('Fetch scheduled error:', e)
    chatScheduled.value = []
  } finally {
    scheduledLoading.value = false
  }
}

async function handleScheduleConfirm({ body, scheduledAt }) {
  if (!currentChat.value) return
  scheduling.value = true
  try {
    await axios.post(`${API}/api/scheduled`,
      { chatId: currentChat.value.id, body, scheduledAt },
      { headers: { Authorization: `Bearer ${auth.token}` } }
    )
    showScheduledDialog.value = false
    scheduledDraft.value = ''
    toastStore.show({ icon: '⏰', title: 'Pesan dijadwalkan', message: 'Pesan akan terkirim otomatis pada waktu yang dipilih' })
    fetchChatScheduled()
  } catch (e) {
    toastStore.show({ icon: '⚠️', title: 'Gagal jadwalkan', message: e.response?.data?.error || e.message })
  } finally {
    scheduling.value = false
  }
}

async function handleCancelScheduled(smId) {
  try {
    await axios.post(`${API}/api/scheduled/${smId}/cancel`, {}, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    chatScheduled.value = chatScheduled.value.filter(s => s.id !== smId)
    toastStore.show({ icon: '⏰', title: 'Pesan dibatalkan', message: 'Pesan terjadwal tidak akan dikirim' })
  } catch (e) {
    toastStore.show({ icon: '⚠️', title: 'Gagal batal', message: e.response?.data?.error || e.message })
  }
}

// ── Select chat (logika v0.1.x + navigasi mobile) ────
async function selectChat(chat, opts = {}) {
  // Mobile: navigasi ke route /chat/:id (full screen) — desktop: tetap state (?chat=)
  const chatId = chat.id
  if (isMobile.value && !opts.fromRoute) {
    router.push({ name: 'ChatDetail', params: { id: chatId } })
    // state fetch dilakukan oleh watch route di bawah
    return
  }

  // Set a minimal placeholder so the template switches to chat view immediately
  currentChat.value = chat
  socketStore.joinChat(chatId)
  // Await the full fetch BEFORE setting currentChat so the reply box renders with full data
  await chats.fetchChat(chatId)
  if (!chats.currentChat) {
    // v0.1.24 — chat tidak dapat diakses (404/403): jangan diam-diam balik ke list
    currentChat.value = null
    socketStore.leaveChat(chatId)
    if (isMobile.value) router.replace('/')
    toastStore.show({
      icon: '⚠️',
      title: 'Gagal membuka chat',
      message: 'Chat sudah ditangani CS lain atau tidak dapat diakses.',
    })
    return
  }
  currentChat.value = chats.currentChat
  currentMessages.value = chats.currentMessages
  // v0.5.1 — clear highlight "transfer belum dibaca" di list (optimistic):
  // server sudah clear transferUnseen saat assignee membuka chat; ikuti state
  // dari respon GET supaya viewer non-assignee gak menghapus highlight orang lain.
  if (!chats.currentChat?.transferUnseen) {
    const listChatTransfer = chats.chats.find(c => c.id === chatId)
    if (listChatTransfer) listChatTransfer.transferUnseen = false
  }
  await chats.markRead(chatId)
  const listChat = chats.chats.find(c => c.id === chatId)
  if (listChat) listChat.unreadCount = 0
  chats.unreadTotal = chats.chats.reduce((n, c) => n + (c.unreadCount || 0), 0)
  // Fetch users for transfer menu — v0.5.0: selalu /api/users/agents
  // (server kirim online-only utk non-admin, semua+flag online utk admin)
  try {
    const res = await axios.get(`${API}/api/users/agents`)
    transferUsers.value = res.data.users.filter(u => u.status === 'active' || !u.status)
  } catch (e) { console.error('Fetch users for transfer:', e) }
  // Reset search + favorites state for new chat
  showSearchBar.value = false
  searchQuery.value = ''
  searchResults.value = []
  showFavoritesPanel.value = false
  chatFavorites.value = []
  await fetchChatFavorites()
  // v0.10.0 — fetch catatan internal + pesan terjadwal utk chat ini
  chatNotes.value = []
  noteDraft.value = ''
  chatScheduled.value = []
  fetchChatNotes()
  fetchChatScheduled()
  // Pending jump from global search
  if (pendingJumpMsgId) {
    await nextTick()
    let attempts = 0
    const tryJump = () => {
      const el = document.getElementById(`msg-${pendingJumpMsgId}`)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        highlightedMsgId.value = pendingJumpMsgId
        const jumpId = pendingJumpMsgId
        pendingJumpMsgId = null
        setTimeout(() => {
          if (highlightedMsgId.value === jumpId) highlightedMsgId.value = null
        }, 2000)
      } else {
        attempts++
        if (attempts < 10) setTimeout(tryJump, 200)
        else pendingJumpMsgId = null
      }
    }
    tryJump()
  } else {
    scrollToBottom()
  }
}

// Mobile route-driven select: /chat/:id masuk → fetch chat by id
async function selectChatFromRoute(chatId) {
  const listChat = chats.chats.find(c => c.id === chatId) || { id: chatId }
  await selectChat(listChat, { fromRoute: true })
}

// Ditutup: mobile back / route leave → leave_chat + clear
async function closeDetail() {
  if (currentChat.value) {
    socketStore.leaveChat(currentChat.value.id)
  }
  currentChat.value = null
  currentMessages.value = []
  transferUsers.value = []
  showSearchBar.value = false
  showFavoritesPanel.value = false
  tkOpen.value = false
}

// Watch route param untuk mobile navigation (join/leave benar, spec §4.1)
watch(routeChatId, async (newId, oldId) => {
  if (!isMobile.value) return
  if (newId && newId !== oldId) {
    await selectChatFromRoute(newId)
  } else if (!newId && oldId) {
    await closeDetail()
  }
})

// v0.1.24 — buka chat dari ?chat= query (menu Kontak) LANGSUNG via fetchChat
async function maybeAutoSelectFromQuery() {
  const chatId = route.query.chat
  if (!chatId) return
  router.replace({ query: {} })
  if (isMobile.value) {
    router.push({ name: 'ChatDetail', params: { id: chatId } })
  } else {
    await selectChat({ id: chatId })
  }
}

// v0.1.26 pattern — cari chat object by id helper
async function selectChatFromSearch(chatData, msgId) {
  const fullChat = chats.chats.find(c => c.id === chatData.id) || chatData
  pendingJumpMsgId = msgId
  await selectChat(fullChat)
}

function scrollToBottom() {
  chatDetailRef.value?.scrollToBottom()
}

// ─── Reply / media (logika v0.1.x identik) ────────────
async function sendReply() {
  if (!replyText.value.trim() || sending.value) return
  sending.value = true
  try {
    await chats.sendReply(currentChat.value.id, replyText.value)
    currentMessages.value = chats.currentMessages
    replyText.value = ''
    showTemplateFlyout.value = false
    templateMatches.value = []
    socketStore.emitStopTyping(currentChat.value.id, auth.user.id)
    scrollToBottom()
  } catch (e) {
    console.error('Send reply error:', e)
  } finally {
    sending.value = false
  }
}

async function handleFileUpload(event) {
  const file = event.target.files?.[0]
  if (!file) return

  sendingMedia.value = true
  try {
    const formData = new FormData()
    formData.append('file', file)
    if (replyText.value.trim()) {
      formData.append('caption', replyText.value.trim())
    }

    const res = await axios.post(
      `${API}/api/chats/${currentChat.value.id}/media`,
      formData,
      {
        headers: {
          'Content-Type': 'multipart/form-data',
          Authorization: `Bearer ${auth.token}`,
        },
      }
    )

    // Add message to current list (if not already from socket)
    const exists = currentMessages.value.some(m => m.id === res.data.message.id)
    if (!exists) {
      currentMessages.value.push(res.data.message)
    }

    replyText.value = ''
    socketStore.emitStopTyping(currentChat.value.id, auth.user.id)
    scrollToBottom()
  } catch (e) {
    console.error('Media upload error:', e)
    toastStore.show({ icon: '⚠️', title: 'Gagal kirim media', message: e.response?.data?.error || e.message })
  } finally {
    sendingMedia.value = false
    // Clear file input so same file can be selected again
    event.target.value = ''
  }
}

// ─── Contact edit overlay handlers ───────────────────
async function openContactEditForCurrentChat() {
  if (!currentChat.value) return
  const chatId = currentChat.value.id
  try {
    const res = await axios.get(`${API}/api/contacts/by-chat/${chatId}`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    editingContact.value = res.data.contact
    contactEditChatId.value = chatId
    showContactEdit.value = true
  } catch (e) {
    console.error('Open contact edit error:', e)
    toastStore.show({ icon: '⚠️', title: 'Gagal membuka kontak', message: e.response?.data?.error || e.message })
  }
}

function handleContactSaved(contact) {
  // v0.14.6 — nama manual = override display (bukan cuma saat kosong): chatlist &
  // header baca chat.contactName. PUT /api/contacts/:id sekarang sync field itu
  // di server; state lokal di-update juga biar instan tanpa nunggu socket event.
  if (currentChat.value && contactEditChatId.value === currentChat.value.id) {
    currentChat.value.contactName = contact.name || null
  }
  const listChat = chats.chats.find(c => c.id === contactEditChatId.value)
  if (listChat) {
    listChat.contactName = contact.name || null
  }
  showContactEdit.value = false
}

function handleContactEditClose() {
  showContactEdit.value = false
}

async function handleContactOpenChat(contact) {
  try {
    const res = await axios.post(`${API}/api/contacts/${contact.id}/open`, {}, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    const chatData = res.data.chat
    // Upsert chat in store
    const existing = chats.chats.find(c => c.id === chatData.id)
    if (!existing) {
      chats.chats.unshift({
        id: chatData.id,
        contactName: chatData.contactName || contact.name || contact.phone,
        contactPhone: chatData.contactPhone || contact.phone,
        status: chatData.status,
        lastMessageAt: chatData.lastMessageAt,
        unreadCount: chatData.unreadCount,
        assignedTo: chatData.assignedTo,
        tags: chatData.tags || [],
      })
    }
    await selectChat({ id: chatData.id })
  } catch (e) {
    console.error('Open chat from contact error:', e)
    toastStore.show({ icon: '⚠️', title: 'Gagal membuka chat', message: e.response?.data?.error || e.message })
  }
}

// ─── Template functions (logika v0.1.x identik) ──────
async function fetchTemplates() {
  try {
    const res = await axios.get(`${API}/api/templates`)
    allTemplates.value = res.data.templates
  } catch (e) {
    console.error('Fetch templates error:', e)
  }
}

function insertTemplateContent(content) {
  const input = chatDetailRef.value?.replyInputRef
  if (!input) {
    replyText.value += content
    return
  }
  const cursorPos = input.selectionStart
  const before = replyText.value.substring(0, cursorPos)
  const after = replyText.value.substring(cursorPos)
  replyText.value = before + content + after
  nextTick(() => {
    input.focus()
    const newPos = cursorPos + content.length
    input.setSelectionRange(newPos, newPos)
  })
}

function insertTemplateFromFlyout(tpl) {
  const input = chatDetailRef.value?.replyInputRef
  if (!input) return
  const cursorPos = input.selectionStart
  const beforeCursor = replyText.value.substring(0, cursorPos)
  const afterCursor = replyText.value.substring(cursorPos)
  const lastSpace = beforeCursor.lastIndexOf(' ') + 1
  replyText.value = beforeCursor.substring(0, lastSpace) + tpl.content + afterCursor
  showTemplateFlyout.value = false
  templateMatches.value = []
  nextTick(() => {
    input.focus()
    const newPos = lastSpace + tpl.content.length
    input.setSelectionRange(newPos, newPos)
  })
}

function handleReplyKeydown(e) {
  // Slash flyout keyboard navigation
  if (showTemplateFlyout.value) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      selectedTemplateIndex.value = Math.min(selectedTemplateIndex.value + 1, templateMatches.value.length - 1)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      selectedTemplateIndex.value = Math.max(selectedTemplateIndex.value - 1, 0)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const selected = templateMatches.value[selectedTemplateIndex.value]
      if (selected) {
        insertTemplateFromFlyout(selected)
      }
      return
    }
    if (e.key === 'Escape') {
      showTemplateFlyout.value = false
      templateMatches.value = []
      return
    }
    if (e.key === ' ') {
      showTemplateFlyout.value = false
      templateMatches.value = []
    }
  } else {
    if (e.key === 'Enter') {
      sendReply()
      return
    }
  }
  onTyping()
}

// Watch replyText for slash command detection
watch(replyText, (newVal) => {
  if (!newVal) { showTemplateFlyout.value = false; return }
  if (!allTemplates.value.length) return

  const input = chatDetailRef.value?.replyInputRef
  const cursorPos = input?.selectionStart || newVal.length
  const beforeCursor = newVal.substring(0, cursorPos)
  const lastSpace = beforeCursor.lastIndexOf(' ') + 1
  const currentWord = beforeCursor.substring(lastSpace)

  if (currentWord.startsWith('/') && currentWord.length >= 1) {
    const query = currentWord.toLowerCase()
    const matches = allTemplates.value.filter(t =>
      t.keyword.toLowerCase().includes(query) ||
      t.name.toLowerCase().includes(query.substring(1))
    ).slice(0, 5)

    if (matches.length > 0) {
      templateMatches.value = matches
      showTemplateFlyout.value = true
      selectedTemplateIndex.value = 0
    } else {
      showTemplateFlyout.value = false
      templateMatches.value = []
    }
  } else {
    showTemplateFlyout.value = false
    templateMatches.value = []
  }
})

function onTemplateUpdate() {
  fetchTemplates()
}

function onTyping() {
  if (currentChat.value) {
    socketStore.emitTyping(currentChat.value.id, auth.user.id, auth.user.username)
    clearTimeout(typingTimer)
    typingTimer = setTimeout(() => {
      socketStore.emitStopTyping(currentChat.value.id, auth.user.id)
    }, 2000)
  }
}

// ─── Assign / Release / Transfer / Resolve (v0.1.21 + hotfixes, identik) ───
async function handleAssign() {
  try {
    await chats.assignChat(currentChat.value.id)
    currentChat.value.assignedTo = { id: auth.user.id, username: auth.user.username }
    currentChat.value.assignedToId = auth.user.id
    chats.fetchChats(chats.filterParams)
  } catch (e) {
    console.error(e)
    toastStore.show({ icon: '⚠️', title: 'Gagal mengambil chat', message: e.response?.data?.error || 'Failed to take chat' })
  }
}

function confirmRelease() {
  // v0.9.0 — dialog M3 (useConfirm); teks & aksi sama dengan dialog lama v0.1.21.
  // handleRelease tetap dipanggil persis seperti tombol "Release" dialog lama.
  confirmAction({
    title: 'Release chat ini?',
    message: 'Yakin mau release chat ini? Chat masuk antrean dan bisa diambil agent lain.',
    confirmText: 'Release',
    danger: true,
  }).then(ok => { if (ok) handleRelease() })
}

async function handleRelease() {
  // v0.1.21 hotfix — chat bisa ke-unbind (realtime) saat confirm dialog masih terbuka
  if (!currentChat.value) {
    return
  }
  releasing.value = true
  try {
    await chats.releaseChat(currentChat.value.id)
    if (!currentChat.value) {
      // realtime sudah handle (detail ditutup + toast + list refresh)
      chats.fetchQueueCount().then(() => { queueCount.value = chats.queueCount })
      return
    }
    currentChat.value.assignedTo = null
    currentChat.value.assignedToId = null
    // Chat masuk antrean → keluar dari Mine list, refresh
    chats.fetchChats(chats.filterParams)
    await chats.fetchQueueCount()
    queueCount.value = chats.queueCount
  } catch (e) {
    console.error(e)
    toastStore.show({ icon: '⚠️', title: 'Gagal release chat', message: e.response?.data?.error || 'Failed to release chat' })
  } finally {
    releasing.value = false
  }
}

async function handleTakeNext() {
  try {
    const data = await chats.takeNext()
    if (data?.chat) {
      const name = data.chat.contactName || data.chat.contactPhone
      await selectChat(data.chat)
      chats.fetchChats(chats.filterParams)
      await chats.fetchQueueCount()
      queueCount.value = chats.queueCount
      toastStore.show({
        icon: '✅',
        title: 'Chat diambil',
        message: `Chat diambil: ${name}`,
      })
    }
  } catch (e) {
    chats.fetchQueueCount().then(() => { queueCount.value = chats.queueCount })
    if (e.response?.status === 404) {
      toastStore.show({
        icon: '📭',
        title: 'Antrean kosong',
        message: 'Antrean kosong',
      })
    } else {
      toastStore.show({
        icon: '⚠️',
        title: 'Gagal mengambil chat',
        message: e.response?.data?.error || 'Coba lagi',
      })
    }
  }
}

async function handleTransfer(userId) {
  try {
    await chats.assignChat(currentChat.value.id, userId)
    // v0.5.0 — nama target dari /api/users/agents (CS/relay gak punya akses /api/users)
    let username = ''
    try {
      const res = await axios.get(`${API}/api/users/agents`)
      const user = (res.data.users || []).find(u => u.id === userId)
      username = user?.username || ''
    } catch {}
    currentChat.value.assignedTo = { id: userId, username }
    currentChat.value.assignedToId = userId
    toastStore.show({
      icon: '↗',
      title: 'Chat ditransfer',
      message: `Chat dialihkan ke @${username || 'agent'}`,
    })
  } catch (e) {
    // v0.5.0 — tampilkan pesan server (mis. "User tujuan sedang offline")
    console.error(e)
    toastStore.show({
      icon: '⚠️',
      title: 'Transfer gagal',
      message: e.response?.data?.error || 'Coba lagi',
    })
  }
}

async function handleResolve() {
  try {
    const res = await chats.resolveChat(currentChat.value.id)
    // v0.1.21.1 hotfix — race: realtime chat_update 'resolved' bisa nyampe duluan
    if (!currentChat.value) return
    currentChat.value.status = 'resolved'
    currentChat.value.resolvedAt = res.chat?.resolvedAt || new Date().toISOString()
    const listChat = chats.chats.find(c => c.id === currentChat.value.id)
    if (listChat) {
      listChat.status = 'resolved'
      listChat.resolvedAt = currentChat.value.resolvedAt
    }
  } catch (e) {
    console.error('Resolve error:', e)
    toastStore.show({ icon: '⚠️', title: 'Gagal resolve', message: e.response?.data?.error || e.message })
  }
}

// ─── Tag actions (logika v0.1.x identik) ──────────────
async function addTag(tagId) {
  try {
    await chats.addTagToChat(currentChat.value.id, tagId)
    // Socket.IO chat_update with tagAdded handles it (Bug #1 fix v0.1.x)
  } catch (e) {
    console.error('Add tag error:', e)
  }
}

async function removeTag(tagId) {
  try {
    await chats.removeTagFromChat(currentChat.value.id, tagId)
  } catch (e) {
    console.error('Remove tag error:', e)
  }
}

async function onCreateTag({ name, color }) {
  if (!name.trim()) return
  try {
    const tag = await chats.createTag(name.trim(), color)
    // tag_created Socket.IO event handles list sync; tambah manual utk pane
    if (!allTags.value.find(t => t.id === tag.id)) {
      allTags.value.push(tag)
    }
    await addTag(tag.id)
  } catch (e) {
    if (e.response?.status === 409 && e.response?.data?.tag) {
      const existingTag = e.response.data.tag
      if (!allTags.value.find(t => t.id === existingTag.id)) {
        allTags.value.push(existingTag)
      }
      await addTag(existingTag.id)
    } else {
      console.error('Create tag error:', e)
      toastStore.show({ icon: '⚠️', title: 'Gagal membuat tag', message: e.response?.data?.error || e.message })
    }
  }
}

async function deleteTag(tagId) {
  // v0.9.0 — confirm() native → M3 dialog; handler chats.deleteTag TIDAK berubah.
  const ok = await confirmAction({
    title: 'Delete tag ini?',
    message: 'Tag akan dihapus dari semua chat.',
    confirmText: 'Hapus',
    danger: true,
  })
  if (!ok) return
  try {
    await chats.deleteTag(tagId)
    allTags.value = allTags.value.filter(t => t.id !== tagId)
    if (currentChat.value?.tags) {
      currentChat.value.tags = currentChat.value.tags.filter(ct => ct.tag.id !== tagId)
    }
    chats.chats.forEach(c => {
      if (c.tags) c.tags = c.tags.filter(ct => ct.tag.id !== tagId)
    })
  } catch (e) {
    console.error('Delete tag error:', e)
    toastStore.show({ icon: '⚠️', title: 'Gagal menghapus tag', message: e.response?.data?.error || e.message })
  }
}

// ─── Favorite + Search (logika v0.1.x identik) ────────
function toggleFavorite(msgId) {
  return doToggleFavorite(msgId)
}

async function doToggleFavorite(msgId) {
  try {
    const res = await axios.post(
      `${API}/api/chats/${currentChat.value.id}/messages/${msgId}/favorite`,
      {},
      { headers: { Authorization: `Bearer ${auth.token}` } }
    )
    if (res.data.favorited) {
      favoritedMsgIds.value.add(msgId)
    } else {
      favoritedMsgIds.value.delete(msgId)
    }
    if (showFavoritesPanel.value) {
      await fetchChatFavorites()
    }
  } catch (e) {
    console.error('Toggle favorite error:', e)
  }
}

async function fetchChatFavorites() {
  if (!currentChat.value) return
  favoritesLoading.value = true
  try {
    const res = await axios.get(
      `${API}/api/chats/${currentChat.value.id}/favorites`,
      { headers: { Authorization: `Bearer ${auth.token}` } }
    )
    chatFavorites.value = res.data.favorites
    favoritedMsgIds.value = new Set(res.data.favorites.map(f => f.message.id))
  } catch (e) {
    console.error('Fetch favorites error:', e)
  } finally {
    favoritesLoading.value = false
  }
}

async function toggleFavoritesPanel() {
  showFavoritesPanel.value = !showFavoritesPanel.value
  if (showFavoritesPanel.value) {
    await fetchChatFavorites()
  }
}

function toggleSearchBar() {
  showSearchBar.value = !showSearchBar.value
  if (!showSearchBar.value) {
    searchQuery.value = ''
    searchResults.value = []
  }
}

function closeSearchBar() {
  showSearchBar.value = false
  searchQuery.value = ''
  searchResults.value = []
}

function onSearchInput() {
  clearTimeout(searchDebounceTimer)
  const q = searchQuery.value.trim()
  if (q.length < 2) {
    searchResults.value = []
    return
  }
  searchDebounceTimer = setTimeout(async () => {
    searchLoading.value = true
    try {
      const res = await axios.get(
        `${API}/api/chats/${currentChat.value.id}/search?q=${encodeURIComponent(q)}`,
        { headers: { Authorization: `Bearer ${auth.token}` } }
      )
      searchResults.value = res.data.messages
    } catch (e) {
      console.error('Search error:', e)
    } finally {
      searchLoading.value = false
    }
  }, 300)
}

function jumpToMessage(msgId) {
  const el = document.getElementById(`msg-${msgId}`)
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    highlightedMsgId.value = msgId
    setTimeout(() => {
      highlightedMsgId.value = null
    }, 2000)
  }
}

function handleLogout() {
  auth.logout()
  window.location.href = '/login'
}

// ─── Socket.IO event handlers (v0.1.22–27 — REGRESSION CRITICAL, jangan ubah) ───

// v0.1.23 — JANGAN skip own outgoing: pesan dari Tangan Kanan gak lewat sendReply
function onNewMessage(data) {
  if (currentChat.value && data.chatId === currentChat.value.id) {
    // Dedup: skip if message already exists
    const exists = currentMessages.value.some(m =>
      m.id === data.message.id ||
      (data.message.waMessageId && m.waMessageId === data.message.waMessageId)
    )
    if (!exists) {
      currentMessages.value.push(data.message)
      chats.markRead(data.chatId)
      scrollToBottom()
    }
  }
  // Update chat list (only for incoming messages)
  if (data.message.direction !== 'out') {
    const chat = chats.chats.find(c => c.id === data.chatId)
    if (chat) {
      const preview = data.message.content || (data.message.mediaType ? `[${data.message.mediaType.charAt(0).toUpperCase() + data.message.mediaType.slice(1)}]` : '[Media]')
      chat.lastMessagePreview = preview
      chat.lastMessageAt = data.message.timestamp
      if (!currentChat.value || data.chatId !== currentChat.value.id) {
        chat.unreadCount = (chat.unreadCount || 0) + 1
      }
    } else {
      chats.fetchChats()
    }
  } else {
    // Outgoing: update preview but don't touch unread count
    const chat = chats.chats.find(c => c.id === data.chatId)
    if (chat) {
      const preview = data.message.content || (data.message.mediaType ? `[${data.message.mediaType.charAt(0).toUpperCase() + data.message.mediaType.slice(1)}]` : '[Media]')
      chat.lastMessagePreview = preview
      chat.lastMessageAt = data.message.timestamp
    } else {
      // v0.1.26 — chat belum ada di list (mis. baru diklaim dari Kontak) → refetch
      chats.fetchChats()
    }
  }
  // v0.2.0 — recompute unread badge homerow
  chats.unreadTotal = chats.chats.reduce((n, c) => n + (c.unreadCount || 0), 0)

  // v0.4.0 — in-app toast utk pesan masuk yang relevan bagi user ini
  // Hanya kalau chat sedang TIDAK dibuka (kalau dibuka, pesan langsung terlihat di thread).
  if (data.message.direction === 'in' && (!currentChat.value || data.chatId !== currentChat.value.id)) {
    const chat = chats.chats.find(c => c.id === data.chatId)
    // v0.12.1 — hotfix popup bocor: sumber assignment utk TOAST GATE diambil
    // dari payload socket (backend kirim assignedToId & status chat), bukan
    // dari list lokal yang role-filtered/stale (penyebab toast muncul di
    // SEMUA CS & admin). Payload lama (deploy window): fallback list lokal.
    const assignedId = 'assignedToId' in data
      ? (data.assignedToId ?? null)
      : (chat?.assignedTo?.id ?? chat?.assignedToId ?? null)
    const isMine = assignedId === auth.user.id
    // v0.13.4 — toast HANYA chat-mine (isi pesan hanya boleh tampil utk pemilik).
    // Unassigned: TANPA toast sama sekali (Kanaka locked) — badge antrean + queue
    // count cukup sebagai sinyal take; notifikasi content-free hanya lewat PWA push
    // (app tertutup). Jalur canTake/unassigned toast v0.5.0 dibuang seluruhnya.
    if (isMine) {
      const preview = data.message.content || (data.message.mediaType ? `[${data.message.mediaType.charAt(0).toUpperCase() + data.message.mediaType.slice(1)}]` : '[Media]')
      const sender = chat?.contactName || data.message.senderName || 'Pesan baru'
      toastStore.show({
        icon: '💬',
        title: sender,
        message: preview.length > 80 ? preview.slice(0, 79) + '…' : preview,
        onClick: () => {
          const target = chats.chats.find(c => c.id === data.chatId)
          if (target) selectChat(target)
          else chats.fetchChats()
        },
      })
    }
  }
}

// v0.1.22 — purge: buang chat dari list + tutup detail kalau sedang dibuka
function onChatsPurged(data) {
  const ids = data?.chatIds || []
  if (!ids.length) return
  if (currentChat.value && ids.includes(currentChat.value.id)) {
    const wasMobileDetail = isMobileDetail.value
    currentChat.value = null
    currentMessages.value = []
    if (wasMobileDetail) router.replace('/')
    toastStore.show({
      icon: '🧹',
      title: 'Chat dibersihkan',
      message: 'Pesan chat ini sudah di-purge oleh admin',
    })
  }
  chats.removeChats(ids)
}

// ═══ v3.6 — Hapus Chat individual (permanen) dari kebab menu ═══
// Confirm dialog (useConfirm, pola confirmRelease) → DELETE /api/chats/:id
// (ADMIN ONLY di backend — role cs ditolak 403). Sukses → toast + clear
// selection/navigasi; chat row hilang dari list via event 'chat_deleted'
// (handler onChatDeleted — defense-in-depth kalau user lain yang ngehapus).
async function confirmDeleteChat() {
  if (!currentChat.value) return
  const nama = currentChat.value.contactName || currentChat.value.contactPhone || 'chat ini'
  const ok = await confirmAction({
    title: 'Hapus permanen chat ini?',
    message: `Semua pesan, media, catatan, dan riwayat chat ${nama} akan dihapus PERMANEN dan tidak bisa dikembalikan.`,
    confirmText: 'Hapus Permanen',
    danger: true,
  })
  if (!ok) return
  const chatId = currentChat.value.id
  try {
    await axios.delete(`${API}/api/chats/${chatId}`)
    toastStore.show({ icon: '🗑️', title: 'Chat dihapus permanen' })
    // Clear selection + navigasi (pola onChatsPurged — close detail aktif)
    if (currentChat.value && currentChat.value.id === chatId) {
      const wasMobileDetail = isMobileDetail.value
      currentChat.value = null
      currentMessages.value = []
      if (wasMobileDetail) router.replace('/')
    }
    // List lokal update via event 'chat_deleted' dari server; fallback refetch
    chats.fetchChats(chats.filterParams)
  } catch (e) {
    console.error('Delete chat error:', e)
    toastStore.show({ icon: '⚠️', title: 'Gagal menghapus chat', message: e.response?.data?.error || e.message })
  }
}

// v3.6 — socket listener 'chat_deleted': buang chat dari list lokal TANPA full
// refetch + clear selection kalau chat yang TERBUKA = chatId itu (defense-in-depth,
// admin lain yang ngehapus). Pola onChatsPurged.
function onChatDeleted(data) {
  const chatId = data?.chatId
  if (!Number.isFinite(chatId)) return
  if (currentChat.value && currentChat.value.id === chatId) {
    const wasMobileDetail = isMobileDetail.value
    currentChat.value = null
    currentMessages.value = []
    if (wasMobileDetail) router.replace('/')
    toastStore.show({
      icon: '🗑️',
      title: 'Chat dihapus permanen',
      message: 'Chat ini dihapus oleh admin',
    })
  }
  // Hapus dari list tanpa full refetch (pola chats.removeChats)
  chats.removeChats([chatId])
}

// v0.6.0 — import history selesai di tempat lain: refetch list sekali
// (backend emit 'history_imported' sekali di akhir import, bukan per-message)
function onHistoryImported() {
  chats.fetchChats(chats.filterParams)
}

// ─── v0.5.1 — Debounced list sync saat assignedTo berubah (transfer) ──────
// Refetch list trailing 300ms supaya burst chat_update gak spam refetch.
// Menangani: A (chat keluar dari Mine), B (chat masuk Mine dgn data lengkap),
// admin di tab All (assignedTo ter-update). fetchChats sudah recompute
// unreadTotal; recompute eksplisit di sini sebagai safety net.
let assignedToRefetchTimer = null
function scheduleAssignedToListSync() {
  clearTimeout(assignedToRefetchTimer)
  assignedToRefetchTimer = setTimeout(async () => {
    await chats.fetchChats(chats.filterParams)
    chats.unreadTotal = chats.chats.reduce((n, c) => n + (c.unreadCount || 0), 0)
  }, 300)
}

function onChatUpdate(data) {
  // v0.14.6 — nama kontak manual di-sync server (PUT /api/contacts) → update
  // baris chatlist realtime (edit dari halaman Kontak / sesi user lain)
  if (data.contactName !== undefined) {
    const listChat = chats.chats.find(c => c.id === data.chatId)
    if (listChat) listChat.contactName = data.contactName
  }
  if (currentChat.value && data.chatId === currentChat.value.id) {
    if (data.unreadCount !== undefined) currentChat.value.unreadCount = data.unreadCount
    // v0.14.6 — sync nama kontak manual realtime (edit oleh user lain / sesi lain)
    if (data.contactName !== undefined) currentChat.value.contactName = data.contactName
    if (data.assignedTo !== undefined) {
      currentChat.value.assignedTo = data.assignedTo
      currentChat.value.assignedToId = data.assignedTo?.id || null
    }
    if (data.status !== undefined) currentChat.value.status = data.status
    if (data.resolvedAt !== undefined) currentChat.value.resolvedAt = data.resolvedAt
    // Real-time tag updates
    if (data.tagAdded && currentChat.value.tags) {
      const exists = currentChat.value.tags.some(ct => ct.tag.id === data.tagAdded.id)
      if (!exists) {
        currentChat.value.tags.push({ tag: data.tagAdded })
      }
    }
    if (data.tagRemoved !== undefined && currentChat.value.tags) {
      currentChat.value.tags = currentChat.value.tags.filter(ct => ct.tag.id !== data.tagRemoved)
    }

    // v0.1.21 — Real-time reaksi unbind: chat yang sedang dibuka di-unassign
    if (
      data.assignedTo !== undefined &&
      data.assignedTo === null &&
      !auth.isAdmin
    ) {
      const chatName = currentChat.value.contactName || currentChat.value.contactPhone
      const wasMobileDetail = isMobileDetail.value
      currentChat.value = null
      currentMessages.value = []
      if (wasMobileDetail) router.replace('/')
      toastStore.show({
        icon: '📨',
        title: 'Chat masuk antrean',
        message: `Chat ${chatName} masuk antrean (binding dilepas)`,
      })
      chats.fetchChats(chats.filterParams)
    }

    // v0.1.21 — Real-time reaksi resolved: chat yang dibuka jadi resolved
    if (data.status === 'resolved' && currentChat.value) {
      const chatName = currentChat.value.contactName || currentChat.value.contactPhone
      const wasMine = currentChat.value.assignedToId === auth.user.id
      if (!auth.isAdmin) {
        // Keluar dari Mine → pindah ke tab Resolved + tutup detail
        if (wasMine) {
          const wasMobileDetail = isMobileDetail.value
          currentChat.value = null
          currentMessages.value = []
          if (wasMobileDetail) router.replace('/')
          changeFilter('resolved')
        }
        toastStore.show({
          icon: '✓',
          title: 'Chat resolved',
          message: `Chat ${chatName} resolved`,
        })
      } else {
        toastStore.show({
          icon: '✓',
          title: 'Chat resolved',
          message: `Chat ${chatName} resolved`,
        })
        chats.fetchChats(chats.filterParams)
      }
    }
  }
  // v0.1.27 — realtime resolve: kalau chat belum ada di snapshot list (admin nunggu
  // di tab Resolved) ATAU filter aktif mengecualikan resolved (mine/unassigned),
  // refetch supaya perubahan langsung kelihatan tanpa pindah tab
  if (data.status === 'resolved') {
    const inList = chats.chats.some(c => c.id === data.chatId)
    if (!inList || filter.value === 'mine' || filter.value === 'unassigned') {
      chats.fetchChats(chats.filterParams)
    }
  }

  // v0.5.1 — Realtime chatlist saat assignedTo berubah (transfer antar-agent):
  // refetch list debounced supaya chat pindah Mine A → Mine B / assignedTo
  // ter-update di All TANPA harus pindah tab. Perilaku existing di atas
  // (currentChat update, unbind realtime, resolved handling) tidak diubah.
  if (data.assignedTo !== undefined) {
    scheduleAssignedToListSync()
  }

  // v0.5.1 — Toast penerima transfer (semua role: cs/relay/admin): chat
  // ditransfer ke SAYA, ada info pengirim, dan sedang TIDAK dibuka.
  if (
    data.assignedTo?.id === auth.user.id &&
    data.transferredFrom &&
    (!currentChat.value || data.chatId !== currentChat.value.id)
  ) {
    toastStore.show({
      icon: '📤',
      title: 'Chat ditransfer ke kamu',
      message: `dari @${data.transferredFrom}`,
      onClick: () => {
        const target = chats.chats.find(c => c.id === data.chatId)
        if (target) selectChat(target)
        else chats.fetchChats(chats.filterParams)
      },
    })
  }

  chats.updateChat(data)

  // v0.10.0 — Fitur A: snooze realtime (chat_update bawa snoozedUntil)
  if (data.snoozedUntil !== undefined) {
    if (currentChat.value && data.chatId === currentChat.value.id) {
      currentChat.value.snoozedUntil = data.snoozedUntil
      currentChat.value.snoozedBy = data.snoozedBy ?? null
    }
    if (data.snoozeReturned) {
      toastStore.show({
        icon: '😴',
        title: 'Kembali dari snooze',
        message: `Chat ${data.snoozeContactName || ''} kembali dari snooze`,
        onClick: () => {
          const target = chats.chats.find(c => c.id === data.chatId)
          if (target) selectChat(target)
          else chats.fetchChats(chats.filter === 'snoozed' ? { snoozed: '1' } : chats.filterParams)
        },
      })
    }
    chats.fetchChats(chats.filter === 'snoozed' ? { snoozed: '1' } : chats.filterParams)
    fetchSnoozedCount()
  }
}

// ─── v0.10.0 — Empat Fitur socket handlers ──────────────────────
function onNoteAdded(data) {
  if (!currentChat.value || data.chatId !== currentChat.value.id) return
  if (!chatNotes.value.some(n => n.id === data.note.id)) {
    chatNotes.value.push(data.note)
  }
}
function onNoteDeleted(data) {
  if (!currentChat.value || data.chatId !== currentChat.value.id) return
  chatNotes.value = chatNotes.value.filter(n => n.id !== data.noteId)
}
// scheduled_sent: pesan sudah masuk lewat new_message; ini cuma toast ke creator
function onScheduledSent(data) {
  if (data.createdById !== auth.user.id) return
  toastStore.show({
    icon: '⏰',
    title: 'Pesan terjadwal terkirim',
    message: `ke ${data.contactName}`,
    onClick: () => {
      const target = chats.chats.find(c => c.id === data.chatId)
      if (target) selectChat(target)
    },
  })
}
function onScheduledError(data) {
  if (data.createdById !== auth.user.id) return
  toastStore.show({ icon: '⚠️', title: 'Pesan terjadwal GAGAL terkirim', message: data.error || 'Coba kirim manual' })
}

// v0.1.21 — Queue count realtime
function onQueueUpdate(data) {
  if (data && typeof data.count === 'number') {
    queueCount.value = data.count
    chats.queueCount = data.count
  }
}

function onTypingEvent(data) {
  if (currentChat.value && data.chatId === currentChat.value.id && data.userId !== auth.user.id) {
    typingUser.value = data.username
  }
}

function onStopTyping(data) {
  if (currentChat.value && data.chatId === currentChat.value.id) {
    typingUser.value = null
  }
}

function onWaStatus(data) {
  waStatus.value = data
}

function onMessageStatus(data) {
  if (currentChat.value && data.chatId === currentChat.value.id) {
    const msg = currentMessages.value.find(m => m.id === data.messageId)
    if (msg) msg.status = data.status
  }
}

function onTagCreated(data) {
  if (data.tag && !allTags.value.find(t => t.id === data.tag.id)) {
    allTags.value.push(data.tag)
  }
}

function onTagDeleted(data) {
  allTags.value = allTags.value.filter(t => t.id !== data.tagId)
  if (currentChat.value?.tags) {
    currentChat.value.tags = currentChat.value.tags.filter(ct => ct.tag.id !== data.tagId)
  }
  chats.chats.forEach(c => {
    if (c.tags) c.tags = c.tags.filter(ct => ct.tag.id !== data.tagId)
  })
}

// Global keyboard shortcuts (Ctrl+F, Escape)
function onGlobalKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'f' && currentChat.value) {
    e.preventDefault()
    if (!showSearchBar.value) {
      toggleSearchBar()
    }
  }
  if (e.key === 'Escape' && showSearchBar.value) {
    closeSearchBar()
  }
}

// Close dropdown menus when clicking outside
function onClickOutside(e) {
  if (showTemplateFlyout.value) {
    showTemplateFlyout.value = false
    templateMatches.value = []
  }
}

// ─── v0.12.8 — Resume sync: refetch state stale setelah app balik dari freeze ────
// PWA dibekukan Android di background → socket putus → event realtime (chat_update/
// new_message) hilang → preview/unread di chat list mentok di state sebelum freeze.
// Fix: refetch saat (1) socket connect/reconnect, (2) app visible lagi,
// (3) window focus. Debounce 2 dtk — visibilitychange+focus+connect bisa bareng.
let lastResumeRefetchAt = 0
let resumeRefetchTimer = null
function onAppResumeSync() {
  const now = Date.now()
  if (now - lastResumeRefetchAt < 2000) return
  lastResumeRefetchAt = now
  clearTimeout(resumeRefetchTimer)
  resumeRefetchTimer = setTimeout(() => {
    if (chats.loadingChats) return // fetch sudah jalan, skip
    chats.fetchChats(chats.filter === 'snoozed' ? { snoozed: '1' } : chats.filterParams)
    chats.fetchQueueCount().then(() => { queueCount.value = chats.queueCount })
    // v0.13.0 — chip menu limbo ikut di-refresh saat resume (fallback realtime)
    if (auth.isAdmin) fetchMenuWaiting()
    fetchSnoozedCount()
    // Thread yang lagi dibuka ikut disinkronkan (pes baru saat app freeze)
    if (currentChat.value) {
      const chatId = currentChat.value.id
      chats.fetchChat(chatId).then(() => {
        if (chats.currentChat?.id === chatId && currentChat.value?.id === chatId) {
          currentChat.value = chats.currentChat
          if (chats.currentMessages.length !== currentMessages.value.length) {
            currentMessages.value = chats.currentMessages
            nextTick(scrollToBottom)
          }
        }
      })
    }
  }, 250)
}
function onVisibilityChange() {
  if (document.visibilityState === 'visible') onAppResumeSync()
}

onMounted(async () => {
  window.addEventListener('resize', onWindowResize)

  // v0.5.0 — presence store: subscribe presence_update + sinkron awal
  presenceStore.subscribe()
  presenceStore.fetchInitial()

  // v0.10.0 — Fitur A: hitung chat snoozed aktif (chip 😴 Snoozed tampil hanya jika > 0)
  fetchSnoozedCount()

  // v0.1.21 — default filter per role (safety net; store default 'mine')
  if (!auth.isAdmin && (filter.value === 'all' || filter.value === 'unassigned')) {
    filter.value = 'mine'
    chats.filter = 'mine'
  }
  await chats.fetchChats()

  // v0.1.21 — initial queue count fetch
  chats.fetchQueueCount().then(() => {
    queueCount.value = chats.queueCount
  })

  // v0.13.0 — chip "⏳ Menunggu menu" (admin): initial fetch + realtime listener
  if (auth.isAdmin) fetchMenuWaiting()

  // Auto-select from ?chat= query param if present (v0.1.24)
  maybeAutoSelectFromQuery()

  // Mobile direct link /chat/:id
  if (isMobile.value && routeChatId.value) {
    await selectChatFromRoute(routeChatId.value)
  }

  // Fetch all tags (untuk chat detail; pane punya salinan sendiri)
  try {
    const res = await axios.get(`${API}/api/tags`)
    allTags.value = res.data.tags
  } catch (e) { console.error('Fetch tags error:', e) }

  await fetchTemplates()

  // Fetch current WA status immediately
  try {
    const res = await axios.get(`${API}/api/wa/status`)
    waStatus.value = res.data
  } catch (e) { console.error('Failed to fetch WA status:', e) }

  // Set up Socket.IO listeners (identik v0.1.x)
  socketStore.on('new_message', onNewMessage)
  socketStore.on('chat_update', onChatUpdate)
  socketStore.on('chats_purged', onChatsPurged) // v0.1.22
  socketStore.on('chat_deleted', onChatDeleted) // v3.6 — hapus chat individual
  socketStore.on('history_imported', onHistoryImported) // v0.6.0
  socketStore.on('queue_update', onQueueUpdate) // v0.1.21
  socketStore.on('typing', onTypingEvent)
  socketStore.on('stop_typing', onStopTyping)
  socketStore.on('wa_status', onWaStatus)
  socketStore.on('message_status', onMessageStatus)
  socketStore.on('tag_created', onTagCreated)
  socketStore.on('tag_deleted', onTagDeleted)
  socketStore.on('template_update', onTemplateUpdate)
  // v0.10.0 — Empat Fitur listeners
  socketStore.on('note_added', onNoteAdded)
  socketStore.on('note_deleted', onNoteDeleted)
  socketStore.on('chat_update', onChatUpdate) // snooze flags dibawa chat_update (handler sama)
  socketStore.on('scheduled_sent', onScheduledSent)
  socketStore.on('scheduled_error', onScheduledError)
  socketStore.on('menu_waiting_update', onMenuWaitingUpdate) // v0.13.0 — chip admin

  // v0.12.8 — resume sync listeners (socket reconnect + app visible + focus)
  socketStore.onReconnect(onAppResumeSync)
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('focus', onAppResumeSync)

  document.addEventListener('click', onClickOutside)
  document.addEventListener('keydown', onGlobalKeydown)
})

onUnmounted(() => {
  window.removeEventListener('resize', onWindowResize)
  // v0.5.1 — clear pending debounced list sync
  clearTimeout(assignedToRefetchTimer)
  socketStore.off('new_message', onNewMessage)
  socketStore.off('chat_update', onChatUpdate)
  socketStore.off('chats_purged', onChatsPurged)
  socketStore.off('chat_deleted', onChatDeleted) // v3.6 — hapus chat individual
  socketStore.off('history_imported', onHistoryImported) // v0.6.0 // v0.1.22
  socketStore.off('queue_update', onQueueUpdate) // v0.1.21
  socketStore.off('typing', onTypingEvent)
  socketStore.off('stop_typing', onStopTyping)
  socketStore.off('wa_status', onWaStatus)
  socketStore.off('message_status', onMessageStatus)
  socketStore.off('tag_created', onTagCreated)
  socketStore.off('tag_deleted', onTagDeleted)
  socketStore.off('template_update', onTemplateUpdate)
  // v0.10.0 — Empat Fitur listeners off
  socketStore.off('note_added', onNoteAdded)
  socketStore.off('note_deleted', onNoteDeleted)
  socketStore.off('scheduled_sent', onScheduledSent)
  socketStore.off('scheduled_error', onScheduledError)
  socketStore.off('menu_waiting_update', onMenuWaitingUpdate) // v0.13.0

  // Mobile: kalau masih di route detail saat unmount, leave chat
  if (currentChat.value) {
    socketStore.leaveChat(currentChat.value.id)
  }

  document.removeEventListener('click', onClickOutside)
  document.removeEventListener('keydown', onGlobalKeydown)

  // v0.12.8 — resume sync cleanup
  socketStore.onReconnect(null)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  window.removeEventListener('focus', onAppResumeSync)
  clearTimeout(resumeRefetchTimer)
})
</script>