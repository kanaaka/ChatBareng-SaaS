// v0.4.0 — Web Push client helper (subscribe/unsubscribe ke backend VAPID)
const API = import.meta.env.VITE_API_URL || ''
import axios from 'axios'

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}

function pushSupported() {
  return typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
}

async function isSubscribed() {
  if (!pushSupported()) return false
  try {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js')
    if (!reg) return false
    const sub = await reg.pushManager.getSubscription()
    return !!sub
  } catch {
    return false
  }
}

// Register SW + minta izin + subscribe push + kirim subscription ke backend.
// Return: { ok, reason } — reason: 'unsupported' | 'denied' | 'error'
async function initPush() {
  if (!pushSupported()) return { ok: false, reason: 'unsupported' }

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return { ok: false, reason: 'denied' }

  try {
    const reg = await navigator.serviceWorker.register('/sw.js')
    await navigator.serviceWorker.ready

    const res = await axios.get(`${API}/api/push/public-key`)
    const publicKey = res.data?.publicKey
    if (!publicKey) return { ok: false, reason: 'error' }

    let sub = await reg.pushManager.getSubscription()
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      })
    }

    const raw = sub.toJSON()
    if (!raw.endpoint || !raw.keys?.p256dh || !raw.keys?.auth) {
      return { ok: false, reason: 'error' }
    }

    await axios.post(`${API}/api/push/subscribe`, {
      endpoint: raw.endpoint,
      keys: { p256dh: raw.keys.p256dh, auth: raw.keys.auth },
    })

    localStorage.setItem('pushSubscribed', 'true')
    return { ok: true }
  } catch (e) {
    console.error('initPush error:', e)
    // 404/410 dari pushManager.subscribe → subscription invalid, bersihkan
    try {
      const reg = await navigator.serviceWorker.getRegistration('/sw.js')
      const sub = await reg?.pushManager.getSubscription()
      if (sub) await sub.unsubscribe()
    } catch { /* ignore */ }
    localStorage.removeItem('pushSubscribed')
    return { ok: false, reason: 'error' }
  }
}

// Unsubscribe dari browser + hapus di backend
async function disablePush() {
  try {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js')
    const sub = await reg?.pushManager.getSubscription()
    if (sub) {
      const raw = sub.toJSON()
      await sub.unsubscribe()
      if (raw.endpoint) {
        try {
          await axios.post(`${API}/api/push/unsubscribe`, { endpoint: raw.endpoint })
        } catch { /* backend mungkin sudah bersih */ }
      }
    }
  } catch (e) {
    console.error('disablePush error:', e)
  } finally {
    localStorage.removeItem('pushSubscribed')
  }
  return { ok: true }
}

export { pushSupported, isSubscribed, initPush, disablePush, urlBase64ToUint8Array }