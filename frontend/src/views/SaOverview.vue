<script setup>
// v3.9.20 — View Overview: dashboard SuperAdmin.
// 5 metric cards (GET /api/sa/stats) + delta % vs periode lalu (dihitung frontend
// dari trends API), chart trend chat (line/area), avg response line,
// pie donut Resolved vs Open, card aksen ungu "Chat hari ini" + sparkline 7 titik.
// v3.9.20: tiap chart punya range SENDIRI (today|7d|30d|all|custom) + bar tab
// masing-masing; cards/sparkline/delta tetap pakai trends today/7d/30d (fixed).
// Chart.js di-import dynamic (tree-shaken; register otomatis di modul chart helper).
import { ref, reactive, computed, onMounted } from 'vue'
import axios from 'axios'
import { fmtBytes } from '../utils/format' // v4.6.1 — shared byte formatter (KB→MB→GB→TB)
import { Chart } from 'chart.js/auto'
import { useAuthStore } from '../stores/auth'

const API = import.meta.env.VITE_API_URL || ''
const auth = useAuthStore()

const stats = ref(null)
const loading = ref(true)
const error = ref('')

// ── v3.9.20 — Per-chart date ranges: tiap panel punya range sendiri ──
// (cards/sparkline/delta TIDAK terpengaruh — tetap today/7d/30d dari trends)
const RANGE_TABS = [
  { key: 'today', label: 'Hari Ini' },
  { key: '7d', label: '7 Hari' },
  { key: '30d', label: '30 Hari' },
  { key: 'all', label: 'All Time' },
  { key: 'custom', label: 'Custom' },
]
const trend = ref(null) // { dates, counts, total }
const avgResp = ref(null) // { dates, avgMinutes, avgTotal }
const resolution = ref(null) // { resolved, open, percentResolved, percentOpen }
const trendRange = ref('7d')
const respRange = ref('7d')
const pieRange = ref('7d')

// Tanggal WIB util (frontend mirror logika backend v3.9.20)
function wibTodayStr() {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10)
}
function wibDaysAgoStr(n) {
  const t = new Date(Date.now() + 7 * 60 * 60 * 1000)
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - n * 86400000)
    .toISOString().slice(0, 10)
}
const todayStr = wibTodayStr()

// State date-picker Custom per panel (default: from = today−29 WIB, to = today)
function makeCustomState() {
  return { from: wibDaysAgoStr(29), to: wibTodayStr(), error: '' }
}
const trendCustom = reactive(makeCustomState())
const respCustom = reactive(makeCustomState())
const pieCustom = reactive(makeCustomState())

// ── Card ungu: chat hari ini + sparkline (7 titik terakhir dari 7d trends) ──
const todayChat = ref(0)
const sparkline = ref([])

// v3.9.21 — Panel Storage Tangan Kanan (GET /api/sa/stats/tk-storage)
const tkStorage = ref(null)

// ── v3.9.24 — Panel AI Usage (GET /api/sa/ai-usage) — snapshot cost per-call ──
const aiUsage = ref(null)
const aiUsageRange = ref('7d') // per-panel sendiri, gak ganggu panel lain (pola v3.9.20)
const aiUsageLoading = ref(false)
const aiUsageError = ref('')
const aiUsageExpanded = ref(false) // tap panel → expand inline (D1, bukan halaman baru)

// Chart instances (destroy saat re-render biar tak leak canvas)
let trendChart = null
let avgChart = null
let pieChart = null
const trendCanvas = ref(null)
const avgCanvas = ref(null)
const pieCanvas = ref(null)
const sparkCanvas = ref(null)
let sparkChart = null

// Warna dari token M3 (ikut dark mode) + aksen chart fixed agar terbaca
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#333'
}
const CHART_COLORS = {
  line: '#25D366', // hijau WA (brand)
  avg: '#8b5cf6', // ungu
  pieResolved: '#22c55e',
  pieOpen: '#f59e0b',
  grid: 'rgba(128,128,128,0.18)',
  tick: 'var(--md-sys-color-on-surface-variant)',
}

function shortDate(d) {
  // "2026-09-25" → "25/9"
  try {
    const [, m, day] = d.split('-')
    return `${Number(day)}/${Number(m)}`
  } catch {
    return d
  }
}

function fmtMinute(v) {
  if (v == null) return '—'
  if (v < 60) return `${v} mnt`
  const h = Math.floor(v / 60)
  const m = Math.round(v % 60)
  return m ? `${h}j ${m}m` : `${h}j`
}

// v3.9.21 — label sumbu per-jam utk mode hourly ('14' → '14.00')
function hourTickLabel(h) {
  try {
    const hh = String(h).split(':')[0]
    return `${hh.padStart(2, '0')}.00`
  } catch {
    return String(h)
  }
}

// v4.6.1 — fmtBytes lokal dihapus → shared dari utils/format (raw B dinonaktifkan)

