# Spec v4.2.1 — Menu Gateway Per-Slot Override (dropdown + Custom/Default + Reset)

> **Request Kanaka 18:12 (GO "lanjutkan aja" 19:47):** AR sudah per-slot (v4.2.0), MG belum — asimetri. Cabang beda = kemungkinan menu beda ("Informasi layanan cabang A" vs B). Proposal diterima: pattern sama dgn AR v4.2.0 — dropdown scope + Custom/Default + Reset, menu per-nomor (intro/options/fallback sendiri).
> **Fondasi:** per-slot rows `MenuGatewayConfig @@unique(tenantId, numberSlot)` (schema L246) + options per-config (`MenuGatewayOption.configId`, deleteMany+createMany di transaksi PUT existing) + runtime `getConfigForSlot()` (slot menang, fallback shared) — SEMUA SUDAH ADA sejak v3.9. **0 migration.**

## 0. Fondasi existing (semantik JANGAN diubah)

- `getConfigForSlot(tenantId, slot)` (service L76): row slot menang → fallback shared. Runtime handler rute per-slot (`handleMenuRequest` dll pakai chat.numberSlot) — tidak diubah.
- `PUT /api/menu-gateway` legacy: tick-box `numberSlots` (array) / single `numberSlot`, 409 proteksi link-all saat shared AR aktif (L461–474), plan-gate aiHybrid 403 (L479+) & CB-AI options 403 + ownership doc (L492+), transaksi per-row replace options (L554+), sync dua-arah AR (L582–619: enable → `enableGreetForScope` + netralisasi shared AR menu + shared MG OFF; master-off → semua OFF + release awaiting), release awaiting D12.
- `GET /` sudah terima `?slot=` (echo config slot + fallback) dan kirim `menuManagedSlots` + `arManagedSlots` + `cbaiPlanOk` + `aiUsage`.
- Auto Reply side (v4.2.0): menu-managed → 409 guard baca AR row `greetMode='menu'` per-slot (bekerja otomatis bila sync MG set AR row per-slot).

## 1. Pilihan desain INTI (beda dgn v4.2.0 — jangan copy buta)

MG sudah punya **write path per-slot** (PUT / + numberSlot tunggal). Jadi jangan buat ulang — **reuse PUT / existing** untuk save (default & slot), tambah hanya:

### 1.1 Endpoint BARU: `GET /api/menu-gateway/options`
Response: `{ slots: [{ slot, label(?? 'Slot N'), custom, menuManaged, enabled, arManaged }], defaultExists }`.
- Sumber slots+label: `wa.listTenantNumbers` (slot-0 synthetic unshift — pola wa.js/autoreply options v4.2.0 O3).
- `custom`: ada row `MenuGatewayConfig {tenantId, numberSlot: slot}` (enabled true ATAU false — row = custom). `menuManaged` → `custom` (row ini dikelola sini). Slot TANPA row = mirror Default.
- Additive saja; FE dropdown di sini, tick-box lama TIDAK lagi dipakai FE (tetap byte-compat BE).

### 1.2 Endpoint BARU: `DELETE /api/menu-gateway/slot/:slot` (reset ke Default)
- 409: slot menu-managed aktif + punya awaiting chats milik slot itu → release dulu? **KEPUTUSAN: reset TIDAK menolak** — release awaiting (jalankan release-awaiting milik slot tersebut, reuse mekanisme D12/master-off scoped: cari fungsi release di service; kalau hanya global, gunakan filter slot pada query yang sama — document). Setelah release:
  1. Delete row `MenuGatewayConfig` slot tsb (options tercascade via `onDelete: Cascade`? — VERIFY schema; kalau tidak, deleteMany options eksplisit dulu dalam transaksi).
  2. Sync AR: row `autoReplyConfig` slot itu dgn `greetMode='menu'` → DELETE row tsb (slot AR kembali mirror shared AR — konsisten semantik override v4.2.0) — BUKAN sekadar set text.
  3. Invalidate kedua cache + release-awaiting hanya slot tsb; response `{ ok, slot, releasedCount }`.
  - Slot tanpa row → 200 idempoten `{ok, deleted:0}` (pola v4.2.0, dokumentasikan deviasi).
- **JANGAN** sentuh shared row (Default utuh). JANGAN sentuh row slot lain.

### 1.3 `GET ?slot=` existing — additive `custom` + `menuManaged` di response (pola v4.2.0 §2.5).

## 2. Reuse PUT / untuk save (bukan endpoint baru)

