<template>
  <div :class="mobileFull ? 'h-full flex flex-col bg-white w-full' : 'h-full flex flex-col bg-white border-l border-gray-200 w-80 flex-shrink-0'">
    <!-- Header (v0.2.5 — hidden di mobile-full: sheet wrapper sudah punya judul + ✕, fix judul dobel)
         v0.13.6 r7: min-height 56px — segaris dgn header chat (ChatDetail min-height:56px);
         border-bottom kedua panel berdampingan jadi satu garis lurus (lapor Kanaka 11:59) -->
    <div v-if="!mobileFull" class="px-3 py-3 border-b border-gray-200 flex items-center gap-2 flex-shrink-0" style="min-height:56px;">
      <button
        @click="$emit('close')"
        class="text-gray-400 hover:text-gray-600 p-1 rounded hover:bg-gray-100"
        title="Close sidebar"
      >
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
      <span class="font-semibold text-sm text-gray-700">Tangan Kanan</span>
    </div>

    <!-- Search — v0.13.6 r8: pill ala admin sidebar & chat list (M3 Expressive, request Kanaka 12:06) -->
    <div class="px-3 py-2 border-b border-gray-200 flex-shrink-0">
      <div class="chat-search">
        <input
          v-model="searchQuery"
          type="text"
          class="chat-search__input"
          placeholder="Cari file…"
          autocomplete="off"
          aria-label="Cari file"
          @input="onSearchInput"
        />
      </div>
    </div>

    <!-- Scrollable content -->
    <div class="flex-1 overflow-y-auto">
      <!-- Loading -->
      <div v-if="loading" class="p-4 text-center text-gray-400 text-sm">Loading...</div>

      <!-- Announcements section (always visible, at top) -->
      <div v-else class="border-b border-gray-200">
        <!-- v0.9.0-r2 (audit fix #2): header section pengumuman pakai token M3
             (tertiary-container), bukan amber hardcoded -->
        <div class="px-3 py-2 text-xs font-semibold uppercase tracking-wide flex items-center gap-1 m3-ann-section">
          <span>📢</span> Pengumuman
        </div>

        <div v-if="!announcementsLoading">
          <div v-if="announcements.length === 0" class="px-3 py-3 text-sm text-gray-400 flex items-center gap-1">
            <svg class="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
            </svg>
            Semua sudah dibaca
          </div>

          <div v-else class="space-y-0">
            <div
              v-for="item in announcements"
              :key="item.id"
              class="border-b last:border-b-0"
              :style="{ borderColor: 'var(--md-sys-color-outline-variant)' }"
            >
              <div
                @click="expandAnnouncement(item.id)"
                class="px-3 py-2 cursor-pointer"
                :style="annHover === item.id ? { background: 'var(--md-sys-color-surface-container-high)' } : {}"
                @mouseover="annHover = item.id"
                @mouseleave="annHover = null"
              >
                <div class="flex items-start gap-2">
                  <span class="text-base leading-none mt-0.5" :style="{ color: 'var(--md-sys-color-tertiary)' }">{{ item.pinned ? '📌' : '📢' }}</span>
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-1.5 mb-0.5">
                      <span class="text-sm font-semibold text-gray-800 truncate">{{ item.title }}</span>
                      <button
                        @click.stop="markAnnouncementRead(item.id)"
                        class="text-gray-400 hover:text-gray-600 p-0.5 rounded hover:bg-gray-100"
                        title="Dismiss"
                      >
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                    <div class="text-xs text-gray-500 mb-1">{{ formatDate(item.createdAt) }}</div>
                    <div
                      class="text-sm text-gray-700 whitespace-pre-line"
                      :class="expandedAnnouncementId === item.id ? '' : 'line-clamp-2'"
                    >{{ item.content }}</div>
                    <div
                      v-if="item.content.length > 80"
                      class="text-xs mt-1 m3-ann-link"
                    >
                      {{ expandedAnnouncementId === item.id ? 'Tutup' : 'Selengkapnya' }}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <template v-if="!loading">
        <!-- Pinned section -->
        <div v-if="pinnedFiles.length > 0" class="border-b border-gray-100">
          <!-- v0.9.0-r2 (audit fix #2): header Pinned — surface-container-high (token),
               bukan yellow-50 hardcoded -->
          <div class="px-3 py-2 text-xs font-semibold uppercase tracking-wide flex items-center gap-1"
            :style="{ background: 'var(--md-sys-color-surface-container-high)', color: 'var(--md-sys-color-on-surface-variant)' }">
            <span>📌</span> Pinned ({{ pinnedFiles.length }})
          </div>
          <div
            v-for="file in pinnedFiles"
            :key="file.id"
            class="tk-file-item"
            @click="openActionMenu(file)"
          >
            <div class="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 cursor-pointer">
              <span class="text-lg flex-shrink-0">{{ fileIcon(file) }}</span>
              <div class="min-w-0 flex-1">
                <div class="text-sm truncate font-medium">{{ file.title || file.filename }}</div>
                <div class="text-xs text-gray-400 truncate">{{ file.uploader?.username || 'Unknown' }}</div>
              </div>
              <span v-if="file.isPinned" class="text-xs">📌</span>
            </div>
          </div>
        </div>

        <!-- Uncategorized files -->
        <div v-if="uncategorizedFiles.length > 0" class="border-b border-gray-100">
          <div class="px-3 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide flex items-center justify-between">
            <span>📂 Uncategorized ({{ uncategorizedFiles.length }})</span>
          </div>
          <div
            v-for="file in uncategorizedFiles"
            :key="file.id"
            @click="openActionMenu(file)"
            class="tk-file-item"
          >
            <div class="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 cursor-pointer">
              <span class="text-lg flex-shrink-0">{{ fileIcon(file) }}</span>
              <div class="min-w-0 flex-1">
                <div class="text-sm truncate font-medium">{{ file.title || file.filename }}</div>
                <div class="text-xs text-gray-400 truncate">{{ file.uploader?.username || 'Unknown' }}</div>
              </div>
              <span v-if="file.isPinned" class="text-xs">📌</span>
            </div>
          </div>
        </div>

        <!-- Folders -->
        <div v-for="folder in displayFolders" :key="folder.id" class="border-b border-gray-100">
          <div class="px-3 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide flex items-center justify-between">
            <span class="flex items-center gap-1">
              <span>{{ folder.isSystem ? systemFolderIcon(folder.name) : '📁' }}</span>
              {{ folder.name }} ({{ folder.files?.length || 0 }})
            </span>
            <button
              @click.stop="folder.name === 'Link' ? (showLinkForm = !showLinkForm) : triggerUpload(folder.id)"
              class="text-gray-400 hover:text-wa-green p-0.5 rounded hover:bg-gray-100"
              :title="folder.name === 'Link' ? 'Add link' : 'Upload to this folder'"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
              </svg>
            </button>
          </div>
          <!-- Link form (v0.2.5 — pindah dari header ke section-nya, konsisten dgn + Document/Image) -->
          <div v-if="folder.name === 'Link' && showLinkForm" class="px-3 py-3 bg-gray-50 border-t border-gray-100">
            <div class="space-y-2">
              <input
                v-model="linkUrl"
                type="url"
                placeholder="https://..."
                class="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:ring-1 focus:ring-wa-green focus:border-transparent"
              />
              <input
                v-model="linkTitle"
                type="text"
                placeholder="Title (optional)"
                class="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:ring-1 focus:ring-wa-green focus:border-transparent"
              />
              <div class="flex gap-2">
                <button
                  @click="addLink"
                  :disabled="!linkUrl.trim() || linking"
                  class="flex-1 px-3 py-1.5 text-sm bg-wa-green text-white rounded-lg hover:bg-green-600 disabled:opacity-50"
                >
                  {{ linking ? 'Adding...' : 'Add Link' }}
                </button>
                <button
                  @click="showLinkForm = false; linkUrl = ''; linkTitle = ''"
                  class="px-3 py-1.5 text-sm bg-gray-200 text-gray-600 rounded-lg hover:bg-gray-300"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
          <div
            v-for="file in (folder.files || [])"
            :key="file.id"
            @click="openActionMenu(file)"
            class="tk-file-item"
          >
            <div class="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 cursor-pointer">
              <template v-if="file.type === 'image' && file.storagePath">
                <!-- v0.9.0-r2 (audit fix #6): thumbnail rounded corner-m (12dp) + padding
                     konsisten via .tk-thumb (border mengikuti outline-variant) -->
                <img
                  :src="`${API}/api/tk/files/${file.id}/download?token=${auth.token}`"
                  class="tk-thumb w-8 h-8 object-cover flex-shrink-0"
                  :alt="file.filename"
                />
              </template>
              <template v-else>
                <span class="text-lg flex-shrink-0">{{ fileIcon(file) }}</span>
              </template>
              <div class="min-w-0 flex-1">
                <div class="text-sm truncate font-medium">{{ file.title || file.filename }}</div>
                <div class="text-xs text-gray-400 truncate">{{ file.uploader?.username || 'Unknown' }}</div>
              </div>
              <span v-if="file.isPinned" class="text-xs">📌</span>
            </div>
          </div>
          <div v-if="!folder.files || folder.files.length === 0" class="px-3 py-1.5 text-xs text-gray-300">
            Empty
          </div>
        </div>

        <!-- Create folder (admin or any user) -->
        <div class="px-3 py-2 border-b border-gray-100">
          <button
            @click="showNewFolderInput = !showNewFolderInput"
            class="text-xs text-gray-500 hover:text-wa-green flex items-center gap-1"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
            </svg>
            New folder
          </button>
          <div v-if="showNewFolderInput" class="mt-2 flex gap-1">
            <input
              v-model="newFolderName"
              @keydown.enter="createFolder"
              type="text"
              placeholder="Folder name..."
              class="flex-1 px-2 py-1 text-sm border border-gray-200 rounded focus:ring-1 focus:ring-wa-green focus:border-transparent"
            />
            <button
              @click="createFolder"
              :disabled="!newFolderName.trim()"
              class="px-2 py-1 text-xs bg-wa-green text-white rounded hover:bg-green-600 disabled:opacity-50"
            >Add</button>
          </div>
        </div>
      </template>
    </div>

    <!-- Hidden file input for uploads -->
    <input
      ref="fileInputRef"
      type="file"
      accept="image/*,video/*,audio/*,.pdf,.doc,.docx"
      class="hidden"
      @change="handleFileUpload"
    />

    <!-- Action menu modal -->
    <div
      v-if="selectedFile"
      @click="selectedFile = null"
      class="fixed inset-0 bg-black/30 z-40 flex items-center justify-center p-4"
    >
      <div
        @click.stop
        class="bg-white rounded-lg shadow-xl w-80 max-w-full overflow-hidden"
      >
        <!-- File preview header -->
        <div class="px-4 py-3 border-b border-gray-100">
          <div class="flex items-center gap-2">
            <span class="text-2xl">{{ fileIcon(selectedFile) }}</span>
            <div class="min-w-0 flex-1">
              <div class="text-sm font-medium truncate">{{ selectedFile.title || selectedFile.filename }}</div>
              <div class="text-xs text-gray-400">by {{ selectedFile.uploader?.username || 'Unknown' }}</div>
            </div>
            <button @click="selectedFile = null" class="text-gray-400 hover:text-gray-600">✕</button>
          </div>
        </div>

        <!-- Image preview -->
        <div v-if="selectedFile.type === 'image' && selectedFile.storagePath" class="border-b border-gray-100">
          <img
            :src="`${API}/api/tk/files/${selectedFile.id}/download?token=${auth.token}`"
            class="w-full max-h-48 object-cover"
            :alt="selectedFile.filename"
          />
        </div>

        <!-- Actions -->
        <div class="py-1">
          <button @click="viewFile(selectedFile)" class="w-full px-4 py-2.5 text-left text-sm hover:bg-gray-50 flex items-center gap-2">
            <span>👁️</span> View
          </button>
          <button
            v-if="currentChat"
            @click="insertToChat(selectedFile)"
            class="w-full px-4 py-2.5 text-left text-sm hover:bg-gray-50 flex items-center gap-2"
          >
            <span>💬</span> Send to {{ currentChat.contactName || currentChat.contactPhone }}
          </button>
          <button
            v-else
            disabled
            class="w-full px-4 py-2.5 text-left text-sm text-gray-300 flex items-center gap-2"
          >
            <span>💬</span> Open a chat first
          </button>
          <button @click="downloadFile(selectedFile)" class="w-full px-4 py-2.5 text-left text-sm hover:bg-gray-50 flex items-center gap-2">
            <span>⬇️</span> Download
          </button>
          <button
            v-if="selectedFile.type === 'link'"
            @click="copyLink(selectedFile)"
            class="w-full px-4 py-2.5 text-left text-sm hover:bg-gray-50 flex items-center gap-2"
          >
            <span>📋</span> Copy link
          </button>
          <button
            v-if="auth.isAdmin"
            @click="togglePin(selectedFile)"
            class="w-full px-4 py-2.5 text-left text-sm hover:bg-gray-50 flex items-center gap-2"
          >
            <span>{{ selectedFile.isPinned ? '📌' : '📍' }}</span> {{ selectedFile.isPinned ? 'Unpin' : 'Pin' }}
          </button>
          <button
            v-if="auth.isAdmin || selectedFile.uploadedBy === auth.user?.id"
            @click="deleteFile(selectedFile)"
            class="w-full px-4 py-2.5 text-left text-sm hover:bg-red-50 text-red-600 flex items-center gap-2"
          >
            <span>🗑️</span> Delete
          </button>
        </div>
      </div>
    </div>

    <!-- Insert confirmation modal (v0.1.21: caption pre-filled & editable utk image) -->
    <div
      v-if="insertConfirmFile"
      @click="insertConfirmFile = null; insertCaption = ''"
      class="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4"
    >
      <div @click.stop class="bg-white rounded-lg shadow-xl w-80 max-w-full p-4">
        <div class="text-sm font-medium mb-2">Send {{ insertConfirmFile.type === 'link' ? 'link' : 'file' }} to chat?</div>
        <div class="text-sm text-gray-500 mb-3">
          Send <span class="font-medium">{{ insertConfirmFile.filename }}</span> to
          <span class="font-medium">{{ currentChat?.contactName || currentChat?.contactPhone }}</span>?
        </div>
        <!-- v0.1.21 — caption editable untuk gambar (pre-filled dari SharedFile.caption) -->
        <div v-if="insertConfirmFile.type === 'image'" class="mb-3">
          <img
            :src="`${API}/api/tk/files/${insertConfirmFile.id}/download?token=${auth.token}`"
            class="w-full max-h-36 object-cover rounded mb-2"
            :alt="insertConfirmFile.filename"
          />
          <label class="text-xs text-gray-500 mb-1 block">Caption (opsional, bisa diedit)</label>
          <textarea
            v-model="insertCaption"
            rows="2"
            placeholder="Caption..."
            class="w-full px-2 py-1.5 text-sm border border-gray-200 rounded focus:ring-1 focus:ring-wa-green focus:border-transparent resize-none"
          ></textarea>
        </div>
        <div class="flex gap-2">
          <button
            @click="confirmInsert"
            :disabled="inserting"
            class="flex-1 px-3 py-2 text-sm bg-wa-green text-white rounded-lg hover:bg-green-600 disabled:opacity-50"
          >
            {{ inserting ? 'Sending...' : 'Send' }}
          </button>
          <button
            @click="insertConfirmFile = null; insertCaption = ''"
            class="px-3 py-2 text-sm bg-gray-200 text-gray-600 rounded-lg hover:bg-gray-300"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>

    <!-- v0.1.21 — Upload image modal: preview + caption sebelum upload -->
    <div
      v-if="uploadPreview"
      class="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4"
    >
      <div class="bg-white rounded-lg shadow-xl w-80 max-w-full p-4">
        <div class="text-sm font-medium mb-2">Upload gambar</div>
        <img :src="uploadPreview" class="w-full max-h-48 object-cover rounded mb-2" alt="preview" />
        <label class="text-xs text-gray-500 mb-1 block">Caption (opsional)</label>
        <textarea
          v-model="uploadCaption"
          rows="2"
          placeholder="Caption..."
          class="w-full px-2 py-1.5 text-sm border border-gray-200 rounded focus:ring-1 focus:ring-wa-green focus:border-transparent resize-none mb-3"
        ></textarea>
        <div class="flex gap-2">
          <button
            @click="doImageUpload"
            :disabled="uploading"
            class="flex-1 px-3 py-2 text-sm bg-wa-green text-white rounded-lg hover:bg-green-600 disabled:opacity-50"
          >
            {{ uploading ? 'Uploading...' : 'Simpan' }}
          </button>
          <button
            @click="cancelImageUpload"
            class="px-3 py-2 text-sm bg-gray-200 text-gray-600 rounded-lg hover:bg-gray-300"
          >
            Batal
          </button>
        </div>
      </div>
    </div>

    <!-- Toast notification -->
    <div
      v-if="toast"
      class="fixed bottom-4 right-4 bg-gray-800 text-white text-sm px-4 py-2 rounded-lg shadow-lg z-50"
    >
      {{ toast }}
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import axios from 'axios'
import { useAuthStore } from '../stores/auth'
import { useConfirm } from '../utils/confirm'
import { useSocketStore } from '../stores/socket'
import { useAnnouncementsStore } from '../stores/announcements'

const API = import.meta.env.VITE_API_URL || ''

const props = defineProps({
  currentChat: { type: Object, default: null },
  // v0.2.0 — 'mobile-full': dirender dalam sheet fullscreen mobile (tanpa border-left,
  // lebar penuh). 'default': sidebar desktop v0.1.x.
  variant: { type: String, default: 'default' },
})

const mobileFull = computed(() => props.variant === 'mobile-full')

const emit = defineEmits(['close'])

const auth = useAuthStore()
const { confirmAction } = useConfirm()
const socketStore = useSocketStore()
const announcementsStore = useAnnouncementsStore()

// State
const loading = ref(false)
const folders = ref([])
const uncategorizedFiles = ref([])
const allFiles = ref([])
const searchQuery = ref('')
const selectedFile = ref(null)
const showLinkForm = ref(false)
const annHover = ref(null) // v0.9.0-r2 (audit fix #2): hover state baris pengumuman
const linkUrl = ref('')
const linkTitle = ref('')
const linking = ref(false)
const showNewFolderInput = ref(false)
const newFolderName = ref('')
const fileInputRef = ref(null)
const uploadFolderId = ref(null)
const uploading = ref(false)
const insertConfirmFile = ref(null)
const insertCaption = ref('') // v0.1.21 — caption editable saat insert image
const inserting = ref(false)
const uploadPreview = ref(null) // v0.1.21 — dataURL preview sebelum upload
const uploadCaption = ref('') // v0.1.21 — caption saat upload image
const pendingImageFile = ref(null) // v0.1.21 — File object yang nunggu modal
const toast = ref(null)
let toastTimer = null
let searchDebounceTimer = null
const expandedAnnouncementId = ref(null)
const announcementsLoading = ref(false)

// Computed
const pinnedFiles = computed(() => {
  return allFiles.value.filter(f => f.isPinned)
})

const announcements = computed(() => announcementsStore.unread)

const displayFolders = computed(() => {
  if (searchQuery.value.trim().length >= 2) {
    const q = searchQuery.value.toLowerCase()
    return folders.value.map(f => ({
      ...f,
      files: (f.files || []).filter(file =>
        file.filename?.toLowerCase().includes(q) ||
        file.title?.toLowerCase().includes(q) ||
        file.url?.toLowerCase().includes(q)
      ),
    })).filter(f => f.files.length > 0)
  }
  return folders.value
})

// Methods
function showToast(msg) {
  toast.value = msg
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = null }, 3000)
}

function fileIcon(file) {
  if (file.type === 'image') return '🖼️'
  if (file.type === 'link') return '🔗'
  if (file.type === 'document') {
    if (file.mimeType?.includes('pdf')) return '📄'
    if (file.mimeType?.includes('sheet') || file.mimeType?.includes('excel')) return '📊'
    if (file.mimeType?.includes('word') || file.mimeType?.includes('document')) return '📝'
    return '📎'
  }
  return '📄'
}

function systemFolderIcon(name) {
  const map = { Image: '🖼️', Document: '📄', Link: '🔗' }
  return map[name] || '📁'
}

async function fetchFolders() {
  loading.value = true
  try {
    const res = await axios.get(`${API}/api/tk/folders`)
    folders.value = res.data.folders || []
    uncategorizedFiles.value = res.data.uncategorized || []
    // Build allFiles from folders + uncategorized for pinned section
    const all = []
    for (const f of folders.value) {
      if (f.files) all.push(...f.files)
    }
    all.push(...uncategorizedFiles.value)
    allFiles.value = all
  } catch (e) {
    console.error('TK fetch folders error:', e)
    showToast('Failed to load files')
  } finally {
    loading.value = false
  }
}

async function fetchFiles() {
  try {
    const params = {}
    if (searchQuery.value.trim().length >= 2) {
      params.search = searchQuery.value.trim()
    }
    const res = await axios.get(`${API}/api/tk/files`, { params })
    allFiles.value = res.data.files || []
  } catch (e) {
    console.error('TK fetch files error:', e)
  }
}

function onSearchInput() {
  clearTimeout(searchDebounceTimer)
  searchDebounceTimer = setTimeout(() => {
    if (searchQuery.value.trim().length >= 2) {
      fetchFiles()
    } else {
      fetchFolders()
    }
  }, 300)
}

function triggerUpload(folderId) {
  uploadFolderId.value = folderId
  if (fileInputRef.value) {
    fileInputRef.value.click()
  }
}

async function handleFileUpload(event) {
  const file = event.target.files?.[0]
  if (!file) return

  // v0.1.21 — Untuk image: tampilkan modal preview + caption dulu, JANGAN langsung upload
  if (file.type.startsWith('image/')) {
    pendingImageFile.value = file
    uploadCaption.value = ''
    const reader = new FileReader()
    reader.onload = e => { uploadPreview.value = e.target.result }
    reader.readAsDataURL(file)
    if (fileInputRef.value) {
      fileInputRef.value.value = ''
    }
    return
  }

  // Non-image: flow lama langsung upload
  uploading.value = true
  try {
    const formData = new FormData()
    formData.append('file', file)
    if (uploadFolderId.value) {
      formData.append('folderId', uploadFolderId.value)
    }

    await axios.post(`${API}/api/tk/files/upload`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })

    showToast('File uploaded')
    await fetchFolders()
  } catch (e) {
    console.error('TK upload error:', e)
    showToast('Upload failed: ' + (e.response?.data?.error || e.message))
  } finally {
    uploading.value = false
    if (fileInputRef.value) {
      fileInputRef.value.value = ''
    }
    uploadFolderId.value = null
  }
}

