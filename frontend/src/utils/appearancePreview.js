/**
 * v0.9.0 — Preview tone generator untuk AdminAppearance (client-side ringan).
 * Bukan pengganti server generator (material-color-utilities) — cukup akurat
 * untuk preview mini light/dark sebelum admin menekan "Terapkan".
 */
function hexToRgb(hex) {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  const n = parseInt(h, 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

function rgbToHex({ r, g, b }) {
  const f = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${f(r)}${f(g)}${f(b)}`.toUpperCase()
}

function mix(hex, other, ratio) {
  const a = hexToRgb(hex)
  const b = hexToRgb(other)
  return rgbToHex({
    r: a.r + (b.r - a.r) * ratio,
    g: a.g + (b.g - a.g) * ratio,
    b: a.b + (b.b - a.b) * ratio,
  })
}

export function buildPreview(seedHex, dark) {
  if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(seedHex || '')) seedHex = '#6D28D9'
  if (dark) {
    return {
      surface: '#141218',
      primary: mix(seedHex, '#ffffff', 0.55),
      onPrimary: mix(seedHex, '#000000', 0.65),
      primaryContainer: mix(seedHex, '#000000', 0.45),
      onPrimaryContainer: mix(seedHex, '#ffffff', 0.8),
      outline: '#948f99',
    }
  }
  return {
    surface: '#ffffff',
    primary: seedHex,
    onPrimary: '#ffffff',
    primaryContainer: mix(seedHex, '#ffffff', 0.85),
    onPrimaryContainer: mix(seedHex, '#000000', 0.7),
    outline: '#79747e',
  }
}