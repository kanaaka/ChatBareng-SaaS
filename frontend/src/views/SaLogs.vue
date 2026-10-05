<template>
  <!--
    v4.6.4 (log menu addition) — Superadmin System Log (spec docs/spec-superadmin-system-log.md §D5).
    Viewer log diagnostik lintas-tenant — SUPERADMIN ONLY (privasi antar-tenant mutlak).
    Pola SaAudit.vue (axios + token global, M3 tokens, cursor "Muat lebih").
    TIDAK ada edit/delete entri manual — data hanya masuk via capture, keluar via auto-prune.
  -->
  <div class="p-4 md:p-6 pb-16">
    <!-- Header view -->
    <div class="flex items-center justify-between mb-5 flex-wrap gap-2">
      <div>
        <h1 class="text-xl md:text-2xl font-bold" :style="{ color: 'var(--md-sys-color-on-surface)' }">Log Sistem</h1>
        <p class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
          Log diagnostik lintas-tenant (error/warn/info server + client) — retensi 30 hari
        </p>
      </div>
      <div class="flex items-center gap-2 flex-wrap">
        <!-- Toggle auto-refresh 30s (polling sederhana — spec D5) -->
        <label class="flex items-center gap-1.5 text-sm cursor-pointer select-none"
          :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
          <input type="checkbox" v-model="autoRefresh" class="cursor-pointer" />
          Auto-refresh 30s
        </label>
        <span v-if="lastRefreshAt" class="text-xs" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
          ↻ {{ fmtTimeShort(lastRefreshAt) }}
        </span>
        <button class="m3-btn m3-btn--tonal !min-h-[40px]" :disabled="loading" @click="refreshAll(true)">Muat ulang</button>
      </div>
    </div>

    <!-- Strip ringkasan 24 jam (stats) — spec D5 -->
    <div v-if="stats" class="sa-stats-strip mb-4">
      <div class="sa-stat-card" :class="{ 'sa-stat-card--error': statError24h > 0 }">
        <div class="sa-stat-num">{{ statError24h }}</div>
        <div class="sa-stat-label">error / 24 jam</div>
      </div>
      <div class="sa-stat-card">
        <div class="sa-stat-num">{{ statCount('warn') }}</div>
        <div class="sa-stat-label">warn / 24 jam</div>
      </div>
      <div class="sa-stat-card">
        <div class="sa-stat-num">{{ statCount('info') }}</div>
        <div class="sa-stat-label">info / 24 jam</div>
      </div>
      <div class="sa-stat-card sa-stat-card--wide">
        <div class="sa-stat-mods">
          <span v-for="m in stats.byModule.slice(0, 6)" :key="m.module" class="sa-pill sa-pill--module">{{ m.module }} {{ m.count }}</span>
        </div>
        <div class="sa-stat-label">modul tersebar / 24 jam</div>
      </div>
    </div>

    <!-- Filter bar (spec D5): Level chips multi, Modul, Tenant, Keyword, Rentang tanggal, Export -->
    <div class="flex flex-wrap items-center gap-2 mb-4">
      <div class="flex items-center gap-1">
        <button
          v-for="lv in LEVELS" :key="lv.value"
          class="sa-level-chip"
          :class="[`sa-level-chip--${lv.value}`, { 'sa-level-chip--on': filterLevels.includes(lv.value) }]"
          @click="toggleLevel(lv.value)"
        >{{ lv.label }}</button>
      </div>
      <select v-model="filterModule" class="m3-select sa-select !py-1.5 !w-auto" aria-label="Filter modul">
        <option value="">Semua modul</option>
        <option v-for="m in MODULES" :key="m" :value="m">{{ m }}</option>
      </select>
      <select v-model="filterTenant" class="m3-select sa-select !py-1.5 !w-auto" aria-label="Filter tenant">
        <option value="">Semua tenant</option>
        <option value="__none__">— global (tanpa tenant) —</option>
        <option v-for="t in tenants" :key="t.id" :value="String(t.id)">#{{ t.id }} {{ t.name }}</option>
      </select>
      <input v-model="filterQ" class="m3-text-field sa-input !py-1.5 !w-auto" placeholder="Kata kunci pesan…"
        aria-label="Kata kunci" @keyup.enter="applyFilters" />
      <input v-model="filterFrom" type="date" class="sa-input !py-1.5 !w-auto" aria-label="Dari tanggal" />
      <span class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">s/d</span>
      <input v-model="filterTo" type="date" class="sa-input !py-1.5 !w-auto" aria-label="Sampai tanggal" />
      <button class="m3-btn m3-btn--text !min-h-[36px] !text-sm" :disabled="loading" @click="applyFilters">Terapkan</button>
      <button class="m3-btn m3-btn--outlined !min-h-[36px] !text-sm" :disabled="exporting" @click="exportCsv">
        {{ exporting ? 'Menyiapkan…' : '⬇ Export CSV' }}
      </button>
      <span v-if="items.length" class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
        {{ items.length }} entri ditampilkan
      </span>
    </div>

    <div v-if="error" class="flex items-start gap-2 text-sm rounded-[var(--md-sys-shape-corner-s)] p-3 mb-4"
      style="background: var(--md-sys-color-error-container); color: var(--md-sys-color-on-error-container);"
      role="alert">
      <span aria-hidden="true">⚠️</span>
      <span>{{ error }}</span>
    </div>

    <!-- Tabel log (scroll-horizontal di mobile — konvensi shell SuperAdmin) -->
    <div v-if="loading && items.length === 0" class="sa-empty">Memuat…</div>
    <div v-else-if="items.length === 0" class="sa-empty">Belum ada log sesuai filter.</div>
    <div v-else class="sa-table-wrap">
      <table class="sa-table">
        <thead>
          <tr>
            <th>Waktu</th>
            <th>Level</th>
            <th>Modul</th>
            <th>Tenant</th>
            <th>Pesan</th>
            <th>Versi</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in items" :key="r.id" class="sa-row" @click="openDetail(r)">
            <td class="sa-td-time">{{ fmtTime(r.ts) }}</td>
            <td>
              <span class="sa-pill sa-pill--level" :class="`sa-pill--${r.level}`">{{ r.level }}</span>
            </td>
            <td class="sa-td-module">{{ r.module }}</td>
            <td class="sa-td-tenant">
              <span v-if="r.tenantId != null">#{{ r.tenantId }} {{ r.tenantName || '‹terhapus›' }}</span>
              <span v-else :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">—</span>
            </td>
            <td class="sa-td-msg" :title="r.message">{{ truncate(r.message, 120) }}</td>
            <td class="sa-td-ver">{{ r.appVersion || '—' }}</td>
          </tr>
        </tbody>
      </table>
      <div v-if="nextCursor" class="text-center mt-3">
        <button class="m3-btn m3-btn--text !min-h-[36px] !text-sm" :disabled="loading" @click="loadMore">
          {{ loading ? 'Memuat…' : `Muat lebih (${items.length} ditampilkan)` }}
        </button>
      </div>
    </div>

    <!-- Drawer detail (klik row) — spec D5: message penuh, stack <pre>, metaJson pretty, Copy JSON -->
    <Teleport to="body">
      <div v-if="detail" class="sa-drawer-backdrop" @click="detail = null"></div>
      <aside v-if="detail" class="sa-drawer" role="dialog" aria-label="Detail log">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-lg font-bold" :style="{ color: 'var(--md-sys-color-on-surface)' }">
            Log #{{ detail.id }}
            <span class="sa-pill sa-pill--level ml-2" :class="`sa-pill--${detail.level}`">{{ detail.level }}</span>
            <span class="sa-pill sa-pill--module ml-1">{{ detail.module }}</span>
          </h2>
          <button class="m3-btn m3-btn--text !min-h-[36px]" @click="detail = null">✕ Tutup</button>
        </div>
        <div class="sa-drawer-meta text-sm mb-3" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
          <div><b>Waktu:</b> {{ fmtTime(detail.ts) }}</div>
          <div><b>Source:</b> {{ detail.source }} · <b>Tenant:</b>
            <template v-if="detail.tenantId != null">#{{ detail.tenantId }} {{ detail.tenantName || '‹terhapus›' }}</template>
            <template v-else>— (global/server)</template>
            <template v-if="detail.source === 'client' && detail.metaObj?.username"> · <b>User:</b> @{{ detail.metaObj.username }}</template>
          </div>
          <div><b>Versi app:</b> {{ detail.appVersion || '—' }}</div>
        </div>
        <div class="sa-drawer-section">
          <div class="sa-drawer-label">Pesan (ter-redaksi)</div>
          <pre class="sa-pre" :style="{ color: 'var(--md-sys-color-on-surface)' }">{{ detail.message }}</pre>
        </div>
        <div v-if="detail.stack" class="sa-drawer-section">
          <div class="sa-drawer-label">Stack</div>
          <pre class="sa-pre sa-pre--stack">{{ detail.stack }}</pre>
        </div>
        <div v-if="detail.metaJson" class="sa-drawer-section">
          <div class="sa-drawer-label">Meta</div>
          <pre class="sa-pre">{{ detail.metaPretty }}</pre>
        </div>
        <div class="mt-4 flex gap-2">
          <button class="m3-btn m3-btn--tonal !min-h-[40px]" @click="copyJson">
            {{ copied ? '✓ Tersalin' : '📋 Copy JSON' }}
          </button>
          <span class="text-xs self-center" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
            Tempel ke laporan ke vendor — data sudah ter-redaksi.
          </span>
        </div>
      </aside>
    </Teleport>
  </div>
