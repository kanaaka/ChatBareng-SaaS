<template>
  <!--
    v0.9.0 — Snackbar M3: reskin ToastStack (API store toast sama persis —
    show/dismiss/onClick tidak diubah). Warna inverse-surface (M3 snackbar spec).
  -->
  <div class="fixed bottom-4 right-4 z-[60] space-y-2">
    <TransitionGroup name="m3-snack">
      <div
        v-for="t in toast.items"
        :key="t.id"
        @click="handleClick(t)"
        class="m3-snackbar px-4 py-3 max-w-xs cursor-pointer flex items-start gap-3"
        role="status"
      >
        <span v-if="t.icon" class="text-lg leading-none mt-0.5" aria-hidden="true">{{ t.icon }}</span>
        <div class="flex-1 min-w-0">
          <div v-if="t.title" class="text-sm font-semibold">{{ t.title }}</div>
          <div v-if="t.message" class="text-sm opacity-80 truncate">{{ t.message }}</div>
        </div>
        <button
          @click.stop="toast.dismiss(t.id)"
          class="opacity-60 hover:opacity-100 transition-opacity text-base leading-none"
          aria-label="Tutup"
        >✕</button>
      </div>
    </TransitionGroup>
  </div>
</template>

<script setup>
import { useToastStore } from '../stores/toast'

const toast = useToastStore()

function handleClick(t) {
  if (typeof t.onClick === 'function') t.onClick()
  toast.dismiss(t.id)
}
</script>

<style>
.m3-snack-enter-active, .m3-snack-leave-active { transition: all 0.2s var(--md-sys-motion-easing-standard); }
.m3-snack-enter-from, .m3-snack-leave-to { opacity: 0; transform: translateY(8px); }
</style>