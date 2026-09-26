<template>
  <!--
    v0.13.6 r2 — Admin Shell jadi ROUTE LAYOUT (bukan wrapper slot):
    router.js: semua route /admin/* + /announcements + /guidebook = children dari
    komponen ini → sidebar PERSIST di semua halaman modul (desktop). Mobile: aside
    hidden via CSS murni, konten = layout lama utuh 100% (regression gate #1).
    Navigasi tetap route-based — deep-link/back/forward aman.

    B — Settings Search (spec §2): index statis frontend (label+keywords+path+
    sectionHint), dropdown M3, contains case-insensitive, skor startsWith >
    contains, keyboard ↑↓/Enter/Esc, hasil kosong "Tidak ditemukan".
    Semua warna via token M3 — dark mode + accent runtime ikut otomatis.
  -->
  <div class="min-h-screen flex flex-col bg-gray-100 overflow-x-hidden">
    <div class="admin-shell-row flex flex-1 items-stretch">
      <!-- Sidebar desktop (hidden <768px; disembunyikan penuh utk non-admin —
           /announcements bisa diakses CS via URL langsung, sidebar admin bukan miliknya) -->
      <aside v-if="auth.isAdmin" class="admin-sidebar hidden md:flex flex-col flex-shrink-0">
        <!-- Brand ala Windows: "← Dashboard" di paling atas sidebar -->
        <div class="px-3 pt-4 pb-1">
          <router-link to="/" class="admin-sidebar__brand">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
            </svg>
            Dashboard
          </router-link>
        </div>

        <!-- B — Settings Search di atas list modul -->
        <div class="px-3 pb-2">
          <div class="admin-search relative">
            <input
              ref="searchInputRef"
              v-model="searchQuery"
              type="text"
              placeholder="Cari pengaturan…"
              class="admin-search__input"
              autocomplete="off"
              aria-label="Cari pengaturan"
              @keydown="onSearchKeydown"
              @focus="onSearchFocus"
              @blur="onSearchBlur"
            />
            <!-- Dropdown hasil (M3 list) -->
            <div v-if="searchOpen" class="admin-search__dropdown" role="listbox" aria-label="Hasil pencarian pengaturan">
              <button
                v-for="(r, i) in searchResults"
                :key="r.path"
                type="button"
                class="admin-search__item"
                :class="{ 'admin-search__item--active': i === searchIndex }"
                role="option"
                :aria-selected="i === searchIndex"
                @click="goSearch(r)"
                @mousemove="searchIndex = i"
              >
                <span class="admin-search__item-icon" aria-hidden="true">{{ r.icon }}</span>
                <span class="admin-search__item-main">
                  <span class="admin-search__item-label">{{ r.label }}</span>
                  <span class="admin-search__item-hint">{{ r.sectionHint }}</span>
                </span>
                <span class="admin-search__item-enter" aria-hidden="true">↵</span>
              </button>
              <div v-if="searchResults.length === 0" class="admin-search__empty">
                <div>Tidak ditemukan</div>
                <div class="admin-search__empty-hint">Coba kata kunci lain, mis. "qr" atau "jam kerja"</div>
              </div>
            </div>
          </div>
        </div>

        <!-- List modul (ikon + label + deskripsi pendek) — route-based -->
        <nav class="admin-sidebar__nav flex-1 overflow-y-auto px-2 pb-4" aria-label="Modul admin">
          <router-link
            v-for="m in visibleModules"
            :key="m.to"
            :to="m.to"
            class="admin-sidebar__item"
            :class="{ 'admin-sidebar__item--active': isActive(m.to) }"
            :aria-current="isActive(m.to) ? 'page' : undefined"
          >
            <span class="admin-sidebar__item-icon" aria-hidden="true">{{ m.icon }}</span>
            <span class="admin-sidebar__item-main">
              <span class="admin-sidebar__item-label">{{ m.title }}</span>
              <span class="admin-sidebar__item-desc">{{ m.desc }}</span>
            </span>
          </router-link>
        </nav>
      </aside>

      <!-- Panel konten: route child dirender di sini (v0.13.6 r2 — shell pindah ke
           router-level, fix lapor Kanaka 11:08 #2: sidebar hilang di halaman modul).
           v0.13.6 r3: panel ini yang scroll internal (desktop) → sidebar statis beneran -->
      <main ref="contentRef" class="admin-content flex-1 min-w-0">
        <router-view />
      </main>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { hasFeature } from '../utils/branding' // v3.4 — menu gating plan

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

// v0.13.6 r3 — panel konten scroll internal (desktop): reset scroll ke atas saat
// pindah modul (ala Windows Settings — halaman baru selalu mulai dari atas).
const contentRef = ref(null)
watch(() => route.path, () => {
  if (contentRef.value) contentRef.value.scrollTop = 0
})

// ── Modul sidebar — 13 modul (LENGKAP sesuai launcher — fix lapor Kanaka 11:08 #1:
// spec v0.13.6 salah tulis "8 modul"; launcher sebenarnya 13 sejak v0.13.0) ──
// v3.4 — modul ber-plan punya `feature` key → difilter hasFeature() (hide bila OFF).
const modules = [
  { icon: '👥', title: 'Users', desc: 'Kelola akun CS & admin', to: '/admin/users' },
  { icon: '📱', title: 'WhatsApp', desc: 'Koneksi & QR session', to: '/admin/whatsapp' },
  { icon: '📝', title: 'Templates', desc: 'Pesan cepat + keyword', to: '/admin/templates' },
  { icon: '📊', title: 'Analytics', desc: 'Performa CS & lifecycle', to: '/admin/analytics', feature: 'analytics' },
  { icon: '📢', title: 'Pengumuman', desc: 'Broadcast ke tim', to: '/announcements', feature: 'blast' },
  { icon: '🧹', title: 'Purge', desc: 'Bersihkan riwayat chat', to: '/admin/purge' },
  { icon: '🗂️', title: 'Backup & Restore', desc: 'Export/import history', to: '/admin/history', feature: 'historyExport' },
  { icon: '🤖', title: 'Auto Reply', desc: 'Greeting & jam kerja', to: '/admin/autoreply' },
  { icon: '🧭', title: 'Menu Gateway', desc: 'Triage otomatis', to: '/admin/menu-gateway', feature: 'menuGateway' },
  // v4.0.0 — ChatBareng AI (CB-AI Knowledge): halaman tampil utk semua admin; guard plan
  // dilakukan server-side (403 upsell di semua endpoint). Client-side gating opsional
  // dibiarkan terbuka agar admin Lite tetap bisa lihat + paham fitur (trial → 403 ramah).
  { icon: '🤖', title: 'ChatBareng AI', desc: 'Jawaban AI dari KB', to: '/admin/ai-knowledge' },
  { icon: '⭐', title: 'CSAT', desc: 'Survey kepuasan', to: '/admin/csat', feature: 'csat' },
  { icon: '☁️', title: 'Backup Drive', desc: 'Google Drive otomatis', to: '/admin/backup', feature: 'gdriveBackup' },
  { icon: '🎨', title: 'Tampilan', desc: 'Warna aksen aplikasi', to: '/admin/appearance' },
  // v3.9.13 — Public API v1: key mgmt (gated featApiAccess, plan max)
  { icon: '🔑', title: 'API Keys', desc: 'Integrasi aplikasi eksternal', to: '/admin/api-keys', feature: 'apiAccess' },
  { icon: '📖', title: 'Panduan', desc: 'Panduan semua peran', to: '/guidebook' },
]

// v3.4 — modul terlihat = filter feature gate (modul tanpa feature key selalu tampil)
const visibleModules = computed(() => modules.filter((m) => !m.feature || hasFeature(m.feature)))

// ── B — Settings Search index statis (spec §2) ──
const SEARCH_INDEX = [
  { label: 'Users', keywords: 'cs, agent, user, password, role', path: '/admin/users', sectionHint: 'Admin Panel', icon: '👥' },
  { label: 'WhatsApp', keywords: 'qr, scan, session, logout wa, centang biru, read receipt', path: '/admin/whatsapp', sectionHint: 'Admin Panel', icon: '📱' },
  { label: 'Auto Reply', keywords: 'away, greeting, sambutan, jam kerja, jam operasional, luar jam', path: '/admin/autoreply', sectionHint: 'Admin Panel', icon: '🤖' },
  { label: 'Menu Gateway', keywords: 'menu, triage, intro, timeout, frekuensi, tag otomatis', path: '/admin/menu-gateway', sectionHint: 'Admin Panel', icon: '🧭' },
  { label: 'ChatBareng AI', keywords: 'ai, knowledge, kb, dokumen, cbai, jawaban otomatis, chatbareng ai', path: '/admin/ai-knowledge', sectionHint: 'Admin Panel', icon: '🤖' },
  { label: 'Channel', keywords: 'channel, kanal, newsletter, arsip, siaran, broadcast', path: '/channels', sectionHint: 'Admin Panel', icon: '📢' },
  { label: 'Templates', keywords: 'template, balasan cepat', path: '/admin/templates', sectionHint: 'Admin Panel', icon: '📝' },
  { label: 'CSAT', keywords: 'bintang, rating, survey, kepuasan, csat', path: '/admin/csat', sectionHint: 'Admin Panel', icon: '⭐' },
  { label: 'Purge', keywords: 'hapus chat, bersih-bersih, purge', path: '/admin/purge', sectionHint: 'Admin Panel', icon: '🧹' },
  { label: 'Backup', keywords: 'backup, google drive', path: '/admin/backup', sectionHint: 'Admin Panel', icon: '☁️' },
  { label: 'Analytics', keywords: 'performa, analitik, statistik, export, cs performance', path: '/admin/analytics', sectionHint: 'Admin Panel', icon: '📊' },
  { label: 'Pengumuman', keywords: 'pengumuman, broadcast, announce, kabar tim', path: '/announcements', sectionHint: 'Admin Panel', icon: '📢' },
  { label: 'Backup & Restore', keywords: 'export, import, restore, history, riwayat chat', path: '/admin/history', sectionHint: 'Admin Panel', icon: '🗂️' },
  { label: 'Tampilan', keywords: 'tema, warna, accent, dark mode, appearance', path: '/admin/appearance', sectionHint: 'Admin Panel', icon: '🎨' },
  { label: 'API Keys', keywords: 'api, key, integrasi, eksternal, token, antrean, webhook', path: '/admin/api-keys', sectionHint: 'Admin Panel', icon: '🔑' },
  { label: 'Panduan', keywords: 'panduan, guidebook, tutorial, bantuan, cara pakai', path: '/guidebook', sectionHint: 'Dokumentasi', icon: '📖' },
]

// ── Sidebar: item aktif (route-based, bukan state global) ──
function isActive(to) {
  return route.path === to
}

// ── B — Settings search logic ──
const searchQuery = ref('')
const searchOpen = ref(false)
const searchIndex = ref(0)
const searchInputRef = ref(null)

const searchResults = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return []
  const scored = []
  for (const item of SEARCH_INDEX) {
    const label = item.label.toLowerCase()
    const kw = item.keywords.toLowerCase()
    // skor sederhana: startsWith > contains (spec §2) — tanpa fuzzy library.
    // Keyword dicek per-token (pisah koma) supaya contains substring antar-token
    // (mis. "cs" di "csat") gak menyalah scoring — ditemukan saat test.
    // Exact keyword token (k === q) di atas label prefix: keyword "cs" memang
    // milik Users (spec §2) — ketik "cs" harus ke Users, bukan CSAT.
    let score = -1
    const kwTokens = kw.split(',').map(k => k.trim())
    if (kwTokens.some(k => k === q)) score = 3.2
    else if (label.startsWith(q)) score = 3
    else if (label.includes(q)) score = 2
    else if (kwTokens.some(k => k.startsWith(q))) score = 1.5
    else if (kwTokens.some(k => k.includes(q))) score = 1
    if (score >= 0) scored.push({ ...item, _score: score })
  }
  scored.sort((a, b) => b._score - a._score)
  return scored.slice(0, 6)
})

function onSearchFocus() {
  if (searchQuery.value.trim()) searchOpen.value = true
}
function onSearchBlur() {
  // delay mikro supaya click item terdaftar sebelum dropdown ditutup
  setTimeout(() => { searchOpen.value = false }, 120)
}
function onSearchKeydown(e) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (searchResults.value.length) {
      searchOpen.value = true
      searchIndex.value = Math.min(searchIndex.value + 1, searchResults.value.length - 1)
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    searchIndex.value = Math.max(searchIndex.value - 1, 0)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    if (searchResults.value.length) goSearch(searchResults.value[searchIndex.value] || searchResults.value[0])
  } else if (e.key === 'Escape') {
    searchOpen.value = false
    searchQuery.value = ''
    searchInputRef.value?.blur()
  }
}
function goSearch(r) {
  if (!r) return
  searchOpen.value = false
  searchQuery.value = ''
  router.push(r.path)
}

// Escape saat fokus di luar input juga menutup dropdown
function onGlobalKeydown(e) {
  if (e.key === 'Escape' && searchOpen.value && document.activeElement !== searchInputRef.value) {
    searchOpen.value = false
  }
}
onMounted(() => window.addEventListener('keydown', onGlobalKeydown))
onUnmounted(() => window.removeEventListener('keydown', onGlobalKeydown))
</script>