// v0.1.21 — Upload image dengan caption (dari modal)
async function doImageUpload() {
  const file = pendingImageFile.value
  if (!file) return

  uploading.value = true
  try {
    const formData = new FormData()
    formData.append('file', file)
    if (uploadFolderId.value) {
      formData.append('folderId', uploadFolderId.value)
    }
    const caption = uploadCaption.value.trim()
    if (caption) {
      formData.append('caption', caption)
    }

    await axios.post(`${API}/api/tk/files/upload`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })

    showToast('Image uploaded')
    cancelImageUpload()
    await fetchFolders()
  } catch (e) {
    console.error('TK image upload error:', e)
    showToast('Upload failed: ' + (e.response?.data?.error || e.message))
  } finally {
    uploading.value = false
    uploadFolderId.value = null
  }
}

function cancelImageUpload() {
  uploadPreview.value = null
  uploadCaption.value = ''
  pendingImageFile.value = null
}

async function addLink() {
  if (!linkUrl.value.trim()) return
  linking.value = true
  try {
    await axios.post(`${API}/api/tk/files/link`, {
      url: linkUrl.value.trim(),
      title: linkTitle.value.trim() || null,
    })
    showToast('Link added')
    showLinkForm.value = false
    linkUrl.value = ''
    linkTitle.value = ''
    await fetchFolders()
  } catch (e) {
    console.error('TK add link error:', e)
    showToast('Failed: ' + (e.response?.data?.error || e.message))
  } finally {
    linking.value = false
  }
}

