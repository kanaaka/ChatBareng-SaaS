/**
 * v0.11.0 — Enkripsi at-rest untuk isi pesan teks (Message.content & Chat.lastMessagePreview)
 *
 * Format tersimpan: 'enc:v1:<base64-iv>:<base64-authTag>:<base64-ciphertext>'
 * - AES-256-GCM (pola media.js — IV 12 byte, authTag 16 byte)
 * - Kunci: env MSG_ENCRYPTION_KEY (base64, WAJIB 32-byte setelah decode)
 * - Kunci di-decode SEKALI di module load; missing/invalid → THROW (server exit,
 *   JANGAN silent fallback ke plaintext — keamanan silent-off = bahaya).
 * - Tanpa prefix 'enc:v1:' → data legacy plaintext → dibaca apa adanya (migrasi bertahap aman).
 * - TIDAK PERNAH me-log plaintext/ciphertext (rule v0.11.0 §6).
 */

const crypto = require('crypto')

const ALGO = 'aes-256-gcm'
const IV_LENGTH = 12
const PREFIX = 'enc:v1:'
const PREFIX_RE = /^enc:v1:/

// ─── Kunci — decode sekali di module load ────────────────────────────────
let KEY = null
try {
  const raw = process.env.MSG_ENCRYPTION_KEY
  if (!raw || !String(raw).trim()) {
    throw new Error('[TEXT-CRYPTO] MSG_ENCRYPTION_KEY missing — refusing to start. Isi env MSG_ENCRYPTION_KEY (base64 32-byte, generate: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))") di .env lalu restart.')
  }
  const key = Buffer.from(String(raw).trim(), 'base64')
  if (key.length !== 32) {
    throw new Error(`[TEXT-CRYPTO] MSG_ENCRYPTION_KEY invalid — base64 decode menghasilkan ${key.length} byte, wajib tepat 32 byte (AES-256). Jangan ubah kunci setelah data terenkripsi.`)
  }
  KEY = key
} catch (e) {
  // Re-throw dengan pesan jelas — caller (server.js) menampilkan & exit.
  throw new Error(e.message)
}

function getKey() {
  return KEY
}

/** true jika stored value ber-format 'enc:v1:...' */
function isEncrypted(stored) {
  return typeof stored === 'string' && PREFIX_RE.test(stored)
}

/**
 * Enkripsi plaintext → 'enc:v1:<iv>:<tag>:<cipher>' (base64 parts).
 * null/undefined/'' → return apa adanya (media-only message tanpa content).
 * Sudah ber-prefix → return apa adanya (idempotent, anti double-encrypt).
 */
function encryptText(plain) {
  if (plain === null || plain === undefined || plain === '') return plain
  if (isEncrypted(plain)) return plain
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGO, KEY, iv)
  const ciphertext = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`
}

/**
 * Dekrip stored value → plaintext.
 * - null/undefined/'' → return apa adanya
 * - tanpa prefix 'enc:v1:' → return apa adanya (plaintext legacy)
 * - dengan prefix → dekrip AES-256-GCM; gagal (kunci salah/data korup) → throw
 */
function decryptText(stored) {
  if (stored === null || stored === undefined || stored === '') return stored
  if (typeof stored !== 'string' || !isEncrypted(stored)) return stored
  const parts = stored.slice(PREFIX.length).split(':')
  if (parts.length !== 3) {
    throw new Error('[TEXT-CRYPTO] Format ciphertext tidak valid (harus enc:v1:<iv>:<tag>:<cipher>)')
  }
  const iv = Buffer.from(parts[0], 'base64')
  const tag = Buffer.from(parts[1], 'base64')
  const ciphertext = Buffer.from(parts[2], 'base64')
  const decipher = crypto.createDecipheriv(ALGO, KEY, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

/** Dekrip aman untuk render API: error → placeholder '[decrypt error]' (tidak crash response). */
function decryptTextSafe(stored) {
  if (stored === null || stored === undefined || stored === '') return stored
  if (typeof stored !== 'string' || !isEncrypted(stored)) return stored
  try {
    return decryptText(stored)
  } catch {
    return '[decrypt gagal]'
  }
}

module.exports = { encryptText, decryptText, decryptTextSafe, isEncrypted, getKey, PREFIX }