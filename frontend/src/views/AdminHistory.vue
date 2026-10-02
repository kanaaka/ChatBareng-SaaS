<template>
  <PageShell title="Backup & Restore" back-to="/admin">
    <header class="hidden md:flex m3-topbar px-4 py-3 items-center justify-between">
      <div class="flex items-center gap-3">
        <h1 class="text-lg font-semibold">Backup &amp; Restore</h1>
      </div>
      <div class="flex items-center gap-4">
        <button @click="handleLogout" class="text-sm hover:underline">Logout</button>
      </div>
    </header>

    <div class="max-w-4xl mx-auto w-full p-6 space-y-4">
      <!-- Export -->
      <div class="bg-white rounded-lg shadow-sm p-6">
        <h2 class="text-lg font-semibold mb-1">Backup (Export)</h2>
        <p class="text-sm text-gray-500 mb-4">
          Download semua history chat (metadata + isi pesan + kontak + tag) sebagai satu file JSON.
        </p>
        <p class="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">
          ⚠️ File backup <strong>tidak menyertakan file media</strong> (gambar/dokumen) — hanya metadata &amp; teks. File media tetap ada di server (<code>data/media/</code>).
        </p>
        <!-- v0.6.1 — pilih rentang waktu backup -->
        <div class="flex flex-wrap items-center gap-2 mb-3">
          <span class="text-sm text-gray-600">Rentang:</span>
          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="opt in rangeOptions"
              :key="opt.key"
              type="button"
              @click="exportRange.key = opt.key"
              :class="['px-3 py-1.5 text-xs rounded-lg border transition-colors', exportRange.key === opt.key ? 'bg-wa-dark text-white border-wa-dark' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50']"
            >
              {{ opt.label }}
            </button>
          </div>
        </div>
        <div v-if="exportRange.key === 'custom'" class="flex flex-wrap items-center gap-2 mb-3">
          <input v-model="exportRange.from" type="date" class="px-3 py-1.5 text-sm border border-gray-300 rounded-lg" />
          <span class="text-xs text-gray-400">s/d</span>
          <input v-model="exportRange.to" type="date" class="px-3 py-1.5 text-sm border border-gray-300 rounded-lg" />
          <span class="text-xs text-gray-400">berdasarkan aktivitas terakhir tiap chat</span>
        </div>
        <button
          @click="downloadBackup"
          :disabled="exporting"
          class="px-4 py-2 bg-wa-dark text-white rounded-lg text-sm hover:bg-green-700 disabled:opacity-50"
        >
          {{ exporting ? 'Menyiapkan…' : '⬇️ Download Backup (JSON)' }}
        </button>
        <div v-if="exportError" class="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {{ exportError }}
        </div>
      </div>

      <!-- Import -->
      <div class="bg-white rounded-lg shadow-sm p-6">
        <h2 class="text-lg font-semibold mb-1">Restore (Import)</h2>
        <p class="text-sm text-gray-500 mb-4">
          Import file backup. Sifatnya <strong>APPEND</strong> — pesan yang sudah ada tidak diduplikasi, tidak ada data yang dihapus/ditimpa.
        </p>

        <div class="space-y-3">
          <div>
            <label class="block text-sm font-medium mb-1">File backup (.json)</label>
            <input
              ref="fileInput"
              type="file"
              accept=".json,application/json"
              @change="onFileChange"
              class="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border-0 file:bg-gray-100 file:text-sm"
            />
          </div>

          <div class="flex flex-wrap gap-2">
            <button
              @click="checkFile"
              :disabled="!file || checking || importing"
              class="px-4 py-2 bg-gray-700 text-white rounded-lg text-sm hover:bg-gray-800 disabled:opacity-50"
            >
              {{ checking ? 'Memeriksa…' : '🔍 Periksa (Preview)' }}
            </button>
            <button
              @click="importNow"
              :disabled="!preview || importing || checking"
              class="px-4 py-2 bg-red-600 text-white rounded-lg text-sm hover:bg-red-700 disabled:opacity-50"
            >
              {{ importing ? 'Mengimpor…' : '📥 Import Sekarang' }}
            </button>
          </div>

          <!-- Preview (dry-run) -->
          <div v-if="preview" class="p-4 bg-gray-50 rounded-lg text-sm">
            <div class="font-semibold mb-2">
              Hasil pemeriksaan <span v-if="preview.dryRun" class="text-xs font-normal text-gray-400">(preview — belum ada data ditulis)</span>
            </div>
            <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mb-2">
              <div class="bg-white rounded-lg border p-2 text-center">
                <div class="text-lg font-bold text-green-700">{{ preview.chatsCreated }}</div>
                <div class="text-xs text-gray-500">chat baru</div>
              </div>
              <div class="bg-white rounded-lg border p-2 text-center">
                <div class="text-lg font-bold text-blue-700">{{ preview.chatsMerged }}</div>
                <div class="text-xs text-gray-500">chat merge</div>
              </div>
              <div class="bg-white rounded-lg border p-2 text-center">
                <div class="text-lg font-bold">{{ preview.messagesAdded }}</div>
                <div class="text-xs text-gray-500">pesan baru</div>
              </div>
              <div class="bg-white rounded-lg border p-2 text-center">
                <div class="text-lg font-bold text-gray-500">{{ preview.messagesSkipped }}</div>
                <div class="text-xs text-gray-500">pesan skip (duplikat)</div>
              </div>
              <div class="bg-white rounded-lg border p-2 text-center">
                <div class="text-lg font-bold">{{ preview.contactsUpdated }}</div>
                <div class="text-xs text-gray-500">kontak terisi</div>
              </div>
              <div class="bg-white rounded-lg border p-2 text-center">
                <div class="text-lg font-bold text-amber-700">{{ preview.chatsRestoredState || 0 }}</div>
                <div class="text-xs text-gray-500">chat balik ke state asli</div>
              </div>
            </div>
            <div v-if="preview.errors && preview.errors.length" class="text-xs text-red-700">
              {{ preview.errors.length }} error terdeteksi (lihat detail setelah import).
            </div>
            <div v-if="preview.chatsCreated === 0 && preview.messagesAdded === 0 && !(preview.errors && preview.errors.length)" class="text-xs text-gray-500">
              Tidak ada data baru untuk ditambahkan — semua sudah ada di sistem.
            </div>
          </div>

          <!-- Hasil import -->
          <div v-if="importResult" class="p-4 bg-green-50 border border-green-200 rounded-lg text-sm">
            <div class="font-semibold mb-2 text-green-800">✅ Import selesai</div>
            <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 mb-2">
              <div class="bg-white rounded-lg border p-2 text-center">
                <div class="text-lg font-bold text-green-700">{{ importResult.chatsCreated }}</div>
                <div class="text-xs text-gray-500">chat dibuat</div>
              </div>
              <div class="bg-white rounded-lg border p-2 text-center">
                <div class="text-lg font-bold text-blue-700">{{ importResult.chatsMerged }}</div>
                <div class="text-xs text-gray-500">chat merge</div>
              </div>
              <div class="bg-white rounded-lg border p-2 text-center">
                <div class="text-lg font-bold">{{ importResult.messagesAdded }}</div>
                <div class="text-xs text-gray-500">pesan ditambahkan</div>
              </div>
              <div class="bg-white rounded-lg border p-2 text-center">
                <div class="text-lg font-bold text-gray-500">{{ importResult.messagesSkipped }}</div>
                <div class="text-xs text-gray-500">pesan skip (duplikat)</div>
              </div>
              <div class="bg-white rounded-lg border p-2 text-center">
                <div class="text-lg font-bold text-amber-700">{{ importResult.chatsRestoredState || 0 }}</div>
                <div class="text-xs text-gray-500">chat balik ke state asli</div>
              </div>
            </div>
            <div class="text-xs text-gray-600">Kontak diperbarui: {{ importResult.contactsUpdated }}</div>
            <div v-if="importResult.errors && importResult.errors.length" class="mt-3">
              <div class="text-xs font-semibold text-red-700 mb-1">Error ({{ importResult.errors.length }}):</div>
              <ul class="text-xs text-red-700 list-disc list-inside space-y-0.5">
                <li v-for="(e, i) in importResult.errors.slice(0, 10)" :key="i">
                  <span class="font-mono">{{ e.chatId || '?' }}</span> — {{ e.error }}
                </li>
                <li v-if="importResult.errors.length > 10" class="text-gray-500">
                  …dan {{ importResult.errors.length - 10 }} lainnya
                </li>
              </ul>
            </div>
          </div>

          <!-- Error import -->
          <div v-if="importError" class="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {{ importError }}
          </div>
        </div>
      </div>

      <!-- v0.15.0 — Import dari Cekat.AI -->
      <div class="bg-white rounded-lg shadow-sm p-6">
        <h2 class="text-lg font-semibold mb-1">📥 Import dari Cekat.AI</h2>
        <p class="text-sm text-gray-500 mb-4">
          Upload CSV export conversations dari Cekat.AI. Hanya channel WhatsApp yang diimport (TikTok/IG di-skip).
          Chat masuk sebagai arsip resolved dan otomatis diberi tag "Import CekatAI" + label/pipeline aslinya.
          Upload ulang file yang sama aman (anti-dobel).
        </p>

        <div class="space-y-3">
          <div>
            <label class="block text-sm font-medium mb-1">File CSV Cekat.AI (.csv)</label>
            <input
              ref="cekatFileInput"
              type="file"
              accept=".csv,text/csv"
              @change="onCekatFileChange"
              class="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border-0 file:bg-gray-100 file:text-sm"
            />
          </div>

          <div class="flex flex-wrap gap-2">
            <button
              @click="cekatPreviewRun"
              :disabled="!cekatFile || cekatChecking || cekatImporting"
              class="px-4 py-2 bg-gray-700 text-white rounded-lg text-sm hover:bg-gray-800 disabled:opacity-50"
            >
              {{ cekatChecking ? 'Memeriksa…' : '🔍 Preview (Dry Run)' }}
            </button>
            <button
              @click="cekatImportNow"
              :disabled="!cekatFile || cekatImporting || cekatChecking"
              class="px-4 py-2 bg-red-600 text-white rounded-lg text-sm hover:bg-red-700 disabled:opacity-50"
            >
              {{ cekatImporting ? 'Mengimpor…' : '📥 Import Sekarang' }}
            </button>
          </div>

          <!-- Preview (dry-run) -->
          <div v-if="cekatPreview" class="p-4 bg-gray-50 rounded-lg text-sm">
            <div class="font-semibold mb-2">
              Hasil preview <span class="text-xs font-normal text-gray-400">(dry run — belum ada data ditulis)</span>
            </div>
            <div class="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 mb-2">
              <div class="bg-white rounded-lg border p-2 text-center">
                <div class="text-lg font-bold text-green-700">{{ cekatPreview.chatsCreated }}</div>
                <div class="text-xs text-gray-500">chat baru</div>
              </div>
              <div class="bg-white rounded-lg border p-2 text-center">
                <div class="text-lg font-bold text-blue-700">{{ cekatPreview.chatsMerged }}</div>
                <div class="text-xs text-gray-500">chat merge</div>
              </div>
              <div class="bg-white rounded-lg border p-2 text-center">
                <div class="text-lg font-bold">{{ cekatPreview.messagesAdded }}</div>
                <div class="text-xs text-gray-500">pesan baru</div>
              </div>
              <div class="bg-white rounded-lg border p-2 text-center">
                <div class="text-lg font-bold text-gray-500">{{ cekatPreview.messagesSkipped }}</div>
                <div class="text-xs text-gray-500">pesan skip</div>
              </div>
              <div class="bg-white rounded-lg border p-2 text-center">
                <div class="text-lg font-bold">{{ cekatPreview.contactsUpdated }}</div>
                <div class="text-xs text-gray-500">kontak</div>
              </div>
              <div class="bg-white rounded-lg border p-2 text-center">
                <div class="text-lg font-bold">{{ cekatPreview.rowsTotal ?? 0 }}</div>
                <div class="text-xs text-gray-500">baris CSV</div>
              </div>
              <div class="bg-white rounded-lg border p-2 text-center">
                <div class="text-lg font-bold text-amber-700">{{ (cekatPreview.rowsSkipped?.nonWhatsApp || 0) + (cekatPreview.rowsSkipped?.noPhone || 0) }}</div>
                <div class="text-xs text-gray-500">baris skip</div>
              </div>
            </div>
            <div v-if="cekatPreview.rowsSkipped" class="text-xs text-gray-600 mb-2">
              Baris di-skip: {{ cekatPreview.rowsSkipped.nonWhatsApp || 0 }} non-WhatsApp (TikTok/IG), {{ cekatPreview.rowsSkipped.noPhone || 0 }} tanpa nomor.
            </div>
            <div v-if="cekatPreview.errors && cekatPreview.errors.length" class="text-xs text-red-700">
              {{ cekatPreview.errors.length }} error terdeteksi (lihat detail setelah import).
            </div>
            <div v-if="cekatPreview.chatsCreated === 0 && cekatPreview.messagesAdded === 0 && !(cekatPreview.errors && cekatPreview.errors.length)" class="text-xs text-gray-500">
              Tidak ada data baru untuk ditambahkan — semua sudah ada di sistem (upload ulang file yang sama aman).
            </div>
          </div>

          <!-- Hasil import Cekat -->
          <div v-if="cekatResult" class="p-4 bg-green-50 border border-green-200 rounded-lg text-sm">
            <div class="font-semibold mb-2 text-green-800">✅ Import dari Cekat.AI selesai</div>
            <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 mb-2">
              <div class="bg-white rounded-lg border p-2 text-center">
                <div class="text-lg font-bold text-green-700">{{ cekatResult.chatsCreated }}</div>
                <div class="text-xs text-gray-500">chat dibuat</div>
              </div>
              <div class="bg-white rounded-lg border p-2 text-center">
                <div class="text-lg font-bold text-blue-700">{{ cekatResult.chatsMerged }}</div>
                <div class="text-xs text-gray-500">chat merge</div>
              </div>
              <div class="bg-white rounded-lg border p-2 text-center">
                <div class="text-lg font-bold">{{ cekatResult.messagesAdded }}</div>
                <div class="text-xs text-gray-500">pesan ditambahkan</div>
              </div>
              <div class="bg-white rounded-lg border p-2 text-center">
                <div class="text-lg font-bold text-gray-500">{{ cekatResult.messagesSkipped }}</div>
                <div class="text-xs text-gray-500">pesan skip (duplikat)</div>
              </div>
              <div class="bg-white rounded-lg border p-2 text-center">
                <div class="text-lg font-bold">{{ cekatResult.contactsUpdated }}</div>
                <div class="text-xs text-gray-500">kontak terisi</div>
              </div>
            </div>
            <div class="text-xs text-gray-600">
              Baris CSV: {{ cekatResult.rowsTotal ?? 0 }} · di-skip: {{ (cekatResult.rowsSkipped?.nonWhatsApp || 0) }} non-WhatsApp + {{ cekatResult.rowsSkipped?.noPhone || 0 }} tanpa nomor
              <template v-if="cekatResult.contactTagsLinked != null">· kontak di-tag "Import CekatAI": {{ cekatResult.contactTagsLinked }}</template>
            </div>
            <div v-if="cekatResult.errors && cekatResult.errors.length" class="mt-3">
              <div class="text-xs font-semibold text-red-700 mb-1">Error ({{ cekatResult.errors.length }}):</div>
              <ul class="text-xs text-red-700 list-disc list-inside space-y-0.5">
                <li v-for="(e, i) in cekatResult.errors.slice(0, 10)" :key="i">
                  <span class="font-mono">{{ e.chatId || '?' }}</span> — {{ e.error }}
                </li>
                <li v-if="cekatResult.errors.length > 10" class="text-gray-500">
                  …dan {{ cekatResult.errors.length - 10 }} lainnya
                </li>
              </ul>
            </div>
          </div>

          <!-- Error import Cekat -->
          <div v-if="cekatError" class="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {{ cekatError }}
          </div>
        </div>
      </div>
    </div>
  </PageShell>