// v3.9.21 — breakdown per-tenant sort desc by bytes (0 byte otomatis di akhir)
const tkRows = computed(() => {
  const rows = Array.isArray(tkStorage.value?.perTenant) ? [...tkStorage.value.perTenant] : []
  return rows.sort((a, b) => (b.bytes || 0) - (a.bytes || 0) || (b.files || 0) - (a.files || 0))
})

// ── v3.9.24 — AI Usage: fetch + format ──
// Range tab sederhana (spec §8a: Today/7 Hari/30 Hari/Semua — tanpa Custom):
const AI_USAGE_TABS = [
  { key: 'today', label: 'Hari Ini' },
  { key: '7d', label: '7 Hari' },
  { key: '30d', label: '30 Hari' },
  { key: 'all', label: 'Semua' },
]
async function fetchAiUsage() {
  aiUsageLoading.value = true
  aiUsageError.value = ''
  try {
    const res = await axios.get(`${API}/api/sa/ai-usage`, { params: { range: aiUsageRange.value } })
    aiUsage.value = res.data
  } catch (e) {
    aiUsageError.value = e.response?.data?.error || 'Gagal memuat AI Usage'
    aiUsage.value = null
  } finally {
    aiUsageLoading.value = false
  }
}
function setAiUsageRange(key) {
  aiUsageRange.value = key
  fetchAiUsage()
}
// Cost USD: >= $0.01 → 2 desimal; < $0.01 → 4 desimal (spec §8a)
function fmtUsd(n) {
  const v = Number(n || 0)
  if (v !== 0 && Math.abs(v) < 0.01) return '$' + v.toFixed(4)
  return '$' + v.toFixed(2)
}
function fmtRp(usd, kurs) {
  const v = Math.round(Number(usd || 0) * Number(kurs || 0))
  return 'Rp ' + v.toLocaleString('id-ID')
}
// Mini bar: cost per hari (maks 14 bar terakhir) — div/CSS, tanpa Chart.js (spec §8a)
const aiUsageBars = computed(() => {
  const rows = (aiUsage.value?.perDay || []).slice(-14)
  const max = Math.max(...rows.map((r) => Number(r.costUsd) || 0), 0)
  return rows.map((r) => ({
    date: r.date,
    costUsd: Number(r.costUsd) || 0,
    calls: Number(r.calls) || 0,
    pct: max > 0 ? Math.max(2, Math.round(((Number(r.costUsd) || 0) / max) * 100)) : 2,
    title: `${r.date}: ${fmtUsd(r.costUsd)} · ${r.calls} call`,
  }))
})
const aiUsageHasData = computed(() => (aiUsage.value?.totals?.calls || 0) > 0)

const pieLegendLabel = computed(() => {
  if (!resolution.value) return ''
  const r = resolution.value
  return `Resolved ${r.percentResolved}% · Open ${r.percentOpen}%`
})

// ── v3.9.20 — label window utk caption pie (menyesuaikan pieRange) ──
const MONTHS_ID = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des']
function shortDateID(d) {
  try {
    const [, m, day] = d.split('-')
    return `${String(day).padStart(2, '0')} ${MONTHS_ID[Number(m) - 1] || m}`
  } catch {
    return d
  }
}
const pieWindowLabel = computed(() => {
  switch (pieRange.value) {
    case 'today': return 'Hari ini (WIB)'
    case '7d': return '7 hari terakhir'
    case '30d': return '30 hari terakhir'
    case 'all': return 'All time'
    case 'custom': return pieCustom.from && pieCustom.to ? `${shortDateID(pieCustom.from)} – ${shortDateID(pieCustom.to)}` : 'Custom'
    default: return ''
  }
})

// ── Delta % vs periode lalu (frontend, dari trends range sama) ──
// trends hanya return window [since, today] — utk delta kita bandingkan setengah
// window pertama vs kedua (7d → 3-4 hari; 30d → 15-15). today tak ada delta.
function deltaFor(counts) {
  if (!Array.isArray(counts) || counts.length < 4) return null
  const half = Math.floor(counts.length / 2)
  const prev = counts.slice(0, half).reduce((a, b) => a + b, 0)
  const cur = counts.slice(half).reduce((a, b) => a + b, 0)
  if (prev === 0) return cur > 0 ? 100 : null
  return Math.round(((cur - prev) / prev) * 1000) / 10
}

// Delta chart trend: hidden utk today (tak ada periode pembanding) DAN utk
// all/custom (v3.9.20 — window tidak sebanding dgn periode lalu)
const trendDelta = computed(() => {
  if (['today', 'all', 'custom'].includes(trendRange.value)) return null
  return deltaFor(trend.value?.counts)
})

// Delta metric cards: bandingkan chat 7d terakhir vs 7d sebelumnya (2 window dari 30d)
const chatDelta = ref(null)
const msgDelta = ref(null) // pesan tak punya trends API → null (tanpa delta)

