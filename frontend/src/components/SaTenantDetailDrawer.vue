<script setup>
// v4.1.7 — SaTenantDetailDrawer: drawer detail per-tenant (slide dari kanan; mobile full-screen).
// Semua editor yang tadinya hidup di modal/inline SaTenants.vue PINDAH ke sini verbatim:
// Nomor WA (slots + Simpan/Hapus slot + Tambah Slot), Masa Aktif (preset/30d/1y/custom),
// Edit Paket (preset + maxAgents/Contacts/Numbers/tkQuotaGb + feature toggles), Branding
// (brandName/logo + Hapus Logo), API Keys (list + create + revoke + raw-key copy),
// AI Hybrid toggle, Backup, Impersonate, + Admin, Purge/Hapus permanen (ketik nama).
// Endpoint SEMUA existing (0 endpoint baru). Loading data saat drawer dibuka: numbers +
// API keys di-fetch fresh (pola openNumbersModal/openApiKeysModal lama).
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import axios from 'axios'
import { useAuthStore } from '../stores/auth'
import M3TextField from './M3TextField.vue'
import M3Switch from './M3Switch.vue'

const props = defineProps({
  tenant: { type: Object, default: null }, // baris tenant aktif (reaktif dari list parent)
  open: { type: Boolean, default: false },
  focusPurge: { type: Boolean, default: false }, // dibuka lewat tombol "Hapus" di tabel
})
const emit = defineEmits(['close', 'refresh', 'deleted', 'status-change'])

const API = import.meta.env.VITE_API_URL || ''
const auth = useAuthStore()

const t = computed(() => props.tenant || null)
const dError = ref('') // error banner drawer (ganti error global pd aksi dalam drawer)

// ── v3.4 — metadata fitur (dipindah dari parent) ──
const FEATURE_DEFS = [
  { key: 'featAnalytics', label: 'Analytics' },
  { key: 'featBlast', label: 'Blast + Pengumuman' },
  { key: 'featMenuGateway', label: 'Menu Gateway' },
  { key: 'featHistoryExport', label: 'Export/Import Riwayat' },
  { key: 'featCsat', label: 'CSAT' },
  { key: 'featGdriveBackup', label: 'Backup GDrive' },
  { key: 'featApiAccess', label: 'Akses API (v1)' },
  { key: 'featAiRouting', label: 'AI Hybrid Routing' }, // v3.9.25 — Lite ✗ / Pro ✓ / Max ✓ (D5)
  { key: 'featAiKnowledge', label: 'ChatBareng AI (Auto Reply)' }, // v4.0.0 — Lite ✗ / Pro ✓ / Max ✓ (D8)
]
const backingUp = ref(null)

// ── v3.9 — Nomor WA per tenant (pindah dari modal) ──
const numbersForm = ref({ slots: [], maxNumbers: 1, used: 0 })
const numbersSaving = ref(false)
const numbersError = ref('')
const newSlot = ref({ slot: 1, label: '' })

// ── v3.9.13 — API keys (pindah dari modal) ──
const apiKeysRows = ref([])
const apiKeysLoading = ref(false)
const apiKeysNewName = ref('')
const apiKeysNewScopes = ref('send,read')
const apiKeysCreating = ref(false)
const apiKeysError = ref('')
const apiKeysRawKey = ref('') // show-once
const apiKeysWarn = ref('')

async function fetchApiKeys(tenant) {
  apiKeysError.value = ''
  apiKeysRawKey.value = ''
  apiKeysWarn.value = ''
  apiKeysLoading.value = true
  try {
    const { data } = await axios.get(`${API}/api/sa/tenants/${tenant.id}/api-keys`)
    apiKeysRows.value = data.keys || []
  } catch (e) {
    apiKeysError.value = e.response?.data?.error || 'Gagal memuat API keys'
  } finally {
    apiKeysLoading.value = false
  }
}
// openApiKeysModalList lama — refresh list in-place
async function refreshApiKeys(tenant) {
  try {
    const { data } = await axios.get(`${API}/api/sa/tenants/${tenant.id}/api-keys`)
    apiKeysRows.value = data.keys || []
  } catch {}
}
async function createApiKey(tenant) {
  apiKeysCreating.value = true
  apiKeysError.value = ''
  apiKeysRawKey.value = ''
  try {
    const { data } = await axios.post(`${API}/api/sa/tenants/${tenant.id}/api-keys`, {
      name: apiKeysNewName.value.trim() || 'API Key',
      scopes: String(apiKeysNewScopes.value || 'read').split(',').map((s) => s.trim()).filter(Boolean),
    })
    apiKeysRawKey.value = data.key || ''
    apiKeysWarn.value = data.warning || ''
    apiKeysNewName.value = ''
    await refreshApiKeys(tenant)
  } catch (e) {
    apiKeysError.value = e.response?.data?.error || 'Gagal membuat API key'
  } finally {
    apiKeysCreating.value = false
  }
}
async function revokeApiKey(row) {
  const tenant = t.value
  if (!tenant || !window.confirm(`Revoke API key "${row.name}"? Aplikasi yg pakai key ini langsung 401.`)) return
  try {
    await axios.delete(`${API}/api/sa/tenants/${tenant.id}/api-keys/${row.id}`)
    await refreshApiKeys(tenant)
  } catch (e) {
    apiKeysError.value = e.response?.data?.error || 'Gagal revoke key'
  }
}
function copyRawKey() {
  try { navigator.clipboard.writeText(apiKeysRawKey.value) } catch {}
}