</template>

<script setup>
// v4.6.4 — View Log Sistem: list+filter+cursor (GET /api/sa/system-logs), stats strip
// (GET /api/sa/system-logs/stats), detail drawer (GET /api/sa/system-logs/:id),
// export CSV (GET /api/sa/system-logs/export — ikut filter aktif), auto-refresh 30s.
// Modul dropdown = konstanta yang SAMA dgn BE (services/systemLog.MODULES).
import { ref, computed, onMounted, onUnmounted } from 'vue'
import axios from 'axios'

const API = import.meta.env.VITE_API_URL || ''

// Konstanta module — mirror src/services/systemLog.js (12 modul)
const MODULES = [
  'auto-reply', 'blast', 'scheduler', 'wa', 'chat', 'media',
  'api-keys', 'auth', 'tenant', 'database', 'frontend', 'other',
]
const LEVELS = [
  { value: 'error', label: 'Error' },
  { value: 'warn', label: 'Warn' },
  { value: 'info', label: 'Info' },
]

const items = ref([])
const nextCursor = ref(null)
const loading = ref(false)
const exporting = ref(false)
const error = ref('')
const detail = ref(null)
const copied = ref(false)
const stats = ref(null)
const tenants = ref([])
const lastRefreshAt = ref(null)

// Filter state
const filterLevels = ref([]) // multi chips (kosong = semua)
const filterModule = ref('')
const filterTenant = ref('')
const filterQ = ref('')
const filterFrom = ref('') // YYYY-MM-DD
const filterTo = ref('')

