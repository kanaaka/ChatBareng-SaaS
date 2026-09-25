<template>
  <!--
    v0.13.0 — Admin "🧭 Menu Gateway" (pola AdminAutoReply/AdminCsat).
    Kartu Status (toggle + repeat + timeout + fallback) · Kartu Intro (textarea +
    counter + preview live) · Kartu Opsi (list dinamis 2..8, reorder ↑↓, add/remove,
    tag select) · satu tombol Simpan → PUT /api/menu-gateway. Dark-safe via token M3.
    v3.9.25 — + Kartu AI Hybrid Routing (Beta): toggle (disabled+upsell bila plan ✗),
    slider aiThreshold 0.50–0.95 + 3 preset + keterangan dinamis + info box + hint
    biaya aiUsage; per-opsi textarea "Deskripsi AI (opsional, ≤200)". TANPA v-html.
  -->
  <PageShell title="Menu Gateway" back-to="/admin/autoreply">
    <header class="hidden md:flex m3-topbar px-4 py-3 items-center justify-between">
      <div class="flex items-center gap-3">
        <h1 class="text-lg font-semibold">Menu Gateway</h1>
      </div>
      <div class="flex items-center gap-4">
        <button @click="handleLogout" class="text-sm hover:underline">Logout</button>
      </div>
    </header>

    <div class="max-w-4xl mx-auto w-full p-6 space-y-4">
      <!-- Kartu 1 — Status & trigger -->
      <div class="m3-card p-6">
        <div class="flex items-center justify-between gap-4">
          <div>
            <h2 class="font-semibold text-gray-900 flex items-center gap-2">Status Menu Gateway</h2>
            <p class="text-xs text-gray-500 mt-1">
              Pelanggan baru menerima menu bernomor; jawabannya menentukan balasan, tag, dan baru kemudian masuk antrean.
            </p>
          </div>
          <M3Switch v-model="form.enabled" :disabled="saving" />
        </div>
        <div class="mt-3">
          <span :class="['inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium', form.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500']">
            {{ form.enabled ? '● Aktif — menu terkirim ke chat baru (jam kerja, via First-of-Day Greeting)' : '● Nonaktif — tidak ada menu terkirim' }}
          </span>
        </div>
        <p class="text-xs text-gray-400 mt-1">
          v0.13.2 — Saklar ini = satu saklar efektif bersama radio "Mode greeting" di halaman
          Auto Reply (sinkron otomatis 2 arah saat disimpan). Nyalakan di sini → radio ikut
          "Menu gateway"; radio ke Teks biasa → saklar ini ikut mati.
        </p>

        <div class="mt-5 flex flex-col sm:flex-row gap-3">
          <label class="flex-1">
            <span class="text-xs text-gray-600 block mb-1">Frekuensi greeting (menu & teks)</span>
            <select
              v-model="form.repeatFrequency"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
              style="min-height: 44px;"
            >
              <option value="per_chat">Tiap chat baru</option>
              <option value="daily">Sekali per hari</option>
              <option value="weekly">Sekali per minggu</option>
            </select>
          </label>
          <label class="sm:w-40">
            <span class="text-xs text-gray-600 block mb-1">Timeout jawaban</span>
            <input
              v-model.number="form.timeoutValue"
              type="number"
              :min="form.timeoutUnit === 'seconds' ? 10 : 1"
              :max="form.timeoutUnit === 'seconds' ? 3600 : 60"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              style="min-height: 44px;"
            />
          </label>
          <label class="sm:w-36">
            <span class="text-xs text-gray-600 block mb-1">Satuan</span>
            <select
              v-model="form.timeoutUnit"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
              style="min-height: 44px;"
            >
              <option value="seconds">Detik</option>
              <option value="minutes">Menit</option>
            </select>
          </label>
        </div>
        <div class="mt-2 text-xs text-gray-400">
          {{ timeoutHint }}
        </div>

        <div class="mt-5">
          <span class="text-xs text-gray-600 block mb-1">Fallback — jawaban tidak cocok</span>
          <textarea
            v-model="form.fallbackText"
            rows="2"
            maxlength="500"
            class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            placeholder="Teks saat pelanggan menjawab di luar menu..."
          ></textarea>
          <div class="flex items-center justify-between mt-1">
            <label class="text-xs text-gray-500 flex items-center gap-2">
              Tag fallback (Lainnya):
              <TagSelect
                v-model="form.fallbackTagId"
                :tags="tags"
                @created="t => upsertLocalTag(t)"
              />
            </label>
            <span class="text-xs text-gray-400">{{ (form.fallbackText || '').length }}/500</span>
          </div>
          <p class="text-xs text-gray-400 mt-1">Fallback selalu lanjut ke antrean (tanpa menu kedua). Timeout → antrean tanpa tag.</p>
        </div>
      </div>

      <!-- Kartu 2 — Intro (v0.13.1: kalimat pembuka SAJA — list otomatis dari Opsi Menu;
           preview dipindah ke kartu terpisah SETELAH Opsi Menu, 1:1 dgn pesan asli) -->
      <div class="m3-card p-6">
        <h2 class="font-semibold text-gray-900 mb-1">Intro Menu</h2>
        <p class="text-xs text-gray-500 mb-3">
          Kalimat pembuka SAJA (list bernomor otomatis dibuat dari <b>Opsi Menu</b> di bawah).
          Maksimal 1000 karakter. Placeholder <code class="bg-gray-100 px-1 rounded">{name}</code> diganti nama pelanggan.
        </p>
        <textarea
          v-model="form.introText"
          rows="2"
          maxlength="1000"
          class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          placeholder="Halo {name}! Silakan pilih topik yang ingin Anda sampaikan:"
        ></textarea>
        <div class="text-xs text-gray-400 mt-1 text-right">{{ (form.introText || '').length }}/1000</div>
      </div>

      <!-- v3.9.25 — AI Hybrid Routing (Beta): LLM classifier fallback (D1–D8 spec §7/§7b).
           Toggle + slider threshold + preset + keterangan dinamis + hint biaya.
           TANPA v-html — semua teks via interpolasi. -->
      <div class="m3-card p-6">
        <div class="flex items-center justify-between gap-4">
          <div>
            <h2 class="font-semibold text-gray-900 flex items-center gap-2">AI Hybrid Routing <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-green-100 text-green-700">Beta</span></h2>
            <p class="text-xs text-gray-500 mt-1">
              Kalau jawaban customer gak kena keyword, AI pilihkan rute — balasan tetap pesan resmi kamu.
            </p>
          </div>
          <M3Switch
            v-model="form.aiHybrid"
            :disabled="saving || !aiPlanOk"
            :title="aiPlanOk ? '' : 'Fitur belum tersedia di paket Anda — hubungi admin platform untuk upgrade'"
          />
        </div>
        <p v-if="!aiPlanOk" class="text-xs mt-2 px-3 py-2 rounded-lg bg-amber-50 text-amber-700">
          Fitur ini belum tersedia di paket Anda. Hubungi admin platform untuk upgrade — setelah aktif, toggle + slider di bawah bisa dipakai.
        </p>
        <p v-if="aiUsage" class="text-xs text-gray-400 mt-2">
          ≈ Rp {{ (aiUsage.costRp || 0).toLocaleString('id-ID') }} bulan ini — metering otomatis ({{ aiUsage.calls || 0 }} call AI).
        </p>

        <div class="mt-4">
          <span class="text-xs text-gray-600 block mb-1">Ambang keyakinan AI (aiThreshold)</span>
          <div class="flex flex-wrap items-center gap-2 mb-2">
            <input
              v-model.number="form.aiThreshold"
              type="range"
              min="0.50"
              max="0.95"
              step="0.05"
              :disabled="saving || !aiPlanOk"
              class="flex-1 min-w-[180px] accent-green-600"
            />
            <span class="text-sm font-semibold text-gray-800 tabular-nums">{{ thresholdLabel }}</span>
          </div>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="p in thresholdPresets"
              :key="p.value"
              type="button"
              :disabled="saving || !aiPlanOk"
              @click="form.aiThreshold = p.value"
              class="px-3 py-1.5 rounded-full text-xs border"
              :class="Number(form.aiThreshold) === p.value ? 'bg-green-600 text-white border-green-600' : 'border-gray-300 text-gray-600 hover:bg-gray-50'"
              :title="p.desc"
            >{{ p.label }} ({{ p.value.toFixed(2) }})</button>
          </div>
          <p class="text-xs text-gray-500 mt-2">Angka = seberapa yakin AI minimal sebelum menyuruh sistem menyuruhkan percakapan.</p>
          <p class="text-xs text-gray-500">≥ {{ thresholdLabel }} → AI salurkan otomatis: tag + balasan resmi kamu terkirim.</p>
          <p class="text-xs text-gray-500">< {{ thresholdLabel }} → AI diam. Pesan masuk antrean CS seperti biasa (perilaku tanpa AI).</p>
          <div class="text-xs text-gray-600 mt-2 px-3 py-2 rounded-lg" style="background: var(--md-sys-color-surface-container-high, #f3f0f7);">
            Semakin tinggi = semakin selektif AI. Dan aman di titik mana pun: AI <b>tidak pernah menulis balasan sendiri</b> — salah rute sekalipun, yang terkirim tetap pesan resmi yang kamu setel.
          </div>
          <p class="text-xs text-gray-400 mt-1">Boleh disetel dulu walau toggle masih OFF (pre-set sebelum menyalakan).</p>
        </div>
      </div>

      <!-- Kartu 3 — Opsi -->
      <div class="m3-card p-6">
        <div class="flex items-center justify-between mb-1">
          <h2 class="font-semibold text-gray-900">Opsi Menu ({{ form.options.length }}/8)</h2>
          <button
            v-if="form.options.length < 8"
            @click="addOption"
            class="m3-btn m3-btn--tonal !min-h-[36px] !px-3 text-xs"
          >
            + Tambah opsi
          </button>
        </div>
        <p class="text-xs text-gray-500 mb-3">
          Nomor menu = urutan (otomatis). <b>Aliases</b> = kata kunci TAMBAHAN opsional dipisah koma
          (maks 5) — angka 1-8 sudah otomatis tanpa perlu diketik. Minimal 1 opsi punya balasan.
          Tag menempel ke kontak saat opsi dipilih — bisa pilih existing atau <b>+ Buat tag baru</b> di tempat.
          <span v-if="aiPlanOk"> <b>Deskripsi AI</b> (opsional) bantu AI paham konteks rute saat jawaban customer gak kena keyword.</span>
        </p>

        <div class="space-y-3">
          <div
            v-for="(opt, idx) in form.options"
            :key="idx"
            class="border border-gray-200 rounded-lg p-3 space-y-2"
          >
            <div class="flex items-center justify-between gap-2">
              <span class="inline-flex items-center justify-center w-7 h-7 rounded-full text-sm font-semibold" style="background: var(--md-sys-color-primary-container, #e8f5e9);">{{ idx + 1 }}</span>
              <div class="flex items-center gap-1">
                <button
                  @click="moveUp(idx)"
                  :disabled="idx === 0"
                  class="px-2 py-1 rounded-md text-sm disabled:opacity-30 hover:bg-gray-100"
                  title="Naik"
                >↑</button>
                <button
                  @click="moveDown(idx)"
                  :disabled="idx === form.options.length - 1"
                  class="px-2 py-1 rounded-md text-sm disabled:opacity-30 hover:bg-gray-100"
                  title="Turun"
                >↓</button>
                <button
                  @click="removeOption(idx)"
                  class="px-2 py-1 rounded-md text-sm hover:bg-red-50"
                  title="Hapus opsi"
                >🗑</button>
              </div>
            </div>
            <input
              v-model="opt.label"
              maxlength="50"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              placeholder="Label menu (mis. Komplain)"
            />
            <input
              v-model="opt.aliases"
              maxlength="200"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              placeholder="Alias kata kunci, dipisah koma (mis. komplain, keluhan)"
            />
            <textarea
              v-model="opt.replyText"
              rows="2"
              maxlength="500"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              placeholder="Balasan konfirmasi saat opsi ini dipilih (mis. 'Siap Kak {name}, kami segera proses.')"
            ></textarea>
            <label class="text-xs text-gray-500 flex items-center gap-2">
              Tag kontak:
              <TagSelect
                v-model="opt.tagId"
                :tags="tags"
                @created="t => upsertLocalTag(t)"
              />
            </label>
            <!-- v3.9.25 — Deskripsi AI (D8): konteks route utk LLM classifier (≤200) -->
            <div>
              <textarea
                v-model="opt.aiDescription"
                rows="2"
                maxlength="200"
                :disabled="!aiPlanOk"
                class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500 disabled:opacity-60"
                placeholder="Deskripsi AI (opsional, ≤200) — mis. 'rute buat pasien mau booking jadwal terapi'. Kosong = AI pakai label + alias."
              ></textarea>
              <div class="text-right text-[10px] text-gray-400">{{ (opt.aiDescription || '').length }}/200</div>
            </div>
          </div>
        </div>
      </div>

      <!-- v0.13.1 — Preview pesan ASLI (intro + list otomatis) — 1:1 dgn yang terkirim -->
      <div class="m3-card p-6">
        <h2 class="font-semibold text-gray-900 mb-1">Preview Pesan ke Pelanggan</h2>
        <p class="text-xs text-gray-500 mb-3">Mengikuti Intro + Opsi Menu secara live — identik dengan pesan yang terkirim.</p>
        <div class="p-3 rounded-lg text-sm" style="background: var(--md-sys-color-surface-container-high, #f3f0f7);">
          <div class="italic text-gray-800 whitespace-pre-line">{{ introPreview }}</div>
        </div>
      </div>

      <!-- Simpan -->
      <div class="flex justify-end items-center gap-3 flex-wrap">
        <!-- v3.9.4 — TICK-BOX (QA #4/#5): pilih nomor mana yang kena menu ini.
             Slot yang punya auto-reply teks aktif dilindungi (disabled + badge). -->
        <div v-if="waSlots.length > 0" class="flex items-center gap-3 flex-wrap">
          <span class="text-sm text-gray-600">Terapkan ke:</span>
          <label class="flex items-center gap-1.5 text-sm" :class="!form.enabled ? 'opacity-50' : 'cursor-pointer'">
            <input type="checkbox" :checked="applyAll" :disabled="!form.enabled" @change="toggleAll" class="w-4 h-4 accent-green-600" />
            Semua nomor
          </label>
          <label
            v-for="s in waSlots"
            :key="s.slot"
            class="flex items-center gap-1.5 text-sm"
            :class="(!form.enabled || arManagedSet.has(s.slot)) ? 'opacity-50' : 'cursor-pointer'"
            :title="arManagedSet.has(s.slot) ? 'Nomor ini punya auto-reply teks aktif — matikan dulu di halaman Auto Reply' : (!form.enabled ? 'Nyalakan saklar utama dulu' : '')"
          >
            <input
              type="checkbox"
              :checked="selectedSlots.has(s.slot)"
              :disabled="!form.enabled || arManagedSet.has(s.slot)"
              @change="toggleSlot(s.slot)"
              class="w-4 h-4 accent-green-600"
            />
            Slot {{ s.slot }}{{ s.label ? ' · ' + s.label : '' }}
            <span v-if="arManagedSet.has(s.slot)" class="text-[10px] px-1.5 py-0.5 rounded-full bg-green-100 text-green-700">auto-reply</span>
          </label>
        </div>
        <p v-if="waSlots.length > 0 && !form.enabled" class="text-xs text-gray-400 w-full">Saklar utama mati — nyalakan dulu untuk memilih nomor.</p>
        <button
          @click="save"
          :disabled="saving"
          class="px-6 py-2.5 bg-wa-green text-white rounded-lg text-sm font-medium hover:bg-green-600 disabled:opacity-50"
          style="min-height: 44px;"
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
import { useToastStore } from '../stores/toast'
import PageShell from '../components/PageShell.vue'
import M3Switch from '../components/M3Switch.vue'
import TagSelect from '../components/TagSelect.vue'
import { useConfirm } from '../utils/confirm'

const API = import.meta.env.VITE_API_URL || ''
const toast = useToastStore()
const { confirmAction } = useConfirm()

const saving = ref(false)
const tags = ref([])

const form = ref({
  enabled: false,
  introText: '',
  fallbackText: '',
  fallbackTagId: null,
  timeoutValue: 30,
  timeoutUnit: 'minutes',
  repeatFrequency: 'daily',
  // v3.9.25 — AI Hybrid Routing (Beta)
  aiHybrid: false,
  aiThreshold: 0.70,
  options: [],
})

// v3.9.25 — plan gate client (menuGateway sudah fitur gated, jadi halaman ini hanya
// muncul bila featMenuGateway ✓; featAiRouting bisa ✗ walau menu gateway ✓)
const aiPlanOk = ref(true)
const aiUsage = ref(null)

// spec §7b — preset threshold klik-instal + keterangan konsekuensi
const thresholdPresets = [
  { label: 'Longgar', value: 0.55, desc: 'AI lebih berani menyala — lebih banyak percakapan tersalur otomatis. Risiko salah rute naik.' },
  { label: 'Seimbang', value: 0.70, desc: 'AI menyala kalau cukup yakin; ragu → antrean CS. Titik awal terbaik.' },
  { label: 'Ketat', value: 0.85, desc: 'AI cuma menyala kalau sangat yakin — lebih aman, tapi lebih banyak pesan jatuh ke antrean CS manual.' },
]
const thresholdLabel = computed(() => Number(form.value.aiThreshold).toFixed(2))

const timeoutHint = computed(() => {
  const u = form.value.timeoutUnit === 'seconds' ? 'detik' : 'menit'
  const eff = form.value.timeoutUnit === 'seconds'
    ? form.value.timeoutValue
    : (form.value.timeoutValue || 0) * 60
  return `Jika pelanggan tidak menjawab dalam ${form.value.timeoutValue} ${u}, chat langsung masuk antrean tanpa tag menu.`
})

// v0.13.1 — Preview = pesan ASLI 1:1 (composeMenuIntro server-side): introText
// (kalimat pembuka saja, list lama di-strip) + list otomatis dari Opsi Menu.
const introPreview = computed(() => {
  let intro = (form.value.introText || '').trim()
  // strip list bernomor legacy di akhir (identik backend)
  intro = intro.replace(/(?:\s*\d+\.\s*[^\n]+)+\s*$/, '').trim()
  const lines = form.value.options
    .map((o, i) => `${i + 1}. ${o.label || '…'}`)
  const composed = lines.length ? `${intro}\n\n${lines.join('\n')}` : intro
  return composed.replace(/\{name\}/g, 'Kakak')
})

function emptyOption(position) {
  return { position, label: '', aliases: '', replyText: '', tagId: null, aiDescription: '' }
}

function addOption() {
  if (form.value.options.length >= 8) return
  // Nomor otomatis = panjang list saat ini + 1 (urutan tampil)
  form.value.options.push(emptyOption(form.value.options.length + 1))
}

// v0.13.1 — tag baru dari TagSelect (inline creation) → masuk daftar lokal biar dropdown lain ikut
function upsertLocalTag(tag) {
  if (!tag || tags.value.some(t => t.id === tag.id)) return
  tags.value = [...tags.value, tag]
}

async function removeOption(idx) {
  const opt = form.value.options[idx]
  const hasValue = (opt.label || '').trim() || (opt.replyText || '').trim() || opt.tagId
  if (hasValue) {
    const ok = await confirmAction({
      title: 'Hapus opsi?',
      message: `Opsi "${opt.label || 'tanpa label'}" akan dihapus dari menu.`,
      confirmText: 'Hapus',
      danger: true,
    })
    if (!ok) return
  }
  form.value.options.splice(idx, 1)
  renumber()
}

// Reorder = swap di array; nomor = index+1 (selalu konsisten)
function moveUp(idx) {
  if (idx === 0) return
  const arr = form.value.options
  ;[arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]]
  renumber()
}
function moveDown(idx) {
  const arr = form.value.options
  if (idx >= arr.length - 1) return
  ;[arr[idx + 1], arr[idx]] = [arr[idx], arr[idx + 1]]
  renumber()
}
function renumber() {
  form.value.options.forEach((o, i) => { o.position = i + 1 })
}

