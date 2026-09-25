# v3.9.25 — FEATURE: AI Hybrid Gateway Routing (LLM classifier fallback untuk Menu Gateway)

**Status: GO — Kanaka 03:18 ("laksanakan implementasinya deh").** Pro/Max ✓ Lite ✗ OK
(D5 final). **AMANDEMEN D5a (Kanaka 03:18):** superadmin JUGA bisa toggle aiHybrid
sendiri per-tenant — via `PUT /api/menu-gateway?tenant=<id>` (path existing sudah
menerima super_admin dengan `?tenant=`, lihat header routes/menuGateway.js) + toggle
di panel SA detail tenant. Plan gate tetap berlaku utk SEMUA aktor (plan ✗ → toggle
disabled + hint upgrade — konsisten, gak ada backdoor).
**Baseline:** `27d0c66` (v3.9.24 released + USER-VERIFIED).
**Origin:** diskusi Kanaka 2026-09-26 03:00–03:09 (Telegram), trigger case nyata **Mazaya**:
routing gateway strict (keyword/nomor) — customer nulis kalimat natural → gak kena →
langsung masuk antrean fallback padahal maksudnya jelas.

---

## 1. Masalah

Menu gateway sekarang match **strict** (`normalizeAnswer` → `matchOption`,
services/menuGateway.js:315/329): customer harus bales **angka** (1..8) atau ketik
**keyword** yang persis ada di aliases. Customer yang nulis
*"kak besok bisa jam berapa ya buat fisio?"* → gak kena apa-apa → masuk fallback
(fallbackText + antrean) padahal maksudnya jelas: rute booking.

## 2. Solusi (satu kalimat)

Kalau jawaban customer **gak kena** keyword/angka DAN tenant menyalakan AI Hybrid,
sistem tanya LLM (classifier murni) *"pilihan mana yang paling cocok?"* → LLM balikin
`{position, confidence}` → sistem eksekusi **rules lama persis** (tag + replyText resmi).
**LLM TIDAK PERNAH menyusun pesan ke customer.**

## 3. Keputusan terkunci (semua dari diskusi dengan Kanaka)

- **D1 — HYBRID, BUKAN REPLACE:** keyword/angka match **SELALU jalan duluan**
  (instan, 0 cost, LLM tidak menyala). LLM hanya dipanggil kalau `matchOption()`
  gak kena. Traffic yang ke-kernel keyword = gratis 100%.
- **D2 — LLM = CLASSIFIER MURNI:** output hanya sinyal `{position, confidence}`.
  Sistem yang n-tag + kirim replyText. Halusinasi mustahil nyampe ke customer —
  salah pilih route pun, yang terkirim tetap pesan resmi tenant.
- **D3 — CONFIDENCE GATE (revisi 03:16 — usulan Kanaka):** threshold **per-tenant
  configurable**: kolom baru `MenuGatewayConfig.aiThreshold REAL @default(0.70)`.
  Validasi 0.50–0.95. `confidence < threshold` → JANGAN route → fallback perilaku lama
  (fallbackText + fallbackTagId + antrean awaiting). Default 0.70 = zona "Seimbang".
  UI = slider + 3 preset + keterangan dinamis makna/konsekuensi (§7b) — admin paham
  apa yang dia setel. Angka ekstrem DIBLOKIR (mis. 0.30 = "route hampir semua pesan"
  = bahaya salah kamar; 1.0 = AI tak pernah route). Lebih baik gagal aman daripada
  salah kamar.
- **D4 — OUTPUT TERKUNCI:** prompt minta JSON ketat `{position:int, confidence:0..1}`;
  parse + validate (position 1..N options aktif, confidence finite). Gagal parse /
  position 0 / out-of-range → perlakukan SAMA dengan no-match → fallback lama.
  Output "nyasar" mustahil dieksekusi.
