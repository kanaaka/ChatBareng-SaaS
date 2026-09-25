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

    <!-- ── Placeholder P2 (spec §7 — bukan kosong, tulis status backlog) ── -->
    <div class="sa-panel mb-6 sa-muted-panel">
      <h2 class="text-lg font-semibold mb-1" :style="{ color: 'var(--md-sys-color-on-surface)' }">Pricing &amp; Payment Gateway</h2>
      <p class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
        Definisi paket editable &amp; payment gateway: dibangun bertahap — v3.9.20+
      </p>
    </div>

    <div class="sa-panel sa-muted-panel">
      <h2 class="text-lg font-semibold mb-1" :style="{ color: 'var(--md-sys-color-on-surface)' }">AI Provider Key</h2>
      <p class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
        AI provider key platform (untuk fitur AI internal): dibangun nanti — backlog P2
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

onMounted(() => {
  loadPlatformBranding()
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