<template>
  <!--
    v0.14.1 — GroupMemberPicker: komponen shared pemilihan anggota grup.
    3 tab: [Kontak] (tersimpan + filter tag) [Nomor] (paste/textarea) [CSV] (parse client-side).
    Default tab: Kontak. v-model = Array<string> nomor final (unik; string mentah boleh —
    backend normalizePhone di src/services/groups.js yang normalisasi final).
    Footer: chips final (hapus per-nomor via ✕) + ringkasan "N anggota akan ditambahkan".
    v0.14.7 — kontak LID-only (tanpa nomor asli, chat terhubung) tetap bisa dipilih:
    masuk daftar final sbg chatId "...@lid" — parent memisahkan phones[] vs lids[],
    backend kirim link undangan 1:1 (sendGroupInviteLinks).
  -->
  <div class="border border-gray-200 rounded-lg overflow-hidden bg-white">
    <!-- Tabs -->
    <div class="flex gap-1 bg-gray-50 border-b border-gray-200 p-1">
      <button
        v-for="t in tabs"
        :key="t.key"
        type="button"
        @click="activeTab = t.key"
        :class="['flex-1 px-2 py-2 rounded-md text-xs sm:text-sm font-medium min-h-[40px]', activeTab === t.key ? 'bg-wa-green text-white' : 'text-gray-600 hover:text-gray-900']"
      >{{ t.label }}</button>
    </div>

    <div class="p-3">
      <!-- ═══ Tab 1: Kontak tersimpan (+ filter tag) — pola BlastComposer tab kontak ═══ -->
      <div v-if="activeTab === 'contacts'" class="space-y-2">
        <div class="flex flex-col sm:flex-row gap-2">
          <input
            v-model="contactSearch"
            @input="onContactSearchInput"
            type="text"
            placeholder="Cari kontak tersimpan…"
            class="flex-1 min-w-0 px-3 py-2 text-sm border border-gray-300 rounded-lg"
          />
          <select
            v-model="selectedTagId"
            @change="onTagFilterChange"
            class="flex-shrink-0 sm:max-w-[150px] px-2 py-2 text-sm border border-gray-300 rounded-lg bg-white"
          >
            <option :value="null">Semua tag</option>
            <option v-for="t in tags" :key="t.id" :value="t.id">{{ t.name }}</option>
          </select>
        </div>

        <div class="flex items-center justify-between gap-2 text-xs">
          <button type="button" @click="toggleSelectPage" class="text-wa-green hover:underline">
            {{ pageAllSelected ? 'Batalkan semua (halaman ini)' : 'Pilih semua (halaman ini)' }}
          </button>
          <span class="text-gray-500 whitespace-nowrap">{{ selectedContacts.size }} dipilih / {{ contactTotal }} kontak</span>
        </div>

        <div class="border border-gray-200 rounded-lg max-h-64 overflow-y-auto">
          <div v-if="contactsLoading" class="p-4 text-center text-gray-400 text-sm">Memuat…</div>
          <div v-else-if="contactsError" class="p-4 text-center text-red-500 text-sm">{{ contactsError }}</div>
          <div v-else-if="contacts.length === 0" class="p-4 text-center text-gray-400 text-sm">Belum ada kontak tersimpan</div>
          <label
            v-for="ct in contacts"
            :key="'gmp-ct-' + ct.id"
            :class="['flex items-center px-3 py-2 border-b border-gray-100', canPickContact(ct) ? 'hover:bg-gray-50 cursor-pointer' : 'opacity-50 cursor-not-allowed']"
          >
            <input
              type="checkbox"
              :disabled="!canPickContact(ct)"
              :checked="isContactSelected(ct)"
              @change="toggleContact(ct)"
              class="mr-3"
            />
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium truncate">{{ ct.name || ct.phone || '-' }}</div>
              <div class="text-xs truncate" :class="ct.phone ? 'text-gray-400' : 'text-amber-600'">
                {{ ct.phone || (ct.chatId ? 'LID — via link undangan' : 'tanpa nomor') }}
              </div>
            </div>
          </label>
          <div v-if="!contactsLoading && contacts.length < contactTotal" class="p-2 text-center">
            <button type="button" @click="loadMoreContacts" class="text-xs text-wa-green hover:underline">
              Muat lagi ({{ contactTotal - contacts.length }} lagi)
            </button>
          </div>
        </div>
      </div>

      <!-- ═══ Tab 2: Nomor (paste daftar sekaligus) ═══ -->
      <div v-else-if="activeTab === 'manual'" class="space-y-2">
        <textarea
          v-model="manualText"
          rows="5"
          placeholder="Satu nomor per baris (koma juga boleh)&#10;0812xxxxxxx&#10;62812xxxxxxx&#10;+62 812-xxxx-xxx"
          class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg font-mono"
        ></textarea>
        <p class="text-xs text-gray-600">
          {{ manualValid.length }} nomor valid, {{ manualInvalid.length }} dibuang
        </p>
        <ul
          v-if="manualInvalid.length"
          class="text-xs text-red-600 space-y-0.5 max-h-24 overflow-y-auto border border-red-100 bg-red-50 rounded-lg p-2"
        >
          <li v-for="(r, i) in manualInvalid.slice(0, 30)" :key="i">• {{ r.raw || '(kosong)' }} — {{ r.reason }}</li>
          <li v-if="manualInvalid.length > 30" class="text-gray-400">…{{ manualInvalid.length - 30 }} baris lainnya</li>
        </ul>
        <p class="text-[11px] text-gray-400">Format bebas (62… / 08… / +62…) — dibersihkan otomatis sebelum ditambahkan.</p>
      </div>

      <!-- ═══ Tab 3: CSV (parse client-side, tidak menyentuh backend) ═══ -->
      <div v-else class="space-y-2">
        <label class="block border-2 border-dashed border-gray-300 hover:border-gray-400 rounded-lg p-4 text-center cursor-pointer transition-colors">
          <span class="text-2xl block mb-1">📁</span>
          <span class="text-sm text-gray-600">Pilih file CSV / TXT</span>
          <input type="file" accept=".csv,.txt" class="hidden" @change="onCsvFile" />
        </label>
        <p v-if="csvFileName" class="text-xs text-gray-500 truncate">
          {{ csvFileName }}
          <button type="button" @click="clearCsv" class="text-red-500 hover:underline ml-2">hapus</button>
        </p>
        <div v-if="csvError" class="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-600">{{ csvError }}</div>
        <p v-if="csvRows.length" class="text-xs text-gray-600">
          {{ csvValidCount }} nomor valid · {{ csvDupCount }} duplikat (dihitung sekali) · {{ csvInvalidCount }} baris dibuang
        </p>
        <ul
          v-if="csvInvalidCount"
          class="text-xs text-red-600 space-y-0.5 max-h-24 overflow-y-auto border border-red-100 bg-red-50 rounded-lg p-2"
        >
          <li v-for="(r, i) in csvInvalidRows.slice(0, 30)" :key="i">• baris {{ r.line }}: {{ r.raw || '(kosong)' }} — {{ r.reason }}</li>
          <li v-if="csvInvalidCount > 30" class="text-gray-400">…{{ csvInvalidCount - 30 }} baris lainnya</li>
        </ul>
        <p class="text-[11px] text-gray-400">Kolom nomor/phone dideteksi otomatis; baris header dilewati. Nama (jika ada) hanya utk preview.</p>
      </div>
    </div>

    <!-- ═══ Footer: daftar final (chips) + ringkasan ═══ -->
    <div class="border-t border-gray-200 p-3 space-y-2 bg-gray-50">
      <div class="flex items-center justify-between gap-2">
        <p class="text-xs font-medium text-gray-700">
          {{ finalEntries.length }} anggota akan ditambahkan<span v-if="linkCount" class="text-amber-600"> · {{ linkCount }} via link undangan</span>
        </p>
        <button
          v-if="finalEntries.length"
          type="button"
          @click="clearAll"
          class="text-[11px] text-red-500 hover:underline whitespace-nowrap"
        >hapus semua</button>
      </div>
      <div v-if="finalEntries.length" class="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
        <span
          v-for="e in finalEntries"
          :key="e.key"
          class="inline-flex items-center gap-1 bg-gray-100 rounded-full pl-2.5 pr-1 py-0.5 text-xs text-gray-700"
        >
          <span class="max-w-[180px] truncate">{{ e.viaLink ? '🔗 ' : '' }}{{ e.name || e.raw }}</span>
          <button
            type="button"
            @click="removeEntry(e)"
            class="w-4 h-4 rounded-full text-gray-400 hover:text-red-500 hover:bg-red-50 flex items-center justify-center flex-shrink-0"
            :title="'Hapus ' + e.raw"
          >✕</button>
        </span>
      </div>
      <p v-else class="text-[11px] text-gray-400">Belum ada nomor dipilih.</p>
    </div>
  </div>
