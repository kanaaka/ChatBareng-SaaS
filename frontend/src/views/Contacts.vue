<template>
  <PageShell title="Kontak">
    <!-- Desktop header (mobile: PageShell topbar + homerow, konsisten v0.2.2) -->
    <header class="hidden md:flex m3-topbar px-4 py-3 items-center justify-between">
      <div class="flex items-center gap-3">
        <router-link to="/" class="text-sm hover:underline">← Dashboard</router-link>
        <h1 class="text-lg font-semibold">Kontak</h1>
      </div>
      <div class="flex items-center gap-4">
        <router-link v-if="auth.isAdmin" to="/admin" class="text-sm hover:underline">Admin Panel</router-link>
        <router-link to="/settings" class="text-sm hover:underline">{{ auth.user?.username }}</router-link>
        <button @click="handleLogout" class="text-sm hover:underline">Logout</button>
      </div>
    </header>

    <div class="max-w-4xl mx-auto w-full p-6 space-y-4">
      <!-- v0.14.0 — Segmen mobile "Kontak | Grup" (spec §6 mobile). Desktop tidak
           berubah (halaman Kontak tetap kontak; nav Grup ada di topbar desktop).
           Homerow TIDAK disentuh.
           v4.1.0 — segmen jadi "Kontak | Grup | Channel" (D4b — pola Grup); Channel
           = read-only (admin-only, tapi tab tetap tampil utk semua role — panel
           menampilkan pesan ramah bila bukan admin, konsisten pola halaman lain). -->
      <div class="md:hidden bg-white rounded-lg shadow-sm p-1 flex gap-1">
        <button
          @click="mobileTab = 'contacts'"
          :class="['flex-1 py-2 text-sm font-medium rounded-md transition-colors', mobileTab === 'contacts' ? 'bg-wa-dark text-white' : 'text-gray-600 hover:bg-gray-100']"
        >Kontak</button>
        <button
          @click="mobileTab = 'groups'"
          :class="['flex-1 py-2 text-sm font-medium rounded-md transition-colors', mobileTab === 'groups' ? 'bg-wa-dark text-white' : 'text-gray-600 hover:bg-gray-100']"
        >Grup</button>
        <button
          @click="mobileTab = 'channels'"
          :class="['flex-1 py-2 text-sm font-medium rounded-md transition-colors', mobileTab === 'channels' ? 'bg-wa-dark text-white' : 'text-gray-600 hover:bg-gray-100']"
        >Channel</button>
      </div>

      <!-- v0.14.0 — Konten tab Grup (mobile): panel list sama dgn halaman Grup -->
      <div v-if="mobileTab === 'groups'" class="md:hidden">
        <GroupListPanel @open="openGroupMobile" />
      </div>

      <!-- v4.1.0 — Konten tab Channel (mobile, D4b): panel read-only (list + postingan) -->
      <div v-if="mobileTab === 'channels'" class="md:hidden">
        <ChannelListPanel />
      </div>

      <!-- Konten tab Kontak (mobile: hidden saat tab Grup aktif; desktop selalu tampil) -->
      <div v-show="mobileTab === 'contacts'">
      <!-- Toolbar -->
      <div class="bg-white rounded-lg shadow-sm p-4 flex flex-col md:flex-row md:items-center gap-3">
        <div class="flex-1">
          <input
            v-model="search"
            @input="onSearch"
            type="text"
            placeholder="Cari nama, nomor, kota, catatan..."
            class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-wa-green"
          />
        </div>
        <div class="flex items-center gap-2">
          <button
            @click="openCreate"
            class="m3-btn m3-btn--filled !min-h-[44px] !px-5 text-sm"
          >
            + Tambah Kontak
          </button>
          <button
            @click="showImportModal = true"
            class="px-4 py-2 text-sm font-medium rounded-lg bg-wa-dark text-white hover:bg-gray-800"
          >
            📥 Import CSV
          </button>
          <button
            @click="exportContacts"
            class="px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
          >
            📤 Export CSV
          </button>
        </div>
      </div>

      <!-- v0.13.4 — Panel "Kelola Tag" (ADMIN ONLY, collapsible) -->
      <div v-if="auth.isAdmin" class="bg-white rounded-lg shadow-sm">
        <button
          @click="showTagPanel = !showTagPanel"
          class="w-full px-4 py-3 flex items-center justify-between text-left"
        >
          <span class="text-sm font-semibold flex items-center gap-2">🏷️ Kelola Tag</span>
          <span class="text-gray-400 text-sm">{{ showTagPanel ? '▲' : '▼' }}</span>
        </button>
        <div v-if="showTagPanel" class="px-4 pb-4 space-y-3">
          <!-- Form tambah tag baru -->
          <div class="flex items-center gap-2">
            <input
              v-model="newTagName"
              type="text"
              maxlength="40"
              placeholder="Nama tag baru"
              class="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-wa-green"
              @keydown.enter="createTag"
            />
            <select v-model="newTagColor" class="px-2 py-2 text-sm border border-gray-300 rounded-lg bg-white">
              <option v-for="c in TAG_COLORS" :key="c.value" :value="c.value">{{ c.label }}</option>
            </select>
            <button
              @click="createTag"
              :disabled="!newTagName.trim() || tagBusy"
              class="px-4 py-2 text-sm font-medium rounded-lg bg-wa-green text-white hover:bg-green-600 disabled:opacity-50 whitespace-nowrap"
            >+ Tambah</button>
          </div>
          <!-- Daftar tag -->
          <div class="space-y-1">
            <div v-if="tags.length === 0" class="text-sm text-gray-400 py-2">Belum ada tag</div>
            <!-- v4.1.4 — row edit inline: form ganti nama + warna (menggantikan tampilan row) -->
            <div
              v-for="t in tags"
              :key="t.id"
              class="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-gray-100"
            >
              <template v-if="editingTagId === t.id">
                <div class="flex items-center gap-2 flex-1 min-w-0">
                  <input
                    ref="editTagInput"
                    v-model="editTagName"
                    type="text"
                    maxlength="40"
                    class="flex-1 min-w-0 px-2 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-wa-green"
                    @keydown.enter="saveTagEdit"
                    @keydown.esc="cancelTagEdit"
                  />
                  <select v-model="editTagColor" class="px-2 py-1.5 text-sm border border-gray-300 rounded-lg bg-white">
                    <option v-for="c in TAG_COLORS" :key="c.value" :value="c.value">{{ c.label }}</option>
                  </select>
                  <button
                    @click="saveTagEdit"
                    :disabled="!hasTagEditChanges || tagBusy"
                    class="text-xs px-2 py-1 rounded bg-wa-green text-white hover:bg-green-600 disabled:opacity-50 whitespace-nowrap"
                  >Simpan</button>
                  <button @click="cancelTagEdit" class="text-xs px-2 py-1 rounded bg-gray-100 text-gray-700 hover:bg-gray-200 whitespace-nowrap">Batal</button>
                </div>
              </template>
              <template v-else>
                <div class="flex items-center gap-2 min-w-0">
                  <span :class="['w-2.5 h-2.5 rounded-full flex-shrink-0', tagDotClass(t.color)]"></span>
                  <span class="text-sm font-medium truncate">{{ t.name }}</span>
                  <span class="text-xs text-gray-400 whitespace-nowrap">{{ t.contactCount ?? 0 }} kontak</span>
                </div>
                <div class="flex items-center gap-1.5 flex-shrink-0">
                  <button @click="selectTag(t.id)" class="text-xs px-2 py-1 rounded bg-blue-100 text-blue-700 hover:bg-blue-200">Lihat kontak</button>
                  <!-- v4.1.4 — Edit tag (rename + ganti warna), admin only -->
                  <button v-if="auth.isAdmin" @click="startTagEdit(t)" class="text-xs px-2 py-1 rounded bg-indigo-100 text-indigo-700 hover:bg-indigo-200">Edit</button>
                  <button @click="exportTagCsv(t)" class="text-xs px-2 py-1 rounded bg-gray-100 text-gray-700 hover:bg-gray-200">Export CSV</button>
                  <button @click="deleteTag(t)" class="text-xs px-2 py-1 rounded bg-red-100 text-red-700 hover:bg-red-200">Hapus</button>
                </div>
              </template>
            </div>
          </div>
        </div>
      </div>

      <!-- v0.13.4 — Filter chip tag (SEMUA role): single-select, "Semua" = tanpa filter -->
      <div v-if="tags.length" class="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1">
        <button
          @click="selectTag(null)"
          :class="['px-3 py-1.5 text-xs font-medium rounded-full border whitespace-nowrap flex-shrink-0', selectedTagId === null ? 'bg-wa-dark text-white border-wa-dark' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50']"
        >
          Semua
        </button>
        <button
          v-for="t in tags"
          :key="t.id"
          @click="selectTag(selectedTagId === t.id ? null : t.id)"
          :class="['px-3 py-1.5 text-xs font-medium rounded-full border whitespace-nowrap flex-shrink-0 flex items-center gap-1.5', selectedTagId === t.id ? 'bg-wa-dark text-white border-wa-dark' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50']"
        >
          <span :class="['w-2 h-2 rounded-full flex-shrink-0', tagDotClass(t.color)]"></span>
          {{ t.name }}
          <span :class="['text-[10px] rounded-full px-1.5', selectedTagId === t.id ? 'bg-white/20' : 'bg-gray-100']">{{ t.contactCount ?? 0 }}</span>
        </button>
      </div>

      <!-- Results count -->
      <div class="flex items-center justify-between">
        <p class="text-sm text-gray-600">{{ total }} kontak ditemukan</p>
        <button
          v-if="search"
          @click="clearSearch"
          class="text-xs text-gray-500 hover:text-red-500"
        >
          Clear search
        </button>
      </div>

      <!-- v0.2.3 — mobile: kartu (tanpa scroll samping); desktop: tabel -->
      <div class="md:hidden space-y-2">
        <div v-if="contacts.length === 0" class="bg-white rounded-lg shadow-sm p-8 text-center text-gray-400 text-sm">Belum ada kontak</div>
        <div v-for="contact in contacts" :key="contact.id" class="bg-white rounded-lg shadow-sm p-3">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="text-sm font-medium truncate">{{ contact.name || '—' }}</div>
              <div class="text-xs text-gray-500">{{ contact.phone || '—' }}</div>
              <div class="text-xs text-gray-400 mt-0.5 truncate">
                <span v-if="contact.city">{{ contact.city }} · </span>{{ contact.note || '' }}
              </div>
            </div>
            <div class="flex flex-col items-end gap-1 flex-shrink-0">
              <span :class="['text-[10px] px-2 py-0.5 rounded-full font-medium uppercase', sourceClass(contact.source)]">{{ contact.source }}</span>
              <span v-if="contact.chat" :class="['text-[10px] px-2 py-0.5 rounded-full font-medium', contact.chat.status === 'open' ? 'bg-yellow-100 text-yellow-700' : 'bg-green-100 text-green-700']">{{ contact.chat.status }}</span>
            </div>
          </div>
          <div class="flex items-center gap-2 mt-2">
            <button @click="openEdit(contact)" class="text-xs px-2.5 py-1.5 rounded bg-blue-100 text-blue-700 active:bg-blue-200">Edit</button>
            <button @click="openChat(contact)" class="text-xs px-2.5 py-1.5 rounded bg-green-100 text-green-700 active:bg-green-200">Chat</button>
            <button v-if="auth.isAdmin" @click="confirmDelete(contact)" class="text-xs px-2.5 py-1.5 rounded bg-red-100 text-red-700 active:bg-red-200">Hapus</button>
          </div>
        </div>
      </div>

      <!-- Table (desktop only) -->
      <div class="hidden md:block bg-white rounded-lg shadow-sm overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full">
            <thead class="bg-gray-50 border-b border-gray-200">
              <tr>
                <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Nama</th>
                <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Nomor</th>
                <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Info</th>
                <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Sumber</th>
                <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Chat Aktif</th>
                <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Aksi</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100">
              <tr v-for="contact in contacts" :key="contact.id" class="hover:bg-gray-50">
                <td class="px-4 py-3">
                  <div class="font-medium text-sm">{{ contact.name || '—' }}</div>
                  <div v-if="contact.note" class="text-xs text-gray-500 mt-0.5 truncate max-w-[200px]">{{ contact.note }}</div>
                </td>
                <td class="px-4 py-3 text-sm text-gray-700">
                  {{ contact.phone || '—' }}
                </td>
                <td class="px-4 py-3 text-xs text-gray-600">
                  <div v-if="contact.birthDate || contact.gender">
                    {{ formatGender(contact.gender) }}<span v-if="contact.birthDate">, {{ formatBirthDate(contact.birthDate) }}</span>
                  </div>
                  <div v-if="contact.city" class="text-gray-500">{{ contact.city }}</div>
                </td>
                <td class="px-4 py-3">
                  <span
                    :class="['text-[10px] px-2 py-0.5 rounded-full font-medium uppercase', sourceClass(contact.source)]"
                  >
                    {{ contact.source }}
                  </span>
                </td>
                <td class="px-4 py-3 text-xs">
                  <div v-if="contact.chat">
                    <span :class="['px-2 py-0.5 rounded-full text-[10px] font-medium', contact.chat.status === 'open' ? 'bg-yellow-100 text-yellow-700' : 'bg-green-100 text-green-700']">
                      {{ contact.chat.status }}
                    </span>
                    <div class="text-gray-400 mt-0.5">{{ contact.chat.lastMessageAt ? formatDateTime(contact.chat.lastMessageAt) : 'belum aktif' }}</div>
                  </div>
                  <span v-else class="text-gray-400">—</span>
                </td>
                <td class="px-4 py-3">
                  <div class="flex items-center gap-2">
                    <button
                      @click="openEdit(contact)"
                      class="text-xs px-2 py-1 rounded bg-blue-100 text-blue-700 hover:bg-blue-200"
                    >
                      Edit
                    </button>
                    <button
                      @click="openChat(contact)"
                      class="text-xs px-2 py-1 rounded bg-green-100 text-green-700 hover:bg-green-200"
                    >
                      Chat
                    </button>
                    <button
                      v-if="auth.isAdmin"
                      @click="confirmDelete(contact)"
                      class="text-xs px-2 py-1 rounded bg-red-100 text-red-700 hover:bg-red-200"
                    >
                      Hapus
                    </button>
                  </div>
                </td>
              </tr>
              <tr v-if="contacts.length === 0">
                <td colspan="6" class="px-4 py-8 text-center text-gray-400 text-sm">
                  Belum ada kontak
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Pagination -->
        <div v-if="totalPages > 1" class="px-4 py-3 border-t border-gray-200 flex items-center justify-between">
          <p class="text-xs text-gray-500">Halaman {{ page }} dari {{ totalPages }}</p>
          <div class="flex gap-2">
            <button
              @click="page--; fetchContacts()"
              :disabled="page <= 1"
              class="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40"
            >
              Prev
            </button>
            <button
              @click="page++; fetchContacts()"
              :disabled="page >= totalPages"
              class="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      </div>
      </div>
    </div>

    <!-- Edit / Create Modal -->
    <ContactEditModal
      v-if="showModal"
      :contact="selectedContact"
      @saved="onSaved"
      @close="showModal = false"
      @open-chat="onOpenChat"
    />

    <!-- Import Modal -->
    <div
      v-if="showImportModal"
      class="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <div class="absolute inset-0 bg-black/50" @click="showImportModal = false"></div>
      <div class="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto relative z-10 flex flex-col">
        <div class="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
          <h3 class="font-semibold">Import Kontak dari CSV</h3>
          <button @click="showImportModal = false" class="text-gray-400 hover:text-gray-600">✕</button>
        </div>

        <div class="p-4 space-y-4">
          <!-- Field documentation -->
          <div class="text-xs text-gray-600">
            <p class="font-medium mb-1">Kolom yang didukung:</p>
            <ul class="list-disc list-inside space-y-0.5">
              <li><strong>name</strong> — nama kontak</li>
              <li><strong>phone</strong> — 628xxx / 08xxx / +62xxx</li>
              <li><strong>birth_date</strong> — YYYY-MM-DD (opsional)</li>
              <li><strong>gender</strong> — male/female atau m/f (opsional)</li>
              <li><strong>city</strong> — kota (opsional)</li>
              <li><strong>note</strong> — catatan internal (opsional)</li>
            </ul>
          </div>

          <button
            @click="downloadSampleCsv"
            class="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
          >
            Download Sample CSV
          </button>

          <!-- Drag & drop area -->
          <div
            @dragover.prevent="dragOver = true"
            @dragleave.prevent="dragOver = false"
            @drop.prevent="handleDrop"
            :class="['border-2 border-dashed rounded-lg p-8 text-center transition-colors', dragOver ? 'border-wa-green bg-green-50' : 'border-gray-300 bg-gray-50']"
          >
            <div v-if="!importFile" class="space-y-2">
              <svg class="w-10 h-10 mx-auto text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" />
              </svg>
              <p class="text-sm text-gray-600">Drag & drop file CSV di sini</p>
              <p class="text-xs text-gray-400">atau klik tombol di bawah</p>
            </div>
            <div v-else class="text-sm text-gray-700">
              <span class="font-medium">{{ importFile.name }}</span>
              <button @click="importFile = null" class="ml-2 text-xs text-red-500 hover:underline">Ganti file</button>
            </div>
            <input
              ref="importInput"
              type="file"
              accept=".csv,text/csv"
              class="hidden"
              @change="handleFileSelect"
            />
            <button
              v-if="!importFile"
              @click="importInput?.click()"
              class="mt-3 px-4 py-1.5 text-sm rounded-lg bg-wa-dark text-white hover:bg-gray-800"
            >
              Pilih File
            </button>
          </div>

          <div v-if="importResult" class="text-sm space-y-1">
            <p class="font-medium">Hasil import:</p>
            <div class="grid grid-cols-3 gap-2 text-center">
              <div class="bg-green-50 rounded p-2">
                <div class="text-lg font-semibold text-green-700">{{ importResult.created }}</div>
                <div class="text-[10px] text-gray-500">Baru</div>
              </div>
              <div class="bg-blue-50 rounded p-2">
                <div class="text-lg font-semibold text-blue-700">{{ importResult.updated }}</div>
                <div class="text-[10px] text-gray-500">Diupdate</div>
              </div>
              <div class="bg-gray-50 rounded p-2">
                <div class="text-lg font-semibold text-gray-700">{{ importResult.skipped }}</div>
                <div class="text-[10px] text-gray-500">Dilewati</div>
              </div>
            </div>
            <ul v-if="importResult.errors.length" class="text-xs text-red-600 list-disc list-inside">
              <li v-for="(err, idx) in importResult.errors" :key="idx">Baris {{ err.line }}: {{ err.message }}</li>
            </ul>
          </div>
        </div>

        <div class="p-4 border-t border-gray-200 flex justify-end gap-2">
          <button
            @click="showImportModal = false"
            class="px-4 py-2 text-sm rounded-lg text-gray-600 hover:bg-gray-100"
          >
            Tutup
          </button>
          <button
            @click="runImport"
            :disabled="!importFile || importing"
            class="px-4 py-2 text-sm rounded-lg bg-wa-green text-white hover:bg-green-600 disabled:opacity-50"
          >
            {{ importing ? 'Mengimport...' : 'Import' }}
          </button>
        </div>
      </div>
    </div>
  </PageShell>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import axios from 'axios'
import { useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'
import { useConfirm } from '../utils/confirm'
import { useSocketStore } from '../stores/socket'
import { tagDotClass } from '../utils/format'
import PageShell from '../components/PageShell.vue'
import ContactEditModal from '../components/ContactEditModal.vue'
// v0.14.0 — tab Grup mobile: panel list grup + navigasi detail via Dashboard (?chat=)
import GroupListPanel from './GroupListPanel.vue'
// v4.1.0 — tab Channel mobile (D4b): panel read-only (list + postingan)
import ChannelListPanel from '../components/ChannelListPanel.vue'
import { useRouter } from 'vue-router'

const API = import.meta.env.VITE_API_URL || ''
const auth = useAuthStore()
const toast = useToastStore()
const { confirmAction } = useConfirm()
const socketStore = useSocketStore()

const contacts = ref([])
const total = ref(0)
const page = ref(1)
const search = ref('')
const searchTimer = ref(null)

// v0.14.0 — segmen mobile "Kontak | Grup"; default Kontak (perilaku existing utuh)
const router = useRouter()
const mobileTab = ref('contacts')

function openGroupMobile(group) {
  // Mobile: buka thread grup full-screen via Dashboard existing (pola openChat kontak)
  router.push({ path: '/', query: { chat: group.id } })
}

const showModal = ref(false)
const selectedContact = ref(null)
const showImportModal = ref(false)
const importFile = ref(null)
const importInput = ref(null)
const dragOver = ref(false)
const importing = ref(false)
const importResult = ref(null)

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / 20)))

