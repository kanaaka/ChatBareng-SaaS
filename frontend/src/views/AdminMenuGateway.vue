<template>
  <!--
    v0.13.0 — Admin "🧭 Menu Gateway" (pola AdminAutoReply/AdminCsat).
    Kartu Status (toggle + repeat + timeout + fallback) · Kartu Intro (textarea +
    counter + preview live) · Kartu Opsi (list dinamis 2..8, reorder ↑↓, add/remove,
    tag select) · satu tombol Simpan → PUT /api/menu-gateway. Dark-safe via token M3.
    v3.9.25 — + Kartu AI Hybrid Routing (Beta): toggle (disabled+upsell bila plan ✗),
    slider aiThreshold 0.50–0.95 + 3 preset + keterangan dinamis + info box + hint
    biaya aiUsage; per-opsi textarea "Deskripsi AI (opsional, ≤200)". TANPA v-html.
    v4.2.1 — Menu Gateway PER-SLOT OVERRIDE (spec docs/spec-v4.2.1-menugateway-per-slot-override.md §3):
    bar atas dropdown "Semua nomor (Default)" + slots (label custom + 🟣 Custom / menu badge,
    disabled+tooltip bila slot punya AR teks aktif), mirror prefill GET ?slot=N + banner biru,
    Save reuse PUT (scopeDefault / numberSlot), Reset ke Default (DELETE slot — modal tipis).
    Tick-box lama DIHAPUS dari FE (BE tetap byte-compat). Master OFF toggle + flyout waiting
    + plan-gate messaging TIDAK diubah.
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
      <!-- v4.2.1 — Bar atas BARU (spec §3.1): dropdown scope pengaturan.
           "Semua nomor (Default)" + satu opsi per slot (label custom | 'Slot N')
           + badge Custom / menu (disabled + tooltip bila slot punya AR teks aktif). -->
      <div class="bg-white rounded-lg shadow-sm p-4">
        <div class="flex flex-wrap items-center gap-3">
          <span class="text-sm text-gray-600">Pengaturan untuk:</span>
          <select
            v-model="selectedScope"
            :disabled="optionsLoading"
            class="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
            style="min-height: 44px; min-width: 220px;"
          >
            <option value="default">Semua nomor (Default)</option>
            <option
              v-for="s in slotOptions"
              :key="s.slot"
              :value="String(s.slot)"
              :disabled="s.arManaged"
              :title="s.arManaged ? 'Nomor ini punya auto-reply teks aktif — matikan dulu di halaman Auto Reply' : ''"
            >
              {{ scopeOptionLabel(s) }}
            </option>
          </select>
          <span v-if="optionsLoading" class="text-xs text-gray-400">Memuat nomor...</span>
        </div>
      </div>

      <!-- v4.2.1 — banner "masih mengikuti Default" (spec §3.2): slot tanpa row menu sendiri.
           Slot dgn AR teks aktif → banner amber (diprotect 409 saat enable menu slot itu). -->
      <div v-if="isSlotScope && currentSlotInfo?.arManaged" class="bg-amber-50 rounded-lg shadow-sm p-4">
        <p class="text-sm text-amber-800">Nomor ini punya auto-reply teks aktif — matikan dulu di halaman Auto Reply, lalu simpan menu di sini.</p>
      </div>
      <div v-else-if="isSlotScope && currentSlotInfo && !currentSlotInfo.custom" class="bg-blue-50 rounded-lg shadow-sm p-4">
        <p class="text-sm text-blue-800">Nomor ini masih mengikuti Default — Simpan akan menjadikannya Custom.</p>
      </div>

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
          <!-- v4.2.1 — badge Custom (slot dgn row menu sendiri; hilang setelah Reset) -->
          <span v-if="isSlotScope && currentSlotInfo?.custom" class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-purple-100 text-purple-700">
            🟣 Custom
          </span>
        </div>
        <p class="text-xs text-gray-400 mt-1">
          v0.13.2 — Saklar ini = satu saklar efektif bersama radio "Mode greeting" di halaman
          Auto Reply (sinkron otomatis 2 arah saat disimpan). Nyalakan di sini → radio ikut
          "Menu gateway"; radio ke Teks biasa → saklar ini ikut mati.
        </p>

        <div class="mt-5 flex flex-col sm:flex-row gap-3">
          <!-- v4.0.0 — D10: dropdown "Frekuensi greeting" PINDAH ke halaman Auto Reply.
               HINT ramah (kolom repeatFrequency tetap ada — nilai lama tetap dibaca sampai
               tenant menyimpan ulang di Auto Reply). Timeout TETAP di sini. -->
          <div class="flex-1">
            <span class="text-xs text-gray-600 block mb-1">Frekuensi greeting</span>
            <div class="px-3 py-2 rounded-lg text-xs text-gray-500 flex items-center gap-1" style="background: var(--md-sys-color-surface-container-high, #f3f0f7); min-height: 44px;">
              <span>Frekuensi greeting diatur di menu</span>
              <router-link to="/admin/autoreply" class="text-green-700 hover:underline">Auto Reply</router-link>
            </div>
          </div>
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
            :disabled="saving || !aiRoutingPlanOk"
            :title="aiRoutingPlanOk ? '' : 'Fitur belum tersedia di paket Anda — hubungi admin platform untuk upgrade'"
          />
        </div>
        <p v-if="!aiRoutingPlanOk" class="text-xs mt-2 px-3 py-2 rounded-lg bg-amber-50 text-amber-700">
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
              :disabled="saving || !aiRoutingPlanOk"
              class="flex-1 min-w-[180px] accent-green-600"
            />
            <span class="text-sm font-semibold text-gray-800 tabular-nums">{{ thresholdLabel }}</span>
          </div>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="p in thresholdPresets"
              :key="p.value"
              type="button"
              :disabled="saving || !aiRoutingPlanOk"
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
          <span v-if="aiRoutingPlanOk"> <b>Deskripsi AI</b> (opsional) bantu AI paham konteks rute saat jawaban customer gak kena keyword.</span>
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
                :disabled="!aiRoutingPlanOk"
                class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500 disabled:opacity-60"
                placeholder="Deskripsi AI (opsional, ≤200) — mis. 'rute buat pasien mau booking jadwal terapi'. Kosong = AI pakai label + alias."
              ></textarea>
              <div class="text-right text-[10px] text-gray-400">{{ (opt.aiDescription || '').length }}/200</div>
            </div>
            <!-- v4.0.0 — §7b (D9): Jawaban opsi = Teks / AI (Knowledge) + scope dokumen KB.
                 v4.0.0a hotfix (quirk #2): section SELALU tampil — plan ✗ → banner upsell
                 (pola Auto Reply), radio AI disabled, Teks tetap bebas. -->
            <div class="border-t border-gray-100 pt-2">
              <p v-if="!kbPlanOk" class="text-xs mb-2 px-3 py-2 rounded-lg bg-amber-50 text-amber-700">
                ChatBareng AI belum tersedia di paket kamu — hubungi admin platform untuk upgrade.
                Opsi tetap dibalas pakai teks resmi di bawah ini.
              </p>
              <div class="flex flex-wrap items-center gap-3">
                <span class="text-xs text-gray-600">Jawaban:</span>
                <label class="flex items-center gap-1.5 text-sm text-gray-800 cursor-pointer">
                  <input v-model="opt.answerMode" type="radio" value="text" class="w-4 h-4 accent-green-600" />
                  Teks
                </label>
                <label
                  class="flex items-center gap-1.5 text-sm cursor-pointer"
                  :class="!kbPlanOk ? 'opacity-50' : ''"
                  title="AI menjawab pertanyaan customer dari dokumen KB (gagal → teks di atas tetap terkirim)"
                >
                  <input v-model="opt.answerMode" type="radio" value="ai_knowledge" :disabled="!kbPlanOk" class="w-4 h-4 accent-green-600" />
                  AI (Knowledge) 🤖
                </label>
              </div>
              <div v-if="opt.answerMode === 'ai_knowledge'" class="mt-2">
                <span class="text-xs text-gray-600 block mb-1">Scope dokumen KB (kosong = semua dokumen aktif)</span>
                <!-- v4.1.1 (D5b) — counter transparan: edukasi limit + reset 24 jam -->
                <p class="text-xs text-gray-400 mt-1">Jawaban AI dari opsi ini ikut limit per chat · reset 24 jam — chat baru mulai dari 0.</p>
                <div v-if="kbDocs.length === 0" class="text-xs text-amber-600 px-2 py-1 rounded bg-amber-50">
                  Belum ada dokumen aktif — upload dulu di menu ChatBareng AI.
                </div>
                <div v-else class="flex flex-wrap gap-2">
                  <label
                    v-for="doc in kbDocs"
                    :key="doc.id"
                    class="flex items-center gap-1.5 text-xs cursor-pointer"
                    :class="!doc.active ? 'opacity-50' : ''"
                    :title="doc.active ? '' : 'Dokumen nonaktif — aktifkan dulu di menu ChatBareng AI'"
                  >
                    <input
                      type="checkbox"
                      :checked="(opt.aiDocIdsList || []).includes(doc.id)"
                      :disabled="!doc.active"
                      @change="toggleDocScope(opt, doc.id)"
                      class="w-3.5 h-3.5 accent-green-600"
                    />
                    {{ doc.label }}
                  </label>
                </div>
              </div>
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

      <!-- v4.2.1 — Simpan (spec §3.3): Save reuse PUT (scopeDefault/numberSlot);
           slot Custom → tombol Reset ke Default (modal tipis, spec §3.4). -->
      <div class="flex justify-end items-center gap-3 flex-wrap">
        <button
          v-if="isSlotScope && currentSlotInfo?.custom"
          @click="showResetModal = true"
          :disabled="saving"
          class="px-4 py-2.5 rounded-lg text-sm font-medium border border-green-600 text-green-700 hover:bg-green-50 disabled:opacity-50"
          style="min-height: 44px;"
        >
          Reset ke Default
        </button>
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

    <!-- v4.2.1 (spec §3.4) — modal konfirmasi Reset ke Default (tipis):
         pengaturan menu khusus nomor ini dihapus + nomor kembali MIRROR Default +
         pesan yang menunggu pemilihan menu di nomor ini dilepas ke antrean. -->
    <div v-if="showResetModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" @click.self="showResetModal = false">
      <div class="bg-white rounded-lg shadow-xl max-w-sm w-full p-5">
        <h3 class="font-semibold text-gray-900">Reset ke Default?</h3>
        <p class="text-sm text-gray-600 mt-2">Pengaturan menu khusus nomor ini akan dihapus; nomor kembali mengikuti Default; pesan yang menunggu pemilihan menu akan dilepas ke antrean.</p>
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

// v4.0.0 — §7b: dokumen KB aktif utk tickbox scope per-opsi + client plan gate CB-AI
const kbDocs = ref([])

// v3.9.25 — plan gate client (menuGateway sudah fitur gated, jadi halaman ini hanya
// muncul bila featMenuGateway ✓; featAiRouting bisa ✗ walau menu gateway ✓)
// v4.0.0 fix audit LOW-2 — dua plan flag terpisah (aiHybrid=featAiRouting; answerMode=featAiKnowledge)
const aiRoutingPlanOk = ref(true)
const kbPlanOk = ref(true)
const aiUsage = ref(null)

// spec §7b — preset threshold klik-instal + keterangan konsekuensi
const thresholdPresets = [
  { label: 'Longgar', value: 0.55, desc: 'AI lebih berani menyala — lebih banyak percakapan tersalur otomatis. Risiko salah rute naik.' },
  { label: 'Seimbang', value: 0.70, desc: 'AI menyala kalau cukup yakin; ragu → antrean CS. Titik awal terbaik.' },
  { label: 'Ketat', value: 0.85, desc: 'AI cuma menyala kalau sangat yakin — lebih aman, tapi lebih banyak pesan jatuh ke antrean CS manual.' },
]
const thresholdLabel = computed(() => Number(form.value.aiThreshold).toFixed(2))

// ═══ v4.2.1 — view scope (spec §3): 'default' ATAU '0'..'2' (string utk <option>, path URL param) ═══
const selectedScope = ref('default')
const isSlotScope = computed(() => selectedScope.value !== 'default')
const currentSlot = computed(() => (isSlotScope.value ? parseInt(selectedScope.value, 10) : null))
if (Number.isNaN(currentSlot.value)) selectedScope.value = 'default' // guard slot ngawur (pola AR v4.2.0)

// GET /options (spec §2.1): dropdown + badge Custom/menu (+ arManaged utk tooltip/disable).
// Di-fetch ulang tiap sukses save/reset (badge hilang/muncul setelah aksi).
const slotOptions = ref([])
const optionsLoading = ref(false)
const currentSlotInfo = computed(() => slotOptions.value.find((s) => s.slot === currentSlot.value) || null)

function scopeOptionLabel(s) {
  // label fallback 'Slot N' (spec §1.1) — bila TenantNumber tanpa label
  const base = s.label || `Slot ${s.slot}`
  if (s.menuManaged) return `${base} · 🟣 Custom · menu`
  return s.custom ? `${base} · 🟣 Custom` : base
}

async function fetchOptions() {
  optionsLoading.value = true
  try {
    const res = await axios.get(`${API}/api/menu-gateway/options`)
    slotOptions.value = res.data.slots || []
  } catch (e) {
    // dropdown tetap jalan dgn slot-0 sintetis bila options gagal (GET utama tetap dicoba)
    slotOptions.value = []
  } finally {
    optionsLoading.value = false
  }
}

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
  // v4.0.0 — §7b: + answerMode ('text'|'ai_knowledge') & aiDocIds (csv string; kosong = whole KB)
  return { position, label: '', aliases: '', replyText: '', tagId: null, aiDescription: '', answerMode: 'text', aiDocIds: '', aiDocIdsList: [] }
}

