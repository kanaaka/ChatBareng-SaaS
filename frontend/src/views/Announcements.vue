<template>
  <PageShell title="Pengumuman" back-to="/admin">
    <!-- Top bar (desktop; mobile pakai PageShell topbar + homerow, konsisten v0.2.2) -->
    <header class="hidden md:flex m3-topbar px-4 py-3 items-center justify-between">
      <div class="flex items-center gap-3">
        <h1 class="text-lg font-semibold">Pengumuman</h1>
      </div>
      <div class="flex items-center gap-4">
        <router-link to="/" class="text-sm hover:underline">Dashboard</router-link>
        <router-link to="/settings" class="text-sm hover:underline">{{ auth.user?.username }}</router-link>
        <button @click="handleLogout" class="text-sm hover:underline">Logout</button>
      </div>
    </header>

    <div class="max-w-4xl mx-auto w-full p-6">
      <!-- Create button (v0.3.4 — mobile: full-width biar selalu keliatan, konsisten Templates) -->
      <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-2 mb-4">
        <h2 class="text-lg font-semibold">Kelola Pengumuman</h2>
        <button @click="openCreateForm" class="w-full md:w-auto bg-wa-green text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-600">
          + New Announcement
        </button>
      </div>

      <!-- List (v0.3.4 — mobile: kartu; desktop: tabel) -->
      <div class="md:hidden space-y-2">
        <div v-if="loading" class="bg-white rounded-lg shadow-sm p-8 text-center text-gray-400 text-sm">Loading announcements...</div>
        <div v-else-if="items.length === 0" class="bg-white rounded-lg shadow-sm p-8 text-center text-gray-400 text-sm">
          No announcements yet. Click "New Announcement" to create one.
        </div>
        <div v-for="item in items" :key="item.id" class="bg-white rounded-lg shadow-sm p-3">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="text-sm font-medium truncate">
                <span v-if="item.pinned" class="mr-1">📌</span>{{ item.title }}
              </div>
              <div class="mt-1.5 flex items-center gap-1.5 flex-wrap">
                <span :class="statusClass(item.status)" class="text-xs px-2 py-0.5 rounded-full font-medium">{{ statusLabel(item.status) }}</span>
                <span class="text-xs text-gray-500">{{ item.readCount }}/{{ item.totalUsers }} users</span>
              </div>
            </div>
          </div>
          <div class="text-xs text-gray-600 mt-1.5 whitespace-pre-line line-clamp-3">{{ item.content }}</div>
          <div class="flex items-center justify-between gap-2 mt-2">
            <span class="text-xs text-gray-400">{{ formatDate(item.updatedAt) }}</span>
            <div class="flex items-center gap-2">
              <button @click="openEditForm(item)" class="text-xs px-2.5 py-1.5 rounded bg-blue-100 text-blue-700 active:bg-blue-200">Edit</button>
              <button @click="confirmDelete(item)" class="text-xs px-2.5 py-1.5 rounded bg-red-100 text-red-700 active:bg-red-200">Delete</button>
            </div>
          </div>
        </div>
      </div>

      <div class="hidden md:block bg-white rounded-lg shadow-sm overflow-x-auto">
        <div v-if="loading" class="p-8 text-center text-gray-400">Loading announcements...</div>
        <div v-else-if="items.length === 0" class="p-8 text-center text-gray-400">
          No announcements yet. Click "New Announcement" to create one.
        </div>
        <table v-else class="w-full min-w-[640px]">
          <thead class="bg-gray-50 border-b border-gray-200">
            <tr>
              <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Title</th>
              <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Content</th>
              <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
              <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Reads</th>
              <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Updated</th>
              <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-for="item in items" :key="item.id" class="hover:bg-gray-50">
              <td class="px-4 py-3 align-top">
                <div class="flex items-center gap-2">
                  <span v-if="item.pinned" class="text-lg">📌</span>
                  <span class="text-sm font-medium">{{ item.title }}</span>
                </div>
              </td>
              <td class="px-4 py-3 text-sm text-gray-600 max-w-xs">
                <div class="whitespace-pre-line line-clamp-3">{{ item.content }}</div>
              </td>
              <td class="px-4 py-3 align-top">
                <span :class="statusClass(item.status)" class="text-xs px-2 py-0.5 rounded-full font-medium">{{ statusLabel(item.status) }}</span>
              </td>
              <td class="px-4 py-3 text-sm text-gray-700 align-top">
                {{ item.readCount }}/{{ item.totalUsers }} users
              </td>
              <td class="px-4 py-3 text-xs text-gray-500 align-top whitespace-nowrap">
                {{ formatDate(item.updatedAt) }}
              </td>
              <td class="px-4 py-3 flex items-center gap-2 align-top">
                <button @click="openEditForm(item)" class="text-xs text-blue-600 hover:underline">Edit</button>
                <button @click="confirmDelete(item)" class="text-xs text-red-600 hover:underline">Delete</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Create/Edit Modal -->
    <div v-if="showForm" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div class="flex items-center justify-between p-6 border-b border-gray-200">
          <h3 class="text-lg font-semibold">{{ editingId ? 'Edit Announcement' : 'New Announcement' }}</h3>
          <button @click="closeForm" class="text-gray-400 hover:text-gray-600 text-2xl">×</button>
        </div>

        <div class="p-6 space-y-4">
          <!-- Title -->
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Title</label>
            <input
              v-model="formData.title"
              type="text"
              placeholder="e.g. Info maintenance malam ini"
              class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-1 focus:ring-wa-green focus:border-transparent"
            />
            <p class="text-xs text-gray-400 mt-1">Max 100 characters.</p>
          </div>

          <!-- Content -->
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Content</label>
            <textarea
              v-model="formData.content"
              rows="6"
              placeholder="Tulis pengumuman dalam plain text..."
              class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-1 focus:ring-wa-green focus:border-transparent"
            ></textarea>
            <p class="text-xs text-gray-400 mt-1">Max 2000 characters. Line breaks preserved.</p>
          </div>

          <!-- Options -->
          <div class="flex flex-wrap items-center gap-6">
            <label class="flex items-center gap-2 cursor-pointer">
              <input v-model="formData.pinned" type="checkbox" class="w-4 h-4 rounded border-gray-300 text-wa-green focus:ring-wa-green" />
              <span class="text-sm text-gray-700">📌 Pin to top</span>
            </label>

            <label v-if="editingId" class="flex items-center gap-2 cursor-pointer">
              <input v-model="formData.isActive" type="checkbox" class="w-4 h-4 rounded border-gray-300 text-wa-green focus:ring-wa-green" />
              <span class="text-sm text-gray-700">Active (visible to users)</span>
            </label>
          </div>

          <!-- Expires at -->
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Expires at (optional)</label>
            <input
              v-model="formData.expiresAt"
              type="datetime-local"
              class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-1 focus:ring-wa-green focus:border-transparent"
            />
            <p class="text-xs text-gray-400 mt-1">Leave empty for no expiration. Expired announcements are hidden from users but still listed here.</p>
          </div>

          <!-- Error -->
          <div v-if="formError" class="text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg p-3">
            {{ formError }}
          </div>
        </div>

        <div class="flex justify-end gap-3 p-6 border-t border-gray-200">
          <button @click="closeForm" class="text-gray-600 px-4 py-2 rounded-lg text-sm hover:bg-gray-100">Cancel</button>
          <button @click="saveAnnouncement" :disabled="saving" class="bg-wa-green text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-600 disabled:opacity-50">
            {{ saving ? 'Saving...' : (editingId ? 'Update' : 'Create') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Delete confirmation modal -->
    <div v-if="showDeleteConfirm" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-lg shadow-xl max-w-md w-full">
        <div class="p-6">
          <h3 class="text-lg font-semibold mb-2">Delete Announcement</h3>
          <p class="text-sm text-gray-600 mb-4">
            Are you sure you want to delete <strong>{{ deletingItem?.title }}</strong>?
            This cannot be undone and will remove read tracking.
          </p>
          <div class="flex justify-end gap-3">
            <button @click="showDeleteConfirm = false" class="text-gray-600 px-4 py-2 rounded-lg text-sm hover:bg-gray-100">Cancel</button>
            <button @click="deleteAnnouncement" class="bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-700">Delete</button>
          </div>
        </div>
      </div>
    </div>
  </PageShell>
</template>

<script setup>
import PageShell from '../components/PageShell.vue'

import { ref, computed, onMounted } from 'vue'
import axios from 'axios'
import { useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'

const API = import.meta.env.VITE_API_URL || ''
const auth = useAuthStore()
const toast = useToastStore()

const items = ref([])
const loading = ref(false)

const showForm = ref(false)
const editingId = ref(null)
const formData = ref({
  title: '',
  content: '',
  pinned: false,
  isActive: true,
  expiresAt: '',
})
const formError = ref('')
const saving = ref(false)

const showDeleteConfirm = ref(false)
const deletingItem = ref(null)

const filteredItems = computed(() => {
  return items.value
})

function statusLabel(status) {
  if (status === 'active') return 'Active'
  if (status === 'expired') return 'Expired'
  return 'Inactive'
}

function statusClass(status) {
  if (status === 'active') return 'bg-green-100 text-green-700'
  if (status === 'expired') return 'bg-yellow-100 text-yellow-700'
  return 'bg-gray-100 text-gray-600'
}

function formatDate(d) {
  if (!d) return ''
  return new Date(d).toLocaleString('id-ID', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

async function fetchAll() {
  loading.value = true
  try {
    const res = await axios.get(`${API}/api/announcements/all`)
    items.value = res.data.announcements || []
  } catch (e) {
    console.error('Fetch announcements error:', e)
  } finally {
    loading.value = false
  }
}

function openCreateForm() {
  editingId.value = null
  formData.value = { title: '', content: '', pinned: false, isActive: true, expiresAt: '' }
  formError.value = ''
  showForm.value = true
}

function openEditForm(item) {
  editingId.value = item.id
  formData.value = {
    title: item.title,
    content: item.content,
    pinned: item.pinned,
    isActive: item.isActive,
    expiresAt: item.expiresAt ? toDatetimeLocal(item.expiresAt) : '',
  }
  formError.value = ''
  showForm.value = true
}

function closeForm() {
  showForm.value = false
  editingId.value = null
  formError.value = ''
}

function toDatetimeLocal(d) {
  const date = new Date(d)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

async function saveAnnouncement() {
  formError.value = ''

  if (!formData.value.title.trim()) {
    formError.value = 'Title is required'
    return
  }
  if (!formData.value.content.trim()) {
    formError.value = 'Content is required'
    return
  }

  const payload = {
    title: formData.value.title.trim(),
    content: formData.value.content.trim(),
    pinned: formData.value.pinned,
  }

  if (editingId.value) {
    payload.isActive = formData.value.isActive
  }

  if (formData.value.expiresAt) {
    payload.expiresAt = new Date(formData.value.expiresAt).toISOString()
  } else {
    payload.expiresAt = null
  }

  saving.value = true
  try {
    if (editingId.value) {
      await axios.put(`${API}/api/announcements/${editingId.value}`, payload)
    } else {
      await axios.post(`${API}/api/announcements`, payload)
    }
    await fetchAll()
    closeForm()
  } catch (e) {
    formError.value = e.response?.data?.error || 'Failed to save announcement'
  } finally {
    saving.value = false
  }
}

function confirmDelete(item) {
  deletingItem.value = item
  showDeleteConfirm.value = true
}

async function deleteAnnouncement() {
  if (!deletingItem.value) return
  try {
    await axios.delete(`${API}/api/announcements/${deletingItem.value.id}`)
    await fetchAll()
    showDeleteConfirm.value = false
    deletingItem.value = null
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Gagal menghapus', message: e.response?.data?.error || e.message })
  }
}

function handleLogout() {
  auth.logout()
  window.location.href = '/login'
}

onMounted(() => {
  fetchAll()
})
</script>

<style scoped>
.line-clamp-3 {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
