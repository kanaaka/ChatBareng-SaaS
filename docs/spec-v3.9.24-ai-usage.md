# Spec v3.9.24 — AI Usage: cost metering + panel dashboard + rate tabel per-model

**Status:** APPROVED — GO Kanaka 2026-09-26 02:21 ("Okedeeh laksanakan")
**Spec:** Alita · **Implementasi:** Dory · **Audit:** Kimi K3 · **Deploy/QA:** Alita
**Baseline:** v3.9.23 (commit `6ffc5ba`, tag pushed, USER-VERIFIED)
**Fitur induk:** v3.9.23 AI Chat Summary (`src/services/llm.js`, `AiConfig`, `TenantSummaryTemplate`)

---

## 0. Ringkasan

Setiap call LLM (summary/preview/test) kini **dicatat** ke `AiUsageLog`: token per jenis,
latency, error, **cost USD yang dihitung & di-snapshot SAAT call** (price snapshot at
transaction time), dan flag fallback lokal. SA dashboard dapat **SATU panel "AI Usage"**
(angka utama = cost); Pengaturan SA dapat **tabel rate per-model** (editable manual) +
field USD→IDR. Seed rate = pricing resmi ollama.com/pricing (fetch 2026-09-26 02:19).

## 1. Keputusan terkunci (diskusi Kanaka 02:04–02:21 — JANGAN diubah)

- **D1** Dashboard SA = SATU panel; angka besar = **COST** (USD + "≈ Rp"); subtitle
  "N call · M token · K error"; mini bar cost per hari; **tap = expand inline** (bukan
  halaman baru): 4 stats sekunder + tabel per-tenant + warning model-tanpa-rate.
- **D2** Rate tabel **PER-MODEL** di Pengaturan SA, fully manual-editable. Seed awal = §7.
- **D3** **SNAPSHOT PER-CALL**: row `AiUsageLog` simpan `costUsd` dihitung saat call +
  snapshot rate (`rateInput/rateCached/rateOutput`). Edit rate **TIDAK PERNAH** mengubah
  histori. Total spent = SUM kolom cost tersimpan.
- **D4** Model tanpa rate: token tetap tercatat, `costUsd = NULL`, stats mengembalikan
  daftar `untrackedModels` → panel tampil warning "… belum di-set rate — cost gak terlacak".
- **D5** Fallback lokal: `costUsd = 0` + `wouldCostUsd` = estimasi pakai rate model
  primary cloud (bila rate-nya ada, else NULL) → totals punya `fallbackSavedUsd`
  (= SUM wouldCostUsd baris fallback) → panel tampil "hemat $X via lokal".
- **D6** USD = unit dasar. Rp = `costUsd × usdToIdr` (field SA editable, default 16000),
  dihitung **saat render** (bukan disimpan).
- **D7** Cached "–" di pricing (mistral-large-3, nemotron-3-nano) → `cachedPerM NULL`
  → token cached dihitung pakai **rate input** (konservatif).
- **D8** Match model: exact nama → fallback **strip `:suffix`** (`gemma4:31b`→`gemma4`).
- **D9** Off-peak pricing (cuma 2 model deepseek) = **PARK**, gak diimplement v1.

## 2. Migration — SATU file, ADDITIVE MURNI

`prisma/migrations/<timestamp>_ai_usage/migration.sql`:
1. `CREATE TABLE AiUsageLog` (kolom §3) + index `(createdAt)` + `(tenantId, createdAt)`
2. `CREATE TABLE AiModelRate` (kolom §3)
3. `ALTER TABLE AiConfig ADD COLUMN usdIdr ...` → kolom `usdToIdr REAL NOT NULL DEFAULT 16000`

GAK ADA drop/rewrite kolom/tabel existing. `schema.prisma` ikut (3 model/kolom baru).
Kolom: lihat §3 — ikuti konvensi penamaan repo (pola migration v3.9.14/v3.9.23).

## 3. Schema (Prisma)