function validateClient() {
  const f = form.value
  if (f.options.length < 2) return 'Minimal 2 opsi menu'
  if (f.options.length > 8) return 'Maksimal 8 opsi'
  if (!(f.introText || '').trim()) return 'Intro menu wajib diisi'
  if ((f.fallbackText || '').trim().length === 0) return 'Fallback text wajib diisi'
  if (!Number.isInteger(f.timeoutValue)) return 'Timeout harus angka'
  if (f.timeoutUnit === 'seconds' && (f.timeoutValue < 10 || f.timeoutValue > 3600)) return 'Timeout 10..3600 detik'
  if (f.timeoutUnit === 'minutes' && (f.timeoutValue < 1 || f.timeoutValue > 60)) return 'Timeout 1..60 menit'
  for (const [i, o] of f.options.entries()) {
    if (!(o.label || '').trim()) return `Opsi ${i + 1}: label wajib diisi`
  }
  // v3.9.25 — AI Hybrid client guard (server tetap validasi keras — defense in depth)
  if (typeof f.aiThreshold !== 'number' || !Number.isFinite(f.aiThreshold) || f.aiThreshold < 0.5 || f.aiThreshold > 0.95) return 'Ambang AI harus 0.50–0.95'
  for (const [i, o] of f.options.entries()) {
    if ((o.aiDescription || '').length > 200) return `Opsi ${i + 1}: Deskripsi AI maksimal 200 karakter`
  }
  if (!f.options.some(o => (o.replyText || '').trim())) return 'Minimal 1 opsi punya balasan konfirmasi'
  return null
}