</template>

<script setup>
// v0.14.1 — GroupMemberPicker: logika pemilihan anggota grup (frontend-only).
// Backend tidak berubah: POST /api/groups & POST /api/groups/:id/members sudah
// menerima phones[] dan menormalisasi via normalizePhone (src/services/groups.js).
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useAuthStore } from '../stores/auth'
import { groupsClient } from '../utils/groupsApi'

const props = defineProps({
  /** v-model — daftar nomor final (Array<string>, unik; string mentah boleh) */
  modelValue: { type: Array, default: () => [] },
})
const emit = defineEmits(['update:modelValue'])

const auth = useAuthStore()

// ─── Tab ───────────────────────────────────────────────────────────────
const tabs = [
  { key: 'contacts', label: 'Kontak' },
  { key: 'manual', label: 'Nomor' },
  { key: 'csv', label: 'CSV' },
]
const activeTab = ref('contacts') // default: Kontak

// ─── Tab Kontak (pola selectedContacts Map di BlastComposer) ───────────
const contacts = ref([])
const contactTotal = ref(0)
const contactPage = ref(1)
const contactSearch = ref('')
const selectedTagId = ref(null)
const contactsLoading = ref(false)
const contactsError = ref('')
const tags = ref([])
const selectedContacts = ref(new Map()) // id → contact (tahan antar halaman/filter)

