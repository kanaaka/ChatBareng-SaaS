import { defineStore } from 'pinia'
import axios from 'axios'
import { loadAndApplyTenantTheme, clearTenantTheme } from '../utils/tenantTheme'
import { syncThemeColorMeta } from '../utils/themeColor'
import { setSubscription, clearSubscription } from '../utils/subscription' // v3.8
import { loadBrandingAndPlan } from '../utils/branding' // v3.9.15

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
      // v3.1 — tema aksen tenant aktif RUNTIME tanpa full reload (bootstrap App.vue
      // tidak jalan lagi saat SPA navigasi). super_admin → dilewati di util (403 netral).
      loadAndApplyTenantTheme()
      // v3.8 — login response tidak membawa subscription (payload login ringkas) →
      // fetch /auth/me segera supaya banner/guard siap di navigasi pertama.
      if (!this.user.impersonated && this.user.role !== 'super_admin') {
        try {
          const me = await axios.get(`${API}/api/auth/me`)
          this.user = me.data.user
          localStorage.setItem('user', JSON.stringify(this.user))
          setSubscription(this.user?.subscription)
        } catch {}
      }
      // v3.9.15 — branding (brandName/logo) di-load saat login. Dulu HANYA di
      // App.vue onMounted (full page load) → login SPA tanpa refresh = header
      // "ChatBareng" polos walau tenant punya brandName (bug ParahitaAsik 2026-09-25).
      // super_admin → /auth/me tanpa branding → reset netral (benar).
      loadBrandingAndPlan()
    },
    // v3.0 — impersonasi view-as tenant (short-lived JWT role admin tenant)
    async impersonate(tenantId) {
      const res = await axios.post(`${API}/api/sa/impersonate/${tenantId}`)
      this.token = res.data.token
      this.user = { id: this.user.id, username: this.user.username, role: 'admin', impersonated: true }
      localStorage.setItem('token', this.token)
      localStorage.setItem('user', JSON.stringify(this.user))
      axios.defaults.headers.common['Authorization'] = `Bearer ${this.token}`
      // v3.9.15 — impersonate in-tab juga harus refresh branding (pola sama dgn login).
      loadBrandingAndPlan()
      // v3.1 — superadmin view-as tenant → tema tenant aktif runtime juga
      loadAndApplyTenantTheme()
      // v3.8 — impersonate token view-as → subscription tenant ikut dimuat
      // (super_admin impersonate TIDAK kena guard — isTenantLocked() cek role/flag).
      try {
        const res2 = await axios.get(`${API}/api/auth/me`)
        setSubscription(res2.data?.user?.subscription)
      } catch {}
    },
    async fetchMe() {
      try {
        const res = await axios.get(`${API}/api/auth/me`)
        this.user = res.data.user
        localStorage.setItem('user', JSON.stringify(this.user))
        // v3.8 — subscription state selalu sinkron dengan /auth/me
        setSubscription(this.user?.subscription)
      } catch (e) {
        // v3.9.4 — logout HANYA saat token benar-benar invalid (401). Bug fatal QA #3:
        // dulu SEMUA error (termasuk 429 rate limit & 5xx) → logout paksa → sesi
        // terhapus → halaman kosong → login pun kena limiter (lingkaran setan).
        const status = e?.response?.status
        if (status === 401) this.logout()
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
      // v3.1 — balik ke permukaan netral platform (login page tidak ikut accent tenant)
      clearTenantTheme()
      syncThemeColorMeta()
      clearSubscription() // v3.8 — reset state masa aktif
    },
  },
})