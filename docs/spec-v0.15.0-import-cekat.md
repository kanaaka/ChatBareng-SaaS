# Spec v0.15.0 — Tombol "Import dari Cekat.AI" (auto-convert + import)

> Ditulis Alita 2026-09-21 untuk Dory. Konteks: hari ini 2.509 chat arsip dari export
> Cekat.AI (software omnichannel lama Mazaya Fit) diimpor MANUAL via converter Python
> (`scripts/cekat_import_converter.py`) → JSON → `POST /api/history/import`. Fitur ini
> memindahkan alur itu KE DALAM APP: admin upload CSV Cekat → auto-convert → import,
> dengan preview dry-run. SEMUA aturan konversi di bawah sudah TERBUKTI benar pada data
> asli 2.924 conversations — jangan diimprovisasi.

## Perilaku yang diinginkan

Admin → halaman Riwayat (`AdminHistory.vue`) → section baru "📥 Import dari Cekat.AI":
1. Pilih file CSV export Cekat (`conversations_export_*.csv`, delimiter `;`, encoding utf-8 ATAU cp1252)
2. Tombol **Preview (Dry Run)** → convert + simulasi, tampilkan ringkasan angka
3. Tombol **Import Sekarang** (confirm dialog) → convert + import beneran
4. Panel hasil: `chatsCreated, chatsMerged, messagesAdded, messagesSkipped, contactsUpdated, errors[], rowsTotal, rowsSkipped {nonWhatsApp, noPhone}`

Idempotent by design: upload ulang file yang sama AMAN — dedup key
(chatId+timestamp+direction+senderName+content) skip pesan dobel. Re-import file yang
sudah diimport hari ini harus menghasilkan `chatsMerged≈2509, messagesSkipped≈2509, chatsCreated=0`.

## Aturan konversi (SAMA PERSIS dengan converter terbukti)

Per row CSV (kolom dipetakan by HEADER NAME, toleran kalau ada kolom hilang):
- `inboxes_type` !== 'whatsapp' → **skip** (rowsSkipped.nonWhatsApp++; TikTok/IG tidak diimport)
- `phone_number` kosong → skip (rowsSkipped.noPhone++). Normalisasi: strip non-digit; startsWith '0' → ganti jadi '62'+sisa; startsWith '8' → prefix '62'; nomor internasional lain → biarkan apa adanya.
  chatId = `<digits>@s.whatsapp.net`; contactPhone = digits; phoneJid = chatId
- `display_name` → contactName (null kalau kosong)
- `created_at` format 'YYYY-MM-DD HH:MM:SS' = **WIB (UTC+7)** → UTC ISO Z. Dipakai untuk: `createdAt`, `firstIncomingAt`, dan timestamp message pertama
- `last_message_at` sudah ISO dengan offset → normalisasi ke UTC ISO Z → `lastMessageAt`
- `resolved_at` (WIB) → `resolvedAt`. Status chat **SELALU 'resolved'** (keputusan owner — fresh start, customer chat lagi → auto-reopen ke antrean). Fallback resolvedAt = last_message_at || created_at
- `note` → contact.note (null kalau kosong)
- `handled_by_name` → `assignedToUsername`: match username user **case-insensitive**; alias map `{'yesa nabila': 'Yesa'}` (case-insensitive); tidak ketemu → **null (JANGAN bikin user baru)**
- Tags per chat, dedup by nama lowercase: `'Import CekatAI'` (color `#6366F1`) + setiap item `label_names` (split ','), trim) + `pipeline_status_name` (color dari `pipeline_status_color` kalau ada)
- Messages: **SATU pesan** — direction 'in', content = `first_message` (kosong → `'[Pesan pertama tidak tersedia di export Cekat.AI]'`), senderName = display_name || 'Customer', senderUsername null, status 'sent', media semua null, purged false
- Struktur akhir: `{format:'wa-cs-hub-history', version:1, source:'Cekat.AI import', chats:[...]}` → diproses engine import yang sama

## Backend

1. **Ekstrak engine import** dari `src/routes/history.js` → file baru `src/services/historyImport.js`
   (MECHANICAL MOVE: `processChat, insertMessages, dedupKey, parseImportPayload, upsertContact,
   connectTags, contactFillData, encryptImportContent, previewOfNewest, parseDateOrNull,
   intOrNull, isoOrNull, resolveMediaPath, relativeMediaPath` + konstanta format/version).
   `history.js` jadi thin routes yang require service itu.
   **PERILAKU endpoint `POST /api/history/import` TIDAK BOLEH BERUBAH SEDIKITPUN** (request/response shape, dryRun, emit events, semuanya sama).
