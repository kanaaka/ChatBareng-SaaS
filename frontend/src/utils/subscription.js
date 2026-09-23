// v3.8 — Subscription (masa aktif tenant) frontend: state + helper.
// Sumber: GET /auth/me → user.subscription { state, validFrom, validUntil }.
// state: 'lifetime' | 'active' | 'expiring' | 'expired' | 'not_started'
// READ-ONLY enforcement (keputusan owner 15:30): expired/not_started → banner
// persistent + route guard (hanya tampilan awal) + tombol kirim disabled.
// super_admin/impersonate TIDAK kena guard (superadmin harus tetap bisa support).
import { reactive } from 'vue'

const state = reactive({
  state: null, // null = belum dimuat / super_admin (tanpa tenant)
  validFrom: null,
  validUntil: null,
})

export function getSubscription() {
  return state
}

/** Isi dari payload GET /auth/me (payload.user.subscription). */
export function setSubscription(sub) {
  state.state = sub?.state || null
  state.validFrom = sub?.validFrom || null
  state.validUntil = sub?.validUntil || null
}

export function clearSubscription() {
  state.state = null
  state.validFrom = null
  state.validUntil = null
}

/** Read-only? expired / not_started → tulis diblokir (backend 403). */
export function isReadOnlyState() {
  return state.state === 'expired' || state.state === 'not_started'
}

/** Route guard aktif? = read-only DAN user bukan super_admin/impersonasi. */
export function isTenantLocked(authUser) {
  if (!authUser || authUser.role === 'super_admin') return false
  // impersonate: token superadmin view-as → user.impersonated flag (backend
  // guard sudah bebas utk super_admin; frontend ikut supaya SA bisa support).
  if (authUser.impersonated) return false
  return isReadOnlyState()
}

/** Tanggal WIB (id-ID) ringkas: "23 Sep 2026". */
export function fmtDateId(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })
  } catch {
    return iso
  }
}