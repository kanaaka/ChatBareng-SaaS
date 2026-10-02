// v3.4 — Axios response interceptor: 403 dari feature middleware (plan per-tenant)
// → toast pesan backend apa adanya (JANGAN swallow, spec §8).
// Skema: 403 + pesan "tidak tersedia di paket Anda" → toast + redirect ke '/' bila
// sedang di halaman fitur yang di-gate (route guard manual handle deep-link).
import axios from 'axios'
import { useToastStore } from '../stores/toast'
import router from '../router'

const API = import.meta.env.VITE_API_URL || ''
const client = axios.create({ baseURL: API })

client.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

client.interceptors.response.use(
  (res) => res,
  (err) => {
    const status = err.response?.status
    const msg = err.response?.data?.error || ''
    if (status === 403 && typeof msg === 'string' && msg.includes('tidak tersedia di paket Anda')) {
      try {
        const toast = useToastStore()
        toast.show({ icon: '🔒', title: 'Fitur terkunci', message: msg, timeout: 6000 })
      } catch {}
      // deep-link ke halaman fitur yang di-gate → balik dashboard
      const path = window.location.pathname
      const gated = ['/blast', '/admin/analytics', '/admin/menu-gateway', '/admin/csat', '/admin/backup', '/admin/history', '/announcements']
      if (gated.some((g) => path.startsWith(g))) {
        router.push('/')
      }
    }
    return Promise.reject(err)
  }
)

export default client