function isContactSelected(ct) { return selectedContacts.value.has(ct.id) }

// v0.14.7 — kontak LID-only (tanpa nomor asli, punya chat 1:1 terhubung) tetap
// bisa dipilih → dikirim LINK UNDANGAN oleh backend (sendGroupInviteLinks).
// Kontak tanpa nomor DAN tanpa chat terhubung tetap tidak bisa dipilih.
function canPickContact(ct) {
  return !!(ct.phone || ct.chatId)
}

function toggleContact(ct) {
  if (!canPickContact(ct)) return
  const m = new Map(selectedContacts.value)
  if (m.has(ct.id)) m.delete(ct.id)
  else m.set(ct.id, ct)
  selectedContacts.value = m
}

const selectableContacts = computed(() => contacts.value.filter(canPickContact))
const pageAllSelected = computed(() =>
  selectableContacts.value.length > 0 && selectableContacts.value.every(c => selectedContacts.value.has(c.id))
)

function toggleSelectPage() {
  const m = new Map(selectedContacts.value)
  if (pageAllSelected.value) {
    for (const c of selectableContacts.value) m.delete(c.id)
  } else {
    for (const c of selectableContacts.value) m.set(c.id, c)
  }
  selectedContacts.value = m
}

/** GET /api/contacts {page, q, tagId} — pageSize fix 20 dari backend. */
async function fetchContacts(reset = true) {
  contactsLoading.value = true
  contactsError.value = ''
  try {
    const api = groupsClient(auth.token)
    const res = await api.get('/api/contacts', {
      params: {
        page: contactPage.value,
        q: contactSearch.value.trim() || undefined,
        tagId: selectedTagId.value || undefined,
      },
    })
    const list = res.data.contacts || []
    contacts.value = reset ? list : [...contacts.value, ...list]
    contactTotal.value = res.data.total || 0
  } catch (e) {
    console.error('[GroupMemberPicker] fetch contacts error:', e)
    contactsError.value = 'Gagal memuat kontak.'
  } finally {
    contactsLoading.value = false
  }
}

