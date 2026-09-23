<template>
  <PageShell title="WhatsApp" back-to="/admin">
    <header class="hidden md:flex m3-topbar px-4 py-3 items-center justify-between">
      <div class="flex items-center gap-3">
        <h1 class="text-lg font-semibold">WhatsApp</h1>
      </div>
      <div class="flex items-center gap-4">
        <button @click="handleLogout" class="text-sm hover:underline">Logout</button>
      </div>
    </header>

    <div class="max-w-4xl mx-auto w-full p-6 space-y-4">
      <!-- v3.9 — DAFTAR SLOT NOMOR WA (multi-nomor per tenant) -->
      <div class="bg-white rounded-lg shadow-sm p-6">
        <div class="flex items-start justify-between gap-4 mb-4 flex-wrap">
          <div>
            <h2 class="text-lg font-semibold">Nomor WhatsApp</h2>
            <p class="text-sm text-gray-500">Setiap nomor punya sesi sendiri — connect/QR/pairing/logout per nomor. Slot-0 = nomor utama.</p>
          </div>
          <div class="flex items-center gap-2">
            <span v-if="waMode" class="text-xs font-medium px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">Mode: {{ waMode }}</span>
            <button @click="addSlot" :disabled="addingSlot" class="px-3 py-1.5 bg-blue-100 text-blue-700 rounded-lg text-sm hover:bg-blue-200 disabled:opacity-50">
              {{ addingSlot ? 'Menambah…' : '+ Tambah Nomor' }}
            </button>
          </div>
        </div>

        <div v-if="slots.length === 0" class="text-sm text-gray-400 py-4">Memuat slot…</div>

        <div v-else class="space-y-3">
          <div v-for="s in slots" :key="s.slot" class="border border-gray-200 rounded-lg p-4">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-sm font-semibold">Slot {{ s.slot }}{{ s.label ? ' — ' + s.label : '' }}</span>
              <span :class="['text-sm font-medium px-2 py-0.5 rounded-full', s.status?.connected ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700']">
                {{ s.status?.connected ? 'Connected' : (s.status?.state || 'Disconnected') }}
              </span>
              <span v-if="s.status?.phoneNumber" class="text-sm text-gray-500">(+{{ s.status.phoneNumber }})</span>
              <span v-if="s.routeMode === 'assigned'" class="text-xs font-medium px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">Assigned → agent #{{ s.assignedAgentId }}</span>
            </div>

            <!-- Label edit (inline) -->
            <div class="flex items-center gap-2 mt-3 flex-wrap">
              <input
                v-model="s._labelDraft"
                type="text"
                placeholder="Label (mis. CS Utama)"
                maxlength="50"
                class="px-3 py-1.5 text-sm border border-gray-300 rounded-lg w-56"
              />
              <button @click="saveLabel(s)" class="px-3 py-1.5 bg-gray-100 text-gray-700 rounded-lg text-sm hover:bg-gray-200">Simpan Label</button>
            </div>

            <!-- QR per-slot (hanya slot ini butuh scan) -->
            <div v-if="s.status?.qrNeeded" class="pt-3">
              <div class="flex gap-2 mb-3" role="tablist">
                <button
                  role="tab"
                  @click="s._pairMode = 'qr'"
                  :class="['px-3 py-1.5 rounded-full text-xs font-medium', (s._pairMode || 'qr') === 'qr' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700']"
                >QR</button>
                <button
                  role="tab"
                  @click="s._pairMode = 'code'"
                  :class="['px-3 py-1.5 rounded-full text-xs font-medium', (s._pairMode || 'qr') === 'code' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700']"
                >Pairing Code</button>
              </div>

              <div v-if="(s._pairMode || 'qr') === 'qr'" class="text-center">
                <img v-if="s._qrDataUrl" :src="s._qrDataUrl" alt="QR Code" class="mx-auto border border-gray-200 rounded-lg max-w-full" />
                <p v-else class="text-sm text-gray-400 py-6">
                  QR belum tersedia —
                  <button @click="fetchQRSlot(s)" class="text-blue-600 hover:underline">muat ulang</button>
                </p>
              </div>

              <div v-else class="max-w-md">
                <div class="flex items-center gap-2 flex-wrap">
                  <input v-model="s._pairPhone" type="tel" placeholder="6281234567890" maxlength="15" class="px-3 py-1.5 text-sm border border-gray-300 rounded-lg w-48" />
                  <button
                    @click="requestPairingSlot(s)"
                    class="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"
                  >Minta Kode</button>
                  <span v-if="s._pairingCode" class="text-xl font-mono font-bold tracking-widest select-all">{{ formatCode(s._pairingCode) }}</span>
                </div>
                <p v-if="s._pairError" class="text-xs text-red-600 mt-1">{{ s._pairError }}</p>
              </div>
            </div>

            <div class="flex flex-wrap gap-2 pt-3">
              <button @click="connectSlot(s)" class="px-3 py-1.5 bg-blue-100 text-blue-700 rounded-lg text-sm hover:bg-blue-200">
                {{ s.status?.connected ? 'Reconnect' : 'Connect' }}
              </button>
              <button v-if="s.status?.qrNeeded" @click="fetchQRSlot(s)" class="px-3 py-1.5 bg-gray-100 text-gray-700 rounded-lg text-sm hover:bg-gray-200">Refresh QR</button>
              <button
                v-if="s.slot !== 0"
                @click="removeSlot(s)"
                class="px-3 py-1.5 bg-red-100 text-red-700 rounded-lg text-sm hover:bg-red-200"
              >Hapus Nomor</button>
              <span v-else class="text-xs text-gray-400 self-center">slot utama — tidak bisa dihapus</span>
            </div>
          </div>
        </div>
      </div>

      <!-- v0.12.10 — Read receipts (centang biru): admin-only, universal, default OFF
           (dipindah dari Settings per Kanaka — setting perilaku WA = tempatnya di sini) -->
      <div class="bg-white rounded-lg shadow-sm p-6">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <h2 class="text-lg font-semibold mb-1">Centang Biru (Read Receipt)</h2>
            <p class="text-sm text-gray-500">Kirim status "terbaca" (centang biru ✓✓) ke pelanggan saat chat dibuka atau dibalas agent. Berlaku universal untuk semua agent. Default: mati.</p>
          </div>
          <M3Switch
            :model-value="receiptsEnabled"
            :disabled="receiptsSaving"
            class="flex-shrink-0 mt-1"
            @update:model-value="toggleReceipts"
          />
        </div>
      </div>
    </div>
  </PageShell>
