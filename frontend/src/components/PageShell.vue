<template>
  <!--
    v0.9.0 — reskin PageShell: layout & props identik v0.2.0, top bar pakai token M3
    (m3-topbar) + rebrand wordmark default. Homerow/safe-area tidak berubah.
  -->
  <div class="min-h-screen flex flex-col bg-gray-100 overflow-x-hidden">
    <!-- Mobile top bar -->
    <header
      v-if="showTopbar"
      class="md:hidden sticky top-0 z-30 m3-topbar px-4 py-3 flex items-center justify-between flex-shrink-0"
      style="padding-top: calc(12px + env(safe-area-inset-top, 0px));"
    >
      <div class="flex items-center gap-2 min-w-0">
        <router-link v-if="backTo" :to="backTo" class="p-1 -ml-1 rounded-full active:bg-white/10 flex-shrink-0">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
          </svg>
        </router-link>
        <h1 class="text-base font-semibold truncate">{{ title }}</h1>
      </div>
      <div class="flex items-center gap-2">
        <slot name="topbar-right" />
        <AnnouncementBell />
      </div>
    </header>

    <!-- Konten -->
    <div class="flex-1 flex flex-col" :class="contentClass">
      <slot />
    </div>

    <!-- Spacer untuk homerow (hanya mobile, hanya kalau homerow kelihatan) -->
    <div v-if="showHomerow" class="md:hidden flex-shrink-0" style="height: calc(56px + env(safe-area-inset-bottom, 0px));"></div>

    <Homerow :visible="showHomerow" />
  </div>
</template>

<script setup>
import Homerow from './Homerow.vue'
import AnnouncementBell from './AnnouncementBell.vue'

defineProps({
  title: { type: String, default: 'ChatBareng' },
  showHomerow: { type: Boolean, default: true },
  showTopbar: { type: Boolean, default: true },
  contentClass: { type: String, default: '' },
  // v0.3.0 — sub-page admin: back arrow di topbar mobile (kembali ke launcher)
  backTo: { type: String, default: '' },
})
</script>