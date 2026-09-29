<script setup>
// v4.1.7 — Tenants: tabel rapi di desktop (referensi visual dashboard Transactions):
// Status chip | Nama Tenant (+brandName) | Users | Kontak | TanganKanan used/quota + mini
// progress bar | Masa Berlaku chip | Paket chip | Aksi (Suspend/Resume · Hapus · 👁 Detail).
// Semua editor per-tenant PINDAH ke drawer detail (SaTenantDetailDrawer.vue — per-tenant,
// slide dari kanan desktop / full-screen mobile): Nomor WA, Masa Aktif, Edit Paket &
// Kuota + fitur toggles, Branding, API Keys (list/create/revoke), AI Hybrid, Backup,
// Impersonate, + Admin, Purge/Hapus permanen. TIDAK ada endpoint baru.
// Preserve penuh (v3.9.19): search box by name, chip filter status (all|active|suspended),
// pagination client-side, + Tenant create, tombol Muat ulang, loading/empty state.
// Mobile <768px: tabel diganti card list — Nama + chip Paket + chip Status (+ masa berlaku
// jika bukan lifetime), SATU tombol "👁 Lihat Detail" (drawer sama dgn desktop).
import { ref, computed, onMounted, onUnmounted } from 'vue'
import axios from 'axios'
import M3TextField from '../components/M3TextField.vue'
import SaTenantDetailDrawer from '../components/SaTenantDetailDrawer.vue'

const API = import.meta.env.VITE_API_URL || ''

const tenants = ref([])
const loading = ref(true)
const error = ref('')
const showCreate = ref(false)
const newTenantName = ref('')
const newTenantPreset = ref('lite')
const creating = ref(false)
const purgeSuccess = ref('')

// ── v3.9.19 — search + filter chip + pagination (client-side di atas data existing) ──
const searchQ = ref('')
const statusFilter = ref('all') // all | active | suspended
const page = ref(1)
const pageSize = ref(20) // 20 | 50 | 100

const FILTER_CHIPS = [
  { key: 'all', label: 'Semua' },
  { key: 'active', label: 'Aktif' },
  { key: 'suspended', label: 'Suspended' },
]

const filteredTenants = computed(() => {
  let list = tenants.value
  const q = searchQ.value.trim().toLowerCase()
  if (q) list = list.filter((t) => String(t.name).toLowerCase().includes(q))
  if (statusFilter.value !== 'all') list = list.filter((t) => t.status === statusFilter.value)
  return list
})
const totalPages = computed(() => Math.max(1, Math.ceil(filteredTenants.value.length / pageSize.value)))
const pagedTenants = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return filteredTenants.value.slice(start, start + pageSize.value)
})
function setPage(p) {
  page.value = Math.min(Math.max(1, p), totalPages.value || 1)
}
const paginationLabel = computed(() => {
  const total = filteredTenants.value.length
  if (total === 0) return ''
  const from = (page.value - 1) * pageSize.value + 1
  const to = Math.min(page.value * pageSize.value, total)
  return `${from}–${to} dari ${total}`
})

async function load() {
  error.value = ''
  try {
    const { data } = await axios.get(`${API}/api/sa/tenants`)
    tenants.value = data.tenants
    if (drawerTenantId.value != null) syncDrawerTenant()
  } catch (e) {
    error.value = e.response?.data?.error || 'Gagal memuat data'
  } finally {
    loading.value = false
  }
}

// ── v3.8 — polling GET /api/sa/tenants tiap 15s (silent in-place) ──
let waPollTimer = null
async function pollTenantsSilent() {
  try {
    const { data } = await axios.get(`${API}/api/sa/tenants`)
    tenants.value = data.tenants
    if (drawerTenantId.value != null) syncDrawerTenant()
  } catch {}
}
function startWaPolling() {
  stopWaPolling()
  waPollTimer = setInterval(pollTenantsSilent, 15000)
}
function stopWaPolling() {
  if (waPollTimer) { clearInterval(waPollTimer); waPollTimer = null }
}
onUnmounted(() => stopWaPolling())

async function createTenant() {
  if (!newTenantName.value.trim()) return
  creating.value = true
  error.value = ''
  try {
    await axios.post(`${API}/api/sa/tenants`, {
      name: newTenantName.value.trim(),
      preset: newTenantPreset.value || 'lite',
    })
    newTenantName.value = ''
    newTenantPreset.value = 'lite'
    showCreate.value = false
    await load()
  } catch (e) {
    error.value = e.response?.data?.error || 'Gagal membuat tenant'
  } finally {
    creating.value = false
  }
}

