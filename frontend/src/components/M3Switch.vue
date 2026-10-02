<template>
  <!-- v0.9.0 — Switch M3 (manual). value: Boolean; emit 'update:modelValue'. -->
  <button
    type="button"
    role="switch"
    class="m3-switch"
    :aria-checked="modelValue ? 'true' : 'false'"
    :disabled="disabled"
    @click="$emit('update:modelValue', !modelValue)"
  >
    <span class="m3-switch__thumb"></span>
  </button>
</template>

<script setup>
defineProps({
  modelValue: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
})
defineEmits(['update:modelValue'])
</script>