async function createFolder() {
  if (!newFolderName.value.trim()) return
  try {
    await axios.post(`${API}/api/tk/folders`, { name: newFolderName.value.trim() })
    showToast('Folder created')
    newFolderName.value = ''
    showNewFolderInput.value = false
    await fetchFolders()
  } catch (e) {
    console.error('TK create folder error:', e)
    showToast('Failed: ' + (e.response?.data?.error || e.message))
  }
}

function openActionMenu(file) {
  selectedFile.value = file
}

function viewFile(file) {
  selectedFile.value = null
  if (file.type === 'link') {
    window.open(file.url, '_blank')
  } else if (file.type === 'image') {
    // Open in new tab via download endpoint
    window.open(`${API}/api/tk/files/${file.id}/download?token=${auth.token}`, '_blank')
  } else {
    // Documents — open in new tab
    window.open(`${API}/api/tk/files/${file.id}/download?token=${auth.token}`, '_blank')
  }
}

async function downloadFile(file) {
  selectedFile.value = null
  try {
    const response = await axios.get(`${API}/api/tk/files/${file.id}/download`, {
      responseType: 'blob',
      params: { token: auth.token },
    })
    const url = window.URL.createObjectURL(response.data)
    const a = document.createElement('a')
    a.href = url
    a.download = file.filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    window.URL.revokeObjectURL(url)
  } catch (e) {
    console.error('TK download error:', e)
    showToast('Download failed')
  }
}