const statError24h = computed(() => statCount('error'))
function statCount(level) {
  const row = (stats.value?.byLevel || []).find((r) => r.level === level)
  return row?.count ?? 0
}

function buildParams(withCursor, limit) {
  const params = { limit: limit || 100 }
  if (filterLevels.value.length) params.level = filterLevels.value.join(',')
  if (filterModule.value) params.module = filterModule.value
  if (filterTenant.value === '__none__') params.tenantId = 'none'
  else if (filterTenant.value) params.tenantId = filterTenant.value
  if (filterQ.value.trim()) params.q = filterQ.value.trim()
  if (filterFrom.value) params.from = filterFrom.value + 'T00:00:00+07:00' // WIB
  if (filterTo.value) params.to = filterTo.value + 'T23:59:59+07:00' // WIB (hari penuh)
  if (withCursor && nextCursor.value) params.cursor = nextCursor.value
  return params
}

// tenantId=none → global (tanpa tenant): BE hanya menerima angka → list tak difilter
// server, entri global difilter client-side (source=server/global dominan di view ini)
async function loadLogs(reset = true) {
  loading.value = true
  try {
    const params = buildParams(!reset, reset ? 100 : 100)
    const filterGlobal = params.tenantId === 'none'
    if (filterGlobal) delete params.tenantId
    const { data } = await axios.get(`${API}/api/sa/system-logs`, { params })
    let newItems = data.items || []
    if (filterGlobal) newItems = newItems.filter((r) => r.tenantId == null)
    items.value = reset ? newItems : [...items.value, ...newItems]
    nextCursor.value = data.nextCursor
    lastRefreshAt.value = new Date()
    error.value = ''
  } catch (e) {
    error.value = e.response?.data?.error || 'Gagal memuat log'
  } finally {
    loading.value = false
  }
}

