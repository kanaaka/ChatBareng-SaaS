<template>
  <!--
    v4.0.0 — Admin "🤖 ChatBareng AI" (CB-AI Knowledge, pola AdminMenuGateway).
    Kartu Status/Config (cbaiLimit slider + toggle footer + hint biaya) · Tabel dokumen
    (label, badge File/Composer, charCount, toggle aktif, updatedAt sortable) · Upload
    modal (label wajib + info PDF) · Composer modal (edit inline) · Preview parse drawer
    (+ warning truncate) · 🧪 Trial chatbox (badge "tercakup/tidak dari KB"). TANPA v-html.
  -->
  <PageShell title="ChatBareng AI" back-to="/admin">
    <header class="hidden md:flex m3-topbar px-4 py-3 items-center justify-between">
      <div class="flex items-center gap-3">
        <h1 class="text-lg font-semibold">ChatBareng AI</h1>
      </div>
      <div class="flex items-center gap-4">
        <button @click="handleLogout" class="text-sm hover:underline">Logout</button>
      </div>
    </header>

    <div class="max-w-4xl mx-auto w-full p-6 space-y-4">
      <!-- v4.0.1 hotfix — plan ✗ → upsell ramah -->
      <div v-if="!planOk" class="m3-card p-6">
        <p class="text-sm text-gray-800">🔒 ChatBareng AI belum tersedia di paket kamu — hubungi admin platform untuk upgrade.</p>
        <p class="text-xs text-gray-500 mt-2">Setelah fitur diaktifkan, di sini kamu bisa "mengajarkan" AI: upload dokumen (pricelist, jam buka, alamat, layanan) dan AI menjawab pertanyaan customer HANYA dari dokumen itu — tidak bisa dijawab → fallback teks + chat masuk antrean CS.</p>
      </div>
      <!-- Kartu Pengaturan CB-AI -->
      <div v-if="planOk" class="m3-card p-6">
        <h2 class="font-semibold text-gray-900">Pengaturan CB-AI</h2>
        <p class="text-xs text-gray-500 mt-1">
          AI menjawab pertanyaan customer HANYA dari dokumen yang kamu ajarkan di bawah (closed-book).
          Tidak bisa dijawab → balasan teks fallback tetap terkirim + chat masuk antrean CS.
        </p>

        <div class="mt-4">
          <span class="text-xs text-gray-600 block mb-1">Limit balasan AI per chat (jendela 24 jam)</span>
          <div class="flex items-center gap-3">
            <input
              v-model.number="config.cbaiLimit"
              type="range"
              min="1"
              max="10"
              step="1"
              :disabled="saving"
              class="flex-1 min-w-[180px] accent-green-600"
            />
            <span class="text-sm font-semibold text-gray-800 tabular-nums w-8 text-center">{{ config.cbaiLimit }}</span>
          </div>
          <p class="text-xs text-gray-500 mt-1">
            Setelah {{ config.cbaiLimit }} balasan AI, chat diam sampai 24 jam sejak balasan AI terakhir —
            lalu budget segar. Human (CS) yang balas tidak mereset hitungan.
          </p>
        </div>

        <label class="flex items-center justify-between mt-4 cursor-pointer">
          <div>
            <span class="text-sm text-gray-800">Footer "info per tanggal"</span>
            <p class="text-xs text-gray-500">Tambahkan catatan tanggal pembaruan dokumen di akhir jawaban AI</p>
          </div>
          <M3Switch v-model="config.cbaiInfoFooter" :disabled="saving" />
        </label>

        <div class="flex justify-end mt-4">
          <button @click="saveConfig" :disabled="saving" class="m3-btn m3-btn--tonal text-sm">
            {{ saving ? 'Menyimpan...' : 'Simpan pengaturan' }}
          </button>
        </div>
        <p v-if="aiUsage" class="text-xs text-gray-400 mt-2">
          ≈ Rp {{ (aiUsage.costRp || 0).toLocaleString('id-ID') }} bulan ini ({{ aiUsage.calls || 0 }} call AI) — metering otomatis.
        </p>
      </div>

      <!-- Tabel dokumen -->
      <div v-if="planOk" class="m3-card p-6">
        <div class="flex items-center justify-between mb-1">
          <h2 class="font-semibold text-gray-900">Dokumen Knowledge ({{ docs.length }})</h2>
          <div class="flex items-center gap-2">
            <button @click="openUpload" class="m3-btn m3-btn--tonal !min-h-[36px] !px-3 text-xs">⬆ Upload file</button>
            <button @click="openCompose" class="m3-btn m3-btn--tonal !min-h-[36px] !px-3 text-xs">✍ Tulis manual</button>
          </div>
        </div>
        <p class="text-xs text-gray-500 mb-3">
          Format: txt, md, csv, docx, xlsx (maks 5 MB). PDF scan butuh OCR — pakai txt/docx/copy-paste dulu.
          Re-upload dengan label sama = mengganti isi dokumen.
        </p>

        <div v-if="docs.length === 0" class="text-sm text-gray-400 py-6 text-center">
          Belum ada dokumen — upload file atau tulis manual dulu.
        </div>
        <div v-else class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-xs text-gray-500 border-b border-gray-200">
                <th class="py-2 pr-2">Label</th>
                <th class="py-2 pr-2">Sumber</th>
                <th class="py-2 pr-2 text-right">Karakter</th>
                <th class="py-2 pr-2 text-center">Aktif</th>
                <th class="py-2 pr-2 cursor-pointer select-none" @click="toggleSort">
                  Diperbarui {{ sortDesc ? '↓' : '↑' }}
                </th>
                <th class="py-2"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="d in sortedDocs" :key="d.id" class="border-b border-gray-100 last:border-0">
                <td class="py-2 pr-2 font-medium text-gray-800">{{ d.label }}</td>
                <td class="py-2 pr-2">
                  <span :class="['text-[10px] px-1.5 py-0.5 rounded-full', d.sourceType === 'composer' ? 'bg-indigo-100 text-indigo-700' : 'bg-green-100 text-green-700']">
                    {{ d.sourceType === 'composer' ? 'Composer' : 'File' }}
                  </span>
                </td>
                <td class="py-2 pr-2 text-right tabular-nums text-gray-600">{{ (d.charCount || 0).toLocaleString('id-ID') }}</td>
                <td class="py-2 pr-2 text-center">
                  <input type="checkbox" :checked="d.active" @change="toggleActive(d)" class="w-4 h-4 accent-green-600" />
                </td>
                <td class="py-2 pr-2 text-xs text-gray-500">{{ fmtDate(d.updatedAt) }}</td>
                <td class="py-2 text-right whitespace-nowrap">
                  <button @click="openPreview(d)" class="text-xs text-gray-600 hover:underline mr-2">Lihat</button>
                  <button @click="openUpload(d)" class="text-xs text-indigo-700 hover:underline mr-2" title="Re-upload file dengan label sama = replace isi">Replace</button>
                  <button v-if="d.sourceType === 'composer'" @click="openEdit(d)" class="text-xs text-green-700 hover:underline mr-2">Edit</button>
                  <button @click="removeDoc(d)" class="text-xs text-red-600 hover:underline">Hapus</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="text-xs text-gray-400 mt-2">Dokumen nonaktif tidak dipakai AI (tapi isinya tetap tersimpan).</p>
      </div>

      <!-- 🧪 Trial chatbox -->
      <div v-if="planOk" class="m3-card p-6">
        <h2 class="font-semibold text-gray-900">🧪 Trial — coba jawaban AI</h2>
        <p class="text-xs text-gray-500 mt-1">
          Jalur sama persis dengan auto-reply, TANPA mengirim WhatsApp & TANPA menambah counter chat.
        </p>
        <div class="mt-3 flex gap-2">
          <input
            v-model="trialQuestion"
            maxlength="1000"
            class="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            placeholder="Tulis pertanyaan customer (mis. 'berapa harga paket A?')"
            @keyup.enter="runTrial"
          />
          <button @click="runTrial" :disabled="trialBusy || !trialQuestion.trim()" class="m3-btn m3-btn--tonal text-sm">
            {{ trialBusy ? 'Menjawab...' : 'Tanya' }}
          </button>
        </div>
        <div v-if="trialResult" class="mt-3 p-3 rounded-lg text-sm" style="background: var(--md-sys-color-surface-container-high, #f3f0f7);">
          <div class="flex items-center gap-2 mb-1">
            <span
              :class="['text-[10px] px-1.5 py-0.5 rounded-full font-medium', trialResult.covered ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700']"
            >
              {{ trialResult.covered ? 'Tercakup dari KB' : 'Tidak tercakup — fallback teks' }}
            </span>
          </div>
          <div class="text-gray-800 whitespace-pre-line">{{ trialResult.answer || '— (tidak ada jawaban; customer akan menerima balasan fallback deterministik + masuk antrean CS)' }}</div>
        </div>
      </div>
    </div>

    <!-- Modal Upload -->
    <div v-if="uploadOpen" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" @click.self="uploadOpen = false">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-md p-5 space-y-3">
        <h3 class="font-semibold text-gray-900">Upload dokumen</h3>
        <input
          v-model="uploadForm.label"
          maxlength="100"
          class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          placeholder="Label wajib (mis. Pricelist, Jam Buka)"
        />
        <input ref="fileInput" type="file" accept=".txt,.md,.csv,.tsv,.docx,.xlsx" class="text-sm" @change="onFilePicked" />
        <p class="text-xs text-gray-400">
          Format: txt, md, csv, docx, xlsx — maks 5 MB. PDF scan butuh OCR — pakai txt/docx/copy-paste dulu.
        </p>
        <div class="flex justify-end gap-2">
          <button @click="uploadOpen = false" class="px-3 py-2 text-sm text-gray-600 hover:underline">Batal</button>
          <button @click="doUpload" :disabled="uploadBusy || !uploadForm.label.trim() || !uploadForm.file" class="px-4 py-2 bg-wa-green text-white rounded-lg text-sm font-medium hover:bg-green-600 disabled:opacity-50">
            {{ uploadBusy ? 'Mengunggah...' : (uploadReplaceId ? 'Replace dokumen' : 'Upload') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Modal Composer -->
    <div v-if="composeOpen" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40" @click.self="composeOpen = false">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-lg p-5 space-y-3">
        <h3 class="font-semibold text-gray-900">{{ composeEditId ? 'Edit dokumen (composer)' : 'Tulis dokumen manual' }}</h3>
        <input
          v-model="composeForm.label"
          maxlength="100"
          :disabled="!!composeEditId"
          class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          placeholder="Label wajib (mis. FAQ singkat)"
        />
        <textarea
          v-model="composeForm.content"
          rows="8"
          class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          placeholder="Tulis isi dokumen... (mis. daftar layanan + harga + jam buka)"
        ></textarea>
        <div class="text-right text-xs text-gray-400">{{ (composeForm.content || '').length.toLocaleString('id-ID') }} karakter (maks 100.000)</div>
        <div class="flex justify-end gap-2">
          <button @click="composeOpen = false" class="px-3 py-2 text-sm text-gray-600 hover:underline">Batal</button>
          <button @click="doCompose" :disabled="composeBusy || !composeForm.label.trim() || !(composeForm.content || '').trim()" class="px-4 py-2 bg-wa-green text-white rounded-lg text-sm font-medium hover:bg-green-600 disabled:opacity-50">
            {{ composeBusy ? 'Menyimpan...' : 'Simpan' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Drawer Preview parse -->
    <div v-if="previewDoc" class="fixed inset-0 z-50 flex justify-end bg-black/40" @click.self="previewOpen = false">
      <div class="bg-white w-full max-w-xl h-full p-5 overflow-y-auto">
        <div class="flex items-center justify-between mb-3">
          <h3 class="font-semibold text-gray-900">{{ previewDoc.label }}</h3>
          <button @click="previewOpen = false" class="text-sm text-gray-500 hover:underline">Tutup</button>
        </div>
        <p v-if="previewDoc.truncated" class="mb-2 px-3 py-2 rounded-lg bg-amber-50 text-amber-700 text-xs">
          ⚠️ {{ (previewDoc.charCount || 0).toLocaleString('id-ID') }} karakter terpotong (batas 100.000) — sisanya tidak dibaca AI.
        </p>
        <div class="p-3 rounded-lg text-sm whitespace-pre-wrap" style="background: var(--md-sys-color-surface-container-high, #f3f0f7);">{{ previewContent }}</div>
      </div>
    </div>
  </PageShell>
</template>

<script setup>
import axios from 'axios'
import { ref, computed, onMounted } from 'vue'
import { useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'
import PageShell from '../components/PageShell.vue'
import M3Switch from '../components/M3Switch.vue'
import { useConfirm } from '../utils/confirm'

const API = import.meta.env.VITE_API_URL || ''
const auth = useAuthStore()
const toast = useToastStore()
const { confirmAction } = useConfirm()

const saving = ref(false)
const docs = ref([])
const aiUsage = ref(null)
const config = ref({ cbaiLimit: 3, cbaiInfoFooter: true })
// v4.0.1 hotfix — plan gate graceful (quirk #2 QA Kanaka): plan ✗ → banner upsell
// ramah (pola Auto Reply), BUKAN toast "Gagal memuat" (403 kena interceptor global).
const planOk = ref(true)

// sortable updatedAt (default desc = terbaru dulu)
const sortDesc = ref(true)
const sortedDocs = computed(() => {
  const arr = docs.value.slice()
  arr.sort((a, b) => {
    const ta = new Date(a.updatedAt || 0).getTime()
    const tb = new Date(b.updatedAt || 0).getTime()
    return sortDesc.value ? tb - ta : ta - tb
  })
  return arr
})
function toggleSort() {
  sortDesc.value = !sortDesc.value
}

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso || '-'
  }
}

// ── Upload modal ──
const uploadOpen = ref(false)
const uploadBusy = ref(false)
const uploadForm = ref({ label: '', file: null })
const uploadReplaceId = ref(null)
const fileInput = ref(null)

function openUpload(replaceDoc = null) {
  uploadForm.value = { label: replaceDoc?.label || '', file: null }
  uploadReplaceId.value = replaceDoc?.id || null
  uploadOpen.value = true
}

// Re-upload dgn label sama = replace — dari tombol "Replace" di tabel
function openReplace(d) {
  openUpload(d)
}

// Edit inline composer doc (PUT content; timestamp naik — D1)
function openEdit(d) {
  composeForm.value = { label: d.label, content: '' }
  composeEditId.value = d.id
  composeContentLoading.value = true
  composeOpen.value = true
  axios.get(`${API}/api/ai-knowledge/${d.id}`).then((res) => {
    composeForm.value.content = res.data?.doc?.content || ''
  }).catch(() => {
    toast.show({ icon: '⚠️', title: 'Gagal memuat', message: 'Isi dokumen tidak bisa dimuat' })
    composeOpen.value = false
  }).finally(() => { composeContentLoading.value = false })
}

function onFilePicked(e) {
  uploadForm.value.file = e.target.files?.[0] || null
  if (!uploadForm.value.label && e.target.files?.[0]) {
    const base = e.target.files[0].name.replace(/\.[^.]+$/, '')
    if (base) uploadForm.value.label = base.slice(0, 100)
  }
}

async function doUpload() {
  if (!uploadForm.value.label.trim() || !uploadForm.value.file) return
  uploadBusy.value = true
  try {
    const fd = new FormData()
    fd.append('label', uploadForm.value.label.trim())
    fd.append('file', uploadForm.value.file)
    if (uploadReplaceId.value) fd.append('docId', String(uploadReplaceId.value))
    const res = await axios.post(`${API}/api/ai-knowledge/upload`, fd, { headers: { 'content-type': 'multipart/form-data' } })
    toast.show({ icon: '✅', title: res.data?.replaced ? 'Dokumen diganti' : 'Dokumen diunggah', message: res.data?.doc?.truncated ? `${(res.data.doc.charCount || 0).toLocaleString('id-ID')} karakter terpotong (batas 100.000)` : 'Knowledge siap dipakai AI' })
    uploadOpen.value = false
    await fetchAll()
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Gagal upload', message: e.response?.data?.error || 'Terjadi kesalahan' })
  } finally {
    uploadBusy.value = false
  }
}

// ── Composer modal ──
const composeOpen = ref(false)
const composeBusy = ref(false)
const composeForm = ref({ label: '', content: '' })
const composeEditId = ref(null)
const composeContentLoading = ref(false)

function openCompose() {
  composeForm.value = { label: '', content: '' }
  composeEditId.value = null
  composeOpen.value = true
}

async function doCompose() {
  composeBusy.value = true
  try {
    if (composeEditId.value) {
      await axios.put(`${API}/api/ai-knowledge/${composeEditId.value}/content`, { content: composeForm.value.content })
    } else {
      await axios.post(`${API}/api/ai-knowledge/compose`, { label: composeForm.value.label.trim(), content: composeForm.value.content })
    }
    toast.show({ icon: '✅', title: 'Tersimpan', message: 'Dokumen composer berhasil disimpan' })
    composeOpen.value = false
    await fetchAll()
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Gagal simpan', message: e.response?.data?.error || 'Terjadi kesalahan' })
  } finally {
    composeBusy.value = false
  }
}

// ── Preview drawer ──
const previewOpen = ref(false)
const previewDoc = ref(null)
const previewContent = ref('')
async function openPreview(d) {
  previewDoc.value = { ...d, truncated: (d.charCount || 0) >= 100000 }
  previewContent.value = 'Memuat...'
  previewOpen.value = true
  try {
    const det = await axios.get(`${API}/api/ai-knowledge/${d.id}`)
    previewContent.value = det.data?.doc?.content || ''
  } catch {
    previewContent.value = '(gagal memuat isi dokumen)'
  }
}

// ── Toggle aktif / hapus ──
async function toggleActive(d) {
  try {
    await axios.put(`${API}/api/ai-knowledge/${d.id}/active`, { active: !d.active })
    d.active = !d.active
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Gagal', message: e.response?.data?.error || 'Terjadi kesalahan' })
  }
}

async function removeDoc(d) {
  const ok = await confirmAction({ title: 'Hapus dokumen?', message: `"${d.label}" akan dihapus dari KB AI.`, confirmText: 'Hapus', danger: true })
  if (!ok) return
  try {
    await axios.delete(`${API}/api/ai-knowledge/${d.id}`)
    toast.show({ icon: '🗑️', title: 'Dihapus', message: `Dokumen "${d.label}" dihapus` })
    await fetchAll()
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Gagal hapus', message: e.response?.data?.error || 'Terjadi kesalahan' })
  }
}

// ── Trial (D11) ──
const trialQuestion = ref('')
const trialBusy = ref(false)
const trialResult = ref(null)
async function runTrial() {
  if (!trialQuestion.value.trim()) return
  trialBusy.value = true
  trialResult.value = null
  try {
    const res = await axios.post(`${API}/api/ai-knowledge/trial`, { question: trialQuestion.value.trim() })
    trialResult.value = res.data
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Trial gagal', message: e.response?.data?.error || 'Terjadi kesalahan' })
  } finally {
    trialBusy.value = false
  }
}

// ── Config ──
async function saveConfig() {
  saving.value = true
  try {
    const res = await axios.put(`${API}/api/ai-knowledge/config`, {
      cbaiLimit: Number(config.value.cbaiLimit),
      cbaiInfoFooter: !!config.value.cbaiInfoFooter,
    })
    config.value.cbaiLimit = res.data.config.cbaiLimit
    config.value.cbaiInfoFooter = res.data.config.cbaiInfoFooter
    toast.show({ icon: '✅', title: 'Tersimpan', message: 'Pengaturan CB-AI berhasil disimpan' })
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Gagal simpan', message: e.response?.data?.error || 'Terjadi kesalahan' })
  } finally {
    saving.value = false
  }
}

async function fetchAll() {
  try {
    const res = await axios.get(`${API}/api/ai-knowledge`)
    docs.value = res.data.docs || []
    aiUsage.value = res.data.aiUsage || null
    if (res.data.config) {
      config.value.cbaiLimit = res.data.config.cbaiLimit ?? 3
      config.value.cbaiInfoFooter = res.data.config.cbaiInfoFooter !== false
    }
  } catch (e) {
    if (e?.response?.status === 403) {
      // v4.0.1 hotfix — plan ✗ → tampil upsell ramah, bukan toast error
      planOk.value = false
      docs.value = []
      aiUsage.value = null
      return
    }
    toast.show({ icon: '⚠️', title: 'Gagal memuat', message: e.response?.data?.error || 'Data tidak bisa dimuat' })
  }
}

function handleLogout() {
  auth.logout()
  window.location.href = '/login'
}

onMounted(fetchAll)
</script>