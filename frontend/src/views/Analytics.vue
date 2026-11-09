<template>
  <PageShell title="Analytics" back-to="/admin">
    <!-- Top bar (desktop only — mobile: PageShell topbar + homerow, v0.3.0) -->
    <header class="hidden md:flex m3-topbar px-4 py-3 items-center justify-between">
      <div class="flex items-center gap-3">
        <h1 class="text-lg font-semibold">Analytics</h1>
      </div>
      <div class="flex items-center gap-4">
        <router-link to="/" class="text-sm hover:underline">Dashboard</router-link>
        <router-link to="/contacts" class="text-sm hover:underline">Kontak</router-link>
        <router-link to="/settings" class="text-sm hover:underline">{{ auth.user?.username }}</router-link>
        <button @click="handleLogout" class="text-sm hover:underline">Logout</button>
      </div>
    </header>

    <div class="max-w-4xl mx-auto w-full p-6 space-y-6">
      <!-- Header + range selector -->
      <div class="bg-white rounded-lg shadow-sm p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h2 class="text-xl font-semibold">📊 Analytics & CS Performance</h2>
          <p class="text-sm text-gray-500">Performa CS dan lifecycle chat</p>
        </div>
        <div class="flex flex-col sm:flex-row sm:items-center gap-2">
          <div class="flex flex-wrap items-center gap-2">
            <div class="flex bg-gray-100 rounded-lg p-1">
              <button
                v-for="r in ranges"
                :key="r.value"
                @click="setRange(r.value)"
                :class="['px-3 py-1.5 text-sm rounded-md font-medium', range === r.value ? 'bg-white text-wa-dark shadow-sm' : 'text-gray-600 hover:text-gray-900']"
              >
                {{ r.label }}
              </button>
            </div>
            <div v-if="range === 'custom'" class="flex items-center gap-2">
              <input
                v-model="customStart"
                type="date"
                class="px-2 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-wa-green"
              />
              <span class="text-gray-500">s/d</span>
              <input
                v-model="customEnd"
                type="date"
                class="px-2 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-wa-green"
              />
              <button
                @click="applyCustom"
                :disabled="!customStart || !customEnd"
                class="px-3 py-1.5 text-sm font-medium rounded-lg bg-wa-dark text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-wa-darker"
              >
                Terapkan
              </button>
            </div>
          </div>
          <button
            @click="fetchAll"
            :disabled="loading || (range === 'custom' && !customApplied.start)"
            class="p-2 text-gray-600 hover:text-wa-dark hover:bg-gray-100 rounded-lg self-start sm:self-auto"
            title="Refresh"
          >
            🔄
          </button>
          <button
            @click="exportAllJson"
            :disabled="loading"
            class="px-3 py-1.5 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40 self-start sm:self-auto"
            title="Export semua data analytics (JSON) utk periode aktif — overview, performa CS, heatmap, CSAT"
          >
            ⬇ JSON
          </button>
          <button
            @click="exportExcel"
            :disabled="exportingExcel"
            class="px-3 py-1.5 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40 self-start sm:self-auto"
            title="Laporan bulanan format Excel — per nomor WA + pesan per CS (12 bulan)"
          >
            ⬇ Excel
          </button>
        </div>
      </div>

      <!-- KPI cards -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <div class="bg-white rounded-lg shadow-sm p-4">
          <p class="text-xs text-gray-500 uppercase font-medium">Chat Masuk</p>
          <p class="text-2xl font-semibold mt-1">{{ formatNumber(overview.totals.chatsIn) }}</p>
        </div>
        <div class="bg-white rounded-lg shadow-sm p-4">
          <p class="text-xs text-gray-500 uppercase font-medium">Chat Selesai</p>
          <p class="text-2xl font-semibold mt-1">{{ formatNumber(overview.totals.chatsResolved) }}</p>
        </div>
        <div class="bg-white rounded-lg shadow-sm p-4">
          <p class="text-xs text-gray-500 uppercase font-medium">Backlog Aktif</p>
          <p class="text-2xl font-semibold mt-1">{{ formatNumber(overview.totals.backlogOpen) }}</p>
          <p class="text-xs text-gray-400 mt-1">Unassigned: {{ formatNumber(overview.totals.unassignedOpen) }}</p>
        </div>
        <div class="bg-white rounded-lg shadow-sm p-4">
          <p class="text-xs text-gray-500 uppercase font-medium">Avg First Response</p>
          <p class="text-2xl font-semibold mt-1">{{ formatDurationLabel(overview.totals.avgFirstResponseMin) }}</p>
        </div>
        <div class="bg-white rounded-lg shadow-sm p-4">
          <p class="text-xs text-gray-500 uppercase font-medium">Avg Resolve (sejak take)</p>
          <p class="text-2xl font-semibold mt-1">{{ formatDurationLabel(overview.totals.avgResolutionMin) }}</p>
        </div>
        <div class="bg-white rounded-lg shadow-sm p-4">
          <p class="text-xs text-gray-500 uppercase font-medium">Avg Idle→Takeover</p>
          <p class="text-2xl font-semibold mt-1">{{ formatDurationLabel(overview.totals.avgTakeoverMin) }}</p>
        </div>
      </div>

      <!-- Agent performance -->
      <div class="bg-white rounded-lg shadow-sm overflow-hidden">
        <div class="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
          <h3 class="font-semibold">Performa CS</h3>
          <div class="flex items-center gap-2">
            <span class="text-xs text-gray-500">Sort by: Ditangani desc</span>
            <button @click="exportAgentsCsv" :disabled="agents.length === 0" class="text-xs px-2 py-1 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40" title="Export performa CS (CSV)">⬇ CSV</button>
          </div>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full">
            <thead class="bg-gray-50 border-b border-gray-200">
              <tr>
                <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Username</th>
                <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Aktif</th>
                <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Ditangani</th>
                <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Resolved</th>
                <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Avg First Response</th>
                <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Avg Resolve</th>
                <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Avg Takeover</th>
                <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Pesan Terkirim</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100">
              <tr v-for="agent in agents" :key="agent.userId" class="hover:bg-gray-50">
                <td class="px-4 py-3 text-sm">
                  <div class="flex items-center gap-2">
                    <span>{{ agent.username }}</span>
                    <span class="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">{{ agent.role }}</span>
                  </div>
                </td>
                <td class="px-4 py-3 text-sm">{{ agent.activeChats }}</td>
                <td class="px-4 py-3 text-sm">
                  <div class="flex items-center gap-2">
                    <span>{{ agent.totalHandled }}</span>
                    <div class="w-16 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div class="h-full bg-wa-green rounded-full" :style="{ width: barWidth(agent.totalHandled, maxHandled) + '%' }"></div>
                    </div>
                  </div>
                </td>
                <td class="px-4 py-3 text-sm">{{ agent.resolvedCount }}</td>
                <td class="px-4 py-3 text-sm">{{ formatDurationLabel(agent.avgFirstResponseMin) }}</td>
                <td class="px-4 py-3 text-sm">{{ formatDurationLabel(agent.avgResolutionMin) }}</td>
                <td class="px-4 py-3 text-sm">{{ formatDurationLabel(agent.avgTakeoverMin) }}</td>
                <td class="px-4 py-3 text-sm">{{ formatNumber(agent.messagesSent) }}</td>
              </tr>
              <tr v-if="agents.length === 0">
                <td colspan="8" class="px-4 py-8 text-center text-gray-400 text-sm">Belum ada data CS</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Heatmap -->
      <div class="bg-white rounded-lg shadow-sm p-4">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between mb-4 gap-3">
          <h3 class="font-semibold">Heatmap Hari×Jam</h3>
          <div class="flex flex-wrap items-center gap-2">
            <!-- CS filter -->
            <select
              v-model="heatmapCs"
              @change="fetchHourly"
              class="px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-wa-green"
            >
              <option :value="null">Semua CS</option>
              <option v-for="agent in agentOptions" :key="agent.id" :value="agent.id">@{{ agent.username }}</option>
            </select>
            <div class="flex bg-gray-100 rounded-lg p-1">
              <button
                v-for="tab in heatmapTabs"
                :key="tab.value"
                @click="heatmapTab = tab.value"
                :class="['px-3 py-1.5 text-sm rounded-md font-medium', heatmapTab === tab.value ? 'bg-white text-wa-dark shadow-sm' : 'text-gray-600 hover:text-gray-900']"
              >
                {{ tab.label }}
              </button>
            </div>
            <button @click="exportHeatmapCsv" class="text-xs px-2 py-1 border border-gray-300 rounded-lg hover:bg-gray-50" title="Export heatmap sesuai tab &amp; filter aktif (CSV)">⬇ CSV</button>
          </div>
        </div>

        <div class="overflow-x-auto">
          <div class="min-w-[800px]">
            <!-- Hour labels -->
            <div class="grid grid-cols-[80px_repeat(24,1fr)] gap-px">
              <div></div>
              <div v-for="hour in 24" :key="hour" class="text-[10px] text-center text-gray-500 py-1">{{ hour - 1 }}</div>
            </div>
            <!-- Days -->
            <div class="grid grid-cols-[80px_repeat(24,1fr)] gap-px">
              <template v-for="dow in 7" :key="dow">
                <div class="text-xs font-medium text-gray-600 flex items-center">{{ dayLabels[dow - 1] }}</div>
                <div
                  v-for="hour in 24"
                  :key="`${dow}-${hour}`"
                  :title="tooltipFor(dow - 1, hour - 1)"
                  :class="['h-8 rounded-sm', heatmapColorClass(dow - 1, hour - 1)]"
                ></div>
              </template>
            </div>
          </div>
        </div>
        <div class="flex items-center gap-2 mt-3 text-xs text-gray-500">
          <span>Less</span>
          <div class="flex gap-1">
            <div class="w-4 h-4 bg-emerald-100 rounded-sm"></div>
            <div class="w-4 h-4 bg-emerald-200 rounded-sm"></div>
            <div class="w-4 h-4 bg-emerald-300 rounded-sm"></div>
            <div class="w-4 h-4 bg-emerald-500 rounded-sm"></div>
            <div class="w-4 h-4 bg-emerald-600 rounded-sm"></div>
          </div>
          <span>More</span>
        </div>
      </div>

      <!-- v0.10.0 — Fitur C: section "⭐ CSAT" -->
      <div class="bg-white rounded-lg shadow-sm p-4">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between mb-4 gap-3">
          <div>
            <h3 class="font-semibold">⭐ CSAT</h3>
            <p class="text-xs text-gray-500">Kepuasan pelanggan (rating 1–5 setelah chat resolved)</p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <div class="flex flex-wrap items-center gap-2 text-xs text-gray-500">
              <span>Terkirim: <strong>{{ csatStats.totalSent ?? '—' }}</strong></span>
              <span>·</span>
              <span>Respons: <strong>{{ csatStats.totalResponded ?? '—' }}</strong></span>
              <span>·</span>
              <span>Rate: <strong>{{ csatResponseRateLabel }}</strong></span>
            </div>
            <button @click="exportCsatCsv" :disabled="!(csatStats.perCs || []).length" class="text-xs px-2 py-1 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40" title="Export per-CS rating (CSV)">⬇ CSV</button>
            <button @click="fetchCsat" class="p-2 text-gray-600 hover:text-wa-dark hover:bg-gray-100 rounded-lg" title="Refresh CSAT" style="min-height: 44px; min-width: 44px;">🔄</button>
          </div>
        </div>
        <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-3 mb-4">
          <div class="rounded-lg p-3 text-center" style="background: var(--md-sys-color-surface-container, #f7f5fa);">
            <p class="text-xs text-gray-500 uppercase font-medium">Avg Rating</p>
            <p class="text-2xl font-semibold mt-1">{{ csatAvgLabel }}</p>
          </div>
          <div
            v-for="star in [1, 2, 3, 4, 5]"
            :key="star"
            class="rounded-lg p-3 text-center"
            style="background: var(--md-sys-color-surface-container, #f7f5fa);"
          >
            <p class="text-xs text-gray-500 uppercase font-medium">{{ '⭐'.repeat(star) }}</p>
            <p class="text-2xl font-semibold mt-1">{{ csatStats.distribution?.[star] ?? 0 }}</p>
            <p class="text-[10px] text-gray-400">{{ csatDistPercent(star) }}%</p>
          </div>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full">
            <thead class="bg-gray-50 border-b border-gray-200">
              <tr>
                <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">CS</th>
                <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Role</th>
                <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Respons</th>
                <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Avg Rating</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100">
              <tr v-for="cs in csatStats.perCs || []" :key="cs.userId" class="hover:bg-gray-50">
                <td class="px-4 py-3 text-sm font-medium">@{{ cs.username }}</td>
                <td class="px-4 py-3 text-sm">{{ cs.role }}</td>
                <td class="px-4 py-3 text-sm">{{ cs.responses }}</td>
                <td class="px-4 py-3 text-sm">{{ cs.avgRating != null ? (Math.round(cs.avgRating * 100) / 100).toFixed(2) : '—' }}</td>
              </tr>
              <tr v-if="!(csatStats.perCs || []).length">
                <td colspan="4" class="px-4 py-6 text-center text-gray-400 text-sm">Belum ada respons CSAT</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Lifecycle chats -->
      <div class="bg-white rounded-lg shadow-sm overflow-hidden">
        <div class="px-4 py-3 border-b border-gray-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <h3 class="font-semibold">Lifecycle Chat</h3>
          <div class="flex bg-gray-100 rounded-lg p-1">
            <button
              v-for="s in statusFilters"
              :key="s.value"
              @click="statusFilter = s.value; page = 1; fetchChats()"
              :class="['px-3 py-1.5 text-sm rounded-md font-medium', statusFilter === s.value ? 'bg-white text-wa-dark shadow-sm' : 'text-gray-600 hover:text-gray-900']"
            >
              {{ s.label }}
            </button>
          </div>
          <button @click="exportChatsCsv" :disabled="exporting" class="text-xs px-2 py-1 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40" title="Export lifecycle chat (CSV) — semua halaman dlm range aktif">
            {{ exporting ? 'Mengumpulkan…' : '⬇ CSV' }}
          </button>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full">
            <thead class="bg-gray-50 border-b border-gray-200">
              <tr>
                <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Kontak</th>
                <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Masuk</th>
                <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Take (Δ)</th>
                <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Balas (Δ)</th>
                <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Resolve (Δ)</th>
                <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Pesan CS</th>
                <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100">
              <tr v-for="chat in chats" :key="chat.chatId" class="hover:bg-gray-50">
                <td class="px-4 py-3 text-sm font-medium">{{ chat.contactName || chat.chatId }}</td>
                <td class="px-4 py-3 text-xs text-gray-600">{{ formatDateTime(chat.firstIncomingAt) }}</td>
                <td class="px-4 py-3 text-xs text-gray-600">
                  {{ chat.assignee || '—' }}<br/>
                  <span class="text-emerald-600">{{ formatDurationLabel(chat.takeoverMin) }}</span>
                </td>
                <td class="px-4 py-3 text-xs text-gray-600">
                  {{ chat.firstResponseBy || '—' }}<br/>
                  <span class="text-emerald-600">{{ formatDurationLabel(chat.firstResponseMin) }}</span>
                </td>
                <td class="px-4 py-3 text-xs text-gray-600">
                  {{ chat.resolvedBy || '—' }}<br/>
                  <span class="text-emerald-600">{{ formatDurationLabel(chat.resolutionMin) }}</span>
                </td>
                <td class="px-4 py-3 text-sm">{{ chat.csMessagesBeforeResolve ?? '—' }}</td>
                <td class="px-4 py-3">
                  <span :class="['text-xs px-2 py-1 rounded-full font-medium', chat.status === 'resolved' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700']">
                    {{ chat.status }}
                  </span>
                </td>
              </tr>
              <tr v-if="chats.length === 0">
                <td colspan="7" class="px-4 py-8 text-center text-gray-400 text-sm">Tidak ada chat dalam range ini</td>
              </tr>
            </tbody>
          </table>
        </div>
        <!-- Pagination -->
        <div v-if="totalPages > 1" class="px-4 py-3 border-t border-gray-200 flex items-center justify-between">
          <p class="text-xs text-gray-500">{{ total }} chat total · halaman {{ page }} dari {{ totalPages }}</p>
          <div class="flex gap-2">
            <button
              @click="page--; fetchChats()"
              :disabled="page <= 1"
              class="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40"
            >
              Prev
            </button>
            <button
              @click="page++; fetchChats()"
              :disabled="page >= totalPages"
              class="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  </PageShell>
