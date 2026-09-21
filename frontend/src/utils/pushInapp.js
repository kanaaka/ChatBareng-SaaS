/**
 * v0.12.7 — Push in-app toast (bugfix: notifikasi lenyap saat app VISIBLE).
 * sw.js dulu return tanpa notif kalau ada jendela visible — padahal in-app toast
 * hanya ada untuk kind 'message' di Dashboard. Kind lain (test, dst) lenyap total.
 *
 * Solusi global (bukan per-halaman): listener SEKALI di App.vue — SW kirim
 * { type: 'push-inapp', payload } ke semua window client visible, di sini
 * ditampilkan sebagai toast (pattern store toast yang sama: title/message/onClick).
 * Returns cleanup fn (pola watchSystemTheme).
 */
import { useToastStore } from '../stores/toast'

export function initPushInAppListener() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return () => {}
  const toast = useToastStore()
  const handler = (event) => {
    const msg = event && event.data
    if (!msg || msg.type !== 'push-inapp') return
    const p = msg.payload || {}
    // v0.13.4 — SKIP kind 'message': jalur socket (Dashboard.onNewMessage) sudah
    // menampilkan toast utk chat-mine saat app visible — toast dari SW di sini
    // mendobel (invariant: tidak ada double toast utk satu kejadian yang sama).
    // Kind lain ('test', 'announcement', dst) tetap jalan (alasan awal v0.12.7).
    if (p.kind === 'message') return
    toast.show({
      icon: p.kind === 'test' ? '🔔' : '💬',
      title: p.title || 'ChatBareng',
      message: p.body || '',
      onClick: () => {
        const url = p.url || '/'
        if (url && url !== '/' && window.location.pathname + window.location.search !== url) {
          window.location.href = url
        }
      },
    })
  }
  navigator.serviceWorker.addEventListener('message', handler)
  return () => navigator.serviceWorker.removeEventListener('message', handler)
}