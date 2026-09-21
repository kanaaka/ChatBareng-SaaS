<template>
  <!--
    v0.14.0 — Manajemen Grup: PANEL MEMBER/SETTINGS (dipakai Groups.vue di sebelah
    ChatDetail; mobile: sheet di bawah). Aksi role-gated: PIC & admin (backend yang
    memutuskan — 403 → toast ramah). Bot bukan admin → toggle disabled + hint.
    Reset invite link WAJIB ConfirmDialog (link lama mati — spec §5).
  -->
  <div class="space-y-4">
    <!-- Header grup + rename -->
    <div class="bg-white rounded-lg shadow-sm p-4">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <h3 class="font-semibold truncate flex items-center gap-2">
            👥 {{ detail?.group?.name || chat?.contactName || 'Grup' }}
            <span v-if="detail?.group?.orphan" class="bg-amber-100 text-amber-700 text-[10px] px-2 py-0.5 rounded-full font-medium uppercase">belum ada PIC</span>
          </h3>
          <p class="text-xs text-gray-500 mt-0.5">
            PIC: @{{ detail?.group?.pic?.username || '—' }}
            <span v-if="detail?.description"> · {{ detail.description }}</span>
          </p>
        </div>
        <button
          v-if="canManage"
          @click="openRename"
          class="text-xs px-3 py-1.5 rounded bg-gray-100 text-gray-700 hover:bg-gray-200 flex-shrink-0"
        >✏️ Edit Info</button>
      </div>

      <!-- Rename dialog inline -->
      <div v-if="showRename" class="mt-3 space-y-2">
        <M3TextField v-model="renameForm.name" label="Nama grup" maxlength="100" />
        <M3TextField v-model="renameForm.description" label="Deskripsi" maxlength="500" />
        <div class="flex justify-end gap-2">
          <button @click="showRename = false" class="px-3 py-1.5 text-xs rounded text-gray-600 hover:bg-gray-100">Batal</button>
          <button
            @click="submitRename"
            :disabled="renaming || !renameForm.name.trim()"
            class="px-3 py-1.5 text-xs rounded bg-wa-green text-white hover:bg-green-600 disabled:opacity-50"
          >{{ renaming ? 'Menyimpan…' : 'Simpan' }}</button>
        </div>
      </div>
    </div>

    <!-- Banner: bot bukan admin (spec §3 — hint, bukan error mentah) -->
    <div v-if="detail && !detail.botIsAdmin" class="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-700">
      🤖🔒 Bot bukan admin di grup ini — aksi kelola (tambah/keluarkan member, ubah pengaturan) dinonaktifkan oleh WhatsApp.
    </div>

    <!-- Pengaturan grup (PIC/admin; disabled kalau bot bukan admin) -->
    <div class="bg-white rounded-lg shadow-sm p-4 space-y-3">
      <h4 class="text-sm font-semibold">Pengaturan</h4>
      <div class="flex items-center justify-between gap-3">
        <div>
          <p class="text-sm font-medium">Hanya admin yang bisa kirim pesan</p>
          <p class="text-xs text-gray-500">Mode pengumuman (announcement)</p>
        </div>
        <M3Switch
          :model-value="!!detail?.announcement"
          :disabled="!canManage || !detail?.botIsAdmin || settingsBusy"
          @update:model-value="v => updateSetting('announcement', v)"
        />
      </div>
      <div class="flex items-center justify-between gap-3">
        <div>
          <p class="text-sm font-medium">Info grup terkunci</p>
          <p class="text-xs text-gray-500">Hanya admin yang bisa ubah nama/deskripsi</p>
        </div>
        <M3Switch
          :model-value="!!detail?.locked"
          :disabled="!canManage || !detail?.botIsAdmin || settingsBusy"
          @update:model-value="v => updateSetting('locked', v)"
        />
      </div>
      <div class="flex items-center justify-between gap-3">
        <div>
          <p class="text-sm font-medium">Setujui anggota baru</p>
          <p class="text-xs text-gray-500">Join request perlu persetujuan admin</p>
        </div>
        <M3Switch
          :model-value="!!detail?.approval"
          :disabled="!canManage || !detail?.botIsAdmin || settingsBusy"
          @update:model-value="v => updateSetting('approval', v)"
        />
      </div>
      <div class="flex items-center justify-between gap-3">
        <div>
          <p class="text-sm font-medium">Semua member bisa tambah anggota</p>
          <p class="text-xs text-gray-500">Off = hanya admin yang bisa menambah member</p>
        </div>
        <M3Switch
          :model-value="!!detail?.memberAddMode"
          :disabled="!canManage || !detail?.botIsAdmin || settingsBusy"
          @update:model-value="v => updateSetting('memberAddMode', v)"
        />
      </div>
    </div>

    <!-- Invite link -->
    <div class="bg-white rounded-lg shadow-sm p-4 space-y-2">
      <h4 class="text-sm font-semibold">Link Invite</h4>
      <p v-if="detail?.inviteUrl" class="text-xs text-gray-600 break-all select-all">{{ detail.inviteUrl }}</p>
      <p v-else class="text-xs text-gray-400">Link invite belum tersedia (bot bukan admin di grup ini).</p>
      <button
        v-if="canManage"
        @click="confirmResetInvite"
        :disabled="!detail?.botIsAdmin || inviteBusy"
        class="text-xs px-3 py-1.5 rounded bg-red-50 text-red-600 border border-red-200 hover:bg-red-100 disabled:opacity-40"
      >{{ inviteBusy ? 'Meriset…' : '♻️ Reset Link (link lama mati)' }}</button>
    </div>

    <!-- Member list + aksi -->
    <div class="bg-white rounded-lg shadow-sm p-4 space-y-3">
      <div class="flex items-center justify-between">
        <h4 class="text-sm font-semibold">Member ({{ members.length }})</h4>
        <button
          v-if="canManage"
          @click="showAddMember = !showAddMember"
          class="text-xs px-3 py-1.5 rounded bg-wa-green text-white hover:bg-green-600"
        >+ Tambah Member</button>
      </div>

      <!-- Add member form (v0.14.1 — picker shared: kontak+tag / paste nomor / CSV) -->
      <div v-if="showAddMember" class="space-y-2 border border-gray-100 rounded-lg p-3">
        <GroupMemberPicker v-model="addPhones" />
        <div class="flex justify-end gap-2">
          <button @click="showAddMember = false; addPhones = []" class="px-3 py-1.5 text-xs rounded text-gray-600 hover:bg-gray-100">Batal</button>
          <button
            @click="submitMemberAction('add')"
            :disabled="membersBusy || addPhones.length === 0"
            class="px-3 py-1.5 text-xs rounded bg-wa-green text-white hover:bg-green-600 disabled:opacity-50"
          >{{ membersBusy ? 'Memproses…' : 'Tambah' }}</button>
        </div>
      </div>

      <!-- Partial-failure hasil terakhir -->
      <ul v-if="lastResults.length" class="text-xs space-y-1 border border-gray-100 rounded-lg p-3">
        <li v-for="(r, i) in lastResults" :key="i" :class="r.status === 'ok' ? 'text-green-700' : 'text-red-600'">
          {{ r.status === 'ok' ? '✅' : '⚠️' }} {{ r.phone }}{{ r.viaLink ? ' 🔗 link undangan' : '' }}{{ r.error ? ' — ' + r.error : '' }}
        </li>
        <li><button @click="lastResults = []" class="text-gray-400 hover:text-gray-600 underline">tutup</button></li>
      </ul>

      <div v-if="loadingDetail" class="text-center text-xs text-gray-400 py-2">Memuat member…</div>
      <ul v-else class="divide-y divide-gray-100">
        <li v-for="m in members" :key="m.jid" class="py-2 flex items-center justify-between gap-2">
          <div class="flex items-center gap-2 min-w-0">
            <div class="w-8 h-8 rounded-full bg-gray-100 text-gray-600 flex items-center justify-center text-xs font-semibold flex-shrink-0">
              {{ m.isBot ? '🤖' : (m.name || m.phone || '?').slice(0, 2).toUpperCase() }}
            </div>
            <div class="min-w-0">
              <p class="text-sm font-medium truncate">
                {{ m.name || m.phone || m.jid }}
                <span v-if="m.isBot" class="text-[10px] bg-blue-50 text-blue-600 px-1.5 rounded">bot</span>
              </p>
              <p class="text-xs text-gray-500">
                {{ m.isAdmin ? 'Admin grup · ' : '' }}+{{ m.phone || m.jid }}
              </p>
            </div>
          </div>
          <div v-if="canManage && !m.isBot" class="flex items-center gap-1 flex-shrink-0">
            <button
              v-if="!m.isAdmin"
              @click="submitMemberAction('promote', m.phone)"
              :disabled="membersBusy || !detail?.botIsAdmin"
              class="text-[11px] px-2 py-1 rounded bg-purple-50 text-purple-700 hover:bg-purple-100 disabled:opacity-40"
              title="Jadikan admin grup"
            >↑ Admin</button>
            <button
              v-else
              @click="submitMemberAction('demote', m.phone)"
              :disabled="membersBusy || !detail?.botIsAdmin"
              class="text-[11px] px-2 py-1 rounded bg-purple-50 text-purple-700 hover:bg-purple-100 disabled:opacity-40"
              title="Turunkan dari admin grup"
            >↓ Turunkan</button>
            <button
              @click="confirmRemoveMember(m)"
              :disabled="membersBusy || !detail?.botIsAdmin"
              class="text-[11px] px-2 py-1 rounded bg-red-50 text-red-600 hover:bg-red-100 disabled:opacity-40"
              title="Keluarkan dari grup"
            >✕</button>
          </div>
        </li>
      </ul>
    </div>

    <!-- Assign PIC (admin only) -->
    <div v-if="auth.isAdmin" class="bg-white rounded-lg shadow-sm p-4 space-y-2">
      <h4 class="text-sm font-semibold">PIC Grup</h4>
      <p class="text-xs text-gray-500">PIC = pemilik grup (baca, balas, kelola).</p>
      <div class="flex items-center gap-2">
        <select
          v-model="panelPicUserId"
          class="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-wa-green"
        >
          <option v-for="u in picCandidates" :key="u.id" :value="u.id">{{ u.username }} ({{ roleLabel(u.role) }})</option>
        </select>
        <button
          @click="submitAssignPic"
          :disabled="assigning || !panelPicUserId"
          class="px-4 py-2 text-xs rounded bg-wa-green text-white hover:bg-green-600 disabled:opacity-50"
        >{{ assigning ? 'Menyimpan…' : 'Assign PIC' }}</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'
