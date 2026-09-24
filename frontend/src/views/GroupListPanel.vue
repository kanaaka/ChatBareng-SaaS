<template>
  <!--
    v0.14.0 — Manajemen Grup: PANEL LIST (dipakai Groups.vue desktop + Contacts.vue tab Grup mobile).
    Matriks visibility (spec §3): PIC → miliknya; Admin → semua + yatim; lainnya → [].
    Tombol "+ Buat Grup" HIDDEN untuk role relay/Cabang (auth.user.role === 'relay').
    Grup yatim: badge "belum ada PIC" + tombol Assign PIC (admin only).
    Semua error API → ToastStack dengan pesan ramah (groupsApi.friendlyGroupError).
  -->
  <div class="space-y-4">
    <!-- Toolbar: header + tombol buat (hidden utk relay) -->
    <div class="bg-white rounded-lg shadow-sm p-4 flex items-center justify-between gap-3">
      <div class="min-w-0">
        <p class="text-sm text-gray-600">{{ listSubtitle }}</p>
      </div>
      <button
        v-if="!isRelay"
        @click="openCreate"
        class="m3-btn m3-btn--filled !min-h-[44px] !px-5 text-sm whitespace-nowrap"
      >
        + Buat Grup
      </button>
    </div>

    <!-- Loading / empty -->
    <div v-if="loading" class="bg-white rounded-lg shadow-sm p-8 text-center text-gray-400 text-sm">
      Memuat grup…
    </div>
    <div v-else-if="groups.length === 0" class="bg-white rounded-lg shadow-sm p-8 text-center">
      <div class="text-3xl mb-2">👥</div>
      <p class="text-sm text-gray-500">
        {{ isRelay ? 'Belum ada grup yang kamu jadi PIC.' : 'Belum ada grup.' }}
      </p>
      <p v-if="!isRelay && !auth.isAdmin" class="text-xs text-gray-400 mt-1">
        Buat grup baru dengan tombol "+ Buat Grup" — kamu otomatis jadi PIC.
      </p>
    </div>

    <!-- List grup -->
    <div v-else class="space-y-2">
      <!-- v3.9.10 — kartu stack vertikal selalu: dulu sm:flex-row bikin badge+tombol berebut baris dgn nama di pane w-96 → nama kepress 1-2 huruf -->
      <div
        v-for="g in groups"
        :key="g.id"
        class="bg-white rounded-lg shadow-sm p-4 flex flex-col gap-3 hover:bg-gray-50 transition-colors"
      >
        <!-- v3.9.10 — nama grup = baris sendiri full-width; badge yatim + tombol aksi
             pindah ke baris bawah (pane w-96 memeras nama jadi 1-2 huruf — lapor
             Kanaka 24 Sep: "nama grup nggak kebaca, atur pemosisian"). -->
        <button class="flex items-center gap-3 min-w-0 flex-1 text-left" @click="handleOpen(g)">
          <div class="w-11 h-11 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center text-lg flex-shrink-0">
            👥
          </div>
          <div class="min-w-0 flex-1">
            <div class="font-medium truncate">{{ g.name }}</div>
            <div class="text-xs text-gray-500 truncate">
              <span v-if="g.memberCount">👥 {{ g.memberCount }} member · </span>
              <span v-if="g.pic">@{{ g.pic.username }} · </span>
              <span v-if="g.unreadCount" class="text-wa-green font-semibold">{{ g.unreadCount }} baru · </span>
              <span>{{ g.lastMessageAt ? formatDateTime(g.lastMessageAt) : 'belum ada pesan' }}</span>
            </div>
          </div>
        </button>
        <div class="flex items-center gap-2 flex-wrap">
          <!-- v0.14.0 — grup yatim: badge "belum ada PIC" (admin only view) -->
          <span v-if="g.orphan" class="inline-flex items-center bg-amber-100 text-amber-700 text-[10px] px-2 py-0.5 rounded-full font-medium uppercase">
            belum ada PIC
          </span>
          <span class="flex-1"></span>
          <!-- Assign PIC (admin only — yatim ATAU ganti PIC) -->
          <button
            v-if="auth.isAdmin"
            @click="openAssignPic(g)"
            :class="['text-xs px-3 py-1.5 rounded font-medium', g.orphan ? 'bg-wa-green text-white active:bg-green-600' : 'bg-gray-100 text-gray-700 hover:bg-gray-200']"
          >
            {{ g.orphan ? 'Assign PIC' : 'Ganti PIC' }}
          </button>
          <button
            @click="handleOpen(g)"
            class="text-xs px-3 py-1.5 rounded bg-blue-100 text-blue-700 hover:bg-blue-200"
          >
            Buka
          </button>
        </div>
      </div>
    </div>

    <!-- ═══ Dialog Buat Grup (spec §6) ═══ -->
    <Teleport to="body">
      <div v-if="showCreate" class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div class="absolute inset-0 bg-black/50" @click="showCreate = false"></div>
        <div class="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto relative z-10">
          <div class="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
            <h3 class="font-semibold">Buat Grup Baru</h3>
            <button @click="showCreate = false" class="text-gray-400 hover:text-gray-600">✕</button>
          </div>
          <div class="p-4 space-y-4">
            <!-- CS: note "Kamu akan jadi PIC grup ini" -->
            <div v-if="auth.user?.role === 'cs'" class="bg-blue-50 border border-blue-100 rounded-lg px-3 py-2 text-xs text-blue-700">
              ℹ️ Kamu akan jadi PIC grup ini.
            </div>

            <M3TextField
              v-model="createForm.name"
              label="Nama grup (wajib)"
              maxlength="100"
              required
            />
            <M3TextField
              v-model="createForm.description"
              label="Deskripsi (opsional)"
              maxlength="500"
            />

            <!-- v0.14.1 — Anggota awal (opsional): picker shared (kontak+tag / paste / CSV) -->
            <div class="space-y-2">
              <p class="text-xs font-medium text-gray-600">Anggota awal (opsional)</p>
              <GroupMemberPicker v-model="createForm.phones" />
              <p class="text-[11px] text-gray-400">Format 62… / 08… — nomor gagal dilaporkan per-member. Kontak LID-only dikirim link undangan via chat pribadi.</p>
            </div>

            <!-- v3.9.6 — pilih nomor pembuat grup (jadi admin WA); default slot-0 -->
            <div v-if="waSlotsOptions.length" class="space-y-1">
              <label class="text-xs font-medium text-gray-600" for="group-slot-select">Nomor pembuat grup (jadi admin WA)</label>
              <select
                id="group-slot-select"
                v-model.number="createForm.slot"
                class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-wa-green"
              >
                <option v-for="s in waSlotsOptions" :key="s.slot" :value="s.slot">
                  {{ s.slot === 0 ? 'Nomor utama' : (s.label || ('Nomor ' + (s.slot + 1))) }}{{ s.phoneNumber ? ' (' + s.phoneNumber + ')' : '' }}{{ s.connected ? '' : ' — belum terhubung' }}
                </option>
              </select>
              <p class="text-[11px] text-gray-400">Nomor ini yang jadi admin grup di WhatsApp (add/kick/pengaturan lewat dia). Grup muncul di ChatBareng walau bot bukan admin.</p>
            </div>

            <!-- Admin: dropdown PIC (default: admin sendiri) -->
            <div v-if="auth.isAdmin" class="space-y-1">
              <label class="text-xs font-medium text-gray-600" for="group-pic-select">PIC grup</label>
              <select
                id="group-pic-select"
                v-model="createForm.picUserId"
                class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-wa-green"
              >
                <option :value="auth.user.id">{{ auth.user.username }} (saya, admin)</option>
                <option v-for="u in picCandidates" :key="u.id" :value="u.id">
                  {{ u.username }} ({{ roleLabel(u.role) }})
                </option>
              </select>
              <p class="text-[11px] text-gray-400">Cabang boleh dijadikan PIC oleh admin (tetap tidak bisa bikin grup lain).</p>
            </div>
          </div>
          <div class="p-4 border-t border-gray-200 flex justify-end gap-2">
            <button @click="showCreate = false" class="px-4 py-2 text-sm rounded-lg text-gray-600 hover:bg-gray-100">Batal</button>
            <button
              @click="submitCreate"
              :disabled="!createForm.name.trim() || creating"
              class="px-4 py-2 text-sm rounded-lg bg-wa-green text-white hover:bg-green-600 disabled:opacity-50"
            >
              {{ creating ? 'Membuat…' : 'Buat Grup' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ═══ Dialog Assign PIC (admin only) ═══ -->
    <Teleport to="body">
      <div v-if="assignTarget" class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div class="absolute inset-0 bg-black/50" @click="assignTarget = null"></div>
        <div class="bg-white rounded-xl shadow-2xl w-full max-w-sm relative z-10">
          <div class="px-4 py-3 border-b border-gray-200">
            <h3 class="font-semibold">{{ assignTarget.orphan ? 'Assign PIC' : 'Ganti PIC' }}</h3>
            <p class="text-xs text-gray-500 truncate mt-0.5">{{ assignTarget.name }}</p>
          </div>
          <div class="p-4 space-y-3">
            <div v-if="assignTarget.orphan" class="bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 text-xs text-amber-700">
              Grup ini dibuat orang dari luar ChatBareng (bot ditambahkan). Assign PIC untuk mengadopsinya.
            </div>
            <label class="text-xs font-medium text-gray-600" for="assign-pic-select">Pilih PIC</label>
            <select
              id="assign-pic-select"
              v-model="assignPicUserId"
              class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-wa-green"
            >
              <option v-for="u in picCandidates" :key="u.id" :value="u.id">
                {{ u.username }} ({{ roleLabel(u.role) }})
              </option>
            </select>
            <p v-if="assignError" class="text-xs text-red-600">{{ assignError }}</p>
          </div>
          <div class="p-4 border-t border-gray-200 flex justify-end gap-2">
            <button @click="assignTarget = null" class="px-4 py-2 text-sm rounded-lg text-gray-600 hover:bg-gray-100">Batal</button>
            <button
              @click="submitAssignPic"
              :disabled="!assignPicUserId || assigning"
              class="px-4 py-2 text-sm rounded-lg bg-wa-green text-white hover:bg-green-600 disabled:opacity-50"
            >
              {{ assigning ? 'Menyimpan…' : 'Simpan' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'
import { useSocketStore } from '../stores/socket'
import M3TextField from '../components/M3TextField.vue'
// v0.14.1 — picker anggota grup shared (kontak+tag / paste nomor / CSV)
import GroupMemberPicker from '../components/GroupMemberPicker.vue'
import { groupsClient, friendlyGroupError } from '../utils/groupsApi'

const props = defineProps({
  /** Deep-link: buka dialog assign PIC utk chatId ini (dari push notifikasi yatim) */
  autoAssignChatId: { type: String, default: null },
})

const emit = defineEmits(['open'])

const auth = useAuthStore()
const toast = useToastStore()
const socketStore = useSocketStore()
const isRelay = computed(() => auth.user?.role === 'relay')

const groups = ref([])
const loading = ref(false)
const picCandidates = ref([])

const listSubtitle = computed(() => {
  if (auth.isAdmin) return 'Semua grup + grup yatim (tanpa PIC)'
  return 'Grup yang kamu jadi PIC'
})

const showCreate = ref(false)
const creating = ref(false)
const createForm = ref({ name: '', description: '', phones: [], picUserId: null, slot: 0 })

// v3.9.6 — daftar nomor tenant utk dropdown pilih nomor pembuat grup
const waSlotsOptions = ref([])
async function fetchWaSlots() {
  try {
    const api = groupsClient(auth.token)
    const res = await api.get('/api/wa/status')
    const slots = res.data?.slots || []
    waSlotsOptions.value = slots.map(s => ({
      slot: Number(s.slot) || 0,
      label: s.label || null,
      phoneNumber: s.status?.phoneNumber || null,
      connected: !!s.status?.connected,
    }))
  } catch (e) {
    console.error('Fetch WA slots error:', e)
    waSlotsOptions.value = []
  }
}

const assignTarget = ref(null)
const assignPicUserId = ref(null)
const assignError = ref(null)
const assigning = ref(false)

function roleLabel(role) {
  if (role === 'admin') return 'Admin'
  if (role === 'relay') return 'Cabang'
  return 'CS'
}

function formatDateTime(value) {
  if (!value) return ''
  return new Date(value).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

// ─── Data ──────────────────────────────────────────────────────────────
async function fetchGroups() {
  loading.value = true
  try {
    const api = groupsClient(auth.token)
    const res = await api.get('/api/groups')
    groups.value = res.data.groups || []
  } catch (e) {
    console.error('Fetch groups error:', e)
    toast.show({ icon: '⚠️', title: 'Gagal memuat grup', message: friendlyGroupError(e, 'Gagal memuat daftar grup.') })
  } finally {
    loading.value = false
  }
}

/** Dropdown PIC (admin only): semua user aktif via /api/users. */
async function fetchPicCandidates() {
  if (!auth.isAdmin) return
  try {
    const api = groupsClient(auth.token)
    const res = await api.get('/api/users')
    picCandidates.value = (res.data.users || []).filter(u => u.status === 'active')
  } catch (e) {
    console.error('Fetch users error:', e)
    toast.show({ icon: '⚠️', title: 'Gagal memuat daftar PIC', message: friendlyGroupError(e) })
  }
}

// ─── Buat grup ─────────────────────────────────────────────────────────
function openCreate() {
  // v0.14.1 — phones: [] (array string final dari GroupMemberPicker; backend yang normalisasi)
  // v3.9.6 — slot: 0 default (nomor utama); fetch daftar slot on-open (fresh status)
  createForm.value = { name: '', description: '', phones: [], picUserId: auth.user.id, slot: 0 }
  fetchWaSlots()
  showCreate.value = true
}

async function submitCreate() {
  if (!createForm.value.name.trim() || creating.value) return
  creating.value = true
  try {
    const api = groupsClient(auth.token)
    const all = createForm.value.phones.map(p => p.trim()).filter(Boolean)
    const body = {
      subject: createForm.value.name.trim(),
      description: createForm.value.description.trim() || undefined,
      phones: all.filter(p => !p.includes('@')),
      // v0.14.7 — kontak LID-only (chatId "...@lid") → backend kirim link undangan 1:1
      lids: all.filter(p => p.includes('@')),
      // v3.9.6 — nomor pembuat grup (jadi admin WA)
      slot: Number(createForm.value.slot) || 0,
    }
    if (auth.isAdmin && createForm.value.picUserId) body.picUserId = createForm.value.picUserId
    const res = await api.post('/api/groups', body)
    const failed = (res.data.memberResults || []).filter(r => r.status === 'error')
    const viaLinkOk = (res.data.memberResults || []).filter(r => r.viaLink && r.status === 'ok').length
    const linkNote = viaLinkOk ? ` ${viaLinkOk} link undangan terkirim.` : ''
    if (failed.length) {
      toast.show({
        icon: '⚠️', title: 'Grup dibuat — sebagian anggota gagal',
        message: failed.map(r => `${r.phone}: ${r.error}`).join(' · ').slice(0, 160) + linkNote,
        timeout: 8000,
      })
    } else {
      toast.show({ icon: '✅', title: 'Grup dibuat', message: `"${res.data.group?.name}" siap dipakai.${linkNote}` })
    }
    showCreate.value = false
    await fetchGroups()
  } catch (e) {
    console.error('Create group error:', e)
    toast.show({ icon: '⚠️', title: 'Gagal membuat grup', message: friendlyGroupError(e, 'Gagal membuat grup.') })
  } finally {
    creating.value = false
  }
}

// ─── Assign PIC (admin) ────────────────────────────────────────────────
function openAssignPic(g) {
  assignError.value = null
  assignTarget.value = g
  assignPicUserId.value = g.picUserId ?? (picCandidates.value[0]?.id ?? null)
}

// v3.9.10 — Buka grup yatim = belum ada thread chat (belum di-adopt) → arahkan
// ke dialog Assign PIC dulu. Dulu: GET /api/chats/<jid-grup> → Number(NaN) →
// 500 "internal server error" (lapor Kanaka 24 Sep).
function handleOpen(g) {
  if (g.orphan) { openAssignPic(g); return }
  emit('open', g)
}

async function submitAssignPic() {
  if (!assignTarget.value || !assignPicUserId.value) return
  assigning.value = true
  try {
    const api = groupsClient(auth.token)
    await api.post(`/api/groups/${encodeURIComponent(assignTarget.value.id)}/assign-pic`, {
      picUserId: assignPicUserId.value,
    })
    toast.show({ icon: '✅', title: 'PIC ditetapkan', message: `"${assignTarget.value.name}" sekarang milik @${picCandidates.value.find(u => u.id === assignPicUserId.value)?.username || 'PIC baru'}.` })
    assignTarget.value = null
    await fetchGroups()
  } catch (e) {
    console.error('Assign PIC error:', e)
    assignError.value = friendlyGroupError(e, 'Gagal assign PIC.')
    toast.show({ icon: '⚠️', title: 'Gagal assign PIC', message: assignError.value })
  } finally {
    assigning.value = false
  }
}

// ─── Realtime: grup berubah di tempat lain (PIC/admin) ────────────────
function onGroupUpdate() {
  fetchGroups()
}

// v0.14.2 — badge "N baru" realtime (lapor Kanaka 10:16): chat_update grup
// (pesan masuk / mark-read) cukup update row terkait — tanpa refetch penuh.
// Event chat_update utk grup di-emit ke room PIC+admin (handler.js v0.14);
// /read juga broadcast chat_update unreadCount:0 → badge hilang tanpa refresh.
function onGroupChatUpdate(data) {
  const chatId = data?.chatId
  if (!chatId || !String(chatId).endsWith('@g.us')) return
  const g = groups.value.find(x => x.id === chatId)
  if (!g) return
  if (data.unreadCount !== undefined) g.unreadCount = data.unreadCount
  if (data.lastMessageAt !== undefined) g.lastMessageAt = data.lastMessageAt
  if (data.lastMessage !== undefined) g.lastMessagePreview = data.lastMessage
  if (data.status !== undefined) g.status = data.status
}

onMounted(() => {
  fetchGroups()
  fetchPicCandidates()
  socketStore.on('group_update', onGroupUpdate)
  socketStore.on('chat_update', onGroupChatUpdate)
})
onUnmounted(() => {
  socketStore.off('group_update', onGroupUpdate)
  socketStore.off('chat_update', onGroupChatUpdate)
})

// Deep-link assign (dari push yatim: /groups?assign=<chatId>)
watch(() => props.autoAssignChatId, (id) => {
  if (!id) return
  const g = groups.value.find(x => x.id === id)
  if (g) openAssignPic(g)
}, { immediate: true })
// List baru datang SETELAH deep-link (fetch async) → cek juga tiap list berubah.
// Konsumsi sekali: assignTarget ter-set → matikan permintaan (emit tidak ada; cukup
// tandai via variabel lokal agar tidak buka ulang di refetch berikutnya).
let assignDeepLinkConsumed = false
watch(groups, (list) => {
  const id = props.autoAssignChatId
  if (!id || !list.length || assignDeepLinkConsumed) return
  const g = list.find(x => x.id === id)
  if (g) {
    openAssignPic(g)
    assignDeepLinkConsumed = true
  }
})
</script>