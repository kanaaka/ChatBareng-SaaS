<script setup>
// v3.9.19 — View Overview: dashboard SuperAdmin.
// 5 metric cards (GET /api/sa/stats) + delta % vs periode lalu (dihitung frontend
// dari trends API range yg sama vs window sebelumnya via counts 30d split),
// chart trend chat (line/area, tab Hari Ini/7d/30d), avg response line,
// pie donut Resolved vs Open, card aksen ungu "Chat hari ini" + sparkline 7 titik.
// Chart.js di-import dynamic (tree-shaken; register otomatis di modul chart helper).
import { ref, computed, onMounted } from 'vue'
import axios from 'axios'
import { Chart } from 'chart.js/auto'
import { useAuthStore } from '../stores/auth'

const API = import.meta.env.VITE_API_URL || ''
const auth = useAuthStore()

const stats = ref(null)
const loading = ref(true)
const error = ref('')

// ── Trends (line/area) ──
const range = ref('7d') // default 7d per spec §4.2
const trend = ref(null) // { dates, counts, total }
const RANGES = [
  { key: 'today', label: 'Hari Ini' },
  { key: '7d', label: '7 Hari' },
  { key: '30d', label: '30 Hari' },
]

// ── Avg response (line) ──
const avgResp = ref(null) // { dates, avgMinutes, avgTotal }

// ── Resolution (donut) ──
const resolution = ref(null) // { resolved, open, percentResolved, percentOpen }

// ── Card ungu: chat hari ini + sparkline (7 titik terakhir dari 7d trends) ──
const todayChat = ref(0)
const sparkline = ref([])

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

const pieLegendLabel = computed(() => {
  if (!resolution.value) return ''
  const r = resolution.value
  return `Resolved ${r.percentResolved}% · Open ${r.percentOpen}%`
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

const trendDelta = computed(() => (range.value === 'today' ? null : deltaFor(trend.value?.counts)))

// Delta metric cards: bandingkan chat 7d terakhir vs 7d sebelumnya (2 window dari 30d)
const chatDelta = ref(null)
const msgDelta = ref(null) // pesan tak punya trends API → null (tanpa delta)

async function loadOverview() {
  loading.value = true
  try {
    const [s, t, a, r] = await Promise.all([
      axios.get(`${API}/api/sa/stats`),
      axios.get(`${API}/api/sa/stats/trends`, { params: { range: range.value } }),
      axios.get(`${API}/api/sa/stats/avg-response`, { params: { range: range.value } }),
      axios.get(`${API}/api/sa/stats/resolution`, { params: { range: range.value } }),
    ])
    stats.value = s.data
    trend.value = t.data
    avgResp.value = a.data
    resolution.value = r.data

    // Card ungu: chat hari ini dari trends today + sparkline dari 7d
    const [tToday, t7] = await Promise.all([
      axios.get(`${API}/api/sa/stats/trends`, { params: { range: 'today' } }),
      axios.get(`${API}/api/sa/stats/trends`, { params: { range: '7d' } }),
    ])
    todayChat.value = tToday.data?.counts?.[0] ?? 0
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

    renderCharts()
  } catch (e) {
    error.value = e.response?.data?.error || 'Gagal memuat statistik'
  } finally {
    loading.value = false
  }
}

function destroyCharts() {
  for (const c of [trendChart, avgChart, pieChart, sparkChart]) {
    if (c) c.destroy()
  }
  trendChart = avgChart = pieChart = sparkChart = null
}

function renderCharts() {
  if (!trendCanvas.value || !avgCanvas.value || !pieCanvas.value || !sparkCanvas.value) return
  destroyCharts()
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
        pointRadius: trend.value?.counts?.length > 10 ? 0 : 3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: onVar, maxTicksLimit: 10, callback: function (v) { return shortDate(this.getLabelForValue(v)) } }, grid: { display: false } },
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
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: onVar, maxTicksLimit: 8, callback: function (v) { return shortDate(this.getLabelForValue(v)) } }, grid: { display: false } },
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

function setRange(key) {
  range.value = key
  loadOverview()
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
            <div class="sa-hero__sub">
              {{ range === 'today' ? 'chat baru masuk hari ini (WIB)' : `total ${fmtNum(trend?.total)} chat dalam ${range === '7d' ? '7' : '30'} hari terakhir` }}
            </div>
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

      <!-- Charts grid -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <!-- Trend chat -->
        <div class="sa-panel">
          <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 class="text-base font-semibold" :style="{ color: 'var(--md-sys-color-on-surface)' }">
              Trend Chat
              <span v-if="trendDelta != null" class="sa-delta ml-1" :class="trendDelta >= 0 ? 'sa-delta--up' : 'sa-delta--down'">
                {{ trendDelta >= 0 ? '↑' : '↓' }} {{ Math.abs(trendDelta) }}%
              </span>
            </h2>
            <div class="flex gap-1">
              <button
                v-for="r in RANGES" :key="r.key"
                class="sa-tab"
                :class="{ 'sa-tab--active': range === r.key }"
                @click="setRange(r.key)"
              >{{ r.label }}</button>
            </div>
          </div>
          <div class="sa-chart-box"><canvas ref="trendCanvas"></canvas></div>
        </div>

        <!-- Pie Resolved vs Open -->
        <div class="sa-panel">
          <h2 class="text-base font-semibold mb-3" :style="{ color: 'var(--md-sys-color-on-surface)' }">Resolved vs Open</h2>
          <div class="sa-chart-box sa-chart-box--pie"><canvas ref="pieCanvas"></canvas></div>
          <div class="text-center text-sm mt-2" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">{{ pieLegendLabel }}</div>
        </div>

        <!-- Avg response time -->
        <div class="sa-panel lg:col-span-2">
          <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 class="text-base font-semibold" :style="{ color: 'var(--md-sys-color-on-surface)' }">Avg Response Time</h2>
            <span class="sa-pill" style="background: #ede9fe; color: #5b21b6;">
              Total: {{ fmtMinute(avgResp?.avgTotal) }}
            </span>
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