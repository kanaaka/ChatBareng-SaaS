// v0.14.0 — Manajemen Grup: API client + peta error ramah (spec §3/§5/§6)
// Error backend baku → pesan Indonesia ramah via ToastStack (BUKAN error mentah):
//  503 WA_BELUM_TERHUBUNG · 422 BOT_BUKAN_ADMIN · 403 FORBIDDEN · 400 VALIDATION.
import axios from 'axios'

const API = import.meta.env.VITE_API_URL || ''

export function friendlyGroupError(e, fallback = 'Terjadi kesalahan. Coba lagi.') {
  const status = e?.response?.status
  const code = e?.response?.data?.code
  const raw = e?.response?.data?.error || null
  if (code === 'WA_BELUM_TERHUBUNG' || status === 503) {
    return 'WhatsApp belum terhubung. Hubungkan dulu di Admin → WhatsApp, lalu coba lagi.'
  }
  if (code === 'BOT_BUKAN_ADMIN' || status === 422) {
    return raw || 'Bot bukan admin di grup ini — aksi ditolak oleh WhatsApp.'
  }
  if (status === 403) return raw || 'Kamu tidak memiliki akses untuk aksi ini.'
  if (status === 404) return raw || 'Grup tidak ditemukan.'
  if (status === 400) return raw || fallback
  return raw || fallback
}

/** Instance axios dgn header auth; error HTTP → Error ber-pesan ramah (id). */
export function groupsClient(token) {
  const client = axios.create({
    baseURL: API,
    headers: { Authorization: `Bearer ${token}` },
  })
  client.interceptors.response.use(
    r => r,
    e => Promise.reject(new Error(friendlyGroupError(e))),
  )
  return client
}