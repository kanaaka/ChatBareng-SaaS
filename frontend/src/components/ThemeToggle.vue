<template>
  <!--
    v0.9.0 — ThemeToggle: 3-segmen (Light/Dark/System), spec §2.
    M3 switch semantics: aria-pressed per opsi; persist via utils/theme.js (key themeMode).
  -->
  <div class="m3-theme-toggle" role="group" aria-label="Mode tema">
    <button
      v-for="opt in options"
      :key="opt.value"
      type="button"
      class="m3-theme-toggle__opt"
      :aria-pressed="mode === opt.value"
      :title="opt.hint"
      @click="setMode(opt.value)"
    >
      <span aria-hidden="true" class="mr-1">{{ opt.icon }}</span>{{ opt.label }}
    </button>
  </div>
</template>

<script setup>
import { ref, onUnmounted } from 'vue'
import { getThemeMode, applyTheme, watchSystemTheme } from '../utils/theme'

const options = [
  { value: 'light', label: 'Terang', icon: '☀️', hint: 'Mode terang' },
  { value: 'dark', label: 'Gelap', icon: '🌙', hint: 'Mode gelap' },
  { value: 'system', label: 'Sistem', icon: '🖥️', hint: 'Ikut pengaturan sistem (default)' },
]

const mode = ref(getThemeMode())
const stopWatch = watchSystemTheme()

function setMode(val) {
  mode.value = val
  applyTheme(val)
}

onUnmounted(() => stopWatch())
</script>