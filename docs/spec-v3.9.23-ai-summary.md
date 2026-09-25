# Spec v3.9.23 — AI Chat Summary (Ollama Cloud) + AI Assistant di Pengaturan SA

**Status:** MENUNGGU GO Kanaka. **Tanggal draft:** 2026-09-25 21:20.
**Keputusan Kanaka (21:06–21:17):** (1) API key TERPIDSA dari key gateway Alita, dimasukin via **Pengaturan Superadmin** (bukan .env); (2) privacy OK (Ollama zero-data policy, keputusan user); (3) fallback lokal = **opsi di Pengaturan, on-demand** — JANGAN download model sekarang; (4) model HARUS bisa dipilih dari daftar model akun (verified: `GET /api/tags` → HTTP 200, 17 model); (5) fitur WAJIB 100% mandiri dari OpenClaw/Alita (ChatBareng call langsung ke provider, key di DB app sendiri, zero callback) — jalan 24/7 saat sudah di hosting beneran walau OpenClaw off.

- **(6) Kanaka 21:25:** template summary diatur MANDIRI oleh admin tenant — preset siap pakai + custom instruksi bebas (bahasa manusia; LLM paham). Cooldown 30 detik OK.

## FACTS terverifikasi (2026-09-25, jangan dipertanyakan ulang)
- `POST https://ollama.com/api/chat` + Bearer key → HTTP 200, 2.2s, model `glm-5.3-flash` (shape body: `{model, messages:[{role,content}], stream:false}` → `{message:{content}}`).
- `GET https://ollama.com/api/tags` + Bearer key → HTTP 200 `{models:[{name, size, details}]}` (17 model; size GB = ukuran di server cloud, BUKAN download — info saja).
- Key disimpan terenkripsi memakai helper crypto existing app (pola `encryptText`/`decryptTextSafe` yang sama dgn ciphertext pesan — lihat `src/routes/chats.js`).
- Storage config: tabel baru **additive** `AiConfig` (satu row, id=1). `AppConfig` tenant-scoped & TIDAK dipakai. Precedent `platform_branding`-di-SaAuditLog TIDAK cocok utk secret (audit log bisa tampil meta).
- Migration prod path = `npx prisma migrate deploy` (proven v3.9.14). Shadow-replay fresh-clone RUSAK (legacy bug) → di copy DB: apply SQL manual + record checksum (proven workaround Dory v3.9.14).

## A. Migration (SATU, additive murni)
```sql
CREATE TABLE "AiConfig" (
  "id"            INTEGER  PRIMARY KEY DEFAULT 1,
  "cloudBaseUrl"  TEXT     NOT NULL DEFAULT 'https://ollama.com',
  "cloudModel"    TEXT     NOT NULL DEFAULT 'glm-5.3-flash',
  "apiKeyEnc"     TEXT,                       -- ciphertext (helper crypto app), NULL = belum diset
  "localBaseUrl"  TEXT     NOT NULL DEFAULT 'http://127.0.0.1:11434',
  "localModel"    TEXT,
  "fallbackEnabled" BOOLEAN NOT NULL DEFAULT false,
  "defaultPreset" TEXT     NOT NULL DEFAULT 'standard', -- format default utk tenant tanpa row template
  "updatedAt"     DATETIME NOT NULL,
  "updatedById"   INTEGER
);
```
- `prisma migrate dev --name ai_config` DIHINDARI (shadow-replay rusak) → tulis SQL migration file manual di `prisma/migrations/<ts>_ai_config/migration.sql` + apply manual ke copy DB + record checksum (pola proven v3.9.14). Prod: Alita jalankan `migrate deploy` saat release.
- Tabel kedua dalam migration yang SAMA (template summary diatur admin tenant):
```sql
CREATE TABLE "TenantSummaryTemplate" (
  "tenantId"   INTEGER PRIMARY KEY,
  "presetKey"  TEXT NOT NULL DEFAULT 'standard',
  "customText" TEXT,                       -- instruksi bebas; non-kosong = menang atas preset
  "updatedAt"  DATETIME NOT NULL,
  "updatedById" INTEGER
);
```
- Dua CREATE TABLE di atas = SATU-SATUNYA perubahan schema (additive murni). Tidak ada kolom baru di tabel existing.