// ── v3.9 — Nomor WA (pindah dari modal) ──
async function fetchNumbers(tenant) {
  numbersError.value = ''
  newSlot.value = { slot: 1, label: '' }
  try {
    const { data } = await axios.get(`${API}/api/sa/tenants/${tenant.id}/numbers`)
    numbersForm.value = {
      slots: (data.slots || []).map((s) => ({ ...s, _labelDraft: s.label || '' })),
      maxNumbers: data.maxNumbers,
      used: data.used,
    }
  } catch (e) {
    numbersError.value = e.response?.data?.error || 'Gagal memuat slot'
  }
}
async function refreshNumbers(tenant) {
  if (!tenant) return
  try {
    const { data } = await axios.get(`${API}/api/sa/tenants/${tenant.id}/numbers`)
    const prev = new Map(numbersForm.value.slots.map((s) => [s.slot, s]))
    numbersForm.value.slots = (data.slots || []).map((s) => ({ ...s, _labelDraft: prev.get(s.slot)?._labelDraft ?? (s.label || '') }))
    numbersForm.value.maxNumbers = data.maxNumbers
    numbersForm.value.used = data.used
  } catch {}
}
async function addSlotRow() {
  const tenant = t.value
  if (!tenant) return
  numbersSaving.value = true
  numbersError.value = ''
  try {
    await axios.post(`${API}/api/sa/tenants/${tenant.id}/numbers`, {
      slot: Number(newSlot.value.slot),
      label: String(newSlot.value.label || '').trim() || undefined,
    })
    await refreshNumbers(tenant)
    emit('refresh')
  } catch (e) {
    numbersError.value = e.response?.data?.error || 'Gagal menambah slot'
  } finally {
    numbersSaving.value = false
  }
}
async function saveSlotRow(s) {
  const tenant = t.value
  if (!tenant) return
  numbersError.value = ''
  try {
    await axios.post(`${API}/api/sa/tenants/${tenant.id}/numbers`, {
      slot: s.slot,
      label: String(s._labelDraft || '').trim() || '',
    })
    s.label = String(s._labelDraft || '').trim() || null
    emit('refresh')
  } catch (e) {
    numbersError.value = e.response?.data?.error || 'Gagal menyimpan slot'
  }
}
async function deleteSlotRow(s) {
  const tenant = t.value
  if (!tenant || s.slot === 0) return
  numbersError.value = ''
  try {
    await axios.delete(`${API}/api/sa/tenants/${tenant.id}/numbers/${s.slot}`)
    await refreshNumbers(tenant)
    emit('refresh')
  } catch (e) {
    numbersError.value = e.response?.data?.error || 'Gagal menghapus slot'
  }
}

// ── v3.8 — chip masa aktif (helper, dipakai drawer) ──
function fmtDate(iso) {
  try { return new Date(iso).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) } catch { return iso }
}
function validityChip(tn) {
  const s = tn.validityState
  if (s === 'lifetime') return { label: 'Lifetime', style: 'background:#e5e7eb;color:#374151;' }
  if (s === 'active' && tn.validUntil) return { label: `s/d ${fmtDate(tn.validUntil)}`, style: 'background:#dcfce7;color:#166534;' }
  if (s === 'expiring' && tn.validUntil) {
    const days = Math.max(0, Math.ceil((new Date(tn.validUntil) - new Date()) / 86400000))
    return { label: `⏰ ${days} hari lagi`, style: 'background:#fef9c3;color:#854d0e;' }
  }
  if (s === 'expired') return { label: `Kedaluwarsa ${tn.validUntil ? fmtDate(tn.validUntil) : ''}`, style: 'background:#fee2e2;color:#991b1b;' }
  if (s === 'not_started') return { label: `Mulai ${tn.validFrom ? fmtDate(tn.validFrom) : '?'}`, style: 'background:#dbeafe;color:#1e40af;' }
  return null
}
function validityNowLabel(tn) {
  const chip = validityChip(tn)
  return chip ? chip.label : 'Lifetime'
}

// ── helpers plan/usage (pindah dari parent) ──
function fmtNum(n) {
  return Number(n || 0).toLocaleString('id-ID')
}
function fmtBytes(n) {
  const GB = 1024 ** 3
  const num = Number(n) || 0
  if (num >= GB) return `${(num / GB).toFixed(1).replace('.', ',')} GB`
  const MB = 1024 ** 2
  if (num >= MB) return `${Math.round(num / MB)} MB`
  return `${num} B`
}
function activeFeatures(tn) {
  if (!tn.plan) return []
  return FEATURE_DEFS.filter((f) => tn.plan[f.key]).map((f) => ({ key: f.key, label: f.label }))
}
function planPreset(tn) {
  const p = tn.plan?.preset || 'custom'
  return p.charAt(0).toUpperCase() + p.slice(1)
}
// TanganKanan mini progress bar (v4.1.7 — dipakai drawer juga; guard divide-by-zero)
function tkPct(tn) {
  const q = tn?.plan?.tkQuotaBytes
  if (q == null) return null
  const used = Number(tn?.usage?.tkBytes) || 0
  const quota = Number(q)
  if (quota <= 0) return used > 0 ? 100 : 0
  return Math.min(100, (used / quota) * 100)
}
function tkFillClass(tn) {
  const pct = tkPct(tn)
  if (pct == null) return ''
  if (pct >= 100) return 'sa-tkbar__fill--over'
  if (pct >= 75) return 'sa-tkbar__fill--warn'
  return ''
}

// ── v3.8 — Modal Masa Aktif → section drawer ──
const validityForm = ref({ preset: 'lifetime', startDate: '', endDate: '' })
const validitySaving = ref(false)
const validityError = ref('')

