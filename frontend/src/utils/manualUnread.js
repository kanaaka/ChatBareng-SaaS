// v4.1.3.1 — "Tandai belum dibaca" (mark as unread) helper — FE-only personal marker.
// Spec: docs/spec-v4.1.3.1-manual-unread.md (pendekatan A terkunci: localStorage,
// NO backend, NO DB, NO migration — pola sama dgn WhatsApp "mark as unread" yang
// juga per-device; chat/agent lain tidak perlu lihat).
//
// Key: `cb_manual_unread` = JSON object `{ "<chatId>": true }`.
// Urutan key = insertion order; cap 300 entry → evict key PERTAMA saat add melebihi
// (LRU-ish by insertion order). Semua operasi try/catch silent no-op (localStorage
// full / private mode / disabled → jangan crash).

const KEY = 'cb_manual_unread'
const CAP = 300

function readStore() {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed
  } catch (e) {
    return {}
  }
}

function writeStore(obj) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(obj))
  } catch (e) {
    // localStorage full / private mode → silent no-op (state in-memory komponen
    // tetap jalan utk sesi ini, tapi tidak persist — diterima dgn desain ini).
  }
}

// v4.1.3.1 hotfix — reactivity: localStorage BUKAN reactive source utk Vue.
// Setiap add/remove emit CustomEvent (same-tab) — listener di ChatListPane sync
// ulang map-nya → dot/label update SEGERA tanpa tunggu menu dibuka.
// Cross-tab: event 'storage' native otomatis fire di tab lain (gratis).
function notifyChanged() {
  try { window.dispatchEvent(new CustomEvent('cb-manual-unread-changed')) } catch (e) {}
}

/** Object `{ "<chatId>": true }` — urutan key = insertion order. */
export function list() {
  return readStore()
}

/** true bila chatId ditandai belum dibaca (marker personal). */
export function has(chatId) {
  if (chatId == null) return false
  return Object.prototype.hasOwnProperty.call(readStore(), String(chatId))
}

/** Tandai chatId; cap 300 → evict entry insertion-order pertama saat melebihi. */
export function add(chatId) {
  if (chatId == null) return
  try {
    const store = readStore()
    const key = String(chatId)
    if (!Object.prototype.hasOwnProperty.call(store, key)) {
      const keys = Object.keys(store)
      if (keys.length >= CAP) {
        // Evict entry pertama (insertion order — pola LRU-ish spec)
        delete store[keys[0]]
      }
    }
    // re-assign: kalau sudah ada, pindah ke urutan terakhir (refresh insertion order)
    delete store[key]
    store[key] = true
    writeStore(store)
    notifyChanged()
  } catch (e) {
    // silent no-op
  }
}

/** Hapus marker chatId (chat dibuka / agent sudah bales). */
export function remove(chatId) {
  if (chatId == null) return
  try {
    const store = readStore()
    const key = String(chatId)
    if (!Object.prototype.hasOwnProperty.call(store, key)) return
    delete store[key]
    writeStore(store)
    notifyChanged()
  } catch (e) {
    // silent no-op
  }
}