function loadMore() { loadLogs(false) }

function toggleLevel(v) {
  const i = filterLevels.value.indexOf(v)
  if (i >= 0) filterLevels.value.splice(i, 1)
  else filterLevels.value.push(v)
}

function applyFilters() { loadLogs(true) }

async function refreshAll(resetStats = false) {
  const jobs = [loadLogs(true)]
  // stats di-refresh saat manual & saat auto-refresh (murah — groupBy 24 jam)
  jobs.push(loadStats())
  if (resetStats) jobs.push(loadTenants())
  await Promise.allSettled(jobs)
}

async function loadStats() {
  try {
    const { data } = await axios.get(`${API}/api/sa/system-logs/stats`)
    stats.value = data
  } catch { /* strip opsional — gagal tidak menutup halaman */ }
}

async function loadTenants() {
  try {
    const { data } = await axios.get(`${API}/api/sa/tenants`)
    tenants.value = data.tenants || []
  } catch { /* filter tenant opsional */ }
}

async function openDetail(row) {
  try {
    const { data } = await axios.get(`${API}/api/sa/system-logs/${row.id}`)
    const it = data.item
    let metaPretty = null
    let metaObj = null
    if (it.metaJson) {
      try { metaObj = JSON.parse(it.metaJson); metaPretty = JSON.stringify(metaObj, null, 2) }
      catch { metaPretty = it.metaJson }
    }
    detail.value = { ...it, metaPretty, metaObj }
    copied.value = false
  } catch (e) {
    error.value = e.response?.data?.error || 'Gagal memuat detail'
  }
}

function exportPayload() {
  const params = buildParams(false, 500)
  delete params.limit
  delete params.cursor
  const qs = new URLSearchParams(params).toString()
  return qs ? `?${qs}` : ''
}

