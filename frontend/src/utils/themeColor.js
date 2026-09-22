/**
 * v0.12.7 — Sinkronisasi meta theme-color (bugfix: status bar Android tidak ikut accent).
 * Android mengambil warna status bar PWA dari theme_color manifest (dipakai saat app
 * TERTUTUP/launcher) + <meta name="theme-color"> (dipakai saat app JALAN).
 * Manifest dinamis di-handle server (/manifest.webmanifest); meta runtime di sini:
 * - effective dark → #141218 (surface dark, biar nyambung dengan status bar sistem);
 *   effective light → accentSeed
 * - update TANPA reload (dipanggil setelah PUT sukses di AdminAppearance)
 * v3.1 — param `seed` opsional: kalau ada (tema tenant post-login), pakai langsung
 * TANPA fetch /api/appearance/public (endpoint itu kini netral pre-login — seed
 * tenant tidak pernah tersedia di sana tanpa ?tenant=).
 */
const META_DARK = '#141218'
const FALLBACK_SEED = '#6D28D9'

function getMeta() {
  return document.querySelector('meta[name="theme-color"]')
}

export async function syncThemeColorMeta(seed) {
  try {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark'
      || (!document.documentElement.getAttribute('data-theme')
        && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
    let accent = null
    if (seed && /^#[0-9a-fA-F]{6}$/.test(seed)) {
      // v3.1 — seed tenant dikirim caller (auth GET /api/appearance); tanpa fetch publik
      accent = seed.toUpperCase()
    } else {
      // Pre-login / tanpa seed: endpoint publik = netral platform (v3.1)
      try {
        const r = await fetch('/api/appearance/public')
        if (r.ok) {
          const j = await r.json()
          accent = (j && j.accentSeed) || null
        }
      } catch (e) { /* fallback di bawah */ }
    }
    const color = dark ? META_DARK : (accent || FALLBACK_SEED)
    const meta = getMeta()
    if (meta && color) meta.setAttribute('content', color)
    return color
  } catch (e) {
    return null
  }
}