import { useConfirm } from '../utils/confirm'
import { useSocketStore } from '../stores/socket'
import M3TextField from '../components/M3TextField.vue'
import M3Switch from '../components/M3Switch.vue'
// v0.14.1 hotfix — import hilang saat review → <GroupMemberPicker> tidak terdaftar
// → panel "+ Tambah Member" kosong tanpa form (lapor Kanaka 10:51)
import GroupMemberPicker from '../components/GroupMemberPicker.vue'
import { groupsClient, friendlyGroupError } from '../utils/groupsApi'

const props = defineProps({
  /** Chat.id grup (@g.us) — sumber data GET /api/groups/:id */
  chatId: { type: String, required: true },
  /** Baris chat utk fallback nama (saat detail masih loading) */
  chat: { type: Object, default: null },
})

const emit = defineEmits(['changed'])

const auth = useAuthStore()
const toast = useToastStore()
const socketStore = useSocketStore()
const { confirmAction } = useConfirm()

const detail = ref(null)
const loadingDetail = ref(false)
const picCandidates = ref([])
const panelPicUserId = ref(null)

const showRename = ref(false)
const renameForm = ref({ name: '', description: '' })
const renaming = ref(false)

const settingsBusy = ref(false)
const inviteBusy = ref(false)
const membersBusy = ref(false)
const assigning = ref(false)
const lastResults = ref([])