// ── v4.1.7 — helper chip/kolom tabel ──
function fmtDate(iso) {
  try { return new Date(iso).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) } catch { return iso }
}
// v3.8 — chip masa aktif (reuse logic existing — validityState dari API)
function validityChip(t) {
  const s = t.validityState
  if (s === 'lifetime') return { label: 'Lifetime', style: 'background:#e5e7eb;color:#374151;' }
  if (s === 'active' && t.validUntil) return { label: `s/d ${fmtDate(t.validUntil)}`, style: 'background:#dcfce7;color:#166534;' }
  if (s === 'expiring' && t.validUntil) {
    const days = Math.max(0, Math.ceil((new Date(t.validUntil) - new Date()) / 86400000))
    return { label: `⏰ ${days} hari lagi`, style: 'background:#fef9c3;color:#854d0e;' }
  }
  if (s === 'expired') return { label: `Kedaluwarsa ${t.validUntil ? fmtDate(t.validUntil) : ''}`, style: 'background:#fee2e2;color:#991b1b;' }
  if (s === 'not_started') return { label: `Mulai ${t.validFrom ? fmtDate(t.validFrom) : '?'}`, style: 'background:#dbeafe;color:#1e40af;' }
  return null
}
// v3.4 — label paket: Preset dari plan.preset (lite/pro/max/custom)
function planPreset(t) {
  const p = t.plan?.preset || 'custom'
  return p.charAt(0).toUpperCase() + p.slice(1)
}
function fmtBytes(n) {
  const GB = 1024 ** 3
  const num = Number(n) || 0
  if (num >= GB) return `${(num / GB).toFixed(1).replace('.', ',')} GB`
  const MB = 1024 ** 2
  if (num >= MB) return `${Math.round(num / MB)} MB`
  return `${num} B`
}
// TanganKanan mini progress bar — guard divide-by-zero; null quota = ∞ (tanpa bar)
function tkPct(t) {
  const q = t?.plan?.tkQuotaBytes
  if (q == null) return null
  const used = Number(t?.usage?.tkBytes) || 0
  const quota = Number(q)
  if (quota <= 0) return used > 0 ? 100 : 0
  return Math.min(100, (used / quota) * 100)
}
function tkQuotaLabel(t) {
  return t.plan?.tkQuotaBytes != null ? fmtBytes(t.plan.tkQuotaBytes) : '∞'
}

// ── v4.1.7 — drawer detail per-tenant ──
const drawerOpen = ref(false)
const drawerTenantId = ref(null)
const drawerFocusPurge = ref(false)
const drawerTenant = computed(() => {
  if (drawerTenantId.value == null) return null
  return tenants.value.find((x) => x.id === drawerTenantId.value) || null
})
function syncDrawerTenant() {
  if (drawerTenantId.value != null && !drawerTenant.value) {
    drawerOpen.value = false // tenant terhapus di luar (mis. purge) → tutup drawer
    drawerTenantId.value = null
  }
}
function openDrawer(t, { purge = false } = {}) {
  drawerTenantId.value = t.id
  drawerFocusPurge.value = purge
  drawerOpen.value = true
}
function closeDrawer() {
  drawerOpen.value = false
  drawerFocusPurge.value = false
}

// ── Suspend/Resume (endpoint existing PUT /api/sa/tenants/:id) — dipanggil tabel & drawer ──
async function setStatus(t, status) {
  error.value = ''
  try {
    await axios.put(`${API}/api/sa/tenants/${t.id}`, { status })
    await load()
  } catch (e) {
    error.value = e.response?.data?.error || 'Gagal mengubah status tenant'
  }
}
// Drawer purge sukses → toast + tutup drawer (list di-refresh oleh drawer emit)
function onDrawerDeleted(msg) {
  purgeSuccess.value = msg
  closeDrawer()
  load()
}
function onDrawerStatusChange(t, status) {
  setStatus(t, status)
}

onMounted(() => {
  load()
  startWaPolling()
})
</script>

