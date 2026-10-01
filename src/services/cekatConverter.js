// v0.15.0 — Konversi rows CSV Cekat.AI → payload wa-cs-hub-history v1 (in-memory)
//
// SEMUA aturan di bawah dicopy SAMA PERSIS dari converter Python terbukti
// `scripts/cekat_import_converter.py` (dipakai import manual 2026-09-21,
// 2.509 chats) + docs/spec-v0.15.0-import-cekat.md. JANGAN diimprovisasi.
//
// Ringkasan aturan:
//   - inboxes_type !== 'whatsapp' → skip (TikTok/IG tidak diimport)
//   - phone: strip non-digit; '0'→'62'+sisa; '8'→'62'+nomor; lainnya biarkan
//     (nomor internasional non-ID tetap diimpor — JID valid)
//   - created_at/resolved_at format 'YYYY-MM-DD HH:MM:SS' = WIB (UTC+7) → UTC Z
//   - last_message_at sudah ISO ber-offset → normalisasi ke UTC Z
//   - status chat SELALU 'resolved' (keputusan owner — fresh start)
//   - handled_by_name → assignedToUsername: match case-insensitive terhadap
//     username user di sistem; alias 'yesa nabila'→'Yesa'; tidak ketemu → null
//     (JANGAN bikin user baru)
//   - tags: 'Import CekatAI' (#6366F1) + label_names (split ',') + pipeline
//     (color dari pipeline_status_color bila ada) — dedup by nama lowercase
//   - SATU pesan: direction 'in', content first_message (kosong → placeholder),
//     senderName display_name || 'Customer', status 'sent', tanpa media

const HISTORY_FORMAT = 'wa-cs-hub-history'
const HISTORY_VERSION = 1
const CEKAT_SOURCE = 'Cekat.AI import'
const EMPTY_FIRST_MESSAGE_PLACEHOLDER = '[Pesan pertama tidak tersedia di export Cekat.AI]'
const IMPORT_TAG_NAME = 'Import CekatAI'
const IMPORT_TAG_COLOR = '#6366F1'

const WIB_OFFSET_MINUTES = 7 * 60

// ─── Normalisasi nomor (sama dengan Python norm_phone) ───────────────────

function normalizePhone(raw) {
  let d = String(raw == null ? '' : raw).replace(/\D/g, '')
  if (d.startsWith('0')) d = '62' + d.slice(1)
  else if (d.startsWith('8')) d = '62' + d
  return d
}

// ─── Time parsing ─────────────────────────────────────────────────────────
// 2026-09-21 09:54:56 (WIB, UTC+7) → 2026-09-21T02:54:56.000Z

function wibToIso(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ ](\d{2}):(\d{2}):(\d{2})/.exec(String(s || '').trim())
  if (!m) return null
  const [, y, mo, d, h, mi, se] = m
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se) - WIB_OFFSET_MINUTES * 60 * 1000
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

// ISO ber-offset (mis. '2026-09-21T03:25:01.215+00:00' / berakhiran 'Z') → UTC Z.
// Format lain (fallback, tak diharapkan): perlakukan sebagai WIB.
function anyToIso(s) {
  const raw = String(s || '').trim()
  if (!raw) return null
  const d = new Date(raw)
  if (!Number.isNaN(d.getTime())) return d.toISOString()
  return wibToIso(raw)
}

// ─── Helper kecil ─────────────────────────────────────────────────────────

function cleanStr(v) {
  const s = String(v == null ? '' : v).trim()
  return s || null
}

// ─── Konversi utama ───────────────────────────────────────────────────────

/**
 * @param {Array<Object>} rows hasil parseCekatCsv (objek by header name)
 * @param {Object} opts
 * @param {Map<string,number>} opts.userMapLower username-lowercase → id (dari DB)
 * @returns {{ chats: Array, skipped: { nonWhatsApp: number, noPhone: number } }}
 */
