<script setup>
// v3.9.19 — Sidebar SuperAdmin (4 item: Overview | Tenants | Audit Log | Pengaturan).
// Desktop ≥768px: sidebar fixed kiri (~240px, full viewport height).
// Mobile <768px: drawer hamburger (☰ kiri atas) — open/close toggle, backdrop klik tutup.
// Style = token M3 existing (var(--md-sys-color-*)) → dark mode otomatis ikut.
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const items = [
  { to: '/superadmin/overview', label: 'Overview', icon: '📊' },
  { to: '/superadmin/tenants', label: 'Tenants', icon: '👥' },
  { to: '/superadmin/audit', label: 'Audit Log', icon: '📜' },
  { to: '/superadmin/pengaturan', label: 'Pengaturan', icon: '⚙️' },
]

// v3.9.18 — brandName platform: AppConfig global (null tenantId) — editable di
// view Pengaturan. Fallback "ChatBareng" bila belum pernah di-set / fetch gagal.
const platformBrand = ref('ChatBareng')

async function loadBrand() {
  try {
    const API = import.meta.env.VITE_API_URL || ''
    const { default: axios } = await import('axios')
    const { data } = await axios.get(`${API}/api/sa/platform-branding`, {
      headers: auth.token ? { authorization: 'Bearer ' + auth.token } : {},
    })
    if (data?.brandName) platformBrand.value = data.brandName
  } catch {
    // belum ada endpoint / gagal → fallback ChatBareng (nilai default)
  }
}

// ── Mobile drawer ──
const drawerOpen = ref(false)
let mq = null
const isMobile = ref(false)

function mqHandler(e) {
  isMobile.value = !e.matches
  if (!isMobile.value) drawerOpen.value = false // desktop → drawer pasti tutup
}

onMounted(() => {
  if (window.matchMedia) {
    mq = window.matchMedia('(min-width: 768px)')
    isMobile.value = !mq.matches
    if (mq.addEventListener) mq.addEventListener('change', mqHandler)
    else if (mq.addListener) mq.addListener(mqHandler)
  }
})
onUnmounted(() => {
  if (mq) {
    if (mq.removeEventListener) mq.removeEventListener('change', mqHandler)
    else if (mq.removeListener) mq.removeListener(mqHandler)
  }
})

function navigate(item) {
  drawerOpen.value = false
  router.push(item.to)
}

function handleLogout() {
  auth.logout()
  router.push('/login')
}

const isActive = (item) => route.path.startsWith(item.to)
const showDrawer = computed(() => isMobile.value && drawerOpen.value)

loadBrand()
</script>

<template>
  <div class="sa-shell">
    <!-- Mobile topbar dgn hamburger -->
    <div class="sa-mobile-bar">
      <button class="sa-burger" aria-label="Buka menu" @click="drawerOpen = !drawerOpen">☰</button>
      <span class="sa-mobile-brand">{{ platformBrand }}</span>
      <span class="sa-mobile-sub">Superadmin</span>
    </div>

    <!-- Backdrop mobile drawer -->
    <div v-if="showDrawer" class="sa-drawer-backdrop" @click="drawerOpen = false"></div>

    <!-- Sidebar: fixed di desktop; drawer slide di mobile -->
    <aside class="sa-sidebar" :class="{ 'sa-sidebar--open': isMobile && drawerOpen }">
      <div class="sa-sidebar__brand">
        <div class="sa-logo">
          <svg class="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm5 13.6c-.2.6-1.2 1.2-1.7 1.2-.4.1-1 .1-1.6-.1-.4-.1-.9-.3-1.5-.5-2.6-1.1-4.3-3.7-4.4-3.9-.1-.2-1-1.4-1-2.6 0-1.2.6-1.8.9-2 .2-.3.5-.3.7-.3h.5c.2 0 .4 0 .6.4l.8 2c.1.2.1.4 0 .6l-.4.6c-.1.2-.3.4-.1.7.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.3 2.4 1.5.3.1.5.1.6-.1l.8-1c.2-.2.4-.2.6-.1l1.9.9c.4.2.4.4.4.6 0 .2 0 .7-.5 1z"/>
          </svg>
        </div>
        <div class="min-w-0">
          <div class="sa-brand truncate">{{ platformBrand }}</div>
          <div class="sa-brand-sub">Superadmin</div>
        </div>
      </div>
      <nav class="sa-nav" aria-label="Menu superadmin">
        <button
          v-for="item in items"
          :key="item.to"
          class="sa-nav__item"
          :class="{ 'sa-nav__item--active': isActive(item) }"
          @click="navigate(item)"
        >
          <span class="sa-nav__icon" aria-hidden="true">{{ item.icon }}</span>
          <span>{{ item.label }}</span>
        </button>
      </nav>
      <div class="sa-sidebar__foot">
        <button class="sa-logout" @click="handleLogout">Keluar</button>
      </div>
    </aside>

    <!-- Konten: offset sidebar di desktop -->
    <div class="sa-content">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.sa-shell {
  min-height: 100vh;
  background: var(--md-sys-color-surface);
}

