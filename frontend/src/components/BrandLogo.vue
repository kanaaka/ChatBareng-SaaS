<template>
  <!--
    v0.9.0 — BrandLogo.vue (spec §5b): wordmark teks "ChatBareng". Font ikut --md-sys-font-family (v0.12.5: Roboto).
    v3.4 — branding per-tenant: logo image (bila tenant punya) + brandName dinamis +
    suffix kecil "by ChatBareng" (muted, HARDCODED frontend — tidak disimpan DB).
    brandName kosong → "ChatBareng" polos. Login page tetap ChatBareng (prop static).
    FIX v3.7.1 (2026-09-23): template pakai effectiveText (bukan prop text mentah) —
    prop text kosong di header tenant bikin brandName gak pernah tampil (cuma 'by ChatBareng').
    SLOT logo tetap dijaga untuk pemakaian lama.
  -->
  <span :class="['m3-wordmark', sizeClass]" :style="{ color: color || 'inherit' }">
    <img
      v-if="logoUrl"
      :src="logoUrl"
      alt="logo"
      class="brand-logo-img"
      :style="{ height: logoHeight }"
    />
    <slot v-if="!logoUrl || showTextWithLogo">{{ effectiveText }}</slot>
    <span v-if="showSuffix" class="brand-suffix">by ChatBareng</span>
  </span>
</template>

<script setup>
import { computed } from 'vue'
import { getBranding } from '../utils/branding'

const props = defineProps({
  text: { type: String, default: '' }, // kosong → ambil dari branding state (fallback 'ChatBareng')
  // xl = login panel besar; lg = top bar desktop; sm = form header kecil / topbar mobile
  size: { type: String, default: 'lg' },
  color: { type: String, default: '' },
  // v3.4 — suffix "by ChatBareng" hanya utk header app tenant (bukan login)
  suffix: { type: Boolean, default: false },
  // tampilkan teks brand di samping logo (default: teks hilang bila logo ada)
  showTextWithLogo: { type: Boolean, default: false },
})

const branding = getBranding()

const effectiveText = computed(() => {
  if (props.text) return props.text
  return branding.brandName || 'ChatBareng'
})

const logoUrl = computed(() => (props.text ? '' : branding.logoUrl))
const showSuffix = computed(() => props.suffix && !!branding.brandName)

const sizeClass = computed(() => ({
  xl: 'text-5xl md:text-6xl',
  lg: 'text-xl',
  sm: 'text-base',
}[props.size] || 'text-xl'))

const logoHeight = computed(() => ({
  xl: '40px',
  lg: '26px',
  sm: '20px',
}[props.size] || '26px'))
</script>

<style scoped>
.brand-logo-img {
  width: auto;
  object-fit: contain;
  vertical-align: middle;
  border-radius: 6px;
  margin-right: 8px;
}
.brand-suffix {
  font-size: 0.68em;
  font-weight: 400;
  opacity: 0.6;
  margin-left: 8px;
  white-space: nowrap;
}
</style>