</template>

<script setup>
import axios from 'axios'
import { ref, onMounted, onUnmounted } from 'vue'
import { useAuthStore } from '../stores/auth'
import { useConfirm } from '../utils/confirm'
import { useSocketStore } from '../stores/socket'
import PageShell from '../components/PageShell.vue'
import M3Switch from '../components/M3Switch.vue'
import { useToastStore } from '../stores/toast'

const API = import.meta.env.VITE_API_URL || ''
const auth = useAuthStore()
const { confirmAction } = useConfirm()
const socketStore = useSocketStore()
const toast = useToastStore()

// ── v0.12.10 — Read receipts (centang biru): admin-only, universal, default OFF ──
const receiptsEnabled = ref(false)
const receiptsSaving = ref(false)

async function loadAppConfig() {
  try {
    const res = await axios.get(`${API}/api/app-config`)
    receiptsEnabled.value = !!res.data.readReceiptsEnabled
  } catch (e) { console.error('Load app-config error:', e) }
}

async function toggleReceipts(v) {
  const prev = receiptsEnabled.value
  receiptsEnabled.value = v
  receiptsSaving.value = true
  try {
    const res = await axios.put(`${API}/api/app-config`, { readReceiptsEnabled: v })
    receiptsEnabled.value = !!res.data.readReceiptsEnabled
    toast.show({
      icon: '👁️',
      title: 'Pengaturan disimpan',
      message: v ? 'Centang biru (read receipt) AKTIF — pelanggan lihat ✓✓ biru' : 'Centang biru (read receipt) MATI — centang tetap abu-abu',
    })
  } catch (e) {
    receiptsEnabled.value = prev
    toast.show({ icon: '⚠️', title: 'Gagal menyimpan', message: e.response?.data?.error || 'Coba lagi' })
  } finally {
    receiptsSaving.value = false
  }
}

// ═══ v3.9 — Multi-nomor: slot list + per-slot actions ═══
const slots = ref([])
const waMode = ref('pool')
const addingSlot = ref(false)
let pollTimer = null

