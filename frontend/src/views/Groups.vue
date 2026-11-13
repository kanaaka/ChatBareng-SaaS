<template>
  <!--
    v0.14.0 — Manajemen Grup (PIC Model) — spec §6 UI.
    Desktop: split — list grup kiri, detail grup kanan (ChatDetail existing + panel
    member/settings GroupManagePanel). Mobile: list → detail full-screen.
    Detail grup membuka ChatDetail EXISTING via /?chat=<gid> pola Kontak (handler
    reply/socket/media tetap satu sumber di Dashboard).
    Deep-link: /groups?chat=<gid> buka detail; ?assign=<gid> buka dialog PIC.
  -->
  <PageShell title="Grup">
    <!-- Desktop header (konsisten Contacts.vue) -->
    <header class="hidden md:flex m3-topbar px-4 py-3 items-center justify-between">
      <div class="flex items-center gap-3">
        <router-link to="/" class="text-sm hover:underline m3-topbar__link">← Dashboard</router-link>
        <h1 class="text-lg font-semibold">Grup</h1>
      </div>
      <div class="flex items-center gap-4">
        <router-link v-if="auth.isAdmin" to="/admin" class="text-sm hover:underline m3-topbar__link">Admin Panel</router-link>
        <router-link to="/settings" class="text-sm hover:underline m3-topbar__link">{{ auth.user?.username }}</router-link>
        <button @click="handleLogout" class="text-sm hover:underline">Logout</button>
      </div>
    </header>

    <div class="flex-1 flex overflow-hidden">
      <!-- ═══ DESKTOP: split list + detail ═══
           v0.14.2 — max-height lock: composer harus stay di bawah (lapor Kanaka 09:41).
           Sebelumnya layout tinggi-dokumen (PageShell min-h-screen) → chat rame bikin
           halaman memanjang, composer kebawa scroll. Lock ke viewport (topbar 68px
           + border 1px) → chat scroll di dalam, composer nempel bawah. -->
      <div class="hidden md:flex flex-1 overflow-hidden relative" style="max-height: calc(100dvh - 69px); min-height: 0;">
        <!-- List pane -->
        <div class="w-96 flex-shrink-0 border-r border-gray-200 overflow-y-auto p-4">
          <GroupListPanel ref="listPanelRef" @open="openGroup" />
        </div>

        <!-- Detail pane -->
        <div class="flex-1 overflow-hidden flex flex-col">
          <!-- Empty state -->
          <div v-if="loadingChat" class="flex-1 flex items-center justify-center text-gray-400">
            <div class="text-center">
              <div class="text-4xl mb-3">⏳</div>
              <p class="text-sm">Memuat grup…</p>
            </div>
          </div>

          <div v-else-if="!activeChat" class="flex-1 flex items-center justify-center text-gray-400">
            <div class="text-center">
              <div class="text-5xl mb-3">👥</div>
              <p class="text-sm">Pilih grup untuk membuka chat & panel kelola</p>
              <p class="text-xs mt-1">PIC bisa membaca & membalas; admin bisa melihat semua grup</p>
            </div>
          </div>

          <!-- Detail: ChatDetail existing + panel member/settings -->
          <div v-else-if="activeChat" class="flex-1 overflow-hidden flex flex-col">
            <!-- 503 banner — WA belum terhubung (spec: banner, bukan error mentah) -->
            <div v-if="waError" class="bg-red-50 border-b border-red-200 px-4 py-2 text-sm text-red-700 flex-shrink-0">
              ⚠️ {{ waError }}
            </div>
            <div class="flex-1 overflow-hidden min-h-0">
              <ChatDetail
                ref="chatDetailRef"
                :chat="activeChat"
                :messages="activeMessages"
                :loading-messages="false"
                :favorited-msg-ids="emptySet"
                :all-tags="[]"
                :all-templates="[]"
                :transfer-users="[]"
                :panels-open="false"
                :reply-text="replyText"
                :sending="sendingReply"
                @update:replyText="replyText = $event"
                @send="sendGroupReply"
                @upload-media="onUploadMedia"
                @reply-keydown="onGroupReplyKeydown"
                @tangan-kanan="tkOpen = !tkOpen"
                @open-contact-edit="openManage"
              />
            </div>

            <!-- Panel kelola grup (desktop: strip bawah chat; toggle) -->
            <div class="border-t border-gray-200 bg-white flex-shrink-0">
              <button
                @click="manageOpen = !manageOpen"
                class="w-full px-4 py-2.5 flex items-center justify-between text-left"
              >
                <span class="text-sm font-semibold flex items-center gap-2">⚙️ Kelola Grup</span>
                <span class="text-gray-400 text-sm">{{ manageOpen ? '▼' : '▲' }}</span>
              </button>
              <div v-if="manageOpen" class="border-t border-gray-100 max-h-[55vh] overflow-y-auto p-4">
                <GroupManagePanel :chat-id="activeGroupId" :chat="activeChat" @changed="onGroupChanged" />
              </div>
            </div>
          </div>
        </div>

        <!-- v0.14.2 — Tangan Kanan di halaman Grup (desktop: rail + panel, pola Dashboard).
             Mobile: detail grup = Dashboard fullscreen → TK sheet existing dipakai. -->
        <button
          v-if="activeChat && !tkOpen"
          @click="tkOpen = true"
          class="hidden md:flex absolute top-1/2 -translate-y-1/2 right-0 z-10 bg-white border border-gray-200 border-r-0 rounded-l-lg w-7 h-14 items-center justify-center text-gray-400 hover:text-wa-green hover:bg-gray-50 shadow-sm"
          title="Open Tangan Kanan"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" /></svg>
        </button>
        <div v-if="tkOpen && activeChat" class="hidden md:block flex-shrink-0 h-full">
          <TanganKanan :current-chat="activeChat" @close="tkOpen = false" />
        </div>
      </div>

      <!-- ═══ MOBILE: list (detail full via route /chat/:id pola Dashboard) ═══ -->
      <div class="md:hidden w-full p-4">
        <GroupListPanel :auto-assign-chat-id="autoAssignChatId" @open="openGroupMobile" />
      </div>
    </div>

    <!-- Mobile manage sheet -->
    <Teleport to="body">
      <Transition name="fade">
        <div v-if="mobileManageOpen" class="fixed inset-0 bg-black/40 z-50 md:hidden" @click="mobileManageOpen = false"></div>
      </Transition>
      <Transition name="sheet">
        <div
          v-if="mobileManageOpen"
          class="fixed left-0 right-0 bottom-0 z-50 bg-white rounded-t-2xl shadow-2xl md:hidden flex flex-col"
          style="height: 88vh; padding-top: env(safe-area-inset-top, 0px);"
        >
          <div class="pt-2 pb-1 flex justify-center flex-shrink-0">
            <div class="w-10 h-1 rounded-full bg-gray-300"></div>
          </div>
          <div class="px-4 pb-2 flex items-center justify-between border-b border-gray-100 flex-shrink-0">
            <span class="font-semibold text-sm text-gray-800">⚙️ Kelola Grup</span>
            <button @click="mobileManageOpen = false" class="p-1.5 rounded-full hover:bg-gray-100 text-gray-500">✕</button>
          </div>
          <div class="flex-1 overflow-y-auto p-4">
            <GroupManagePanel v-if="activeGroupId" :chat-id="activeGroupId" :chat="activeChat" @changed="onGroupChanged" />
          </div>
        </div>
      </Transition>
    </Teleport>
  </PageShell>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import axios from 'axios'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'
