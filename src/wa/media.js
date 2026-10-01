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

// v3.9.12 — path media PORTABEL (paket hosting, lapor Kanaka 24 Sep): DB lama
// nyimpan path ABSOLUT dari host dev (/home/kanakxxx/...) yang mati di server
// lain; DB baru nyimpan RELATIF (basename di mediaDir). Helper ini menyatukan
// keduanya: absolut → pakai apa adanya bila file ada; kalau gak ada (host lain)
// → fallback ke mediaDir sekarang by basename; relatif → mediaDir sekarang.
function resolveMediaFilePath(p) {
  if (!p) return null
  const s = String(p)
  const base = path.resolve(config.mediaDir)
  let candidate
  if (path.isAbsolute(s)) {
    if (fs.existsSync(s)) candidate = s
    else candidate = path.join(base, path.basename(s))
  } else {
    candidate = path.join(base, s)
  }
  // v3.9.12b (self-review) — containment: hasil resolve WAJIB di dalam mediaDir
  // (blok relatif '../' & absolut di luar mediaDir; legacy absolut dev tetap
  // lolos krn memang berada di dalam mediaDir).
  const resolved = path.resolve(candidate)
  return resolved === base || resolved.startsWith(base + path.sep) ? resolved : null
}

async function saveMedia(buffer, ext = 'bin') {
  const uuid = crypto.randomUUID()
  const filepath = path.join(config.mediaDir, `${uuid}.enc`)
  const encrypted = encrypt(buffer)
  fs.writeFileSync(filepath, encrypted)
  return path.basename(filepath) // v3.9.12 — simpan RELATIF: portabel lintas host
}

function loadMedia(filepath) {
  const encrypted = fs.readFileSync(resolveMediaFilePath(filepath))
  return decrypt(encrypted)
}

module.exports = { saveMedia, loadMedia, resolveMediaFilePath }