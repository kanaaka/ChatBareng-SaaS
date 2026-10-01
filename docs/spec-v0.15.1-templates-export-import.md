# Spec v0.15.1 — Templates: Export & Import (portabilitas antar-deploy)

> Ditulis Alita 2026-09-21 untuk Dory. Konteks: owner mau ChatBareng bisa dipindah
> ke deployment lain tanpa kehilangan library template "/" (hari ini 44 template:
> 4 bawaan + 40 hasil import quick replies Cekat.AI). Fitur = export JSON + import
> JSON di halaman Templates admin.
>
> ⚠️ PARALLEL TASK NOTICE: ada task subagent lain yang SEDANG jalan di repo ini
> (v0.15.0: services/historyImport.js, routes/cekatImport.js, server.js,
> AdminHistory.vue). Scope file kamu DIBATASI (lihat bawah) supaya tidak konflik.
> JANGAN sentuh file milik task itu.

## Perilaku yang diinginkan

Halaman Templates admin (`/admin/templates`, router sudah admin-only) dapat dua tombol baru
di area top bar (desktop) / baris aksi (mobile), gaya konsisten dengan yang sudah ada:

1. **⬇️ Export** — download file JSON berisi SEMUA template:
   `{format: 'wa-cs-hub-templates', version: 1, exportedAt, exportedBy, counts: {templates},
     templates: [{name, keyword, content, category}]}`
   Content template plaintext di DB (tidak dienkripsi) — export apa adanya.
   Filename: `chatbareng-templates-YYYYMMDD-HHmm.json`. Endpoint admin-only.
2. **⬆️ Import** — file input (.json) → confirm dialog → import → panel hasil:
   `{dryRun, total, created, skipped, renamed, errors[]}`.
   Import SEMANTICS (aman by default):
   - keyword sudah ada di DB → **skip** (existing menang, tidak diubah), skipped++
   - name sudah ada (tapi keyword beda) → **auto-rename** `${name} (import)` (suffix naik
     `(import2)`, dst kalau masih tabrakan), renamed++
   - duplikat keyword DI DALAM file → entry kedua skip (skipped++)
   - entry invalid (keyword jadi '/' sendirian, content kosong, name kosong, keyword/name
     bukan string) → errors.push({index, name, reason}) — jangan gagalkan sisanya
   - setelah import sukses (non-dryRun): emit `broadcast.emit('template_update', {action:'imported'})`
     SEKALI (Dashboard sudah dengarkan event ini → template "/" ikut refresh di composer)

## Normalisasi & validasi per entry (pure function — WAJIB diekstrak biar unit-testable)

`normalizeTemplateEntry(raw)` → `{entry}` | `{error: reason}`:
- name: `String(raw.name||'').trim()` — kosong → error 'name kosong'
- keyword: `String(raw.keyword||'').trim().toLowerCase().replace(/\s+/g,'')`, auto-prepend
  '/' kalau belum; hasil '/' sendirian → error 'keyword tidak valid'
- content: `String(raw.content??'')` — kosong/whitespace → error 'content kosong' (trim tidak
  mengubah isi asli — hanya buat cek; simpan content apa adanya)
- category: `String(raw.category||'').trim() || 'umum'`

`mergeDecision(entry, existingKeywords:Set, existingNames:Set, claimedInFile:Set)` →
`'create' | 'skip-keyword' | 'rename'` — pure, tidak nyentuh Prisma.

Validasi payload: `format === 'wa-cs-hub-templates'`, `version === 1`, `templates` array,
max 1000 entries per file (lebih → 400 pesan jelas).

## Backend — SEMUA di `src/routes/templates.js` (file ini saja)

- `GET /api/templates/export` — requireAuth + requireAdmin. Prisma findMany semua template
  (orderBy name asc), set headers Content-Type application/json + Content-Disposition
  attachment, res.send(JSON.stringify(payload)).
- `POST /api/templates/import` — requireAuth + requireAdmin, multer memoryStorage single
  field 'file' limit 5MB. Query `?dryRun=true|1` → hitung hasil tanpa menulis DB, tanpa emit.
  Non-dryRun: buat template valid (createdBy = req.user.id), transaksional per-entry tidak
  wajib — cukup sequential create; error per-entry ditampung di errors[].
- Multer error (LIMIT_FILE_SIZE dll) → 400 dengan pesan jelas (pattern: routes/history.js
  punya contoh error handler multer — tiru bentuknya, TANPA menyentuh file itu).
- `require('multer')` aman — sudah dipakai contacts.js/blast.js.

## Frontend — `frontend/src/views/Templates.vue` (file ini saja)

- Dua tombol di top area: Export (langsung axios blob → objectURL → click a.download; cek
  pattern export di AdminHistory.vue kalau perlu referensi, tapi JANGAN edit file itu) dan
  Import (input file hidden + confirm via useConfirm yang sudah dipakai di file ini/di app).
- Setelah import non-dryRun: refetch list template di halaman ini + toast ringkasan
  ("Berhasil: 40 dibuat, 2 dilewati, 1 di-rename" gaya toast yang ada).
- Panel hasil singkat menampilkan errors[] (kalau ada) — scrollable max-height.
- Ikon/emoji konsisten dengan halaman (⬇️ ⬆️ atau gaya yang sudah dipakai).

## BATASAN KEAMANAN (non-negotiable)

- NEVER destructive DB ops (db push/reset/--force-reset/--accept-data-loss/DROP/TRUNCATE/rm DB).
- JANGAN npm run build / dev; JANGAN start/restart/kill proses apa pun; JANGAN git commit.
- JANGAN menulis ke DB live (test harus OFFLINE via pure function + fixture).
- **Scope tulis kode (HANYA ini):** `src/routes/templates.js`, `frontend/src/views/Templates.vue`,
  plus file test offline di `/tmp/` (bersihkan setelah lapor).
- **JANGAN sentuh (punya task lain / Alita):** server.js, routes/history.js,
  services/historyImport.js, routes/cekatImport.js, AdminHistory.vue, Guidebook.vue,
  CHANGELOG.md, schema.prisma, .env, credentials/, data/, state/.

## Acceptance (self-check sebelum lapor)

1. `node --check src/routes/templates.js`
2. Offline test (di /tmp, tanpa Prisma/DB):
   - normalizeTemplateEntry: `'Halo Kak'/'halo'` → name 'Halo Kak', keyword '/halo';
     `'FU'/'FU '` → keyword '/fu'; content `'  '` → error; keyword `'/'` → error;
     content dengan newline preserved persis.
   - mergeDecision: existing `{'/hai'}` + import `/hai` → skip-keyword; existing name
     'salam sehat' + import keyword beda name sama → rename → 'salam sehat (import)';
     keyword baru name baru → create.
   - Round-trip: fixture 3 template → export shape function → JSON.stringify/parse →
     import parser menerima (format/version lolos), counts match.
3. Laporan akhir: file yang diubah + ringkasan + hasil self-check.