- **Default view save** → PUT / dgn `numberSlots: 'all'`? TIDAK — itu expand-ke-semua-slot eksplisit (perilaku QA-2 v3.9.5). Default view save = **edit shared row**. PUT / existing dgn `numberSlot: 'all'` → shared row (targetList=null). Perlu ADDITIVE kecil: bila body `scopeDefault: true` (flag baru, whitelist) → tulis shared row SAJA tanpa expand ke slot rows + tanpa netralisasi menyeret slot custom (kecuali sync AR yang sudah ada di enable path — pertahankan). **CAREFUL: netralisasi shared AR menu hanya saat per-slot tick-box; untuk scopeDefault save, JANGAN netralkan** (Default = shared itu sendiri).
- **Slot view save** → reuse PUT / dgn `numberSlot: N` (path existing L407+) — perilaku netralisasi shared AR-menu + shared MG OFF untuk isolasi slot custom SUDAH BENAR (tick-box tunggal). FE kirim body persis seperti tick-box single-slot lama.
- Validasi & plan gates & 409 link-all AR aktif & master-OFF D12 — semua berlaku otomatis (reuse).
- **ADDITIVE #2 (whitelist):** `scopeDefault: true` boolean — BE: 400 bila dikombinasi `numberSlot/numberSlots`; artinya tulis shared row (skip expand-ke-slot & skip netralisasi blok L593–606). `enabled` sync tetap: true → `enableGreetForScope(tenantId, null)`; false → shared MG OFF + **HANYA AR row menu SHARED dimatikan** (row slot custom tidak disentuh!) + release-awaiting = hanya slot pengikut shared. (Kalau terlalu rumit untuk incremental sync, minimalnya: default OFF → update shared row only + release awaiting pengikut shared; dokumentasikan perbedaan master-off lama vs baru di report.)

## 3. FRONTEND — rework `AdminMenuGateway.vue` (710 L)

1. **Bar atas**: dropdown "Semua nomor (Default)" + slots (custom label + 🟣 Custom badge / badge menu) — pola AdminAutoReply v4.2.0. Data dari GET /options; refresh pasca save/reset.
2. **Mirror**: slot tanpa row → prefill dari `GET ?slot=N` (sudah fallback shared) + banner biru "Nomor ini masih mengikuti Default — Simpan akan menjadikannya Custom".
3. **Save**: reuse PUT (endpoint sama, `numberSlot`/`scopeDefault`) — payload form penuh (intro/fallback/tag/timeout/repeat/aiHybrid/options[]).
4. **Reset ke Default** (slot custom): DELETE §1.2 + modal konfirmasi tipis ("Pengaturan menu khusus nomor ini akan dihapus; nomor kembali mengikuti Default; pesan yang menunggu pemilihan menu akan dilepas ke antrean.").
5. **Master OFF toggle** tetap di atas (perilaku master-off saat ini dipertahankan — release semua + netralkan semua rows; ini saklar platform, BUKAN bagian toggle per-slot) — JANGAN ubah perilakunya, hanya pastikan tidak bentrok dgn dropdown (toggle OFF semua → FE back ke Default view + banner options refresh).
6. Keep: flyout waiting, chip counts, plan-gate messaging, arManagedSlots/menuManagedSlots guards yang men-disable opsi (pola tick-box lama dipakai ulang sebagai info badge).
7. Jangan sentuh: file lain di FE.

## 4. Verifikasi (GATES)

1. `node --check` semua file BE edited; `vite build --outDir /tmp/v421-verify --emptyOutDir` exit 0 (PROD public/ JANGAN di-build).
2. **e2e-v421.cjs** (copy-DB :5099, kill PID sendiri):
   - O: options → label + custom/menuManaged.
   - S1 save slot-0 (intro beda + options beda) → row dibuat; GET ?slot=0 `custom:true`; slot-1 tetap mirror `custom:false` (effective == shared).
   - S2 slot-1 menu beda → 2 menu berbeda hidup berdampingan; runtime `getConfigForSlot(0)`/`(1)` return config masing2 (cache-invalidate).
   - S3 reset slot-1 → row hilang; AR row menu slot-1 ikut terhapus; effective kembali == shared; awaiting slot-1 released (count berubah).
   - S4 menu-managed: save slot enabled=true → AR row slot greetMode 'menu' (badge muncul di AR options juga — cek via autoreply options endpoint); AR save greeting di slot itu → 409 (konsisten v4.2.0).
   - S5 proteksi: link-all enable saat shared AR aktif → 409; plan-gate aiHybrid/cbai 403; ownership doc; `scopeDefault` mixed dgn numberSlot → 400; invalid slot → 400.
   - S6 legacy PUT: tick-box array path masih jalan (200) — byte-compat.
   - S7 idempotent DELETE tanpa row → 200 {ok, deleted:0}.
3. Regresi: e2e-v4121 61/61 + e2e-v420 57/57 (keduanya copy-DB).

## 5. HARD PROHIBITIONS

- NEVER `--force-reset / --accept-data-loss / DROP / TRUNCATE / rm` DB/data apapun (prod/copy) → tool minta reset = STOP & lapor.
- No restart prod 5047; kill hanya PID sendiri (5099). No git commit/tag/push. No browser. No dep baru. Jangan ubah: runtime handler menu (`processIncoming`/`handleChoice*`), `routes/autoreply.js` & `autoReply.js` (v4.2.0 — hanya boleh IMPORT helper yang sudah publik), prisma (zero-migration), `.env`, `CHANGELOG.md`, halaman AR/SuperAdmin/contacts/sa-*.

## 6. Deliverable (report)

Files+endpoints table; build+e2e totals (v421, v4121, v420); must-preserve evidence (line refs: transaksi options, sync dua-arah, release awaiting, plan gates); deviasi + alasan (esp. master-off semantics di §2 ADDITIVE #2).