2. Route baru `src/routes/cekatImport.js`: `POST /api/cekat-import` — requireAuth + requireAdmin,
   multer memoryStorage single field 'file' (limit 50MB, file .csv saja), query `?dryRun=true|1`.
   Flow: decode → parse CSV → convert rows (aturan di atas) → jalankan engine import yang sama
   (payload JSON in-memory, TIDAK lewat HTTP loopback) → return result shape history import
   + `source:'cekat'` + `rowsTotal` + `rowsSkipped`.
3. Register route di `src/server.js` dekat pendaftaran history (1-2 baris).
4. CSV parsing: **cek dulu parser yang sudah dipakai** import Kontak/Blast (`grep` di
   `src/routes/contacts.js` + `src/routes/blast.js` — mereka sudah punya import CSV) dan pakai
   approach/dependency yang sama. JANGAN hand-roll quoted-CSV parser kalau sudah ada parser
   yang bisa dipakai. WAJIB support delimiter ';' + quote + newline di dalam quote + CRLF.
5. Encoding: coba utf-8 strict; kalau gagal → decode windows-1252 (`TextDecoder('windows-1252')`,
   fallback latin1). File asli memang cp1252.
6. Guard: maksimal 20.000 baris per file → kalau lebih, 400 dengan pesan jelas.
7. **Post-pass ContactTag (non-dryRun only):** setelah engine import selesai, untuk SETIAP chatEntry yang diproses: cari Contact by chatId (engine sudah upsert). Kalau Contact ada dan belum ter-link ke Tag 'Import CekatAI' → buat row ContactTag `{ contactId, tagId }` (idempotent — cek existing dulu; Tag-nya pasti sudah ada karena engine connectTags membuatnya di chat level). Tujuan: kontak hasil import bisa difilter di database Kontak — konsisten dengan import manual 2026-09-21 (2.509 link). Error per-contact → skip, jangan gagalkan keseluruhan.

## Frontend (`AdminHistory.vue`)

- Section card baru "📥 Import dari Cekat.AI" di dekat section import backup yang sudah ada:
  - Deskripsi singkat: "Upload CSV export conversations dari Cekat.AI. Hanya channel WhatsApp
    yang diimport (TikTok/IG di-skip). Chat masuk sebagai arsip resolved dan otomatis diberi
    tag 'Import CekatAI' + label/pipeline aslinya. Upload ulang file yang sama aman (anti-dobel)."
  - File input accept .csv, tombol "Preview (Dry Run)", tombol "Import Sekarang" (confirm via useConfirm pattern yang sudah ada), panel hasil ringkasan (semua counter + errors list)
  - Reuse pattern axios/toast/confirm yang sudah dipakai di file yang sama
- Cek `Guidebook.vue`: kalau ada section Riwayat/History admin, tambahkan 2-3 baris bullet
  gaya yang sudah ada mendeskripsikan fitur ini. Kalau tidak ada section yang cocok, skip.

## BATASAN KEAMANAN (WAJIB, NON-NEGOTIABLE)

- **NEVER** destructive DB ops: no `prisma db push`, no `migrate reset`, no `--force-reset`,
  no `--accept-data-loss`, no DROP/TRUNCATE/`rm` pada DB file apa pun. Tool minta reset → STOP & report.
- **JANGAN** jalankan `npm run build` / `npm run dev`. **JANGAN** start/restart/kill server
  atau proses apa pun (node, cloudflared, pm2, gateway). Deploy = tanggung jawab Alita.
- **JANGAN** sentuh: `.env`, `credentials/`, `data/`, DB live, `state/`. Jangan import apa pun ke DB live.
- **JANGAN** git commit — Alita yang review + commit.
- Scope tulis kode: `/home/kanakxxx/.openclaw/workspace/wa-cs-hub/` saja.
- File referensi READ-ONLY (untuk test parser offline, TANPA DB):
  `/home/kanakxxx/.openclaw/workspace/media/inbound/openclaw-staged-3ba36d68-e701-434a-b29f-0222dd90ccd0/conversations_export_1789961471429---ac120c8e-a649-4224-bde6-084e1346b4b2.csv`
  (2.924 data rows; header + kolom `;`)

## Acceptance (self-check sebelum lapor)

1. `node --check` semua file .js yang dibuat/diubah
2. Script test offline (temp, tanpa DB): parse file referensi → HARUS menghasilkan
   **2.509 kandidat WA, 415 skip non-WA, 15 first_message kosong**. Spot check: row pertama
   harus Ummu Aisha, phone 6281330909131, created 2026-09-21T02:54:56.000Z (09:54:56 WIB)
3. Diff baca `src/routes/history.js` baru vs perilaku lama: response shape + dryRun + emit
   `history_imported`/`queue_update` TIDAK berubah
4. Laporan akhir: daftar file yang diubah/dibuat + ringkasan implementasi + hasil self-check