## B. Service `src/services/llm.js` (NEW)
- `getAiConfig()` → baca row `AiConfig` (id=1); kalau row belum ada → config kosong (fitur off). Dekrip `apiKeyEnc` on-demand; JANGAN pernah log key.
- `aiChat({messages, timeoutMs=60000})` → POST `{cloudBaseUrl}/api/chat` (AbortController timeout; default model `cloudModel`). Return `{ok, content, model, latencyMs}` atau `{ok:false, code, message}` — code: `NO_CONFIG` | `AUTH_401` | `TIMEOUT` | `NETWORK` | `UPSTREAM_5XX`.
- `aiListModels({baseUrl, apiKey})` → GET `{baseUrl}/api/tags` → array `{name, sizeBytes}`.
- `aiTestConnection({baseUrl, apiKey, model})` → 1 call mini ("Balas persis satu kata: siap") → `{ok, latencyMs, model}`.
- **Fallback logic:** primary = cloud. Kalau primary gagal (NETWORK/TIMEOUT/5XX) **dan** `fallbackEnabled` && local reachable (ping `GET {localBaseUrl}/api/tags` timeout 2s) → retry 1x ke local, tandai `viaFallback:true` di response. Kalau fallback juga gagal → error gabungan yang jelas.
- Semua fetch pakai `AbortController`; body key TIDAK masuk log/error message.

## C. Endpoint Superadmin (src/routes/superadmin.js — additive, guard `...sa`)
1. `GET /api/sa/ai-config` → `{cloudBaseUrl, cloudModel, hasKey:bool, keyMasked:"••••"+last4|null, localBaseUrl, localModel, fallbackEnabled}` — key TIDAK PERNAH full.
2. `PUT /api/sa/ai-config` body `{cloudBaseUrl?, cloudModel?, apiKey?|null(=keep), localBaseUrl?, localModel?, fallbackEnabled?}` → validasi: baseUrl harus http(s), apiKey kalau dikirim ≥ 20 char (disimpan ENCRYPTED), model non-kosong. Response shape = GET. Audit `ai_config_update` (TANPA key).
3. `POST /api/sa/ai-config/test` body `{baseUrl?, apiKey?|null(=stored), model?}` → pakai `aiTestConnection`. Response `{ok, latencyMs, model}` / `{ok:false, code, message}`.
4. `GET /api/sa/ai-config/models?scope=cloud|local` → proxy list model dari baseUrl terkait (+key stored). Response `{models:[{name,sizeBytes}]}` / error code.
5. `POST /api/sa/ai-config/local-pull` body `{model}` → cek binary `ollama` ada (spawn `which ollama`); tidak ada → 400 `{error:"Ollama binary tidak ditemukan di host ini"}`. Ada → spawn DETACHED `ollama pull <model>` (log ke `/tmp/cb_ai_pull.log`), response `{started:true}`. **Validasi model name regex `^[a-zA-Z0-9._:\-\/]+$`** (anti-injection). Status cek = panggil ulang `models?scope=local`.
- Audit: `ai_config_update`, `ai_config_test`, `ai_config_pull` (SaAuditLog, tanpa secret).

## D. Endpoint Summary CS (src/routes/chats.js — additive)

**Template output bisa diatur admin tenant (Kanaka 21:25):**
- Preset sebagai konstanta `SUMMARY_PRESETS` di `src/services/llm.js` (satu sumber): `standard` (default 4 blok) | `ringkas` | `handoff` | `medis` | `penjualan` | `keluhan`.
- Resolusi template: row `TenantSummaryTemplate` tenant → `customText` non-kosong MENANG; kosong → `presetKey` tenant; tenant tanpa row → `AiConfig.defaultPreset` (platform default, SA set di panel AI).
- RAIL WAJIB (selalu ditambahkan setelah instruksi apapun): "Gunakan HANYA isi percakapan berikut. JANGAN mengarang fakta yang tidak ada di percakapan. Jawab dalam Bahasa Indonesia." + customText divalidasi ≤ 1000 char.
- Endpoint tenant template (guard role admin tenant; CS read-only): `GET /api/settings/summary-template` → `{presetKey, customText}`; `PUT /api/settings/summary-template` body `{presetKey, customText?}` → validasi presetKey ∈ daftar + customText ≤ 1000. Audit `summary_template_update` (tenant name, tanpa isi template).
- `POST /api/chats/summary-preview` (guard tenant admin) → body `{presetKey?, customText?}` (DRAFT, belum disave) → jalankan dgn transcript CONTOH yang di-bake in (bukan data pelanggan) → `{summaryText, latencyMs}`. Buat tombol "Uji dengan contoh".

