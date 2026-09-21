// Media handling — download/encrypt/save incoming media (Phase 2 feature, stub for MVP)
// This module will handle:
// - downloadMediaMessage() from Baileys → buffer → encrypt → save
// - Serve decrypted media via API
// For Phase 1, we only handle text messages

const crypto = require('crypto')
const path = require('path')
const fs = require('fs')
const config = require('../config')
const { encrypt, decrypt } = require('../utils/crypto')

async function saveMedia(buffer, ext = 'bin') {
  const uuid = crypto.randomUUID()
  const filepath = path.join(config.mediaDir, `${uuid}.enc`)
  const encrypted = encrypt(buffer)
  fs.writeFileSync(filepath, encrypted)
  return filepath
}

function loadMedia(filepath) {
  const encrypted = fs.readFileSync(filepath)
  return decrypt(encrypted)
}

module.exports = { saveMedia, loadMedia }