</template>

<script setup>
import { ref } from 'vue'
import axios from 'axios'
import PageShell from '../components/PageShell.vue'
import { useAuthStore } from '../stores/auth'
import { useSocketStore } from '../stores/socket'
import { useConfirm } from '../utils/confirm'

const API = import.meta.env.VITE_API_URL || ''
const auth = useAuthStore()
const socketStore = useSocketStore()
const { confirmAction } = useConfirm()

// Export
const exporting = ref(false)
const exportError = ref('')

// v0.6.1 — rentang waktu export (urutan sesuai request Kanaka)
const rangeOptions = [
  { key: '30d', label: '30 Hari' },
  { key: '7d', label: '7 Hari' },
  { key: '3d', label: '3 Hari' },
  { key: 'custom', label: 'Custom' },
  { key: 'all', label: 'All' },
]
const exportRange = ref({ key: 'all', from: '', to: '' })

async function downloadBackup() {
  exporting.value = true
  exportError.value = ''
  try {
    const params = new URLSearchParams()
    params.set('range', exportRange.value.key)
    if (exportRange.value.key === 'custom') {
      if (exportRange.value.from) params.set('from', exportRange.value.from)
      if (exportRange.value.to) params.set('to', exportRange.value.to)
    }
    const res = await axios.get(`${API}/api/history/export?${params.toString()}`, { responseType: 'blob' })
    // Ambil filename dari Content-Disposition, fallback default
    let filename = 'wa-cs-hub-history.json'
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
    exportError.value = e.response?.data?.error || 'Gagal mengunduh backup'
  } finally {
    exporting.value = false
  }
}