// ─── v0.13.4 — Tag Manager (chips + panel admin) ───────────────────────
const TAG_COLORS = [
  { value: 'blue', label: 'Biru' },
  { value: 'green', label: 'Hijau' },
  { value: 'red', label: 'Merah' },
  { value: 'yellow', label: 'Kuning' },
  { value: 'purple', label: 'Ungu' },
  { value: 'gray', label: 'Abu-abu' },
]
const tags = ref([])
const selectedTagId = ref(null)
const showTagPanel = ref(false)
const newTagName = ref('')
const newTagColor = ref('blue')
const tagBusy = ref(false)
// v4.1.4 — Edit tag (rename + ganti warna): mode edit inline per-row, admin only
const editingTagId = ref(null)
const editTagName = ref('')
const editTagColor = ref('blue')
const editTagInput = ref(null)
const hasTagEditChanges = computed(() => {
  const t = tags.value.find((x) => x.id === editingTagId.value)
  if (!t) return false
  return editTagName.value.trim() !== t.name || editTagColor.value !== t.color
})

async function fetchTags() {
  try {
    const res = await axios.get(`${API}/api/tags`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    tags.value = res.data.tags
    // Tag terfilter hilang (dihapus) → reset filter
    if (selectedTagId.value !== null && !tags.value.find((t) => t.id === selectedTagId.value)) {
      selectedTagId.value = null
      fetchContacts()
    }
  } catch (e) {
    console.error('Fetch tags error:', e)
  }
}

function selectTag(tagId) {
  selectedTagId.value = tagId
  page.value = 1
  fetchContacts()
}

async function createTag() {
  const name = newTagName.value.trim()
  if (!name || tagBusy.value) return
  tagBusy.value = true
  try {
    await axios.post(`${API}/api/tags`, { name: name.trim(), color: newTagColor.value }, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    newTagName.value = ''
    newTagColor.value = 'blue'
    // tags_changed broadcast → fetchTags (dedup di listener)
    await fetchTags()
  } catch (e) {
    if (e.response?.status === 409) {
      toast.show({ icon: '⚠️', title: 'Tag sudah ada', message: 'Nama tag tersebut sudah dipakai' })
    } else {
      console.error('Create tag error:', e)
      toast.show({ icon: '⚠️', title: 'Gagal membuat tag', message: e.response?.data?.error || e.message })
    }
  } finally {
    tagBusy.value = false
  }
}

// v4.1.4 — Edit tag: mulai mode edit (prefill nama+warna) → form inline
function startTagEdit(t) {
  editingTagId.value = t.id
  editTagName.value = t.name
  editTagColor.value = t.color
  // autofocus input nama (row re-render — tunggu nextTick)
  nextTick(() => {
    const el = Array.isArray(editTagInput.value) ? editTagInput.value[0] : editTagInput.value
    if (el) el.focus()
  })
}

function cancelTagEdit() {
  editingTagId.value = null
  editTagName.value = ''
  editTagColor.value = 'blue'
}

async function saveTagEdit() {
  const id = editingTagId.value
  if (id === null || tagBusy.value) return
  const name = editTagName.value.trim()
  if (!name) return
  // guard: tanpa perubahan → tidak ada PUT (tombol Simpan juga disabled)
  const t = tags.value.find((x) => x.id === id)
  if (t && name === t.name && editTagColor.value === t.color) return
  tagBusy.value = true
  try {
    const res = await axios.put(`${API}/api/tags/${id}`, { name, color: editTagColor.value }, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    // Update in-place (array tags) — tanpa nunggu refetch
    const idx = tags.value.findIndex((x) => x.id === id)
    if (idx !== -1) tags.value[idx] = { ...tags.value[idx], name: res.data.tag.name, color: res.data.tag.color, contactCount: res.data.tag.contactCount ?? tags.value[idx].contactCount }
    toast.show({ icon: '✅', title: 'Tag diperbarui', message: `Tag "${res.data.tag.name}" sudah disimpan` })
    editingTagId.value = null
  } catch (e) {
    if (e.response?.status === 409) {
      // Dup name → TETAP di mode edit biar user bisa ganti nama
      toast.show({ icon: '⚠️', title: 'Nama tag sudah dipakai', message: 'Pakai nama lain untuk tag ini' })
    } else {
      console.error('Update tag error:', e)
      toast.show({ icon: '⚠️', title: 'Gagal memperbarui tag', message: e.response?.data?.error || e.message })
      editingTagId.value = null
    }
  } finally {
    tagBusy.value = false
  }
}

async function deleteTag(t) {
  // v0.13.4 — konfirmasi M3 dialog (BUKAN native confirm)
  const ok = await confirmAction({
    title: 'Hapus tag?',
    message: `Hapus tag "${t.name}"? Tag akan dilepas dari ${t.contactCount ?? 0} kontak dan semua chat yang memakainya.`,
    confirmText: 'Hapus',
    danger: true,
  })
  if (!ok) return
  try {
    await axios.delete(`${API}/api/tags/${t.id}`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    toast.show({ icon: '🗑️', title: 'Tag dihapus', message: `Tag "${t.name}" sudah dihapus` })
    // tag_deleted broadcast → fetchTags + filter reset kalau tag tsb aktif
    await fetchTags()
  } catch (e) {
    console.error('Delete tag error:', e)
    toast.show({ icon: '⚠️', title: 'Gagal menghapus tag', message: e.response?.data?.error || e.message })
  }
}

async function exportTagCsv(t) {
  try {
    const res = await axios.get(`${API}/api/contacts/export`, {
      params: { tagId: t.id },
      headers: { Authorization: `Bearer ${auth.token}` },
      responseType: 'blob',
    })
    const blob = new Blob([res.data], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `contacts-tag-${t.name.replace(/[^a-zA-Z0-9-_]/g, '_')}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  } catch (e) {
    console.error('Export tag CSV error:', e)
    toast.show({ icon: '⚠️', title: 'Gagal export', message: e.response?.data?.error || e.message })
  }
}

// v0.13.4 — realtime sync: tag dibuat/dihapus di tempat lain (Menu Gateway,
// chat detail) → chips refresh. tags_changed khusus contactCount refresh.
function onTagsChanged() {
  fetchTags()
}
function onTagCreated() {
  fetchTags()
}
function onTagDeleted() {
  fetchTags()
}

function handleLogout() {
  auth.logout()
  window.location.href = '/login'
}

function formatGender(gender) {
  if (!gender) return ''
  return gender === 'male' ? 'Laki-laki' : 'Perempuan'
}

function formatBirthDate(value) {
  if (!value) return ''
  return new Date(value).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })
}

function formatDateTime(value) {
  if (!value) return ''
  return new Date(value).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function sourceClass(source) {
  switch (source) {
    case 'chat': return 'bg-purple-100 text-purple-700'
    case 'import': return 'bg-blue-100 text-blue-700'
    case 'manual': return 'bg-green-100 text-green-700'
    default: return 'bg-gray-100 text-gray-700'
  }
}

async function fetchContacts() {
  try {
    const params = { page: page.value }
    if (search.value.trim()) params.q = search.value.trim()
    // v0.13.4 — filter by tag (via ContactTag, server-side)
    if (selectedTagId.value !== null) params.tagId = selectedTagId.value
    const res = await axios.get(`${API}/api/contacts`, {
      params,
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    contacts.value = res.data.contacts
    total.value = res.data.total
  } catch (e) {
    console.error('Fetch contacts error:', e)
  }
}

function onSearch() {
  clearTimeout(searchTimer.value)
  page.value = 1
  searchTimer.value = setTimeout(fetchContacts, 250)
}

function clearSearch() {
  search.value = ''
  page.value = 1
  fetchContacts()
}

function openCreate() {
  selectedContact.value = null
  showModal.value = true
}

function openEdit(contact) {
  selectedContact.value = contact
  showModal.value = true
}

function onSaved() {
  showModal.value = false
  fetchContacts()
}

function onOpenChat(contact) {
  showModal.value = false
  openChat(contact)
}

async function openChat(contact) {
  try {
    const res = await axios.post(`${API}/api/contacts/${contact.id}/open`, {}, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    // Navigate to dashboard with ?chat= query
    window.location.href = `/?chat=${encodeURIComponent(res.data.chat.id)}`
  } catch (e) {
    console.error('Open chat error:', e)
    toast.show({ icon: '⚠️', title: 'Gagal membuka chat', message: e.response?.data?.error || e.message })
  }
}

async function confirmDelete(contact) {
  // v0.9.0 — confirm() native → M3 dialog; handler delete TIDAK berubah
  const ok = await confirmAction({
    title: 'Hapus kontak?',
    message: `Hapus kontak "${contact.name || contact.phone || contact.id}"?`,
    confirmText: 'Hapus',
    danger: true,
  })
  if (!ok) return
  try {
    await axios.delete(`${API}/api/contacts/${contact.id}`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    fetchContacts()
  } catch (e) {
    console.error('Delete contact error:', e)
    toast.show({ icon: '⚠️', title: 'Gagal menghapus', message: e.response?.data?.error || e.message })
  }
}

function downloadSampleCsv() {
  const sample = `name,phone,birth_date,gender,city,note
Andi Wijaya,6281234567890,1990-05-21,male,Surabaya,Pelanggan setia
Siti Aminah,6281987654321,1995-12-10,female,Jakarta,Follow up minggu depan
Budi Santoso,6281122334455,,male,Bandung,
Dewi Lestari,6282233445566,,,Malang,Leads dari Instagram`
  const blob = new Blob([sample], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'sample-contacts.csv'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function handleFileSelect(event) {
  const file = event.target.files?.[0]
  if (!file) return
  if (!file.name.toLowerCase().endsWith('.csv')) {
    toast.show({ icon: '⚠️', title: 'Format salah', message: 'File harus berformat CSV' })
    return
  }
  importFile.value = file
  importResult.value = null
}

function handleDrop(event) {
  dragOver.value = false
  const file = event.dataTransfer.files?.[0]
  if (!file) return
  if (!file.name.toLowerCase().endsWith('.csv')) {
    toast.show({ icon: '⚠️', title: 'Format salah', message: 'File harus berformat CSV' })
    return
  }
  importFile.value = file
  importResult.value = null
}

async function runImport() {
  if (!importFile.value) return
  importing.value = true
  importResult.value = null
  try {
    const formData = new FormData()
    formData.append('file', importFile.value)
    const res = await axios.post(`${API}/api/contacts/import`, formData, {
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'multipart/form-data',
      },
    })
    importResult.value = res.data
    fetchContacts()
  } catch (e) {
    console.error('Import error:', e)
    toast.show({ icon: '⚠️', title: 'Gagal import', message: e.response?.data?.error || e.message })
  } finally {
    importing.value = false
  }
}

async function exportContacts() {
  try {
    const res = await axios.get(`${API}/api/contacts/export`, {
      headers: { Authorization: `Bearer ${auth.token}` },
      responseType: 'blob',
    })
    const blob = new Blob([res.data], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `contacts-${new Date().toISOString().split('T')[0]}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  } catch (e) {
    console.error('Export error:', e)
    toast.show({ icon: '⚠️', title: 'Gagal export', message: e.response?.data?.error || e.message })
  }
}

watch(showImportModal, (val) => {
  if (!val) {
    importFile.value = null
    importResult.value = null
    dragOver.value = false
  }
})

onMounted(() => {
  fetchContacts()
  fetchTags()
  socketStore.on('tags_changed', onTagsChanged)
  socketStore.on('tag_created', onTagCreated)
  socketStore.on('tag_deleted', onTagDeleted)
})
onUnmounted(() => {
  socketStore.off('tags_changed', onTagsChanged)
  socketStore.off('tag_created', onTagCreated)
  socketStore.off('tag_deleted', onTagDeleted)
})
</script>