let contactSearchTimer = null
function onContactSearchInput() {
  clearTimeout(contactSearchTimer)
  contactSearchTimer = setTimeout(() => { contactPage.value = 1; fetchContacts(true) }, 300)
}

function onTagFilterChange() {
  contactPage.value = 1
  fetchContacts(true)
}

async function loadMoreContacts() {
  contactPage.value++
  await fetchContacts(false)
}

/** GET /api/tags — dropdown filter tag (id + name). */
async function fetchTags() {
  try {
    const api = groupsClient(auth.token)
    const res = await api.get('/api/tags')
    tags.value = res.data.tags || []
  } catch (e) {
    console.error('[GroupMemberPicker] fetch tags error:', e)
  }
}

// ─── Normalisasi client (HANYA utk preview — mirror normalizePhone groups.js) ──
function normalizePhoneClient(raw) {
  if (!raw) return null
  let p = String(raw).replace(/[\s\-().]/g, '')
  if (p.startsWith('+')) p = p.slice(1)
  if (p.startsWith('0')) p = '62' + p.slice(1)
  if (p.startsWith('8') && p.length >= 8 && !p.startsWith('62')) p = '62' + p
  if (!/^\d+$/.test(p)) return null
  if (p.length < 8 || p.length > 15) return null
  return p
}

function invalidReason(raw) {
  const t = String(raw || '').trim()
  if (!t) return 'kosong'
  const digits = t.replace(/[\s\-().+]/g, '')
  if (!/^\d+$/.test(digits)) return 'berisi non-angka'
  if (digits.length < 8) return 'terlalu pendek (<8 digit)'
  if (digits.length > 15) return 'terlalu panjang (>15 digit)'
  return 'format tidak dikenali'
}

// ─── Tab Nomor (paste daftar sekaligus) ────────────────────────────────
const manualText = ref('')

/** Parse textarea: 1 nomor per baris, koma/titik-koma juga boleh. */
const manualParsed = computed(() => {
  const out = []
  manualText.value.split('\n').forEach((line, lineIdx) => {
    for (const tok of line.split(/[,;]/)) {
      const raw = tok.trim()
      if (!raw) continue
      const phone = normalizePhoneClient(raw)
      out.push({ raw, phone, valid: !!phone, reason: phone ? null : invalidReason(raw), lineIdx })
    }
  })
  return out
})
const manualValid = computed(() => manualParsed.value.filter(t => t.phone))
const manualInvalid = computed(() => manualParsed.value.filter(t => !t.phone))

/** Hapus satu token dari textarea (baris jadi kosong → baris dihapus). */
function removeManualEntry(entry) {
  const lines = manualText.value.split('\n')
  const line = lines[entry.lineIdx]
  if (line == null) return
  const idx = line.indexOf(entry.raw)
  const newLine = idx >= 0 ? line.slice(0, idx) + line.slice(idx + entry.raw.length) : line
  lines[entry.lineIdx] = newLine.trim() ? newLine : ''
  manualText.value = lines.join('\n')
}