// Import
const fileInput = ref(null)
const file = ref(null)
const checking = ref(false)
const importing = ref(false)
const preview = ref(null)
const importResult = ref(null)
const importError = ref('')

function onFileChange(ev) {
  file.value = ev.target.files?.[0] || null
  preview.value = null
  importResult.value = null
  importError.value = ''
}

async function checkFile() {
  if (!file.value) return
  checking.value = true
  preview.value = null
  importResult.value = null
  importError.value = ''
  try {
    const fd = new FormData()
    fd.append('file', file.value)
    const res = await axios.post(`${API}/api/history/import?dryRun=true`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    preview.value = res.data
  } catch (e) {
    importError.value = e.response?.data?.error || 'Gagal memeriksa file'
  } finally {
    checking.value = false
  }
}

async function importNow() {
  if (!file.value || !preview.value) return
  // v0.9.0 — confirm() native → M3 dialog; handler import TIDAK berubah
  const ok = await confirmAction({
    title: 'Lanjutkan import?',
    message:
      'Import bersifat APPEND — tidak ada data yang dihapus/ditimpa.\n' +
      `Chat baru: ${preview.value.chatsCreated} · Pesan baru: ${preview.value.messagesAdded}\n\nLanjutkan?`,
    confirmText: 'Import',
  })
  if (!ok) return
  importing.value = true
  importError.value = ''
  importResult.value = null
  try {
    const fd = new FormData()
    fd.append('file', file.value)
    const res = await axios.post(`${API}/api/history/import`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    importResult.value = res.data
    preview.value = null
  } catch (e) {
    importError.value = e.response?.data?.error || 'Import gagal'
  } finally {
    importing.value = false
  }
}

function handleLogout() {
  auth.logout()
  window.location.href = '/login'
}

// ─── v0.15.0 — Import dari Cekat.AI ─────────────────────────────────────
// CSV export Cekat.AI → auto-convert (server) → engine import yang sama.
// Preview = ?dryRun=true; Import = konfirmasi dulu, lalu tanpa dryRun.
const cekatFileInput = ref(null)
const cekatFile = ref(null)
const cekatChecking = ref(false)
const cekatImporting = ref(false)
const cekatPreview = ref(null)
const cekatResult = ref(null)
const cekatError = ref('')

function onCekatFileChange(ev) {
  cekatFile.value = ev.target.files?.[0] || null
  cekatPreview.value = null
  cekatResult.value = null
  cekatError.value = ''
}

async function cekatPreviewRun() {
  if (!cekatFile.value) return
  cekatChecking.value = true
  cekatPreview.value = null
  cekatResult.value = null
  cekatError.value = ''
  try {
    const fd = new FormData()
    fd.append('file', cekatFile.value)
    const res = await axios.post(`${API}/api/cekat-import?dryRun=true`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    cekatPreview.value = res.data
  } catch (e) {
    cekatError.value = e.response?.data?.error || 'Gagal memeriksa file CSV'
  } finally {
    cekatChecking.value = false
  }
}

async function cekatImportNow() {
  if (!cekatFile.value) return
  const ok = await confirmAction({
    title: 'Import dari Cekat.AI?',
    message:
      'Import bersifat APPEND — tidak ada data yang dihapus/ditimpa.\n' +
      'Chat masuk sebagai arsip resolved + tag "Import CekatAI".\n' +
      'Upload ulang file yang sama aman (anti-dobel).\n\nLanjutkan?',
    confirmText: 'Import',
  })
  if (!ok) return
  cekatImporting.value = true
  cekatError.value = ''
  cekatResult.value = null
  try {
    const fd = new FormData()
    fd.append('file', cekatFile.value)
    const res = await axios.post(`${API}/api/cekat-import`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    cekatResult.value = res.data
    cekatPreview.value = null
  } catch (e) {
    cekatError.value = e.response?.data?.error || 'Import gagal'
  } finally {
    cekatImporting.value = false
  }
}
</script>
