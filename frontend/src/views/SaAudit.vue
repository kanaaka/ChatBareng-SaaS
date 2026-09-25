<template>
  <!--
    v3.9.19 — View Audit Log (spec §6): pindah dari SuperAdmin.vue, fungsionalitas sama.
    Filter action + tenant (existing), pagination cursor (existing ?before=),
    detail collapsible (existing <details>), tombol muat lebih (existing).
    Endpoint GET /api/sa/audit TIDAK diubah (locked — additive murni).
  -->
  <div class="p-4 md:p-6 max-w-6xl mx-auto pb-16">
    <!-- Header view -->
    <div class="flex items-center justify-between mb-5 flex-wrap gap-2">
      <div>
        <h1 class="text-xl md:text-2xl font-bold" :style="{ color: 'var(--md-sys-color-on-surface)' }">Audit Log</h1>
        <p class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
          Trail permanen semua aksi superadmin — filter per aksi / tenant
        </p>
      </div>
      <button class="m3-btn m3-btn--tonal !min-h-[40px]" @click="loadAudit(true)">Muat ulang</button>
    </div>

    <!-- Filter: action + tenant (existing) -->
    <div class="flex flex-wrap items-center gap-2 mb-4">
      <select v-model="auditFilterAction" class="m3-select sa-select !py-1.5 !w-auto" aria-label="Filter aksi">
        <option value="">Semua aksi</option>
        <option v-for="a in AUDIT_ACTIONS" :key="a" :value="a">{{ a }}</option>
      </select>
      <select v-model="auditFilterTenant" class="m3-select sa-select !py-1.5 !w-auto" aria-label="Filter tenant">
        <option value="">Semua tenant</option>
        <option v-for="t in tenants" :key="t.id" :value="String(t.id)">#{{ t.id }} {{ t.name }}</option>
      </select>
      <button class="m3-btn m3-btn--text !min-h-[36px] !text-sm" @click="applyFilters">Terapkan</button>
      <span v-if="auditItems.length" class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
        {{ auditItems.length }} aksi ditampilkan
      </span>
    </div>

    <div v-if="error" class="flex items-start gap-2 text-sm rounded-[var(--md-sys-shape-corner-s)] p-3 mb-4"
      style="background: var(--md-sys-color-error-container); color: var(--md-sys-color-on-error-container);"
      role="alert">
      <span aria-hidden="true">⚠️</span>
      <span>{{ error }}</span>
    </div>

    <div v-if="auditLoading && auditItems.length === 0" class="sa-empty">Memuat…</div>
    <div v-else-if="auditItems.length === 0" class="sa-empty">Belum ada aksi tercatat.</div>
    <div v-else class="sa-audit-list">
      <div v-for="a in auditItems" :key="a.id" class="sa-audit-row">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="sa-pill sa-pill--action">{{ a.action }}</span>
          <span class="text-sm font-medium" :style="{ color: 'var(--md-sys-color-on-surface)' }">@{{ a.actorUsername }}</span>
          <span v-if="a.tenantName" class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">→ #{{ a.tenantId }} {{ a.tenantName }}</span>
          <span class="text-xs ml-auto" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">{{ fmtTime(a.createdAt) }}</span>
        </div>
        <details v-if="a.detail" class="mt-1">
          <summary class="text-xs cursor-pointer" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">detail</summary>
          <pre class="sa-audit-detail text-xs">{{ JSON.stringify(a.detail, null, 2) }}</pre>
        </details>
      </div>
      <div v-if="auditNextBefore" class="text-center mt-3">
        <button class="m3-btn m3-btn--text !min-h-[36px] !text-sm" :disabled="auditLoading" @click="loadMoreAudit">
          {{ auditLoading ? 'Memuat…' : `Muat lebih (${auditItems.length} ditampilkan)` }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
// v3.9.19 — View Audit Log: logic DI-PRESERVASI dari SuperAdmin.vue (v3.4 audit viewer):
// GET /api/sa/audit?limit=50&action=&tenantId=&before=<id> (cursor pagination existing).
// Tambahan minimal: filter diterapkan via tombol "Terapkan" (loadAudit(true) reset cursor).
import { ref, onMounted } from 'vue'
import axios from 'axios'

const API = import.meta.env.VITE_API_URL || ''
// super_admin-only view (router guard meta.superadmin). auth store tidak dipakai
// langsung di sini — token terkirim via axios interceptor global (pola view lain).

// v3.4 — metadata audit (di-preservasi dari SuperAdmin.vue)
const AUDIT_ACTIONS = [
  'tenant_create', 'tenant_update', 'tenant_delete', 'tenant_purge',
  'validity_update', // v3.8 — masa aktif tenant
  'plan_update', 'branding_update', 'backup_download', 'impersonate', 'admin_create',
  'api_key_create', 'api_key_revoke', // v3.9.13 — Public API v1
  'platform_branding', // v3.9.19 — branding platform (row permanen di SaAuditLog)
]

const tenants = ref([])
const auditItems = ref([])
const auditNextBefore = ref(null)
const auditFilterAction = ref('')
const auditFilterTenant = ref('')
const auditLoading = ref(false)
const error = ref('')

async function loadAudit(reset = true) {
  auditLoading.value = true
  try {
    if (reset) auditNextBefore.value = null
    const params = { limit: 50 }
    if (auditFilterAction.value) params.action = auditFilterAction.value
    if (auditFilterTenant.value) params.tenantId = auditFilterTenant.value
    if (!reset && auditNextBefore.value) params.before = auditNextBefore.value
    const { data } = await axios.get(`${API}/api/sa/audit`, { params })
    auditItems.value = reset ? data.items : [...auditItems.value, ...data.items]
    auditNextBefore.value = data.nextBefore
    error.value = ''
  } catch (e) {
    error.value = e.response?.data?.error || 'Gagal memuat audit'
  } finally {
    auditLoading.value = false
  }
}

function loadMoreAudit() {
  loadAudit(false)
}

function applyFilters() {
  loadAudit(true)
}

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return iso
  }
}

async function loadTenants() {
  try {
    const { data } = await axios.get(`${API}/api/sa/tenants`)
    tenants.value = data.tenants || []
  } catch {
    // filter tenant opsional — gagal load → dropdown kosong, bukan error fatal
  }
}

onMounted(() => {
  loadAudit(true)
  loadTenants()
})
</script>

<style scoped>
.sa-empty {
  text-align: center;
  padding: 32px 0;
  color: var(--md-sys-color-on-surface-variant);
}
.sa-select {
  width: 100%;
  padding: 10px 12px;
  border-radius: var(--md-sys-shape-corner-s);
  border: 1px solid var(--md-sys-color-outline);
  background: var(--md-sys-color-surface);
  color: var(--md-sys-color-on-surface);
}
.sa-pill {
  font-size: 0.72rem;
  font-weight: 600;
  border-radius: 999px;
  padding: 2px 10px;
  white-space: nowrap;
}
.sa-pill--action {
  background: #ede9fe;
  color: #5b21b6;
}
.sa-audit-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sa-audit-row {
  background: var(--md-sys-color-surface-container-high);
  border-radius: var(--md-sys-shape-corner-m);
  padding: 10px 14px;
}
.sa-audit-detail {
  background: var(--md-sys-color-surface-container);
  border-radius: var(--md-sys-shape-corner-s);
  padding: 8px 10px;
  max-height: 260px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>