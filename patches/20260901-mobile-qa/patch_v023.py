#!/usr/bin/env python3
"""v0.2.3 — QA feedback Kanaka 21:02:
A) BlastComposer: tab 'Kontak' — recipient dari kontak tersimpan (frontend-only, pipeline backend sama)
B) BlastHistory: mobile card layout + log table internal scroll
C) Contacts: mobile card layout (tidak ada lagi kepotong/scroll samping)
Semua blok pakai assert; kalau anchor gagal -> file TIDAK ditulis."""
import sys

def apply(path, pairs):
    c = open(path).read()
    for i, (old, new) in enumerate(pairs):
        if old not in c:
            print(f'ANCHOR FAIL {path} block#{i}')
            sys.exit(1)
        c = c.replace(old, new, 1)
    open(path, 'w').write(c)
    print(f'OK  {path} ({len(pairs)} blocks)')

# ════════ A. BlastComposer — tab Kontak sebagai recipient ════════
p = 'frontend/src/views/BlastComposer.vue'
c = open(p).read()

old = """          <button @click="recipientTab = 'chats'" :class="['flex-1 px-4 py-2 rounded-md text-sm font-medium', recipientTab === 'chats' ? 'bg-wa-green text-white' : 'text-gray-600 hover:text-gray-900']">From Chat List</button>
          <button @click="recipientTab = 'tags'" :class="['flex-1 px-4 py-2 rounded-md text-sm font-medium', recipientTab === 'tags' ? 'bg-wa-green text-white' : 'text-gray-600 hover:text-gray-900']">From Tags</button>
          <button @click="recipientTab = 'csv'" :class="['flex-1 px-4 py-2 rounded-md text-sm font-medium', recipientTab === 'csv' ? 'bg-wa-green text-white' : 'text-gray-600 hover:text-gray-900']">Upload CSV</button>"""
new = """          <button @click="recipientTab = 'chats'" :class="['flex-1 px-2 py-2 rounded-md text-sm font-medium', recipientTab === 'chats' ? 'bg-wa-green text-white' : 'text-gray-600 hover:text-gray-900']">Chat List</button>
          <button @click="openContactsTab" :class="['flex-1 px-4 py-2 rounded-md text-sm font-medium', recipientTab === 'contacts' ? 'bg-wa-green text-white' : 'text-gray-600 hover:text-gray-900']">Kontak</button>
          <button @click="recipientTab = 'tags'" :class="['flex-1 px-2 py-2 rounded-md text-sm font-medium', recipientTab === 'tags' ? 'bg-wa-green text-white' : 'text-gray-600 hover:text-gray-900']">Tags</button>
          <button @click="recipientTab = 'csv'" :class="['flex-1 px-2 py-2 rounded-md text-sm font-medium', recipientTab === 'csv' ? 'bg-wa-green text-white' : 'text-gray-600 hover:text-gray-900']">CSV</button>"""
assert old in c, 'A1'
c = c.replace(old, new, 1)

panel = '''        <!-- From Contacts (v0.2.3 — kontak tersimpan, request Kanaka 2026-09-01 21:02) -->
        <div v-if="recipientTab === 'contacts'">
          <div class="flex gap-2 mb-3">
            <input v-model="contactSearch" @input="onContactSearchInput" type="text" placeholder="Cari kontak tersimpan..." class="flex-1 min-w-0 px-3 py-2 text-sm border border-gray-300 rounded-lg" />
          </div>

          <div class="flex items-center justify-between mb-2">
            <button @click="selectAllContacts" class="text-sm text-wa-green hover:underline">{{ contactsPageAllSelected ? 'Batalkan Semua (halaman ini)' : 'Pilih Semua (halaman ini)' }}</button>
            <span class="text-sm text-gray-500">{{ availableContacts.length }} / {{ contactTotal }} kontak</span>
          </div>

          <div class="border border-gray-200 rounded-lg max-h-80 overflow-y-auto">
            <div v-if="loadingContacts" class="p-4 text-center text-gray-400 text-sm">Loading...</div>
            <div v-else-if="availableContacts.length === 0" class="p-4 text-center text-gray-400 text-sm">Belum ada kontak tersimpan</div>
            <label v-for="ct in availableContacts" :key="'ct-' + ct.id" class="flex items-center px-3 py-2 hover:bg-gray-50 cursor-pointer border-b border-gray-100">
              <input type="checkbox" :checked="isContactSelected(ct)" @change="toggleContact(ct)" class="mr-3" />
              <div class="flex-1 min-w-0">
                <div class="text-sm font-medium truncate">{{ ct.name || ct.phone || '-' }}</div>
                <div class="text-xs text-gray-400 truncate">{{ ct.phone || 'nomor tidak diketahui' }}<span v-if="ct.chatId" class="text-wa-green"> · punya chat</span></div>
              </div>
            </label>
            <div v-if="availableContacts.length < contactTotal" class="p-2 text-center">
              <button @click="loadMoreContacts" class="text-sm text-wa-green hover:underline">Muat lagi ({{ contactTotal - availableContacts.length }} lagi)</button>
            </div>
          </div>
          <p class="text-xs text-gray-400 mt-2">Kontak tanpa chat terdaftar dikirim sebagai nomor baru (warm/cold) — sama seperti jalur CSV.</p>
        </div>

        <!-- From Chat List -->'''