import { useSocketStore } from '../stores/socket'
import { useConfirm } from '../utils/confirm'
import { groupsClient, friendlyGroupError } from '../utils/groupsApi'
import PageShell from '../components/PageShell.vue'
import GroupListPanel from './GroupListPanel.vue'
import GroupManagePanel from './GroupManagePanel.vue'
import ChatDetail from './ChatDetail.vue'
import TanganKanan from '../components/TanganKanan.vue'

const API = import.meta.env.VITE_API_URL || ''
const auth = useAuthStore()
const toast = useToastStore()
const socketStore = useSocketStore()
const route = useRoute()
const router = useRouter()
const { confirmAction } = useConfirm()

const activeGroupId = ref(null)
const activeChat = ref(null)
const activeMessages = ref([])
const loadingChat = ref(false)
const replyText = ref('')
const sendingReply = ref(false)
const waError = ref(null)
const manageOpen = ref(false)
const mobileManageOpen = ref(false)
// v0.14.2 — Tangan Kanan di halaman Grup (desktop rail; lapor Kanaka 09:41)
const tkOpen = ref(false)
const listPanelRef = ref(null)
const chatDetailRef = ref(null)
const autoAssignChatId = ref(null)
// v0.14.0 — favoritedMsgIds wajib ada utk ChatDetail (Set immutable kosong;
// favorit fitur 1:1 — tidak dipakai grup)
const emptySet = new Set()

