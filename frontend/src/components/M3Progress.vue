<template>
  <!-- v0.9.0 — Linear progress M3 (Blast progress). -->
  <div class="m3-progress" :class="{ 'm3-progress--indeterminate': indeterminate }" role="progressbar">
    <div class="m3-progress__bar" :style="barStyle"></div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  value: { type: Number, default: 0 }, // 0–100
  indeterminate: { type: Boolean, default: false },
})

const barStyle = computed(() => props.indeterminate ? {} : { width: Math.min(100, Math.max(0, props.value)) + '%' })
</script>