</template>

<script setup>
import PageShell from '../components/PageShell.vue'
import { ref, computed, onMounted, watch } from 'vue'
import axios from 'axios'
import { useAuthStore } from '../stores/auth'

const API = import.meta.env.VITE_API_URL || ''
const auth = useAuthStore()

const loading = ref(false)
const range = ref('30d')
const ranges = [
  { value: '7d', label: '7 hari' },
  { value: '30d', label: '30 hari' },
  { value: 'all', label: 'Semua' },
  { value: 'custom', label: 'Kustom' },
]
const customStart = ref('')
const customEnd = ref('')
const customApplied = ref({ start: '', end: '' })

const heatmapTab = ref('byMessages')
const heatmapCs = ref(null)
const agentOptions = ref([])
const heatmapTabs = computed(() => {
  if (heatmapCs.value != null) {
    return [
      { value: 'byMessages', label: 'Pesan Dibalas' },
      { value: 'byNewChats', label: 'Chat Diambil' },
    ]
  }
  return [
    { value: 'byMessages', label: 'Pesan Masuk' },
    { value: 'byNewChats', label: 'Chat Baru' },
  ]
})

const statusFilter = ref('all')
const statusFilters = [
  { value: 'all', label: 'Semua' },
  { value: 'open', label: 'Open' },
  { value: 'resolved', label: 'Resolved' },
]

