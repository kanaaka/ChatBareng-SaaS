<!--
  v4.3.2 — MediaViewer.vue: fullscreen image viewer + zoom in/out.
  Spec: docs/spec-v4.3.2-media-viewer-lightbox.md (D1). Dipakai ChatDetail
  (openLightbox(msg) → v-if). Murni frontend, tanpa dep baru.
  Fitur: tombol zoom in/out (step 1.25×, clamp 1–8×), indikator %, reset,
  wheel-zoom mengikuti kursor, drag-pan saat zoom>1, dblclick toggle 1↔2.5×,
  Esc / klik ruang kosong = tutup, download, caption pelanggan, keyboard
  +/=/−/0/Esc. Video/audio/document TIDAK lewat komponen ini (native controls).
-->
<template>
  <Teleport to="body">
    <div
      ref="rootEl"
      class="fixed inset-0 z-50 bg-black/85"
      role="dialog"
      aria-modal="true"
      aria-label="Media viewer"
      @click="$emit('close')"
      @wheel.prevent="onWheel"
    >
      <!-- Toolbar (click.stop — jangan nutup viewer pas klik tombol) -->
      <div class="absolute top-3 right-3 z-10 flex items-center gap-1.5" @click.stop>
        <button
          @click="zoomOut"
          title="Zoom out (−)"
          aria-label="Zoom out"
          class="w-9 h-9 flex items-center justify-center rounded-full bg-white/15 hover:bg-white/25 text-white transition-colors"
          :class="{ 'opacity-40': scale <= MIN_SCALE }"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 12H4" /></svg>
        </button>
        <span class="w-14 text-center text-xs font-medium text-white/90 tabular-nums select-none" title="Tingkat zoom">{{ Math.round(scale * 100) }}%</span>
        <button
          @click="zoomIn"
          title="Zoom in (+)"
          aria-label="Zoom in"
          class="w-9 h-9 flex items-center justify-center rounded-full bg-white/15 hover:bg-white/25 text-white transition-colors"
          :class="{ 'opacity-40': scale >= MAX_SCALE }"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" /></svg>
        </button>
        <button
          @click="reset"
          title="Reset zoom (0)"
          aria-label="Reset zoom"
          class="w-9 h-9 flex items-center justify-center rounded-full bg-white/15 hover:bg-white/25 text-white transition-colors"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
        </button>
        <a
          v-if="downloadUrl"
          :href="downloadUrl"
          download
          @click.stop
          title="Download"
          aria-label="Download"
          class="w-9 h-9 flex items-center justify-center rounded-full bg-white/15 hover:bg-white/25 text-white transition-colors"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V4" /></svg>
        </a>
        <button
          @click="$emit('close')"
          title="Tutup (Esc)"
          aria-label="Tutup"
          class="w-9 h-9 flex items-center justify-center rounded-full bg-white/15 hover:bg-white/25 text-white transition-colors"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
      </div>

      <!-- Stage: klik ruang kosong (bukan gambar/toolbar) → bubbling ke root → tutup -->
      <div class="absolute inset-0 flex items-center justify-center overflow-hidden">
        <img
          ref="imgEl"
          :src="src"
          :alt="alt || 'media'"
          class="max-w-[92vw] max-h-[86vh] object-contain select-none will-change-transform"
          :style="imgStyle"
          draggable="false"
          @click.stop
          @dblclick.stop="onDblClick"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        />
      </div>

      <!-- Caption pelanggan -->
      <div v-if="caption" class="absolute bottom-4 left-0 right-0 z-10 flex justify-center px-4 pointer-events-none">
        <span class="max-w-[80vw] text-center text-sm text-white/85 bg-black/45 rounded-lg px-3 py-1.5 whitespace-pre-line break-words">{{ caption }}</span>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'

const props = defineProps({
  src: { type: String, required: true },
  caption: { type: String, default: '' },
  alt: { type: String, default: null },
  downloadUrl: { type: String, default: null },
})
const emit = defineEmits(['close'])