// Fetch chart satu-satu (v3.9.20): range panel tak mengganggu panel lain.
// axios params: { range } — utk custom tambah from/to.
function chartParams(rangeVal, customState) {
  const params = { range: rangeVal }
  if (rangeVal === 'custom' && customState) {
    params.from = customState.from
    params.to = customState.to
  }
  return params
}

// Validasi custom client-side: from/to terisi + from <= to (jangan fetch kalau invalid)
function customInvalid(c) {
  return !c.from || !c.to || c.from > c.to
}

async function fetchTrend() {
  const res = await axios.get(`${API}/api/sa/stats/trends`, { params: chartParams(trendRange.value, trendCustom) })
  trend.value = res.data
}
async function fetchAvg() {
  const res = await axios.get(`${API}/api/sa/stats/avg-response`, { params: chartParams(respRange.value, respCustom) })
  avgResp.value = res.data
}
async function fetchPie() {
  const res = await axios.get(`${API}/api/sa/stats/resolution`, { params: chartParams(pieRange.value, pieCustom) })
  resolution.value = res.data
}

async function loadOverview() {
  loading.value = true
  try {
    const [s, t, a, r] = await Promise.all([
      axios.get(`${API}/api/sa/stats`),
      fetchTrend(),
      fetchAvg(),
      fetchPie(),
    ])
    stats.value = s.data

    // Card ungu: chat hari ini dari trends today + sparkline dari 7d
    const [tToday, t7] = await Promise.all([
      axios.get(`${API}/api/sa/stats/trends`, { params: { range: 'today' } }),
      axios.get(`${API}/api/sa/stats/trends`, { params: { range: '7d' } }),
    ])
    // v3.9.21 HERO FIX: pakai total (sum semua bucket) — dgn mode hourly,
    // counts[0] = chat jam 00:00–01:00 doang (SALAH).
    todayChat.value = tToday.data?.total ?? 0
    sparkline.value = (t7.data?.counts || []).slice(-7)

    // Delta chat: 7d terakhir vs 7d sebelumnya — ambil 30d lalu split.
    try {
      const t30 = await axios.get(`${API}/api/sa/stats/trends`, { params: { range: '30d' } })
      const c = t30.data?.counts || []
      const last7 = c.slice(-7).reduce((x, y) => x + y, 0)
      const prev7 = c.slice(-14, -7).reduce((x, y) => x + y, 0)
      chatDelta.value = prev7 === 0 ? (last7 > 0 ? 100 : null) : Math.round(((last7 - prev7) / prev7) * 1000) / 10
    } catch {
      chatDelta.value = null
    }

    // v3.9.21 — Storage Tangan Kanan (non-blocking; gagal → panel hidden)
    try {
      const tk = await axios.get(`${API}/api/sa/stats/tk-storage`)
      tkStorage.value = tk.data
    } catch {
      tkStorage.value = null
    }

    // v3.9.24 — AI Usage (non-blocking; gagal → panel hidden + error inline saat refresh)
    await fetchAiUsage()

    renderCharts()
  } catch (e) {
    error.value = e.response?.data?.error || 'Gagal memuat statistik'
  } finally {
    loading.value = false
  }
}

// ── v3.9.20 — set range 1 panel → refetch HANYA panel itu ──
async function refreshPanel(which) {
  try {
    if (which === 'trend') await fetchTrend()
    else if (which === 'avg') await fetchAvg()
    else if (which === 'pie') await fetchPie()
    renderCharts({ quick: true }) // v3.9.21 — re-render panel: animasi pendek
  } catch (e) {
    error.value = e.response?.data?.error || 'Gagal memuat statistik'
  }
}

function setTrendRange(key) {
  if (key === 'custom') { trendRange.value = 'custom'; trendCustom.error = ''; return } // pilih tab → tampil picker, fetch saat Terapkan
  trendRange.value = key
  refreshPanel('trend')
}
function setRespRange(key) {
  if (key === 'custom') { respRange.value = 'custom'; respCustom.error = ''; return }
  respRange.value = key
  refreshPanel('avg')
}
function setPieRange(key) {
  if (key === 'custom') { pieRange.value = 'custom'; pieCustom.error = ''; return }
  pieRange.value = key
  refreshPanel('pie')
}

function applyTrendCustom() {
  if (customInvalid(trendCustom)) { trendCustom.error = 'Rentang tidak valid: isi kedua tanggal dan pastikan From ≤ To'; return }
  trendCustom.error = ''
  trendRange.value = 'custom'
  refreshPanel('trend')
}
function applyRespCustom() {
  if (customInvalid(respCustom)) { respCustom.error = 'Rentang tidak valid: isi kedua tanggal dan pastikan From ≤ To'; return }
  respCustom.error = ''
  respRange.value = 'custom'
  refreshPanel('avg')
}
function applyPieCustom() {
  if (customInvalid(pieCustom)) { pieCustom.error = 'Rentang tidak valid: isi kedua tanggal dan pastikan From ≤ To'; return }
  pieCustom.error = ''
  pieRange.value = 'custom'
  refreshPanel('pie')
}

