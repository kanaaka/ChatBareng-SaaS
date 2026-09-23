<template>
  <!--
    v0.2.0 KebabMenu (⋮) — semua aksi chat dipindah ke sini (spec §3.3).
    - Mobile: slide-up sheet (drag-handle + ✕), pola WhatsApp/Telegram.
    - Desktop: dropdown anchor kanan-atas (konsisten perilaku dua viewport).
    Handler TIDAK diubah: parent emit event yang memanggil fungsi existing
    (handleTransfer/handleRelease via confirm dialog existing/handleResolve/TK).

    v0.5.0 — Transfer list upgrade:
    - Fetch fresh /api/users/agents SETIAP KALI menu transfer dibuka.
    - Badge role (CS/Admin/Cabang) + titik hijau online (store presence live).
    - Entry offline (hanya terlihat oleh admin — server memfilter non-admin)
      di-disable; admin bisa centang "Assign paksa (user offline)" untuk tetap transfer.
  -->
  <!-- Desktop dropdown -->
  <div v-if="!isMobile" class="relative">
    <button
      @click.stop="open = !open"
      class="m3-icon-btn !w-10 !h-10"
      title="Menu chat"
    >
      <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 5v.01M12 12v.01M12 19v.01" />
      </svg>
    </button>
    <div v-if="open" @click.stop class="m3-menu absolute right-0 top-full mt-1 z-40 min-w-[240px]">
      <!-- v0.10.0 — Fitur A: Snooze (spec §1: item di atas Transfer) -->
      <button
        v-if="!isSnoozed"
        @click="chooseSnooze()"
        class="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
      >
        😴 Snooze
      </button>
      <button
        v-else
        @click="chooseCancelSnooze()"
        class="w-full text-left px-3 py-2 text-sm text-amber-600 hover:bg-amber-50 font-medium"
      >
        😴 Batalkan snooze
      </button>
      <div class="border-t border-gray-100 my-1"></div>
      <div class="px-3 py-1 text-[10px] uppercase text-gray-400 tracking-wide">Transfer ke agent</div>
      <div
        v-for="user in visibleUsers"
        :key="user.id"
        @click="chooseTransfer(user)"
        :class="['w-full text-left px-3 py-2 text-sm flex items-center justify-between', isEntryDisabled(user) ? 'cursor-not-allowed' : 'hover:bg-gray-50 cursor-pointer']"
      >
        <span class="flex items-center gap-2 min-w-0" :class="isEntryDisabled(user) ? 'text-gray-300' : 'text-gray-700'">
          <span :class="['w-2 h-2 rounded-full flex-shrink-0', presence.isOnline(user.id) ? 'bg-green-500' : 'bg-gray-300']"></span>
          <span class="truncate">@{{ user.username }}</span>
          <span :class="['text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0', roleBadgeClass(user.role)]">{{ roleLabel(user.role) }}</span>
        </span>
        <span v-if="user.id === currentAssigneeId" class="text-xs text-gray-400 flex-shrink-0">(current)</span>
        <span v-else-if="isEntryDisabled(user)" class="text-xs text-gray-400 flex-shrink-0">offline</span>
      </div>
      <div v-if="!visibleUsers.length" class="px-3 py-2 text-xs text-gray-400">Tidak ada agent online</div>
      <!-- v0.5.0 — opsi assign paksa (admin saja, target offline) -->
      <label v-if="auth.isAdmin" class="flex items-center gap-2 px-3 py-2 text-xs text-gray-500 border-t border-gray-100 cursor-pointer select-none">
        <input v-model="forceAssign" type="checkbox" class="accent-wa-green" />
        Assign paksa (user offline)
      </label>
      <div class="border-t border-gray-100 my-1"></div>
      <button
        v-if="chat?.assignedTo"
        @click="chooseRelease()"
        class="w-full text-left px-3 py-2 text-sm text-orange-600 hover:bg-orange-50 font-medium"
      >
        Release ke Antrean
      </button>
      <button
        v-if="chat?.status === 'open'"
        @click="chooseResolve()"
        class="w-full text-left px-3 py-2 text-sm text-green-700 hover:bg-green-50 font-semibold"
      >
        Resolve Chat
      </button>
      <div class="border-t border-gray-100 my-1"></div>
      <button @click="chooseTanganKanan()" class="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
        📎 Tangan Kanan
      </button>
      <!-- v3.7 — Hapus Chat: DUA pilihan terpisah (paling bawah, admin only):
           keep kontak (default) vs hapus kontak (behavior v3.6). Payload flag
           deleteContact diteruskan sampai Dashboard (jangan hilang di emit chain). -->
      <template v-if="auth.isAdmin">
        <div class="border-t border-gray-100 my-1"></div>
        <button
          @click="chooseDeleteChat(false)"
          class="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50"
        >
          🗑️ Hapus Chat
        </button>
        <button
          @click="chooseDeleteChat(true)"
          class="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50"
        >
          🗑️ Hapus Chat + Kontak
        </button>
      </template>
    </div>
  </div>

  <!-- Mobile trigger -->
  <button
    v-else
    @click.stop="open = true"
    class="m3-icon-btn -mr-2 !w-10 !h-10"
    title="Menu chat"
  >
    <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 5v.01M12 12v.01M12 19v.01" />
    </svg>
  </button>

  <!-- Mobile sheet -->
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="open && isMobile" class="fixed inset-0 bg-black/40 z-50 md:hidden" @click="open = false"></div>
    </Transition>
    <Transition name="sheet">
      <div
        v-if="open && isMobile"
        class="fixed left-0 right-0 bottom-0 z-50 bg-white rounded-t-2xl shadow-2xl md:hidden max-h-[85vh] flex flex-col"
        style="padding-bottom: env(safe-area-inset-bottom, 0px);"
      >
        <!-- Drag handle -->
        <div class="pt-2 pb-1 flex justify-center">
          <div class="w-10 h-1 rounded-full bg-gray-300"></div>
        </div>
        <div class="px-4 py-2 flex items-center justify-between border-b border-gray-100">
          <span class="font-semibold text-sm text-gray-800">Menu chat</span>
          <button @click="open = false" class="m3-icon-btn !w-9 !h-9">✕</button>
        </div>

        <div class="overflow-y-auto flex-1">
          <!-- v0.10.0 — Fitur A: Snooze (mobile sheet, di atas Transfer) -->
          <button
            v-if="!isSnoozed"
            @click="chooseSnooze()"
            class="w-full px-4 py-3 text-left text-base text-gray-800 active:bg-gray-50"
          >
            😴 Snooze
          </button>
          <button
            v-else
            @click="chooseCancelSnooze()"
            class="w-full px-4 py-3 text-left text-base text-amber-600 active:bg-amber-50 font-medium"
          >
            😴 Batalkan snooze
          </button>
          <div class="border-t border-gray-100 my-1"></div>
          <!-- Transfer submenu inline -->
          <div class="px-4 pt-3 pb-1 text-xs font-semibold text-gray-500 uppercase tracking-wide">
            Transfer ke agent
          </div>
          <button
            v-for="user in visibleUsers"
            :key="user.id"
            @click="chooseTransfer(user)"
            :class="['w-full px-4 py-3 text-left text-base flex items-center justify-between', isEntryDisabled(user) ? 'cursor-not-allowed' : 'active:bg-gray-50']"
          >
            <span class="flex items-center gap-2 min-w-0" :class="isEntryDisabled(user) ? 'text-gray-300' : 'text-gray-800'">
              <span :class="['w-2.5 h-2.5 rounded-full flex-shrink-0', presence.isOnline(user.id) ? 'bg-green-500' : 'bg-gray-300']"></span>
              <span class="truncate">@{{ user.username }}</span>
              <span :class="['text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0', roleBadgeClass(user.role)]">{{ roleLabel(user.role) }}</span>
            </span>
            <span v-if="user.id === currentAssigneeId" class="text-xs text-gray-400 flex-shrink-0">(current)</span>
            <span v-else-if="isEntryDisabled(user)" class="text-xs text-gray-400 flex-shrink-0">offline</span>
          </button>
          <div v-if="!visibleUsers.length" class="px-4 py-3 text-sm text-gray-400">Tidak ada agent online</div>
          <label v-if="auth.isAdmin" class="flex items-center gap-2 px-4 py-2 text-xs text-gray-500 cursor-pointer select-none">
            <input v-model="forceAssign" type="checkbox" class="accent-wa-green" />
            Assign paksa (user offline)
          </label>

          <div class="border-t border-gray-100 my-1"></div>
          <button
            v-if="chat?.assignedTo"
            @click="chooseRelease()"
            class="w-full px-4 py-3 text-left text-base text-orange-600 active:bg-orange-50 font-medium"
          >
            Release ke Antrean
          </button>
          <button
            v-if="chat?.status === 'open'"
            @click="chooseResolve()"
            class="w-full px-4 py-3 text-left text-base text-green-700 active:bg-green-50 font-semibold"
          >
            Resolve Chat
          </button>
          <div class="border-t border-gray-100 my-1"></div>
          <button @click="chooseTanganKanan()" class="w-full px-4 py-3 text-left text-base text-gray-800 active:bg-gray-50">
            📎 Tangan Kanan
          </button>
          <!-- v3.7 — Hapus Chat: DUA pilihan (mobile sheet, admin only) —
               SAMAKAN dgn desktop dropdown (sejarah bug cuma satu yg ke-update). -->
          <template v-if="auth.isAdmin">
            <div class="border-t border-gray-100 my-1"></div>
            <button
              @click="chooseDeleteChat(false)"
              class="w-full px-4 py-3 text-left text-base text-red-600 active:bg-red-50"
            >
              🗑️ Hapus Chat
            </button>
            <button
              @click="chooseDeleteChat(true)"
              class="w-full px-4 py-3 text-left text-base text-red-600 active:bg-red-50"
            >
              🗑️ Hapus Chat + Kontak
            </button>
          </template>
          <div class="h-2"></div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import axios from 'axios'