function handleLogout() {
  auth.logout()
  window.location.href = '/login'
}

// ─── Buka grup (desktop: inline; mobile: route detail penuh) ──────────
function isMobileViewport() {
  return window.innerWidth < 768
}

function openGroup(g) {
  waError.value = null
  activeGroupId.value = g.id
  if (isMobileViewport()) {
    // Mobile: chat thread full-screen memakai Dashboard existing (pola Kontak
    // openChat → /?chat=) + tetap simpan context manage utk kembali.
    router.push({ path: '/', query: { chat: g.id } })
    return
  }
  fetchGroupChat(g.id)
}

function openGroupMobile(g) {
  openGroup(g)
}

// ─── Fetch chat detail grup (GET /api/chats/:id — guard existing) ─────
async function fetchGroupChat(chatId) {
  loadingChat.value = true
  waError.value = null
  try {
    const res = await axios.get(`${API}/api/chats/${encodeURIComponent(chatId)}`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    activeChat.value = res.data.chat
    activeMessages.value = res.data.messages || []
    try { socketStore.joinChat(chatId) } catch (e) { /* non-fatal */ }
    // v0.14.2 — buka grup = baca: clear badge "N baru" di list (fire-and-forget;
    // server broadcast chat_update unreadCount:0 → GroupListPanel update realtime).
    try { axios.post(`${API}/api/chats/${encodeURIComponent(chatId)}/read`, {}, { headers: { Authorization: `Bearer ${auth.token}` } }) } catch (e) { /* non-fatal */ }
    // D2 — Auto-focus reply box on desktop when opening group chat
    if (!isMobileViewport()) {
      nextTick(() => chatDetailRef.value?.focusReply())
    }
  } catch (e) {
    console.error('Fetch group chat error:', e)
    // 503 dkk → banner ramah; 403 → toast + kembali ke list
    const msg = friendlyGroupError(e, 'Gagal membuka grup.')
    if (e?.response?.status === 503) {
      waError.value = 'WhatsApp belum terhubung — isi chat grup belum bisa dimuat. Hubungkan WhatsApp dulu di Admin → WhatsApp.'
    } else {
      toast.show({ icon: '⚠️', title: 'Gagal membuka grup', message: msg })
      activeGroupId.value = null
      activeChat.value = null
    }
  } finally {
    loadingChat.value = false
  }
}

// ─── Balas di grup (jalur reply existing — 1:1 flow TIDAK disentuh) ───
// v0.14.0b — guard sending + Enter kirim. Hotfix: tombol send tadinya disabled
// permanen karena prop replyText/sending tidak diteruskan ke ChatDetail.
async function sendGroupReply() {
  if (!replyText.value.trim() || !activeChat.value || sendingReply.value) return
  const content = replyText.value.trim()
  sendingReply.value = true
  try {
    const res = await axios.post(
      `${API}/api/chats/${encodeURIComponent(activeChat.value.id)}/reply`,
      { content },
      { headers: { Authorization: `Bearer ${auth.token}` } },
    )
    const msg = res.data.message
    const exists = activeMessages.value.some(m => m.id === msg.id)
    if (!exists) activeMessages.value.push(msg)
    replyText.value = ''
  } catch (e) {
    console.error('Group reply error:', e)
    toast.show({ icon: '⚠️', title: 'Gagal mengirim', message: friendlyGroupError(e, 'Gagal mengirim pesan.') })
  } finally {
    sendingReply.value = false
  }
}

// v0.14.0b — Enter kirim (pola Dashboard); input single-line, shift+enter aman
function onGroupReplyKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendGroupReply()
  }
}