<template>
  <div class="p-4 md:p-6 pb-16">
    <div class="flex items-center justify-between mb-5 flex-wrap gap-3">
      <div>
        <h1 class="text-2xl font-bold" :style="{ color: 'var(--md-sys-color-on-surface)' }">Tenants</h1>
        <p class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">Kelola perusahaan, paket & nomor WA</p>
      </div>
      <div class="flex gap-2">
        <button class="m3-btn m3-btn--tonal !min-h-[40px]" @click="load">Muat ulang</button>
        <button class="m3-btn m3-btn--filled !min-h-[40px]" @click="showCreate = !showCreate">+ Tenant</button>
      </div>
    </div>

    <!-- Search + filter chip + page size (v3.9.19 — preserve) -->
    <div class="sa-panel mb-4 !p-4">
      <div class="flex gap-2 items-center flex-wrap">
        <input
          v-model="searchQ"
          type="search"
          placeholder="Cari nama tenant…"
          class="sa-select !py-2 flex-1 min-w-[180px]"
          @input="page = 1"
        />
        <div class="flex gap-1">
          <button
            v-for="c in FILTER_CHIPS" :key="c.key"
            class="sa-chip"
            :class="{ 'sa-chip--active': statusFilter === c.key }"
            @click="statusFilter = c.key; page = 1"
          >{{ c.label }}</button>
        </div>
        <select v-model.number="pageSize" class="m3-select sa-select !py-2 !w-auto" @change="page = 1">
          <option :value="20">20 / hal</option>
          <option :value="50">50 / hal</option>
          <option :value="100">100 / hal</option>
        </select>
      </div>
    </div>

    <!-- Create tenant form (preserve) -->
    <div v-if="showCreate" class="sa-form">
      <M3TextField v-model="newTenantName" label="Nama tenant (perusahaan)" type="text" />
      <label class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">Paket awal</label>
      <select v-model="newTenantPreset" class="m3-select sa-select">
        <option value="lite">Lite — 3 agen · 2 GB TK · 5.000 kontak · fitur dasar</option>
        <option value="pro">Pro — 10 agen · 5 GB TK · 10.000 kontak · semua kecuali GDrive</option>
        <option value="max">Max — 50 agen · 10 GB TK · 50.000 kontak · semua fitur</option>
      </select>
      <div class="flex gap-2 justify-end mt-2">
        <button class="m3-btn m3-btn--text !min-h-[40px]" @click="showCreate = false">Batal</button>
        <button class="m3-btn m3-btn--filled !min-h-[40px]" :disabled="creating" @click="createTenant">
          {{ creating ? 'Membuat…' : 'Buat Tenant' }}
        </button>
      </div>
    </div>

    <div v-if="error" class="flex items-start gap-2 text-sm rounded-[var(--md-sys-shape-corner-s)] p-3 mb-4"
      style="background: var(--md-sys-color-error-container); color: var(--md-sys-color-on-error-container);"
      role="alert">
      <span aria-hidden="true">⚠️</span>
      <span>{{ error }}</span>
    </div>
    <div v-if="purgeSuccess" class="flex items-start gap-2 text-sm rounded-[var(--md-sys-shape-corner-s)] p-3 mb-4"
      style="background: var(--md-sys-color-primary-container); color: var(--md-sys-color-on-primary-container);"
      role="status">
      <span aria-hidden="true">✓</span>
      <span>{{ purgeSuccess }}</span>
    </div>

    <div v-if="loading" class="sa-empty">Memuat…</div>
    <div v-else-if="pagedTenants.length === 0" class="sa-empty">
      {{ tenants.length === 0 ? 'Belum ada tenant. Klik + Tenant untuk membuat perusahaan pertama.' : 'Tidak ada tenant yang cocok dgn filter.' }}
    </div>
    <template v-else>
      <!-- ── Desktop: tabel rapi (v4.1.7) ── -->
      <div class="sa-tablewrap hidden md:block">
        <table class="sa-table">
          <thead>
            <tr>
              <th class="sa-table__th sa-table__th--status">Status</th>
              <th class="sa-table__th">Nama Tenant</th>
              <th class="sa-table__th sa-table__th--num">Users</th>
              <th class="sa-table__th sa-table__th--num">Kontak</th>
              <th class="sa-table__th sa-table__th--tk">TanganKanan</th>
              <th class="sa-table__th">Masa Berlaku</th>
              <th class="sa-table__th">Paket</th>
              <th class="sa-table__th sa-table__th--aksi">Aksi</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in pagedTenants" :key="t.id" class="sa-table__row">
              <td class="sa-table__td">
                <span
                  class="sa-pill"
                  :style="t.status === 'active'
                    ? 'background:#dcfce7;color:#166534;'
                    : 'background:#fee2e2;color:#991b1b;'"
                >{{ t.status === 'active' ? 'Aktif' : 'Suspended' }}</span>
              </td>
              <td class="sa-table__td">
                <div class="font-semibold" :style="{ color: 'var(--md-sys-color-on-surface)' }">{{ t.name }}</div>
                <div v-if="t.brandName" class="text-xs" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">{{ t.brandName }}</div>
              </td>
              <td class="sa-table__td sa-table__td--num">{{ t.userCount }}</td>
              <td class="sa-table__td sa-table__td--num">{{ t.usage ? t.usage.contacts : 0 }}</td>
              <td class="sa-table__td sa-table__td--tk">
                <template v-if="tkPct(t) != null">
                  <div class="sa-tkbar" :title="fmtBytes(t.usage?.tkBytes) + ' / ' + tkQuotaLabel(t)">
                    <div class="sa-tkbar__fill" :class="tkPct(t) >= 100 ? 'sa-tkbar__fill--over' : (tkPct(t) >= 75 ? 'sa-tkbar__fill--warn' : '')" :style="{ width: tkPct(t) + '%' }"></div>
                  </div>
                </template>
                <span class="text-xs whitespace-nowrap" :class="{ 'sa-table__dim': tkPct(t) != null }" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
                  {{ fmtBytes(t.usage?.tkBytes) }}/{{ tkQuotaLabel(t) }}
                </span>
              </td>
              <td class="sa-table__td">
                <span v-if="validityChip(t)" class="sa-pill" :style="validityChip(t).style">{{ validityChip(t).label }}</span>
                <span v-else class="sa-pill" style="background:#e5e7eb;color:#374151;">Lifetime</span>
              </td>
              <td class="sa-table__td">
                <span class="sa-pill sa-pill--plan">{{ planPreset(t) }}</span>
              </td>
              <td class="sa-table__td sa-table__td--aksi">
                <div class="flex gap-1.5 justify-end flex-wrap">
                  <button
                    v-if="t.status === 'active'"
                    class="m3-btn m3-btn--tonal !min-h-[34px] !text-sm"
                    :title="'Suspend tenant ' + t.name"
                    @click="setStatus(t, 'suspended')"
                  >💤 Suspend</button>
                  <button
                    v-else
                    class="m3-btn m3-btn--tonal !min-h-[34px] !text-sm"
                    :title="'Aktifkan tenant ' + t.name"
                    @click="setStatus(t, 'active')"
                  >⚡ Resume</button>
                  <button
                    class="m3-btn m3-btn--text !min-h-[34px] !text-sm"
                    style="color: var(--md-sys-color-error);"
                    :title="'Hapus permanen tenant ' + t.name"
                    @click="openDrawer(t, { purge: true })"
                  >Hapus</button>
                  <button
                    class="m3-btn m3-btn--tonal !min-h-[34px] !text-sm"
                    :title="'Detail tenant ' + t.name"
                    @click="openDrawer(t)"
                  >👁 Lihat Detail</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- ── Mobile <768px: card list (v4.1.7) ── -->
      <div class="md:hidden space-y-3">
        <div v-for="t in pagedTenants" :key="t.id" class="sa-tcard">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="font-semibold truncate" :style="{ color: 'var(--md-sys-color-on-surface)' }">{{ t.name }}</div>
              <div v-if="t.brandName" class="text-xs truncate" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">{{ t.brandName }}</div>
            </div>
            <div class="flex gap-1 flex-none flex-wrap justify-end">
              <span class="sa-pill sa-pill--plan">{{ planPreset(t) }}</span>
              <span
                class="sa-pill"
                :style="t.status === 'active'
                  ? 'background:#dcfce7;color:#166534;'
                  : 'background:#fee2e2;color:#991b1b;'"
              >{{ t.status === 'active' ? 'Aktif' : 'Suspended' }}</span>
            </div>
          </div>
          <div class="mt-2 flex items-center gap-2 flex-wrap">
            <span
              v-if="validityChip(t) && t.validityState !== 'lifetime'"
              class="sa-pill"
              :style="validityChip(t).style"
            >{{ validityChip(t).label }}</span>
            <span v-if="t.validityState === 'lifetime'" class="sa-pill" style="background:#e5e7eb;color:#374151;">Lifetime</span>
          </div>
          <div class="mt-3 flex justify-end">
            <button
              class="m3-btn m3-btn--tonal !min-h-[36px] !text-sm"
              :title="'Detail tenant ' + t.name"
              @click="openDrawer(t)"
            >👁 Lihat Detail</button>
          </div>
        </div>
      </div>

      <!-- Pagination (v3.9.19 — preserve) -->
      <div v-if="totalPages > 1" class="flex items-center justify-center gap-2 pt-4">
        <button class="m3-btn m3-btn--text !min-h-[36px] !text-sm" :disabled="page <= 1" @click="setPage(page - 1)">‹ Prev</button>
        <span class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">Hal {{ page }} / {{ totalPages }}</span>
        <button class="m3-btn m3-btn--text !min-h-[36px] !text-sm" :disabled="page >= totalPages" @click="setPage(page + 1)">Next ›</button>
      </div>
      <div v-if="totalPages > 1" class="text-center text-xs mt-1" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">{{ paginationLabel }}</div>
    </template>

    <!-- v4.1.7 — Drawer detail per-tenant (semua editor pindah ke sini) -->
    <SaTenantDetailDrawer
      :tenant="drawerTenant"
      :open="drawerOpen"
      :focus-purge="drawerFocusPurge"
      @close="closeDrawer"
      @refresh="load"
      @deleted="onDrawerDeleted"
      @status-change="onDrawerStatusChange"
    />
  </div>
