<template>
  <!--
    v3.9.19 — View Pengaturan (spec §7):
    1. Ganti password SA (pindah dari SuperAdmin.vue — POST /api/auth/change-password existing)
    2. Branding platform: brandName "ChatBareng" editable (disimpan SaAuditLog row
       permanen action=platform_branding — spec §7 bilang AppConfig, tapi AppConfig
       tidak punya kolom brandName + zero-migration locked; DEVIASI tercatat di report)
       null tenantId — dipakai SaSidebar via GET /api/sa/platform-branding)
    3. Placeholder P2: pricing/payment gateway + AI provider key (backlog, bukan kosong)
  -->
  <div class="p-4 md:p-6 max-w-3xl mx-auto pb-16">
    <!-- Header view -->
    <div class="mb-5">
      <h1 class="text-xl md:text-2xl font-bold" :style="{ color: 'var(--md-sys-color-on-surface)' }">Pengaturan</h1>
      <p class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
        Akun superadmin &amp; branding platform
      </p>
    </div>

    <!-- ── v3.1.1 — Akun: ganti password mandiri (pindah dari SuperAdmin.vue, logic sama) ── -->
    <div class="sa-panel mb-6">
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

    <!-- ── Branding platform (P1) ── -->
    <div class="sa-panel mb-6">
      <h2 class="text-lg font-semibold mb-1" :style="{ color: 'var(--md-sys-color-on-surface)' }">Branding Platform</h2>
      <p class="text-sm mb-4" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
        Nama platform yang tampil di sidebar superadmin. Login page tetap "ChatBareng" polos;
        topbar tenant tetap pakai brandName tenant masing-masing (by design).
      </p>
      <div class="grid gap-3 max-w-md">
        <M3TextField
          v-model="brandName"
          label="Brand name platform (2-50 karakter, kosong = ChatBareng)"
          type="text"
          maxlength="50"
        />
        <div v-if="brandError" class="flex items-start gap-2 text-sm rounded-[var(--md-sys-shape-corner-s)] p-3"
          style="background: var(--md-sys-color-error-container); color: var(--md-sys-color-on-error-container);"
          role="alert">
          <span aria-hidden="true">⚠️</span>
          <span>{{ brandError }}</span>
        </div>
        <div v-if="brandSuccess" class="flex items-start gap-2 text-sm rounded-[var(--md-sys-shape-corner-s)] p-3"
          style="background: var(--md-sys-color-primary-container); color: var(--md-sys-color-on-primary-container);"
          role="status">
          <span aria-hidden="true">✓</span>
          <span>{{ brandSuccess }}</span>
        </div>
        <div class="flex justify-end">
          <button type="button" class="m3-btn m3-btn--filled !min-h-[40px]" :disabled="brandSaving" @click="savePlatformBranding">
            {{ brandSaving ? 'Menyimpan…' : 'Simpan Branding' }}
          </button>
        </div>
      </div>
    </div>

    <!-- ── v3.9.23 — AI Assistant (Ollama Cloud + fallback lokal) ── -->
    <div class="sa-panel mb-6">
      <h2 class="text-lg font-semibold mb-1" :style="{ color: 'var(--md-sys-color-on-surface)' }">AI Assistant</h2>
      <p class="text-sm mb-4" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
        Provider AI (Ollama Cloud) untuk fitur Summary Sesi. API key disimpan terenkripsi dan tidak pernah tampil utuh.
      </p>
      <div class="grid gap-3 max-w-md">
        <M3TextField v-model="aiForm.cloudBaseUrl" label="Base URL cloud (default https://ollama.com)" type="text" maxlength="200" />
        <M3TextField v-model="aiForm.cloudModel" label="Model cloud (mis. glm-5.3-flash)" type="text" maxlength="100" />

        <!-- API key: password input; placeholder masked bila sudah ada + tombol Ganti Key -->
        <div class="flex items-end gap-2">
          <div class="flex-1">
            <M3TextField
              v-if="aiKeyEditing || !aiForm.hasKey"
              v-model="aiKeyDraft"
              label="API key (min 20 karakter)"
              type="password"
              autocomplete="new-password"
            />
            <div v-else class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }" style="min-height: 40px; display: flex; align-items: center;">
              API key tersimpan: <code class="ml-1 px-1.5 py-0.5 rounded bg-black/5">{{ aiForm.keyMasked }}</code>
            </div>
          </div>
          <button v-if="aiForm.hasKey && !aiKeyEditing" type="button" class="m3-btn m3-btn--tonal !min-h-[40px]" @click="aiKeyEditing = true; aiKeyDraft = ''">
            Ganti Key
          </button>
          <button v-else-if="aiKeyEditing" type="button" class="m3-btn m3-btn--tonal !min-h-[40px]" @click="aiKeyEditing = false; aiKeyDraft = ''">
            Batal
          </button>
        </div>

        <div class="flex flex-wrap gap-2">
          <button type="button" class="m3-btn m3-btn--tonal !min-h-[40px]" :disabled="aiTesting" @click="testAiConnection">
            {{ aiTesting ? 'Menguji…' : 'Tes Koneksi' }}
          </button>
          <button type="button" class="m3-btn m3-btn--tonal !min-h-[40px]" :disabled="aiLoadingModels" @click="loadAiModels('cloud')">
            {{ aiLoadingModels ? 'Memuat…' : 'Muat Daftar Model' }}
          </button>
          <select v-if="aiModels.length" v-model="aiForm.cloudModel" class="m3-btn m3-btn--tonal !min-h-[40px]" style="max-width: 240px;">
            <option v-for="m in aiModels" :key="m.name" :value="m.name">{{ m.name }}</option>
          </select>
        </div>

        <label class="text-sm font-medium" style="margin-top: 8px;">Format default platform</label>
        <select v-model="aiForm.defaultPreset" class="px-3 py-2.5 rounded-[var(--md-sys-shape-corner-s)] text-sm border" style="border-color: var(--md-sys-color-outline); background: var(--md-sys-color-surface-container-lowest); color: var(--md-sys-color-on-surface);">
          <option v-for="p in AI_PRESETS" :key="p.key" :value="p.key">{{ p.label }}</option>
        </select>

        <!-- Sub-panel Fallback Lokal -->
        <div class="rounded-[var(--md-sys-shape-corner-m)] p-4" style="background: var(--md-sys-color-surface-container-lowest); margin-top: 8px;">
          <div class="flex items-center justify-between gap-4">
            <div>
              <div class="text-sm font-semibold">Fallback Ollama Lokal</div>
              <div class="text-xs" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
                Dipakai otomatis kalau cloud gagal (jaringan/timeout). {{ aiLocalStatus }}
              </div>
            </div>
            <M3Switch :model-value="aiForm.fallbackEnabled" :disabled="aiSaving" @update:model-value="aiForm.fallbackEnabled = $event" />
          </div>
          <div v-if="aiForm.fallbackEnabled" class="grid gap-3 mt-3">
            <M3TextField v-model="aiForm.localBaseUrl" label="Base URL lokal (default http://127.0.0.1:11434)" type="text" maxlength="200" />
            <div class="flex flex-wrap gap-2 items-center">
              <button type="button" class="m3-btn m3-btn--tonal !min-h-[40px]" :disabled="aiLoadingLocalModels" @click="loadAiModels('local')">
                {{ aiLoadingLocalModels ? 'Memuat…' : 'Muat Model Lokal' }}
              </button>
              <select v-if="aiLocalModels.length" v-model="aiForm.localModel" class="px-2 py-2 rounded-[var(--md-sys-shape-corner-s)] text-sm border" style="border-color: var(--md-sys-color-outline); background: var(--md-sys-color-surface-container-lowest); max-width: 240px;">
                <option :value="null">— pilih model lokal —</option>
                <option v-for="m in aiLocalModels" :key="m.name" :value="m.name">{{ m.name }}</option>
              </select>
              <select v-model="aiPullModel" class="px-2 py-2 rounded-[var(--md-sys-shape-corner-s)] text-sm border" style="border-color: var(--md-sys-color-outline); background: var(--md-sys-color-surface-container-lowest);">
                <option value="qwen3:4b">qwen3:4b</option>
                <option value="qwen2.5:3b-instruct">qwen2.5:3b-instruct</option>
                <option value="llama3.2:3b">llama3.2:3b</option>
              </select>
              <button type="button" class="m3-btn m3-btn--tonal !min-h-[40px]" :disabled="aiPulling" @click="pullLocalModel">
                {{ aiPulling ? 'Memulai…' : 'Pasang Model' }}
              </button>
            </div>
            <p v-if="aiPullHint" class="text-xs" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">{{ aiPullHint }}</p>
          </div>
        </div>

        <div v-if="aiTestResult" class="text-sm" :class="aiTestResult.ok ? 'text-green-600' : 'text-red-600'">{{ aiTestResult.text }}</div>
        <div v-if="aiError" class="flex items-start gap-2 text-sm rounded-[var(--md-sys-shape-corner-s)] p-3"
          style="background: var(--md-sys-color-error-container); color: var(--md-sys-color-on-error-container);"
          role="alert">
          <span aria-hidden="true">⚠️</span>
          <span>{{ aiError }}</span>
        </div>
        <div v-if="aiSuccess" class="flex items-start gap-2 text-sm rounded-[var(--md-sys-shape-corner-s)] p-3"
          style="background: var(--md-sys-color-primary-container); color: var(--md-sys-color-on-primary-container);"
          role="status">
          <span aria-hidden="true">✓</span>
          <span>{{ aiSuccess }}</span>
        </div>
        <div class="flex justify-end">
          <button type="button" class="m3-btn m3-btn--filled !min-h-[40px]" :disabled="aiSaving" @click="saveAiConfig">
            {{ aiSaving ? 'Menyimpan…' : 'Simpan AI Assistant' }}
          </button>
        </div>
      </div>
    </div>

    <!-- ── Placeholder P2 (spec §7 — bukan kosong, tulis status backlog) ── -->
    <div class="sa-panel mb-6 sa-muted-panel">
      <h2 class="text-lg font-semibold mb-1" :style="{ color: 'var(--md-sys-color-on-surface)' }">Pricing &amp; Payment Gateway</h2>
      <p class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
        Definisi paket editable &amp; payment gateway: dibangun bertahap — v3.9.20+
      </p>
    </div>
  </div>