const showAddMember = ref(false)
// v0.14.1 — addPhones: array string final (awalnya [] — dulu [''] placeholder baris kosong)
const addPhones = ref([])

const members = computed(() => detail.value?.members || [])
const canManage = computed(() => auth.isAdmin || detail.value?.group?.picUserId === auth.user.id)

function roleLabel(role) {
  if (role === 'admin') return 'Admin'
  if (role === 'relay') return 'Cabang'
  return 'CS'
}

// ─── Data ──────────────────────────────────────────────────────────────
async function fetchDetail(silent = false) {
  if (!silent) loadingDetail.value = true
  try {
    const api = groupsClient(auth.token)
    const res = await api.get(`/api/groups/${encodeURIComponent(props.chatId)}`)
    detail.value = res.data
    panelPicUserId.value = res.data?.group?.picUserId ?? panelPicUserId.value
  } catch (e) {
    console.error('Group detail error:', e)
    if (!silent) toast.show({ icon: '⚠️', title: 'Gagal memuat grup', message: friendlyGroupError(e, 'Gagal memuat detail grup.') })
  } finally {
    loadingDetail.value = false
  }
}

async function fetchPicCandidates() {
  if (!auth.isAdmin) return
  try {
    const api = groupsClient(auth.token)
    const res = await api.get('/api/users')
    picCandidates.value = (res.data.users || []).filter(u => u.status === 'active')
  } catch (e) {
    console.error('Fetch users error:', e)
  }
}