function destroyCharts() {
  for (const c of [trendChart, avgChart, pieChart, sparkChart]) {
    if (c) c.destroy()
  }
  trendChart = avgChart = pieChart = sparkChart = null
}

function renderCharts(opts = {}) {
  if (!trendCanvas.value || !avgCanvas.value || !pieCanvas.value || !sparkCanvas.value) return
  destroyCharts()
  // v3.9.21 — load awal = animasi full ~900ms easeOutQuart + stagger (trend 0 /
  // pie 120 / avg 240 ms); refreshPanel (quick) = ~400ms biar gak lambat.
  const quick = !!opts.quick
  const animLine = (delayMs) => ({ duration: quick ? 400 : 900, easing: 'easeOutQuart', delay: quick ? 0 : delayMs })
  const onSurface = cssVar('--md-sys-color-on-surface')
  const onVar = cssVar('--md-sys-color-on-surface-variant')
  const gridC = CHART_COLORS.grid

  // ── Trend chat: line/area ──
  trendChart = new Chart(trendCanvas.value, {
    type: 'line',
    data: {
      labels: trend.value?.dates || [],
      datasets: [{
        label: 'Chat baru',
        data: trend.value?.counts || [],
        borderColor: CHART_COLORS.line,
        backgroundColor: 'rgba(37, 211, 102, 0.15)',
        fill: true,
        tension: 0.3,
        // v3.9.21 — hourly (≤24 titik) → titik selalu tampil
        pointRadius: trend.value?.mode === 'hourly' ? 3 : (trend.value?.counts?.length > 10 ? 0 : 3),
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: animLine(0),
      plugins: { legend: { display: false } },
      scales: {
        // v3.9.21 — hourly: tick label 'HH.00'; daily: tanggal singkat existing
        x: trend.value?.mode === 'hourly'
          ? { ticks: { color: onVar, maxTicksLimit: 8, callback: function (v) { return hourTickLabel(this.getLabelForValue(v)) } }, grid: { display: false } }
          : { ticks: { color: onVar, maxTicksLimit: 10, callback: function (v) { return shortDate(this.getLabelForValue(v)) } }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: onVar, precision: 0 }, grid: { color: gridC } },
      },
    },
  })

  // ── Avg response: line ──
  avgChart = new Chart(avgCanvas.value, {
    type: 'line',
    data: {
      labels: avgResp.value?.dates || [],
      datasets: [{
        label: 'Rata-rata respon (menit)',
        data: avgResp.value?.avgMinutes || [],
        borderColor: CHART_COLORS.avg,
        backgroundColor: 'rgba(139, 92, 246, 0.12)',
        fill: false,
        tension: 0.3,
        spanGaps: true, // null hari tanpa data → lewati garis
        pointRadius: 3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: animLine(240),
      plugins: { legend: { display: false } },
      scales: {
        // v3.9.21 — hourly: tick label 'HH.00'; daily: tanggal singkat existing
        x: avgResp.value?.mode === 'hourly'
          ? { ticks: { color: onVar, maxTicksLimit: 8, callback: function (v) { return hourTickLabel(this.getLabelForValue(v)) } }, grid: { display: false } }
          : { ticks: { color: onVar, maxTicksLimit: 8, callback: function (v) { return shortDate(this.getLabelForValue(v)) } }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: onVar, callback: (v) => fmtMinute(v) }, grid: { color: gridC } },
      },
    },
  })

  // ── Pie donut Resolved vs Open ──
  pieChart = new Chart(pieCanvas.value, {
    type: 'doughnut',
    data: {
      labels: ['Resolved', 'Open'],
      datasets: [{
        data: [resolution.value?.resolved ?? 0, resolution.value?.open ?? 0],
        backgroundColor: [CHART_COLORS.pieResolved, CHART_COLORS.pieOpen],
        borderWidth: 2,
        borderColor: cssVar('--md-sys-color-surface-container'),
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      // v3.9.21 — doughnut rotate+scale default Chart.js, durasi ~900ms + stagger 120ms
      animation: { duration: quick ? 400 : 900, easing: 'easeOutQuart', delay: quick ? 0 : 120 },
      cutout: '62%',
      plugins: {
        legend: { position: 'bottom', labels: { color: onSurface, boxWidth: 12, padding: 12 } },
      },
    },
  })

  // ── Sparkline card ungu (garis putih tipis, tanpa axes) ──
  sparkChart = new Chart(sparkCanvas.value, {
    type: 'line',
    data: {
      labels: sparkline.value.map((_, i) => String(i)),
      datasets: [{
        data: sparkline.value,
        borderColor: 'rgba(255,255,255,0.85)',
        borderWidth: 2,
        fill: false,
        tension: 0.35,
        pointRadius: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: { x: { display: false }, y: { display: false } },
      animation: false,
    },
  })
}

// format angka pendek (1,2rb)
function fmtNum(n) {
  return Number(n || 0).toLocaleString('id-ID')
}

onMounted(() => {
  loadOverview()
})
</script>

<template>
  <div class="p-4 md:p-6 pb-16">
    <div class="flex items-center justify-between mb-5 flex-wrap gap-3">
      <div>
        <h1 class="text-2xl font-bold" :style="{ color: 'var(--md-sys-color-on-surface)' }">Overview</h1>
        <p class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
          Ringkasan platform — @{{ auth.user?.username }}
        </p>
      </div>
      <button class="m3-btn m3-btn--tonal !min-h-[40px]" @click="loadOverview">Muat ulang</button>
    </div>

    <div v-if="error" class="flex items-start gap-2 text-sm rounded-[var(--md-sys-shape-corner-s)] p-3 mb-4"
      style="background: var(--md-sys-color-error-container); color: var(--md-sys-color-on-error-container);"
      role="alert">
      <span aria-hidden="true">⚠️</span>
      <span>{{ error }}</span>
    </div>

    <div v-if="loading && !stats" class="sa-empty">Memuat…</div>

    <template v-if="stats">
      <!-- Card aksen ungu: Chat hari ini + sparkline -->
      <div class="sa-hero mb-4">
        <div class="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div class="sa-hero__label">Chat hari ini</div>
            <div class="sa-hero__num">{{ fmtNum(todayChat) }}</div>
            <div class="sa-hero__sub">chat baru masuk hari ini (WIB)</div>
          </div>
          <div class="sa-spark">
            <canvas ref="sparkCanvas" height="56"></canvas>
          </div>
        </div>
      </div>

      <!-- 5 metric cards (mobile 2-per-row) -->
      <div class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <div class="sa-card">
          <div class="sa-stat">{{ fmtNum(stats.tenants) }}</div>
          <div class="sa-label">Tenant</div>
        </div>
        <div class="sa-card">
          <div class="sa-stat">{{ fmtNum(stats.activeTenants) }}</div>
          <div class="sa-label">Aktif</div>
        </div>
        <div class="sa-card">
          <div class="sa-stat">{{ fmtNum(stats.users) }}</div>
          <div class="sa-label">User</div>
        </div>
        <div class="sa-card">
          <div class="sa-stat">{{ fmtNum(stats.chats) }}</div>
          <div class="sa-label">Chat</div>
          <div v-if="chatDelta != null" class="sa-delta" :class="chatDelta >= 0 ? 'sa-delta--up' : 'sa-delta--down'">
            {{ chatDelta >= 0 ? '↑' : '↓' }} {{ Math.abs(chatDelta) }}% vs 7d lalu
          </div>
        </div>
        <div class="sa-card">
          <div class="sa-stat">{{ fmtNum(stats.messages) }}</div>
          <div class="sa-label">Pesan</div>
        </div>
      </div>

      <!-- v3.9.21 — Panel Storage Tangan Kanan (full-width, read-only) -->
      <div v-if="tkStorage" class="sa-panel sa-storage mb-6">
        <div class="flex items-center justify-between flex-wrap gap-2">
          <h2 class="text-base font-semibold" :style="{ color: 'var(--md-sys-color-on-surface)' }">Storage Tangan Kanan</h2>
          <span class="sa-storage__sub">{{ fmtNum(tkStorage.fileCount) }} file · {{ tkRows.length }} tenant</span>
        </div>
        <div class="sa-storage__total">{{ fmtBytes(tkStorage.totalBytes) }}</div>
        <div v-if="tkRows.length" class="sa-storage__rows">
          <div v-for="t in tkRows" :key="t.tenantId" class="sa-storage__row">
            <span class="sa-storage__name">{{ t.tenantName }}</span>
            <span class="sa-storage__bytes">{{ fmtBytes(t.bytes) }}</span>
            <span class="sa-storage__files">{{ fmtNum(t.files) }} file</span>
          </div>
        </div>
      </div>

      <!-- v3.9.24 — Panel AI Usage (snapshot cost per-call; SETELAH Storage Tangan Kanan) -->
      <div v-if="aiUsage" class="sa-panel sa-aiusage mb-6" data-testid="panel-ai-usage">
        <div class="flex items-center justify-between flex-wrap gap-2">
          <button type="button" class="sa-aiusage__toggle" @click="aiUsageExpanded = !aiUsageExpanded" :aria-expanded="aiUsageExpanded">
            <h2 class="text-base font-semibold" :style="{ color: 'var(--md-sys-color-on-surface)' }">AI Usage</h2>
          </button>
          <div class="flex gap-1 flex-wrap">
            <button
              v-for="r in AI_USAGE_TABS" :key="r.key"
              class="sa-tab"
              :class="{ 'sa-tab--active': aiUsageRange === r.key }"
              @click="setAiUsageRange(r.key)"
            >{{ r.label }}</button>
          </div>
        </div>
        <template v-if="aiUsageLoading && !aiUsage">
          <div class="sa-empty">Memuat…</div>
        </template>
        <template v-else-if="aiUsageError">
          <div class="sa-aiusage__err">{{ aiUsageError }}</div>
        </template>
        <template v-else-if="!aiUsageHasData">
          <div class="sa-empty">Belum ada pemakaian AI</div>
        </template>
        <template v-else>
          <!-- Angka besar = COST (D1) -->
          <div class="sa-aiusage__total">{{ fmtUsd(aiUsage.totals.costUsd) }}</div>
          <div class="sa-aiusage__rp">≈ {{ fmtRp(aiUsage.totals.costUsd, aiUsage.usdToIdr) }}</div>
          <div class="sa-storage__sub">
            {{ fmtNum(aiUsage.totals.calls) }} call · {{ fmtNum(aiUsage.totals.tokens) }} token · {{ fmtNum(aiUsage.totals.errors) }} error
          </div>
          <!-- Mini bar cost per hari (maks 14 bar) — div/CSS, tanpa Chart.js -->
          <div v-if="aiUsageBars.length" class="sa-aiusage__bars" role="img" aria-label="Biaya AI per hari">
            <div
              v-for="b in aiUsageBars" :key="b.date"
              class="sa-aiusage__bar"
              :style="{ height: b.pct + '%' }"
              :title="b.title"
            ></div>
          </div>
          <!-- Expand inline (tap panel header) — D1 -->
          <div v-if="aiUsageExpanded" class="sa-aiusage__expand">
            <div class="sa-aiusage__stats">
              <div class="sa-aiusage__stat"><span class="sa-aiusage__stat-n">{{ fmtNum(aiUsage.totals.calls) }}</span><span class="sa-aiusage__stat-l">Call</span></div>
              <div class="sa-aiusage__stat"><span class="sa-aiusage__stat-n">{{ fmtNum(aiUsage.totals.tokens) }}</span><span class="sa-aiusage__stat-l">Token</span></div>
              <div class="sa-aiusage__stat"><span class="sa-aiusage__stat-n">{{ aiUsage.totals.avgLatencyMs == null ? '—' : (aiUsage.totals.avgLatencyMs / 1000).toLocaleString('id-ID', { maximumFractionDigits: 1 }) + ' dtk' }}</span><span class="sa-aiusage__stat-l">Rata-rata latency</span></div>
              <div class="sa-aiusage__stat">
                <span class="sa-aiusage__stat-n">{{ fmtNum(aiUsage.totals.errors) }} error · {{ fmtNum(aiUsage.totals.fallbacks) }} fallback</span>
                <span class="sa-aiusage__stat-l" v-if="(aiUsage.totals.fallbackSavedUsd || 0) > 0">hemat {{ fmtUsd(aiUsage.totals.fallbackSavedUsd) }} via lokal</span>
                <span class="sa-aiusage__stat-l" v-else>fallback lokal (D5)</span>
              </div>
            </div>
            <div v-if="aiUsage.perTenant.length" class="sa-aiusage__table-wrap">
              <table class="sa-aiusage__table">
                <thead>
                  <tr><th>Tenant</th><th class="num">Calls</th><th class="num">Tokens</th><th class="num">Cost</th><th>Terakhir</th></tr>
                </thead>
                <tbody>
                  <tr v-for="t in aiUsage.perTenant" :key="t.tenantId">
                    <td>{{ t.name }}</td>
                    <td class="num">{{ fmtNum(t.calls) }}</td>
                    <td class="num">{{ fmtNum(t.tokens) }}</td>
                    <td class="num">{{ fmtUsd(t.costUsd) }}</td>
                    <td>{{ t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString('id-ID') : '—' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-if="aiUsage.untrackedModels.length" class="sa-aiusage__warn" role="alert">
              ⚠️ {{ aiUsage.untrackedModels.join(', ') }} belum di-set rate — cost gak terlacak.
            </div>
            <div class="sa-aiusage__hint">Atur rate di Pengaturan → AI Assistant</div>
          </div>
        </template>
      </div>

      <!-- Charts grid -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <!-- v3.9.20 — bar tab range per panel (reuse .sa-tab) -->
<!-- Trend chat -->
        <div class="sa-panel">
          <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 class="text-base font-semibold" :style="{ color: 'var(--md-sys-color-on-surface)' }">
              Trend Chat
              <span v-if="trendDelta != null" class="sa-delta ml-1" :class="trendDelta >= 0 ? 'sa-delta--up' : 'sa-delta--down'">
                {{ trendDelta >= 0 ? '↑' : '↓' }} {{ Math.abs(trendDelta) }}%
              </span>
            </h2>
            <div class="flex gap-1 flex-wrap">
              <button
                v-for="r in RANGE_TABS" :key="r.key"
                class="sa-tab"
                :class="{ 'sa-tab--active': trendRange === r.key }"
                @click="setTrendRange(r.key)"
              >{{ r.label }}</button>
            </div>
          </div>
          <div v-if="trendRange === 'custom'" class="sa-custom-row">
            <input v-model="trendCustom.from" type="date" class="sa-date" :max="todayStr" aria-label="Tanggal mulai">
            <span class="sa-date-sep">–</span>
            <input v-model="trendCustom.to" type="date" class="sa-date" :max="todayStr" aria-label="Tanggal akhir">
            <button class="m3-btn m3-btn--tonal sa-apply-btn" @click="applyTrendCustom">Terapkan</button>
            <span v-if="trendCustom.error" class="sa-custom-err">{{ trendCustom.error }}</span>
          </div>
          <div class="sa-chart-box"><canvas ref="trendCanvas"></canvas></div>
        </div>

        <!-- Pie Resolved vs Open -->
        <div class="sa-panel">
          <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 class="text-base font-semibold" :style="{ color: 'var(--md-sys-color-on-surface)' }">Resolved vs Open</h2>
            <div class="flex gap-1 flex-wrap">
              <button
                v-for="r in RANGE_TABS" :key="r.key"
                class="sa-tab"
                :class="{ 'sa-tab--active': pieRange === r.key }"
                @click="setPieRange(r.key)"
              >{{ r.label }}</button>
            </div>
          </div>
          <div v-if="pieRange === 'custom'" class="sa-custom-row">
            <input v-model="pieCustom.from" type="date" class="sa-date" :max="todayStr" aria-label="Tanggal mulai">
            <span class="sa-date-sep">–</span>
            <input v-model="pieCustom.to" type="date" class="sa-date" :max="todayStr" aria-label="Tanggal akhir">
            <button class="m3-btn m3-btn--tonal sa-apply-btn" @click="applyPieCustom">Terapkan</button>
            <span v-if="pieCustom.error" class="sa-custom-err">{{ pieCustom.error }}</span>
          </div>
          <div class="sa-chart-box sa-chart-box--pie"><canvas ref="pieCanvas"></canvas></div>
          <div class="text-center text-sm mt-2" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
            {{ pieLegendLabel }}<template v-if="pieWindowLabel"> — {{ pieWindowLabel }}</template>
          </div>
        </div>

        <!-- Avg response time -->
        <div class="sa-panel lg:col-span-2">
          <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 class="text-base font-semibold" :style="{ color: 'var(--md-sys-color-on-surface)' }">Avg Response Time</h2>
            <div class="flex items-center gap-2 flex-wrap">
              <span class="sa-pill" style="background: #ede9fe; color: #5b21b6;">
                Total: {{ fmtMinute(avgResp?.avgTotal) }}
              </span>
              <div class="flex gap-1 flex-wrap">
                <button
                  v-for="r in RANGE_TABS" :key="r.key"
                  class="sa-tab"
                  :class="{ 'sa-tab--active': respRange === r.key }"
                  @click="setRespRange(r.key)"
                >{{ r.label }}</button>
              </div>
            </div>
          </div>
          <div v-if="respRange === 'custom'" class="sa-custom-row">
            <input v-model="respCustom.from" type="date" class="sa-date" :max="todayStr" aria-label="Tanggal mulai">
            <span class="sa-date-sep">–</span>
            <input v-model="respCustom.to" type="date" class="sa-date" :max="todayStr" aria-label="Tanggal akhir">
            <button class="m3-btn m3-btn--tonal sa-apply-btn" @click="applyRespCustom">Terapkan</button>
            <span v-if="respCustom.error" class="sa-custom-err">{{ respCustom.error }}</span>
          </div>
          <div class="sa-chart-box"><canvas ref="avgCanvas"></canvas></div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.sa-card {
  background: var(--md-sys-color-surface-container);
  border-radius: var(--md-sys-shape-corner-m);
  padding: 12px 16px;
}
.sa-stat {
  font-size: 1.4rem;
  font-weight: 700;
  color: var(--md-sys-color-on-surface);
}
.sa-label {
  font-size: 0.78rem;
  color: var(--md-sys-color-on-surface-variant);
}
.sa-delta {
  font-size: 0.72rem;
  font-weight: 600;
  margin-top: 2px;
}
.sa-delta--up { color: #166534; }
.sa-delta--down { color: #991b1b; }
.sa-panel {
  background: var(--md-sys-color-surface-container);
  border-radius: var(--md-sys-shape-corner-l);
  box-shadow: var(--md-sys-elevation-1);
  padding: 20px;
}
.sa-empty {
  text-align: center;
  padding: 32px 0;
  color: var(--md-sys-color-on-surface-variant);
}
/* Card aksen ungu (focal point) */
.sa-hero {
  background: linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%);
  border-radius: var(--md-sys-shape-corner-l);
  box-shadow: var(--md-sys-elevation-2);
  padding: 20px 24px;
  color: #fff;
}
.sa-hero__label {
  font-size: 0.85rem;
  opacity: 0.85;
  font-weight: 500;
}
.sa-hero__num {
  font-size: 2.4rem;
  font-weight: 800;
  line-height: 1.1;
  margin: 4px 0;
}
.sa-hero__sub {
  font-size: 0.78rem;
  opacity: 0.8;
}
.sa-spark {
  width: 140px;
  height: 56px;
  opacity: 0.9;
}
/* Tabs range */
.sa-tab {
  padding: 6px 14px;
  border-radius: 999px;
  border: 1px solid var(--md-sys-color-outline-variant);
  background: transparent;
  color: var(--md-sys-color-on-surface-variant);
  font-size: 0.8rem;
  font-weight: 500;
  cursor: pointer;
  min-height: 32px;
}
.sa-tab--active {
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
  border-color: transparent;
  font-weight: 600;
}
/* v3.9.20 — custom date-picker row */
.sa-custom-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
  font-size: 0.8rem;
  color: var(--md-sys-color-on-surface-variant);
}
.sa-date {
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-s);
  background: var(--md-sys-color-surface);
  color: var(--md-sys-color-on-surface);
  padding: 6px 10px;
  min-height: 32px;
  font-size: 0.8rem;
}
.sa-apply-btn {
  min-height: 32px;
  font-size: 0.8rem;
  padding: 4px 14px;
}
.sa-custom-err {
  color: #991b1b;
  font-weight: 500;
  width: 100%;
}
.sa-date-sep {
  color: var(--md-sys-color-on-surface-variant);
}
/* v3.9.21 — Panel Storage Tangan Kanan */
.sa-storage__total {
  font-size: 1.6rem;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
  line-height: 1.15;
  margin-top: 2px;
}
.sa-storage__sub {
  font-size: 0.78rem;
  color: var(--md-sys-color-on-surface-variant);
}
.sa-storage__rows {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
}
.sa-storage__row {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 12px;
  align-items: baseline;
  padding: 7px 0;
  border-top: 1px solid var(--md-sys-color-outline-variant);
  font-size: 0.85rem;
}
.sa-storage__row:first-child {
  border-top: none;
}
.sa-storage__name {
  color: var(--md-sys-color-on-surface);
  font-weight: 500;
}
.sa-storage__bytes {
  color: var(--md-sys-color-on-surface);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.sa-storage__files {
  color: var(--md-sys-color-on-surface-variant);
  font-size: 0.78rem;
}
/* v3.9.24 — Panel AI Usage */
.sa-aiusage__toggle {
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  text-align: left;
}
.sa-aiusage__total {
  font-size: 1.6rem;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
  line-height: 1.15;
  margin-top: 6px;
}
.sa-aiusage__rp {
  font-size: 0.85rem;
  color: var(--md-sys-color-on-surface-variant);
  margin-bottom: 2px;
}
.sa-aiusage__bars {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 48px;
  margin-top: 10px;
}
.sa-aiusage__bar {
  flex: 1;
  min-height: 2px;
  background: var(--md-sys-color-primary, #25d366);
  opacity: 0.75;
  border-radius: 3px 3px 0 0;
}
.sa-aiusage__expand {
  margin-top: 14px;
  border-top: 1px solid var(--md-sys-color-outline-variant);
  padding-top: 12px;
}
.sa-aiusage__stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
}
.sa-aiusage__stat {
  display: flex;
  flex-direction: column;
}
.sa-aiusage__stat-n {
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--md-sys-color-on-surface);
}
.sa-aiusage__stat-l {
  font-size: 0.75rem;
  color: var(--md-sys-color-on-surface-variant);
}
.sa-aiusage__table-wrap {
  margin-top: 12px;
  overflow-x: auto;
}
.sa-aiusage__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.82rem;
}
.sa-aiusage__table th,
.sa-aiusage__table td {
  text-align: left;
  padding: 6px 8px;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  color: var(--md-sys-color-on-surface);
}
.sa-aiusage__table th {
  font-weight: 600;
  color: var(--md-sys-color-on-surface-variant);
}
.sa-aiusage__table td.num,
.sa-aiusage__table th.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.sa-aiusage__warn {
  margin-top: 10px;
  font-size: 0.8rem;
  padding: 8px 12px;
  border-radius: var(--md-sys-shape-corner-s);
  background: var(--md-sys-color-error-container);
  color: var(--md-sys-color-on-error-container);
}
.sa-aiusage__err {
  margin-top: 8px;
  font-size: 0.85rem;
  color: #991b1b;
  font-weight: 500;
}
.sa-aiusage__hint {
  margin-top: 8px;
  font-size: 0.72rem;
  color: var(--md-sys-color-on-surface-variant);
}
.sa-chart-box {
  position: relative;
  height: 260px;
}
.sa-chart-box--pie {
  height: 230px;
}
@media (max-width: 767px) {
  .sa-chart-box { height: 220px; }
  .sa-hero__num { font-size: 1.7rem; }
  .sa-spark { width: 110px; }
}
</style>