</template>

<script setup>
// v3.9.19 — View Pengaturan:
// - Ganti password SA: logic DI-PRESERVASI persis dari SuperAdmin.vue (v3.1.1) —
//   POST /api/auth/change-password (existing endpoint, requireAuth, rate-limit ketat).
// - Branding platform: brandName disimpan via GET/PUT /api/sa/platform-branding
//   (endpoint additive baru; storage = SaAuditLog row action=platform_branding —
//   permanen, tak ter-purge, queryable; DEVIASI dari spec §7 "AppConfig" karena
//   AppConfig tak punya kolom brandName dan zero-migration ter-locked §9).
// - Placeholder P2 per spec §7: pricing/payment gateway + AI provider key.
import { ref, onMounted } from 'vue'
import axios from 'axios'
import M3TextField from '../components/M3TextField.vue'
// v3.9.23 — AI Assistant (fallback toggle) — M3Switch
import M3Switch from '../components/M3Switch.vue'

const API = import.meta.env.VITE_API_URL || ''

// ── v3.1.1 — self-service ganti password (preserved dari SuperAdmin.vue) ──
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

// ── Branding platform (SaAuditLog row action=platform_branding — deviasi zero-migration) ──
const brandName = ref('')
const brandSaving = ref(false)
const brandError = ref('')
const brandSuccess = ref('')

