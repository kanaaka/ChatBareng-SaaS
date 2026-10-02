<template>
  <!-- v0.13.6 r2: launcher = CHILD dari AdminShell layout (pindah ke router-level —
       fix lapor Kanaka 11:08 #2: sidebar harus persist di semua halaman modul).
       DESKTOP: konten launcher dirender di panel kanan shell (sidebar tetap terlihat).
       MOBILE: layout lama UTUH (topbar+homerow PageShell + grid) — 0 perubahan.
       v4.1.6 — grid kini ikut plan gating hasFeature() (sinkron sidebar AdminShell
       v3.4) + kartu ChatBareng AI (dilewatkam sejak v4.0.0) + API Keys → feature key.
       Fix lapor Kanaka 09:28 2026-09-29: grid mobile tampil semua walau plan OFF. -->
  <PageShell title="Admin">
      <!-- Top bar (desktop only — mobile pakai topbar+homerow PageShell, konsisten v0.2.2) -->
      <header class="hidden md:flex m3-topbar px-4 py-3 items-center justify-between">
        <div class="flex items-center gap-3">
          <h1 class="text-lg font-semibold">Admin Panel</h1>
        </div>
        <div class="flex items-center gap-4">
          <router-link to="/contacts" class="text-sm hover:underline m3-topbar__link">Kontak</router-link>
          <router-link to="/blast" class="text-sm hover:underline m3-topbar__link">Blast</router-link>
          <router-link to="/settings" class="text-sm hover:underline m3-topbar__link">{{ auth.user?.username }}</router-link>
          <button @click="handleLogout" class="text-sm hover:underline m3-topbar__link">Logout</button>
        </div>
      </header>

      <div class="max-w-4xl mx-auto w-full p-6">
        <p class="text-sm text-gray-500 mb-4">Pilih area yang ingin dikelola:</p>

        <!-- v0.3.0 — launcher ikon: tiap fungsi punya halaman sendiri (request Kanaka 01:04)
             v0.9.0 — reskin M3 Card -->
        <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
          <router-link
            v-for="m in visibleModules"
            :key="m.to"
            :to="m.to"
            class="m3-card m3-card--elevated p-6 flex flex-col items-center gap-2 text-center transition-shadow hover:shadow-[var(--md-sys-elevation-2)]"
            style="min-height: 44px;"
          >
            <div class="text-3xl">{{ m.icon }}</div>
            <div class="font-semibold text-gray-900 text-sm">{{ m.title }}</div>
            <div class="text-xs text-gray-500">{{ m.desc }}</div>
          </router-link>
        </div>
      </div>
    </PageShell>
</template>

<script setup>
import { computed } from 'vue'
import { useAuthStore } from '../stores/auth'
import PageShell from '../components/PageShell.vue'
import { hasFeature } from '../utils/branding' // v4.1.6 — plan gating grid (sinkron sidebar)
// v0.13.6 r2 — shell pindah ke router-level (AdminShell = layout /admin/*):
// view ini tidak lagi membungkus sendiri (sidebar persist di semua modul).

const auth = useAuthStore()

// v0.3.0 — satu ikon = satu halaman (tab bar + quick-links cards dobel dihapus)
// v0.9.0 — + Tampilan (accent color admin, spec §1a)
// v0.12.0 — + Guidebook (kartu launcher "📖 Panduan")
// v4.1.6 — feature keys disamakan dgn sidebar AdminShell (gating v3.4): kartu
// ber-plan difilter hasFeature() → grid mobile konsisten dgn sidebar per-plan
// (fix lapor Kanaka 09:28: Womba Lite lihat kartu mati di grid).
// ChatBareng AI TANPA feature key (selalu tampil — keputusan v4.0.0, upsell 403
// server-side; kartu ini sebelumnya justru KELEWATAN di grid sejak v4.0.0).
const modules = [
  { icon: '👥', title: 'Users', desc: 'Kelola akun CS & admin', to: '/admin/users' },
  { icon: '📱', title: 'WhatsApp', desc: 'Koneksi & QR session', to: '/admin/whatsapp' },
  { icon: '📝', title: 'Templates', desc: 'Pesan cepat + keyword', to: '/admin/templates' },
  { icon: '📊', title: 'Analytics', desc: 'Performa CS & lifecycle', to: '/admin/analytics', feature: 'analytics' },
  { icon: '📢', title: 'Pengumuman', desc: 'Broadcast ke tim', to: '/announcements', feature: 'blast' },
  { icon: '🧹', title: 'Purge', desc: 'Bersihkan riwayat chat', to: '/admin/purge' },
  { icon: '🗂️', title: 'Backup & Restore', desc: 'Export/import history', to: '/admin/history', feature: 'historyExport' },
  { icon: '🤖', title: 'Auto Reply', desc: 'Balasan otomatis di luar jam + greeting', to: '/admin/autoreply' },
  { icon: '🧭', title: 'Menu Gateway', desc: 'Triage otomatis sebelum antrean', to: '/admin/menu-gateway', feature: 'menuGateway' },
  { icon: '🤖', title: 'ChatBareng AI', desc: 'Jawaban AI dari KB', to: '/admin/ai-knowledge' },
  { icon: '⭐', title: 'CSAT Survey', desc: 'Survey rating 1–5 pasca-resolve', to: '/admin/csat', feature: 'csat' },
  { icon: '☁️', title: 'Backup Drive', desc: 'Backup otomatis ke Google Drive', to: '/admin/backup', feature: 'gdriveBackup' },
  { icon: '🎨', title: 'Tampilan', desc: 'Warna aksen aplikasi (accent)', to: '/admin/appearance' },
  { icon: '🔑', title: 'API Keys', desc: 'Integrasi aplikasi eksternal (Public API v1)', to: '/admin/api-keys', feature: 'apiAccess' },
  { icon: '📖', title: 'Panduan', desc: 'Panduan penggunaan untuk semua peran', to: '/guidebook' },
]

// v4.1.6 — kartu terlihat = filter feature gate (modul tanpa feature key selalu tampil)
const visibleModules = computed(() => modules.filter((m) => !m.feature || hasFeature(m.feature)))

function handleLogout() {
  auth.logout()
  window.location.href = '/login'
}
</script>