```prisma
model AiUsageLog {
  id           Int      @id @default(autoincrement())
  tenantId     Int?     // null utk source 'test' (platform-level)
  chatId       Int?
  source       String   // 'summary' | 'preview' | 'test'
  model        String   // model yang BENAR-BENAR dipakai (cloud/local)
  primaryModel String?  // model cloud saat viaFallback=true
  viaFallback  Boolean  @default(false)
  promptTokens Int      @default(0)
  cachedTokens Int      @default(0)
  outputTokens Int      @default(0)
  latencyMs    Int?
  ok           Boolean  @default(true)
  errorCode    String?  // NO_CONFIG|AUTH_401|TIMEOUT|NETWORK|UPSTREAM_5XX
  rateInput    Float?   // snapshot per 1M token saat call
  rateCached   Float?
  rateOutput   Float?
  costUsd      Float?   // null = model tanpa rate; 0 = fallback lokal / error
  wouldCostUsd Float?   // utk baris fallback: est. cost via rate primary cloud
  createdAt    DateTime @default(now())
  @@index([createdAt])
  @@index([tenantId, createdAt])
}

model AiModelRate {
  id          Int     @id @default(autoincrement())
  model       String  @unique
  inputPerM   Float
  cachedPerM  Float?  // null = pakai rate input (D7)
  outputPerM  Float
  updatedAt   DateTime @updatedAt
  updatedById Int?
}
```

`AiConfig` += `usdToIdr Float @default(16000)`.

## 4. Backend — `src/services/llm.js`

- `aiChat()` tambah opsi `source` (default `'summary'`), `tenantId`, `chatId` — di-pass
  dari caller: chats.js summary → `source:'summary'` + tenant+chat id; chats.js preview →
  `source:'preview'` (tenantId ada, chatId null); superadmin.js test → `source:'test'`.
- **Tangkap usage dari response provider**: `prompt_eval_count` (prompt), `eval_count`
  (output), `prompt_eval_cached_count` (cached subset). Provider gak kasih → 0.
- Setelah call selesai (SUkses ATAU gagal), panggil helper baru `logAiUsage()`:
  **best-effort, try/catch swallow — GAK BOLEH bikin call utama gagal.**
  - `model` = model yang dipakai; `primaryModel` diisi bila fallback jalan.
  - `latencyMs` = durasi terukur (yang sudah ada di aiChat).
  - `ok=false` + `errorCode` bila gagal (tokens 0, `costUsd` 0).
- **Rate resolve** (helper `resolveRate(model)`): `AiModelRate` exact → strip `:suffix`
  → null. Hitung `costUsd` saat call:
  `uncached = max(prompt − cached, 0)`; `costUsd = (uncached×rateInput + cached×(rateCached ?? rateInput) + output×rateOutput) / 1e6`.
  Rate null → `costUsd` null (token tetap tercatat). `viaFallback` → `costUsd=0`,
  `wouldCostUsd` = estimasi sama pakai rate `primaryModel` (null bila rate gak ada).
- **Gak ada call LLM = gak ada row**: 400 EMPTY_WINDOW / 429 cooldown / NO_CONFIG →
  TIDAK di-log (bukan pemakaian). Hanya call yang benar-benar menyentuh provider.

## 5. Backend — endpoints SA (`src/routes/superadmin.js`, additive murni, guard `...sa`)

- `GET /api/sa/ai-usage?range=today|7d|30d|all` (default `7d`) →
  ```json
  { "usdToIdr": 16000,
    "totals": { "calls", "tokens", "costUsd", "avgLatencyMs", "errors",
                 "fallbacks", "fallbackSavedUsd" },
    "perDay":  [ { "date": "2026-09-26", "calls", "costUsd" } ],   // WIB, pola v3.9.20
    "perTenant": [ { "tenantId", "name", "calls", "tokens", "costUsd", "lastUsedAt" } ],
    "untrackedModels": [ "kimi-k3" ] }                             // distinct costUsd NULL dlm range
  ```
  - `avgLatencyMs` hanya dari row `ok=true` + `latencyMs` ada.
  - `calls`/`costUsd` totals mencakup SEMUA source (incl. `test`); `perTenant` hanya row
    dengan tenantId (grup tenant 8/10 dst, nama dari tabel Tenant).
- `GET /api/sa/ai-rates` → `{ usdToIdr, rates: [ {model, inputPerM, cachedPerM, outputPerM, updatedAt} ] }`
- `PUT /api/sa/ai-rates` → body `{ usdToIdr?, rates: [ {model, inputPerM, cachedPerM?, outputPerM} ] }`
  upsert transaksional (hapus-then-insert atau upsert per model — pilih yang paling
  sederhana & aman). Validasi: model regex `^[a-zA-Z0-9._:\-\/]+$` (1..64 char); angka
  finite & `>= 0`; `usdToIdr` > 0; rates array maksimal 100 row. Audit `ai_rates_update`
  (jumlah row, TANPA key/token apa pun).