async function loadPlatformBranding() {
  try {
    const { data } = await axios.get(`${API}/api/sa/platform-branding`)
    brandName.value = data?.brandName || ''
  } catch {
    // belum ada row → default ChatBareng (brandName tetap '')
  }
}

async function savePlatformBranding() {
  brandError.value = ''
  brandSuccess.value = ''
  const bn = brandName.value.trim()
  if (bn.length > 0 && (bn.length < 2 || bn.length > 50)) {
    brandError.value = 'Brand name harus 2-50 karakter (atau kosong untuk reset ke ChatBareng)'
    return
  }
  brandSaving.value = true
  try {
    const { data } = await axios.put(`${API}/api/sa/platform-branding`, {
      brandName: bn,
    })
    brandName.value = data?.brandName || ''
    brandSuccess.value = bn
      ? `Brand platform disimpan: "${bn}" (berlaku setelah refresh sidebar)`
      : 'Brand platform di-reset ke ChatBareng'
  } catch (e) {
    brandError.value = e.response?.data?.error || 'Gagal menyimpan branding platform'
  } finally {
    brandSaving.value = false
  }
}

// ── v3.9.23 — AI Assistant (Ollama Cloud + fallback lokal) ──
const AI_PRESETS = [
  { key: 'standard', label: 'Standard (4 blok)' },
  { key: 'ringkas', label: 'Ringkas (1 paragraf)' },
  { key: 'handoff', label: 'Handoff shift' },
  { key: 'medis', label: 'Medis (klinik)' },
  { key: 'penjualan', label: 'Penjualan' },
  { key: 'keluhan', label: 'Keluhan' },
]

