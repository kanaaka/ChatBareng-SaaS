// v3.4 — Branding per-tenant di frontend (spec §8): state + helper.
// brandName + logoUrl dari GET /auth/me (payload.user.branding / payload.user.plan).
// Suffix " by ChatBareng" = teks kecil muted HARDCODED di sini (tidak disimpan DB).
// brandName kosong → tampil "ChatBareng" polos. Login page TETAP ChatBareng
// (belum ada context tenant sebelum login — keputusan owner).
import axios from 'axios'

const API = import.meta.env.VITE_API_URL || ''

// Global reactive-ish state (module singleton; dibaca komponen via getters di bawah)
const state = {
  brandName: '',
  logoUrl: null,
  features: null, // { analytics, blast, menuGateway, historyExport, csat, gdriveBackup }
  planUsage: null, // { maxAgents, maxContacts, tkQuotaBytes, usage: {...} } | null
}

export function getBranding() {
  return state
}

/** Judul dokumen: "<brand> — by ChatBareng" / "ChatBareng". */
export function applyDocumentTitle(brandName) {
  document.title = brandName ? `${brandName} — by ChatBareng` : 'ChatBareng'
}

/**
 * Fetch /auth/me lalu isi state branding + plan.features.
 * super_admin tanpa tenant → payload tanpa branding/plan → reset ke netral.
 */
export async function loadBrandingAndPlan() {
  try {
    const res = await axios.get(`${API}/api/auth/me`)
    const u = res.data?.user || {}
    state.brandName = u.branding?.brandName || ''
    state.logoUrl = u.branding?.logoUrl || null
    state.features = u.plan?.features || null
    state.planUsage = u.plan || null
  } catch {
    state.brandName = ''
    state.logoUrl = null
    state.features = null
    state.planUsage = null
  }
  applyDocumentTitle(state.brandName)
  return state
}

export function clearBranding() {
  state.brandName = ''
  state.logoUrl = null
  state.features = null
  state.planUsage = null
  applyDocumentTitle('')
}

/** Cek fitur ON/OFF (null plan → base app, base selalu ON). */
export function hasFeature(key) {
  if (!state.features) return true // super_admin impersonasi tanpa plan / fallback
  return !!state.features[key]
}