assert '<!-- From Chat List -->' in c, 'A2'
c = c.replace('        <!-- From Chat List -->', panel, 1)

old = "const csvNumbers = ref([]) // [{ name, phone, normalized, valid, reason }]"
new = old + '''

// v0.2.3 — recipient dari Kontak tersimpan (request Kanaka 2026-09-01 21:02)
const availableContacts = ref([])
const contactSearch = ref('')
const contactPage = ref(1)
const contactTotal = ref(0)
const loadingContacts = ref(false)
const selectedContactMap = ref(new Map()) // id -> contact object
let contactSearchTimer = null

function normalizeContactPhone(raw) {
  if (!raw) return { normalized: '', valid: false, reason: 'No phone' }
  let p = String(raw).replace(/[\\s\\-().]/g, '')
  if (p.startsWith('+')) p = p.slice(1)
  if (p.startsWith('0')) p = '62' + p.slice(1)
  if (p.startsWith('8') && p.length >= 8 && !p.startsWith('62')) p = '62' + p
  if (!/^\\d+$/.test(p)) return { normalized: '', valid: false, reason: 'Bukan angka' }
  if (!p.startsWith('62')) {
    if (p.length < 8) return { normalized: '', valid: false, reason: 'Terlalu pendek' }
  } else if (p.length < 10) return { normalized: '', valid: false, reason: 'Terlalu pendek' }
  if (p.length > 15) return { normalized: '', valid: false, reason: 'Terlalu panjang' }
  return { normalized: p, valid: true, reason: '' }
}'''
assert old in c, 'A3'
c = c.replace(old, new, 1)

old = '''const totalUniqueRecipients = computed(() => {
  // Chat IDs from chat list + tag selection + valid CSV numbers not already in chat list
  return selectedChatIds.value.size + csvValidCount.value
})'''
new = '''const selectedContactObjs = computed(() => [...selectedContactMap.value.values()])
const contactChatIds = computed(() => new Set(selectedContactObjs.value.filter(c => c.chatId).map(c => c.chatId)))
const csvNormSet = computed(() => new Set(csvNumbers.value.filter(n => n.valid).map(n => n.normalized)))
const noChatContactNumbers = computed(() => selectedContactObjs.value
  .filter(c => !c.chatId)
  .map(c => { const n = normalizeContactPhone(c.phone); return { name: c.name || '', phone: c.phone, normalized: n.normalized, valid: n.valid, reason: n.reason } })
  .filter(n => n.valid && !csvNormSet.value.has(n.normalized)))

const totalUniqueRecipients = computed(() => {
  // v0.2.3 — chat ids unik (chat list ∪ kontak ber-chat) + kontak tanpa chat (cold) + CSV valid
  const chatIdSet = new Set([...selectedChatIds.value, ...contactChatIds.value])
  return chatIdSet.size + noChatContactNumbers.value.length + csvValidCount.value
})'''
assert old in c, 'A4'
c = c.replace(old, new, 1)

old = '''  // From CSV
  for (const csv of csvNumbers.value) {'''
