<template>
  <!--
    v3.9.13 — Admin "🔑 API Keys" (Public API v1, pola AdminCsat/AdminAppearance).
    List keys (name, prefix, scopes, lastUsed, revoked badge) + Create modal
    (name + scope checkboxes; RAW KEY tampil SEKALI + copy + warning) + Revoke
    (konfirmasi via ConfirmDialog). Gate plan: featApiAccess (route meta feature).
  -->
  <PageShell title="API Keys" back-to="/admin">
    <header class="hidden md:flex m3-topbar px-4 py-3 items-center justify-between">
      <div class="flex items-center gap-3">
        <h1 class="text-lg font-semibold">API Keys</h1>
      </div>
      <div class="flex items-center gap-4">
        <button @click="handleLogout" class="text-sm hover:underline">Logout</button>
      </div>
    </header>

    <div class="max-w-4xl mx-auto w-full p-6 space-y-4">
      <!-- Intro -->
      <div class="bg-white rounded-lg shadow-sm p-6">
        <div class="flex items-start justify-between gap-4">
          <div>
            <h2 class="font-semibold text-gray-900 flex items-center gap-2">🔑 API Keys</h2>
            <p class="text-xs text-gray-500 mt-1">
              Key untuk aplikasi eksternal (mis. program antrean) kirim pesan WhatsApp & baca chat
              via ChatBareng API. Autentikasi: header <code class="bg-gray-100 px-1 rounded">Authorization: Bearer cbk_live_…</code>.
            </p>
            <p class="text-xs text-gray-500 mt-1">
              Raw key hanya tampil <b>SEKALI</b> saat dibuat — simpan di tempat aman. Key bisa dicabut kapan pun (langsung mati).
            </p>
          </div>
          <button
            @click="openCreate"
            class="px-4 py-2 bg-wa-green text-white rounded-lg text-sm font-medium hover:bg-green-600 flex-shrink-0"
            style="min-height: 44px;"
          >
            + Buat Key
          </button>
        </div>
      </div>

      <!-- List keys -->
      <div class="bg-white rounded-lg shadow-sm p-6">
        <div v-if="loading" class="text-sm text-gray-500 py-4 text-center">Memuat…</div>
        <div v-else-if="keys.length === 0" class="text-sm text-gray-500 py-4 text-center">
          Belum ada API key. Klik <b>+ Buat Key</b> untuk membuat key pertama.
        </div>
        <ul v-else class="divide-y divide-gray-100">
          <li v-for="k in keys" :key="k.id" class="py-3 flex flex-col sm:flex-row sm:items-center gap-2">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-medium text-sm text-gray-900">{{ k.name }}</span>
                <code class="text-xs bg-gray-100 px-1.5 py-0.5 rounded">{{ k.prefix }}…</code>
                <span
                  v-if="k.revokedAt"
                  class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700"
                >Revoked</span>
              </div>
              <div class="text-xs text-gray-500 mt-1">
                Scopes: <span class="font-mono">{{ (k.scopes || []).join(', ') || '—' }}</span>
                · Rate: {{ k.ratePerMin }}/menit
                · Dibuat: {{ fmtDate(k.createdAt) }}
                · Terakhir dipakai: {{ k.lastUsedAt ? fmtDate(k.lastUsedAt) : 'belum pernah' }}
              </div>
            </div>
            <div class="flex-shrink-0">
              <button
                v-if="!k.revokedAt"
                @click="revoke(k)"
                class="px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 rounded-lg border border-red-200"
                style="min-height: 36px;"
              >Revoke</button>
              <span v-else class="text-xs text-gray-400">dicabut {{ fmtDate(k.revokedAt) }}</span>
            </div>
          </li>
        </ul>
      </div>
    </div>

    <!-- Modal Create -->
    <Teleport to="body">
      <div v-if="createOpen" class="fixed inset-0 z-50 flex items-center justify-center p-4" style="background: rgba(0,0,0,.45);" @click.self="closeCreate">
        <div class="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
          <!-- Hasil: RAW KEY show-once -->
          <template v-if="createdRaw">
            <h3 class="text-lg font-semibold mb-1">Key dibuat ✅</h3>
            <p class="text-xs text-red-600 font-medium mb-3">⚠️ Simpan SEKARANG — hanya ditampilkan sekali dan tidak bisa dilihat lagi.</p>
            <div class="bg-gray-900 text-green-300 rounded-lg p-3 font-mono text-xs break-all select-all">{{ createdRaw }}</div>
            <button
              @click="copyRaw"
              class="mt-3 w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50"
              style="min-height: 44px;"
            >{{ copied ? '✅ Tersalin' : '📋 Copy Key' }}</button>
            <div class="flex justify-end mt-4">
              <button class="m3-btn m3-btn--filled !min-h-[40px]" @click="closeCreate">Selesai</button>
            </div>
          </template>

          <!-- Form create -->
          <template v-else>
            <h3 class="text-lg font-semibold mb-3">Buat API Key</h3>
            <label class="block mb-3">
              <span class="text-xs text-gray-600 block mb-1">Nama key (mis. "Aplikasi Antrean")</span>
              <input
                v-model="form.name"
                type="text"
                maxlength="80"
                class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                style="min-height: 44px;"
                placeholder="Aplikasi Antrean"
              />
            </label>
            <div class="mb-3">
              <span class="text-xs text-gray-600 block mb-1">Scopes (hak akses)</span>
              <label class="flex items-center gap-2 py-1">
                <input v-model="form.send" type="checkbox" class="w-4 h-4" />
                <span class="text-sm">send — kirim pesan WhatsApp</span>
              </label>
              <label class="flex items-center gap-2 py-1">
                <input v-model="form.read" type="checkbox" class="w-4 h-4" />
                <span class="text-sm">read — baca daftar chat</span>
              </label>
              <!-- v4.6.12 pending (API v1.1, docs/SPEC-api-v1.1-additive.md §1):
                   2 scope baru. TANPA centang = behaviour v1.0 (slot-0, masuk
                   queue, bebas di-take). Centang = capability saja; behaviour
                   per-request ditentukan param yang dikirim aplikasi. -->
              <label class="flex items-start gap-2 py-1">
                <input v-model="form.chooseSlot" type="checkbox" class="w-4 h-4" />
                <span class="text-sm">choose_slot — Pilih nomor slot: app boleh kirim param <code>numberSlot</code> (0–2) saat mengirim pesan</span>
              </label>
              <label class="flex items-start gap-2 py-1">
                <input v-model="form.assignAgent" type="checkbox" class="w-4 h-4" />
                <span class="text-sm">assign_agent — Pilih agent auto-assign: app boleh assign chat ke CS (<code>assignTo</code>) &amp; lihat daftar agent via API</span>
              </label>
            </div>
            <div v-if="createError" class="text-sm mb-2" style="color: var(--md-sys-color-error);">{{ createError }}</div>
            <div class="flex gap-2 justify-end mt-4">
              <button class="m3-btn m3-btn--text !min-h-[40px]" @click="closeCreate">Batal</button>
              <button class="m3-btn m3-btn--filled !min-h-[40px]" :disabled="creating" @click="create">
                {{ creating ? 'Membuat…' : 'Buat Key' }}
              </button>
            </div>
          </template>
        </div>
      </div>
    </Teleport>
  </PageShell>
