<template>
  <!--
    v0.9.0 — Login revamp gaya Kreatr (spec §5a):
    Desktop ≥768px: kiri panel brand accent (gradient tonal + bentuk dekoratif M3 lembut,
    wordmark "ChatBareng" display + tagline), kanan form putih minimalis.
    Mobile <768px: form full-screen + brand header kecil di atas.
    LOGIKA AUTH NIHIL BERUBAH (handleLogin identik v0.1.x).
  -->
  <div class="min-h-screen flex flex-col md:flex-row bg-surface">
    <!-- ═══ Kiri: panel brand (desktop only) ═══ -->
    <div class="hidden md:flex md:w-[55%] relative overflow-hidden items-center justify-center"
      :style="{ background: 'linear-gradient(135deg, var(--md-sys-color-primary) 0%, var(--md-sys-color-primary-active, var(--md-sys-color-primary)) 100%)' }"
    >
      <!-- Bentuk dekoratif M3 lembut (blok membulat transparan) -->
      <div class="absolute -top-24 -left-24 w-96 h-96 rounded-full opacity-15 bg-white" aria-hidden="true"></div>
      <div class="absolute bottom-[-6rem] right-[-4rem] w-[28rem] h-[28rem] rounded-[var(--md-sys-shape-corner-xl)] opacity-10 bg-white rotate-12" aria-hidden="true"></div>
      <div class="absolute top-1/3 right-10 w-24 h-24 rounded-[var(--md-sys-shape-corner-xl)] opacity-10 bg-white -rotate-6" aria-hidden="true"></div>

      <div class="relative z-10 text-center px-8">
        <BrandLogo text="ChatBareng" size="xl" color="var(--md-sys-color-on-primary)" />
        <p class="mt-4 text-lg font-medium" :style="{ color: 'var(--md-sys-color-on-primary)', opacity: 0.92 }">
          Aplikasi Agent Hub untuk WhatsApp
        </p>
      </div>
    </div>

    <!-- ═══ Kanan: form minimalis ═══
         v0.9.0-r2 (audit fix #7): form dibungkus card surface-container (radius L,
         elevation-1) — di DARK card lebih terang dari bg (tidak flush); LIGHT tetap
         kartu putih (surface-container light = netral sangat terang, token tetap). -->
    <div class="flex-1 flex flex-col items-center justify-center p-6 md:p-12">
      <!-- Mobile: brand header kecil di atas -->
      <div class="md:hidden mb-8 text-center">
        <BrandLogo text="ChatBareng" size="lg" class="!text-2xl" :style="{ color: 'var(--md-sys-color-primary)' }" />
        <p class="text-sm text-gray-500 mt-1">Aplikasi Agent Hub untuk WhatsApp</p>
      </div>

      <div class="w-full max-w-sm m3-login-card">
        <!-- Desktop: icon/logo kecil + heading -->
        <div class="hidden md:block mb-8">
          <div class="w-12 h-12 rounded-[var(--md-sys-shape-corner-m)] flex items-center justify-center mb-4"
            :style="{ background: 'var(--md-sys-color-primary-container)' }">
            <svg class="w-6 h-6" :style="{ color: 'var(--md-sys-color-primary)' }" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
          </div>
          <h1 class="text-3xl font-bold" :style="{ color: 'var(--md-sys-color-on-surface)' }">Masuk</h1>
        </div>

        <form @submit.prevent="handleLogin" class="space-y-4">
          <M3TextField v-model="username" label="Username" type="text" required autocomplete="username" />
          <M3TextField v-model="password" label="Password" type="password" required autocomplete="current-password" />

          <!-- Pesan error inline M3 -->
          <div v-if="error" class="flex items-start gap-2 text-sm rounded-[var(--md-sys-shape-corner-s)] p-3"
            :style="{ background: 'var(--md-sys-color-error-container)', color: 'var(--md-sys-color-on-error-container)' }"
            role="alert"
          >
            <span aria-hidden="true">⚠️</span>
            <span>{{ error }}</span>
          </div>

          <button
            type="submit"
            :disabled="loading"
            class="m3-btn m3-btn--filled w-full !min-h-[48px]"
          >
            {{ loading ? 'Signing in...' : 'Masuk' }}
          </button>

          <!-- v0.12.0 — link publik ke Guidebook (bawah form, tanpa login) -->
          <router-link
            to="/guidebook"
            class="block text-center text-sm m3-topbar__link mt-2 !min-h-[44px] leading-[44px]"
          >📖 Panduan Penggunaan</router-link>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { useSocketStore } from '../stores/socket'
import { useAnnouncementsStore } from '../stores/announcements'
import BrandLogo from '../components/BrandLogo.vue'
import M3TextField from '../components/M3TextField.vue'

const router = useRouter()
const auth = useAuthStore()
const socket = useSocketStore()
const announcements = useAnnouncementsStore()

const username = ref('')
const password = ref('')
const error = ref('')
const loading = ref(false)

// v0.9.0 — login halaman publik: warna fallback aman via utility bg-surface.
// (data-theme di-set oleh init script anti-FOUC di index.html SEBELUM paint;
// live matchMedia di-handle global watcher di App.vue.)

async function handleLogin() {
  error.value = ''
  loading.value = true
  try {
    await auth.login(username.value, password.value)
    // v3.0 — super_admin TIDAK masuk dashboard CS (socket tenant pun tidak join)
    if (auth.isSuperAdmin) {
      router.push('/superadmin')
      return
    }
    socket.init(auth.token)
    announcements.initSockets()
    announcements.fetchAll()
    router.push('/')
  } catch (e) {
    error.value = e.response?.data?.error || 'Login failed'
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
/* v0.9.0-r2 (audit fix #7) — card form login:
   surface-container (dark: terangin dari surface bg; light: putih) + radius L + elevasi halus.
   v4.1.8 — notch label M3TextField ikut warna kartu → bg putih "floating" nyata hilang
   (lapor Kanaka 11:56 2026-09-29). */
.m3-login-card {
  --m3tf-notch-bg: var(--md-sys-color-surface-container);
  background: var(--md-sys-color-surface-container);
  border-radius: var(--md-sys-shape-corner-l);
  box-shadow: var(--md-sys-elevation-1);
  padding: 24px;
}
@media (min-width: 768px) {
  .m3-login-card { padding: 32px; }
}
</style>