const aiForm = ref({
  cloudBaseUrl: '',
  cloudModel: '',
  hasKey: false,
  keyMasked: null,
  localBaseUrl: '',
  localModel: null,
  fallbackEnabled: false,
  defaultPreset: 'standard',
})
const aiKeyEditing = ref(false)
const aiKeyDraft = ref('')
const aiSaving = ref(false)
const aiTesting = ref(false)
const aiLoadingModels = ref(false)
const aiLoadingLocalModels = ref(false)
const aiModels = ref([])
const aiLocalModels = ref([])
const aiTestResult = ref(null) // { ok, text }
const aiLocalStatus = ref('')
const aiPullModel = ref('qwen3:4b')
const aiPulling = ref(false)
const aiPullHint = ref('')
const aiError = ref('')
const aiSuccess = ref('')

async function loadAiConfig() {
  try {
    const { data } = await axios.get(`${API}/api/sa/ai-config`)
    aiForm.value = {
      cloudBaseUrl: data.cloudBaseUrl || '',
      cloudModel: data.cloudModel || '',
      hasKey: !!data.hasKey,
      keyMasked: data.keyMasked || null,
      localBaseUrl: data.localBaseUrl || '',
      localModel: data.localModel || null,
      fallbackEnabled: !!data.fallbackEnabled,
      defaultPreset: data.defaultPreset || 'standard',
    }
  } catch (e) {
    aiError.value = e.response?.data?.error || 'Gagal memuat konfigurasi AI'
  }
}