import { useAuthStore } from '../stores/auth'
import { usePresenceStore } from '../stores/presence'

const props = defineProps({
  chat: { type: Object, default: null },
  transferUsers: { type: Array, default: () => [] },
  // canTransfer: chat assigned & (owner atau admin) — parent kontrol visibilitas opsi
  // v0.10.0 — Fitur A: status snooze aktif (untuk toggle menu item)
  isSnoozed: { type: Boolean, default: false },
})
const emit = defineEmits(['transfer', 'release', 'resolve', 'tangan-kanan', 'snooze', 'cancel-snooze', 'delete-chat'])

const auth = useAuthStore()
const presence = usePresenceStore()

const open = ref(false)
const isMobile = ref(typeof window !== 'undefined' ? window.innerWidth < 768 : false)

// v0.5.0 — assign paksa (admin only) utk target offline
const forceAssign = ref(false)

// v0.5.0 — fresh fetch agents SETIAP KALI menu dibuka (spec Fitur 1 poin 14).
// Fallback kalau fetch gagal: pakai props.transferUsers yang di-pass parent.
function fetchFreshAgents() {
  axios.get('/api/users/agents')
    .then((res) => {
      if (Array.isArray(res.data.users)) {
        // parent state tetap sumber untuk prop, tapi list dropdown lokal pakai fresh
        freshUsers.value = res.data.users
      }
    })
    .catch(() => {})
}
const freshUsers = ref([])
const displayUsers = computed(() => (freshUsers.value.length ? freshUsers.value : props.transferUsers))