// ─── Tab CSV (parse penuh di client, tanpa dependency) ─────────────────
const csvRows = ref([]) // {line, raw, name, phone, valid, dup, reason}
const csvFileName = ref('')
const csvError = ref('')
// Header: kolom pertama mengandung "nomor|phone|no|wa|whatsapp" (case-insensitive).
// Batas non-huruf agar nama seperti "Noval" tidak dianggap header "no".
const PHONE_HEADER_RE = /(?:^|[^a-z])(nomor|phone|whatsapp|no|wa)(?:$|[^a-z])/
const NAME_HEADER_RE = /(?:^|[^a-z])(nama|name)(?:$|[^a-z])/

function detectCsvDelimiter(text) {
  const head = text.split('\n', 3).join('\n')
  let best = ',', bestN = 0
  for (const d of [',', ';', '\t']) {
    const n = head.split(d).length - 1
    if (n > bestN) { best = d; bestN = n }
  }
  return best
}

/** Parser CSV mini: quoted field sederhana + delimiter , ; tab (tanpa papaparse). */
function parseCsvText(text, delim) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } // escaped ""
        else inQuotes = false
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === delim) {
      row.push(field); field = ''
    } else if (ch === '\n') {
      row.push(field); rows.push(row); row = []; field = ''
    } else if (ch === '\r') {
      // abaikan CR
    } else {
      field += ch
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows
}

function onCsvFile(ev) {
  const file = ev.target?.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    try {
      ingestCsvText(String(reader.result || ''), file.name)
    } catch (e) {
      console.error('[GroupMemberPicker] CSV parse error:', e)
      csvError.value = 'Gagal membaca file CSV.'
    }
  }
  reader.onerror = () => { csvError.value = 'Gagal membaca file.' }
  reader.readAsText(file)
  ev.target.value = '' // reset → file yang sama bisa dipilih ulang
}

function ingestCsvText(text, fileName) {
  csvError.value = ''
  const delim = detectCsvDelimiter(text)
  const rawRows = parseCsvText(text, delim).filter(r => r.some(c => String(c).trim() !== ''))
  if (!rawRows.length) {
    csvRows.value = []
    csvFileName.value = ''
    csvError.value = 'File kosong — tidak ada baris data.'
    return
  }

  // Header row: kolom pertama mengandung nomor/phone/no/wa/whatsapp → skip.
  // Tambahan kecil (logis, dicatat di laporan): kolom pertama bernama "nama|name"
  // + ada kolom lain bernomor → tetap dianggap header.
  let header = null
  let startIdx = 0
  const firstCell = String(rawRows[0]?.[0] || '').trim().toLowerCase()
  const anyPhoneHeader = rawRows[0].some(c => PHONE_HEADER_RE.test(String(c || '').trim().toLowerCase()))
  if (PHONE_HEADER_RE.test(firstCell) || (NAME_HEADER_RE.test(firstCell) && anyPhoneHeader)) {
    header = rawRows[0]
    startIdx = 1
  }

  // Kolom phone: bernama nomor/phone/no/wa bila ada; else kolom pertama.
  // Kolom "nama|name" opsional → hanya utk tampilan preview.
  let phoneCol = 0
  let nameCol = -1
  if (header) {
    for (let i = 0; i < header.length; i++) {
      if (PHONE_HEADER_RE.test(String(header[i] || '').trim().toLowerCase())) { phoneCol = i; break }
    }
    for (let i = 0; i < header.length; i++) {
      if (NAME_HEADER_RE.test(String(header[i] || '').trim().toLowerCase())) { nameCol = i; break }
    }
  }

  const out = []
  const seen = new Set()
  for (let i = startIdx; i < rawRows.length; i++) {
    const row = rawRows[i]
    const raw = String(row[phoneCol] ?? '').trim()
    const name = nameCol >= 0 ? String(row[nameCol] ?? '').trim() : ''
    if (!raw && !name) continue
    const phone = normalizePhoneClient(raw)
    const entry = { line: i + 1, raw, name, phone, valid: false, dup: false, reason: null }
    if (!phone) entry.reason = invalidReason(raw)
    else if (seen.has(phone)) entry.valid = true, entry.dup = true // duplikat dihitung sekali
    else { entry.valid = true; seen.add(phone) }
    out.push(entry)
  }
  csvRows.value = out
  csvFileName.value = fileName || ''
}

