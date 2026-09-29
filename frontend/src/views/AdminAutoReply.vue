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
      <!-- v4.2.0 — Bar atas BARU (spec §3.1): dropdown scope pengaturan.
           "Default (Semua nomor)" + satu opsi per slot (label custom | 'Slot N')
           + badge Custom / ikut-Default / menu (disabled + tooltip). -->
      <div class="bg-white rounded-lg shadow-sm p-4">
        <div class="flex flex-wrap items-center gap-3">
          <span class="text-sm text-gray-600">Pengaturan untuk:</span>
          <select
            v-model="selectedScope"
            :disabled="optionsLoading"
            class="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
            style="min-height: 44px; min-width: 220px;"
          >
            <option value="default">Default (Semua nomor)</option>
            <option v-for="s in slotOptions" :key="s.slot" :value="String(s.slot)" :disabled="s.menuManaged">
              {{ scopeOptionLabel(s) }}
            </option>
          </select>
          <span v-if="optionsLoading" class="text-xs text-gray-400">Memuat nomor...</span>
        </div>
      </div>

      <!-- v4.2.0 — banner "masih mengikuti Default" (spec §3.2): slot tanpa row sendiri.
           Badge "menu" utk slot menu-managed (dilindungi — dikelola Menu Gateway). -->
      <div v-if="isSlotScope && currentSlotInfo?.menuManaged" class="bg-purple-50 rounded-lg shadow-sm p-4">
        <p class="text-sm text-purple-800">
          Nomor ini sedang dikelola Menu Gateway — matikan menu untuk slot itu di halaman Menu Gateway dulu, lalu simpan ulang di sini.
          <router-link to="/admin/menu-gateway" class="underline font-medium">Buka Menu Gateway →</router-link>
        </p>
      </div>
      <div v-else-if="isSlotScope && !currentSlotInfo?.custom" class="bg-blue-50 rounded-lg shadow-sm p-4">
        <p class="text-sm text-blue-800">Nomor ini masih mengikuti Default — menekan Simpan akan membuatnya Custom.</p>
      </div>

      <!-- Badge status ringkas -->
      <div class="bg-white rounded-lg shadow-sm p-4">
        <div class="flex flex-wrap items-center gap-2">
          <span :class="['inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium', statusBadge.class]">
            {{ statusBadge.text }}
          </span>
          <!-- v4.2.0 — badge Custom (slot dgn row sendiri; hilang setelah reset) -->
          <span v-if="isSlotScope && currentSlotInfo?.custom" class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-purple-100 text-purple-700">
            🟣 Custom
          </span>
        </div>
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
            <!-- v4.2.0 (Audit R3 N5) — form echo mode menu (shared/slot menu-managed):
                 radio text/cbai JUGA di-disable — takeover greeting hanya lewat Menu
                 Gateway (BE: PUT /default dgn greet* → 409 dgn pesan yang sama). -->
            <label class="flex items-center gap-1.5 text-sm text-gray-800 cursor-pointer" :class="menuManagedEcho ? 'opacity-50 cursor-not-allowed' : ''" style="min-height: 36px;" :title="menuManagedEcho ? menuRadioTitle : ''">
              <input v-model="form.greetMode" type="radio" value="text" :disabled="menuManagedEcho" class="w-4 h-4 accent-green-600" />
              Teks biasa
            </label>
            <label
              class="flex items-center gap-1.5 cursor-pointer"
              style="min-height: 36px;"
              :class="(!aiPlanOk || menuManagedEcho) ? 'opacity-50' : ''"
              :title="menuManagedEcho ? menuRadioTitle : (aiPlanOk ? '' : 'AI menjawab dari dokumen yang kamu ajarkan di menu ChatBareng AI')"
            >
              <input v-model="form.greetMode" type="radio" value="cbai" :disabled="!aiPlanOk || menuManagedEcho" class="w-4 h-4 accent-green-600" />
              <span class="text-sm text-gray-800">ChatBareng AI (dari KB)</span>
            </label>
            <label
              class="flex items-center gap-1.5 cursor-not-allowed opacity-50"
              style="min-height: 36px;"
              :title="menuRadioTitle"
            >
              <!-- v4.2.0 (Audit Kimi K3 BUG#1 opsi A): mode menu = milik halaman Menu
                   Gateway — radio legacy DINONAKTIFKAN (menu → 400 dari endpoint baru;
                   konfigurasi menu lewat halaman Menu Gateway) -->
              <input v-model="form.greetMode" type="radio" value="menu" disabled class="w-4 h-4 accent-green-600" />
              <span class="text-sm text-gray-800">Menu gateway (pilihan topik)</span>
              <router-link to="/admin/menu-gateway" class="text-xs text-green-700 hover:underline" @click.stop>→ Buka Menu Gateway</router-link>
            </label>
          </div>
          <p v-if="!aiPlanOk && form.greetMode !== 'menu'" class="text-xs px-3 py-2 rounded-lg bg-amber-50 text-amber-700">
            ChatBareng AI belum tersedia di paket kamu — hubungi admin platform untuk upgrade.
          </p>
          <p v-if="form.greetMode === 'menu'" class="text-xs text-amber-600">
            Greeting dikelola oleh Menu Gateway — matikan menunya dulu di halaman Menu Gateway
            untuk mengambil alih greeting di sini.
            <router-link to="/admin/menu-gateway" class="underline">Buka Menu Gateway</router-link>
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

      <!-- v4.2.0 (spec §3.4) — Kartu CB-AI HANYA di view Default.
           Di view slot: panel ringkas read-only + tombol link "Buka Default". -->
      <div v-if="!isSlotScope" class="bg-white rounded-lg shadow-sm p-6">
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
          <!-- v4.1.1 (D5b) — counter transparan: edukasi reset 24 jam -->
          <p class="text-xs text-gray-400 mt-1">Limit per chat · reset 24 jam — chat baru mulai dari 0.</p>
        </div>
        <label class="flex items-center justify-between mt-4 cursor-pointer">
          <div>
            <span class="text-sm text-gray-800">Footer "info per tanggal" di jawaban AI</span>
            <p class="text-xs text-gray-500">Tanggal dokumen KB terbaru dicantumkan di akhir jawaban (default ON)</p>
          </div>
          <M3Switch v-model="form.cbaiInfoFooter" :disabled="!aiPlanOk || saving" />
        </label>
      </div>
      <div v-else class="bg-white rounded-lg shadow-sm p-6">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 class="font-semibold text-gray-900">🧠 Pengaturan AI (KB, persona, batas)</h2>
            <p class="text-xs text-gray-500 mt-1">Diatur di Default — sama untuk semua nomor.</p>
          </div>
          <button
            @click="selectedScope = 'default'"
            class="px-4 py-2 rounded-lg text-sm font-medium border border-green-600 text-green-700 hover:bg-green-50"
          >
            Buka Default
          </button>
        </div>
      </div>

      <!-- v4.0.0b hotfix — Frekuensi greeting: kartu sendiri (aturan greeting, BUKAN bagian CB-AI) -->
      <div class="bg-white rounded-lg shadow-sm p-6">
        <div class="mt-1">
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
          <p class="text-xs text-gray-400 mt-1">Mengatur seberapa sering sapaan/greeting terkirim ke kontak yang sama (berlaku juga utk menu gateway). Pengaturan lama di Menu Gateway tetap berlaku sampai kamu menyimpan dari sini.</p>
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

      <!-- Save bar (v4.2.0 — spec §3.3): Simpan; slot Custom → tombol Reset ke Default (modal tipis). -->
      <div class="flex justify-end items-center gap-3 flex-wrap">
        <button
          v-if="isSlotScope && currentSlotInfo?.custom"
          @click="showResetModal = true"
          :disabled="saving"
          class="px-4 py-2.5 rounded-lg text-sm font-medium border border-green-600 text-green-700 hover:bg-green-50 disabled:opacity-50"
        >
          Reset ke Default
        </button>
        <button
          @click="save"
          :disabled="saving"
          class="px-6 py-2.5 bg-wa-green text-white rounded-lg text-sm font-medium hover:bg-green-600 disabled:opacity-50"
        >
          {{ saving ? 'Menyimpan...' : 'Simpan' }}
        </button>
      </div>
    </div>

    <!-- v4.2.0 (spec §3.3) — modal konfirmasi Reset ke Default (tipis) -->
    <div v-if="showResetModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" @click.self="showResetModal = false">
      <div class="bg-white rounded-lg shadow-xl max-w-sm w-full p-5">
        <h3 class="font-semibold text-gray-900">Reset ke Default?</h3>
        <p class="text-sm text-gray-600 mt-2">Kembalikan pengaturan nomor ini ke Default? Pengaturan khususnya akan dihapus.</p>
        <div class="flex justify-end gap-2 mt-4">
          <button @click="showResetModal = false" class="px-4 py-2 rounded-lg text-sm text-gray-700 hover:bg-gray-100">Batal</button>
          <button
            @click="resetSlot"
            :disabled="resetting"
            class="px-4 py-2 rounded-lg text-sm font-medium bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50"
          >
            {{ resetting ? 'Mereset...' : 'Reset' }}
          </button>
        </div>
      </div>
    </div>
  </PageShell>
</template>

<script setup>
import axios from 'axios'
import { ref, computed, onMounted, watch } from 'vue'
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

// ═══ v4.2.0 — view scope (spec §3): 'default' ATAU '0'..'2' (string utk <option>, path URL param)
const selectedScope = ref('default')
const isSlotScope = computed(() => selectedScope.value !== 'default')
const currentSlot = computed(() => (isSlotScope.value ? parseInt(selectedScope.value, 10) : null))
// validasi client: scope harus 0..2 (slot ngawur → kembali ke Default) — backend tetap 400
if (Number.isNaN(currentSlot.value)) selectedScope.value = 'default'

// v4.2.0 — GET /options (spec §2.1): dropdown + badge Custom/menu-managed.
// Di-fetch ulang tiap sukses save/reset (badge hilang/muncul setelah aksi).
const slotOptions = ref([])
const optionsLoading = ref(false)
const currentSlotInfo = computed(() => slotOptions.value.find((s) => s.slot === currentSlot.value) || null)

function scopeOptionLabel(s) {
  if (s.menuManaged) return `Slot ${s.slot} · menu`
  const base = s.label || `Slot ${s.slot}`
  return s.custom ? `${base} · Custom` : base
}

async function fetchOptions() {
  optionsLoading.value = true
  try {
    const res = await axios.get(`${API}/api/autoreply/options`)
    slotOptions.value = res.data.slots || []
  } catch (e) {
    // dropdown tetap jalan dgn slot-0 sintetis bila options gagal (GET utama tetap dicoba)
    slotOptions.value = []
  } finally {
    optionsLoading.value = false
  }
}

// v4.2.0 — pindah scope → form diisi nilai EFEKTIF view itu (spec §3.2):
// Default → GET /api/autoreply (shared); Slot N → GET /api/autoreply?slot=N
// (merge fallback shared + overlay CB-AI di backend).
async function loadScopeConfig() {
  try {
    const url = isSlotScope.value ? `${API}/api/autoreply?slot=${currentSlot.value}` : `${API}/api/autoreply`
    const res = await axios.get(url)
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
    // CB-AI shared: echo kartu CB-AI (pola v4.0.0) — hanya relevan di view Default
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
      // 401 → biarkan fetch utama yang melempar error auth
    }
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Gagal memuat', message: e.response?.data?.error || 'Config tidak bisa dimuat' })
  }
}

