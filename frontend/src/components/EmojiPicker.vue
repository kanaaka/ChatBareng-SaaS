<!--
  v4.1.3 EmojiPicker — popover pilih emoji utk composer chat (FE-only, 0 backend/DB/dep).
  Spec: docs/spec-v4.1.3-emoji-picker.md (D2).
  - ~122 emoji hardcoded (tanpa lib), HANYA 3 kategori NETRAL multi-tenant
    (revisi Kanaka 2026-09-28 12:07 — TIDAK ada kategori spesifik industri/klinik,
    ChatBareng dipakai semua tenant): Smileys & Perasaan (lengkap), Gestur & Tangan,
    Hati & Keluarga.
  - "Sering dipakai": LRU localStorage `cb_emoji_recent` (max 16, unshift+dedupe);
    kosong → section disembunyikan.
  - Insert TIDAK menutup popover (multi-emoji); tutup via backdrop klik-luar +
    tombol ✕ kanan-atas + Esc.
  - Warna var M3 (surface-container / outline-variant / on-surface /
    surface-container-high) — dark/light otomatis, kontras AA.
  - Komponen TIDAK menyentuh layout composer: root = backdrop fixed + panel
    absolute (di luar flow) → composerHeight tidak berubah (spec D4).
-->
<template>
  <!-- Backdrop klik-luar: transparan, z-30 di bawah panel (z-40); klik → tutup.
       Panel sendiri @click.stop supaya klik di dalam popover tidak bubble. -->
  <div class="fixed inset-0 z-30" @click="$emit('close')"></div>

  <div
    class="absolute bottom-full left-0 mb-2 z-40 flex flex-col w-[340px] max-w-[calc(100vw-24px)] max-h-80 rounded-lg border border-[var(--md-sys-color-outline-variant)] bg-[var(--md-sys-color-surface-container)] shadow-xl overflow-hidden"
    role="dialog"
    aria-label="Pilih emoji"
    @click.stop
  >
    <!-- Header panel + tombol ✕ (di luar area scroll) -->
    <div class="flex items-center justify-between pl-3 pr-1.5 py-1 flex-shrink-0 border-b border-[var(--md-sys-color-outline-variant)]">
      <span class="text-xs font-semibold uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">Emoji</span>
      <button
        type="button"
        @click="$emit('close')"
        class="p-1.5 rounded-full text-[var(--md-sys-color-on-surface-variant)] hover:bg-[var(--md-sys-color-surface-container-high)] flex-shrink-0"
        title="Tutup emoji"
        style="min-width: 32px; min-height: 32px;"
      >✕</button>
    </div>

    <div class="overflow-y-auto px-2 pb-2">
      <!-- "Sering dipakai" — LRU cb_emoji_recent; kosong → section disembunyikan -->
      <div v-if="recent.length > 0" class="mb-1">
        <div class="px-1 py-1 text-xs font-semibold uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">Sering dipakai</div>
        <div class="grid grid-cols-7 justify-items-center">
          <button
            v-for="e in recent"
            :key="'recent-' + e"
            type="button"
            class="emoji-cell"
            :title="e"
            @click="pick(e)"
          >{{ e }}</button>
        </div>
      </div>

      <!-- 3 kategori netral (multi-tenant) -->
      <div v-for="cat in categories" :key="cat.name" class="mb-1">
        <div class="px-1 py-1 text-xs font-semibold uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">{{ cat.name }}</div>
        <div class="grid grid-cols-7 justify-items-center">
          <button
            v-for="e in cat.emojis"
            :key="cat.name + '-' + e"
            type="button"
            class="emoji-cell"
            :title="e"
            @click="pick(e)"
          >{{ e }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'

const emit = defineEmits(['select', 'close'])

// ── Data emoji hardcoded (FE-only, tanpa lib) — 3 kategori netral multi-tenant ──
// Revisi Kanaka 2026-09-28 12:07: hapus kategori industri; Smileys LENGKAP.
const categories = [
  {
    name: 'Smileys & Perasaan',
    emojis: [
      '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃',
      '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '☺', '😚',
      '😙', '🥲', '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭',
      '🤫', '🤔', '🤨', '😐', '😑', '😶', '😏', '😒', '🙄', '😬',
      '🤥', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢',
      '🤮', '🥵', '🥶', '😵', '🥳', '🥺', '😢', '😭', '😤', '😠',
      '😡', '🤬', '🤯', '😳', '🥱',
    ],
  },
  {
    name: 'Gestur & Tangan',
    emojis: [
      '👋', '🤚', '🖐️', '✋', '🖖', '👌', '🤌', '🤏', '✌️', '🤞',
      '🤟', '🤘', '🤙', '👈', '👉', '👆', '👇', '☝️', '👍', '👎',
      '✊', '👊', '👏', '🙌', '👐', '🤲', '🤝', '🙏',
    ],
  },
  {
    name: 'Hati & Keluarga',
    emojis: [
      '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💔', '❣️',
      '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💋', '👶', '🧒',
      '👦', '👧', '🧑', '👨', '👩', '👨‍👩‍👦', '👨‍👩‍👧‍👦', '👩‍👩‍👦', '🧑‍🤝‍🧑',
    ],
  },
]

// ── "Sering dipakai" — LRU localStorage cb_emoji_recent (max 16, unshift+dedupe) ──
const RECENT_KEY = 'cb_emoji_recent'
const RECENT_MAX = 16

function loadRecent() {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr)
      ? arr.filter(e => typeof e === 'string' && e.length > 0).slice(0, RECENT_MAX)
      : []
  } catch {
    return []
  }
}

const recent = ref(loadRecent())

function pick(emoji) {
  // LRU: unshift + dedupe + clamp 16; persist lalu emit (insert di parent, popover tetap buka)
  recent.value = [emoji, ...recent.value.filter(e => e !== emoji)].slice(0, RECENT_MAX)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent.value))
  } catch { /* storage penuh/disabled → biarkan in-memory saja */ }
  emit('select', emoji)
}

// ── Esc menutup popover (document-level selama komponen ter-render) ──
function onDocKeydown(e) {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => document.addEventListener('keydown', onDocKeydown))
onUnmounted(() => document.removeEventListener('keydown', onDocKeydown))
</script>

<style scoped>
/* Tombol grid emoji — min 40×44px (spec D2), text-2xl, rounded-lg,
   tap highlight none, hover surface-container-high (var M3 dark/light). */
.emoji-cell {
  width: 40px;
  height: 44px;
  min-width: 40px;
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.5rem; /* text-2xl */
  line-height: 1;
  border: none;
  background: transparent;
  border-radius: 0.5rem; /* rounded-lg */
  cursor: pointer;
  padding: 0;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
  transition: background-color 100ms ease;
}
.emoji-cell:hover { background: var(--md-sys-color-surface-container-high); }
.emoji-cell:focus-visible { outline: 2px solid var(--md-sys-color-outline); }
</style>