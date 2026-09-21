import { defineStore } from 'pinia'
import axios from 'axios'

const API = import.meta.env.VITE_API_URL || ''

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: localStorage.getItem('token') || '',
    user: JSON.parse(localStorage.getItem('user') || 'null'),
    // v3.0 — daftar tenant (hanya terisi utk login super_admin)
    tenants: JSON.parse(localStorage.getItem('tenants') || 'null'),
  }),
  getters: {
    isLoggedIn: (state) => !!state.token,
    isAdmin: (state) => state.user?.role === 'admin',
    // v3.0 — super_admin = owner platform (tanpa tenant)
    isSuperAdmin: (state) => state.user?.role === 'super_admin',
    // v0.5.0 — role Cabang (internal: relay). Tidak bisa take antrean;
    // hanya menerima chat lewat transfer.
    isRelay: (state) => state.user?.role === 'relay',
    canTake: (state) => state.user?.role === 'admin' || state.user?.role === 'cs',
  },
  actions: {
    async login(username, password) {
      const res = await axios.post(`${API}/api/auth/login`, { username, password })
      this.token = res.data.token
      this.user = res.data.user
      this.tenants = res.data.tenants || null // super_admin saja
      localStorage.setItem('token', this.token)
      localStorage.setItem('user', JSON.stringify(this.user))
      localStorage.setItem('tenants', JSON.stringify(this.tenants))
      axios.defaults.headers.common['Authorization'] = `Bearer ${this.token}`
    },
    // v3.0 — impersonasi view-as tenant (short-lived JWT role admin tenant)
    async impersonate(tenantId) {
      const res = await axios.post(`${API}/api/sa/impersonate/${tenantId}`)
      this.token = res.data.token
      this.user = { id: this.user.id, username: this.user.username, role: 'admin', impersonated: true }
      localStorage.setItem('token', this.token)
      localStorage.setItem('user', JSON.stringify(this.user))
      axios.defaults.headers.common['Authorization'] = `Bearer ${this.token}`
    },
    async fetchMe() {
      try {
        const res = await axios.get(`${API}/api/auth/me`)
        this.user = res.data.user
        localStorage.setItem('user', JSON.stringify(this.user))
      } catch {
        this.logout()
      }
    },
    logout() {
      this.token = ''
      this.user = null
      this.tenants = null
      localStorage.removeItem('token')
      localStorage.removeItem('user')
      localStorage.removeItem('tenants')
      delete axios.defaults.headers.common['Authorization']
    },
  },
})