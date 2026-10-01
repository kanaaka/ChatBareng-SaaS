const crypto = require('crypto')
const config = require('../config')

const ALGO = 'aes-256-gcm'
const IV_LENGTH = 12

function getKey() {
  const hex = config.mediaEncryptionKey
  if (hex.length !== 64) {
    // Derive a 32-byte key from whatever string we have
    return crypto.createHash('sha256').update(hex).digest()
  }
  return Buffer.from(hex, 'hex')
}

function encrypt(buffer) {
  const key = getKey()
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGO, key, iv)
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()])
  const tag = cipher.getAuthTag()
  // Format: IV (12 bytes) + tag (16 bytes) + ciphertext
  return Buffer.concat([iv, tag, encrypted])
}

function decrypt(encryptedBuffer) {
  const key = getKey()
  const iv = encryptedBuffer.slice(0, IV_LENGTH)
  const tag = encryptedBuffer.slice(IV_LENGTH, IV_LENGTH + 16)
  const ciphertext = encryptedBuffer.slice(IV_LENGTH + 16)
  const decipher = crypto.createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

module.exports = { encrypt, decrypt }