</template>

<style scoped>
.sa-panel {
  background: var(--md-sys-color-surface-container);
  border-radius: var(--md-sys-shape-corner-l);
  box-shadow: var(--md-sys-elevation-1);
  padding: 24px;
}
.sa-form {
  background: var(--md-sys-color-surface-container-high);
  border-radius: var(--md-sys-shape-corner-m);
  padding: 16px;
  margin-bottom: 16px;
  display: grid;
  gap: 8px;
}
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
/* Filter chips v3.9.19 */
.sa-chip {
  padding: 6px 14px;
  border-radius: 999px;
  border: 1px solid var(--md-sys-color-outline-variant);
  background: transparent;
  color: var(--md-sys-color-on-surface-variant);
  font-size: 0.8rem;
  font-weight: 500;
  cursor: pointer;
  min-height: 32px;
  white-space: nowrap;
}
.sa-chip--active {
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
  border-color: transparent;
  font-weight: 600;
}
.sa-pill {
  font-size: 0.72rem;
  font-weight: 600;
  border-radius: 999px;
  padding: 2px 10px;
  white-space: nowrap;
}
.sa-pill--plan { background: #dbeafe; color: #1e40af; }

/* ── v4.1.7 — tabel desktop ── */
.sa-tablewrap {
  background: var(--md-sys-color-surface-container);
  border-radius: var(--md-sys-shape-corner-l);
  box-shadow: var(--md-sys-elevation-1);
  overflow-x: auto;
}
.sa-table {
  width: 100%;
  border-collapse: collapse;
  min-width: 900px;
  font-size: 0.875rem;
}
.sa-table thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--md-sys-color-surface-container);
  text-align: left;
  font-weight: 600;
  font-size: 0.76rem;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  color: var(--md-sys-color-on-surface-variant);
  padding: 12px 14px;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  white-space: nowrap;
}
.sa-table__th--status { min-width: 100px; }
.sa-table__th--num { min-width: 70px; }
.sa-table__th--tk { min-width: 120px; }
.sa-table__th--aksi { min-width: 270px; }
.sa-table__row { border-bottom: 1px solid var(--md-sys-color-outline-variant); }
.sa-table__row:hover { background: var(--md-sys-color-surface-container-high); }
.sa-table__td {
  padding: 12px 14px;
  vertical-align: middle;
  color: var(--md-sys-color-on-surface);
}
.sa-table__td--num { text-align: right; font-variant-numeric: tabular-nums; }
.sa-table__td--tk { min-width: 150px; }
.sa-table__td--aksi { text-align: right; }
.sa-table__dim { display: block; margin-top: 3px; }

/* TanganKanan mini progress bar (CSS murni, v4.1.7) */
.sa-tkbar {
  height: 6px;
  border-radius: 999px;
  background: var(--md-sys-color-surface-container-highest);
  overflow: hidden;
  min-width: 100px;
  margin-bottom: 3px;
}
.sa-tkbar__fill {
  height: 100%;
  border-radius: 999px;
  background: var(--md-sys-color-primary);
}
.sa-tkbar__fill--warn { background: var(--md-sys-color-warning); }
.sa-tkbar__fill--over { background: var(--md-sys-color-error); }

/* ── v4.1.7 — card mobile ── */
.sa-tcard {
  background: var(--md-sys-color-surface-container);
  border-radius: var(--md-sys-shape-corner-m);
  padding: 14px 16px;
  box-shadow: var(--md-sys-elevation-1);
}
</style>