- **D5 — TOGGLE 2 LAPIS (usulan Kanaka, 03:07; SA toggle = amandemen 03:18):**
  - Flag plan baru **`featAiRouting`** (TenantPlan, additive): preset
    **Lite ✗ / Pro ✓ / Max ✓** → AI hybrid jadi fitur premium (upsell naik plan).
  - Toggle per-tenant **`MenuGatewayConfig.aiHybrid`** (Boolean, **default FALSE**):
    perilaku lama persis, 0 cost, 0 risiko sampai tenant sadar menyalakan.
  - Plan ✗ → toggle hidden/disabled di UI + `PUT aiHybrid=true` → **403 upsell**
    (pola feat gate yang sudah ada).
  - **D5a — SA toggle:** superadmin dapat flip `aiHybrid` per-tenant dari panel SA
    (PUT via `?tenant=` impersonation — path existing); plan gate tetap mengikat
    semua aktor termasuk SA.
- **D6 — GRACEFUL DEGRADATION:** LLM gagal/timeout (8s)/error/NO_CONFIG →
  jatuh ke perilaku lama. Gak crash, gak pesan ngawur. Row `AiUsageLog ok=false`
  tetap tercatat untuk observability. AI-nya bonus, bukan tulang punggung.
- **D7 — METERING + COST TRANSPARAN:** source baru **`'gateway'`** di AiUsageLog
  (perluas whitelist `['summary','preview','test']` di `logAiUsage`). `GET /api/menu-gateway`
  include `aiUsage: {calls, costUsd, costRp}` bulan berjalan (WIB, tenant ini) →
  tampil di dekat toggle ("≈ Rp X bulan ini — metering otomatis"). Tenant gak pernah kaget.
- **D8 — DESKRIPSI AI PER OPSI:** kolom baru **`MenuGatewayOption.aiDescription
  String @default("")`** (≤200 char). Ini yang bikin LLM paham KONTEKS route
  ("rute buat pasien mau booking jadwal terapi"), bukan cuma keyword.
  Kosong → prompt pakai fallback `label + aliases`.
- **D9 — KONTEKS CHAT MINIMAL:** prompt include **max 8 pesan terakhir** (teks saja;
  media → "[media]") + introText. Tidak lebih (L2 conversational penuh = parked).
- **D10 — NON-GOALS (parked, TIDAK di v3.9.25):** auto-tagging, sentiment/eskalasi,
  draft CS, smart follow-up (L3); AI jawab otonom (L4 — **NO** untuk domain klinik).
  Juga parked: threshold configurable UI, model AI per-tenant pilihan.

## 4. Flow runtime (anchor kode nyata)

1. Pesan customer masuk saat awaiting → `handleChoice()` (services/menuGateway.js:373)
2. `normalizeAnswer()` + `matchOption()` — **path lama 100% utuh**: angka exact →
   option; keyword → option. Match → eksekusi lama. (Tidak ada perubahan di sini.)
3. **Gak kena** && `cfg.aiHybrid` && plan `featAiRouting` ✓ && AiConfig ada key →
   `classifyRoute()` (fungsi baru di services/menuGateway.js)
4. `classifyRoute()`: bangun prompt (routes + history ≤8) →
   `aiChat({ source:'gateway', tenantId, chatId, timeoutMs:8000 })`
5. Parse `{position, confidence}` → valid && confidence ≥ 0.70 → jalankan
   **fungsi eksekusi yang SAMA** dengan pilihan normal:
   `tagContactAndMirror()` + `sendAutoMessage(option.replyText)` — bukan duplikat logic.
6. else → path lama persis: `queueChatAfterMenu()` (fallbackText + fallbackTagId + awaiting).

**Prinsip:** LLM hanya substitusi langkah "pilih opsi". Eksekusi = kode yang sama 100%.

## 5. Schema changes (migration SATU, additive murni)

- `MenuGatewayConfig.aiHybrid Boolean @default(false)`
- `MenuGatewayConfig.aiThreshold REAL @default(0.70)` — confidence gate per-tenant
  (0.50–0.95; slider UI + preset, lihat D3/§7b)