/* ── Sidebar desktop ── */
.sa-sidebar {
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  width: 240px;
  display: flex;
  flex-direction: column;
  background: var(--md-sys-color-surface-container);
  border-right: 1px solid var(--md-sys-color-outline-variant);
  z-index: 40;
  transition: transform 0.2s ease;
}
/* v3.9.21 — brand gak nempel frame pojok kiri atas (live-QA Kanaka):
 * padding-top ≥ 20px + kiri align dgn teks nav item (10 nav + 12 item = 22px). */
.sa-sidebar__brand {
  padding: 20px 16px 12px 22px;
}
.sa-logo {
  width: 40px;
  height: 40px;
  border-radius: var(--md-sys-shape-corner-m);
  background: #25D366;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.sa-sidebar__brand > .sa-logo {
  display: none; /* logo svg dipakai via slot markup di atas */
}
.sa-brand {
  font-weight: 700;
  color: var(--md-sys-color-on-surface);
  font-size: 1.05rem;
}
.sa-brand-sub {
  font-size: 0.75rem;
  color: var(--md-sys-color-on-surface-variant);
}
.sa-nav {
  flex: 1;
  overflow-y: auto;
  padding: 16px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sa-nav__item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  padding: 10px 12px;
  border-radius: 999px;
  font-size: 0.92rem;
  font-weight: 500;
  color: var(--md-sys-color-on-surface-variant);
  background: transparent;
  border: none;
  cursor: pointer;
  min-height: 44px;
}
.sa-nav__item:hover {
  background: var(--md-sys-color-surface-container-high);
}
.sa-nav__item--active {
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
  font-weight: 600;
}
.sa-sidebar__foot {
  padding: 12px 16px 16px;
}
.sa-logout {
  width: 100%;
  padding: 10px 0;
  border-radius: 999px;
  border: none;
  cursor: pointer;
  font-weight: 600;
  background: var(--md-sys-color-error-container);
  color: var(--md-sys-color-on-error-container);
  min-height: 40px;
}

/* ── Konten ── */
.sa-content {
  margin-left: 240px; /* offset sidebar desktop */
  min-height: 100vh;
}
.sa-mobile-bar {
  display: none;
}
.sa-burger {
  display: none;
}
.sa-drawer-backdrop {
  display: none;
}

/* ── Mobile <768px ── */
@media (max-width: 767px) {
  .sa-sidebar {
    transform: translateX(-100%);
    width: 270px;
  }
  .sa-sidebar--open {
    transform: translateX(0);
    box-shadow: var(--md-sys-elevation-3);
  }
  .sa-content {
    margin-left: 0;
  }
  .sa-mobile-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    /* v3.9.21 — brand topbar mobile gak mepet frame (≥12px vertikal) */
    padding: 12px 16px;
    background: var(--md-sys-color-surface-container);
    position: sticky;
    top: 0;
    z-index: 30;
    border-bottom: 1px solid var(--md-sys-color-outline-variant);
  }
  .sa-burger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border-radius: 999px;
    border: none;
    background: var(--md-sys-color-surface-container-high);
    color: var(--md-sys-color-on-surface);
    font-size: 1.1rem;
    cursor: pointer;
  }
  .sa-mobile-brand {
    font-weight: 700;
    color: var(--md-sys-color-on-surface);
  }
  .sa-mobile-sub {
    margin-left: auto;
    font-size: 0.78rem;
    color: var(--md-sys-color-on-surface-variant);
  }
  .sa-drawer-backdrop {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    z-index: 39;
  }
  .sa-sidebar__foot {
    display: none; /* logout ada di Overview mobile actions */
  }
}
</style>