`POST /api/chats/:id/summary` (middleware auth + tenant scope existing; chat wajib milik tenant → 404 kalau bukan):
- **Window semantics (locked, permintaan Kanaka):** transcript = pesan dengan `timestamp > chat.resolvedAt` (kalau resolvedAt NULL → semua pesan chat). Order asc. Cap: 200 pesan terakhir DALAM window, max 20.000 karakter (potong dari depan, sisipkan marker "(pesan awal dipotong)").
- Payload LLM: system prompt = template aktif (resolusi di atas) + RAIL WAJIB; user content = `{transcript}` + metadata (nama kontak, status chat, tanggal).
- Preset `standard` (default, plain text dengan heading):
  ```
  RINGKASAN: <2-4 kalimat kronologi>
  KEBUTUHAN CUSTOMER: <poin utk/permintaan>
  TINDAKAN CS: <sudah dilakukan apa>
  STATUS & LANGKAH LANJUT: <status sekarang + next step>
  ```
- Preset lain (instruksi lengkap di konstanta `SUMMARY_PRESETS`):
  - `ringkas`: 1 paragraf 3–5 kalimat merangkum seluruh sesi.
  - `handoff`: serah terima shift — status, yang SUDAH dilakukan, yang BELUM selesai, instruksi konkret utk CS berikutnya (bullet).
  - `medis`: keluhan/kebutuhan pasien, layanan/jadwal ditanyakan, harga dibahas, tindak lanjut (cocok Mazaya/Parahita).
  - `penjualan`: produk/layanan diminati, keberatan, harga/penawaran dibahas, next step closing.
  - `keluhan`: isi komplain, urgensi, solusi ditawarkan, status kepuasan saat ini.
- `custom` = instruksi bebas admin (≤1000 char, bahasa manusia) — menang atas preset kalau diisi; rails anti-halusinasi tetap ditambahkan.
- Response `{summaryText, templateUsed:'standard|ringkas|handoff|medis|penjualan|keluhan|custom', model, viaFallback:bool, latencyMs, window:{messageCount, from, to}}`. Modal render text apa adanya (newline preserved; heading di-bold kalau templateUsed=standard — parsing sederhana baris `NAMA:`; NO v-html).
- **Cooldown 30 detik per chat** (in-memory Map chatId→ts) → 429 `{retryAfter:30}`.
- Config belum diset → 400 `{error:"AI belum dikonfigurasi. Hubungi admin platform."}`.
- JANGAN ubah endpoint/handler existing di chats.js. Tidak menulis ChatEvent baru (analytics tidak tersentuh).
- Simpan summary = REUSE endpoint catatan existing (`ChatNote` — sudah ada route-nya); frontend yang memanggil. ZERO schema tambahan.

## E. Frontend
### E1. `SaPengaturan.vue` — panel baru "AI Assistant" (di bawah Branding Platform)
- Field: Base URL (default `https://ollama.com`), API Key (password input; placeholder `••••1234` kalau sudah ada + tombol "Ganti Key"), tombol **Tes Koneksi** (tampil `OK — 2.1s · model` atau pesan error ramah).
- Tombol **Muat Daftar Model** → GET models → `<select>` model keisi (manual input fallback kalau list gagal). Simpan → PUT (key cuma dikirim kalau diisi).
- Sub-panel **Fallback Lokal**: toggle `fallbackEnabled`, Base URL lokal (default 127.0.0.1:11434), model lokal (select dari Muat Daftar Model scope=local), badge status ping (`Ollama lokal: tersedia ✓ / tidak terdeteksi`), tombol **Pasang model lokal (on-demand)** → dropdown preset (`qwen3:4b`, `qwen2.5:3b-instruct`, `llama3.2:3b`) + tombol → response `{started}` → hint "berjalan di background; cek status via Muat Daftar Model". JANGAN auto-download.
- Field tambah: **Format default platform** (select 6 preset; disimpan `AiConfig.defaultPreset`) — dipakai tenant yang belum pernah set template.
- Saving states + inline error semua tombol; tidak ada alert().

### E2. Chat view (komponen chat area — Dory locate: ChatBox.vue / view chat utama)
- Tombol ikon 🤖/✨ di area aksi chat (dekat resolve/notes) — visible hanya chat open (resolved → tombol tetap ada tapi window-nya kosong → disabled + tooltip).
- Klik → loading state (spinner + "Merangkum…") → modal "Summary Sesi": render `summaryText` (newline preserved; template standard = heading 4 blok di-bold), footer `{model · template · via fallback · Xs}` + tombol **Salin Semua** (clipboard) + **Simpan ke Catatan** (POST catatan existing, body = formatted text; optional) + Tutup/Regenerate (regenerate = re-call; kena cooldown 429 → tampil sisa detik).
- Error state inline: NO_CONFIG (arahkan ke admin), TIMEOUT/NETWORK (coba lagi), 401 ("API key tidak valid").
- Mobile responsive; skeleton/loading ≤ 60s dengan indikator berjalan.

