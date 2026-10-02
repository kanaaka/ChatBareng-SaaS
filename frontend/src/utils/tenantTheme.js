/**
 * v3.1 — Tenant theme runtime (post-login).
 *
 * Tema aksen per-tenant di-apply RUNTIME di sisi klien: GET /api/appearance (auth,
 * tenant resolve dari JWT — tenantId tidak pernah bocor) → themeCss dari server
 * di-inject/replace pada <style id="tenant-theme"> di <head>.
 *
 * Cascade: <style> ini di-append SETELAH <link rel="stylesheet" href="/theme.css">
 * yang di-sisipkan init script index.html → specificity sama, yang terakhir menang.
 * Pre-login style tetap netral (v3.1: /theme.css tanpa ?tenant= = kosong).
 *
 * Semua user tenant (admin/cs/relay) boleh apply — tema tampil buat seluruh tenant.
 * super_admin (tanpa tenant) tidak memanggil ini (dashboard platform, netral).
 */
import axios from 'axios'
import { syncThemeColorMeta } from './themeColor'

const API = import.meta.env.VITE_API_URL || ''
const STYLE_ID = 'tenant-theme'

/**
 * Apply tema tenant dari CSS string (variabel --md-sys-color-* dari server).
 * Idempotent: dipanggil 2x hanya mengganti isi style yang sama.
 * @returns {boolean} true kalau style terpasang
 */
export function applyTenantThemeCss(themeCss) {
  if (typeof document === 'undefined') return false
  if (!themeCss || !themeCss.trim()) return false
  let el = document.getElementById(STYLE_ID)
  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ID
    document.head.appendChild(el)
  }
  el.textContent = themeCss
  return true
}

/**
 * Hapus tema tenant runtime (logout / balik ke permukaan netral).
 */
export function clearTenantTheme() {
  const el = document.getElementById(STYLE_ID)
  if (el) el.remove()
}

/**
 * Fetch config appearance tenant aktif (via JWT) lalu apply + sinkron meta
 * theme-color. Aman dipanggil berkali-kali (bootstrap + after-login + after-save).
 * @returns {Promise<{accentSeed: string, applied: boolean}|null>}
 */
export async function loadAndApplyTenantTheme() {
  try {
    const res = await axios.get(`${API}/api/appearance`)
    const seed = res.data?.config?.accentSeed || null
    const css = res.data?.themeCss || ''
    const applied = applyTenantThemeCss(css)
    if (seed) syncThemeColorMeta(seed) // light mode = seed tenant; dark tetap META_DARK
    return { accentSeed: seed, applied }
  } catch (e) {
    // 403 utk super_admin tanpa ?tenant= (requireTenant) = netral, bukan error app
    console.warn('[tenantTheme] apply dilewati:', e?.response?.status || e?.message)
    return null
  }
}