- `DELETE /api/sa/ai-rates/:model` → hapus rate; audit `ai_rates_delete`.
- Semua endpoint 401/403 utk non-SA (N10).

## 6. Seed — `prisma/seed-ai-rates.js` (script, BUKAN migration; pola `seed-api-access.js`)

Idempotent upsert 17 model §7 ke `AiModelRate`. `usdToIdr` TIDAK di-set script (default
kolom sudah 16000). Output ringkas per row. Dijalankan Alita saat deploy.

## 7. Seed rate resmi — ollama.com/pricing (fetch 2026-09-26 02:19, per 1M token USD)

| model | inputPerM | cachedPerM | outputPerM |
|---|---|---|---|
| glm-5.3-flash | 0.15 | 0.03 | 0.50 |
| glm-5.3 | 1.40 | 0.26 | 4.40 |
| glm-5.2 | 1.40 | 0.26 | 4.40 |
| kimi-k3 | 3.00 | 0.30 | 15.00 |
| kimi-k2.6 | 0.95 | 0.16 | 4.00 |
| kimi-k2.7-code | 0.95 | 0.19 | 4.00 |
| deepseek-v4.1-flash | 0.30 | 0.006 | 1.20 |
| deepseek-v4-pro | 1.32 | 0.044 | 3.96 |
| minimax-m3 | 0.60 | 0.12 | 2.40 |
| minimax-m2.7 | 0.30 | 0.06 | 1.20 |
| gpt-oss:120b | 0.15 | 0.014 | 0.60 |
| gpt-oss:20b | 0.07 | 0.035 | 0.30 |
| gemma4 | 0.14 | 0.05 | 0.40 |
| mistral-large-3 | 0.50 | NULL | 1.50 |
| nemotron-3-nano | 0.06 | NULL | 0.24 |
| nemotron-3-super | 0.015 | 0.015 | 0.60 |
| nemotron-3-ultra | 0.10 | 0.10 | 3.00 |

## 8. Frontend

### 8a. `SaOverview.vue` — panel "AI Usage" (kartu normal, taruh SETELAH panel Storage Tangan Kanan)
- Header: judul "AI Usage" + range selector **pola v3.9.20** (Today / 7 Hari / 30 Hari / Semua; default 7 hari; per-panel sendiri, gak ganggu panel lain).
- Angka besar: cost USD (format: `>= $0.01` → 2 desimal; `< $0.01` → 4 desimal) + `≈ Rp <Math.round(cost×usdToIdr)>` (locale id-ID).
- Subtitle: "N call · M token · K error".
- Mini bar chart: cost per hari (maks 14 bar terakhir) — div/CSS bars sederhana (gak perlu axis; TIDAK perlu instance Chart.js baru).
- **Tap panel → expand inline**: 4 stats sekunder (calls, tokens, avg latency dalam detik, error & fallback + "hemat $X via lokal" bila fallbackSavedUsd > 0) + tabel per-tenant (Tenant | Calls | Tokens | Cost | Terakhir) + warning `untrackedModels` ("kimi-k3 belum di-set rate — cost gak terlacak") + hint kecil "Atur rate di Pengaturan → AI Assistant".
- Loading + empty state ("Belum ada pemakaian AI").
- Refresh mengikuti mekanisme refreshPanel existing. GAK BOLEH `v-html`.

### 8b. `SaPengaturan.vue` — section "Tabel Harga (per 1 juta token, USD)" di panel AI Assistant
- Tabel editable per row: model | input | cached (kosong = pakai input) | output | tombol hapus row; tombol "+ Tambah Model".
- Field "USD → IDR" (angka > 0).
- Load rates saat panel dibuka (`GET /api/sa/ai-rates`).
- Tombol Simpan → `PUT /api/sa/ai-rates`; toast sukses; note kecil di bawah:
  "Rate berlaku untuk call berikutnya. Histori lama tidak berubah (snapshot per-call)."
- Hapus row di UI = DELETE endpoint (atau kirim daftar tanpa row tsb — konsisten dgn PUT
  semantics yang dipilih; dokumentasikan pilihan di kode).

## 9. E2E — `scripts/e2e-v3924.cjs` (COPY DB + mock LLM 127.0.0.1:11435, pola v3.9.23)

