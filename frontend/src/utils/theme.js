/**
 * v0.9.0 — Theme manager (3 mode: light/dark/system, default system).
 * Key localStorage: themeMode. Dipakai init script anti-FOUC (index.html, inline)
 * dan ThemeToggle (Pengaturan + top bar).
 *
 * Pola: <html data-theme="dark"> HANYA saat tema efektif = dark.
 * Mode "system" mengikuti matchMedia('(prefers-color-scheme: dark)') live.
 */

const STORAGE_KEY = 'themeMode'

function getStoredMode() {
  try {
    const m = localStorage.getItem(STORAGE_KEY)
    return (m === 'light' || m === 'dark' || m === 'system') ? m : 'system'
  } catch { return 'system' }
}

function systemPrefersDark() {
  return typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false
}

export function getEffectiveTheme() {
  const mode = getStoredMode()
  return mode === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : mode
}

export function applyTheme(mode) {
  const effective = mode === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : mode
  const root = document.documentElement
  if (effective === 'dark') root.setAttribute('data-theme', 'dark')
  else root.removeAttribute('data-theme')
  try { localStorage.setItem(STORAGE_KEY, mode) } catch {}
  return effective
}

export function getThemeMode() {
  return getStoredMode()
}

/** Live listener: dipanggil sekali di App.vue mount. Returns cleanup fn. */
export function watchSystemTheme() {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {}
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const handler = () => {
    if (getStoredMode() === 'system') applyTheme('system')
  }
  if (mq.addEventListener) mq.addEventListener('change', handler)
  else if (mq.addListener) mq.addListener(handler)
  return () => {
    if (mq.removeEventListener) mq.removeEventListener('change', handler)
    else if (mq.removeListener) mq.removeListener(handler)
  }
}