async function copyLink(file) {
  selectedFile.value = null
  if (file.url) {
    try {
      await navigator.clipboard.writeText(file.url)
      showToast('Link copied')
    } catch {
      showToast('Could not copy')
    }
  }
}

async function togglePin(file) {
  selectedFile.value = null
  try {
    await axios.post(`${API}/api/tk/files/${file.id}/pin`)
    await fetchFolders()
  } catch (e) {
    console.error('TK pin error:', e)
    showToast('Failed to pin/unpin')
  }
}

async function deleteFile(file) {
  selectedFile.value = null
  // v0.9.0 — confirm() native → M3 dialog; handler delete TIDAK berubah
  const ok = await confirmAction({
    title: 'Hapus file?',
    message: `Delete "${file.filename}"?`,
    confirmText: 'Hapus',
    danger: true,
  })
  if (!ok) return
  try {
    await axios.delete(`${API}/api/tk/files/${file.id}`)
    showToast('File deleted')
    await fetchFolders()
  } catch (e) {
    console.error('TK delete error:', e)
    showToast('Delete failed')
  }
}

function insertToChat(file) {
  selectedFile.value = null
  if (!props.currentChat) {
    showToast('Please open a chat first')
    return
  }
  // v0.1.21 — pre-fill caption tersimpan untuk image (bisa diedit di modal)
  insertCaption.value = (file.type === 'image' && file.caption) ? file.caption : ''
  insertConfirmFile.value = file
}

