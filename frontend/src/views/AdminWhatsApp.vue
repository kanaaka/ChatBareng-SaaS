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
      <div class="bg-white rounded-lg shadow-sm p-6">
        <h2 class="text-lg font-semibold mb-4">WhatsApp Connection</h2>
        <div class="space-y-3">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-sm">Status:</span>
            <span :class="['text-sm font-medium px-2 py-0.5 rounded-full', waStatus.connected ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700']">
              {{ waStatus.connected ? 'Connected' : (waStatus.state || 'Disconnected') }}
            </span>
            <span v-if="waStatus.phoneNumber" class="text-sm text-gray-500">
              ({{ waStatus.phoneNumber }})
            </span>
          </div>

          <!-- v0.13.7 — Dual-mode pairing: QR (DEFAULT, utuh) + Pairing Code.
               Saat connected: keduanya disembunyikan (v-if qrNeeded) seperti QR dulu. -->
          <div v-if="waStatus.qrNeeded" class="pt-1">
            <!-- Tab M3 dua opsi — default: QR -->
            <div class="flex gap-2 mb-4" role="tablist" aria-label="Metode tambahkan WhatsApp">
              <button
                role="tab"
                :aria-selected="pairMode === 'qr'"
                @click="pairMode = 'qr'"
                :class="['px-4 py-2 rounded-full text-sm font-medium transition-colors', pairMode === 'qr' ? 'bg-blue-600 text-white shadow-sm' : 'bg-gray-100 text-gray-700 hover:bg-gray-200']"
              >
                Tambahkan via QR
              </button>
              <button
                role="tab"
                :aria-selected="pairMode === 'code'"
                @click="pairMode = 'code'"
                :class="['px-4 py-2 rounded-full text-sm font-medium transition-colors', pairMode === 'code' ? 'bg-blue-600 text-white shadow-sm' : 'bg-gray-100 text-gray-700 hover:bg-gray-200']"
              >
                Tambahkan via Pairing Code
              </button>
            </div>

            <!-- Mode QR (DEFAULT — perilaku existing UTUH, regression gate #1) -->
            <div v-if="pairMode === 'qr'" class="text-center">
              <p class="text-sm text-gray-600 mb-3">Scan QR code with WhatsApp → Linked Devices</p>
              <img v-if="qrDataUrl" :src="qrDataUrl" alt="QR Code" class="mx-auto border border-gray-200 rounded-lg max-w-full" />
              <p v-else class="text-sm text-gray-400 py-8">QR belum tersedia — tunggu beberapa saat atau klik Refresh QR.</p>
            </div>

            <!-- Mode Pairing Code (baru — v0.13.7; lifecycle UI v0.13.9: countdown 90s,
                 auto-update kode dari broadcast, banner invalidation, hint QR) -->
            <div v-else class="max-w-md">
              <!-- v0.13.9 — banner invalidation: sesi pairing berakhir (TTL 5 mnt / max re-issue) -->
              <div v-if="pairingInvalidated" class="mb-3 rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800" role="alert">
                ⚠️ Sesi pairing berakhir — klik "Minta Kode" untuk mulai lagi.
              </div>

              <div v-if="!pairingCode" class="space-y-3">
                <M3TextField
                  v-model="pairingPhone"
                  label="Nomor WhatsApp (mis. 6281234567890)"
                  type="tel"
                  autocomplete="off"
                  maxlength="15"
                  :disabled="pairingLoading"
                />
                <p class="text-xs text-gray-500">Masukkan nomor HP pemilik akun WhatsApp ini (8–15 digit, kode negara di depan).</p>
                <button
                  @click="requestPairingCode"
                  :disabled="pairingLoading || pairingPhone.replace(/\D/g, '').length < 8"
                  class="w-full sm:w-auto px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {{ pairingLoading ? 'Meminta kode…' : 'Minta Kode' }}
                </button>
                <p v-if="pairingError" class="text-sm text-red-600">{{ pairingError }}</p>
              </div>

              <div v-else class="space-y-4">
                <p class="text-sm text-gray-600">Ketik kode ini di HP → WhatsApp → Setelan → Perangkat tertaut → Tautkan perangkat → "Tautkan dengan nomor telepon saja":</p>
                <div class="flex items-center gap-3 flex-wrap">
                  <span class="text-4xl font-mono font-bold tracking-widest text-gray-900 select-all" aria-label="Pairing code">{{ formattedPairingCode }}</span>
                  <button
                    @click="copyPairingCode"
                    class="px-3 py-1.5 bg-gray-100 text-gray-700 rounded-lg text-sm hover:bg-gray-200"
                  >
                    {{ pairingCopied ? 'Tersalin ✓' : 'Copy' }}
                  </button>
                  <button
                    @click="requestPairingCode"
                    :disabled="pairingLoading || pairingCooldown > 0"
                    class="px-3 py-1.5 bg-gray-100 text-gray-700 rounded-lg text-sm hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {{ pairingCooldown > 0 ? `Tunggu ${pairingCooldown}s` : (pairingLoading ? 'Meminta…' : 'Minta ulang') }}
                  </button>
                  <!-- v0.13.9 — countdown masa berlaku kode (UI 90 dtk; server TTL 5 mnt) -->
                  <span v-if="pairingCountdown > 0" class="text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-full px-2.5 py-1">
                    Kode aktif — {{ pairingCountdown }}s
                  </span>
                  <span v-else class="text-xs font-medium text-red-600 bg-red-50 border border-red-200 rounded-full px-2.5 py-1">
                    Kode kemungkinan hangus — minta ulang
                  </span>
                </div>
                <ol class="text-sm text-gray-600 list-decimal list-inside space-y-1">
                  <li>Buka WhatsApp di HP pemilik nomor ini.</li>
                  <li>Setelan → Perangkat tertaut → Tautkan perangkat.</li>
                  <li>Pilih "Tautkan dengan nomor telepon saja".</li>
                  <li>Ketik kode di atas di HP (di langkah "Tautkan dengan nomor telepon saja") — tunggu hingga terhubung.</li>
                </ol>
                <!-- v0.13.9 — status kode: countdown otomatis; kode baru dari server
                     (auto re-issue) mengganti tampilan TANPA reload (micro-toast) -->
                <p class="text-xs text-gray-400">Kode diperbarui otomatis selama sesi pairing aktif — pakai selalu kode yang tampil terakhir. Kalau kedaluwarsa, tunggu sebentar (kode baru terbit otomatis) atau klik "Minta ulang".</p>
                <!-- v0.13.9 — hint jujur: koneksi pairing tidak stabil → QR lebih andal
                     (QR TIDAK disembunyikan — tab QR tetap tersedia di atas) -->
                <p v-if="pairingUnstable" class="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                  Koneksi pairing sedang tidak stabil (kode sering berganti). QR lebih andal saat ini — tab "Tambahkan via QR" tetap tersedia.
                </p>
              </div>
            </div>
          </div>

          <div class="flex flex-wrap gap-2 pt-3">
            <button
              @click="reconnect"
              class="px-4 py-2 bg-blue-100 text-blue-700 rounded-lg text-sm hover:bg-blue-200"
            >
              Reconnect
            </button>
            <button
              @click="logout"
              class="px-4 py-2 bg-red-100 text-red-700 rounded-lg text-sm hover:bg-red-200"
            >
              Logout & Clear Session
            </button>
            <button
              @click="fetchQR"
              class="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm hover:bg-gray-200"
            >
              Refresh QR
            </button>
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
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useAuthStore } from '../stores/auth'
import { useConfirm } from '../utils/confirm'
import { useSocketStore } from '../stores/socket'
import PageShell from '../components/PageShell.vue'
import M3Switch from '../components/M3Switch.vue'
import M3TextField from '../components/M3TextField.vue'
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