new = '''  // v0.2.3 — dari Kontak tersimpan (chat-linked dedupe dgn chat list; cold dedupe dgn CSV)
  for (const ct of selectedContactObjs.value) {
    if (ct.chatId) {
      if (!selectedChatIds.value.has(ct.chatId)) {
        preview.push({ id: ct.chatId, name: ct.name || ct.phone || 'Kontak', phone: ct.phone })
      }
    } else {
      const n = normalizeContactPhone(ct.phone)
      if (n.valid && !csvNormSet.value.has(n.normalized)) {
        preview.push({ id: `contact-${ct.id}`, name: ct.name || n.normalized, phone: ct.phone })
      }
    }
  }
  // From CSV'''
assert old in c, 'A5'
c = c.replace(old, new, 1)

old = '''    const res = await axios.post(`${API}/api/blast/preview`, {
      recipientChatIds: [...selectedChatIds.value],
      tagIds: [...selectedTagIds.value],
      csvNumbers: validCsvNumbers,
    })'''
new = '''    const res = await axios.post(`${API}/api/blast/preview`, {
      recipientChatIds: [...new Set([...selectedChatIds.value, ...contactChatIds.value])],
      tagIds: [...selectedTagIds.value],
      csvNumbers: [...validCsvNumbers, ...noChatContactNumbers.value],
    })'''
assert old in c, 'A6'
c = c.replace(old, new, 1)

old = "    const chatIds = [...selectedChatIds.value]"
assert old in c, 'A7a'
c = c.replace(old, "    const chatIds = [...new Set([...selectedChatIds.value, ...contactChatIds.value])]", 1)
old = "      csvNumbers: validCsvNumbers,"
assert old in c, 'A7b'
c = c.replace(old, "      csvNumbers: [...validCsvNumbers, ...noChatContactNumbers.value],", 1)

old = "function clearAllRecipients() {\n  selectedChatIds.value = new Set()\n  selectedTagIds.value = new Set()\n  csvNumbers.value = []"
new = "function clearAllRecipients() {\n  selectedChatIds.value = new Set()\n  selectedContactMap.value = new Map()\n  selectedTagIds.value = new Set()\n  csvNumbers.value = []"
assert old in c, 'A8'
c = c.replace(old, new, 1)

funcs = '''// ── v0.2.3 — Kontak tersimpan sebagai recipient (frontend-only; pipeline backend sama) ──
async function fetchContactsForPicker(reset = true) {
  loadingContacts.value = true
  try {
    const res = await axios.get(`${API}/api/contacts`, { params: { page: contactPage.value, q: contactSearch.value.trim() || undefined } })
    const list = res.data.contacts || []
    availableContacts.value = reset ? list : [...availableContacts.value, ...list]
    contactTotal.value = res.data.total || 0
  } catch (e) {
    console.error('Fetch contacts error:', e)
  } finally {
    loadingContacts.value = false
  }
}
function openContactsTab() {
  recipientTab.value = 'contacts'
  if (availableContacts.value.length === 0 && !loadingContacts.value) fetchContactsForPicker(true)
}
function onContactSearchInput() {
  clearTimeout(contactSearchTimer)
  contactSearchTimer = setTimeout(() => { contactPage.value = 1; fetchContactsForPicker(true) }, 250)
}
async function loadMoreContacts() {
  contactPage.value++
  await fetchContactsForPicker(false)
}
function isContactSelected(ct) { return selectedContactMap.value.has(ct.id) }
function toggleContact(ct) {
  const m = new Map(selectedContactMap.value)
  if (m.has(ct.id)) m.delete(ct.id)
  else m.set(ct.id, ct)
  selectedContactMap.value = m
}
const contactsPageAllSelected = computed(() =>
  availableContacts.value.length > 0 && availableContacts.value.every(ct => selectedContactMap.value.has(ct.id))
)
function selectAllContacts() {
  const m = new Map(selectedContactMap.value)
  if (contactsPageAllSelected.value) {
    for (const ct of availableContacts.value) m.delete(ct.id)
  } else {
    for (const ct of availableContacts.value) m.set(ct.id, ct)
  }
  selectedContactMap.value = m
}

function clearAllRecipients() {'''
assert 'function clearAllRecipients() {' in c, 'A9'
c = c.replace('function clearAllRecipients() {', funcs, 1)