function wibTodayValue() {
  const now = new Date(Date.now() + 7 * 60 * 60 * 1000)
  return now.toISOString().slice(0, 10)
}
function parseWibDateToIso(dateStr, endOfDay = false) {
  if (!dateStr) return null
  const ms = endOfDay ? (23 * 60 + 59) * 60 * 1000 + 999 : 0
  return new Date(Date.UTC(
    Number(dateStr.slice(0, 4)), Number(dateStr.slice(5, 7)) - 1, Number(dateStr.slice(8, 10)),
    0, 0, 0, ms
  ) - 7 * 60 * 60 * 1000).toISOString()
}
function initValidityForm(tn) {
  validityForm.value = {
    preset: tn.validityState === 'lifetime' ? 'lifetime' : 'custom',
    startDate: tn.validFrom ? new Date(new Date(tn.validFrom).getTime() + 7 * 3600000).toISOString().slice(0, 10) : wibTodayValue(),
    endDate: tn.validUntil ? new Date(new Date(tn.validUntil).getTime() + 7 * 3600000).toISOString().slice(0, 10) : '',
  }
  validityError.value = ''
}
const validityPreviewText = computed(() => {
  const f = validityForm.value
  const fmt = (iso) => {
    try { return new Date(iso).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) } catch { return iso }
  }
  if (f.preset === 'lifetime') return 'Lifetime — tanpa batas waktu'
  const startIso = parseWibDateToIso(f.startDate, false)
  if (!startIso) return 'Pilih tanggal mulai'
  if (f.preset === '30d') {
    const d = new Date(new Date(startIso).getTime() + 30 * 86400000)
    return `${fmt(startIso)} + 30 hari → ${fmt(d.toISOString())}`
  }
  if (f.preset === '1y') {
    const d = new Date(new Date(startIso).getTime())
    d.setUTCFullYear(d.getUTCFullYear() + 1)
    return `${fmt(startIso)} + 1 tahun → ${fmt(d.toISOString())}`
  }
  if (!f.endDate) return 'Pilih tanggal selesai (wajib utk Custom)'
  const endIso = parseWibDateToIso(f.endDate, true)
  if (endIso && new Date(endIso) <= new Date(startIso)) return '⚠️ Tanggal selesai harus SETELAH tanggal mulai'
  return `s/d ${fmt(endIso)} (23:59 WIB)`
})
async function saveValidity() {
  const tn = t.value
  if (!tn) return
  validitySaving.value = true
  validityError.value = ''
  try {
    const body = { preset: validityForm.value.preset }
    if (validityForm.value.startDate) body.startDate = parseWibDateToIso(validityForm.value.startDate, false)
    if (validityForm.value.preset === 'custom') {
      if (!validityForm.value.endDate) { validityError.value = 'endDate wajib untuk preset Custom'; validitySaving.value = false; return }
      body.endDate = parseWibDateToIso(validityForm.value.endDate, true)
    }
    await axios.put(`${API}/api/sa/tenants/${tn.id}/validity`, body)
    emit('refresh')
  } catch (e) {
    validityError.value = e.response?.data?.error || 'Gagal menyimpan masa aktif'
  } finally {
    validitySaving.value = false
  }
}

// ── v3.4 — Modal Edit Paket → section drawer ──
const planForm = ref({})
const planSaving = ref(false)
const planError = ref('')

function initPlanForm(tn) {
  planForm.value = {
    preset: '',
    maxAgents: tn.plan?.maxAgents ?? '',
    maxContacts: tn.plan?.maxContacts ?? '',
    maxNumbers: tn.plan?.maxNumbers ?? '',
    tkQuotaGb: tn.plan?.tkQuotaBytes != null ? +(tn.plan.tkQuotaBytes / 1024 ** 3).toFixed(2) : '',
    featAnalytics: !!tn.plan?.featAnalytics,
    featBlast: !!tn.plan?.featBlast,
    featMenuGateway: !!tn.plan?.featMenuGateway,
    featHistoryExport: !!tn.plan?.featHistoryExport,
    featCsat: !!tn.plan?.featCsat,
    featGdriveBackup: !!tn.plan?.featGdriveBackup,
    featApiAccess: !!tn.plan?.featApiAccess,
    featAiRouting: !!tn.plan?.featAiRouting, // v3.9.25
    featAiKnowledge: !!tn.plan?.featAiKnowledge, // v4.0.0 — CB-AI Knowledge Auto-Reply
  }
  planError.value = ''
}
async function savePlan() {
  const tn = t.value
  if (!tn) return
  planSaving.value = true
  planError.value = ''
  try {
    const body = {}
    if (planForm.value.preset) body.preset = planForm.value.preset
    const numOrNull = (v) => (v === '' || v === null || v === undefined ? null : Number(v))
    body.maxAgents = numOrNull(planForm.value.maxAgents)
    body.maxContacts = numOrNull(planForm.value.maxContacts)
    if (planForm.value.maxNumbers === '' || planForm.value.maxNumbers === null) body.maxNumbers = null
    else {
      const n = Number(planForm.value.maxNumbers)
      body.maxNumbers = Number.isFinite(n) ? Math.max(0, Math.min(3, Math.trunc(n))) : null
    }
    const gb = planForm.value.tkQuotaGb
    body.tkQuotaBytes = gb === '' || gb === null || gb === undefined ? null : Math.round(Number(gb) * 1024 ** 3)
    for (const f of FEATURE_DEFS) body[f.key] = !!planForm.value[f.key]
    await axios.put(`${API}/api/sa/tenants/${tn.id}/plan`, body)
    emit('refresh')
  } catch (e) {
    planError.value = e.response?.data?.error || 'Gagal menyimpan paket'
  } finally {
    planSaving.value = false
  }
}

// ── v3.9.25 — AI Hybrid toggle per-tenant (pindah dari baris) ──
const aiHybridBusy = ref(false)
async function toggleAiHybrid(tn) {
  if (aiHybridBusy.value) return
  const target = !tn.aiHybridEnabled
  const msg = target
    ? `Aktifkan AI Hybrid Routing utk tenant #${tn.id} ${tn.name}? Jawaban customer yang gak kena keyword akan dicocokkan AI ke opsi menu — balasan tetap pesan resmi tenant. Biaya metering otomatis.`
    : `Matikan AI Hybrid Routing utk tenant #${tn.id} ${tn.name}? Kembali ke perilaku lama (keyword saja → fallback antrean).`
  if (!window.confirm(msg)) return
  aiHybridBusy.value = true
  try {
    await axios.put(`${API}/api/menu-gateway?tenant=${tn.id}`, { aiHybrid: target })
    tn.aiHybridEnabled = target
    dError.value = ''
  } catch (e) {
    dError.value = e?.response?.status === 403
      ? (e.response?.data?.error || 'Plan tenant ini tidak mendukung AI Hybrid Routing — upgrade paket dulu.')
      : (e.response?.data?.error || 'Gagal toggle AI Hybrid')
  } finally {
    aiHybridBusy.value = false
  }
}

// ── + Admin (pindah dari inline per-baris) ──
const adminFormOpen = ref(false)
const adminUsername = ref('')
const adminPassword = ref('')
const creatingAdmin = ref(false)