async function fetchAll() {
  try {
    const res = await axios.get(`${API}/api/menu-gateway`)
    // v3.9 fix BUG-7 — daftar slot (untuk dropdown Terapkan ke)
    try {
      const st = await axios.get(`${API}/api/wa/status`)
      waSlots.value = st.data.slots || []
    } catch {}
    const cfg = res.data.config
    form.value.enabled = !!cfg.enabled
    form.value.introText = cfg.introText || ''
    form.value.fallbackText = cfg.fallbackText || ''
    form.value.fallbackTagId = cfg.fallbackTagId ?? null
    form.value.timeoutValue = cfg.timeoutValue ?? 30
    form.value.timeoutUnit = cfg.timeoutUnit || 'minutes'
    form.value.repeatFrequency = cfg.repeatFrequency || 'daily'
    // v3.9.25 — AI Hybrid state + plan gate + metering (spec §7)
    form.value.aiHybrid = !!cfg.aiHybrid
    form.value.aiThreshold = Number(cfg.aiThreshold ?? 0.70)
    aiPlanOk.value = res.data.aiUsage !== null // plan ✗ → aiUsage null → toggle disabled + upsell
    aiUsage.value = res.data.aiUsage || null
    form.value.options = (cfg.options || []).map(o => ({
      position: o.position,
      label: o.label || '',
      aliases: o.aliases || '',
      replyText: o.replyText || '',
      tagId: o.tagId ?? null,
      aiDescription: o.aiDescription || '',
    }))
    if (form.value.options.length === 0) {
      // Config default baru → sediakan 2 opsi kosong sebagai titik mulai
      form.value.options = [emptyOption(1), emptyOption(2)]
    }
    // v3.9.4 — state tick-box dari server (persist) + slot dilindungi auto-reply
    arManagedSet.value = new Set(res.data.arManagedSlots || [])
    const mgSlots = (res.data.menuManagedSlots || []).map(Number)
    if (mgSlots.length > 0) {
      applyAll.value = false
      selectedSlots.value = new Set(mgSlots)
      // overlay form dari config slot tercentang pertama (scoped yang AKTIF)
      try {
        const sc = await axios.get(`${API}/api/menu-gateway?slot=${mgSlots[0]}`)
        const sCfg = sc.data.config
        form.value.enabled = !!sCfg.enabled
        if (sCfg.introText) form.value.introText = sCfg.introText
        if (sCfg.fallbackText) form.value.fallbackText = sCfg.fallbackText
        form.value.fallbackTagId = sCfg.fallbackTagId ?? form.value.fallbackTagId
        form.value.timeoutValue = sCfg.timeoutValue ?? form.value.timeoutValue
        form.value.timeoutUnit = sCfg.timeoutUnit || form.value.timeoutUnit
        form.value.repeatFrequency = sCfg.repeatFrequency || form.value.repeatFrequency
        if ((sCfg.options || []).length > 0) {
          form.value.options = sCfg.options.map(o => ({
            position: o.position, label: o.label || '', aliases: o.aliases || '', replyText: o.replyText || '', tagId: o.tagId ?? null, aiDescription: o.aiDescription || '',
          }))
        }
      } catch {}
    } else {
      applyAll.value = true
      selectedSlots.value = new Set()
    }
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Gagal memuat', message: e.response?.data?.error || 'Config tidak bisa dimuat' })
  }
  try {
    const res = await axios.get(`${API}/api/tags`)
    tags.value = res.data.tags || []
  } catch (e) { console.error('Fetch tags error:', e) }
}

