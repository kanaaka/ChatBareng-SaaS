# Spec v4.2.0 — Auto Reply Per-Slot Override (dropdown scope + Custom/Default + Reset)

> **Request Kanaka (voice note 15:31, diratifikasi chat 15:48-15:49):** Auto Reply jadi per-slot basis — slot 1 & slot 2 bisa sama-sama pakai teks auto-reply dgn TEMPLATE BEDA + jam kerja beda. Mekanisme: slot tanpa row = **mirror Default**; pilih slot → form prefilled dgn nilai Default; Save = slot jadi **Custom** (row dibuat); "Reset ke default" = row di-delete (kembali mirror). KB & persona AI tetap tenant-wide (jawaban #1/#2/#3 + konfirmasi override GO 15:49).

## 0. Fondasi yang SUDAH ADA (jangan diubah semantiknya)

- Schema `AutoReplyConfig` (prisma/schema.prisma:559+): shared row (`numberSlot = null`) + per-slot rows (`@@unique(tenantId, numberSlot)`, slot 0..2). Field: outsideHours* (Enabled/Text/Mode), greet* (Enabled/Mode/Text), jam kerja per tipe hari (monFri/sat/sun × Enabled/Start/End HH:mm WIB), repeatFrequency, CB-AI SHARED fields (`cbaiLimit/InfoFooter/BotName/BotRole/HumanAgentLabel/Disclaimer/UpsellEnabled/UpsellDocId/EndText`).
- Runtime resolve per-slot SUDAH benar: `getConfigForSlot()` (src/services/autoReply.js:78) — slot row menang; tidak ada → fallback shared; CB-AI fields SELALU overlay dari shared (`CBAI_SHARED_FIELDS` L74 — shared MENANG di field itu). **Runtime tidak diubah.**
- Kredensial: `GET /api/wa/status` → `slots[]` berisi `{slot, label (custom), status, chatCount, _synthetic}` (src/routes/wa.js:47) + slot-0 synthetic selalu ada.

## 1. Perubahan semantik inti (THE CORE)

**LAMA (tick-box):** form satu → centang slots → save: upsert rows tercentang + **SHARED DINETRALKAN** (trigger OFF) + slot tak tercentang di-DELETE. Shared = saklar induk.

**BARU (dropdown + override):** shared row = **"Default"** — SELALU meaningful (baseline untuk semua slot tanpa row sendiri). Slot dgn row sendiri = **"Custom"** (fully independent — teks/jam/mode sendiri, per jawaban Kanaka #1: "slot 2 tetep bisa pakai teks auto reply regardless yang ada di slot 1").

Akibat semantik (WAJIB dipahami Dory):
1. Save Default → **HANYA update shared row** — ZERO cascade (TIDAK menetralkan, TIDAK menghapus row slot apa pun).
2. Save Slot N → **upsert row per-slot** — TIDAK menyentuh shared, TIDAK menyentuh row slot lain.
3. Reset Slot N → **DELETE row per-slot** — slot kembali mirror Default.
4. Legacy tick-box PUT (numberAll/numberSlots array + netralisasi + delete cascade) **TETAP ADA byte-kompatibel** untuk compat lama — tapi FE baru TIDAK PERNAH memakainya. Jangan hapus, jangan ubah perilakunya (regression gate).

## 2. API — endpoint BARU (additive; GET/PUT legacy tidak diubah)

Semua admin-only (`...rt`), pola validasi-first ketat (field asing → 400, pola ALLOWED set existing). Semua write → `invalidateConfig(tenantId)` + `updatedById`.

### 2.1 `GET /api/autoreply/options` (BARU)
Data dropdown. Response:
```json
{ "slots": [ {"slot":0, "label":"Klinik Laboratorium Parahita", "custom":true, "menuManaged":false},
             {"slot":1, "label":null, "custom":false, "menuManaged":true} ],
  "defaultExists": true }
```
- Sumber slot + label: `wa.listTenantNumbers(tenantId)` (label custom per-slot; `_synthetic` slot-0 bila belum ada baris — pola persis GET /api/wa/status; SYNTHETIC label null).
- `custom`: punya row `numberSlot = slot` non-menu (scoped); `menuManaged`: row `greetMode === 'menu'` (reuse `listSlotsWithConfig` — ia sudah return scoped + menuManaged).
- Gagal wajib 200 dgn array kosong-bijak (jangan 500 liar).

### 2.2 `PUT /api/autoreply/default` (BARU)
Whitelist = semua field kecuali scope-fields (`numberAll/numberSlot/numberSlots`) dan TANPA CB-AI shared fields di slot. Validasi reuse penuh: `validateTextField` (≤1000, placeholder {name}), `validateHours` (TIME_RE), enum modes (`GREET_MODES`/`OUTSIDE_MODES`; menu/cbai memaksa greetEnabled=true — pola existing), `cbaiUpsellDocId` kepemilikan doc, `repeatFrequency` enum, plan-gate cbai (featAiKnowledge ✗ → 403 upsell, pola existing). Update shared row by id (`findFirst numberSlot null`), `updatedById`. TANPA delete/touch apa pun lain.

### 2.3 `PUT /api/autoreply/slot/:slot` (BARU)
- `:slot` 0..2 → 400 selain itu. **409** bila row slot itu menu-managed (error teks persis pola existing: "matikan menu untuk slot itu di halaman Menu Gateway dulu…").
- Whitelist KESEL: trigger fields (outsideHours*, greet*, jam harian, repeatFrequency) + `outsideHoursMode`/`greetMode`. **CB-AI SHARED fields DITOLAK 400** dgn error eksplisit: `"cbaiBotName dll diatur di Default (Semua nomor) — KB & persona tetap tenant-wide"` (hindari jebakan overlay shared-menantang — spec §0). Modes cbai tetap boleh + plan gate 403 (pola existing).
- Upsert row `{tenantId, numberSlot: slot}`; bila slot BUKAN menu-managed dan row belum ada → create. `updatedById`. TIDAK menyentuh shared/row lain.

### 2.4 `DELETE /api/autoreply/slot/:slot` (BARU — reset ke default)
- 409 bila menu-managed. Delete row by `tenantId_numberSlot` (P2002-safe: deleteMany by where). Response `{ ok: true, slot }`. Invalidate cache.

### 2.5 `GET ?slot=N` existing — TAMBAHAN additive 2 field saja di response: `custom` (bool: punya row sendiri non-menu) + `menuManaged` (bool). Bentuk existing tidak diubah (regression).

## 3. FRONTEND — rework `AdminAutoReply.vue` (443 L)

1. **Bar atas BARU**: label "Pengaturan untuk:" + dropdown (M3-style konsisten halaman): opsi `Default (Semua nomor)` + satu opsi per slot: `{label | 'Slot N'}` + badge 🟣 `Custom` (punya row) / 🔗 (ikut default, label kecil abu) / badge `menu` ungu utk menu-managed (disabled + tooltip ke halaman Menu Gateway — pola existing menuManagedSet). Data dari `GET /options`; fetch ulang tiap sukses save/reset.
2. **Prefill mirror**: pilih slot tanpa row → form diisi nilai EFEKTIF (`GET ?slot=N` — sudah merge fallback shared + overlay CB-AI) + banner info: *"Nomor ini masih mengikuti Default — menekan Simpan akan membuatnya Custom."* Badge/banner hilang setelah save sukses.
3. **Save bar**: tombol Simpan; slot custom → + tombol `Reset ke Default` (tonal, konfirmasi modal tipis: "Kembalikan pengaturan nomor ini ke Default? Pengaturan khususnya akan dihapus." + Batal/Reset) → DELETE §2.4 → form kembali ke mirror + banner.
4. **CB-AI section (KB, persona, limit, footer, disclaimer, upsell, endText)**: HANYA tampil di view Default (edit → PUT §2.2). Di view slot → panel ringkas read-only: "🧠 Pengaturan AI (KB, persona, batas) diatur di Default — sama untuk semua nomor" + tombol link "Buka Default" (ganti dropdown view). Mode radio cbai per-slot TETAP ada (outsideHoursMode/greetMode = trigger-level).
5. **Tick-box lama DIHAPUS dari UI** (numberAll/numberSlots tidak lagi dikirim; struktur kode lama yang menampilkan form pertama-tercentang diganti logic view-scope).
6. Toast sukses/error konsisten halaman; loading state dropdown; role admin.
7. **TIDAK diubah**: file selain `AdminAutoReply.vue` di FE; halaman Menu Gateway; Dashboard; sembol/label warna existing.

## 4. Verifikasi (GATES — wajib)

1. Backend: `node --check` semua file BE yang diedit; FE: `npx vite build --outDir /tmp/v420-verify --emptyOutDir` exit 0 (PROD `public/` JANGAN di-build).
2. **e2e BARU `scripts/e2e-v420.cjs`** (copy-DB :5099 pola v4121; kill PID sendiri; superadmin reset + dotenv `. ./.env`). Minimal checks:
   - O: options → label custom + custom/menuManaged flags benar (setelah save test).
   - S1 default save: PUT /default (ubah greetText + jam monFri) → row shared berubah; TIDAK ada row slot baru; slot lain row-nya utuh.
   - S2 slot save: PUT /slot/0 dgn outsideHoursText beda + jam beda → row per-slot dibuat; GET ?slot=0 `custom:true`; PUT /slot/1 → row slot-1 terpisah dgn isi sendiri (2 template beda hidup berdampingan — INTI FITUR).
   - S3 reset: DELETE /slot/1 → row hilang → GET ?slot=1 `custom:false` + effective == shared; DELETE slot tanpa row → 404/409 konsisten (pilih salahsatu, dokumentasikan).
   - S4 menu-managed: seed row greetMode='menu' slot-0 → PUT /slot/0 409 + DELETE /slot/0 409 (save & reset terlindungi).
   - S5 CB-AI guard: PUT /slot/0 dgn `cbaiBotName` → 400 "diatur di Default"; PUT /default dgn cbaiBotName valid → 200.
   - S6 plan gate: tenant Lite preset copy → PUT slot mode cbai → 403 (polanya existing).
   - S7 invalid: slot=3/abc → 400; TIME_RE jam ngawur → 400; field asing → 400.
   - S8 runtime: langsung `getConfigForSlot(tenant, 0)` sebelum & sesudah reset — mirror kembali ke shared (cache-invalidation terbukti).
   - S9 kompat: tenant legacy (shared dinetralkan + 2 slot rows seperti bekas tick-box) → GET options benar (custom=2); runtime slot tanpa row = trigger OFF (netral shared) — perilaku lama utuh.
   - S10 CB-AI overlay: slot custom + shared persona → jawaban/echo persona tetap milik shared (CBAI_SHARED_FIELDS menang) — KONSISTEN DGN KB-SHARED keputusan Kanaka #2.
   - S11 regresi in-file: cbaiEndText 501 char → 400; PUT /autoreput legacy numberSlots array masih jalan 200 (byte-compat jalur lama).
3. Regresi standar: e2e-v4121 **61/61 PASS** (copy-DB dance dari header script; skip prisma db execute bila kolom sudah ada).

## 5. HARD PROHIBITIONS (pelanggaran = STOP & lapor)

1. NEVER `--force-reset / --accept-data-loss / DROP / TRUNCATE / rm` pada DB/data (prod maupun copy); tool minta reset → STOP & lapor.
2. No restart prod 5047; kill hanya PID yang kamu spawn sendiri (server test 5099); jangan sentuh `.env`, `prisma/**` (zero-migration — SEMUA kolom sudah ada!), `CHANGELOG.md`, halaman Menu Gateway, `SuperAdmin.vue`, service `aiKnowledge.js`.
3. No git commit/tag/push — oleh Alita. No browser (visual QA oleh Alita). No dependency baru.
4. Legacy GET/PUT `/api/autoreply` path: TIDAK berubah perilaku (byte-compat).
5. Jangan sentuh: `SaSidebar.vue`, `AdminShell.vue`, `Admin.vue`, `Contacts.vue`, `SaPengaturan.vue`, `SaTenantDetailDrawer.vue` (baru rilis v4.1.6–v4.1.12).

## 6. Deliverable (report ke Alita)

1. File diubah/dibuat + struktur baru (endpoint table + dropdown flow).
2. Build result (exit code) + e2e-v420 total PASS/FAIL + e2e-v4121 hasil akhir.
3. Bukti must-preserve: validator enum/plane-gate/cache-invalidate dipanggil di SEMUA endpoint baru (grep line refs).
4. Catatan keputusan/detail deviasi (mis. 404 vs 409 utk reset tanpa row — dokumentasikan pilihan + alasan).

## 7. Rilis (oleh Alita, bukan Dory)

- Deploy: FE build prod + backend restart by-PID (endpoint baru — pola v4.1.4/v4.1.12).
- Visual QA Chrome 18801 copy-DB: dropdown+badge, banner mirror, save-ja-custom, reset-to-default, menu-managed lock, CB-AI panel only-Default; mobile + desktop.
- CHANGELOG v4.2.0 + commit + tag.