function openAdminForm() {
  adminFormOpen.value = !adminFormOpen.value
  adminUsername.value = ''
  adminPassword.value = ''
}
function closeAdminForm() {
  adminFormOpen.value = false
}
async function createAdmin() {
  const tn = t.value
  if (!tn) return
  creatingAdmin.value = true
  dError.value = ''
  try {
    await axios.post(`${API}/api/sa/tenants/${tn.id}/admins`, {
      username: adminUsername.value.trim(),
      password: adminPassword.value,
    })
    adminFormOpen.value = false
    emit('refresh')
  } catch (e) {
    dError.value = e.response?.data?.error || 'Gagal membuat admin'
  } finally {
    creatingAdmin.value = false
  }
}

// ── Suspend/Resume dari dalam drawer (endpoint existing PUT /api/sa/tenants/:id) ──
function setStatus(tn, status) {
  emit('status-change', tn, status)
}

// ── v3.1.2 — Purge permanen (pindah dari inline per-baris) ──
const purgeFormOpen = ref(false)
const purgeConfirmName = ref('')
const purging = ref(false)
const purgeError = ref('')

function openPurgeForm() {
  purgeFormOpen.value = true
  purgeConfirmName.value = ''
  purgeError.value = ''
  adminFormOpen.value = false
}
function closePurgeForm() {
  purgeFormOpen.value = false
  purgeConfirmName.value = ''
  purgeError.value = ''
}
async function purgeTenant() {
  const tn = t.value
  if (!tn) return
  purging.value = true
  purgeError.value = ''
  try {
    const { data } = await axios.post(`${API}/api/sa/tenants/${tn.id}/purge`, {
      confirmName: purgeConfirmName.value,
    })
    const d = data.deleted || {}
    const parts = [`${d.users || 0} user`, `${d.chats || 0} chat`, `${d.messages || 0} pesan`]
    if (data.filesRemoved) parts.push(`${data.filesRemoved} file media`)
    dError.value = ''
    purgeFormOpen.value = false
    emit('deleted', `Tenant "${tn.name}" dihapus permanen — ${parts.join(', ')}.`)
  } catch (e) {
    purgeError.value = e.response?.data?.error || 'Gagal menghapus tenant'
  } finally {
    purging.value = false
  }
}

// ── v3.4 — Modal Branding → section drawer ──
const brandingForm = ref({ brandName: '', logoFile: null, logoPreview: false, logoPreviewUrl: '', removeLogo: false })
const brandingSaving = ref(false)
const brandingError = ref('')

function initBrandingForm(tn) {
  brandingForm.value = { brandName: tn.brandName || '', logoFile: null, logoPreview: false, logoPreviewUrl: '', removeLogo: false }
  brandingError.value = ''
}
function onLogoPicked(ev) {
  const file = ev.target?.files?.[0] || null
  brandingForm.value.logoFile = file
  brandingForm.value.logoPreview = !!file
  if (file) brandingForm.value.removeLogo = false
  if (brandingForm.value.logoPreviewUrl) URL.revokeObjectURL(brandingForm.value.logoPreviewUrl)
  brandingForm.value.logoPreviewUrl = file ? URL.createObjectURL(file) : ''
}
async function saveBranding() {
  const tn = t.value
  if (!tn) return
  brandingSaving.value = true
  brandingError.value = ''
  try {
    const fd = new FormData()
    fd.append('brandName', brandingForm.value.brandName.trim())
    if (brandingForm.value.logoFile) fd.append('logo', brandingForm.value.logoFile)
    if (!brandingForm.value.logoFile && brandingForm.value.removeLogo) fd.append('removeLogo', 'true')
    await axios.put(`${API}/api/sa/tenants/${tn.id}/branding`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    emit('refresh')
  } catch (e) {
    brandingError.value = e.response?.data?.error || 'Gagal menyimpan branding'
  } finally {
    brandingSaving.value = false
  }
}

// ── v3.4 — Backup download (pindah dari baris) ──
async function backupTenant(tn) {
  if (!window.confirm(`Buat backup tar.gz tenant "${tn.name}"? Arsip berisi semua data + file media tenant ini.`)) return
  backingUp.value = tn.id
  dError.value = ''
  try {
    const res = await axios.get(`${API}/api/sa/tenants/${tn.id}/backup`, { responseType: 'blob' })
    const cd = res.headers['content-disposition'] || ''
    const m = cd.match(/filename="?([^"]+)"?/)
    const fileName = m ? m[1] : `backup-tenant-${tn.id}.tar.gz`
    const url = URL.createObjectURL(res.data)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  } catch (e) {
    dError.value = e.response?.data?.error || 'Gagal membuat backup'
  } finally {
    backingUp.value = null
  }
}

// ── v3.4 — Impersonate (pindah dari baris) ──
async function impersonateTenant(tn) {
  if (!window.confirm(`Impersonate tenant "${tn.name}"? Tab baru akan dibuka dengan token view-as 30 menit.`)) return
  dError.value = ''
  try {
    const { data } = await axios.post(`${API}/api/sa/impersonate/${tn.id}`)
    const win = window.open('/', '_blank')
    if (win) {
      const payload = JSON.stringify({ token: data.token, user: { id: auth.user?.id, username: auth.user?.username, role: 'admin', impersonated: true } })
      const write = () => {
        try {
          win.sessionStorage.setItem('__impersonate_boot', payload)
        } catch {}
      }
      write()
      let tries = 0
      const iv = setInterval(() => {
        write()
        if (++tries >= 10) clearInterval(iv)
      }, 200)
    } else {
      dError.value = 'Popup diblokir browser — izinkan popup untuk impersonate'
    }
  } catch (e) {
    dError.value = e.response?.data?.error || 'Gagal impersonate'
  }
}

// ── open/close lifecycle ──
function initForms() {
  const tn = t.value
  if (!tn) return
  dError.value = ''
  initValidityForm(tn)
  initPlanForm(tn)
  initBrandingForm(tn)
  adminFormOpen.value = false
  purgeFormOpen.value = !!props.focusPurge
  purgeConfirmName.value = ''
  purgeError.value = ''
  apiKeysNewName.value = ''
  apiKeysNewScopes.value = 'send,read'
  apiKeysLoading.value = false
  apiKeysRows.value = []
  apiKeysRawKey.value = ''
  apiKeysWarn.value = ''
  apiKeysError.value = ''
  numbersForm.value = { slots: [], maxNumbers: 1, used: 0 }
  numbersSaving.value = false
  numbersError.value = ''
  newSlot.value = { slot: 1, label: '' }
  validitySaving.value = false
  planSaving.value = false
  brandingSaving.value = false
  purging.value = false
  aiHybridBusy.value = false
}
watch(
  () => [props.open, props.tenant?.id],
  ([open]) => {
    if (!open || !t.value) return
    initForms()
    fetchNumbers(t.value)
    fetchApiKeys(t.value)
  },
  { immediate: true }
)

