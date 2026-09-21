/** @type {import('tailwindcss').Config} */
// v0.9.0 — warna/shadow/radius membaca CSS variables (token M3 di tokens.css),
// utility layout tetap dipakai. Hindari hardcode hex di komponen (spec §6).
export default {
  content: [
    './index.html',
    './src/**/*.{vue,js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Legacy WA colors (v0.9.1 hotfix — pemetaan hilang saat revamp bikin bg-wa-dark dkk jadi kelas mati: tombol transparan, teks putih di bg terang = invisible)
        wa: {
          dark: 'var(--wa-legacy-dark)',
          green: 'var(--wa-legacy-green)',
          light: 'var(--wa-legacy-light)',
        },
        // Token M3 (utama — dipakai komponen baru)
        md: {
          primary: 'var(--md-sys-color-primary)',
          'on-primary': 'var(--md-sys-color-on-primary)',
          'primary-container': 'var(--md-sys-color-primary-container)',
          'on-primary-container': 'var(--md-sys-color-on-primary-container)',
          secondary: 'var(--md-sys-color-secondary)',
          'secondary-container': 'var(--md-sys-color-secondary-container)',
          'on-secondary-container': 'var(--md-sys-color-on-secondary-container)',
          tertiary: 'var(--md-sys-color-tertiary)',
          'tertiary-container': 'var(--md-sys-color-tertiary-container)',
          error: 'var(--md-sys-color-error)',
          'on-error': 'var(--md-sys-color-on-error)',
          'error-container': 'var(--md-sys-color-error-container)',
          success: 'var(--md-sys-color-success)',
          'success-container': 'var(--md-sys-color-success-container)',
          warning: 'var(--md-sys-color-warning)',
          'warning-container': 'var(--md-sys-color-warning-container)',
          info: 'var(--md-sys-color-info)',
          'info-container': 'var(--md-sys-color-info-container)',
          surface: 'var(--md-sys-color-surface)',
          'surface-variant': 'var(--md-sys-color-surface-variant)',
          'surface-container-lowest': 'var(--md-sys-color-surface-container-lowest)',
          'surface-container-low': 'var(--md-sys-color-surface-container-low)',
          'surface-container': 'var(--md-sys-color-surface-container)',
          'surface-container-high': 'var(--md-sys-color-surface-container-high)',
          'surface-container-highest': 'var(--md-sys-color-surface-container-highest)',
          'on-surface': 'var(--md-sys-color-on-surface)',
          'on-surface-variant': 'var(--md-sys-color-on-surface-variant)',
          outline: 'var(--md-sys-color-outline)',
          'outline-variant': 'var(--md-sys-color-outline-variant)',
          'inverse-surface': 'var(--md-sys-color-inverse-surface)',
          'inverse-on-surface': 'var(--md-sys-color-inverse-on-surface)',
        },
        // Legacy WA palette — dipertahankan agar kelas lama tidak breaking,
        // nilainya mengarah ke token M3 (lihat juga alias di components.css).
        wa: {
          green: 'var(--md-sys-color-primary)',
          dark: 'var(--md-sys-color-surface-container-lowest)',
          light: 'var(--md-sys-color-secondary-container)',
        },
      },
      borderRadius: {
        'md-s': 'var(--md-sys-shape-corner-s)',
        'md-m': 'var(--md-sys-shape-corner-m)',
        'md-l': 'var(--md-sys-shape-corner-l)',
        'md-xl': 'var(--md-sys-shape-corner-xl)',
      },
      boxShadow: {
        'md-1': 'var(--md-sys-elevation-1)',
        'md-2': 'var(--md-sys-elevation-2)',
        'md-3': 'var(--md-sys-elevation-3)',
      },
      fontFamily: {
        jakarta: ['Roboto', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Helvetica Neue', 'Arial', 'sans-serif'],
      },
    },
  },
  plugins: [],
}