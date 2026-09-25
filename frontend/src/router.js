import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from './stores/auth'
import AdminShell from './components/AdminShell.vue'

const routes = [
  { path: '/login', name: 'Login', component: () => import('./views/Login.vue') },
  // v0.13.6 r2 — AdminShell = ROUTE LAYOUT (fix lapor Kanaka 11:08 #2: sidebar harus
  // persist di SEMUA halaman modul, bukan cuma launcher). Semua route /admin/* +
  // /announcements + /guidebook = children dgn path ABSOLUT (URL tidak berubah).
  // Meta per-child dipertahankan persis (guidebook tetap PUBLIC; announcements tetap
  // admin-only seperti sebelumnya). Mobile: aside hidden via CSS → konten utuh (gate #1).
  {
    path: '/admin',
    component: AdminShell,
    children: [
      { path: '', name: 'Admin', component: () => import('./views/Admin.vue'), meta: { auth: true, admin: true } },
      { path: '/admin/users', name: 'AdminUsers', component: () => import('./views/AdminUsers.vue'), meta: { auth: true, admin: true } },
      { path: '/admin/whatsapp', name: 'AdminWhatsApp', component: () => import('./views/AdminWhatsApp.vue'), meta: { auth: true, admin: true } },
      { path: '/admin/purge', name: 'AdminPurge', component: () => import('./views/AdminPurge.vue'), meta: { auth: true, admin: true } },
      // v0.6.0 — Backup & Restore history chat (admin)
      { path: '/admin/history', name: 'AdminHistory', component: () => import('./views/AdminHistory.vue'), meta: { auth: true, admin: true, feature: 'historyExport' } },
      // v0.7.0 — Auto Reply (Outside Hours + First-of-Day Greeting, admin)
      { path: '/admin/autoreply', name: 'AdminAutoReply', component: () => import('./views/AdminAutoReply.vue'), meta: { auth: true, admin: true } },
      // v0.8.0 — Auto Backup Google Drive (OAuth per-user, admin)
      { path: '/admin/backup', name: 'AdminBackup', component: () => import('./views/AdminBackup.vue'), meta: { auth: true, admin: true, feature: 'gdriveBackup' } },
      // v0.13.0 — Menu Gateway (Auto Reply Triage, admin)
      { path: '/admin/menu-gateway', name: 'AdminMenuGateway', component: () => import('./views/AdminMenuGateway.vue'), meta: { auth: true, admin: true, feature: 'menuGateway' } },
      // v0.10.0 — CSAT Survey (Fitur C, admin)
      { path: '/admin/csat', name: 'AdminCsat', component: () => import('./views/AdminCsat.vue'), meta: { auth: true, admin: true, feature: 'csat' } },
      // v0.9.0 — Tampilan (accent color admin, M3 theme)
      { path: '/admin/appearance', name: 'AdminAppearance', component: () => import('./views/AdminAppearance.vue'), meta: { auth: true, admin: true } },
      // v3.9.13 — Public API v1: API Keys (admin tenant, plan gate apiAccess)
      { path: '/admin/api-keys', name: 'AdminApiKeys', component: () => import('./views/AdminApiKeys.vue'), meta: { auth: true, admin: true, feature: 'apiAccess' } },
      // v0.3.0 — halaman asli (bukan redirect ke tab yg gak ada)
      { path: '/admin/analytics', name: 'AdminAnalytics', component: () => import('./views/Analytics.vue'), meta: { auth: true, admin: true, feature: 'analytics' } },
      { path: '/admin/templates', name: 'AdminTemplates', component: () => import('./views/Templates.vue'), meta: { auth: true, admin: true } },
      { path: '/announcements', name: 'Announcements', component: () => import('./views/Announcements.vue'), meta: { auth: true, admin: true, feature: 'blast' } },
      // v0.12.0 — Guidebook PUBLIC (tanpa meta.auth): panduan statis; sidebar hanya
      // render utk admin (v-if auth.isAdmin di shell) — CS lihat halaman penuh tanpa sidebar.
      { path: '/guidebook', name: 'Guidebook', component: () => import('./views/Guidebook.vue') },
    ],
  },
  // v0.2.0 — chat list + detail split. Desktop (>=768px): Dashboard adalah layout
  // split-panel (list + detail) memakai ?chat=; mobile: list full → detail full.
  { path: '/', name: 'Dashboard', component: () => import('./views/Dashboard.vue'), meta: { auth: true } },
  { path: '/chat/:id', name: 'ChatDetail', component: () => import('./views/Dashboard.vue'), meta: { auth: true } },
  { path: '/settings', name: 'Settings', component: () => import('./views/Settings.vue'), meta: { auth: true } },
  { path: '/contacts', name: 'Contacts', component: () => import('./views/Contacts.vue'), meta: { auth: true } },
  // v0.14.0 — Manajemen Grup (PIC Model): halaman list grup + detail grup
  // (ChatDetail existing + panel member/settings). Pola route /contacts.
  { path: '/groups', name: 'Groups', component: () => import('./views/Groups.vue'), meta: { auth: true } },
  // v0.2.0 — Blast jadi satu halaman 2 tab (Kirim/Riwayat); deep-link lama tetap jalan
  { path: '/blast', name: 'Blast', component: () => import('./views/Blast.vue'), meta: { auth: true, feature: 'blast' } },
  { path: '/blast/history', redirect: to => ({ path: '/blast', query: { tab: 'riwayat' } }) },
  { path: '/blast/progress/:id', name: 'BlastProgress', component: () => import('./views/BlastProgress.vue'), meta: { auth: true, feature: 'blast' } },
  // v3.0 — Superadmin platform (owner): daftar tenant + buat tenant/admin + suspend
  // v3.9.19 — DIPILAH: /superadmin = AdminShell (SaSidebar) + 4 child view
  // (Overview | Tenants | Audit Log | Pengaturan). Meta auth+superadmin dipertahankan
  // persis; redirect '' → /superadmin/overview (dashboard baru = default).
  {
    path: '/superadmin',
    component: () => import('./views/SuperAdmin.vue'),
    children: [
      { path: '', redirect: '/superadmin/overview' },
      { path: '/superadmin/overview', name: 'SuperAdminOverview', component: () => import('./views/SaOverview.vue'), meta: { auth: true, superadmin: true } },
      { path: '/superadmin/tenants', name: 'SuperAdminTenants', component: () => import('./views/SaTenants.vue'), meta: { auth: true, superadmin: true } },
      { path: '/superadmin/audit', name: 'SuperAdminAudit', component: () => import('./views/SaAudit.vue'), meta: { auth: true, superadmin: true } },
      { path: '/superadmin/pengaturan', name: 'SuperAdminPengaturan', component: () => import('./views/SaPengaturan.vue'), meta: { auth: true, superadmin: true } },
    ],
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  // v0.2.0 — mobile list↔detail full-screen: jangan paksa scroll ke atas saat
  // kembali ke list (scroll position list harus preserved)
  scrollBehavior(to, from, savedPosition) {
    if (savedPosition) return savedPosition
    return { top: 0 }
  },
})