const MIN_SCALE = 1
const MAX_SCALE = 8
const STEP = 1.25
const WHEEL_STEP = 1.1

const scale = ref(1)
const tx = ref(0)
const ty = ref(0)
const rootEl = ref(null)
const imgEl = ref(null)
const dragging = ref(false)
let dragStart = { x: 0, y: 0, tx: 0, ty: 0 }

const imgStyle = computed(() => ({
  transform: `translate(${tx.value}px, ${ty.value}px) scale(${scale.value})`,
  transformOrigin: 'center center',
  cursor: scale.value > MIN_SCALE ? (dragging.value ? 'grabbing' : 'grab') : 'zoom-in',
  touchAction: 'none',
}))

function clampScale(v) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, v))
}

// Zoom mengikuti titik (kursor / pusat layar): titik gambar di bawah kursor
// tetap diam saat scale berubah. Model transform: screen = L + T + S*(p − C),
// rect terukur = tertransform → layout L dideduksi dari rect (lesson #4: jangan
// asumsi rect = layout box).
function zoomAt(clientX, clientY, nextScale) {
  const el = imgEl.value
  const ns = clampScale(nextScale)
  if (ns === scale.value && ns === MIN_SCALE) return // zoom-out at 1× = no-op
  if (!el) { scale.value = ns; return }
  const rect = el.getBoundingClientRect()
  const S = scale.value
  const W = rect.width / S
  const H = rect.height / S
  const cx = W / 2
  const cy = H / 2
  const Lx = rect.left - tx.value + S * cx
  const Ly = rect.top - ty.value + S * cy
  const qlx = cx + (clientX - Lx - tx.value) / S
  const qly = cy + (clientY - Ly - ty.value) / S
  tx.value = ns === MIN_SCALE ? 0 : clientX - Lx - ns * (qlx - cx)
  ty.value = ns === MIN_SCALE ? 0 : clientY - Ly - ns * (qly - cy)
  scale.value = ns
}

function viewportCenter() {
  const r = rootEl.value?.getBoundingClientRect()
  return {
    x: r ? r.left + r.width / 2 : window.innerWidth / 2,
    y: r ? r.top + r.height / 2 : window.innerHeight / 2,
  }
}

function zoomIn() {
  const c = viewportCenter()
  zoomAt(c.x, c.y, scale.value * STEP)
}
function zoomOut() {
  const c = viewportCenter()
  zoomAt(c.x, c.y, scale.value / STEP)
}
function reset() {
  scale.value = MIN_SCALE
  tx.value = 0
  ty.value = 0
}

function onWheel(e) {
  const factor = e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP
  zoomAt(e.clientX, e.clientY, scale.value * factor)
}

function onDblClick(e) {
  zoomAt(e.clientX, e.clientY, scale.value > MIN_SCALE ? MIN_SCALE : 2.5)
}

// Pan: hanya saat zoom > 1 (pointer events = mouse + touch seragam).
function onPointerDown(e) {
  if (scale.value <= MIN_SCALE) return
  dragging.value = true
  dragStart = { x: e.clientX, y: e.clientY, tx: tx.value, ty: ty.value }
  imgEl.value?.setPointerCapture?.(e.pointerId)
}
function onPointerMove(e) {
  if (!dragging.value) return
  tx.value = dragStart.tx + (e.clientX - dragStart.x)
  ty.value = dragStart.ty + (e.clientY - dragStart.y)
}
function onPointerUp(e) {
  if (!dragging.value) return
  dragging.value = false
  imgEl.value?.releasePointerCapture?.(e.pointerId)
}

function onKey(e) {
  if (e.key === 'Escape') { emit('close'); return }
  if (e.key === '+' || e.key === '=') zoomIn()
  else if (e.key === '-') zoomOut()
  else if (e.key === '0') reset()
}

onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>