function onKeydown(ev) {
  if (ev.key === 'Escape' && props.open) emit('close')
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div v-if="open && t">
    <div class="sa-drawer-backdrop" @click.self="emit('close')"></div>
    <aside class="sa-drawer" role="dialog" aria-modal="true" :aria-label="'Detail tenant ' + t.name">
      <!-- Header -->
      <div class="sa-drawer__header">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 flex-wrap">
            <h3 class="text-lg font-bold truncate" :style="{ color: 'var(--md-sys-color-on-surface)' }">#{{ t.id }} · {{ t.name }}</h3>
          </div>
          <div v-if="t.brandName" class="text-xs mt-0.5" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">{{ t.brandName }}</div>
          <div class="flex items-center gap-1 flex-wrap mt-2">
            <span class="sa-pill" :style="t.status === 'active' ? 'background:#dcfce7;color:#166534;' : 'background:#fee2e2;color:#991b1b;'">{{ t.status === 'active' ? 'active' : 'suspended' }}</span>
            <span class="sa-pill sa-pill--plan">{{ planPreset(t) }}</span>
            <span v-if="validityChip(t)" class="sa-pill" :style="validityChip(t).style">{{ validityChip(t).label }}</span>
            <span v-if="t.waStatus?.disabled" class="sa-pill" style="background:#e5e7eb;color:#374151;">WA off</span>
            <span v-else-if="t.waStatus?.connected" class="sa-pill" style="background:#dcfce7;color:#166534;">WA terhubung</span>
            <span v-else-if="t.waStatus?.qrNeeded" class="sa-pill" style="background:#fef9c3;color:#854d0e;">Menunggu scan QR</span>
            <span v-else class="sa-pill" style="background:#e5e7eb;color:#374151;">Terputus</span>
            <span v-if="t.slots && t.slots.length > 1" class="sa-pill" style="background:#dbeafe;color:#1e40af;">{{ t.slots.filter(s => s.status?.connected).length }}/{{ t.slots.length }} nomor · {{ t.waMode }}</span>
          </div>
        </div>
        <button class="sa-drawer__close" aria-label="Tutup detail" @click="emit('close')">✕</button>
      </div>

      <div class="sa-drawer__body">
        <!-- Error banner drawer -->
        <div v-if="dError" class="flex items-start gap-2 text-sm rounded-[var(--md-sys-shape-corner-s)] p-3 mb-4"
          style="background: var(--md-sys-color-error-container); color: var(--md-sys-color-on-error-container);"
          role="alert">
          <span aria-hidden="true">⚠️</span>
          <span>{{ dError }}</span>
        </div>

        <!-- ── Ringkasan ── -->
        <section class="sa-drawer__section">
          <h4 class="sa-drawer__title">Ringkasan</h4>
          <div class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
            {{ t.userCount }} user · {{ t.chatCount }} chat
            <template v-if="t.waPhone"> · WA +{{ t.waPhone }}</template>
          </div>
          <div v-if="t.slots && t.slots.length > 0" class="flex flex-wrap gap-1 mt-2">
            <span
              v-for="s in t.slots" :key="s.slot"
              class="sa-pill"
              :style="s.status?.connected ? 'background:#dcfce7;color:#166534;' : 'background:#e5e7eb;color:#374151;'"
              :title="s.waSessionDir || ''"
            >
              slot {{ s.slot }}{{ s.label ? ' · ' + s.label : '' }}{{ s.status?.connected ? ' ✓ +' + (s.status.phoneNumber || '') : ' ✕' }}
            </span>
          </div>
          <div v-if="t.usage" class="sa-usage mt-2">
            <span class="sa-meter" title="Agen">👤 {{ t.usage.agents }}/{{ t.plan?.maxAgents ?? '∞' }}</span>
            <span class="sa-meter">📇 {{ fmtNum(t.usage.contacts) }}/{{ t.plan?.maxContacts != null ? fmtNum(t.plan.maxContacts) : '∞' }}</span>
            <span class="sa-meter">🗂️ {{ fmtBytes(t.usage.tkBytes) }}/{{ t.plan?.tkQuotaBytes != null ? fmtBytes(t.plan.tkQuotaBytes) : '∞' }}</span>
          </div>
          <div v-if="tkPct(t) != null" class="mt-2">
            <div class="sa-tkbar"><div class="sa-tkbar__fill" :class="tkFillClass(t)" :style="{ width: tkPct(t) + '%' }"></div></div>
          </div>
          <div v-if="t.plan" class="flex flex-wrap gap-1 mt-2">
            <span v-for="f in activeFeatures(t)" :key="f.key" class="sa-pill sa-pill--feat">{{ f.label }}</span>
          </div>
        </section>

        <!-- ── Aksi cepat ── -->
        <section class="sa-drawer__section">
          <h4 class="sa-drawer__title">Aksi</h4>
          <div class="flex flex-wrap gap-2">
            <button
              v-if="t.status === 'active'"
              class="m3-btn m3-btn--tonal !min-h-[36px] !text-sm"
              @click="setStatus(t, 'suspended')"
            >💤 Suspend</button>
            <button
              v-else
              class="m3-btn m3-btn--tonal !min-h-[36px] !text-sm"
              @click="setStatus(t, 'active')"
            >⚡ Aktifkan</button>
            <button
              class="m3-btn m3-btn--tonal !min-h-[36px] !text-sm"
              :disabled="aiHybridBusy"
              :title="t.plan?.featAiRouting ? (t.aiHybridEnabled ? 'AI Hybrid ON — klik utk matikan' : 'AI Hybrid OFF — klik utk aktifkan') : 'Plan tenant ini belum mendukung AI Hybrid (Pro/Max)'"
              @click="toggleAiHybrid(t)"
            >{{ aiHybridBusy ? '…' : (t.aiHybridEnabled ? '🤖 AI Hybrid: ON' : '🤖 AI Hybrid: OFF') }}</button>
            <button class="m3-btn m3-btn--tonal !min-h-[36px] !text-sm" :disabled="backingUp === t.id" @click="backupTenant(t)">
              {{ backingUp === t.id ? 'Membuat…' : 'Backup' }}
            </button>
            <button class="m3-btn m3-btn--tonal !min-h-[36px] !text-sm" @click="impersonateTenant(t)">Impersonate</button>
            <button class="m3-btn m3-btn--tonal !min-h-[36px] !text-sm" @click="openAdminForm">+ Admin</button>
            <button
              class="m3-btn m3-btn--text !min-h-[36px] !text-sm"
              style="color: var(--md-sys-color-error);"
              @click="openPurgeForm"
            >⚠️ Hapus</button>
          </div>
        </section>

        <!-- ── + Admin form ── -->
        <section v-if="adminFormOpen" class="sa-drawer__section">
          <h4 class="sa-drawer__subtitle">Admin tenant</h4>
          <div class="sa-form">
            <M3TextField v-model="adminUsername" label="Username admin" type="text" />
            <M3TextField v-model="adminPassword" label="Password (min 6)" type="password" />
            <div class="flex gap-2 justify-end mt-2">
              <button class="m3-btn m3-btn--text !min-h-[40px]" @click="closeAdminForm">Batal</button>
              <button class="m3-btn m3-btn--filled !min-h-[40px]" :disabled="creatingAdmin" @click="createAdmin">
                {{ creatingAdmin ? 'Membuat…' : 'Buat Admin' }}
              </button>
            </div>
          </div>
        </section>

        <!-- ── Purge / Hapus permanen ── -->
        <section v-if="purgeFormOpen" class="sa-drawer__section">
          <div class="sa-form" style="border-left: 3px solid var(--md-sys-color-error);">
            <div class="text-sm font-semibold" :style="{ color: 'var(--md-sys-color-error)' }">
              ⚠️ Hapus permanen "{{ t.name }}"
            </div>
            <div class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
              Semua data tenant ini akan dihapus selamanya dan tidak bisa dikembalikan:
              {{ t.userCount }} user, {{ t.chatCount }} chat, semua pesan &amp; file media, kontak, tag,
              template, pengumuman, blast, config — semuanya.
            </div>
            <div class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
              Ketik <strong :style="{ color: 'var(--md-sys-color-on-surface)' }">{{ t.name }}</strong> persis untuk konfirmasi:
            </div>
            <M3TextField v-model="purgeConfirmName" :label="'Ketik: ' + t.name" type="text" />
            <div v-if="purgeError" class="flex items-start gap-2 text-sm rounded-[var(--md-sys-shape-corner-s)] p-3"
              style="background: var(--md-sys-color-error-container); color: var(--md-sys-color-on-error-container);"
              role="alert">
              <span aria-hidden="true">⚠️</span>
              <span>{{ purgeError }}</span>
            </div>
            <div class="flex gap-2 justify-end mt-2">
              <button class="m3-btn m3-btn--text !min-h-[40px]" @click="closePurgeForm">Batal</button>
              <button
                class="m3-btn m3-btn--filled !min-h-[40px]"
                style="background: var(--md-sys-color-error); color: var(--md-sys-color-on-error);"
                :disabled="purging || purgeConfirmName.trim() !== t.name"
                @click="purgeTenant"
              >
                {{ purging ? 'Menghapus…' : 'Hapus Permanen' }}
              </button>
            </div>
          </div>
        </section>

        <!-- ── Nomor WA (pindah dari modal) ── -->
        <section class="sa-drawer__section">
          <h4 class="sa-drawer__title">📍 Nomor WA</h4>
          <p class="text-sm mb-3" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
            Kuota paket: {{ numbersForm.used }}/{{ numbersForm.maxNumbers }} (hard cap 3). Kuota dihitung dari slot yang ADA (disconnect tetap ngitung).
          </p>
          <div class="space-y-2 mb-4">
            <div v-for="s in numbersForm.slots" :key="s.slot" class="flex items-center gap-2 p-2 rounded-lg" style="background: var(--md-sys-color-surface-container-high);">
              <span class="text-sm font-semibold min-w-[70px]">Slot {{ s.slot }}</span>
              <input v-model="s._labelDraft" type="text" placeholder="Label" maxlength="50" class="sa-select !py-1 flex-1 min-w-0" />
              <span class="sa-pill" :style="s.status?.connected ? 'background:#dcfce7;color:#166534;' : 'background:#e5e7eb;color:#374151;'">
                {{ s.status?.connected ? '+' + (s.status.phoneNumber || '?') : (s.status?.state || 'off') }}
              </span>
              <button class="m3-btn m3-btn--text !min-h-[32px] !text-xs" @click="saveSlotRow(s)">Simpan</button>
              <button
                class="m3-btn m3-btn--text !min-h-[32px] !text-xs"
                style="color: var(--md-sys-color-error);"
                :disabled="s.slot === 0"
                @click="deleteSlotRow(s)"
              >Hapus</button>
            </div>
            <div v-if="numbersForm.slots.length === 0" class="sa-empty">Belum ada slot terdaftar (slot-0 implisit jalan).</div>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <M3TextField v-model="newSlot.slot" label="Slot baru (1 / 2)" type="number" min="1" max="2" />
            <M3TextField v-model="newSlot.label" label="Label (opsional)" type="text" />
          </div>
          <div v-if="numbersError" class="text-sm mt-3" style="color: var(--md-sys-color-error);">{{ numbersError }}</div>
          <div class="flex gap-2 justify-end mt-4">
            <button class="m3-btn m3-btn--filled !min-h-[40px]" :disabled="numbersSaving" @click="addSlotRow">
              {{ numbersSaving ? 'Menyimpan…' : 'Tambah Slot' }}
            </button>
          </div>
        </section>

        <!-- ── Masa Aktif (pindah dari modal) ── -->
        <section class="sa-drawer__section">
          <h4 class="sa-drawer__title">🗓️ Masa Aktif</h4>
          <p class="text-sm mb-3" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
            Sekarang: {{ validityNowLabel(t) }}. Tenant expired tetap bisa login &amp; lihat data (read-only), tapi tidak bisa mengirim apa pun.
          </p>
          <label class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">Preset</label>
          <select v-model="validityForm.preset" class="m3-select sa-select">
            <option value="lifetime">Lifetime — tanpa batas</option>
            <option value="30d">30 Hari</option>
            <option value="1y">1 Tahun</option>
            <option value="custom">Custom — tentukan tanggal selesai</option>
          </select>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
            <div>
              <label class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">Mulai (default hari ini WIB)</label>
              <input v-model="validityForm.startDate" type="date" class="sa-select sa-date-input" />
            </div>
            <div v-if="validityForm.preset === 'custom'">
              <label class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">Selesai (wajib)</label>
              <input v-model="validityForm.endDate" type="date" class="sa-select sa-date-input" />
            </div>
          </div>
          <div class="mt-3 p-3 rounded-[var(--md-sys-shape-corner-m)]" style="background: var(--md-sys-color-surface-container-high);">
            <div class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">Pratinjau selesai:</div>
            <div class="font-semibold" :style="{ color: 'var(--md-sys-color-on-surface)' }">{{ validityPreviewText }}</div>
          </div>
          <div v-if="validityError" class="text-sm mt-3" style="color: var(--md-sys-color-error);">{{ validityError }}</div>
          <div class="flex gap-2 justify-end mt-4">
            <button class="m3-btn m3-btn--text !min-h-[40px]" @click="initValidityForm(t)">Batal</button>
            <button class="m3-btn m3-btn--filled !min-h-[40px]" :disabled="validitySaving" @click="saveValidity">
              {{ validitySaving ? 'Menyimpan…' : 'Simpan' }}
            </button>
          </div>
        </section>

        <!-- ── Edit Paket (pindah dari modal) ── -->
        <section class="sa-drawer__section">
          <h4 class="sa-drawer__title">📦 Paket &amp; Kuota</h4>
          <label class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">Terapkan preset</label>
          <select v-model="planForm.preset" class="m3-select sa-select">
            <option value="">— jangan ganti preset (custom override) —</option>
            <option value="lite">Lite</option>
            <option value="pro">Pro</option>
            <option value="max">Max</option>
          </select>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
            <M3TextField v-model="planForm.maxAgents" label="Max agen (kosong = ∞)" type="number" min="0" />
            <M3TextField v-model="planForm.maxContacts" label="Max kontak (kosong = ∞)" type="number" min="0" />
            <M3TextField v-model="planForm.maxNumbers" label="Maks. Nomor WA (kosong = 1, max 3)" type="number" min="0" max="3" />
            <M3TextField v-model="planForm.tkQuotaGb" label="Kuota TK (GB, kosong = ∞)" type="number" step="0.1" min="0" />
          </div>
          <div class="grid grid-cols-2 md:grid-cols-3 gap-3 mt-4">
            <label v-for="f in FEATURE_DEFS" :key="f.key" class="sa-feat-toggle">
              <M3Switch v-model="planForm[f.key]" />
              <span class="text-sm">{{ f.label }}</span>
            </label>
          </div>
          <div v-if="planError" class="text-sm mt-3" style="color: var(--md-sys-color-error);">{{ planError }}</div>
          <div class="flex gap-2 justify-end mt-4">
            <button class="m3-btn m3-btn--text !min-h-[40px]" @click="initPlanForm(t)">Batal</button>
            <button class="m3-btn m3-btn--filled !min-h-[40px]" :disabled="planSaving" @click="savePlan">
              {{ planSaving ? 'Menyimpan…' : 'Simpan Paket' }}
            </button>
          </div>
        </section>

        <!-- ── Branding (pindah dari modal) ── -->
        <section class="sa-drawer__section">
          <h4 class="sa-drawer__title">🎨 Branding</h4>
          <M3TextField v-model="brandingForm.brandName" label="Brand name (2-50 char, kosong = ChatBareng)" type="text" />
          <div class="mt-3">
            <label class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">Logo (PNG/JPEG/WEBP, maks 1 MB)</label>
            <div class="text-xs mt-1 leading-snug" style="opacity: .75;">
              Disarankan: rasio 1:1 (kotak) s/d 4:1 (memanjang), tinggi gambar 64–256px biar tajam.
              Logo dirender ±26px di header; PNG transparan paling rapi.
            </div>
            <input type="file" accept="image/png,image/jpeg,image/webp" class="sa-file-input" @change="onLogoPicked" />
            <div v-if="brandingForm.logoPreview" class="mt-2 flex items-center gap-3">
              <img :src="brandingForm.logoPreviewUrl" alt="preview logo" style="max-height: 48px; max-width: 160px; border-radius: 8px;" />
            </div>
            <div v-if="t.logoPath && !brandingForm.logoFile && !brandingForm.removeLogo" class="mt-2 flex items-center gap-2">
              <span class="text-xs" style="opacity: .75;">Logo terpasang ✓</span>
              <button
                class="m3-btn m3-btn--text !min-h-[32px] !text-xs"
                style="color: var(--md-sys-color-error);"
                @click="brandingForm.removeLogo = true"
              >Hapus Logo</button>
            </div>
            <div v-else-if="brandingForm.removeLogo" class="mt-2 text-xs" style="color: var(--md-sys-color-error);">
              Logo akan dihapus saat Simpan Branding. <button class="underline" @click="brandingForm.removeLogo = false">Batal</button>
            </div>
          </div>
          <div class="mt-4 p-3 rounded-[var(--md-sys-shape-corner-m)]" style="background: var(--md-sys-color-surface-container-high);">
            <div class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">Pratinjau header:</div>
            <div class="flex items-baseline gap-2 mt-1">
              <span class="font-bold" :style="{ color: 'var(--md-sys-color-on-surface)' }">{{ brandingForm.brandName || 'ChatBareng' }}</span>
              <span v-if="brandingForm.brandName" class="text-xs" style="opacity: .6;">by ChatBareng</span>
            </div>
          </div>
          <div v-if="brandingError" class="text-sm mt-3" style="color: var(--md-sys-color-error);">{{ brandingError }}</div>
          <div class="flex gap-2 justify-end mt-4">
            <button class="m3-btn m3-btn--text !min-h-[40px]" @click="initBrandingForm(t)">Batal</button>
            <button class="m3-btn m3-btn--filled !min-h-[40px]" :disabled="brandingSaving" @click="saveBranding">
              {{ brandingSaving ? 'Menyimpan…' : 'Simpan Branding' }}
            </button>
          </div>
        </section>

        <!-- ── API Keys (pindah dari modal; v3.9.13 helper, per-tenant) ── -->
        <section class="sa-drawer__section">
          <h4 class="sa-drawer__title">🔑 API Keys</h4>
          <p class="text-sm mb-3" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
            Public API v1 (locked v3.9.13). Raw key hanya tampil SEKALI saat dibuat.
          </p>
          <div v-if="apiKeysRawKey" class="sa-form mb-3" style="background: var(--md-sys-color-primary-container);">
            <div class="text-sm font-semibold" style="color: var(--md-sys-color-on-primary-container);">🔑 Raw key (salin sekarang — tidak ditampilkan lagi):</div>
            <code class="text-xs break-all" style="color: var(--md-sys-color-on-primary-container);">{{ apiKeysRawKey }}</code>
            <div v-if="apiKeysWarn" class="text-xs" style="color: var(--md-sys-color-on-primary-container);">{{ apiKeysWarn }}</div>
            <div><button class="m3-btn m3-btn--tonal !min-h-[32px] !text-xs" @click="copyRawKey">Copy</button></div>
          </div>
          <div v-if="apiKeysLoading" class="sa-empty">Memuat…</div>
          <div v-else-if="apiKeysRows.length === 0" class="sa-empty">Belum ada API key.</div>
          <div v-else class="space-y-2 mb-4">
            <div v-for="k in apiKeysRows" :key="k.id" class="flex items-center gap-2 p-2 rounded-lg flex-wrap" style="background: var(--md-sys-color-surface-container-high);">
              <span class="text-sm font-semibold">{{ k.name }}</span>
              <span class="sa-pill" style="background:#dbeafe;color:#1e40af;">{{ k.scopes }}</span>
              <span class="sa-pill" :style="k.revokedAt ? 'background:#fee2e2;color:#991b1b;' : 'background:#dcfce7;color:#166534;'">
                {{ k.revokedAt ? 'revoked' : 'aktif' }}
              </span>
              <span class="text-xs ml-auto" style="opacity:.7;">{{ k.ratePerMin }}/mnt</span>
              <button v-if="!k.revokedAt" class="m3-btn m3-btn--text !min-h-[32px] !text-xs" style="color: var(--md-sys-color-error);" @click="revokeApiKey(k)">Revoke</button>
            </div>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <M3TextField v-model="apiKeysNewName" label="Nama key" type="text" />
            <M3TextField v-model="apiKeysNewScopes" label="Scopes (send,read)" type="text" />
          </div>
          <div v-if="apiKeysError" class="text-sm mt-3" style="color: var(--md-sys-color-error);">{{ apiKeysError }}</div>
          <div class="flex gap-2 justify-end mt-4">
            <button class="m3-btn m3-btn--filled !min-h-[40px]" :disabled="apiKeysCreating" @click="createApiKey(t)">
              {{ apiKeysCreating ? 'Membuat…' : '+ Buat Key' }}
            </button>
          </div>
        </section>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.sa-drawer-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 60;
}
.sa-drawer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 540px;
  max-width: 94vw;
  background: var(--md-sys-color-surface-container-low);
  box-shadow: var(--md-sys-elevation-3);
  z-index: 61;
  display: flex;
  flex-direction: column;
  animation: sa-drawer-in 0.26s cubic-bezier(0.2, 0, 0, 1);
}
@keyframes sa-drawer-in {
  from { transform: translateX(100%); }
  to { transform: translateX(0); }
}
@media (max-width: 767px) {
  .sa-drawer {
    width: 100vw;
    max-width: 100vw;
  }
}
.sa-drawer__header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 20px;
  background: var(--md-sys-color-surface-container);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}
