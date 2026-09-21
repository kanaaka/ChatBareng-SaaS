<template>
  <!--
    v0.9.0 — Homerow reskin M3: struktur & perilaku identik v0.2.0 (nav, badge,
    safe-area). Warna aktif → primary token, surface → surface-container-lowest.
  -->
  <nav
    v-if="visible"
    class="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-white border-t border-gray-200"
    style="padding-bottom: env(safe-area-inset-bottom, 0px);"
  >
    <div class="flex items-stretch justify-around max-w-lg mx-auto">
      <router-link
        v-for="item in items"
        :key="item.to"
        :to="item.to"
        class="relative flex-1 flex flex-col items-center gap-0.5 py-2 text-gray-500 active:text-wa-dark"
        :class="isActive(item) ? 'text-wa-green' : ''"
        style="min-height: 48px;"
      >
        <span class="relative leading-none" style="z-index: 0;">
          <!-- v0.13.5 — pill indikator aktif (accent) di belakang ikon -->
          <span v-if="isActive(item)" class="homerow-icon-pill" aria-hidden="true"></span>
          <!-- Ikon -->
          <svg v-if="item.icon === 'chat'" class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
          <svg v-else-if="item.icon === 'contacts'" class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
          </svg>
          <svg v-else-if="item.icon === 'blast'" class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592c-.58-.204-1.082-.75-1.082-1.412 0-.66.57-1.213 1.286-1.213.715 0 1.286.553 1.286 1.213M11 5.882C11 4.29 9.823 3 8.324 3 6.826 3 5.647 4.29 5.647 5.882m0 0c0 1.24.396 2.086 1.286 2.758M3 19c0 .724.078 1.31.224 1.756M3 19c0-3.492.29-5.75 1.048-7.66M3 19c0 .55.047 1.047.14 1.5M11.3 5.9c.55-.1 1.1-.166 1.7-.166 4.142 0 7.5 3.274 7.5 7.3 0 4.026-3.358 7.3-7.5 7.3-1.285 0-2.5-.245-3.503-.686M18 11.9a4 4 0 11-8 0 4 4 0 018 0z" />
          </svg>
          <!-- v0.9.0-r2 (audit fix #3): Admin ≠ gear lagi — shield-person (admin/keamanan),
               gear sekarang KHAUSUS Pengaturan (lihat branch 'settings' di bawah) -->
          <svg v-else-if="item.icon === 'admin'" class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3l7 3v5.2c0 4.6-3 8.7-7 9.8-4-1.1-7-5.2-7-9.8V6l7-3z" />
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 9.5a3 3 0 11-6 0 3 3 0 016 0zm-7.4 8.2c.9-1.9 2.6-3.2 4.4-3.2s3.5 1.3 4.4 3.2" />
          </svg>
          <svg v-else-if="item.icon === 'settings'" class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 00-1.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          <!-- Unread badge (Obrolan) -->
          <span
            v-if="item.badge > 0"
            class="absolute -top-1 -right-2 min-w-[18px] h-[18px] bg-red-500 text-white text-[10px] font-bold flex items-center justify-center rounded-full px-1"
          >
            {{ item.badge > 99 ? '99+' : item.badge }}
          </span>
        </span>
        <span class="text-[10px] font-medium">{{ item.label }}</span>
      </router-link>
    </div>
  </nav>
</template>

<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { useChatsStore } from '../stores/chats'

const props = defineProps({
  // Parent menyembunyikan homerow saat chat detail mobile / halaman penuh lain
  visible: { type: Boolean, default: true },
})

const route = useRoute()
const auth = useAuthStore()
const chats = useChatsStore()

// v0.2.0 spec §1.2 — badge = jumlah chat dengan unreadCount > 0 di list milikku,
// bukan queueCount. unreadTotal direcompute store saat fetch/chat_update/purge.
const unreadBadge = computed(() => chats.unreadTotal || 0)

const items = computed(() => {
  const base = [
    { icon: 'chat', label: 'Obrolan', to: '/', badge: unreadBadge.value },
    { icon: 'contacts', label: 'Kontak', to: '/contacts' },
    { icon: 'blast', label: 'Blast', to: '/blast' },
  ]
  if (auth.isAdmin) {
    base.push({ icon: 'admin', label: 'Admin', to: '/admin' })
  }
  base.push({ icon: 'settings', label: 'Pengaturan', to: '/settings' })
  return base
})

function isActive(item) {
  const path = item.to === '/' ? '/' : item.to
  if (path === '/') {
    // Obrolan aktif di list & chat detail (route name Dashboard/ChatDetail)
    return route.path === '/' || route.path.startsWith('/chat/')
  }
  return route.path === path || route.path.startsWith(path + '/')
}
</script>