<template>
  <!--
    v0.9.0 — BrandLogo.vue (spec §5b): wordmark teks "ChatBareng". Font ikut --md-sys-font-family (v0.12.5: Roboto).
    TANPA logo gambar (logo belum ada — keputusan Kanaka 14:06, jangan generate icon).
    SLOT logo: kalau nanti ada file logo, tinggal swap isi slot ini — pemakaian di
    login panel besar / top bar / form header kecil dikendalikan via props size.
  -->
  <span :class="['m3-wordmark', sizeClass]" :style="{ color: color || 'inherit' }">
    <!-- SLOT LOGO: ganti dengan <img v-if="logoUrl"> saat logo sudah ada -->
    <slot>{{ text }}</slot>
  </span>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  text: { type: String, default: 'ChatBareng' },
  // xl = login panel besar; lg = top bar desktop; sm = form header kecil / topbar mobile
  size: { type: String, default: 'lg' },
  color: { type: String, default: '' },
})

const sizeClass = computed(() => ({
  xl: 'text-5xl md:text-6xl',
  lg: 'text-xl',
  sm: 'text-base',
}[props.size] || 'text-xl'))
</script>