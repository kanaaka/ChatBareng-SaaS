// v3.4.1 — Unique username GLOBAL lintas tenant (request owner 2026-09-22 18:50).
// Username = kunci login platform-wide (satu ruang nama untuk SEMUA tenant),
// jadi duplikat = bahaya: user bisa salah masuk / kebingungan identitas.
// DB @unique hanya case-sensitive (SQLite binary) → guard ini menambah:
//   1. Case-insensitive check (lower()) — "Kanaka" vs "kanaka" dianggap bentrok
//      (catatan: lower() SQLite hanya ASCII — username di-restrict charset ASCII
//      oleh validation, jadi cukup)
//   2. Pesan 409 ramah + saran username yang TERSEDIA (diverifikasi, bukan tebak)
// Privasi lintas tenant: TIDAK pernah bocor tenant mana yang memakai username.
const prisma = require('../prisma')

const USERNAME_RE = /^[A-Za-z0-9._-]+$/

/** Cari user dengan username sama (case-insensitive) di SELURUH platform. */
async function findConflict(username) {
  if (typeof username !== 'string' || !username.trim()) return null
  const rows = await prisma.$queryRaw`SELECT id, username FROM User WHERE lower(username) = lower(${username}) LIMIT 1`
  return rows && rows.length > 0 ? rows[0] : null
}

/** Slug sederhana dari nama tenant utk prefix saran (lowercase, ASCII, tanpa spasi). */
function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20) || 'cs'
}

/** Kandidat saran username (base = username yang bentrok, tenantName utk konteks). */
function candidatesFor(base, tenantName) {
  const slug = slugify(tenantName)
  const out = [`${slug}-${base}`, `${base}-${slug}`]
  for (let i = 0; i < 3; i++) out.push(`${base}${Math.floor(100 + Math.random() * 900)}`)
  return out
}

/**
 * Saran username yang beneran tersedia (exact + CI), max 3.
 * Tidak pernah throw — saran bersifat best-effort.
 */
async function suggestUsernames(base, tenantName) {
  const seen = new Set()
  const available = []
  for (const cand of candidatesFor(base, tenantName)) {
    if (seen.has(cand)) continue
    seen.add(cand)
    try {
      if (!(await findConflict(cand))) available.push(cand)
    } catch {}
    if (available.length >= 3) break
  }
  return available
}

/** Pesan bentrok — peringatan jelas minta ganti ke yang lebih unik + saran. */
function conflictMessage(username, suggestions) {
  let m = `Username "${username}" sudah dipakai. Username bersifat unik di seluruh platform (semua perusahaan), jadi ganti ke yang lebih spesifik`
  if (suggestions && suggestions.length > 0) m += ` — misalnya: ${suggestions.join(', ')}`
  return m + '.'
}

module.exports = { USERNAME_RE, findConflict, suggestUsernames, conflictMessage }