router.beforeEach((to, from, next) => {
  const auth = useAuthStore()
  // v3.8 — route guard masa aktif tenant (READ-ONLY enforcement):
  // expired / not_started → hanya tampilan awal (Dashboard/ChatDetail) + logout
  // jalan; navigasi ke menu lain DIBLOKIR (redirect balik + toast). super_admin
  // (termasuk impersonate) bebas. Halaman auth/public tidak di-lock.
  import('./utils/subscription').then(({ isTenantLocked, fmtDateId }) => {
    const locked = isTenantLocked(auth.user)
    if (locked) {
      const publicPaths = ['/login']
      const allowedWhileLocked = ['Dashboard', 'ChatDetail', 'Login']
      if (!allowedWhileLocked.includes(to.name) && !publicPaths.includes(to.path)) {
        import('./stores/toast').then(({ useToastStore }) => {
          try {
            const toast = useToastStore()
            const msg = auth.user?.subscription?.state === 'not_started'
              ? `Masa aktif dimulai ${fmtDateId(auth.user.subscription.validFrom)} — silakan kembali kemudian`
              : 'Masa berlaku akun habis — Perbarui Langganan untuk menggunakan'
            toast.show({ icon: '🔒', title: 'Masa aktif habis', message: msg, timeout: 5000 })
          } catch {}
        })
        next('/')
        return
      }
      next()
      return
    }
    guardRest(to, from, next, auth)
  })
})

function guardRest(to, from, next, auth) {
  if (to.meta.auth && !auth.isLoggedIn) {
    next('/login')
  } else if (to.meta.superadmin && !auth.isSuperAdmin) {
    // /superadmin hanya utk super_admin (user tenant → dashboard normal)
    next('/')
  } else if (to.meta.admin && auth.user?.role !== 'admin') {
    next('/')
  } else if (to.name === 'Login' && auth.isLoggedIn) {
    // v3.0 — super_admin → /superadmin; impersonasi aktif → tetap boleh ke '/'
    if (auth.isSuperAdmin) next('/superadmin')
    else next('/')
  } else if (auth.isSuperAdmin && to.path === '/') {
    // v3.0 — super_admin dilarang dashboard CS tanpa impersonasi eksplisit
    next('/superadmin')
  } else if (to.meta.feature) {
    // v3.4 — route guard plan: halaman fitur diakses langsung (deep-link) padahal
    // fitur OFF → redirect + toast pesan 403 backend (spec §8).
    // Guard hanya berlaku utk user tenant (super_admin tanpa plan → bebas; halaman
    // admin fitur memang milik tenant).
    import('./utils/branding').then(({ hasFeature }) => {
      if (!hasFeature(to.meta.feature)) {
        import('./stores/toast').then(({ useToastStore }) => {
          try {
            const toast = useToastStore()
            toast.show({ icon: '🔒', title: 'Fitur terkunci', message: 'Fitur ini tidak tersedia di paket Anda. Hubungi admin platform untuk upgrade.', timeout: 6000 })
          } catch {}
        })
        next('/')
      } else {
        next()
      }
    })
  } else {
    next()
  }
}

export default router