// v4.0.0 — toggle scope dokumen per-opsi (tickbox) → sinkron aiDocIdsList + csv string
function toggleDocScope(opt, docId) {
  const list = Array.isArray(opt.aiDocIdsList) ? opt.aiDocIdsList.slice() : []
  const idx = list.indexOf(docId)
  if (idx >= 0) list.splice(idx, 1)
  else list.push(docId)
  opt.aiDocIdsList = list
  opt.aiDocIds = list.join(',')
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

// v4.2.1 — normalize row opsi API → form (dipakai loadConfig + save echo)
function normalizeOptions(list) {
  return (list || []).map(o => ({
    position: o.position,
    label: o.label || '',
    aliases: o.aliases || '',
    replyText: o.replyText || '',
    tagId: o.tagId ?? null,
    aiDescription: o.aiDescription || '',
    answerMode: (o.answerMode === 'ai_knowledge' && kbPlanOk.value) ? 'ai_knowledge' : 'text', // v4.0.0a hotfix — coerce text bila plan ✗ (PUT gak 403)
    aiDocIds: o.aiDocIds || '',
    aiDocIdsList: String(o.aiDocIds || '').split(',').map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite),
  }))
}

async function loadScopeConfig() {
  try {
    const url = isSlotScope.value ? `${API}/api/menu-gateway?slot=${currentSlot.value}` : `${API}/api/menu-gateway`
    const res = await axios.get(url)
    const cfg = res.data.config
    form.value.enabled = !!cfg.enabled
    form.value.introText = cfg.introText || ''
    form.value.fallbackText = cfg.fallbackText || ''
    form.value.fallbackTagId = cfg.fallbackTagId ?? null
    form.value.timeoutValue = cfg.timeoutValue ?? 30
    form.value.timeoutUnit = cfg.timeoutUnit || 'minutes'
    form.value.repeatFrequency = cfg.repeatFrequency || 'daily'
    form.value.aiHybrid = !!cfg.aiHybrid
    form.value.aiThreshold = Number(cfg.aiThreshold ?? 0.70)
    // v4.0.0a hotfix — plan flag dari SERVER (pola AutoReply) — sama seperti loadScopeConfig
    aiRoutingPlanOk.value = res.data.aiUsage !== null
    aiUsage.value = res.data.aiUsage || null
    kbPlanOk.value = res.data.cbaiPlanOk !== false
    if (kbPlanOk.value) {
      try {
        const kbd = await axios.get(`${API}/api/ai-knowledge`) // plan ✓ → 200, interceptor aman
        kbDocs.value = (kbd.data?.docs || []).filter((d) => d.active)
      } catch { kbDocs.value = [] }
    } else {
      kbDocs.value = []
    }
    form.value.options = normalizeOptions(cfg.options)
    if (form.value.options.length === 0) {
      // Config default baru → sediakan 2 opsi kosong sebagai titik mulai
      form.value.options = [emptyOption(1), emptyOption(2)]
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
  const err = validateClient()
  if (err) {
    toast.show({ icon: '⚠️', title: 'Belum valid', message: err })
    return
  }
  // v4.2.1 — slot dgn AR teks aktif: enable menu slot itu akan 409 (proteksi v3.9.4)
  if (isSlotScope.value && form.value.enabled && currentSlotInfo.value?.arManaged) {
    toast.show({ icon: '⚠️', title: 'Nomor punya auto-reply teks aktif', message: 'Matikan dulu trigger teksnya di halaman Auto Reply, lalu simpan menu di sini.' })
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
      // v4.2.1 (spec §2) — scope: Default view (scopeDefault=true → tulis SHARED row SAJA)
      // vs Slot view (numberSlot=N → path tick-box tunggal lama, netralisasi SUDAH BENAR).
      // TANPA numberSlots lagi — FE baru tidak pernah memakai tick-box (BE tetap byte-compat).
      ...(isSlotScope.value ? { numberSlot: currentSlot.value } : { scopeDefault: true }),
      aiHybrid: form.value.aiHybrid,
      aiThreshold: form.value.aiThreshold,
      options: form.value.options.map(o => ({
        position: o.position,
        label: o.label,
        aliases: o.aliases || '',
        replyText: o.replyText,
        tagId: o.tagId,
        aiDescription: (o.aiDescription || '').trim(),
        // v4.0.0 — §7b D9 (aiDocIds csv; kosong = whole KB)
        answerMode: (o.answerMode === 'ai_knowledge' && kbPlanOk.value) ? 'ai_knowledge' : 'text', // v4.0.0a hotfix — plan ✗ → text (PUT gak 403)
        aiDocIds: Array.isArray(o.aiDocIdsList) && o.aiDocIdsList.length > 0 ? o.aiDocIdsList.join(',') : '',
      })),
    }
    const res = await axios.put(`${API}/api/menu-gateway`, payload)
    const cfg = res.data.config || {}
    // v0.13.2 — info sinkron: radio greeting di Auto Reply ikut status saklar ini
    if (res.data.greetMode === 'menu') {
      toast.show({ icon: '🔗', title: 'Tersimpan + sinkron', message: 'Radio "Mode greeting" di Auto Reply sekarang = Menu gateway' })
    } else if (res.data.greetMode === 'text') {
      toast.show({ icon: '🔗', title: 'Tersimpan + sinkron', message: 'Radio "Mode greeting" di Auto Reply kembali = Teks biasa' })
    }
    // v4.2.1 — echo config (normalize + guard bila BE tidak echo config)
    if (cfg.options) {
      form.value.options = normalizeOptions(cfg.options)
      if (form.value.options.length === 0) form.value.options = [emptyOption(1), emptyOption(2)]
    }
    // v3.9.25 — refresh state AI setelah save (metering + echo server)
    form.value.aiHybrid = !!cfg.aiHybrid
    form.value.aiThreshold = Number(cfg.aiThreshold ?? form.value.aiThreshold)
    toast.show({
      icon: '✅',
      title: 'Tersimpan',
      message: isSlotScope.value
        ? `Menu slot ${currentSlot.value} disimpan (Custom — bebas dari Default)`
        : 'Config Menu Gateway Default berhasil disimpan',
    })
    // v4.2.1 — refresh badge scope (slot bisa jadi Custom / menu badge)
    await fetchOptions()
  } catch (e) {
    // v3.9.4 — 409 = slot dilindungi Auto Reply / shared AR aktif (proteksi hybrid dua arah)
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

// ═══ v4.2.1 (spec §3.3) — Reset ke Default: DELETE row menu slot → nomor kembali MIRROR
// Default (BE juga menghapus row AR 'menu' slot itu + melepas awaiting milik slot itu).
const showResetModal = ref(false)
const resetting = ref(false)

async function resetSlot() {
  resetting.value = true
  try {
    await axios.delete(`${API}/api/menu-gateway/slot/${currentSlot.value}`)
    showResetModal.value = false
    toast.show({ icon: '✅', title: 'Di-reset ke Default', message: `Menu nomor slot ${currentSlot.value} kembali mengikuti Default.` })
    // badge Custom hilang + form kembali ke nilai EFEKTIF (mirror Default)
    await fetchOptions()
    await loadScopeConfig()
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Gagal reset', message: e.response?.data?.error || 'Terjadi kesalahan' })
  } finally {
    resetting.value = false
  }
}

// pindah dropdown → reload form utk scope baru (watch, bukan handler terpisah — pola AR v4.2.0)
watch(selectedScope, () => {
  loadScopeConfig()
})

onMounted(async () => {
  // R2-fix Kimi: fetchAll () di-rename ke loadScopeConfig, + fetchOptions diperlukannya
  // utk prefill dropdown (dulu gak pernah dipanggil di mount — dropdown kosong)
  await fetchOptions()
  await loadScopeConfig()
  try {
    const res = await axios.get(`${API}/api/tags`)
    tags.value = res.data.tags || []
  } catch (e) { console.error('Fetch tags error:', e) }
})
</script>