</template>

<script setup>
import axios from 'axios'
import { ref, onMounted } from 'vue'
import { useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'
import { useConfirm } from '../utils/confirm'
import PageShell from '../components/PageShell.vue'

const API = import.meta.env.VITE_API_URL || ''
const auth = useAuthStore()
const toast = useToastStore()
const confirm = useConfirm()

const loading = ref(false)
const keys = ref([])

const createOpen = ref(false)
const creating = ref(false)
const createError = ref('')
// v4.6.12 pending — default tetap v1.0 (send+read); 2 scope baru default OFF
// (backward compat: key tanpa centang = behaviour v1.0 penuh).
const form = ref({ name: '', send: true, read: true, chooseSlot: false, assignAgent: false })

const createdRaw = ref('')

async function fetchKeys() {
  loading.value = true
  try {
    const res = await axios.get(`${API}/api/api-keys`)
    keys.value = res.data.keys || []
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Gagal memuat', message: e.response?.data?.error || 'Key tidak bisa dimuat' })
  } finally {
    loading.value = false
  }
}

function openCreate() {
  form.value = { name: '', send: true, read: true, chooseSlot: false, assignAgent: false }
  createError.value = ''
  createdRaw.value = ''
  createOpen.value = true
}
function closeCreate() {
  createOpen.value = false
  createdRaw.value = ''
}

async function create() {
  createError.value = ''
  const scopes = []
  if (form.value.send) scopes.push('send')
  if (form.value.read) scopes.push('read')
  if (form.value.chooseSlot) scopes.push('choose_slot')
  if (form.value.assignAgent) scopes.push('assign_agent')
  if (!form.value.name.trim()) { createError.value = 'Nama key wajib diisi'; return }
  if (scopes.length === 0) { createError.value = 'Pilih minimal 1 scope'; return }
  creating.value = true
  try {
    const res = await axios.post(`${API}/api/api-keys`, { name: form.value.name.trim(), scopes })
    createdRaw.value = res.data.key
    if (res.data.warning) toast.show({ icon: 'ℹ️', title: 'Catatan', message: res.data.warning, timeout: 6000 })
    await fetchKeys()
  } catch (e) {
    createError.value = e.response?.data?.error || 'Gagal membuat key'
  } finally {
    creating.value = false
  }
}

async function copyRaw() {
  try {
    await navigator.clipboard.writeText(createdRaw.value)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch {
    toast.show({ icon: '⚠️', title: 'Gagal copy', message: 'Salin manual key di atas' })
  }
}
const copied = ref(false)

async function revoke(k) {
  const yes = await confirm.confirmAction({
    title: `Revoke key "${k.name}"?`,
    message: `Key ${k.prefix}… langsung mati dan aplikasi yang memakainya akan gagal 401 pada request berikutnya. Aksi permanen.`,
    confirmText: 'Revoke',
    danger: true,
  })
  if (!yes) return
  try {
    await axios.delete(`${API}/api/api-keys/${k.id}`)
    toast.show({ icon: '✅', title: 'Key dicabut', message: `Key "${k.name}" sudah di-revoke` })
    await fetchKeys()
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Gagal revoke', message: e.response?.data?.error || 'Terjadi kesalahan' })
  }
}

function fmtDate(d) {
  if (!d) return '—'
  try {
    return new Date(d).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return String(d)
  }
}

function handleLogout() {
  auth.logout()
  window.location.href = '/login'
}

onMounted(fetchKeys)
</script>