function formatCode(code) {
  const compact = String(code || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  if (compact.length !== 8) return compact
  return compact.slice(0, 4) + '-' + compact.slice(4)
}

async function fetchStatus() {
  try {
    const res = await axios.get(`${API}/api/wa/status`)
    waMode.value = res.data.waMode || 'pool'
    // Merge in-place supaya state _qrDataUrl/_draft tidak hilang saat polling
    const prev = new Map(slots.value.map((s) => [s.slot, s]))
    slots.value = (res.data.slots || []).map((n) => {
      const old = prev.get(n.slot) || {}
      return {
        ...n,
        _labelDraft: old._labelDraft ?? (n.label || ''),
        _pairMode: old._pairMode || 'qr',
        _qrDataUrl: old._qrDataUrl || null,
        _pairingCode: old._pairingCode || null,
        _pairError: old._pairError || null,
        _pairPhone: old._pairPhone || '',
      }
    })
    // Auto-fetch QR bila slot butuh scan dan QR belum tampil
    for (const s of slots.value) {
      if (s.status?.qrNeeded && !s._qrDataUrl) fetchQRSlot(s)
    }
  } catch (e) { console.error(e) }
}

async function fetchQRSlot(s) {
  try {
    const res = await axios.get(`${API}/api/wa/qr?slot=${s.slot}`)
    s._qrDataUrl = res.data.qrDataUrl
  } catch (e) { /* QR not available yet */ }
}

async function connectSlot(s) {
  try {
    await axios.post(`${API}/api/wa/reconnect`, { slot: s.slot })
    toast.show({ icon: '🔄', title: 'Connect dimulai', message: `Slot ${s.slot} — tunggu QR/muncul status.` })
    setTimeout(fetchStatus, 3000)
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Gagal connect', message: e.response?.data?.error || 'Coba lagi' })
  }
}

async function requestPairingSlot(s) {
  const phone = String(s._pairPhone || '').replace(/\D/g, '')
  if (phone.length < 8) {
    s._pairError = 'Nomor tidak valid — 8–15 digit (kode negara di depan).'
    return
  }
  s._pairError = null
  try {
    const res = await axios.post(`${API}/api/wa/pairing-code`, { phone, slot: s.slot })
    s._pairingCode = res.data.pairingCode
  } catch (e) {
    s._pairError = e.response?.data?.error || 'Gagal meminta pairing code.'
  }
}

async function saveLabel(s) {
  try {
    const label = String(s._labelDraft || '').trim()
    await axios.put(`${API}/api/wa/numbers/${s.slot}`, { label })
    s.label = label === '' ? null : label
    toast.show({ icon: '🏷️', title: 'Label disimpan', message: `Slot ${s.slot}: ${label || '(tanpa label)'}` })
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Gagal simpan label', message: e.response?.data?.error || 'Coba lagi' })
  }
}

async function addSlot() {
  // Slot pertama yang belum terdaftar (mulai dari 1)
  const existing = new Set(slots.value.map((s) => s.slot))
  let target = null
  for (let i = 1; i <= 2; i++) {
    if (!existing.has(i)) { target = i; break }
  }
  if (target === null) {
    toast.show({ icon: '⚠️', title: 'Slot penuh', message: 'Maksimal 3 nomor per tenant (slot 0..2).' })
    return
  }
  addingSlot.value = true
  try {
    await axios.post(`${API}/api/wa/numbers`, { slot: target })
    toast.show({ icon: '➕', title: 'Slot ditambahkan', message: `Slot ${target} terdaftar — klik Connect untuk scan QR.` })
    await fetchStatus()
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Gagal menambah slot', message: e.response?.data?.error || 'Coba lagi' })
  } finally {
    addingSlot.value = false
  }
}

async function removeSlot(s) {
  const ok = await confirmAction({
    title: `Hapus Nomor Slot ${s.slot}?`,
    message: 'Sesi WhatsApp nomor ini akan dihapus (logout). Slot lain tidak terpengaruh.',
    confirmText: 'Hapus',
    danger: true,
  })
  if (!ok) return
  try {
    await axios.delete(`${API}/api/wa/numbers/${s.slot}`)
    toast.show({ icon: '🗑️', title: 'Slot dihapus', message: `Slot ${s.slot} dihapus bersih.` })
    await fetchStatus()
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Gagal hapus slot', message: e.response?.data?.error || 'Coba lagi' })
  }
}

// socket broadcast: refresh slot saat status WA berubah
function onWaStatus() {
  // debounced refresh
  clearTimeout(onWaStatus._t)
  onWaStatus._t = setTimeout(fetchStatus, 500)
}

function handleLogout() {
  auth.logout()
  window.location.href = '/login'
}

onMounted(() => {
  fetchStatus()
  loadAppConfig()
  socketStore.on('wa_status', onWaStatus)
  pollTimer = setInterval(fetchStatus, 10000)
})
onUnmounted(() => {
  socketStore.off('wa_status', onWaStatus)
  if (pollTimer) clearInterval(pollTimer)
})
</script>