const dayLabels = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min']
const page = ref(1)

const overview = ref({ range: '30d', totals: {} })
const agents = ref([])
// v0.10.0 — CSAT stats (admin endpoint /api/csat/stats)
const csatStats = ref({ distribution: {}, perCs: [] })
const csatAvgLabel = computed(() => {
  const a = csatStats.value.avgRating
  return a != null ? (Math.round(a * 100) / 100).toFixed(2) + ' ⭐' : '—'
})
const csatResponseRateLabel = computed(() => {
  const r = csatStats.value.responseRate
  return r != null ? Math.round(r * 100) + '%' : '—'
})
function csatDistPercent(star) {
  const total = csatStats.value.totalResponded || 0
  if (!total) return '0'
  return Math.round(((csatStats.value.distribution?.[star] || 0) / total) * 100)
}
async function fetchCsat() {
  try {
    let url = `${API}/api/csat/stats`
    if (range.value === 'custom' && customApplied.value.start && customApplied.value.end) {
      url += `?from=${customApplied.value.start}&to=${customApplied.value.end}`
    }
    const res = await axios.get(url)
    csatStats.value = res.data
  } catch (e) {
    console.error('Fetch CSAT error:', e)
  }
}
const hourly = ref({ byMessages: [], byNewChats: [], cs: null })
const chats = ref([])
const total = ref(0)
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / 20)))
const maxHandled = computed(() => Math.max(1, ...agents.value.map((a) => a.totalHandled)))