// pindah dropdown → reload form utk scope baru (watch, bukan handler terpisah).
// v4.2.0 (Kimi K3 R1 N2) — form dirty dibuang TANPA konfirmasi (keputusan UX sadar;
// konsisten dgn halaman config lain di aplikasi — spec §3 tidak mewajibkan confirm).
watch(selectedScope, () => {
  loadScopeConfig()
})

// Badge status ringkas di atas (v4.2.0 — tanpa tick-box; view-scope aktif saja)
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

// v4.2.0 (Audit BUG#1 opsi A) — tooltip radio menu (dinonaktifkan): menu dikelola Menu Gateway
const menuRadioTitle = 'Greeting dikelola Menu Gateway — matikan menunya dulu di halaman Menu Gateway untuk mengambil alih greeting di sini'
// v4.2.0 (Audit R3 N5) — form sedang MENG-ECHO baris menu-managed (greetMode 'menu'
// dari Menu Gateway legacy link-all / slot menu): radio text/cbai ikut disabled selama
// tampilan ini menampilkan greeting milik Menu Gateway.
const menuManagedEcho = computed(() => form.value.greetMode === 'menu')

async function save() {
  // v4.2.0 — guard plan client: radio CB-AI hanya boleh dikirim bila plan ✓
  if (!aiPlanOk.value && (form.value.greetMode === 'cbai' || form.value.outsideHoursMode === 'cbai')) {
    toast.show({ icon: '⚠️', title: 'Fitur belum tersedia', message: 'ChatBareng AI tidak tersedia di paket kamu — hubungi admin platform untuk upgrade.' })
    return
  }
  // v4.2.0 (Audit BUG#1) — radio menu disabled; kalau masih ada greetMode 'menu'
  // (mis. slot menu-managed → form echo mode menu), JANGAN kirim greetMode ke endpoint
  // baru (500 → 400); FE menampilkan banner proteksi di atas.
  const body = { ...form.value }
  if (body.greetMode === 'menu') delete body.greetMode
  // guard slot menu-managed: server akan 409; cegah save useless + toast jelas
  if (isSlotScope.value && currentSlotInfo.value?.menuManaged) {
    toast.show({ icon: '⚠️', title: 'Slot dikelola Menu Gateway', message: 'Matikan menu untuk slot itu di halaman Menu Gateway dulu, lalu simpan ulang di sini.' })
    return
  }
  // v4.2.0 (Audit R3 N5) — view Default menu-managed: field greet* DILARANG (server
  // 409 "Greeting dikelola Menu Gateway…"); FE cegah save useless + pesan jelas.
  if (!isSlotScope.value && form.value.greetMode === 'menu') {
    toast.show({ icon: '⚠️', title: 'Greeting dikelola Menu Gateway', message: 'Matikan menunya di halaman Menu Gateway dulu, lalu simpan ulang di sini.' })
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
    // v4.2.0 (spec §3.4) — CB-AI + scope-fields TIDAK PERNAH dikirim dari view slot;
    // CB-AI hanya di PUT /default (shared = pemilik KB & persona).
    if (isSlotScope.value) {
      for (const k of ['cbaiLimit', 'cbaiInfoFooter']) delete body[k]
    }
    // v4.0.0 — plan ✗ → JANGAN kirim nilai cbai (biar 403 tidak menyala gara-gara pre-set)
    if (!aiPlanOk.value) {
      if (body.greetMode === 'cbai') body.greetMode = 'text'
      if (body.outsideHoursMode === 'cbai') body.outsideHoursMode = 'text'
      delete body.cbaiLimit
      delete body.cbaiInfoFooter
    }
    const res = isSlotScope.value
      ? await axios.put(`${API}/api/autoreply/slot/${currentSlot.value}`, body)
      : await axios.put(`${API}/api/autoreply/default`, body)
    const cfg = res.data.config
    for (const key of Object.keys(form.value)) {
      if (cfg[key] !== undefined) form.value[key] = cfg[key]
    }
    toast.show({
      icon: '✅',
      title: 'Tersimpan',
      message: isSlotScope.value
        ? `Pengaturan slot ${currentSlot.value} disimpan (Custom — bebas dari Default)`
        : 'Pengaturan Default berhasil disimpan',
    })
    // v4.2.0 — refresh badge scope (slot bisa jadi Custom) + plan gate (plan bisa berubah)
    fetchOptions()
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
    // v3.9.4/v4.2.0 — 409 = slot dilindungi Menu Gateway (proteksi hybrid)
    toast.show({ icon: '⚠️', title: e?.response?.status === 409 ? 'Slot dikelola Menu Gateway' : 'Gagal simpan', message: e.response?.data?.error || 'Terjadi kesalahan' })
  } finally {
    saving.value = false
  }
}

// v4.2.0 (spec §3.3) — Reset ke Default: DELETE row slot (modal konfirmasi di atas)
const showResetModal = ref(false)
const resetting = ref(false)

async function resetSlot() {
  resetting.value = true
  try {
    await axios.delete(`${API}/api/autoreply/slot/${currentSlot.value}`)
    showResetModal.value = false
    toast.show({ icon: '✅', title: 'Di-reset ke Default', message: `Nomor slot ${currentSlot.value} kembali mengikuti Default.` })
    // badge Custom hilang + form kembali ke nilai EFEKTIF (mirror Default)
    await fetchOptions()
    await loadScopeConfig()
  } catch (e) {
    toast.show({ icon: '⚠️', title: e?.response?.status === 409 ? 'Slot dikelola Menu Gateway' : 'Gagal reset', message: e.response?.data?.error || 'Terjadi kesalahan' })
  } finally {
    resetting.value = false
  }
}

function handleLogout() {
  auth.logout()
  window.location.href = '/login'
}

onMounted(async () => {
  await fetchOptions()
  await loadScopeConfig()
  loading.value = false
})
</script>