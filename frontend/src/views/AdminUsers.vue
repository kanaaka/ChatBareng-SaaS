<template>
  <PageShell title="Users" back-to="/admin">
    <header class="hidden md:flex m3-topbar px-4 py-3 items-center justify-between">
      <div class="flex items-center gap-3">
        <h1 class="text-lg font-semibold">Users</h1>
      </div>
      <div class="flex items-center gap-4">
        <button @click="handleLogout" class="text-sm hover:underline">Logout</button>
      </div>
    </header>

    <div class="max-w-4xl mx-auto w-full p-6 space-y-4">
      <!-- Create User -->
      <div class="bg-white rounded-lg shadow-sm p-6">
        <h2 class="text-lg font-semibold mb-4">Create User</h2>
        <form @submit.prevent="createUser" class="flex gap-3 flex-wrap">
          <!-- v0.9.0-r2 (audit fix #1): M3TextField floating label -->
          <M3TextField v-model="newUser.username" label="Username" type="text" required autocomplete="off" class="flex-1 min-w-[150px]" />
          <M3TextField v-model="newUser.password" label="Password" type="password" required autocomplete="new-password" class="flex-1 min-w-[150px]" />
          <select v-model="newUser.role" class="px-3 py-2 border border-gray-300 rounded-lg text-sm">
            <option value="cs">CS</option>
            <option value="admin">Admin</option>
            <option value="relay">Cabang</option>
          </select>
          <button type="submit" class="m3-btn m3-btn--filled !min-h-[44px] !px-5 text-sm">
            Create
          </button>
        </form>
        <div v-if="createError" class="text-red-600 text-sm mt-2">{{ createError }}</div>
      </div>

      <!-- v0.3.0 — mobile: kartu; desktop: tabel (dengan scroll internal) -->
      <div class="md:hidden space-y-2">
        <div v-for="user in users" :key="user.id" class="bg-white rounded-lg shadow-sm p-3">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="text-sm font-medium truncate">{{ user.username }}</div>
              <div class="text-xs text-gray-400">{{ user.lastLogin ? new Date(user.lastLogin).toLocaleString() : 'Never login' }}</div>
            </div>
            <div class="flex items-center gap-2 flex-shrink-0">
              <span class="text-xs text-gray-500">{{ user.status === 'active' ? 'Active' : 'Inactive' }}</span>
              <button
                @click="toggleStatus(user)"
                :disabled="user.id === auth.user.id"
                role="switch"
                :aria-checked="user.status === 'active'"
                :class="['relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200', user.status === 'active' ? 'bg-wa-green' : 'bg-gray-300', user.id === auth.user.id ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer']"
              >
                <span :class="['inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200', user.status === 'active' ? 'translate-x-6' : 'translate-x-1']"></span>
              </button>
            </div>
          </div>
          <div class="flex items-center gap-2 mt-2">
            <span class="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 font-medium">{{ roleLabels[user.role] || user.role }}</span>
            <select
              :value="user.role"
              @change="updateUser(user.id, { role: $event.target.value })"
              class="text-sm border border-gray-200 rounded px-2 py-1"
            >
              <option value="cs">CS</option>
              <option value="admin">Admin</option>
              <option value="relay">Cabang</option>
            </select>
            <button
              v-if="user.id !== auth.user.id"
              @click="openResetPw(user)"
              class="text-xs px-2.5 py-1.5 rounded bg-gray-100 text-gray-700 active:bg-gray-200"
            >
              🔑 Reset PW
            </button>
            <button
              v-if="user.id !== auth.user.id"
              @click="deleteUser(user)"
              class="ml-auto text-xs px-2.5 py-1.5 rounded bg-red-100 text-red-700 active:bg-red-200"
            >
              Delete
            </button>
          </div>
        </div>
      </div>

      <div class="hidden md:block bg-white rounded-lg shadow-sm overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full min-w-[560px]">
            <thead class="bg-gray-50 border-b border-gray-200">
              <tr>
                <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Username</th>
                <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Role</th>
                <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
                <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Last Login</th>
                <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100">
              <tr v-for="user in users" :key="user.id" class="hover:bg-gray-50">
                <td class="px-4 py-3 text-sm">{{ user.username }}</td>
                <td class="px-4 py-3 text-xs text-gray-600">{{ roleLabels[user.role] || user.role }}</td>
                <td class="px-4 py-3">
                  <select
                    :value="user.role"
                    @change="updateUser(user.id, { role: $event.target.value })"
                    class="text-sm border border-gray-200 rounded px-2 py-1"
                  >
                    <option value="cs">CS</option>
                    <option value="admin">Admin</option>
                    <option value="relay">Cabang</option>
                  </select>
                </td>
                <td class="px-4 py-3">
                  <div class="flex items-center gap-2">
                    <span class="text-xs text-gray-500">{{ user.status === 'active' ? 'Active' : 'Inactive' }}</span>
                    <button
                      @click="toggleStatus(user)"
                      :disabled="user.id === auth.user.id"
                      role="switch"
                      :aria-checked="user.status === 'active'"
                      :class="['relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200', user.status === 'active' ? 'bg-wa-green' : 'bg-gray-300', user.id === auth.user.id ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer']"
                    >
                      <span :class="['inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200', user.status === 'active' ? 'translate-x-6' : 'translate-x-1']"></span>
                    </button>
                  </div>
                </td>
                <td class="px-4 py-3 text-xs text-gray-500">
                  {{ user.lastLogin ? new Date(user.lastLogin).toLocaleString() : 'Never' }}
                </td>
                <td class="px-4 py-3">
                  <div v-if="user.id !== auth.user.id" class="flex items-center gap-2">
                    <button
                      @click="openResetPw(user)"
                      class="text-xs px-2.5 py-1.5 rounded bg-gray-100 text-gray-700 hover:bg-gray-200"
                    >
                      🔑 Reset PW
                    </button>
                    <button
                      @click="deleteUser(user)"
                      class="text-xs px-2.5 py-1.5 rounded bg-red-100 text-red-700 hover:bg-red-200"
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- v0.12.2 — Dialog reset password (pola ScheduledDialog, token M3, aman dark mode) -->
    <Teleport to="body">
      <div v-if="resetPw.user" class="m3-dialog-backdrop" @click.self="closeResetPw">
        <div role="dialog" aria-modal="true" aria-label="Reset password" class="m3-dialog" style="max-width: 440px; width: calc(100vw - 32px);">
          <h2 class="m3-dialog__headline">🔑 Reset password</h2>
          <div class="m3-dialog__body">
            Ganti password user "{{ resetPw.user.username }}". User perlu diinfokan password barunya.
          </div>

          <div class="space-y-3 mb-2">
            <div>
              <label class="block text-xs font-medium text-[var(--md-sys-color-on-surface-variant)] mb-1">Username</label>
              <input
                :value="resetPw.user.username"
                type="text"
                readonly
                class="w-full px-3 py-2.5 border border-[var(--md-sys-color-outline)] rounded-lg text-sm text-[var(--md-sys-color-on-surface-variant)] bg-[var(--md-sys-color-surface-container)] opacity-80 cursor-not-allowed"
              />
            </div>
            <div>
              <label class="block text-xs font-medium text-[var(--md-sys-color-on-surface-variant)] mb-1">Password baru (min. 6 karakter)</label>
              <input
                ref="resetPwNew"
                v-model="resetPw.new"
                type="password"
                autocomplete="new-password"
                class="w-full px-3 py-2.5 border border-[var(--md-sys-color-outline)] rounded-lg text-sm text-[var(--md-sys-color-on-surface)] placeholder:text-[var(--md-sys-color-on-surface-variant)] focus:outline-none focus:ring-2 focus:ring-wa-green min-h-[44px]"
              />
            </div>
            <div>
              <label class="block text-xs font-medium text-[var(--md-sys-color-on-surface-variant)] mb-1">Konfirmasi password</label>
              <input
                v-model="resetPw.confirm"
                type="password"
                autocomplete="new-password"
                @keyup.enter="submitResetPw"
                class="w-full px-3 py-2.5 border border-[var(--md-sys-color-outline)] rounded-lg text-sm text-[var(--md-sys-color-on-surface)] placeholder:text-[var(--md-sys-color-on-surface-variant)] focus:outline-none focus:ring-2 focus:ring-wa-green min-h-[44px]"
              />
            </div>
          </div>

          <div v-if="resetPw.error" class="text-xs text-red-600 mb-2">{{ resetPw.error }}</div>

          <div class="m3-dialog__actions">
            <button type="button" class="m3-btn m3-btn--text" @click="closeResetPw">Batal</button>
            <button type="button" class="m3-btn m3-btn--filled" :disabled="resetPw.busy || !resetPw.canSubmit" @click="submitResetPw">
              {{ resetPw.busy ? 'Mereset...' : 'Reset' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </PageShell>
</template>

<script setup>
import axios from 'axios'
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import { useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'
import { useConfirm } from '../utils/confirm'
import PageShell from '../components/PageShell.vue'
import M3TextField from '../components/M3TextField.vue'

const API = import.meta.env.VITE_API_URL || ''
const auth = useAuthStore()
const toast = useToastStore()
const { confirmAction } = useConfirm()

// v0.5.0 — label mapping role (internal value tetap 'relay', label UI "Cabang")
const roleLabels = { admin: 'Admin', cs: 'CS', relay: 'Cabang' }

// Users (dipindah dari Admin.vue v0.1.x — logika tidak berubah)
const users = ref([])
const newUser = ref({ username: '', password: '', role: 'cs' })
const createError = ref('')

async function fetchUsers() {
  try {
    const res = await axios.get(`${API}/api/users`)
    users.value = res.data.users
  } catch (e) { console.error(e) }
}

async function createUser() {
  createError.value = ''
  try {
    await axios.post(`${API}/api/users`, newUser.value)
    newUser.value = { username: '', password: '', role: 'cs' }
    await fetchUsers()
  } catch (e) {
    createError.value = e.response?.data?.error || 'Failed to create user'
  }
}

async function updateUser(id, data) {
  try {
    await axios.put(`${API}/api/users/${id}`, data)
    await fetchUsers()
  } catch (e) { console.error(e) }
}

async function toggleStatus(user) {
  if (user.id === auth.user.id) return
  const next = user.status === 'active' ? 'inactive' : 'active'
  await updateUser(user.id, { status: next })
}

async function deleteUser(user) {
  // v0.9.0 — confirm() native → M3 dialog; handler delete TIDAK berubah
  const ok = await confirmAction({
    title: 'Hapus permanen user?',
    message: `Hapus permanen user "${user.username}"?\n\nAkun TIDAK bisa dipulihkan. Riwayat chat/blast tetap tersimpan, kepemilikan data pindah ke kamu.`,
    confirmText: 'Hapus',
    danger: true,
  })
  if (!ok) return
  try {
    await axios.delete(`${API}/api/users/${user.id}`)
    await fetchUsers()
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Gagal menghapus', message: e.response?.data?.error || e.message })
  }
}

onMounted(fetchUsers)

// ── v0.12.2 — Admin reset password user (backend PUT /api/users/:id sudah support field password) ──
const resetPw = reactive({
  user: null,
  new: '',
  confirm: '',
  busy: false,
  error: '',
})
const resetPwNew = ref(null)

const resetPwCanSubmit = computed(() => (resetPw.new || '').length >= 6 && resetPw.new === resetPw.confirm)
resetPw.canSubmit = resetPwCanSubmit

function openResetPw(user) {
  resetPw.user = user
  resetPw.new = ''
  resetPw.confirm = ''
  resetPw.error = ''
  resetPw.busy = false
  // fokus ke field password baru setelah dialog ter-mount (pola interaktif dialog)
  requestAnimationFrame(() => {
    if (resetPwNew.value) resetPwNew.value.focus()
  })
}

function closeResetPw() {
  resetPw.user = null
  resetPw.new = ''
  resetPw.confirm = ''
  resetPw.error = ''
}

function validateResetPw() {
  if ((resetPw.new || '').length < 6) {
    resetPw.error = 'Password minimal 6 karakter'
    return false
  }
  if (resetPw.new !== resetPw.confirm) {
    resetPw.error = 'Konfirmasi password tidak cocok'
    return false
  }
  return true
}

async function submitResetPw() {
  resetPw.error = ''
  if (!validateResetPw()) return
  resetPw.busy = true
  try {
    await axios.put(`${API}/api/users/${resetPw.user.id}`, { password: resetPw.new })
    toast.show({ icon: '🔑', title: 'Password direset', message: `Password ${resetPw.user.username} direset` })
    closeResetPw()
  } catch (e) {
    resetPw.error = e.response?.data?.error || 'Gagal reset password'
  } finally {
    resetPw.busy = false
  }
}

function onResetPwKeydown(e) {
  if (e.key === 'Escape' && resetPw.user) closeResetPw()
}
onMounted(() => document.addEventListener('keydown', onResetPwKeydown))
onUnmounted(() => document.removeEventListener('keydown', onResetPwKeydown))
</script>
