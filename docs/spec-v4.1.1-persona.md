# SPEC v4.1.1 — CB-AI Persona + Counter transparan (GO Kanaka 14:00)

> **Status: GO ("iya Tambahin pengaturan persona yaa").** Trigger QA Kanaka 13:35 (quirk #2 personifikasi + quirk #1 counter tak terlihat). Bonus info QA: badge 🤖 di chat list sudah terlihat berfungsi (Kanaka 14:00).

## Keputusan terkunci

| # | Keputusan |
|---|---|
| D1 | **3 field persona baru** (per tenant, kartu "Pengaturan ChatBareng AI" di AdminAiKnowledge): `cbaiBotName` (nama bot), `cbaiBotRole` (bekerja di mana/bisnis apa — teks bebas ≤120), `cbaiHumanAgentLabel` (label agent manusia, default "" = perilaku lama). |
| D2 | **Inject ke prompt** di `answerFromKnowledge` (dipakai AR cbai + gateway ai_knowledge + trial sama — semua lewat satu pintu): blok persona BARU sebelum `<knowledge>`. Hanya bagian yang terisi yang ikut. Kosong semua = prompt PERSIS v4.1.0 (golden-compare E2E). |
| D3 | **Instruksi handoff:** bila `cbaiHumanAgentLabel` terisi → tambahkan instruksi "bila perlu merujuk penyerahan ke manusia/agent, sebut sebagai {label}" — fix "Nanti akan dibalas CS Manusia" generik. Kosong → instruksi ini TIDAK disuntik (perilaku lama). |
| D4 | **Fallback deterministik TIDAK diubah** (greetText/outsideHoursText tenant-configured — persona hanya menyentuh jawaban AI). |
| D5 | **Counter transparan (quirk #1), tanpa kolom/logic baru:** (a) kartu CB-AI (AdminAiKnowledge) tampilkan "Terpakai bulan ini: N jawaban · ≈ Rp X" dari `aiUsage` yang SUDAH dikembalikan GET config; (b) AdminAutoReply + AdminMenuGateway: hint kecil di bawah/near slider AI "Limit per chat · reset 24 jam — chat baru mulai dari 0" (edukasi; angka live per-chat = v2, butuh endpoint per-chat). |
| D6 | **Migration SATU additive:** `2026092614000000_cbai_persona` — 3 ADD COLUMN ke `AutoReplyConfig` (semua TEXT NOT NULL DEFAULT '') + schema.prisma sync. 0 DROP. |
| D7 | Non-goals (parked v2): voice/tone slider, multi-persona, persona per-opsi gateway, counter live per-chat. |

## Implementasi
1. **Migration** `prisma/migrations/2026092614000000_cbai_persona/migration.sql` — 3 ADD COLUMN + schema.prisma sinkron (format+validate+generate).
2. **`src/services/aiKnowledge.js`:** `buildPersonaBlock(cfg)` (pure function; return '' bila kosong semua) — disuntik di `answerFromKnowledge` prompt (system/user content) untuk SEMUA mode (cbai/ai_knowledge/trial — konsisten). Label manusia → kalimat handoff.
3. **Routes:** `autoreply.js` PUT whitelist +3 field (string, trim, cap 120 — liar → 400) + GET echo; GET `ai-knowledge` config ikutkan 3 field (sudah selekt * — tambah saja); menuGateway path baca config AR existing → persona otomatis ikut.
4. **FE:** `AdminAiKnowledge.vue` — 3 input di kartu Pengaturan + baris terpakai (D5a); `AdminAutoReply.vue` + `AdminMenuGateway.vue` — hint counter (D5b). Tanpa v-html.
5. **E2E `scripts/e2e-v4110.cjs`** (server copy 5099, pola v4100/v4000; WA_DISABLED=1 + E2E_OK_SEND=1 + E2E_DEBUG_INBOUND=1; mock LLM :11435 capture prompt):
   - N1 persona lengkap → prompt capture mengandung nama/role + instruksi handoff dgn label kustom
   - N2 persona kosong → prompt IDENTIK pola v4.1.0 (golden compare — backward-compat)
   - N3 PUT validasi: >120 char → 400; tipe liar → 400; valid → 200 + GET echo
   - N4 runtime AR covered dgn persona → jawaban terkirim (stub) + counter=1 + metering row
   - N5 trial tetap jalan (persona ikut di prompt trial — tidak counter)
   - **Regresi penuh: e2e-v4100 (32) + e2e-v4000 (78) + e2e-v3925 (59) + e2e-v3924 (72) + e2e-v3919 (121)**
6. **Gates & deploy** pola v4.1.0: node --check, vite build exit 0 (log penuh), migration additive 0 DROP → backup → migrate deploy → restart by-PID → smoke (401, health, 3 slot) → commit + tag `v4.1.1` → push (script tag-loop `^v[34]\.`).

**Catatan:** QA Kanaka 14:00 — badge 🤖 di chat list verified berfungsi (chat yang dibalas CB-AI kelihatan). Kanaka akan re-test limit 3x sendiri — counter transparan (D5) bikin hasilnya kelihatan.