.sa-drawer__close {
  flex: none;
  min-height: 36px;
  min-width: 36px;
  border-radius: 999px;
  border: 1px solid var(--md-sys-color-outline-variant);
  background: transparent;
  color: var(--md-sys-color-on-surface-variant);
  font-size: 1rem;
  cursor: pointer;
}
.sa-drawer__close:hover {
  background: var(--md-sys-color-surface-container-high);
  color: var(--md-sys-color-on-surface);
}
.sa-drawer__body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px 40px;
}
.sa-drawer__title {
  font-size: 1rem;
  font-weight: 700;
  margin-bottom: 8px;
  color: var(--md-sys-color-on-surface);
}
.sa-drawer__section + .sa-drawer__section {
  margin-top: 26px;
  padding-top: 22px;
  border-top: 1px solid var(--md-sys-color-outline-variant);
}
.sa-form {
  background: var(--md-sys-color-surface-container-high);
  border-radius: var(--md-sys-shape-corner-m);
  padding: 16px;
  margin-bottom: 16px;
  display: grid;
  gap: 8px;
}
.sa-pill {
  font-size: 0.72rem;
  font-weight: 600;
  border-radius: 999px;
  padding: 2px 10px;
  white-space: nowrap;
}
.sa-pill--plan { background: #dbeafe; color: #1e40af; }
.sa-pill--feat { background: #dcfce7; color: #166534; font-size: 0.68rem; }
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
.sa-date-input {
  margin-top: 4px;
  min-height: 44px;
}
.sa-usage { display: flex; flex-wrap: wrap; gap: 8px; }
.sa-meter {
  font-size: 0.78rem;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--md-sys-color-surface-container);
  color: var(--md-sys-color-on-surface-variant);
  white-space: nowrap;
}
/* TanganKanan mini progress bar (CSS murni, v4.1.7) */
.sa-tkbar {
  height: 6px;
  border-radius: 999px;
  background: var(--md-sys-color-surface-container-highest);
  overflow: hidden;
  min-width: 90px;
}
.sa-tkbar__fill {
  height: 100%;
  border-radius: 999px;
  background: var(--md-sys-color-primary);
}
.sa-tkbar__fill--warn { background: var(--md-sys-color-warning); }
.sa-tkbar__fill--over { background: var(--md-sys-color-error); }
.sa-feat-toggle { display: flex; align-items: center; gap: 8px; }
.sa-file-input { margin-top: 6px; font-size: 0.85rem; }
</style>