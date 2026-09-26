<template>
  <!--
    v4.1.0 — Channels (WA Channel archive, read-only): PANEL LIST + detail postingan.
    Dipakai Channels.vue (desktop) + Contacts.vue tab "Channel" (mobile) — pola
    GroupListPanel v0.14.0. READ-ONLY TOTAL (spec D3): TANPA kirim/edit/hapus,
    TANPA v-html (teks postingan render via interpolation murni).
    Media = badge (D6 — metadata saja dari API); fromMe = badge "dari kamu".
    Pagination cursor simple: tombol "Muat lebih lama" (before=<id terakhir>).
  -->
  <div class="space-y-4">
    <!-- Detail postingan (klik channel dari list) -->
    <div v-if="activeChannel" class="space-y-3">
      <div class="bg-white rounded-lg shadow-sm p-4 flex items-center gap-3">
        <button @click="closeDetail" class="text-sm text-gray-600 hover:text-gray-800 flex-shrink-0">← Daftar Channel</button>
        <div class="min-w-0 flex-1 text-center">
          <div class="font-semibold truncate">{{ activeChannel.name }}</div>
          <div class="text-xs text-gray-400 truncate">{{ activeChannel.waJid }} · read-only</div>
        </div>
        <span class="flex-1"></span>
      </div>

      <div v-if="loadingPosts" class="bg-white rounded-lg shadow-sm p-8 text-center text-gray-400 text-sm">Memuat postingan…</div>
      <div v-else-if="posts.length === 0" class="bg-white rounded-lg shadow-sm p-8 text-center">
        <div class="text-3xl mb-2">📢</div>
        <p class="text-sm text-gray-500">Belum ada postingan terarsip.</p>
        <p class="text-xs text-gray-400 mt-1">Postingan baru dari WhatsApp otomatis terarsip (read-only).</p>
      </div>
      <div v-else class="space-y-2">
        <div v-for="p in posts" :key="p.id" class="bg-white rounded-lg shadow-sm p-3">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0 flex-1">
              <!-- TANPA v-html — teks murni -->
              <p class="text-sm whitespace-pre-wrap break-words">{{ p.content || (p.mediaType ? '📁 ' + labelMedia(p) : '(tanpa teks)') }}</p>
            </div>
            <div class="flex flex-col items-end gap-1 flex-shrink-0">
              <span v-if="p.mediaType" class="text-[10px] px-2 py-0.5 rounded-full font-medium bg-purple-100 text-purple-700">
                {{ mediaBadge(p) }}
              </span>
              <span v-if="p.fromMe" class="text-[10px] px-2 py-0.5 rounded-full font-medium bg-blue-100 text-blue-700">dari kamu</span>
            </div>
          </div>
          <div class="text-[11px] text-gray-400 mt-1">{{ formatDateTime(p.msgTimestamp || p.createdAt) }}</div>
        </div>
        <div v-if="hasMore" class="text-center">
          <button @click="loadMore" :disabled="loadingMore" class="px-4 py-2 text-sm rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:opacity-50">
            {{ loadingMore ? 'Memuat…' : 'Muat lebih lama' }}
          </button>
        </div>
      </div>
    </div>

    <!-- List channel -->
    <div v-else class="space-y-2">
      <div class="bg-white rounded-lg shadow-sm p-4">
        <div class="flex items-center justify-between gap-3">
          <p class="text-sm text-gray-600">Channel WhatsApp yang terarsip (read-only)</p>
        </div>
        <input
          v-model="searchQuery"
          type="search"
          placeholder="Cari nama channel / JID…"
          class="mt-3 w-full px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-wa-green"
        />
      </div>

      <div v-if="loading" class="bg-white rounded-lg shadow-sm p-8 text-center text-gray-400 text-sm">Memuat channel…</div>
      <div v-else-if="filteredChannels.length === 0" class="bg-white rounded-lg shadow-sm p-8 text-center">
        <div class="text-3xl mb-2">📢</div>
        <p v-if="channels.length === 0" class="text-sm text-gray-500">Belum ada channel terarsip.</p>
        <p v-else class="text-sm text-gray-500">Tidak ada channel yang cocok dengan pencarian.</p>
        <p v-if="channels.length === 0" class="text-xs text-gray-400 mt-1">
          Postingan pertama dari channel yang diterima nomor WhatsApp otomatis terarsip di sini.
        </p>
      </div>
      <div v-else class="space-y-2">
        <button
          v-for="c in filteredChannels"
          :key="c.id"
          class="w-full bg-white rounded-lg shadow-sm p-4 flex items-center gap-3 text-left hover:bg-gray-50 transition-colors"
          @click="openDetail(c)"
        >
          <div class="w-11 h-11 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center text-lg flex-shrink-0">📢</div>
          <div class="min-w-0 flex-1">
            <div class="font-medium truncate">{{ c.name }}</div>
            <div class="text-xs text-gray-500 truncate">{{ c.waJid }}</div>
            <div class="text-xs text-gray-400">
              <span v-if="c.postCount">📝 {{ c.postCount }} postingan · </span>
              <span>{{ c.lastPostAt ? 'terakhir ' + formatDateTime(c.lastPostAt) : 'belum ada postingan' }}</span>
            </div>
          </div>
        </button>
      </div>
    </div>

    <div v-if="error" class="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{{ error }}</div>
  </div>