function setRange(value) {
  range.value = value
  if (value !== 'custom') {
    customApplied.value = { start: '', end: '' }
    fetchAll()
  }
}

function applyCustom() {
  if (!customStart.value || !customEnd.value) return
  customApplied.value = { start: customStart.value, end: customEnd.value }
  fetchAll()
}

async function fetchAll() {
  loading.value = true
  await Promise.all([fetchOverview(), fetchAgents(), fetchHourly(), fetchChats(), fetchCsat()])
  loading.value = false
}

function rangeQuery() {
  if (range.value === 'custom' && customApplied.value.start && customApplied.value.end) {
    return `start=${customApplied.value.start}&end=${customApplied.value.end}`
  }
  return `range=${range.value}`
}

async function fetchOverview() {
  try {
    const res = await axios.get(`${API}/api/analytics/overview?${rangeQuery()}`)
    overview.value = res.data
  } catch (e) {
    console.error('Fetch overview error:', e)
  }
}

async function fetchAgents() {
  try {
    const res = await axios.get(`${API}/api/analytics/agents?${rangeQuery()}`)
    agents.value = res.data.agents
  } catch (e) {
    console.error('Fetch agents error:', e)
  }
}

async function fetchHourly() {
  try {
    let url = `${API}/api/analytics/hourly?${rangeQuery()}`
    if (heatmapCs.value != null) {
      url += `&cs=${heatmapCs.value}`
    }
    const res = await axios.get(url)
    hourly.value = res.data
  } catch (e) {
    console.error('Fetch hourly error:', e)
  }
}

