# QA — Superadmin System Log (v4.6.4 "log menu addition")

> Spec: `docs/spec-superadmin-system-log.md` (APPROVED 2026-10-05 14:35).
> Catatan penamaan: file e2e memakai `e2e-v470-systemlogs.mjs` persis sesuai §D9
> spec; rilis masuk sebagai penambahan patch line **v4.6.4** tanpa bump minor
> (Keputusan Terkunci #4). Nama dok mengikuti nama file e2e.
> Tanggal QA: 2026-10-05. Produksi (port 5047) TIDAK tersentuh — semua test di
> copy-DB `/tmp/saas-v3-e2e-p470.db` + boot port 5098.

## D10 — Acceptance & deploy checklist

- [x] Semua e2e §D9 PASS — `scripts/e2e-v470-systemlogs.mjs` **59 PASS / 0 FAIL** (run final, kode final)
- [x] `version.json` `{"appVersion":"v4.6.3"}` (bump nomor final dilakukan pipeline rilis saat ship)
- [x] `CHANGELOG.md` entri v4.6.4 bertanda "(log menu addition)"
- [x] `docs/SCHEMA-CHANGES.md` entri v4.6.4 + blok DDL SQLite eksak (dari `prisma migrate diff` datamodel)
- [x] Migrasi folder `prisma/migrations/2026100515000000_systemlog/migration.sql` (ADD-ONLY)
- [x] Smoke copy-DB port test: `/api/sa/system-logs*` 200 + redaksi terverifikasi
- [ ] Audit reviewer (kimia-K3/Kane) — WAJIB cek redaksi vs sample log nyata sebelum release (spec §D7.6)
- [ ] Smoke tunnel + PR ke repo IT (skill `chatbareng-it-release`, graft dari main IT; body PR membawa blok DDL) — bagian pipeline rilis, di luar commit implementasi ini
- [ ] Restart produksi by-PID setelah PR merge (pola rilis sebelumnya)

## E2E — 10 kasus §D9 (59 assertion / 0 FAIL)

| # | Kasus | Hasil | Bukti singkat |
|---|-------|-------|---------------|
| S1 | Ingest BE (wrapper + structured call) | ✅ 7/7 | `console.error('[Blast] …')` → row `module=blast`, `tenantId=14` + snapshot nama + `appVersion`; `logError()` terstruktur → module `auto-reply` + stack `e2e-s1 boom` + metaJson |
| S2 | Redaksi PII saat ingest | ✅ 7/7 | row tersimpan: `62***2333`, `c***@parahita.co.id`, `[redacted-body 19 chars]`; mentah 0 hitung di DB |
| S3 | Client capture + rate limit | ✅ 9/9 | cs login → 20x POST `/api/client-log` = 204 + 20 row `source=client`, tenant dari TOKEN; ke-21..25 di-drop (total tetap 20); tenantId palsu di body diabaikan; username di meta dari token; message+stack ter-redaksi; tanpa JWT → 401 |
| S4 | Role gate admin/cs → 403 | ✅ 8/8 | admin & cs: list/stats/export/detail semuanya 403 |
| S5 | List+filter+cursor+export CSV | ✅ 12/12 | list ≤limit + nextCursor (id desc); list tanpa stack/meta; filter level multi/module/q; detail 200 dgn stack+meta; export 200 `text/csv` header 11 kolom persis spec; baris = min(filter,10000); 404 id hilang; 400 id invalid |
| S6 | Dedup 10 detik | ✅ 1/1 | spam 30x identik <10s → **1 row** (≤2) |
| S7 | Retensi 30 hari | ✅ 2/2 | row `ts` 31 hari lalu terhapus oleh `pruneOnce()`; row segar tetap |
| S8 | Isolasi & survival purge | ✅ 5/5 | purge tenant 200; row SystemLog tenantId lama **tetap ada** (plain, tanpa FK), tenantName snapshot terbaca |
| S9 | Regresi boot & volume normal | ✅ 3/3 | boot bersih (tiap init jalan: capture, scheduler×2, retensi, WA disabled); volume info boot normal (11 row/jam); **0** self-storm `[SystemLog]` |
| S10 | Flood guard info | ✅ 3/3 | 1000× `logInfo` → **300 masuk** + 1 warn `info flood suppressed 1001`; `/api/health` 200 setelah flood |

Ringkasan 3 round: 43/58 (bug guard-emit dua-log-berurutan) → 50/58+57/58 (artefak harness) → **59/59** (kode final + harness final).

## Smoke (copy-DB, port test 5098)

- Boot log bersih: `[SystemLog] capture aktif … flood guard info ±300/menit`, `[SystemLog] Retensi aktif (30 hari …)`, `[Server] … port 5098`
- `GET /api/health` 200
- `GET /api/sa/system-logs?limit=3` 200 JSON (list ringkas, tanpa stack)
- `GET /api/sa/system-logs/stats` 200 (byLevel/byModule/topTenants, window 24h)
- `GET /api/sa/system-logs/:id` 200 (stack + metaJson lengkap)
- `GET /api/sa/system-logs/export?level=error` 200 `text/csv` + `Content-Disposition: filename="system-log-20261005-1508.csv"` (stamp WIB)
- Verifikasi redaksi di CSV: mentah `628111222333` / `cs@parahita.co.id` / body literal = **0 kejadian**; bentuk redaksi `62***2333`, `c***@parahita` hadir
- FE build verifikasi (`vite build` ke outDir terpisah): sukses, chunk `SaLogs-*.js/.css` dihasilkan

## Deviasi dari spec (dokumentasi reviewer)

1. **Flood-guard window env** `SYSTEMLOG_FLOOD_WINDOW_MS` (default 60000 = 1 menit sesuai spec) — tambahan khusus agar e2e S10 bisa membuktikan flush warn tanpa menunggu 60s; produksi memakai default.
2. **Skip literal `prisma:` di jalur info wrapper** — NODE_ENV=development membuat prisma client mencetak `prisma:query …` (SQL literal + nilai param) ke stdout; tanpa skip ini query-log membanjiri tabel via flood guard dan SQL literal berpotensi membawa nilai param. Keputusan di sisi aman: stdout tetap utuh, DB tidak; perilaku konsisten dengan semangat §D7 (tanpa isi literal sensitif di log).
3. **Dedup key memasukkan tenantId** — pesan identik dari tenant BERBEDA tetap tercatat masing-masing (konteks triage per-tenant penting); storm dari KONTEKS yang sama di-bungkam. Spec menulis "hash(message) identik" — interpretasi ini yang membuat fitur tetap berguna multi-tenant.
4. **Filter "global (tanpa tenant)" di UI dikerjakan client-side** (`tenantId == null` pada halaman ter-load) — endpoint list hanya menerima `tenantId=<angka>`; mode `__none__` di dropdown didefinisikan sendiri oleh FE.
5. **module hint client selalu `frontend`** + route disimpan di metaJson — mapping nama route FE ke 12 modul BE tidak 1:1; module literal yang benar lebih berguna untuk filter.
6. `logWarn('info flood suppressed N')` mengisi window warn berikut — dengan flood 1000/tick yang ekstrem, aturan dedup 10s bisa menyimpan hingga 6 warn "suppressed" per menit (satu per window-dedup); praktisnya 1–2 (bukti run: 1).

## Catatan reviewer (fokus audit)

- **Redaksi (P0):** sample nyata di copy-DB: `redactText` bekerja di message/stack/metaJson; digit-run ≥8 → `62***xxxx`; email → `x***@domain`; blok `message|body|payload|pesan:` → `[redacted-body N chars]`. Isi chat pelanggan tidak pernah ditulis literal oleh call-site structured (spec §D7.5 dipatuhi — `redactFirst40` disediakan tapi belum ada caller yang melempar konten chat).
- **Anti-rekursi:** referensi `console` asli di-bind saat load modul; guard `logWriteActive` melindungi fase sinkron; catch write memakai `console` asli. Bukti: S9-c 0 self-storm.
- **Rate limit client-log:** per-USER (Map userId), bukan per-IP — kantor NAT tidak saling menghabiskan jatah; drop = 204 diam sesuai spec.
- **Best-effort:** semua write/purge/retensi try-catch; kegagalan log tidak pernah menggagalkan aksi utama (pola saAudit).
- **Keamanan DB:** migrasi additive murni; `db push` hanya pada copy DB; PROD DB & port 5047 tidak disentuh; tidak ada reset/drop/accept-data-loss.
- **Isolasi tenant:** SystemLog tidak ada di daftar tabel purge (row survive — S8); viewer & endpoint superadmin-only.