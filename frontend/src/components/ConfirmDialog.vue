<template>
  <!--
    v0.9.0 — ConfirmDialog M3: pengganti SEMUA confirm()/alert() native.
    Terhubung via utils/confirm.js event bus: useConfirm().confirmAction({...}) dari
    komponen mana pun → dialog tunggal ini menjawab promise. Handler TIDAK berubah.
  -->
  <Teleport to="body">
    <Transition name="m3-fade">
      <div v-if="state.open" class="m3-dialog-backdrop" @click.self="cancel">
        <div
          ref="dialogEl"
          role="alertdialog"
          aria-modal="true"
          :aria-label="state.title"
          class="m3-dialog"
          :style="{ maxWidth: (state.maxWidth || 360) + 'px' }"
        >
          <h2 class="m3-dialog__headline">{{ state.title }}</h2>
          <div class="m3-dialog__body">{{ state.message }}</div>
          <div class="m3-dialog__actions">
            <button
              type="button"
              class="m3-btn m3-btn--text"
              @click="cancel"
            >
              {{ state.cancelText || 'Batal' }}
            </button>
            <button
              type="button"
              :class="['m3-btn', state.danger ? 'm3-btn--filled' : 'm3-btn--filled']"
              :style="state.danger ? { background: 'var(--md-sys-color-error)', color: 'var(--md-sys-color-on-error)' } : {}"
              @click="accept"
            >
              {{ state.confirmText || 'OK' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { reactive, ref, watch, nextTick, onUnmounted, onMounted } from 'vue'
import { subscribeConfirm } from '../utils/confirm'

const state = reactive({
  open: false,
  title: '',
  message: '',
  confirmText: '',
  cancelText: '',
  danger: false,
  maxWidth: 360,
})
let resolver = null
const dialogEl = ref(null)

function handleRequest(detail) {
  const { _resolve, ...opts } = detail
  resolver = _resolve
  state.title = opts.title || 'Konfirmasi'
  state.message = opts.message || ''
  state.confirmText = opts.confirmText || 'OK'
  state.cancelText = opts.cancelText || 'Batal'
  state.danger = !!opts.danger
  state.maxWidth = opts.maxWidth || 360
  state.open = true
}

let unsubscribe = null
onMounted(() => { unsubscribe = subscribeConfirm(handleRequest) })
onUnmounted(() => unsubscribe?.())

function accept() {
  state.open = false
  resolver?.(true)
  resolver = null
}
function cancel() {
  state.open = false
  resolver?.(false)
  resolver = null
}

function onKeydown(e) {
  if (!state.open) return
  if (e.key === 'Escape') { e.preventDefault(); cancel() }
  if (e.key === 'Enter' && state.open) { e.preventDefault(); accept() }
}
watch(() => state.open, (open) => {
  if (open) {
    document.addEventListener('keydown', onKeydown)
    nextTick(() => {
      const btns = dialogEl.value?.querySelectorAll('button')
      // Focus tombol konfirmasi (aksi utama) — pola M3
      btns?.[btns.length - 1]?.focus()
    })
  } else {
    document.removeEventListener('keydown', onKeydown)
  }
})
onUnmounted(() => document.removeEventListener('keydown', onKeydown))
</script>

<style>
.m3-fade-enter-active, .m3-fade-leave-active { transition: opacity 0.2s var(--md-sys-motion-easing-standard); }
.m3-fade-enter-from, .m3-fade-leave-to { opacity: 0; }
.m3-fade-enter-active .m3-dialog { transition: transform 0.2s var(--md-sys-motion-easing-standard); }
.m3-fade-enter-from .m3-dialog { transform: scale(0.96); }
</style>