### E3. Pengaturan tenant admin — panel "Format Summary AI"
- Lokasi: halaman pengaturan existing milik admin tenant (Dory locate — tempat AppConfig/read receipts dikelola).
- Isi: preset picker (radio cards 6 preset) + textarea "Instruksi sendiri (bahasa bebas)" + counter 1000 char + tombol **Uji dengan contoh** (call `summary-preview`; hasil tampil di inline preview box) + Simpan.
- customText non-kosong → badge "Mode: instruksi sendiri"; kosong → "Mode: preset {nama}". CS lihat read-only indikator mode (bukan edit).
- Render di-escape (no v-html — pola audit v3.9.19).

## F. E2E (`scripts/e2e-v3919.cjs` — tambah section N; mock LLM deterministic)
- **Mock server** di `127.0.0.1:11435` (dari script E2E sendiri): `GET /api/tags` → 2 model canned; `POST /api/chat` → parse prompt yang diterima, balik fixed content + ECHO marker jumlah pesan yg diterima (buat assert window). Timeout-safe.
- N1: PUT ai-config (baseUrl=mock, key=test-key-123456) → 200; GET → hasKey true + keyMasked (last4 "2345") + key TIDAK muncul.
- N2: POST test → ok true + latencyMs number.
- N3: GET models → array 2 + tidak ada key.
- N4: seed chat dgn 5 pesan (t1..t5) + resolvedAt=t3 → POST summary → 200; assert marker = hanya pesan t4,t5 (window benar); chat kedua tanpa resolvedAt → marker = 5 pesan.
- N5: cooldown → call kedua langsung → 429.
- N6: guard → user tenant lain → 404; CS tanpa AI config (row dikosongkan sementara) → 400 NO_CONFIG.
- N7: Simpan-ke-catatan via endpoint catatan existing → row ChatNote muncul (SELECT-back verify — lesson #4).
- N8: fallback path: fallbackEnabled + cloudBaseUrl diarahkan ke port mati → summary tetap 200 via local (mock), `viaFallback:true`.
- N9 template: GET template default → standard; PUT tenant template preset=medis → summary echo instruksi medis (mock echo); PUT customText → summary echo customText; preview endpoint → 200 dgn sample; customText >1000 → 400; CS role PUT → 403; tenant lain → 404.
- 73 check existing WAJIB tetap PASS (additive murni).

## G. Hard prohibitions (standard)
- No destructive DB (`--force-reset`/DROP/rm DB). Migration HANYA additive di atas.
- Jangan sentuh: `apiV1.js`, `analytics.js`, csat, autoReply, menuGateway, `src/auth.js`, `.env`, config existing, SaSidebar/SaOverview/SaTenants/SaAudit, router split. `chats.js` & `superadmin.js` = additive murni.
- Key TIDAK BOLEH: ke-print di log/response/CHANGELOG; plaintext di DB; hardcoded di repo. E2E mock key = dummy.
- No restart prod 5047; no git commit/tag; no browser; kill hanya PID server-copy sendiri (5099, DATABASE_URL eksplisit `file:/tmp/saas-v3-e2e.db` — WAJIB, lesson v3.9.19).
- Tidak ada callback/network ke OpenClaw (127.0.0.1 gateway port, dll) — fitur mandiri.

## Gates (Dory lapor semua)
1. `npx vite build` exit 0
2. `node --check` semua file backend yang disentuh
3. E2E ALL PASS (73 lama + N1–N8) di copy DB 5099
4. Post-verify fresh curl (copy): GET ai-config masked; POST summary dgn mock → window marker benar; local-pull tanpa binary → 400 message jelas
5. CHANGELOG v3.9.23 + daftar file diubah + deviasi spec (kalau ada)

## Deploy (Alita, pasca-GO+audit)
1. Backup DB → apply migration via `npx prisma migrate deploy` → verify PRAGMA table AiConfig
2. Vite rebuild (snapshot public-pre-build-<ts>) → restart by-PID → health 200
3. Visual QA 18801 (copy DB): panel AI Assistant (key masked, tes koneksi ke MOCK — key asli JANGAN dipakai di QA), tombol summary + modal, mobile 390px
4. Commit + tag v3.9.23 + push GitHub
5. Config asli diisi Kanaka sendiri via Pengaturan (key terpisah — Kanaka yang pegang); default model saran = glm-5.3-flash