async function confirmInsert() {
  const file = insertConfirmFile.value
  if (!file || !props.currentChat) return

  inserting.value = true
  try {
    if (file.type === 'link') {
      // v0.14.5 — link dikirim sbg pesan TEKS (bukan media): endpoint download
      // me-redirect ke URL eksternal -> CORS blocked -> axios "Network Error".
      // Pesan teks bikin WA nampilin preview link otomatis.
      await axios.post(
        `${API}/api/chats/${props.currentChat.id}/reply`,
        { content: file.url }
      )
    } else {
      // Download file as blob
      const response = await axios.get(`${API}/api/tk/files/${file.id}/download`, {
        responseType: 'blob',
        params: { token: auth.token },
      })

      // Send via chat media endpoint
      const formData = new FormData()
      formData.append('file', response.data, file.filename)
      // v0.1.21 — kirim caption (edited) untuk image; edit gak mengubah caption tersimpan
      if (file.type === 'image') {
        const cap = insertCaption.value.trim()
        if (cap) {
          formData.append('caption', cap)
        }
      }

      await axios.post(
        `${API}/api/chats/${props.currentChat.id}/media`,
        formData,
        { headers: { 'Content-Type': 'multipart/form-data' } }
      )
    }

    showToast(`Sent ${file.filename} to ${props.currentChat.contactName || props.currentChat.contactPhone}`)
    insertConfirmFile.value = null
    insertCaption.value = ''
  } catch (e) {
    console.error('TK insert to chat error:', e)
    showToast('Failed to send: ' + (e.response?.data?.error || e.message))
  } finally {
    inserting.value = false
  }
}