// WhatsApp (dipindah dari Admin.vue v0.1.x — logika tidak berubah)
const waStatus = ref({ connected: false, state: 'connecting' })
const qrDataUrl = ref(null)

// ── v0.13.7 — Pairing dual-mode: QR default + pairing code ──
const pairMode = ref('qr') // 'qr' (DEFAULT, regression gate #1) | 'code'
const pairingPhone = ref('')
const pairingCode = ref(null) // kode mentah dari server
const pairingLoading = ref(false)
const pairingError = ref(null)
const pairingCopied = ref(false)
// v0.13.8 — cooldown 15s antar attempt (server WA juga punya rate limit; attempt numpuk = bind sesi kacau)
const pairingCooldown = ref(0)
let cooldownTimer = null
function startCooldown(seconds = 15) {
  pairingCooldown.value = seconds
  if (cooldownTimer) clearInterval(cooldownTimer)
  cooldownTimer = setInterval(() => {
    pairingCooldown.value -= 1
    if (pairingCooldown.value <= 0) {
      clearInterval(cooldownTimer)
      cooldownTimer = null
    }
  }, 1000)
}

// ── v0.13.9 — Pairing code lifecycle UI (spec §4) ──
// countdown 90 dtk dari momen kode terbit · auto-update kode dari broadcast wa_status
// (auto re-issue server, tanpa reload) · banner invalidation · hint QR saat tidak stabil.
// MODE QR TIDAK DISSENTUH SAMA SEKALI.
const PAIRING_UI_TTL_SECONDS = 90
const pairingIssuedAt = ref(null)      // ISO dari server (pairingIssuedAt)
const pairingInvalidated = ref(false)  // true → banner kuning "Sesi pairing berakhir"
const pairingCountdown = ref(0)        // detik tampil tersisa (max 90)
const pairingUnstable = ref(false)     // true → hint "QR lebih andal"
let countdownTimer = null
let reissueTimestamps = []             // epoch ms kode-baru-via-broadcast (window 60 dtk)

function stopCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer)
    countdownTimer = null
  }
}

/**
 * Terima kode (manual dari POST /pairing-code atau broadcast auto re-issue).
 * Reset countdown + cooldown client-side mengikuti kode TERBARU (spec §4 poin 5);
 * tampilan kode baru tidak pernah tertahan oleh cooldown.
 */
function adoptPairingCode(code, issuedAtIso = null, isAuto = false) {
  const hadCode = !!pairingCode.value
  const isNewCode = !!code && code !== pairingCode.value
  pairingCode.value = code
  pairingIssuedAt.value = issuedAtIso || new Date().toISOString()
  if (isNewCode) {
    // countdown dari issuedAt server (fallback: sekarang) — toleran clock skew minimal (host sama)
    const issuedMs = new Date(pairingIssuedAt.value).getTime()
    pairingCountdown.value = Math.max(0, PAIRING_UI_TTL_SECONDS - Math.floor((Date.now() - issuedMs) / 1000))
    if (countdownTimer) clearInterval(countdownTimer)
    countdownTimer = setInterval(() => {
      if (pairingCountdown.value > 0) pairingCountdown.value -= 1
      if (pairingCountdown.value <= 0 && countdownTimer) {
        clearInterval(countdownTimer)
        countdownTimer = null
      }
    }, 1000)
    // cooldown client-side ikut kode terbaru — tapi TIDAK menahan tampilan kode baru
    startCooldown(60)
    if (isAuto && hadCode) {
      // auto re-issue terdeteksi: catat utk deteksi "≥3x dalam 1 menit"
      const now = Date.now()
      reissueTimestamps = reissueTimestamps.filter(t => now - t < 60000)
      reissueTimestamps.push(now)
      pairingUnstable.value = reissueTimestamps.length >= 3
      // micro-toast "Kode diperbarui otomatis" (spec §4 poin 2)
      toast.show({ icon: '🔄', title: 'Kode diperbarui otomatis', message: 'Kode pairing baru terbit — gunakan kode terbaru di HP.' })
    }
  } else if (!countdownTimer && pairingCode.value) {
    // kode sama di-rebroadcast (mis. page reload) → lanjutkan countdown dari issuedAt
    startCountdownFromIssuedAt()
  }
}

function startCountdownFromIssuedAt() {
  if (!pairingIssuedAt.value) return
  const issuedMs = new Date(pairingIssuedAt.value).getTime()
  pairingCountdown.value = Math.max(0, PAIRING_UI_TTL_SECONDS - Math.floor((Date.now() - issuedMs) / 1000))
  if (countdownTimer) clearInterval(countdownTimer)
  countdownTimer = setInterval(() => {
    if (pairingCountdown.value > 0) pairingCountdown.value -= 1
    if (pairingCountdown.value <= 0 && countdownTimer) {
      clearInterval(countdownTimer)
      countdownTimer = null
    }
  }, 1000)
}

/** v0.13.9 — reset seluruh lifecycle UI pairing (saat connected / invalidated) */
function resetPairingLifecycleUI() {
  pairingIssuedAt.value = null
  pairingInvalidated.value = false
  pairingCountdown.value = 0
  stopCountdown()
}