function convertCekatRows(rows, opts = {}) {
  const userMapLower = opts.userMapLower instanceof Map ? opts.userMapLower : new Map()
  const chats = []
  const skipped = { nonWhatsApp: 0, noPhone: 0 }

  for (const r of rows) {
    if (String(r.inboxes_type || '').trim() !== 'whatsapp') {
      skipped.nonWhatsApp++
      continue
    }
    const phone = normalizePhone(r.phone_number)
    if (!phone) {
      skipped.noPhone++
      continue
    }

    const chatId = `${phone}@s.whatsapp.net`

    const createdAt = wibToIso(r.created_at) || anyToIso(r.last_message_at)
    if (!createdAt) continue // tanpa timestamp valid → tidak bisa diimpor (tidak terjadi di data asli)

    const lastMessageAt = anyToIso(r.last_message_at) || createdAt
    // Semua chat → resolved (keputusan owner); fallback resolvedAt = last_message_at || created_at
    const resolvedAt = anyToIso(r.resolved_at) || lastMessageAt

    const displayName = cleanStr(r.display_name)
    const note = cleanStr(r.note)

    // assignedToUsername: match username sistem CASE-INSENSITIVE (pakai ejaan
    // username di SISTEM — engine lookup pakai Map persis); alias 'yesa nabila' → 'Yesa';
    // tidak ketemu → null (JANGAN bikin user baru)
    const agentRaw = cleanStr(r.handled_by_name)
    let assignedToUsername = null
    if (agentRaw) {
      const key = agentRaw.toLowerCase()
      if (key === 'yesa nabila') assignedToUsername = 'Yesa'
      else assignedToUsername = userMapLower.get(key) || null
    }

    // ── Tags (dedup by nama lowercase) ──
    const tags = []
    const seenTags = new Set()
    const addTag = (name, color) => {
      const nm = String(name || '').trim()
      if (!nm) return
      const key = nm.toLowerCase()
      if (seenTags.has(key)) return
      seenTags.add(key)
      tags.push(color ? { name: nm, color: String(color).trim() || undefined } : { name: nm })
    }
    addTag(IMPORT_TAG_NAME, IMPORT_TAG_COLOR)
    for (const lbl of String(r.label_names || '').split(',')) addTag(lbl)
    addTag(r.pipeline_status_name, cleanStr(r.pipeline_status_color) || undefined)

    // ── SATU pesan per chat ──
    const fm = String(r.first_message || '').trim()
    const content = fm || EMPTY_FIRST_MESSAGE_PLACEHOLDER

    chats.push({
      chatId,
      contactPhone: phone,
      contactName: displayName,
      phoneJid: chatId,
      status: 'resolved',
      resolvedAt,
      createdAt,
      lastMessageAt,
      assignedToUsername,
      firstIncomingAt: createdAt,
      csMessagesSent: 0,
      reopenedCount: 0,
      contact: { note },
      tags,
      messages: [
        {
          direction: 'in',
          content,
          senderName: displayName || 'Customer',
          senderUsername: null,
          timestamp: createdAt,
          status: 'sent',
          waMessageId: null,
          purged: false,
          mediaType: null,
          mediaMime: null,
          mediaSize: null,
          mediaPath: null,
          mediaUrl: null,
        },
      ],
    })
  }

  return { chats, skipped }
}

/**
 * Payload lengkap untuk engine import (format history v1, in-memory).
 */
function buildCekatPayload(chats, source = CEKAT_SOURCE) {
  return {
    format: HISTORY_FORMAT,
    version: HISTORY_VERSION,
    exportedBy: 'admin (import Cekat.AI)',
    exportedAt: new Date().toISOString(),
    source,
    chats,
  }
}

module.exports = {
  normalizePhone,
  wibToIso,
  anyToIso,
  convertCekatRows,
  buildCekatPayload,
  EMPTY_FIRST_MESSAGE_PLACEHOLDER,
  IMPORT_TAG_NAME,
  IMPORT_TAG_COLOR,
  CEKAT_SOURCE,
  HISTORY_FORMAT,
  HISTORY_VERSION,
}