async function save() {
  // v3.9.5 fix audit MEDIUM-2 — guard sama dgn AutoReply: uncheck semua = tolak dini
  // (hanya saat master ON — toggle OFF = full-off, tick-box tidak dipaksa)
  if (form.value.enabled && waSlots.value.length > 0 && !applyAll.value && selectedSlots.value.size === 0) {
    toast.show({ icon: '⚠️', title: 'Belum ada nomor dipilih', message: 'Centang minimal satu nomor (atau Semua nomor).' })
    return
  }
  const err = validateClient()
  if (err) {
    toast.show({ icon: '⚠️', title: 'Belum valid', message: err })
    return
  }
  saving.value = true
  try {
    const payload = {
      enabled: form.value.enabled,
      introText: form.value.introText,
      fallbackText: form.value.fallbackText,
      fallbackTagId: form.value.fallbackTagId,
      timeoutValue: form.value.timeoutValue,
      timeoutUnit: form.value.timeoutUnit,
      repeatFrequency: form.value.repeatFrequency,
      // v3.9.4 — tick-box scope (legacy numberSlot tetap didukung backend)
      numberSlots: applyAll.value ? null : [...selectedSlots.value],
      aiHybrid: form.value.aiHybrid,
      aiThreshold: form.value.aiThreshold,
      options: form.value.options.map(o => ({
        position: o.position,
        label: o.label,
        aliases: o.aliases || '',
        replyText: o.replyText,
        tagId: o.tagId,
        aiDescription: (o.aiDescription || '').trim(),
      })),
    }
    const res = await axios.put(`${API}/api/menu-gateway`, payload)
    const cfg = res.data.config
    // v0.13.2 — info sinkron: radio greeting di Auto Reply ikut status saklar ini
    if (res.data.greetMode === 'menu') {
      toast.show({ icon: '🔗', title: 'Tersimpan + sinkron', message: 'Radio "Mode greeting" di Auto Reply sekarang = Menu gateway' })
    } else if (res.data.greetMode === 'text') {
      toast.show({ icon: '🔗', title: 'Tersimpan + sinkron', message: 'Radio "Mode greeting" di Auto Reply kembali = Teks biasa' })
    }
    form.value.options = (cfg.options || []).map(o => ({
      position: o.position,
      label: o.label || '',
      aliases: o.aliases || '',
      replyText: o.replyText || '',
      tagId: o.tagId ?? null,
      aiDescription: o.aiDescription || '',
    }))
    // v3.9.25 — refresh state AI setelah save (metering + echo server)
    form.value.aiHybrid = !!cfg.aiHybrid
    form.value.aiThreshold = Number(cfg.aiThreshold ?? form.value.aiThreshold)
    toast.show({ icon: '✅', title: 'Tersimpan', message: 'Config Menu Gateway berhasil disimpan' })
  } catch (e) {
    // v3.9.4 — 409 = slot dilindungi Auto Reply (proteksi hybrid dua arah)
    // v3.9.25 — 403 = plan ✗ (AI Hybrid Routing gate — upsell ramah)
    toast.show({
      icon: '⚠️',
      title: e?.response?.status === 409 ? 'Slot punya auto-reply aktif' : (e?.response?.status === 403 ? 'Fitur belum tersedia di paket Anda' : 'Gagal simpan'),
      message: e.response?.data?.error || 'Terjadi kesalahan',
    })
  } finally {
    saving.value = false
  }
}

// v3.9.4 — TICK-BOX scope (QA #4/#5): applyAll = 'Semua nomor'; selectedSlots =
// slot tercentang (persist via numberSlot config — pilihan tidak hilang lagi).
// arManagedSet = slot dgn auto-reply teks aktif → dilindungi dari save menu.
const waSlots = ref([])
const applyAll = ref(true)
const selectedSlots = ref(new Set())
const arManagedSet = ref(new Set())

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

onMounted(fetchAll)
</script>