// D4 — Media: ChatDetail emit upload-media (payload { file, caption, target }) — preview modal di ChatDetail
function onUploadMedia(payload) {
  const file = payload?.file || payload?.target?.files?.[0]
  if (!file || !activeChat.value) return
  const caption = payload?.caption !== undefined ? payload.caption : replyText.value.trim()
  const form = new FormData()
  form.append('file', file)
  if (caption) {
    form.append('caption', caption)
  }
  axios.post(`${API}/api/chats/${encodeURIComponent(activeChat.value.id)}/media`, form, {
    headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'multipart/form-data' },
  })
    .then((res) => {
      const msg = res.data.message
      const exists = activeMessages.value.some(m => m.id === msg.id)
      if (!exists) activeMessages.value.push(msg)
      replyText.value = ''
      toast.show({ icon: '📎', title: 'Media terkirim' })
    })
    .catch((e) => {
      console.error('Group media error:', e)
      toast.show({ icon: '⚠️', title: 'Gagal mengirim media', message: friendlyGroupError(e, 'Gagal mengirim media.') })
    })
    .finally(() => {
      if (payload?.target) payload.target.value = ''
    })
}

function openManage() {
  if (isMobileViewport()) mobileManageOpen.value = true
  else manageOpen.value = true
}

function onGroupChanged() {
  // group_update socket sudah refetch list; refetch header chat juga
  if (activeGroupId.value) fetchGroupChat(activeGroupId.value)
}

// ─── Socket realtime (room per-user PIC+admin — handler.js v0.14) ─────
function onNewMessage(data) {
  if (data?.chatId !== activeGroupId.value || !data?.message) return
  const exists = activeMessages.value.some(m => m.id === data.message.id)
  if (!exists) activeMessages.value.push(data.message)
  if (!data.message.direction || data.message.direction === 'in') {
    try { axios.post(`${API}/api/chats/${encodeURIComponent(activeGroupId.value)}/read`, {}, { headers: { Authorization: `Bearer ${auth.token}` } }) } catch (e) { /* non-fatal */ }
  }
}

function onChatUpdate(data) {
  if (data?.chatId !== activeGroupId.value) return
  if (activeChat.value) {
    if (data.status !== undefined) activeChat.value.status = data.status
    if (data.unreadCount !== undefined) activeChat.value.unreadCount = data.unreadCount
    if (data.lastMessage !== undefined) activeChat.value.lastMessagePreview = data.lastMessage
  }
}

// ─── Deep-link ─────────────────────────────────────────────────────────
async function applyQuery() {
  const chatId = route.query.chat
  const assignId = route.query.assign
  if (assignId) autoAssignChatId.value = String(assignId)
  if (chatId) {
    const gid = String(chatId)
    activeGroupId.value = gid
    if (isMobileViewport()) {
      router.replace({ query: {} })
      router.push({ path: '/', query: { chat: gid } })
    } else {
      router.replace({ query: {} })
      await fetchGroupChat(gid)
    }
  }
}

watch(() => route.query, () => applyQuery(), { immediate: false })

onMounted(() => {
  applyQuery()
  socketStore.on('new_message', onNewMessage)
  socketStore.on('chat_update', onChatUpdate)
})
onUnmounted(() => {
  socketStore.off('new_message', onNewMessage)
  socketStore.off('chat_update', onChatUpdate)
  if (activeGroupId.value) {
    try { socketStore.leaveChat(activeGroupId.value) } catch (e) { /* non-fatal */ }
  }
})
</script>