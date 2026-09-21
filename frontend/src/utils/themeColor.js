/**
 * v0.12.7 — Sinkronisasi meta theme-color (bugfix: status bar Android tidak ikut accent).
 * Android mengambil warna status bar PWA dari theme_color manifest (dipakai saat app
 * TERTUTUP/launcher) + <meta name="theme-color"> (dipakai saat app JALAN).
 * Manifest dinamis di-handle server (/manifest.webmanifest); meta runtime di sini:
 * - fetch GET /api/appearance/public (no-auth) → seed aktif
 * - effective dark → #141218 (surface dark, biar nyambung dengan status bar sistem);
 *   effective light → accentSeed
 * - update TANPA reload (dipanggil setelah PUT sukses di AdminAppearance)
 */
const META_DARK = '#141218'
const FALLBACK_SEED = '#6D28D9'

function getMeta() {
  return document.querySelector('meta[name="theme-color"]')
}

export async function syncThemeColorMeta() {
  try {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark'
      || (!document.documentElement.getAttribute('data-theme')
        && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
    let seed = null
    try {
      const r = await fetch('/api/appearance/public')
      if (r.ok) {
        const j = await r.json()
        seed = (j && j.accentSeed) || null
      }
    } catch (e) { /* fallback di bawah */ }
    const color = dark ? META_DARK : (seed || FALLBACK_SEED)
    const meta = getMeta()
    if (meta && color) meta.setAttribute('content', color)
    return color
  } catch (e) {
    return null
  }
}