- `MenuGatewayOption.aiDescription String @default("")`
- `TenantPlan.featAiRouting Boolean @default(false)` + preset Lite✗ Pro✓ Max✓
  (file preset plan, bukan data migrasi)

Zero DROP / zero ALTER destruktif. Perilaku existing 100% terjaga (default OFF).

## 6. API changes (`src/routes/menuGateway.js` — additive)

- `PUT /api/menu-gateway`: + `aiHybrid` (bool strict) + `aiThreshold` (number 0.50–0.95,
  reject di luar range) + `options[].aiDescription` (string ≤200, trim). Plan ✗ +
  `aiHybrid=true` → 403 ramah + upsell. (`aiThreshold` boleh diset walau aiHybrid OFF —
  pre-set sebelum menyalakan.)
- `GET /api/menu-gateway`: + `aiHybrid`, `aiThreshold`, `options[].aiDescription`,
  `aiUsage: {calls, costUsd, costRp}` (AiUsageLog source='gateway', tenant ini,
  bulan WIB berjalan; plan ✗ → `aiUsage: null`).
- Field unknown tetap DITOLAK 400 (extend `ALLOWED_TOP_FIELDS`/`ALLOWED_OPTION_FIELDS`).

## 7. Frontend (panel Menu Gateway, admin tenant)