// ─── Rename ────────────────────────────────────────────────────────────
function openRename() {
  renameForm.value = {
    name: detail.value?.group?.name || '',
    description: detail.value?.description || '',
  }
  showRename.value = true
}

async function submitRename() {
  if (renaming.value || !renameForm.value.name.trim()) return
  renaming.value = true
  try {
    const api = groupsClient(auth.token)
    await api.patch(`/api/groups/${encodeURIComponent(props.chatId)}`, {
      name: renameForm.value.name.trim(),
      description: renameForm.value.description.trim(),
    })
    toast.show({ icon: '✅', title: 'Info grup diubah' })
    showRename.value = false
    await fetchDetail(true)
    emit('changed')
  } catch (e) {
    console.error('Rename error:', e)
    toast.show({ icon: '⚠️', title: 'Gagal mengubah info grup', message: friendlyGroupError(e, 'Gagal mengubah info grup.') })
  } finally {
    renaming.value = false
  }
}

// ─── Settings toggle ───────────────────────────────────────────────────
async function updateSetting(key, value) {
  if (settingsBusy.value) return
  settingsBusy.value = true
  const prev = { ...detail.value }
  // Optimistic UI — revert kalau gagal
  detail.value = { ...detail.value, [key]: value }
  try {
    const api = groupsClient(auth.token)
    const body = {}
    if (key === 'memberAddMode') body.memberAddMode = value ? 'all_member_add' : 'admin_add'
    else body[key] = value
    const res = await api.post(`/api/groups/${encodeURIComponent(props.chatId)}/settings`, body)
    if (res.data?.failed?.length) {
      toast.show({ icon: '⚠️', title: 'Sebagian pengaturan gagal', message: friendlyGroupError({ response: { status: 422, data: { error: res.data.failed[0].message } } }) })
    } else {
      toast.show({ icon: '✅', title: 'Pengaturan disimpan' })
    }
  } catch (e) {
    detail.value = prev // revert
    console.error('Setting error:', e)
    toast.show({ icon: '⚠️', title: 'Gagal mengubah pengaturan', message: friendlyGroupError(e, 'Gagal mengubah pengaturan.') })
  } finally {
    settingsBusy.value = false
  }
}

// ─── Invite reset (ConfirmDialog wajib — spec §5) ──────────────────────
async function confirmResetInvite() {
  const ok = await confirmAction({
    title: 'Reset link invite?',
    message: 'Link invite LAMA akan mati dan diganti link baru. Siapa pun yang memegang link lama tidak bisa lagi masuk lewat link itu.',
    confirmText: 'Reset Link',
    danger: true,
  })
  if (!ok) return
  inviteBusy.value = true
  try {
    const api = groupsClient(auth.token)
    const res = await api.post(`/api/groups/${encodeURIComponent(props.chatId)}/invite-reset`)
    toast.show({ icon: '🔗', title: 'Link invite direset', message: res.data?.inviteUrl || 'Link baru aktif.' })
    await fetchDetail(true)
  } catch (e) {
    console.error('Invite reset error:', e)
    toast.show({ icon: '⚠️', title: 'Gagal reset link invite', message: friendlyGroupError(e, 'Gagal reset link invite.') })
  } finally {
    inviteBusy.value = false
  }
}