Mock LLM **WAJIB** return `prompt_eval_count` / `eval_count` / `prompt_eval_cached_count`.
Checks minimum (naming N1…):
- **N1** Summary → row AiUsageLog: tokens benar; `costUsd` = hitungan persis (assert
  angka, tolerance 1e-9); snapshot rate = seed glm-5.3-flash.
- **N2** Preview + test-connection → row `source` 'preview' / 'test'.
- **N3** Model tanpa rate (set cloudModel 'model-tanpa-rate' via SA API di copy) →
  `costUsd` null; tokens tercatat; `untrackedModels` berisi model tsb.
- **N4** **Snapshot semantics**: PUT rate glm-5.3-flash (mis. output 1.00) → call baru
  pakai rate baru; row lama `costUsd` TIDAK berubah; lalu kembalikan rate.
- **N5** Fallback (primary down + local up): `costUsd=0`, `viaFallback=true`,
  `wouldCostUsd>0`, `fallbackSavedUsd` > 0 di totals.
- **N6** Error path (mock 500): row `ok=false`, `errorCode='UPSTREAM_5XX'`, tokens 0,
  `costUsd` 0; `errors` terhitung di totals.
- **N7** Range stats: seed rows lintas hari → totals & `perDay` benar utk today/7d/30d/all
  (boundary WIB, pola parseSaRange v3.9.20); `perTenant` terpisah per tenant.
- **N8** DELETE rate → model jadi untracked.
- **N9** Validasi PUT: model karakter liar → 400; angka negatif → 400; usdToIdr ≤ 0 → 400.
- **N10** SA-only: token CS/tenant admin → 401/403 di ai-usage & ai-rates.
- **Regresi**: `e2e-v3919.cjs` (73) + `e2e-v3923.cjs` (121) ALL PASS ×1 beruntun.
- CHANGELOG: hitung `check(` **programmatic** (`grep -c`).

## 10. Batasan keras (WAJIB — lesson 2026-08-31)

- **ADDITIVE ONLY.** NEVER `prisma db push --force-reset` / `--accept-data-loss` /
  `DROP TABLE` / delete data / `rm` DB apa pun. Kalau tool minta reset → **STOP & lapor**.
- **PROD GAK DISENTUH** (deploy = Alita). E2E di COPY DB `/tmp/saas-v3-e2e.db` +
  `PORT=5099 WA_DISABLED=1`. Gak restart proses prod, gak commit (Alita yang commit).
- `node --check` semua file JS yang diubah; `npx vite build` exit 0 (outDir `../public`).
- Key/token gak pernah ke-log, ke-audit, atau masuk response.
- CHANGELOG.md entry v3.9.24 di atas file (pola v3.9.23) + file spec ini disertakan.
- File protected jangan disentuh; script QA sementara dihapus setelah pakai.

## 11. Non-goals (park)

- Off-peak pricing (cuma 2 model deepseek — D9)
- Breakdown per-user / per-chat cost
- Auto-refresh pricing dari web (manual edit saja)
- Kuota AI per plan Lite/Pro/Max (nanti — data AiUsageLog jadi dasarnya)
---

## 12. Catatan implementasi (deviasi kecil, terdokumentasi — Dory 2026-09-26)

- **logAiUsage di-AWAIT** di semua exit `aiChat`/`aiTestConnection` (bukan fire-and-forget):
  SQLite lokal + try/catch swallow → tetap best-effort (gagal metering tidak pernah
  menggagalkan call utama), tapi deterministik utk E2E (row sudah ada saat response balik).
- **wouldCostUsd (D5)** dihitung dari rate PRIMARY cloud walau model lokal tidak punya
  rate — konsisten dgn kalimat D5 "estimasi pakai rate model primary cloud";
  `fallbackSavedUsd` jadi lebih akurat.
- **PUT ai-rates = REPLACE-ALL** (hapus-then-insert dalam 1 transaksi) — opsi "paling
  sederhana & aman" dari §5; FE selalu kirim daftar penuh. Hapus row UI = DELETE endpoint.
- **untrackedModels (D4)** = distinct model dgn `costUsd IS NULL AND ok = 1` di range
  (row gagal = cost 0, bukan untracked; row lama snapshot tetap ber-cost setelah DELETE).
- **E2E N8** assert untracked via call BARU model ter-DELETE (snapshot semantics).
- Copy-DB E2E: migration di-apply manual + bookkeeping `_prisma_migrations` (checksum
  'manual-copy-db', pola proven) — ADDITIVE ONLY, tanpa reset/drop.
