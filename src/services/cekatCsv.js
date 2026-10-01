// v0.15.0 — Parser CSV export Cekat.AI (conversations_export_*.csv)
//
// Spesifikasi (docs/spec-v0.15.0-import-cekat.md):
//   - delimiter ';' + quote + newline di dalam quote + CRLF (RFC4180).
//     Parser CSV yang sudah ada di app (blast.js/contacts.js) hanyalah
//     split-per-baris tanpa dukungan quoted newline → TIDAK memenuhi syarat,
//     jadi parser RFC4180 kecil di-roll khusus di sini (tanpa dependency baru).
//   - Map by HEADER NAME (bukan posisi) — toleran kolom hilang/tambah.
//   - Encoding: coba utf-8 strict dulu; gagal → windows-1252 (fallback latin1).
//     File asli Cekat.AI adalah cp1252.

// ─── Encoding ─────────────────────────────────────────────────────────────

function decodeCsvBuffer(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    // Tidak valid utf-8 → file Cekat.AI asli memang cp1252
    try {
      return new TextDecoder('windows-1252').decode(buf)
    } catch {
      return buf.toString('latin1')
    }
  }
}

// ─── Parser baris-quoted (RFC4180) ────────────────────────────────────────
// Field quoted boleh memuat delimiter, `"`, dan newline. `""` di dalam
// quote = literal `"`. Parser ini tidak bergantung Node versi tertentu.
function parseCsvText(text, delimiter = ';') {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  let fieldWasQuoted = false
  const src = text
  const len = src.length
  let i = 0

  const pushField = () => {
    // Trim BOM/spasi tepi — tapi JANGAN menghapus konten dalam quote
    row.push(fieldWasQuoted ? field : field.trim())
    field = ''
    fieldWasQuoted = false
  }
  const pushRow = () => {
    pushField()
    rows.push(row)
    row = []
  }

  while (i < len) {
    const ch = src[i]

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }

    if (ch === '"') {
      inQuotes = true
      fieldWasQuoted = true
      i++
      continue
    }
    if (ch === delimiter) {
      pushField()
      i++
      continue
    }
    if (ch === '\r') {
      if (src[i + 1] === '\n') i++
      pushRow()
      i++
      continue
    }
    if (ch === '\n') {
      pushRow()
      i++
      continue
    }
    field += ch
    i++
  }

  // Baris terakhir tanpa newline di akhir file
  if (field !== '' || row.length > 0 || fieldWasQuoted) pushRow()

  return rows
}

// ─── Rows → objek by header name ──────────────────────────────────────────

/**
 * Parse CSV Cekat.AI dari buffer → array of objects keyed by header name.
 * Kolom hilang → ''; kolom tambahan diabaikan. Baris kosong di-skip.
 */
function parseCekatCsv(buf) {
  let text = decodeCsvBuffer(buf)
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1) // BOM
  const rows = parseCsvText(text, ';')
  if (!rows.length) return []

  const header = rows[0].map((h) => String(h).trim())
  const out = []
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]
    // Baris benar-benar kosong → skip
    if (cells.length === 1 && String(cells[0]).trim() === '') continue
    const obj = {}
    for (let c = 0; c < header.length; c++) {
      if (!header[c]) continue
      obj[header[c]] = c < cells.length ? String(cells[c] == null ? '' : cells[c]) : ''
    }
    out.push(obj)
  }
  return out
}

module.exports = { parseCekatCsv, parseCsvText, decodeCsvBuffer }