// ─── Member actions (add/remove/promote/demote — partial failure) ─────
async function submitMemberAction(action, singlePhone = null) {
  if (membersBusy.value) return
  let phones = []
  let lids = [] // v0.14.7 — chatId "...@lid" (kontak LID-only) → link undangan 1:1
  if (singlePhone) phones = [singlePhone]
  else {
    const all = addPhones.value.map(p => p.trim()).filter(Boolean)
    // v0.14.7 — string ber-@ = chat jid (kontak LID-only) → link undangan 1:1
    phones = all.filter(p => !p.includes('@'))
    lids = all.filter(p => p.includes('@'))
    if (!phones.length && !lids.length) return
  }
  if (action === 'remove') {
    const m = members.value.find(x => x.phone === singlePhone)
    const ok = await confirmAction({
      title: 'Keluarkan member?',
      message: `Keluarkan ${m?.name || '+' + singlePhone} dari grup ini?`,
      confirmText: 'Keluarkan',
      danger: true,
    })
    if (!ok) return
  }
  membersBusy.value = true
  try {
    const api = groupsClient(auth.token)
    const payload = { phones, action }
    if (action === 'add' && lids.length) payload.lids = lids // v0.14.7 — link undangan
    const res = await api.post(`/api/groups/${encodeURIComponent(props.chatId)}/members`, payload)
    const results = res.data?.results || []
    lastResults.value = results
    const failed = results.filter(r => r.status === 'error')
    if (failed.length) {
      toast.show({
        icon: '⚠️', title: 'Sebagian aksi member gagal',
        message: failed.map(r => `${r.phone}: ${r.error}`).join(' · ').slice(0, 160),
        timeout: 8000,
      })
    } else {
      const labelMap = { add: 'ditambahkan', remove: 'dikeluarkan', promote: 'dijadikan admin', demote: 'diturunkan' }
      const total = phones.length + (action === 'add' ? lids.length : 0)
      const linkNote = (action === 'add' && lids.length) ? ` (${lids.length} via link undangan)` : ''
      toast.show({ icon: '✅', title: 'Berhasil', message: `${total} member ${labelMap[action] || action}${linkNote}.` })
      if (!singlePhone) { showAddMember.value = false; addPhones.value = [] }
    }
    await fetchDetail(true)
    emit('changed')
  } catch (e) {
    console.error('Member action error:', e)
    toast.show({ icon: '⚠️', title: 'Gagal memproses member', message: friendlyGroupError(e, 'Gagal memproses member.') })
  } finally {
    membersBusy.value = false
  }
}

async function confirmRemoveMember(m) {
  await submitMemberAction('remove', m.phone)
}

// ─── Assign PIC (admin only) ───────────────────────────────────────────
async function submitAssignPic() {
  if (assigning.value || !panelPicUserId.value) return
  assigning.value = true
  try {
    const api = groupsClient(auth.token)
    await api.post(`/api/groups/${encodeURIComponent(props.chatId)}/assign-pic`, { picUserId: panelPicUserId.value })
    toast.show({ icon: '✅', title: 'PIC ditetapkan', message: `PIC baru: @${picCandidates.value.find(u => u.id === panelPicUserId.value)?.username || ''}` })
    await fetchDetail(true)
    emit('changed')
  } catch (e) {
    console.error('Assign PIC error:', e)
    toast.show({ icon: '⚠️', title: 'Gagal assign PIC', message: friendlyGroupError(e, 'Gagal assign PIC.') })
  } finally {
    assigning.value = false
  }
}

// ─── Realtime ──────────────────────────────────────────────────────────
function onGroupUpdate() {
  fetchDetail(true)
}

watch(() => props.chatId, (id) => {
  if (!id) return
  detail.value = null
  showAddMember.value = false
  lastResults.value = []
  addPhones.value = [] // v0.14.1 — array string (picker), bukan placeholder baris kosong
  fetchDetail()
  fetchPicCandidates()
})

onMounted(() => {
  fetchDetail()
  fetchPicCandidates()
  socketStore.on('group_update', onGroupUpdate)
})
onUnmounted(() => {
  socketStore.off('group_update', onGroupUpdate)
})
</script>