async function fetchAgentOptions() {
  try {
    const res = await axios.get(`${API}/api/users/agents`)
    agentOptions.value = res.data.users
  } catch (e) {
    console.error('Fetch agent options error:', e)
  }
}

async function fetchChats() {
  try {
    const res = await axios.get(`${API}/api/analytics/chats?${rangeQuery()}&status=${statusFilter.value}&page=${page.value}`)
    chats.value = res.data.chats
    total.value = res.data.total
  } catch (e) {
    console.error('Fetch chats error:', e)
  }
}

function formatNumber(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return Number(n).toLocaleString('id-ID')
}

function formatDurationLabel(minutes) {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes)) return '—'
  if (minutes < 60) return `${Math.round(minutes * 10) / 10}m`
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  if (h < 24) return `${h}h ${m}m`
  const d = Math.floor(h / 24)
  const rh = h % 24
  return `${d}d ${rh}h`
}

function formatDateTime(value) {
  if (!value) return '—'
  return new Date(value).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function barWidth(value, max) {
  if (!value || max === 0) return 0
  return Math.min(100, Math.round((value / max) * 100))
}

function heatmapValues() {
  const grid = heatmapTab.value === 'byMessages' ? hourly.value.byMessages : hourly.value.byNewChats
  const counts = grid.map((c) => c.count).filter((c) => c > 0)
  if (counts.length === 0) return { q1: 0, q2: 0, q3: 0, max: 0 }
  const sorted = counts.sort((a, b) => a - b)
  const q1 = sorted[Math.floor(sorted.length * 0.25)] || 0
  const q2 = sorted[Math.floor(sorted.length * 0.5)] || 0
  const q3 = sorted[Math.floor(sorted.length * 0.75)] || 0
  const max = sorted[sorted.length - 1]
  return { q1, q2, q3, max }
}

function heatmapColorClass(dow, hour) {
  const grid = heatmapTab.value === 'byMessages' ? hourly.value.byMessages : hourly.value.byNewChats
  const cell = grid.find((c) => c.dow === dow && c.hour === hour)
  const count = cell ? cell.count : 0
  if (count === 0) return 'bg-gray-50'
  const { q1, q2, q3 } = heatmapValues()
  if (count <= q1) return 'bg-emerald-100'
  if (count <= q2) return 'bg-emerald-200'
  if (count <= q3) return 'bg-emerald-300'
  return 'bg-emerald-500'
}

function tooltipFor(dow, hour) {
  const grid = heatmapTab.value === 'byMessages' ? hourly.value.byMessages : hourly.value.byNewChats
  const cell = grid.find((c) => c.dow === dow && c.hour === hour)
  const count = cell ? cell.count : 0
  const label = heatmapTab.value === 'byMessages'
    ? (heatmapCs.value != null ? 'pesan dibalas' : 'pesan masuk')
    : (heatmapCs.value != null ? 'chat diambil' : 'chat baru')
  return `${dayLabels[dow]} ${String(hour).padStart(2, '0')}:00 — ${count} ${label}`
}

function handleLogout() {
  auth.logout()
  window.location.href = '/login'
}

// ─── v0.13.6 — Export CSV/JSON (murni frontend; sumber = data yang sudah ke-load) ───
const exporting = ref(false)

function csvEscape(v) {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function exportSuffix() {
  if (range.value === 'custom' && customApplied.value.start && customApplied.value.end) {
    return `custom-${customApplied.value.start}_${customApplied.value.end}`
  }
  return range.value
}

function csvDownload(rows, headers, nameBase) {
  const csv = '\uFEFF' + [headers.join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\n')
  downloadBlob(csv, `${nameBase}-${exportSuffix()}.csv`, 'text/csv;charset=utf-8')
}

function exportAgentsCsv() {
  csvDownload(
    agents.value.map((a) => [a.username, a.role, a.activeChats, a.totalHandled, a.resolvedCount, a.avgFirstResponseMin, a.avgResolutionMin, a.avgTakeoverMin, a.messagesSent]),
    ['Username', 'Role', 'Aktif', 'Ditangani', 'Resolved', 'AvgFirstResponseMin', 'AvgResolveMin', 'AvgTakeoverMin', 'PesanTerkirim'],
    'analytics-performa-cs'
  )
}

function exportHeatmapCsv() {
  const metric = heatmapTab.value === 'byMessages'
    ? (heatmapCs.value != null ? 'pesan_dibalas' : 'pesan_masuk')
    : (heatmapCs.value != null ? 'chat_diambil' : 'chat_baru')
  const grid = heatmapTab.value === 'byMessages' ? hourly.value.byMessages : hourly.value.byNewChats
  const rows = (grid || []).filter((c) => c.count > 0).map((c) => [dayLabels[c.dow], c.hour, c.count, metric])
  csvDownload(rows, ['Hari', 'Jam', 'Jumlah', 'Metrik'], 'analytics-heatmap')
}

function exportCsatCsv() {
  csvDownload(
    (csatStats.value.perCs || []).map((c) => [c.username, c.role, c.responses, c.avgRating != null ? Math.round(c.avgRating * 100) / 100 : '']),
    ['Username', 'Role', 'Respons', 'AvgRating'],
    'analytics-csat'
  )
}

async function exportChatsCsv() {
  exporting.value = true
  try {
    // Kumpulkan SEMUA halaman dalam range+filter aktif (backend paginate 20/hal)
    const all = []
    for (let p = 1; p <= 1000; p++) {
      const res = await axios.get(`${API}/api/analytics/chats?${rangeQuery()}&status=${statusFilter.value}&page=${p}`)
      all.push(...(res.data.chats || []))
      if (res.data.chats.length === 0 || all.length >= res.data.total) break
    }
    csvDownload(
      all.map((c) => [c.contactName || c.chatId, c.firstIncomingAt, c.assignee || '', c.takeoverMin, c.firstResponseBy || '', c.firstResponseMin, c.resolvedBy || '', c.resolutionMin, c.csMessagesBeforeResolve, c.status]),
      ['Kontak', 'MasukISO', 'Assignee', 'TakeoverMin', 'FirstResponseBy', 'FirstResponseMin', 'ResolvedBy', 'ResolutionMin', 'PesanCS', 'Status'],
      'analytics-lifecycle'
    )
  } catch (e) {
    console.error('Export chats error:', e)
  } finally {
    exporting.value = false
  }
}

function exportAllJson() {
  const payload = {
    meta: {
      app: 'wa-cs-hub',
      exportedAt: new Date().toISOString(),
      range: range.value,
      rangeStart: customApplied.value.start || null,
      rangeEnd: customApplied.value.end || null,
      heatmapCs: heatmapCs.value,
    },
    overview: overview.value,
    agents: agents.value,
    hourly: hourly.value,
    csat: csatStats.value,
  }
  downloadBlob(JSON.stringify(payload, null, 2), `analytics-export-${exportSuffix()}.json`, 'application/json')
}

// ─── v4.6.13 (pending) — Excel bulanan: backend generate .xlsx (file binary, tombol hanya unduh) ───
const exportingExcel = ref(false)
async function exportExcel() {
  exportingExcel.value = true
  try {
    const res = await axios.get(`${API}/api/analytics/excel?months=12`, { responseType: 'blob' })
    let filename = null
    const cd = res.headers && res.headers['content-disposition']
    const m = cd ? /filename="([^"]+)"/.exec(cd) : null
    if (m) filename = m[1]
    downloadBlob(res.data, filename || `report-chatbareng-excel-${Date.now()}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  } catch (e) {
    console.error('Export excel error:', e)
  } finally {
    exportingExcel.value = false
  }
}

watch(range, () => {
  if (range.value !== 'custom') fetchAll()
})

onMounted(() => {
  fetchAll()
  fetchAgentOptions()
})
</script>