// Socket.IO listeners
function onTkFileCreated() {
  fetchFolders()
}

function onTkFileDeleted() {
  fetchFolders()
}

function onTkFilePinned() {
  fetchFolders()
}

function onTkFolderCreated() {
  fetchFolders()
}

function onTkFolderDeleted() {
  fetchFolders()
}

function formatDate(d) {
  if (!d) return ''
  const date = new Date(d)
  return date.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })
}

function expandAnnouncement(id) {
  expandedAnnouncementId.value = expandedAnnouncementId.value === id ? null : id
}

async function markAnnouncementRead(id) {
  await announcementsStore.markRead(id)
}

async function fetchAnnouncements() {
  announcementsLoading.value = true
  try {
    await announcementsStore.fetchAll()
  } finally {
    announcementsLoading.value = false
  }
}

function onAnnouncementUpdate() {
  // Socket updates refresh the store automatically; keep this for future use.
}

onMounted(() => {
  fetchFolders()
  fetchAnnouncements()
  socketStore.on('tk_file_created', onTkFileCreated)
  socketStore.on('tk_file_deleted', onTkFileDeleted)
  socketStore.on('tk_file_pinned', onTkFilePinned)
  socketStore.on('tk_folder_created', onTkFolderCreated)
  socketStore.on('tk_folder_deleted', onTkFolderDeleted)
  socketStore.on('announcement_update', onAnnouncementUpdate)
  socketStore.on('announcement_delete', onAnnouncementUpdate)
})