old = "(chat list: {{ selectedChatIds.size }}, tags: {{ tagRecipientCount }}, CSV: {{ csvValidCount }})"
new = "(chat: {{ selectedChatIds.size }}, kontak: {{ selectedContactMap.size }}, tags: {{ tagRecipientCount }}, CSV: {{ csvValidCount }})"
assert old in c, 'A10'
c = c.replace(old, new, 1)

open(p, 'w').write(c)
print('PART A OK — BlastComposer (tab Kontak + pipeline merge)')

# ════════ B. BlastHistory — mobile cards + log table internal scroll ════════
p2 = 'frontend/src/views/BlastHistory.vue'
c2 = open(p2).read()

old = '''      <div v-if="!selectedBlast" class="bg-white rounded-lg shadow-sm overflow-hidden">
        <table class="w-full">'''
new = '''      <div v-if="!selectedBlast" class="bg-white rounded-lg shadow-sm overflow-hidden">
        <!-- v0.2.3 — mobile: kartu; desktop: tabel -->
        <div class="md:hidden divide-y divide-gray-100">
          <div v-if="loading" class="py-4 text-center text-gray-400 text-sm">Loading...</div>
          <div v-else-if="blasts.length === 0" class="p-8 text-center text-gray-400 text-sm">No blasts yet</div>
          <div v-for="b in blasts" :key="b.id" @click="viewBlast(b.id)" class="p-3 border-b border-gray-100 active:bg-gray-50 cursor-pointer">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <div class="text-sm font-medium truncate">{{ b.name || `Blast #${b.id}` }}</div>
                <div class="text-xs text-gray-500 truncate">{{ b.message }}</div>
                <div class="text-xs text-gray-400 mt-1">{{ formatDate(b.createdAt) }} · {{ b.createdByUser?.username || '-' }}</div>
              </div>
              <div class="text-right flex-shrink-0">
                <span :class="statusBadge(b.status)">{{ b.status }}</span>
                <div class="text-xs mt-1"><span class="text-green-600">{{ b.totalSent }}</span>/<span class="text-red-600">{{ b.totalFailed }}</span>/{{ b.totalRecipients }}</div>
              </div>
            </div>
          </div>
        </div>
        <div class="hidden md:block">
        <table class="w-full">'''
assert old in c2, 'B1'
c2 = c2.replace(old, new, 1)

old = '''            <button v-if="pagination.page < pagination.pages" @click="fetchBlasts(pagination.page + 1)" class="text-sm px-3 py-1 border border-gray-300 rounded-lg hover:bg-gray-50">Next →</button>
          </div>
        </div>
      </div>'''
new = '''            <button v-if="pagination.page < pagination.pages" @click="fetchBlasts(pagination.page + 1)" class="text-sm px-3 py-1 border border-gray-300 rounded-lg hover:bg-gray-50">Next →</button>
          </div>
        </div>
        </div>
      </div>'''
assert old in c2, 'B2'
c2 = c2.replace(old, new, 1)

old = '<div class="grid grid-cols-4 gap-4 mb-4">'
assert old in c2, 'B3'
c2 = c2.replace(old, '<div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">', 1)

old = '''          <table class="w-full">
            <thead class="bg-gray-50 border-b border-gray-200">
              <tr>
                <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Name</th>'''
new = '''          <div class="overflow-x-auto">
          <table class="w-full min-w-[640px]">
            <thead class="bg-gray-50 border-b border-gray-200">
              <tr>
                <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Name</th>'''
assert old in c2, 'B4'
c2 = c2.replace(old, new, 1)

old = '''          </table>

          <!-- Log Pagination -->'''
new = '''          </table>
          </div>

          <!-- Log Pagination -->'''
assert old in c2, 'B5'
c2 = c2.replace(old, new, 1)

open(p2, 'w').write(c2)
print('PART B OK — BlastHistory')

# ════════ C. Contacts — mobile cards, desktop table ═════════
p3 = 'frontend/src/views/Contacts.vue'
c3 = open(p3).read()

old = '''      <!-- Table -->
      <div class="bg-white rounded-lg shadow-sm overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full">'''
new = '''      <!-- v0.2.3 — mobile: kartu (tanpa scroll samping); desktop: tabel -->
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
          <table class="w-full">'''
assert old in c3, 'C1'
c3 = c3.replace(old, new, 1)
open(p3, 'w').write(c3)
print('PART C OK — Contacts mobile cards')

print('ALL PATCHES OK')