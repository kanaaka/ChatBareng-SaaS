<template>
  <!-- v0.9.0 — Badge M3: unread count, presence dot, badge "⚙️ Otomatis". -->
  <span :class="['m3-badge', dot && 'm3-badge--dot']" :style="color ? { background: color } : {}">
    <template v-if="!dot">{{ value === true ? '•' : value }}</template>
  </span>
</template>

<script setup>
defineProps({
  value: { type: [String, Number, Boolean], default: '' },
  dot: { type: Boolean, default: false },
  color: { type: String, default: '' },
})
</script>