async function saveAiConfig() {
  aiError.value = ''
  aiSuccess.value = ''
  aiSaving.value = true
  try {
    const body = {
      cloudBaseUrl: aiForm.value.cloudBaseUrl,
      cloudModel: aiForm.value.cloudModel,
      localBaseUrl: aiForm.value.localBaseUrl,
      localModel: aiForm.value.localModel,
      fallbackEnabled: !!aiForm.value.fallbackEnabled,
      defaultPreset: aiForm.value.defaultPreset,
    }
    // Key hanya dikirim kalau user sedang mengganti (field terisi) — else keep.
    if (aiKeyEditing.value && aiKeyDraft.value.trim()) {
      body.apiKey = aiKeyDraft.value
    }
    const { data } = await axios.put(`${API}/api/sa/ai-config`, body)
    aiForm.value = {
      cloudBaseUrl: data.cloudBaseUrl || '',
      cloudModel: data.cloudModel || '',
      hasKey: !!data.hasKey,
      keyMasked: data.keyMasked || null,
      localBaseUrl: data.localBaseUrl || '',
      localModel: data.localModel || null,
      fallbackEnabled: !!data.fallbackEnabled,
      defaultPreset: data.defaultPreset || 'standard',
    }
    aiKeyEditing.value = false
    aiKeyDraft.value = ''
    aiSuccess.value = 'Konfigurasi AI disimpan'
  } catch (e) {
    aiError.value = e.response?.data?.error || 'Gagal menyimpan konfigurasi AI'
  } finally {
    aiSaving.value = false
  }
}

async function testAiConnection() {
  aiTestResult.value = null
  aiError.value = ''
  aiTesting.value = true
  try {
    const body = { baseUrl: aiForm.value.cloudBaseUrl, model: aiForm.value.cloudModel }
    if (aiKeyEditing.value && aiKeyDraft.value.trim()) body.apiKey = aiKeyDraft.value
    // apiKey tidak dikirim → server pakai key stored
    const { data } = await axios.post(`${API}/api/sa/ai-config/test`, body)
    if (data.ok) {
      aiTestResult.value = { ok: true, text: `OK — ${(data.latencyMs / 1000).toFixed(1)}s · ${data.model}` }
    } else {
      aiTestResult.value = { ok: false, text: data.message || 'Tes gagal' }
    }
  } catch (e) {
    aiTestResult.value = { ok: false, text: e.response?.data?.error || 'Tes gagal' }
  } finally {
    aiTesting.value = false
  }
}

async function loadAiModels(scope) {
  aiError.value = ''
  if (scope === 'cloud') {
    aiLoadingModels.value = true
  } else {
    aiLoadingLocalModels.value = true
  }
  try {
    const baseUrl = scope === 'cloud' ? aiForm.value.cloudBaseUrl : aiForm.value.localBaseUrl
    const { data } = await axios.get(`${API}/api/sa/ai-config/models`, { params: { scope, baseUrl: baseUrl || undefined } })
    if (scope === 'cloud') {
      aiModels.value = data.models || []
      if (!aiModels.value.length) aiError.value = 'Daftar model kosong dari server'
    } else {
      aiLocalModels.value = data.models || []
      aiLocalStatus.value = aiLocalModels.value.length ? `Ollama lokal: tersedia ✓` : 'Ollama lokal: tidak terdeteksi'
    }
  } catch (e) {
    if (scope === 'cloud') aiModels.value = []
    else aiLocalModels.value = []
    if (scope === 'local') aiLocalStatus.value = 'Ollama lokal: tidak terdeteksi'
    aiError.value = e.response?.data?.error || `Gagal memuat daftar model (${scope})`
  } finally {
    aiLoadingModels.value = false
    aiLoadingLocalModels.value = false
  }
}

async function pullLocalModel() {
  aiError.value = ''
  aiPulling.value = true
  aiPullHint.value = ''
  try {
    const { data } = await axios.post(`${API}/api/sa/ai-config/local-pull`, { model: aiPullModel.value })
    aiPullHint.value = `Unduhan "${data.model}" berjalan di background — cek status via Muat Model Lokal.`
  } catch (e) {
    aiError.value = e.response?.data?.error || 'Gagal memulai unduhan model'
  } finally {
    aiPulling.value = false
  }
}

onMounted(() => {
  loadPlatformBranding()
  loadAiConfig()
})
</script>

<style scoped>
.sa-panel {
  background: var(--md-sys-color-surface-container);
  border-radius: var(--md-sys-shape-corner-l);
  box-shadow: var(--md-sys-elevation-1);
  padding: 24px;
}
.sa-muted-panel {
  opacity: 0.85;
}
</style>