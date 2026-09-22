<template>
  <!--
    v3.0 Phase 1 — Superadmin platform (minimal):
    daftar tenant (nama, status, #user, #chat) + buat Tenant + buat Admin per tenant +
    suspend/activate. Style konsisten (max-w-4xl, card, hijau WA). super_admin saja.
    v3.1.1 — panel Akun: ganti password mandiri (superadmin sengaja tidak punya
    akses /settings → self-service change-password v0.12.2 dipasang di sini).
  -->
  <div class="min-h-screen bg-surface">
    <div class="max-w-4xl mx-auto px-4 py-8">
      <!-- Header -->
      <div class="flex items-center justify-between mb-6">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-[var(--md-sys-shape-corner-m)] flex items-center justify-center"
            style="background: #25D366;">
            <svg class="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm5 13.6c-.2.6-1.2 1.2-1.7 1.2-.4.1-1 .1-1.6-.1-.4-.1-.9-.3-1.5-.5-2.6-1.1-4.3-3.7-4.4-3.9-.1-.2-1-1.4-1-2.6 0-1.2.6-1.8.9-2 .2-.3.5-.3.7-.3h.5c.2 0 .4 0 .6.4l.8 2c.1.2.1.4 0 .6l-.4.6c-.1.2-.3.4-.1.7.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.3 2.4 1.5.3.1.5.1.6-.1l.8-1c.2-.2.4-.2.6-.1l1.9.9c.4.2.4.4.4.6 0 .2 0 .7-.5 1z"/>
            </svg>
          </div>
          <div>
            <h1 class="text-2xl font-bold" :style="{ color: 'var(--md-sys-color-on-surface)' }">Superadmin</h1>
            <p class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
              Platform multi-tenant — @{{ auth.user?.username }}
            </p>
          </div>
        </div>
        <button
          class="m3-btn m3-btn--tonal !min-h-[40px]"
          @click="handleLogout"
        >Keluar</button>
      </div>

      <!-- Stats -->
      <div v-if="stats" class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <div class="sa-card">
          <div class="sa-stat">{{ stats.tenants }}</div>
          <div class="sa-label">Tenant</div>
        </div>
        <div class="sa-card">
          <div class="sa-stat">{{ stats.activeTenants }}</div>
          <div class="sa-label">Aktif</div>
        </div>
        <div class="sa-card">
          <div class="sa-stat">{{ stats.users }}</div>
          <div class="sa-label">User</div>
        </div>
        <div class="sa-card">
          <div class="sa-stat">{{ stats.chats }}</div>
          <div class="sa-label">Chat</div>
        </div>
        <div class="sa-card">
          <div class="sa-stat">{{ stats.messages }}</div>
          <div class="sa-label">Pesan</div>
        </div>
      </div>

      <!-- Form + Tenant -->
      <div class="sa-panel">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-lg font-semibold" :style="{ color: 'var(--md-sys-color-on-surface)' }">Daftar Tenant</h2>
          <button
            class="m3-btn m3-btn--filled !min-h-[40px]"
            @click="showCreate = !showCreate"
          >+ Tenant</button>
        </div>

        <!-- Create tenant form -->
        <div v-if="showCreate" class="sa-form">
          <M3TextField v-model="newTenantName" label="Nama tenant (perusahaan)" type="text" />
          <div class="flex gap-2 justify-end mt-2">
            <button class="m3-btn m3-btn--text !min-h-[40px]" @click="showCreate = false">Batal</button>
            <button class="m3-btn m3-btn--filled !min-h-[40px]" :disabled="creating" @click="createTenant">
              {{ creating ? 'Membuat…' : 'Buat Tenant' }}
            </button>
          </div>
        </div>

        <div v-if="error" class="flex items-start gap-2 text-sm rounded-[var(--md-sys-shape-corner-s)] p-3 mb-4"
          style="background: var(--md-sys-color-error-container); color: var(--md-sys-color-on-error-container);"
          role="alert">
          <span aria-hidden="true">⚠️</span>
          <span>{{ error }}</span>
        </div>

        <!-- Tenant list -->
        <div v-if="loading" class="sa-empty">Memuat…</div>
        <div v-else-if="tenants.length === 0" class="sa-empty">
          Belum ada tenant. Klik <strong>+ Tenant</strong> untuk membuat perusahaan pertama.
        </div>
        <div v-else class="space-y-3">
          <div v-for="t in tenants" :key="t.id" class="sa-tenant">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <span class="font-semibold truncate" :style="{ color: 'var(--md-sys-color-on-surface)' }">#{{ t.id }} · {{ t.name }}</span>
                  <span
                    class="sa-pill"
                    :style="t.status === 'active'
                      ? 'background:#dcfce7;color:#166534;'
                      : 'background:#fee2e2;color:#991b1b;'"
                  >{{ t.status === 'active' ? 'active' : 'suspended' }}</span>
                  <span v-if="t.waStatus?.disabled" class="sa-pill" style="background:#e5e7eb;color:#374151;">WA off</span>
                </div>
                <div class="text-sm mt-1" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
                  {{ t.userCount }} user · {{ t.chatCount }} chat
                  <template v-if="t.waPhone"> · WA +{{ t.waPhone }}</template>
                </div>
              </div>
              <div class="flex flex-wrap gap-2 justify-end">
                <button class="m3-btn m3-btn--tonal !min-h-[36px] !text-sm" @click="openAdminForm(t)">+ Admin</button>
                <button
                  v-if="t.status === 'active'"
                  class="m3-btn m3-btn--tonal !min-h-[36px] !text-sm"
                  @click="setStatus(t, 'suspended')"
                >Suspend</button>
                <button
                  v-else
                  class="m3-btn m3-btn--tonal !min-h-[36px] !text-sm"
                  @click="setStatus(t, 'active')"
                >Activate</button>
              </div>
            </div>

            <!-- Create admin form per tenant -->
            <div v-if="adminFormFor === t.id" class="sa-form mt-3">
              <M3TextField v-model="adminUsername" label="Username admin" type="text" />
              <M3TextField v-model="adminPassword" label="Password (min 6)" type="password" />
              <div class="flex gap-2 justify-end mt-2">
                <button class="m3-btn m3-btn--text !min-h-[40px]" @click="adminFormFor = null">Batal</button>
                <button class="m3-btn m3-btn--filled !min-h-[40px]" :disabled="creatingAdmin" @click="createAdmin(t)">
                  {{ creatingAdmin ? 'Membuat…' : 'Buat Admin' }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- v3.1.1 — Akun: ganti password mandiri -->
      <div class="sa-panel mt-6">
        <h2 class="text-lg font-semibold mb-1" :style="{ color: 'var(--md-sys-color-on-surface)' }">Akun</h2>
        <p class="text-sm mb-4" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
          Ganti password superadmin kamu sendiri — minimal 6 karakter.
        </p>
        <form @submit.prevent="changePassword" class="grid gap-3 max-w-md">
          <M3TextField v-model="pwCurrent" label="Password saat ini" type="password" autocomplete="current-password" required />
          <M3TextField v-model="pwNew" label="Password baru (min 6)" type="password" autocomplete="new-password" minlength="6" required />
          <M3TextField v-model="pwConfirm" label="Konfirmasi password baru" type="password" autocomplete="new-password" minlength="6" required />
          <div v-if="pwError" class="flex items-start gap-2 text-sm rounded-[var(--md-sys-shape-corner-s)] p-3"
            style="background: var(--md-sys-color-error-container); color: var(--md-sys-color-on-error-container);"
            role="alert">
            <span aria-hidden="true">⚠️</span>
            <span>{{ pwError }}</span>
          </div>
          <div v-if="pwSuccess" class="flex items-start gap-2 text-sm rounded-[var(--md-sys-shape-corner-s)] p-3"
            style="background: var(--md-sys-color-primary-container); color: var(--md-sys-color-on-primary-container);"
            role="status">
            <span aria-hidden="true">✓</span>
            <span>{{ pwSuccess }}</span>
          </div>
          <div class="flex justify-end">
            <button type="submit" class="m3-btn m3-btn--filled !min-h-[40px]" :disabled="pwSaving">
              {{ pwSaving ? 'Menyimpan…' : 'Ganti Password' }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup>
// v3.0 — Halaman superadmin minimal (fase 1). Impersonasi view-as = fase 3.
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import axios from 'axios'
import { useAuthStore } from '../stores/auth'
import M3TextField from '../components/M3TextField.vue'

const API = import.meta.env.VITE_API_URL || ''
const router = useRouter()
const auth = useAuthStore()

const tenants = ref([])
const stats = ref(null)
const loading = ref(true)
const error = ref('')
const showCreate = ref(false)
const newTenantName = ref('')
const creating = ref(false)

const adminFormFor = ref(null)
const adminUsername = ref('')
const adminPassword = ref('')
const creatingAdmin = ref(false)

async function load() {
  error.value = ''
  try {
    const [t, s] = await Promise.all([
      axios.get(`${API}/api/sa/tenants`),
      axios.get(`${API}/api/sa/stats`),
    ])
    tenants.value = t.data.tenants
    stats.value = s.data
  } catch (e) {
    error.value = e.response?.data?.error || 'Gagal memuat data'
  } finally {
    loading.value = false
  }
}

async function createTenant() {
  if (!newTenantName.value.trim()) return
  creating.value = true
  error.value = ''
  try {
    await axios.post(`${API}/api/sa/tenants`, { name: newTenantName.value.trim() })
    newTenantName.value = ''
    showCreate.value = false
    await load()
  } catch (e) {
    error.value = e.response?.data?.error || 'Gagal membuat tenant'
  } finally {
    creating.value = false
  }
}

function openAdminForm(t) {
  adminFormFor.value = adminFormFor.value === t.id ? null : t.id
  adminUsername.value = ''
  adminPassword.value = ''
}

async function createAdmin(t) {
  creatingAdmin.value = true
  error.value = ''
  try {
    await axios.post(`${API}/api/sa/tenants/${t.id}/admins`, {
      username: adminUsername.value.trim(),
      password: adminPassword.value,
    })
    adminFormFor.value = null
    await load()
  } catch (e) {
    error.value = e.response?.data?.error || 'Gagal membuat admin'
  } finally {
    creatingAdmin.value = false
  }
}

async function setStatus(t, status) {
  error.value = ''
  try {
    await axios.put(`${API}/api/sa/tenants/${t.id}`, { status })
    await load()
  } catch (e) {
    error.value = e.response?.data?.error || 'Gagal mengubah status tenant'
  }
}

// v3.1.1 — self-service ganti password. Endpoint /api/auth/change-password (v0.12.2)
// sudah role-agnostic (requireAuth; verifikasi current password; rate limit ketat) —
// superadmin tidak punya akses /settings (router guard khusus), jadi panelnya di sini.
const pwCurrent = ref('')
const pwNew = ref('')
const pwConfirm = ref('')
const pwSaving = ref(false)
const pwError = ref('')
const pwSuccess = ref('')

async function changePassword() {
  pwError.value = ''
  pwSuccess.value = ''
  if (pwNew.value !== pwConfirm.value) {
    pwError.value = 'Password baru tidak sama dengan konfirmasinya'
    return
  }
  if ((pwNew.value || '').length < 6) {
    pwError.value = 'Password baru minimal 6 karakter'
    return
  }
  pwSaving.value = true
  try {
    await axios.post(`${API}/api/auth/change-password`, {
      currentPassword: pwCurrent.value,
      newPassword: pwNew.value,
    })
    pwSuccess.value = 'Password berhasil diganti'
    pwCurrent.value = ''
    pwNew.value = ''
    pwConfirm.value = ''
  } catch (e) {
    pwError.value = e.response?.data?.error || 'Gagal mengganti password'
  } finally {
    pwSaving.value = false
  }
}

function handleLogout() {
  auth.logout()
  router.push('/login')
}

onMounted(load)
</script>

<style scoped>
.sa-card {
  background: var(--md-sys-color-surface-container);
  border-radius: var(--md-sys-shape-corner-m);
  padding: 12px 16px;
}
.sa-stat {
  font-size: 1.4rem;
  font-weight: 700;
  color: var(--md-sys-color-on-surface);
}
.sa-label {
  font-size: 0.78rem;
  color: var(--md-sys-color-on-surface-variant);
}
.sa-panel {
  background: var(--md-sys-color-surface-container);
  border-radius: var(--md-sys-shape-corner-l);
  box-shadow: var(--md-sys-elevation-1);
  padding: 24px;
}
.sa-form {
  background: var(--md-sys-color-surface-container-high);
  border-radius: var(--md-sys-shape-corner-m);
  padding: 16px;
  margin-bottom: 16px;
  display: grid;
  gap: 8px;
}
.sa-tenant {
  background: var(--md-sys-color-surface-container-high);
  border-radius: var(--md-sys-shape-corner-m);
  padding: 16px;
}
.sa-pill {
  font-size: 0.72rem;
  font-weight: 600;
  border-radius: 999px;
  padding: 2px 10px;
  white-space: nowrap;
}
.sa-empty {
  text-align: center;
  padding: 32px 0;
  color: var(--md-sys-color-on-surface-variant);
}
</style>
