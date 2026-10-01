/**
 * v3.0 Phase 1 — baileys.js = lapisan tipis di atas src/wa/pool.js (stub fase 1).
 *
 * Dulu: modul Baileys global tunggal (sock global, chat id = JID string).
 * Sekarang: SEMUA logika multi-tenant pindah ke pool.js — file ini hanya
 * compatibility layer:
 *   - connectToWhatsApp() → pool.connectAllTenants() (no-op saat WA_DISABLED)
 *   - getStatus() → netral ({ disabled:true } saat WA_DISABLED)
 *   - sendMessage/sendMedia/logout/reconnect/requestPairingCode legacy
 *     (tanpa tenant) → ERROR JELAS supaya pemanggil lupa refactor ketahuan.
 *
 * Semua kode baru WAJIB pakai src/wa/pool.js langsung.
 */

const config = require('../config')
const pool = require('./pool')

/**
 * Boot hook lama (dipanggil server.js). Fase 1: delegasi ke pool stub —
 * WA_DISABLED=1 → log "WA disabled" + no-op total (tanpa Baileys, tanpa QR).
 */
async function connectToWhatsApp() {
  await pool.connectAllTenants()
}

/**
 * Status WA global (legacy). Fase 1 = netral/disabled; per-tenant pakai
 * pool.getStatusForTenant(tenantId).
 */
function getStatus() {
  if (config.waDisabled) {
    return {
      connected: false,
      qrNeeded: false,
      state: 'disabled',
      phoneNumber: null,
      baileysVersion: null,
      disabled: true,
    }
  }
  return {
    connected: false,
    qrNeeded: false,
    state: 'disconnected',
    phoneNumber: null,
    baileysVersion: null,
    disabled: false,
  }
}

// ─── Legacy API (tanpa tenant) — ERROR JELAS, bukan silent no-op ──────

function legacyError(fn) {
  const err = new Error(`wa.baileys.${fn}() dihapus di v3 multi-tenant — gunakan pool.${fn === 'sendMessage' ? 'sendMessageForTenant' : fn === 'sendMedia' ? 'sendMediaForTenant' : 'API per-tenant'}(tenantId, ...)`)
  err.code = 'WA_LEGACY_REMOVED'
  throw err
}

async function sendMessage() { legacyError('sendMessage') }
async function sendMedia() { legacyError('sendMedia') }
async function logout() { legacyError('logout') }
async function reconnect() { legacyError('reconnect') }
async function requestPairingCode() { legacyError('requestPairingCode') }
async function getQRDataUrl() { return null }
function getSocket() { return pool.getSocketForTenant(null) }

// LID resolution butuh socket nyata — fase 2 (dipanggil dari pool saat connect)
async function resolveLidToPhone() { return null }
async function resolveExistingLidChats() { /* fase 2 */ }

function formatPairingCode(rawCode) {
  const compact = String(rawCode || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  if (compact.length !== 8) return compact
  return compact.slice(0, 4) + '-' + compact.slice(4)
}

module.exports = {
  connectToWhatsApp,
  getStatus,
  getQRDataUrl,
  getSocket,
  formatPairingCode,
  // legacy — error jelas
  sendMessage,
  sendMedia,
  logout,
  reconnect,
  requestPairingCode,
  resolveLidToPhone,
  resolveExistingLidChats,
}