const csvValidCount = computed(() => csvRows.value.filter(r => r.valid && !r.dup).length)
const csvDupCount = computed(() => csvRows.value.filter(r => r.valid && r.dup).length)
const csvInvalidCount = computed(() => csvRows.value.filter(r => !r.valid).length)
const csvInvalidRows = computed(() => csvRows.value.filter(r => !r.valid))

function clearCsv() {
  csvRows.value = []
  csvFileName.value = ''
  csvError.value = ''
}

// ─── Gabungan 3 tab → daftar final unik (v-model) ──────────────────────
// Dedupe by normalized key; entri pertama menang (urutan: kontak → manual → CSV).
const finalEntries = computed(() => {
  const out = []
  const seen = new Set()
  const push = (raw, source, extra = {}) => {
    const key = normalizePhoneClient(raw)
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push({ key, raw: String(raw).trim(), source, ...extra })
  }
  for (const ct of selectedContacts.value.values()) {
    // v0.14.7 — kontak LID-only: masuk daftar final sbg chatId ("...@lid") →
    // parent memisahkan phones vs lids; backend kirim link undangan 1:1.
    if (!ct.phone && ct.chatId) {
      const key = String(ct.chatId)
      if (!seen.has(key)) {
        seen.add(key)
        out.push({ key, raw: key, source: 'contact', contactId: ct.id, name: ct.name || '', viaLink: true })
      }
      continue
    }
    if (ct.phone) push(ct.phone, 'contact', { contactId: ct.id, name: ct.name || '' })
  }
  for (const t of manualValid.value) push(t.raw, 'manual', {})
  for (const r of csvRows.value) {
    if (r.valid && !r.dup) push(r.raw, 'csv', { name: r.name || '' })
  }
  return out
})

// v0.14.7 — jumlah entri LID-only (dikirim sbg link undangan oleh backend)
const linkCount = computed(() => finalEntries.value.filter(e => e.viaLink).length)

let lastEmitted = ''
watch(finalEntries, (entries) => {
  const arr = entries.map(e => e.raw)
  lastEmitted = JSON.stringify(arr)
  emit('update:modelValue', arr)
}, { immediate: true })

// Perubahan dari LUAR (parent reset form → []) → bersihkan state internal.
// Nilai non-kosong dari luar di-merge sbg baris manual (nomor yang belum ada).
watch(() => props.modelValue, (val) => {
  const sig = JSON.stringify(val || [])
  if (sig === lastEmitted) return
  if (!val || val.length === 0) {
    clearAll()
    return
  }
  const keys = new Set(finalEntries.value.map(e => e.key))
  const extra = []
  for (const v of val) {
    const raw = String(v || '').trim()
    if (!raw) continue
    const key = normalizePhoneClient(raw)
    if (!key || keys.has(key)) continue
    keys.add(key)
    extra.push(raw)
  }
  if (extra.length) {
    manualText.value = (manualText.value ? manualText.value.replace(/\s+$/, '') + '\n' : '') + extra.join('\n')
  }
})

/** Hapus satu nomor dari daftar final → kembali ke sumber asalnya. */
function removeEntry(entry) {
  if (entry.source === 'contact') {
    const m = new Map(selectedContacts.value)
    m.delete(entry.contactId)
    selectedContacts.value = m
  } else if (entry.source === 'manual') {
    removeManualEntry(entry)
  } else if (entry.source === 'csv') {
    csvRows.value = csvRows.value.filter(r => !(r.valid && !r.dup && r.raw === entry.raw))
  }
}

function clearAll() {
  selectedContacts.value = new Map()
  manualText.value = ''
  clearCsv()
}

onMounted(() => {
  fetchContacts(true)
  fetchTags()
})

onUnmounted(() => {
  clearTimeout(contactSearchTimer)
})
</script>