// Formatter XXXX-XXXX (grup 4-4) — mirror dari server (wa.formatPairingCode)
const formattedPairingCode = computed(() => {
  const compact = String(pairingCode.value || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  if (compact.length !== 8) return compact
  return compact.slice(0, 4) + '-' + compact.slice(4)
})

// Input digits-only (strip non-digit saat mengetik) — via watch karena M3TextField
// hanya emit update:modelValue (listener @input komponen tidak ikut).
watch(pairingPhone, (val) => {
  const clean = String(val || '').replace(/\D/g, '').slice(0, 15)
  if (clean !== val) pairingPhone.value = clean
})

async function requestPairingCode() {
  const phone = pairingPhone.value.replace(/\D/g, '')
  if (phone.length < 8 || phone.length > 15) {
    pairingError.value = 'Nomor tidak valid — masukkan 8–15 digit (kode negara di depan, mis. 6281234567890).'
    return
  }
  pairingLoading.value = true
  pairingError.value = null
  try {
    const res = await axios.post(`${API}/api/wa/pairing-code`, { phone })
    if (res.data.code) {
      // v0.13.9 — adopt dgn countdown + cooldown mengikuti kode terbaru
      adoptPairingCode(res.data.code, res.data.issuedAt || null, false)
    } else {
      pairingError.value = 'Kode kosong dari server — minta ulang.'
    }
  } catch (e) {
    pairingError.value = e.response?.data?.error || 'Gagal meminta pairing code — coba lagi.'
  } finally {
    pairingLoading.value = false
  }
}

async function copyPairingCode() {
  try {
    await navigator.clipboard.writeText(formattedPairingCode.value)
    pairingCopied.value = true
    setTimeout(() => { pairingCopied.value = false }, 2000)
  } catch {
    pairingError.value = 'Gagal menyalin — salin manual kode di atas.'
  }
}

async function fetchStatus() {
  try {
    const res = await axios.get(`${API}/api/wa/status`)
    waStatus.value = res.data
    // v0.13.9 — REST snapshot: adopt pairing state bila belum ada kode di layar
    // (broadcast selalu menang bila lebih baru — snapshot hanya bootstrap reload)
    if (!res.data.connected && res.data.pairingCode && !pairingCode.value) {
      adoptPairingCode(res.data.pairingCode, res.data.pairingIssuedAt || null, false)
    }
    if (!res.data.connected && res.data.pairingInvalidated) {
      pairingInvalidated.value = true
      pairingCode.value = null
    }
    if (res.data.qrNeeded) await fetchQR()
  } catch (e) { console.error(e) }
}

async function fetchQR() {
  try {
    const res = await axios.get(`${API}/api/wa/qr`)
    qrDataUrl.value = res.data.qrDataUrl
  } catch (e) { /* QR not available yet */ }
}

async function reconnect() {
  try {
    await axios.post(`${API}/api/wa/reconnect`)
    setTimeout(fetchStatus, 3000)
  } catch (e) { console.error(e) }
}

async function logout() {
  // v0.9.0 — confirm() native → M3 dialog; handler logout WA TIDAK berubah
  const ok = await confirmAction({
    title: 'Logout WhatsApp?',
    message: 'You will need to re-scan QR.',
    confirmText: 'Logout',
    danger: true,
  })
  if (!ok) return
  try {
    await axios.post(`${API}/api/wa/logout`)
    waStatus.value = { connected: false, state: 'close' }
    qrDataUrl.value = null
    setTimeout(fetchStatus, 3000)
  } catch (e) { console.error(e) }
}

function onWaStatus(data) {
  waStatus.value = data
  if (data.qrNeeded && data.qrDataUrl) {
    qrDataUrl.value = data.qrDataUrl
  }
  // v0.13.7 — pairing code live-update (broadcast wa_status.pairingCode)
  if (data.connected) {
    pairingCode.value = null
    pairingError.value = null
    // v0.13.9 — pairing selesai → reset lifecycle UI
    pairingUnstable.value = false
    reissueTimestamps = []
    resetPairingLifecycleUI()
  } else if (data.pairingInvalidated === true) {
    // v0.13.9 — TTL/MAX habis: banner + tombol Minta Kode tetap tersedia.
    // Kode lama dibuang dari layar (hangus) → form muncul lagi.
    pairingInvalidated.value = true
    pairingCode.value = null
    pairingIssuedAt.value = null
    pairingCountdown.value = 0
    stopCountdown()
  } else if (data.pairingCode) {
    // v0.13.9 — kode baru via broadcast (manual issue ATAU auto re-issue server):
    // ganti kode di layar TANPA reload; isAuto=true hanya bila menggantikan kode existing
    adoptPairingCode(data.pairingCode, data.pairingIssuedAt || null, !!pairingCode.value && data.pairingCode !== pairingCode.value)
    if (data.pairingInvalidated === false) pairingInvalidated.value = false
  }
}

function handleLogout() {
  auth.logout()
  window.location.href = '/login'
}

onMounted(() => {
  fetchStatus()
  loadAppConfig()
  socketStore.on('wa_status', onWaStatus)
})
onUnmounted(() => {
  socketStore.off('wa_status', onWaStatus)
  if (cooldownTimer) clearInterval(cooldownTimer)
  // v0.13.9 — bersihkan countdown timer
  stopCountdown()
})
</script>
