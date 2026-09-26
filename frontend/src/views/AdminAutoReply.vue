<template>
  <PageShell title="Auto Reply" back-to="/admin">
    <header class="hidden md:flex m3-topbar px-4 py-3 items-center justify-between">
      <div class="flex items-center gap-3">
        <h1 class="text-lg font-semibold">Auto Reply</h1>
      </div>
      <div class="flex items-center gap-4">
        <button @click="handleLogout" class="text-sm hover:underline">Logout</button>
      </div>
    </header>

    <div class="max-w-4xl mx-auto w-full p-6 space-y-4">
      <!-- Badge status ringkas -->
      <div class="bg-white rounded-lg shadow-sm p-4">
        <span :class="['inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium', statusBadge.class]">
          {{ statusBadge.text }}
        </span>
        <p class="text-xs text-gray-400 mt-2">Auto message 1×/hari per pelanggan · tidak mengubah antrean · tidak dihitung sebagai first-response CS</p>
      </div>

      <!-- Outside Hours Reply -->
      <div class="bg-white rounded-lg shadow-sm p-6">
        <label class="flex items-center justify-between cursor-pointer">
          <div>
            <h2 class="font-semibold text-gray-900">Outside Hours Reply</h2>
            <p class="text-xs text-gray-500">Balasan otomatis saat pelanggan chat di luar jam operasional</p>
          </div>
          <input v-model="form.outsideHoursEnabled" type="checkbox" class="w-5 h-5 accent-green-600" />
        </label>
        <div v-if="form.outsideHoursEnabled" class="mt-4 space-y-2">
          <!-- v4.0.0 — radio luar jam (D4): Teks / CB-AI -->
          <div class="flex flex-wrap items-center gap-4 mb-2">
            <span class="text-xs text-gray-600">Mode luar jam:</span>
            <label class="flex items-center gap-1.5 text-sm text-gray-800 cursor-pointer" style="min-height: 36px;">
              <input v-model="form.outsideHoursMode" type="radio" value="text" class="w-4 h-4 accent-green-600" />
              Teks biasa
            </label>
            <label
              class="flex items-center gap-1.5 cursor-pointer"
              style="min-height: 36px;"
              :class="!aiPlanOk ? 'opacity-50' : ''"
              title="AI menjawab dari dokumen yang kamu ajarkan di menu ChatBareng AI"
            >
              <input v-model="form.outsideHoursMode" type="radio" value="cbai" :disabled="!aiPlanOk" class="w-4 h-4 accent-green-600" />
              <span class="text-sm text-gray-800">ChatBareng AI (jaga malam)</span>
            </label>
          </div>
          <p v-if="!aiPlanOk" class="text-xs px-3 py-2 rounded-lg bg-amber-50 text-amber-700">
            ChatBareng AI belum tersedia di paket kamu — hubungi admin platform untuk upgrade.
          </p>
          <p v-else-if="form.outsideHoursMode === 'cbai'" class="text-xs text-gray-500">
            Malam dijaga AI dari dokumen KB kamu (menu ChatBareng AI). Tidak tercakup/limit habis →
            teks luar jam di bawah tetap terkirim. Teks di bawah = fallback + jawaban AI.
          </p>
          <textarea
            v-model="form.outsideHoursText"
            rows="3"
            maxlength="1000"
            class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            placeholder="Teks balasan di luar jam kerja..."
          ></textarea>
          <p class="text-xs text-gray-500">
            Preview: <span class="italic text-gray-700">{{ preview(form.outsideHoursText) }}</span>
          </p>
        </div>
      </div>

      <!-- First-of-Day Greeting -->
      <div class="bg-white rounded-lg shadow-sm p-6">
        <label class="flex items-center justify-between cursor-pointer">
          <div>
            <h2 class="font-semibold text-gray-900">First-of-Day Greeting</h2>
            <p class="text-xs text-gray-500">Sapaan otomatis untuk pelanggan yang chat pertama kali di hari itu</p>
          </div>
          <input v-model="form.greetEnabled" type="checkbox" class="w-5 h-5 accent-green-600" />
        </label>
        <div v-if="form.greetEnabled" class="mt-4 space-y-2">
          <!-- v0.13.0 — mode greeting (D9): teks biasa / menu gateway; v4.0.0 (D4): + CB-AI -->
          <div class="flex flex-wrap items-center gap-4 mb-2">
            <span class="text-xs text-gray-600">Mode greeting:</span>
            <label class="flex items-center gap-1.5 text-sm text-gray-800 cursor-pointer" style="min-height: 36px;">
              <input v-model="form.greetMode" type="radio" value="text" class="w-4 h-4 accent-green-600" />
              Teks biasa
            </label>
            <label
              class="flex items-center gap-1.5 cursor-pointer"
              style="min-height: 36px;"
              :class="!aiPlanOk ? 'opacity-50' : ''"
            >
              <input v-model="form.greetMode" type="radio" value="cbai" :disabled="!aiPlanOk" class="w-4 h-4 accent-green-600" />
              <span class="text-sm text-gray-800">ChatBareng AI (dari KB)</span>
            </label>
            <label class="flex items-center gap-1.5 cursor-pointer" style="min-height: 36px;">
              <input v-model="form.greetMode" type="radio" value="menu" class="w-4 h-4 accent-green-600" />
              <span class="text-sm text-gray-800">Menu gateway (pilihan topik)</span>
              <router-link to="/admin/menu-gateway" class="text-xs text-green-700 hover:underline">→ atur menu</router-link>
            </label>
          </div>
          <p v-if="!aiPlanOk && form.greetMode !== 'menu'" class="text-xs px-3 py-2 rounded-lg bg-amber-50 text-amber-700">
            ChatBareng AI belum tersedia di paket kamu — hubungi admin platform untuk upgrade.
          </p>
          <p v-if="form.greetMode === 'menu'" class="text-xs text-amber-600">
            Teks greeting di bawah TIDAK terkirim — pelanggan menerima intro dari Menu Gateway
            (yang otomatis menyala saat mode ini disimpan; mati lagi kalau radio kembali ke Teks biasa).
          </p>
          <p v-else-if="form.greetMode === 'cbai'" class="text-xs text-gray-500">
            Siang dijaga AI dari dokumen KB (menu ChatBareng AI). Tidak tercakup → greeting text
            di bawah terkirim (dihitung). Menu gateway TIDAK aktif di mode ini.
          </p>
          <textarea
            v-model="form.greetText"
            rows="3"
            maxlength="1000"
            class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            placeholder="Teks greeting..."
          ></textarea>
          <p class="text-xs text-gray-500">
            Preview: <span class="italic text-gray-700">{{ preview(form.greetText) }}</span>
          </p>
        </div>
      </div>

      <!-- v4.0.0 — Kartu Pengaturan CB-AI (limit slider + jendela 24 jam + footer + hint biaya;
           dropdown Frekuensi greeting PINDAH ke sini — D10) -->
      <div class="bg-white rounded-lg shadow-sm p-6">
        <div class="flex items-center justify-between gap-2">
          <h2 class="font-semibold text-gray-900">Pengaturan ChatBareng AI</h2>
          <span v-if="aiUsage" class="text-xs text-gray-400">≈ Rp {{ (aiUsage.costRp || 0).toLocaleString('id-ID') }} bulan ini ({{ aiUsage.calls || 0 }} call)</span>
        </div>
        <div class="mt-3">
          <span class="text-xs text-gray-600 block mb-1">Limit balasan AI per chat (1–10, default 3)</span>
          <div class="flex items-center gap-3">
            <input v-model.number="form.cbaiLimit" type="range" min="1" max="10" step="1" class="flex-1 min-w-[160px] accent-green-600" :disabled="!aiPlanOk || saving" />
            <span class="text-sm font-semibold text-gray-800 tabular-nums w-8 text-center">{{ form.cbaiLimit }}</span>
          </div>
          <p class="text-xs text-gray-500 mt-1">
            Jendela 24 jam sejak balasan AI terakhir: setelah {{ form.cbaiLimit }} balasan (jawaban AI + fallback
            dihitung), chat diam sampai 24 jam lewat — lalu budget segar. CS yang bales TIDAK mereset hitungan.
          </p>
        </div>
        <label class="flex items-center justify-between mt-4 cursor-pointer">
          <div>
            <span class="text-sm text-gray-800">Footer "info per tanggal" di jawaban AI</span>
            <p class="text-xs text-gray-500">Tanggal dokumen KB terbaru dicantumkan di akhir jawaban (default ON)</p>
          </div>
          <M3Switch v-model="form.cbaiInfoFooter" :disabled="!aiPlanOk || saving" />
        </label>
        <div class="mt-4">
          <span class="text-xs text-gray-600 block mb-1">Frekuensi greeting (menu &amp; teks)</span>
          <select
            v-model="form.repeatFrequency"
            class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
            style="min-height: 44px;"
          >
            <option value="per_chat">Tiap chat baru</option>
            <option value="daily">Sekali per hari</option>
            <option value="weekly">Sekali per minggu</option>
          </select>
          <p class="text-xs text-gray-400 mt-1">Mengatur seberapa sering sapaan/greeting terkirim ke kontak yang sama (berlaku juga utk menu gateway).</p>
        </div>
      </div>

      <!-- Jam Operasional -->
      <div class="bg-white rounded-lg shadow-sm p-4 sm:p-6">
        <h2 class="font-semibold text-gray-900 mb-4">Jam Operasional <span class="text-xs font-normal text-gray-400">(WIB)</span></h2>
        <div class="space-y-1">
          <div v-for="row in hourRows" :key="row.prefix" class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 py-1.5 border-b border-gray-100 last:border-0">
            <label class="flex items-center gap-2 cursor-pointer">
              <input v-model="form[row.prefix + 'Enabled']" type="checkbox" class="w-4 h-4 accent-green-600" />
              <span class="text-sm text-gray-800">{{ row.label }}</span>
            </label>
            <!-- v0.7.1: start–end = SATU grup flex shrink-0 → wrap per grup, bukan per input (fix zigzag mobile) -->
            <div v-if="form[row.prefix + 'Enabled']" class="flex items-center gap-1 shrink-0">
              <input v-model="form[row.prefix + 'Start']" type="time" class="px-1.5 py-1 border border-gray-300 rounded-lg text-sm" />
              <span class="text-gray-400 text-sm">–</span>
              <input v-model="form[row.prefix + 'End']" type="time" class="px-1.5 py-1 border border-gray-300 rounded-lg text-sm" />
            </div>
            <span v-else class="text-xs text-gray-400">Off — dianggap di luar jam operasional</span>
          </div>
        </div>
      </div>

      <!-- Save -->
      <div class="flex justify-end items-center gap-3 flex-wrap">
        <!-- v3.9.4 — TICK-BOX (QA #4/#5): pilih nomor mana yang kena rules ini.
             'Semua nomor' + slot tick-box; slot menu-managed dilindungi (disabled + badge). -->
        <div v-if="waSlots.length > 0" class="flex items-center gap-3 flex-wrap">
          <span class="text-sm text-gray-600">Terapkan ke:</span>
          <label class="flex items-center gap-1.5 text-sm cursor-pointer">
            <input type="checkbox" :checked="applyAll" @change="toggleAll" class="w-4 h-4 accent-green-600" />
            Semua nomor
          </label>
          <label
            v-for="s in waSlots"
            :key="s.slot"
            class="flex items-center gap-1.5 text-sm"
            :class="menuManagedSet.has(s.slot) ? 'opacity-50' : 'cursor-pointer'"
            :title="menuManagedSet.has(s.slot) ? 'Nomor ini dikelola Menu Gateway — matikan menunya dulu di halaman Menu Gateway' : ''"
          >
            <input
              type="checkbox"
              :checked="selectedSlots.has(s.slot)"
              :disabled="menuManagedSet.has(s.slot)"
              @change="toggleSlot(s.slot)"
              class="w-4 h-4 accent-green-600"
            />
            Slot {{ s.slot }}{{ s.label ? ' · ' + s.label : '' }}
            <span v-if="menuManagedSet.has(s.slot)" class="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700">menu</span>
          </label>
        </div>
        <button
          @click="save"
          :disabled="saving"
          class="px-6 py-2.5 bg-wa-green text-white rounded-lg text-sm font-medium hover:bg-green-600 disabled:opacity-50"
        >
          {{ saving ? 'Menyimpan...' : 'Simpan' }}
        </button>
      </div>
    </div>
  </PageShell>
</template>

<script setup>
import axios from 'axios'
import { ref, computed, onMounted } from 'vue'
import { useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'
import PageShell from '../components/PageShell.vue'
import M3Switch from '../components/M3Switch.vue'

const API = import.meta.env.VITE_API_URL || ''
const auth = useAuthStore()
const toast = useToastStore()

const loading = ref(true)
const saving = ref(false)

const hourRows = [
  { prefix: 'monFri', label: 'Senin–Jumat' },
  { prefix: 'sat', label: 'Sabtu' },
  { prefix: 'sun', label: 'Minggu' },
]

const form = ref({
  outsideHoursEnabled: false,
  outsideHoursText: '',
  // v4.0.0 — CB-AI (D4/D5/D3): mode luar jam + limit + footer; greetMode extended "cbai"
  outsideHoursMode: 'text', // "text" | "cbai"
  cbaiLimit: 3, // 1..10
  cbaiInfoFooter: true,
  greetEnabled: false,
  greetText: '',
  repeatFrequency: 'daily', // v4.0.0 — D10: dropdown PINDAH dari Menu Gateway (kolom additive)
  greetMode: 'text', // "text" | "menu" | "cbai"
  monFriEnabled: true, monFriStart: '08:00', monFriEnd: '17:00',
  satEnabled: true, satStart: '08:00', satEnd: '17:00',
  sunEnabled: true, sunStart: '08:00', sunEnd: '17:00',
})

// v4.0.0 — plan gate client + hint biaya (server tetap 403 — defense in depth)
const aiPlanOk = ref(true)
const aiUsage = ref(null)

// v3.9.4 — TICK-BOX scope (QA #4/#5): applyAll = 'Semua nomor'; selectedSlots =
// slot tercentang. Persist via GET numberSlots/menuManagedSlots — pilihan tidak
// hilang lagi saat reload (bug lama: dropdown reset + save per-slot 400 diam).
const waSlots = ref([])
const applyAll = ref(true)
const selectedSlots = ref(new Set())
const menuManagedSet = ref(new Set())

function toggleAll() {
  applyAll.value = !applyAll.value
  if (applyAll.value) selectedSlots.value = new Set()
}
function toggleSlot(slot) {
  const next = new Set(selectedSlots.value)
  if (next.has(slot)) {
    next.delete(slot)
  } else {
    next.add(slot)
    applyAll.value = false
  }
  selectedSlots.value = next
}

// Badge status ringkas di atas
const statusBadge = computed(() => {
  const f = form.value
  if (!f.outsideHoursEnabled && !f.greetEnabled) {
    return { text: '● Nonaktif', class: 'bg-gray-100 text-gray-500' }
  }
  const parts = []
  if (f.outsideHoursEnabled) parts.push('Outside hours ON')
  if (f.greetEnabled) parts.push('Greeting ON')
  const days = []
  if (f.monFriEnabled) days.push(`Sen–Jum ${f.monFriStart}–${f.monFriEnd}`)
  if (f.satEnabled) days.push(`Sab ${f.satStart}–${f.satEnd}`)
  if (f.sunEnabled) days.push(`Min ${f.sunStart}–${f.sunEnd}`)
  const jam = days.length > 0 ? days.join(' · ') : 'Jam operasional kosong'
  return { text: `● Aktif · ${parts.join(' + ')} · ${jam}`, class: 'bg-green-100 text-green-700' }
})

// Preview {name} → contoh nama "Kakak"
function preview(text) {
  return (text || '').replace(/\{name\}/g, 'Kakak')
}

async function fetchConfig() {
  try {
    const res = await axios.get(`${API}/api/autoreply`)
    const cfg = res.data.config
    for (const key of Object.keys(form.value)) {
      if (cfg[key] !== undefined) form.value[key] = cfg[key]
    }
    // v0.13.0 — greetMode default "text" bila backend belum punya kolom
    if (!form.value.greetMode) form.value.greetMode = 'text'
    // v4.0.0 — CB-AI fields default aman bila backend belum punya kolom
    if (!form.value.outsideHoursMode) form.value.outsideHoursMode = 'text'
    if (!form.value.cbaiLimit) form.value.cbaiLimit = 3
    form.value.cbaiInfoFooter = form.value.cbaiInfoFooter !== false
    // v3.9.4 — daftar slot + state tick-box dari server (persist!)
    const st = await axios.get(`${API}/api/wa/status`)
    waSlots.value = st.data.slots || []
    const scoped = res.data.numberSlots || []
    menuManagedSet.value = new Set(res.data.menuManagedSlots || [])
    if (scoped.length > 0) {
      applyAll.value = false
      selectedSlots.value = new Set(scoped)
      // v3.9.4 — form menampilkan rules scoped yang AKTIF (ambil dari slot pertama
      // tercentang — baseline shared sengaja dinetralkan server saat mode per-slot)
      try {
        const sc = await axios.get(`${API}/api/autoreply?slot=${scoped[0]}`)
        for (const key of Object.keys(form.value)) {
          if (sc.data.config[key] !== undefined) form.value[key] = sc.data.config[key]
        }
      } catch {}
    } else {
      applyAll.value = true
      selectedSlots.value = new Set()
    }
    // v4.0.0 — plan gate CB-AI: GET /api/ai-knowledge 403 = plan ✗ (upsell banner);
    // 200 → config + aiUsage utk kartu Pengaturan CB-AI
    try {
      const kb = await axios.get(`${API}/api/ai-knowledge`)
      aiPlanOk.value = true
      aiUsage.value = kb.data?.aiUsage || null
      if (kb.data?.config) {
        form.value.cbaiLimit = kb.data.config.cbaiLimit ?? 3
        form.value.cbaiInfoFooter = kb.data.config.cbaiInfoFooter !== false
      }
    } catch (kbErr) {
      if (kbErr?.response?.status === 403) aiPlanOk.value = false
      else if (kbErr?.response?.status === 401) throw kbErr // auth error → toast utama
    }
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Gagal memuat', message: e.response?.data?.error || 'Config tidak bisa dimuat' })
  } finally {
    loading.value = false
  }
}

async function save() {
  // v3.9.4 — guard: mode per-slot tanpa satu pun centangan → tolak (jangan kirim 400)
  if (waSlots.value.length > 0 && !applyAll.value && selectedSlots.value.size === 0) {
    toast.show({ icon: '⚠️', title: 'Belum ada nomor dipilih', message: 'Centang minimal satu nomor (atau Semua nomor).' })
    return
  }
  // v4.0.0 — guard plan client: radio CB-AI hanya boleh dikirim bila plan ✓
  if (!aiPlanOk.value && (form.value.greetMode === 'cbai' || form.value.outsideHoursMode === 'cbai')) {
    toast.show({ icon: '⚠️', title: 'Fitur belum tersedia', message: 'ChatBareng AI tidak tersedia di paket kamu — hubungi admin platform untuk upgrade.' })
    return
  }
  // Validasi ringan di client sebelum PUT
  for (const row of hourRows) {
    if (form.value[row.prefix + 'Enabled'] && form.value[row.prefix + 'Start'] >= form.value[row.prefix + 'End']) {
      toast.show({ icon: '⚠️', title: 'Jam tidak valid', message: `${row.label}: jam mulai harus lebih kecil dari jam selesai` })
      return
    }
  }
  saving.value = true
  try {
    // v3.9.4 — numberAll + numberSlots (tick-box); legacy numberSlot tidak lagi
    // dikirim dari UI baru
    const body = { ...form.value }
    // v4.0.0 — plan ✗ → JANGAN kirim nilai cbai (biar 403 tidak menyala gara-gara pre-set)
    if (!aiPlanOk.value) {
      if (body.greetMode === 'cbai') body.greetMode = 'text'
      if (body.outsideHoursMode === 'cbai') body.outsideHoursMode = 'text'
      delete body.cbaiLimit
      delete body.cbaiInfoFooter
    }
    if (waSlots.value.length > 0) {
      if (applyAll.value) {
        body.numberAll = true
        body.numberSlots = null
      } else {
        body.numberAll = false
        body.numberSlots = [...selectedSlots.value]
      }
    }
    const res = await axios.put(`${API}/api/autoreply`, body)
    const cfg = res.data.config
    // v0.13.2 — sinkron otomatis: mode menu → gateway ON; mode text → gateway OFF
    if (res.data.menuGatewayEnabled === true) {
      toast.show({ icon: '🔗', title: 'Menu Gateway aktif', message: 'Saklar di halaman Menu Gateway ikut menyala otomatis' })
    }
    for (const key of Object.keys(form.value)) {
      if (cfg[key] !== undefined) form.value[key] = cfg[key]
    }
    toast.show({ icon: '✅', title: 'Tersimpan', message: 'Config Auto Reply berhasil disimpan' })
    // v4.0.0 — refresh plan gate (plan bisa berubah; GET ikutkan cbai echo)
    try {
      const cfg2 = await axios.get(`${API}/api/ai-knowledge`)
      if (cfg2.data?.config) {
        form.value.cbaiLimit = cfg2.data.config.cbaiLimit ?? form.value.cbaiLimit
        form.value.cbaiInfoFooter = cfg2.data.config.cbaiInfoFooter !== false
      }
      aiUsage.value = cfg2.data?.aiUsage || null
      aiPlanOk.value = !!cfg2.data?.aiUsage
    } catch {}
  } catch (e) {
    // v3.9.4 — 409 = slot dilindungi Menu Gateway (proteksi hybrid)
    toast.show({ icon: '⚠️', title: e?.response?.status === 409 ? 'Slot dikelola Menu Gateway' : 'Gagal simpan', message: e.response?.data?.error || 'Terjadi kesalahan' })
  } finally {
    saving.value = false
  }
}

function handleLogout() {
  auth.logout()
  window.location.href = '/login'
}

onMounted(fetchConfig)
</script>