// Defense-in-depth (server juga memfilter): relay hanya boleh lihat cs/admin
const visibleUsers = computed(() => {
  if (auth.isRelay) return displayUsers.value.filter(u => u.role === 'cs' || u.role === 'admin')
  return displayUsers.value
})

const currentAssigneeId = computed(() => props.chat?.assignedToId ?? null)

// Entry disabled: offline dan (bukan admin ATAU admin tidak centang assign paksa)
function isEntryDisabled(user) {
  if (user.id === currentAssigneeId.value) return false // (current) selalu disabled click sendiri via guard
  if (presence.isOnline(user.id)) return false
  return !(auth.isAdmin && forceAssign.value)
}

const roleLabels = { admin: 'Admin', cs: 'CS', relay: 'Cabang' }
function roleLabel(role) {
  return roleLabels[role] || role
}
function roleBadgeClass(role) {
  if (role === 'admin') return 'bg-purple-100 text-purple-700'
  if (role === 'relay') return 'bg-amber-100 text-amber-700'
  return 'bg-blue-100 text-blue-700'
}

function chooseTransfer(user) {
  if (user.id === props.chat?.assignedToId) return
  if (isEntryDisabled(user)) return
  open.value = false
  forceAssign.value = false
  emit('transfer', user.id)
}
function chooseRelease() {
  open.value = false
  emit('release')
}
function chooseResolve() {
  open.value = false
  emit('resolve')
}
function chooseTanganKanan() {
  open.value = false
  emit('tangan-kanan')
}
// v0.10.0 — Fitur A: Snooze / batal snooze
function chooseSnooze() {
  open.value = false
  emit('snooze')
}
function chooseCancelSnooze() {
  open.value = false
  emit('cancel-snooze')
}
// v3.6/v3.7 — Hapus Chat (admin only): tutup menu lalu emit dgn payload flag
// deleteContact (false = keep kontak, true = kontak ikut terhapus)
function chooseDeleteChat(deleteContact) {
  open.value = false
  emit('delete-chat', deleteContact)
}

function onResize() {
  isMobile.value = window.innerWidth < 768
}

// v0.5.0 — setiap menu dibuka → fetch fresh + reset force flag
watch(open, (val) => {
  if (val) {
    forceAssign.value = false
    fetchFreshAgents()
  }
})

onMounted(() => {
  window.addEventListener('resize', onResize)
  presence.subscribe()
  // v0.10.3 — desktop dropdown: tutup saat tap di luar (mobile sheet sudah punya backdrop)
  document.addEventListener('click', onDocClick)
})
onUnmounted(() => {
  window.removeEventListener('resize', onResize)
  document.removeEventListener('click', onDocClick)
})
function onDocClick() {
  if (open.value) open.value = false
}
</script>