onUnmounted(() => {
  socketStore.off('tk_file_created', onTkFileCreated)
  socketStore.off('tk_file_deleted', onTkFileDeleted)
  socketStore.off('tk_file_pinned', onTkFilePinned)
  socketStore.off('tk_folder_created', onTkFolderCreated)
  socketStore.off('tk_folder_deleted', onTkFolderDeleted)
  socketStore.off('announcement_update', onAnnouncementUpdate)
  socketStore.off('announcement_delete', onAnnouncementUpdate)
})
</script>

<style scoped>
.tk-file-item {
  cursor: pointer;
}
/* v0.9.0-r2 (audit fix #2) — section header pengumuman Tangan Kanan: token M3 */
.m3-ann-section {
  background: var(--md-sys-color-tertiary-container);
  color: var(--md-sys-color-on-tertiary-container);
}
.m3-ann-link {
  color: var(--md-sys-color-tertiary);
}
/* v0.9.0-r2 (audit fix #6) — thumbnail Tangan Kanan: sudut rounded (corner-m = 12dp),
   ring tipis token supaya visualnya konsisten dgn baris file (wrapper baris sudah
   punya padding px-3/py-2 yang seragam untuk semua tipe file). */
.tk-thumb {
  border-radius: var(--md-sys-shape-corner-m);
  border: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container);
}
</style>