</template>

<script setup>
// v4.1.0 — Channels: panel read-only (list + detail postingan) — spec §5.
// Pola GroupListPanel: panel dipakai desktop (Channels.vue) & mobile (Contacts.vue
// tab "Channel"). TANPA aksi tulis; TANPA v-html; media hanya badge (D6).
import { ref, computed, onMounted, onUnmounted } from 'vue'
import axios from 'axios'
import { useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'

const auth = useAuthStore()
const toast = useToastStore()

const channels = ref([])
const loading = ref(false)
const error = ref(null)
const searchQuery = ref('')

const activeChannel = ref(null)
const posts = ref([])
const hasMore = ref(false)
const nextBefore = ref(null)
const loadingPosts = ref(false)
const loadingMore = ref(false)

const filteredChannels = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return channels.value
  return channels.value.filter((c) =>
    String(c.name || '').toLowerCase().includes(q) || String(c.waJid || '').toLowerCase().includes(q)
  )
})

function client() {
  return axios.create({ baseURL: '', headers: { Authorization: `Bearer ${auth.token}` } })
}

function formatDateTime(value) {
  if (!value) return ''
  return new Date(value).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function labelMedia(p) {
  if (p.mediaType === 'image') return 'Foto'
  if (p.mediaType === 'video') return 'Video'
  if (p.mediaType === 'document') return 'Dokumen'
  return 'Media'
}

function mediaBadge(p) {
  if (p.mediaPath) return labelMedia(p)
  return labelMedia(p) + ' (meta saja)'
}

async function doFetchChannels() {
  loading.value = true
  error.value = null
  try {
    const res = await client().get('/api/channels')
    channels.value = res.data.channels || []
  } catch (e) {
    console.error('Fetch channels error:', e)
    const msg = e?.response?.status === 403 ? 'Channel hanya untuk admin.' : 'Gagal memuat daftar channel.'
    error.value = msg
    toast.show({ icon: '⚠️', title: 'Gagal memuat channel', message: msg })
  } finally {
    loading.value = false
  }
}

async function fetchPosts(reset = true) {
  if (!activeChannel.value) return
  if (reset) loadingPosts.value = true
  else loadingMore.value = true
  try {
    const id = activeChannel.value.id
    const params = { limit: 50 }
    if (!reset && nextBefore.value) params.before = nextBefore.value
    const res = await client().get(`/api/channels/${id}/posts`, { params })
    if (activeChannel.value?.id !== id) return // user pindah channel — buang hasil lama
    posts.value = reset ? res.data.posts || [] : posts.value.concat(res.data.posts || [])
    hasMore.value = !!res.data.hasMore
    nextBefore.value = res.data.nextBefore ?? null
  } catch (e) {
    console.error('Fetch posts error:', e)
    toast.show({ icon: '⚠️', title: 'Gagal memuat postingan', message: e?.response?.status === 404 ? 'Channel tidak ditemukan.' : 'Gagal memuat postingan channel.' })
  } finally {
    loadingPosts.value = false
    loadingMore.value = false
  }
}

function openDetail(c) {
  activeChannel.value = c
  posts.value = []
  hasMore.value = false
  nextBefore.value = null
  fetchPosts(true)
}

function closeDetail() {
  activeChannel.value = null
  posts.value = []
  hasMore.value = false
  nextBefore.value = null
}

function loadMore() {
  fetchPosts(false)
}

onMounted(doFetchChannels)
onUnmounted(() => {})

defineExpose({ refresh: doFetchChannels })
</script>