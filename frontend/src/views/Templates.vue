<template>
  <PageShell title="Templates" back-to="/admin">
    <!-- Top bar (desktop only — mobile: PageShell topbar + homerow, v0.3.0) -->
    <header class="hidden md:flex m3-topbar px-4 py-3 items-center justify-between">
      <div class="flex items-center gap-3">
        <h1 class="text-lg font-semibold">Templates</h1>
      </div>
      <div class="flex items-center gap-4">
        <router-link to="/" class="text-sm hover:underline">Dashboard</router-link>
        <router-link to="/settings" class="text-sm hover:underline">{{ auth.user?.username }}</router-link>
        <button @click="handleLogout" class="text-sm hover:underline">Logout</button>
      </div>
    </header>

    <div class="max-w-4xl mx-auto w-full p-6">
      <!-- Action bar (v0.15.1 — Export/Import + New; mobile: full-width, flex wrap) -->
      <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-2 mb-4">
        <h2 class="text-lg font-semibold">Message Templates</h2>
        <div class="flex flex-wrap items-center gap-2">
          <button
            @click="exportTemplates"
            :disabled="exporting"
            class="w-full md:w-auto px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {{ exporting ? 'Menyiapkan…' : '⬇️ Export' }}
          </button>
          <button
            @click="triggerImport"
            :disabled="importing"
            class="w-full md:w-auto px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {{ importing ? 'Mengimpor…' : '⬆️ Import' }}
          </button>
          <button @click="openCreateForm" class="w-full md:w-auto bg-wa-green text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-600">
            + New Template
          </button>
          <input
            ref="importFileInput"
            type="file"
            accept=".json,application/json"
            class="hidden"
            @change="onImportFileChange"
          />
        </div>
      </div>

      <!-- Search/filter -->
      <div class="mb-4">
        <input
          v-model="searchQuery"
          type="text"
          placeholder="Search by name, keyword, or category..."
          class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-1 focus:ring-wa-green focus:border-transparent"
        />
      </div>

      <!-- Template list (v0.3.1 — mobile: kartu; desktop: tabel internal-scroll) -->
      <div class="md:hidden space-y-2">
        <div v-if="loading" class="bg-white rounded-lg shadow-sm p-8 text-center text-gray-400 text-sm">Loading templates...</div>
        <div v-else-if="filteredTemplates.length === 0" class="bg-white rounded-lg shadow-sm p-8 text-center text-gray-400 text-sm">
          {{ searchQuery ? 'Tidak ada template yang cocok dengan pencarian' : 'Belum ada template. Tekan "+ New Template" untuk membuat.' }}
        </div>
        <div v-for="tpl in filteredTemplates" :key="tpl.id" class="bg-white rounded-lg shadow-sm p-3">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="text-sm font-medium truncate">{{ tpl.name }}</div>
              <div class="mt-1 flex items-center gap-1.5 flex-wrap">
                <code class="text-xs bg-gray-100 px-1.5 py-0.5 rounded text-wa-dark">{{ tpl.keyword }}</code>
                <span class="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">{{ tpl.category }}</span>
              </div>
            </div>
          </div>
          <div class="text-xs text-gray-600 mt-1.5 line-clamp-2">{{ tpl.content }}</div>
          <div class="flex items-center gap-2 mt-2">
            <button @click="openEditForm(tpl)" class="text-xs px-2.5 py-1.5 rounded bg-blue-100 text-blue-700 active:bg-blue-200">Edit</button>
            <button @click="confirmDelete(tpl)" class="text-xs px-2.5 py-1.5 rounded bg-red-100 text-red-700 active:bg-red-200">Delete</button>
          </div>
        </div>
      </div>

      <div class="hidden md:block bg-white rounded-lg shadow-sm overflow-x-auto">
        <div v-if="loading" class="p-8 text-center text-gray-400">Loading templates...</div>
        <div v-else-if="filteredTemplates.length === 0" class="p-8 text-center text-gray-400">
          {{ searchQuery ? 'No templates match your search' : 'No templates yet. Click "New Template" to create one.' }}
        </div>
        <table v-else class="w-full min-w-[640px]">
          <thead class="bg-gray-50 border-b border-gray-200">
            <tr>
              <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Name</th>
              <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Keyword</th>
              <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Category</th>
              <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Content</th>
              <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-for="tpl in filteredTemplates" :key="tpl.id" class="hover:bg-gray-50">
              <td class="px-4 py-3 text-sm font-medium">{{ tpl.name }}</td>
              <td class="px-4 py-3">
                <code class="text-xs bg-gray-100 px-1.5 py-0.5 rounded text-wa-dark">{{ tpl.keyword }}</code>
              </td>
              <td class="px-4 py-3">
                <span class="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">{{ tpl.category }}</span>
              </td>
              <td class="px-4 py-3 text-sm text-gray-600 max-w-xs truncate">{{ tpl.content }}</td>
              <td class="px-4 py-3 flex items-center gap-2">
                <button @click="openEditForm(tpl)" class="text-xs text-blue-600 hover:underline">Edit</button>
                <button @click="confirmDelete(tpl)" class="text-xs text-red-600 hover:underline">Delete</button>
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
          <h3 class="text-lg font-semibold">{{ editingId ? 'Edit Template' : 'New Template' }}</h3>
          <button @click="closeForm" class="text-gray-400 hover:text-gray-600 text-2xl">×</button>
        </div>

        <div class="p-6 space-y-4">
          <!-- Name -->
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Name</label>
            <input
              v-model="formData.name"
              type="text"
              placeholder="e.g. Sapaan Pembuka"
              class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-1 focus:ring-wa-green focus:border-transparent"
            />
          </div>

          <!-- Keyword -->
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Keyword</label>
            <input
              v-model="formData.keyword"
              type="text"
              placeholder="e.g. /sapaan"
              @blur="autoPrependSlash"
              class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-1 focus:ring-wa-green focus:border-transparent"
            />
            <p class="text-xs text-gray-400 mt-1">Must start with "/". Used as slash command in chat.</p>
          </div>

          <!-- Category -->
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Category</label>
            <input
              v-model="formData.category"
              type="text"
              placeholder="e.g. pembuka, penutup, faq"
              list="category-suggestions"
              class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-1 focus:ring-wa-green focus:border-transparent"
            />
            <datalist id="category-suggestions">
              <option v-for="cat in uniqueCategories" :key="cat" :value="cat" />
            </datalist>
          </div>

          <!-- Content with formatting toolbar -->
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Content</label>
            <!-- Formatting Toolbar -->
            <div class="flex items-center gap-1 mb-2 pb-2 border-b border-gray-200">
              <button @click="wrapSelection('*', '*')" class="toolbar-btn" title="Bold">
                <span class="font-bold">B</span>
              </button>
              <button @click="wrapSelection('_', '_')" class="toolbar-btn" title="Italic">
                <span class="italic">I</span>
              </button>
              <button @click="wrapSelection('~', '~')" class="toolbar-btn" title="Strikethrough">
                <span class="line-through">S</span>
              </button>
              <div class="w-px h-5 bg-gray-300 mx-1"></div>
              <button @click="insertLinePrefix('- ')" class="toolbar-btn" title="Bullet list">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/></svg>
              </button>
              <button @click="insertLinePrefix('1. ')" class="toolbar-btn" title="Numbered list">
                <span class="text-sm font-medium">1.</span>
              </button>
              <div class="w-px h-5 bg-gray-300 mx-1"></div>
              <button @click="insertName" class="toolbar-btn" title="Insert Name variable">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>
                <span class="text-sm">Name</span>
              </button>
            </div>
            <textarea
              ref="contentTextareaRef"
              v-model="formData.content"
              rows="5"
              placeholder="Type template content... Use {name} for personalization"
              class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-1 focus:ring-wa-green focus:border-transparent"
            ></textarea>
            <p class="text-xs text-gray-400 mt-1">
              <code class="bg-gray-100 px-1 rounded">{name}</code> will be replaced with the contact's name when sending.
            </p>
          </div>

          <!-- Error -->
          <div v-if="formError" class="text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg p-3">
            {{ formError }}
          </div>
        </div>

        <div class="flex justify-end gap-3 p-6 border-t border-gray-200">
          <button @click="closeForm" class="text-gray-600 px-4 py-2 rounded-lg text-sm hover:bg-gray-100">Cancel</button>
          <button @click="saveTemplate" :disabled="saving" class="bg-wa-green text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-600 disabled:opacity-50">
            {{ saving ? 'Saving...' : (editingId ? 'Update' : 'Create') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Delete confirmation modal -->
    <div v-if="showDeleteConfirm" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-lg shadow-xl max-w-md w-full">
        <div class="p-6">
          <h3 class="text-lg font-semibold mb-2">Delete Template</h3>
          <p class="text-sm text-gray-600 mb-4">
            Are you sure you want to delete <strong>{{ deletingTemplate?.name }}</strong> ({{ deletingTemplate?.keyword }})?
            This cannot be undone.
          </p>
          <div class="flex justify-end gap-3">
            <button @click="showDeleteConfirm = false" class="text-gray-600 px-4 py-2 rounded-lg text-sm hover:bg-gray-100">Cancel</button>
            <button @click="deleteTemplate" class="bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-700">Delete</button>
          </div>
        </div>
      </div>
    </div>
    <!-- Import confirmation modal (v0.15.1 — pattern sama dengan delete confirm) -->
    <div v-if="showImportConfirm" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-lg shadow-xl max-w-md w-full">
        <div class="p-6">
          <h3 class="text-lg font-semibold mb-2">Import Template</h3>
          <p class="text-sm text-gray-600 mb-4">
            Import template dari <strong>{{ pendingImportFile?.name }}</strong>?
            Sifatnya aman — tidak ada template yang diubah/dihapus:
            keyword yang sudah ada dilewati, nama yang sudah ada otomatis di-rename "(import)".
          </p>
          <div class="flex justify-end gap-3">
            <button @click="cancelImport" class="text-gray-600 px-4 py-2 rounded-lg text-sm hover:bg-gray-100">Cancel</button>
            <button @click="doImport" :disabled="importing" class="bg-wa-green text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-600 disabled:opacity-50">
              {{ importing ? 'Mengimpor…' : 'Import' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Import result modal (v0.15.1 — panel hasil import template) -->
    <div v-if="importResult" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-lg shadow-xl max-w-md w-full">
        <div class="p-6">
          <h3 class="text-lg font-semibold mb-2">Hasil Import Template</h3>
          <p class="text-sm text-gray-600 mb-4">
            Total {{ importResult.total }} entri — {{ importResult.created }} dibuat, {{ importResult.skipped }} dilewati, {{ importResult.renamed }} di-rename.
          </p>

          <div v-if="importResult.errors?.length" class="mb-4">
            <div class="text-sm font-medium text-red-700 mb-1">Errors ({{ importResult.errors.length }})</div>
            <div class="max-h-40 overflow-y-auto bg-red-50 border border-red-200 rounded-lg p-3 space-y-1">
              <div v-for="(err, i) in importResult.errors" :key="i" class="text-xs text-red-700">
                <span class="font-medium">#{{ err.index }} {{ err.name }}</span> — {{ err.reason }}
              </div>
            </div>
          </div>

          <div class="flex justify-end gap-3">
            <button @click="importResult = null" class="bg-wa-green text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-600">OK</button>
          </div>
        </div>
      </div>
    </div>
  </PageShell>
</template>

<script setup>
import PageShell from '../components/PageShell.vue'
import { ref, computed, onMounted, nextTick } from 'vue'
import axios from 'axios'
import { useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'

const API = import.meta.env.VITE_API_URL || ''
const auth = useAuthStore()
const toast = useToastStore()

const templates = ref([])
const loading = ref(false)
const searchQuery = ref('')

// Form state
const showForm = ref(false)
const editingId = ref(null)
const formData = ref({ name: '', keyword: '', content: '', category: 'umum' })
const formError = ref('')
const saving = ref(false)
const contentTextareaRef = ref(null)

// Delete state
const showDeleteConfirm = ref(false)
const deletingTemplate = ref(null)

const filteredTemplates = computed(() => {
  if (!searchQuery.value.trim()) return templates.value
  const q = searchQuery.value.toLowerCase()
  return templates.value.filter(t =>
    t.name.toLowerCase().includes(q) ||
    t.keyword.toLowerCase().includes(q) ||
    t.category.toLowerCase().includes(q)
  )
})

const uniqueCategories = computed(() => {
  const cats = templates.value.map(t => t.category).filter(Boolean)
  return [...new Set(cats)].sort()
})

async function fetchTemplates() {
  loading.value = true
  try {
    const res = await axios.get(`${API}/api/templates`)
    templates.value = res.data.templates
  } catch (e) {
    console.error('Fetch templates error:', e)
  } finally {
    loading.value = false
  }
}

function openCreateForm() {
  editingId.value = null
  formData.value = { name: '', keyword: '', content: '', category: 'umum' }
  formError.value = ''
  showForm.value = true
  nextTick(() => contentTextareaRef.value?.focus())
}

function openEditForm(tpl) {
  editingId.value = tpl.id
  formData.value = { name: tpl.name, keyword: tpl.keyword, content: tpl.content, category: tpl.category }
  formError.value = ''
  showForm.value = true
}

function closeForm() {
  showForm.value = false
  editingId.value = null
  formError.value = ''
}

function autoPrependSlash() {
  if (formData.value.keyword && !formData.value.keyword.startsWith('/')) {
    formData.value.keyword = '/' + formData.value.keyword
  }
}

async function saveTemplate() {
  formError.value = ''
  
  if (!formData.value.name.trim()) {
    formError.value = 'Name is required'
    return
  }
  if (!formData.value.keyword.trim()) {
    formError.value = 'Keyword is required'
    return
  }
  if (!formData.value.content.trim()) {
    formError.value = 'Content is required'
    return
  }

  // Auto-prepend slash
  let keyword = formData.value.keyword.trim()
  if (!keyword.startsWith('/')) {
    keyword = '/' + keyword
  }

  saving.value = true
  try {
    const payload = {
      name: formData.value.name.trim(),
      keyword,
      content: formData.value.content.trim(),
      category: formData.value.category.trim() || 'umum',
    }

    if (editingId.value) {
      await axios.put(`${API}/api/templates/${editingId.value}`, payload)
    } else {
      await axios.post(`${API}/api/templates`, payload)
    }

    await fetchTemplates()
    closeForm()
  } catch (e) {
    formError.value = e.response?.data?.error || 'Failed to save template'
  } finally {
    saving.value = false
  }
}

function confirmDelete(tpl) {
  deletingTemplate.value = tpl
  showDeleteConfirm.value = true
}

async function deleteTemplate() {
  if (!deletingTemplate.value) return
  try {
    await axios.delete(`${API}/api/templates/${deletingTemplate.value.id}`)
    await fetchTemplates()
    showDeleteConfirm.value = false
    deletingTemplate.value = null
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Gagal menghapus', message: e.response?.data?.error || e.message })
  }
}

// v0.15.1 — Export & Import templates (admin)
const exporting = ref(false)
const importing = ref(false)
const importFileInput = ref(null)
const showImportConfirm = ref(false)
const pendingImportFile = ref(null)
const importResult = ref(null)

async function exportTemplates() {
  exporting.value = true
  try {
    const res = await axios.get(`${API}/api/templates/export`, { responseType: 'blob' })
    // Ambil filename dari Content-Disposition, fallback default
    let filename = 'chatbareng-templates.json'
    const cd = res.headers['content-disposition']
    if (cd) {
      const m = /filename="?([^";]+)"?/i.exec(cd)
      if (m) filename = m[1]
    }
    const url = URL.createObjectURL(res.data)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Export gagal', message: e.response?.data?.error || 'Gagal mengunduh file export template' })
  } finally {
    exporting.value = false
  }
}

function triggerImport() {
  importFileInput.value?.click()
}

function onImportFileChange(ev) {
  const selected = ev.target.files?.[0] || null
  ev.target.value = ''
  if (!selected) return
  if (!selected.name.toLowerCase().endsWith('.json') && selected.type !== 'application/json') {
    toast.show({ icon: '⚠️', title: 'File tidak valid', message: 'Pilih file .json hasil export template.' })
    return
  }
  pendingImportFile.value = selected
  showImportConfirm.value = true
}

function cancelImport() {
  showImportConfirm.value = false
  pendingImportFile.value = null
}

async function doImport() {
  const selected = pendingImportFile.value
  if (!selected || importing.value) return

  importing.value = true
  try {
    const fd = new FormData()
    fd.append('file', selected)
    const res = await axios.post(`${API}/api/templates/import`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    importResult.value = res.data
    const { created, skipped, renamed } = res.data
    toast.show({ icon: '⬆️', title: 'Import selesai', message: `Berhasil: ${created} dibuat, ${skipped} dilewati, ${renamed} di-rename` })
    await fetchTemplates()
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Import gagal', message: e.response?.data?.error || 'Gagal mengimpor file template' })
  } finally {
    showImportConfirm.value = false
    pendingImportFile.value = null
    importing.value = false
  }
}

// Formatting toolbar functions
function wrapSelection(before, after) {
  const textarea = contentTextareaRef.value
  if (!textarea) return
  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  const selected = formData.value.content.substring(start, end)
  formData.value.content = formData.value.content.substring(0, start) + before + selected + after + formData.value.content.substring(end)
  nextTick(() => {
    textarea.focus()
    textarea.setSelectionRange(start + before.length, end + before.length)
  })
}

function insertLinePrefix(prefix) {
  const textarea = contentTextareaRef.value
  if (!textarea) return
  const start = textarea.selectionStart
  const lineStart = formData.value.content.lastIndexOf('\n', start - 1) + 1
  formData.value.content = formData.value.content.substring(0, lineStart) + prefix + formData.value.content.substring(lineStart)
  nextTick(() => {
    textarea.focus()
    textarea.setSelectionRange(start + prefix.length, start + prefix.length)
  })
}

function insertName() {
  const textarea = contentTextareaRef.value
  if (!textarea) return
  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  formData.value.content = formData.value.content.substring(0, start) + '{name}' + formData.value.content.substring(end)
  nextTick(() => {
    textarea.focus()
    textarea.setSelectionRange(start + 6, start + 6)
  })
}

function handleLogout() {
  auth.logout()
  window.location.href = '/login'
}

onMounted(() => {
  fetchTemplates()
})
</script>

<style scoped>
.toolbar-btn {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 14px;
  color: #4b5563;
  transition: background 0.15s;
}
.toolbar-btn:hover {
  background: #f3f4f6;
}
</style>