- Section baru **"AI Hybrid Routing (Beta)"**: toggle (disabled + upsell bila plan ✗),
  1 kalimat penjelasan ("Kalau jawaban customer gak kena keyword, AI pilihkan rute —
  balasan tetap pesan resmi kamu"), hint biaya ("≈ Rp X bulan ini — metering otomatis"),
  per-opsi textarea kecil "Deskripsi AI (opsional, ≤200)" + placeholder contoh.
- TANPA v-html. Tidak ada halaman baru. Pola UI mengikuti panel existing.

### 7b. Threshold UI (slider + preset + penjelasan dinamis — usulan Kanaka 03:16)

Slider `aiThreshold` (0.50–0.95, step 0.05) + **3 preset klik-instal** dengan
label + konsekuensi:

| Preset | Nilai | Keterangan yang tampil |
|---|---|---|
| **Longgar** | 0.55 | "AI lebih berani menyala — lebih banyak percakapan tersalur otomatis. Risiko salah rute naik."
| **Seimbang** (default) | 0.70 | "AI menyala kalau cukup yakin; ragu → antrean CS. Titik awal terbaik."
| **Ketat** | 0.85 | "AI cuma menyala kalau sangat yakin — lebih aman, tapi lebih banyak pesan jatuh ke antrean CS manual."

**Penjelasan dinamis di bawah slider** (ikut nilai terpilih, update real-time):
- "Angka = seberapa yakin AI minimal sebelum menyuruh sistem menyuruhkan percakapan."
- "**≥ {t}** → AI salurkan otomatis: tag + balasan resmi kamu terkirim."
- "**< {t}** → AI diam. Pesan masuk antrean CS seperti biasa (perilaku tanpa AI)."

**Info box tetap (selalu tampil):**
> "Semakin tinggi = semakin selektif AI. Dan aman di titik mana pun: AI **tidak pernah
> menulis balasan sendiri** — salah rute sekalipun, yang terkirim tetap pesan resmi
> yang kamu setel."

Slider disabled + upsell bila plan ✗; boleh disetel walau toggle masih OFF (pre-set).

## 8. Prompt classifier (draft)

```
System: Kamu classifier routing menu WA. Pilih nomor opsi yang paling cocok
dengan pesan customer. Balas HANYA JSON: {"position": <int>, "confidence": <0..1>}.
Tidak ada yang cocok → {"position": 0, "confidence": 0}.
Daftar opsi:
1. Komplain — rute keluhan layanan/pelayanan (keywords: komplain,keluhan)
2. Ambil hasil — rute pasien mau ambil hasil lab/terapi (keywords: hasil,ambil)
...
User: [history ≤8 pesan, "Customer: ..." / "CS: ..."] Pesan terakhir: "..."
```

## 9. E2E (`scripts/e2e-v3925.cjs`, mock LLM 127.0.0.1:11435 — pola v3.9.24)

- N1 keyword match → **0 LLM call** (0 row source 'gateway') — fast-path terbukti.
- N2 no-match + toggle OFF → fallback lama + 0 row.
- N3 no-match + ON → row 'gateway' + snapshot cost + tag + replyText TERKIRIM persis.
- N4 mock confidence 0.55 → fallback lama di default 0.70 (gak route); PUT
  `aiThreshold=0.50` → call baru SAMA → **route** (threshold setting terbukti efektif).
- N4b mock confidence 0.4 → fallback lama (gak route).
- N5 mock position 9 (out-of-range) → fallback lama.
- N6 mock 500 → fallback lama + row ok=false (D6).
- N7 plan ✗: PUT aiHybrid → 403; runtime gak call LLM; **N7b SA impersonation:
  SA + `?tenant=<plan✗>` toggle aiHybrid → 403 JUGA (plan gate menang); SA +
  `?tenant=<plan✓>` → 200 (SA toggle terbukti).**
- N8 aiDescription kosong → prompt pakai label+aliases (assert via mock capture).
- N9 `aiUsage` bulan ini benar (calls/cost/costRp).
- N10 validasi PUT: aiDescription 201 char → 400; aiHybrid "yes" → 400;
  aiThreshold 0.49 / 0.96 / "0.7" (string) → 400; aiThreshold 0.85 valid → 200 echo.
- **Regresi:** e2e-v3924 (72) + e2e-v3919 (121) tetap PASS.

## 10. Batasan keras (SAMA dgn v3.9.24 — wajib di spec Dory)

- Migration **ADDITIVE-ONLY**. NEVER `--force-reset` / `--accept-data-loss` /
  DROP / DELETE / UPDATE schema / rm DB. Kalau tool minta reset → **STOP & report**.
- **Prod (5047) JANGAN disentuh**: no restart, no commit, no migrate. Testing di
  copy DB (`/tmp/saas-v3-e2e.db`) + port 5099 + `WA_DISABLED=1`.
- No v-html. Key/token TIDAK PERNAH masuk log/audit/E2E output.
- Protected files tidak boleh disentuh; diff hanya file yang diizinkan spec ini.

## 11. Estimasi biaya per skenario traffic (glm-5.3-flash, kurs 16000)

Prompt ≈ 600 token (daftar route + history) + output ≈ 20 token →
**≈ $0.0001/call ≈ Rp 1.6/call.**

| Skenario | Pesan/bulan | % no-match (LLM) | Call/bulan | Biaya/bulan |
|---|---|---|---|---|
| Klinik kecil (kasa Mazaya) | 300 | 30% | 90 | **≈ Rp 145** |
| Klinik sedang | 1.000 | 30% | 300 | ≈ Rp 480 |
| Besar | 3.000 | 40% | 1.200 | ≈ Rp 1.900 |

Keyword fast-path = gratis. Biaya LLM routing gak akan nembus Rp 2rb/bulan bahkan
di traffic besar. (Konservatif; angka bisa dipantau live di panel AiUsage.)

## 12. Rollout plan

- Deploy: default OFF semua tenant → behavior lama 100% sampai tenant menyalakan sendiri.
- Setelah QA lulus: tawarkan aktifasi ke **Mazaya** (case asli pemicu) — manual, by request.

## 13. Keputusan — SEMUA FINAL lewat diskusi Kanaka (03:13–03:18)

- ✅ aiDescription = OPSI, default prompt pakai label+aliases (03:13)
- ✅ Threshold per-tenant configurable + slider/preset/keterangan (03:16, D3 revisi)
- ✅ Pro/Max ✓ Lite ✗ (03:18)
- ✅ SA juga bisa toggle sendiri per-tenant (03:18, D5a)
- Nama fitur di UI: **"AI Hybrid Routing"** (tidak keberatan — default dipakai)

**GO diberikan 03:18 → implementasi (Dory) dimulai.**

— Alita, 2026-09-26 03:12 WIB