async function exportCsv() {
  // Export ikut filter aktif (GET text/csv — axios blob → trigger download)
  exporting.value = true
  try {
    const { data } = await axios.get(`${API}/api/sa/system-logs/export${exportPayload()}`, { responseType: 'blob' })
    const blob = new Blob([data], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `system-log-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  } catch (e) {
    error.value = e.response?.data?.error || 'Gagal export CSV'
  } finally {
    exporting.value = false
  }
}

async function copyJson() {
  try {
    await navigator.clipboard.writeText(JSON.stringify(detail.value, null, 2))
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch { /* clipboard API ditolak → fallback lama: user salin manual */ }
}

// ─── Auto-refresh 30s (polling sederhana — spec D5) ───
const autoRefresh = ref(false)
let autoTimer = null
function setupAutoTimer() {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null }
  if (autoRefresh.value) {
    autoTimer = setInterval(() => { loadLogs(true); loadStats() }, 30 * 1000)
  }
}
import { watch } from 'vue'
watch(autoRefresh, setupAutoTimer)

// ─── Format helpers ───
function fmtTime(iso) {
  try { return new Date(iso).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'medium' }) }
  catch { return iso }
}
function fmtTimeShort(d) {
  try { return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }
  catch { return '' }
}
function truncate(s, n) {
  s = String(s || '')
  return s.length > n ? s.slice(0, n) + '…' : s
}

onMounted(() => {
  loadTenants()
  loadStats()
  loadLogs(true)
})
onUnmounted(() => {
  if (autoTimer) clearInterval(autoTimer)
})
</script>

<style scoped>
.sa-empty {
  text-align: center;
  padding: 32px 0;
  color: var(--md-sys-color-on-surface-variant);
}
.sa-select, .sa-input {
  width: auto;
  min-width: 130px;
  padding: 6px 10px;
  border-radius: var(--md-sys-shape-corner-s);
  border: 1px solid var(--md-sys-color-outline);
  background: var(--md-sys-color-surface);
  color: var(--md-sys-color-on-surface);
}
/* ── Stats strip ── */
.sa-stats-strip {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.sa-stat-card {
  background: var(--md-sys-color-surface-container-high);
  border-radius: var(--md-sys-shape-corner-m);
  padding: 10px 16px;
  min-width: 110px;
}
.sa-stat-card--error {
  background: var(--md-sys-color-error-container);
  color: var(--md-sys-color-on-error-container);
}
.sa-stat-num {
  font-size: 1.4rem;
  font-weight: 700;
}
.sa-stat-card--error .sa-stat-num {
  color: #b3261e;
}
.sa-stat-card--error .sa-stat-label {
  color: var(--md-sys-color-on-error-container);
}
.sa-stat-label {
  font-size: 0.75rem;
  color: var(--md-sys-color-on-surface-variant);
}
.sa-stat-card--wide {
  flex: 1;
  min-width: 220px;
}
.sa-stat-mods {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 4px;
}
/* ── Chips ── */
.sa-level-chip {
  border: 1px solid var(--md-sys-color-outline);
  background: var(--md-sys-color-surface);
  color: var(--md-sys-color-on-surface-variant);
  border-radius: 999px;
  padding: 5px 12px;
  font-size: 0.8rem;
  cursor: pointer;
  min-height: 32px;
}
.sa-level-chip--on.sa-level-chip--error {
  background: #fdeceb;
  border-color: #f2b8b5;
  color: #b3261e;
  font-weight: 600;
}
.sa-level-chip--on.sa-level-chip--warn {
  background: #fff7e0;
  border-color: #f0d9a0;
  color: #8a6a00;
  font-weight: 600;
}
.sa-level-chip--on.sa-level-chip--info {
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
  font-weight: 600;
}
/* ── Pills ── */
.sa-pill {
  font-size: 0.72rem;
  font-weight: 600;
  border-radius: 999px;
  padding: 2px 10px;
  white-space: nowrap;
}
.sa-pill--level.sa-pill--error { background: #fdeceb; color: #b3261e; }
.sa-pill--level.sa-pill--warn  { background: #fff7e0; color: #8a6a00; }
.sa-pill--level.sa-pill--info  { background: #eceff4; color: #5f6b7a; }
.sa-pill--module {
  background: #ede9fe;
  color: #5b21b6;
}
/* ── Tabel ── */
.sa-table-wrap {
  overflow-x: auto;
}
.sa-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.88rem;
}
.sa-table th {
  text-align: left;
  font-size: 0.75rem;
  padding: 8px 10px;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  color: var(--md-sys-color-on-surface-variant);
  white-space: nowrap;
}
.sa-row {
  cursor: pointer;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}
.sa-row:hover {
  background: var(--md-sys-color-surface-container-high);
}
.sa-table td {
  padding: 8px 10px;
  color: var(--md-sys-color-on-surface);
  vertical-align: top;
}
.sa-td-time { white-space: nowrap; }
.sa-td-module { white-space: nowrap; font-family: monospace; font-size: 0.8rem; }
.sa-td-tenant { white-space: nowrap; }
.sa-td-msg { max-width: 420px; word-break: break-word; }
.sa-td-ver { white-space: nowrap; font-family: monospace; font-size: 0.8rem; }
/* ── Drawer detail ── */
.sa-drawer-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 50;
}
.sa-drawer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(560px, 92vw);
  background: var(--md-sys-color-surface);
  z-index: 51;
  box-shadow: var(--md-sys-elevation-3);
  padding: 20px;
  overflow-y: auto;
  border-left: 1px solid var(--md-sys-color-outline-variant);
}
.sa-drawer-section {
  margin-bottom: 14px;
}
.sa-drawer-label {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--md-sys-color-on-surface-variant);
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.sa-pre {
  background: var(--md-sys-color-surface-container);
  border-radius: var(--md-sys-shape-corner-s);
  padding: 10px 12px;
  max-height: 320px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.8rem;
  margin: 0;
}
@media (max-width: 767px) {
  .sa-drawer {
    width: 100vw;
    padding: 16px;
  }
  .sa-td-msg { max-width: 260px; }
}
</style>