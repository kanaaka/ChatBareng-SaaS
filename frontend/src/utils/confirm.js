/**
 * v0.9.0 — useConfirm(): composable pengganti window.confirm()/alert() native.
 * Pemakaian: const { confirmDialog } = useConfirm() di root (App.vue pasang
 * <ConfirmDialog ref="...">); di komponen mana pun:
 *   const { confirmAction } = useConfirm()
 *   if (await confirmAction({ title, message, confirmText: 'Hapus', danger: true })) { ... }
 *
 * Implementasi: event bus kecil (CustomEvent di window) → ConfirmDialog tunggal
 * di App.vue menjawab promise. Handler existing TIDAK berubah — hanya wadah.
 */
const EVENT = 'm3-confirm-request'

export function useConfirm() {
  function confirmAction(opts = {}) {
    return new Promise((resolve) => {
      const detail = { ...opts, _resolve: resolve }
      window.dispatchEvent(new CustomEvent(EVENT, { detail }))
    })
  }
  return { confirmDialog: confirmAction, confirmAction }
}

/** Dipasang sekali di ConfirmDialog (App.vue) — internal. */
export function subscribeConfirm(handler) {
  const listener = (e) => handler(e.detail)
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}