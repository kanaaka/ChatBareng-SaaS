# v3.9.18b — ENHANCEMENT: WA notify multi-target (2026-09-25)

**Request (Kanaka 14:54):** tim Parahita juga mulai pakai ChatBareng — notif tunnel
regen dikirim juga ke **grup Brandcom PDC** (tenant Parahita) pakai **API key
Parahita** (`cbk_live_9Nz…`, scope send+read) — sekalian test jalur API kirim ke
grup.

**Perubahan:**
- `state/saas_v3_notify.json` → format **multi-target**: `{ enabled, targets: [ … ] }`
  (backward-compat: single-dict lama Zahrina era v3.9.18 tetap diterima).
- `saas_v3_tunnel_watchdog.py` — `load_notify_config()` return **LIST** target +
  `main()` loop: kirim per target, `wa_line` gabung hasil per target
  ("Zahrina (Mazaya CS): terkirim ✅; Brandcom PDC (Parahita): terkirim ✅").
- **Adopt grup Brandcom PDC** (orphan → assign PIC `parahitaadmin`) supaya
  `resolveTarget` API v1 bisa resolve `@g.us` (butuh row Chat tenant).
- QA kirim manual: Zahrina (single → 200, thread @lid existing), Brandcom PDC
  (group, 200, `waMessageId 3EB085378F9ACB6CCDC9CA`), invalid slot 400, isolasi
  tenant (t12 lihat slot-0 miliknya), partisi s0+s1 == baseline.

# v3.9.17 — FITUR: Filter chat-list by nomor WA (numberSlot) (2026-09-25)

**Request (Kanaka 14:16):** era multi-nomor (v3.9) — CS/admin bisa filter list chat
berdasarkan **nomor penerima pesannya** (slot 0/1/2), biar chat per nomor gak tercampur.

**Backend (`src/routes/chats.js` GET /api/chats):**
- Query param additive **`numberSlot`** (0–2; kosong/absent = tanpa filter slot —
  compat semua caller lama). Invalid (bukan digit 0-2) → 400 VALIDATION.
- CS juga boleh pakai (nomor milik tenant, bukan info lintas-CS); isolasi tenant
  tetap via requireTenant (tenant lain lihat slot-nya sendiri).

**Frontend (`ChatListPane.vue`):**
- Dropdown **"All numbers"** di panel filter (sama baris dgn All handlers) —
  **muncul HANYA bila tenant punya >1 nomor** (`waSlots.length > 1` — data badge
  slot yang sama; tenant 1 nomor = UI nihil, zero change). Label = label slot
  (atau `Slot N`) + ✓ kalau connected.
- State `filterNumberSlot` (null = semua) + masuk `buildFilterParams()` →
  socket-handler refetch ikut filter + counter badge Filters ikut +1 + tombol
  Clear all filters me-reset-nya.

**QA (copy 5099, tenant 11 & 12 + 2 slots seeded):** admin filter=all baseline
2 chat slot-0; `numberSlot=0` → sama dgn baseline; `numberSlot=1` → chat slot-1
tepat (7734 t12); `numberSlot=2` → 0; invalid `numberSlot=9` → 400; kombinasi
`mine`/`unassigned` + handlerId → 200; isolasi tenant (t12 lihat slot-0 miliknya
saja). Visual: dropdown tampil 2 slot dgn label + status ✓. Prod 5047 restart
health 200.

# v3.9.16b — FIX: Logo branding gak ke-render + logo gak bisa dihapus (2026-09-25)

**Bug (lapor Kanaka 13:32, logo 512×512 dipasang di tenant Parahita):**
1. **Logo error di tampilan tenant** — cuma alt-text "logo". Akar: `GET /api/branding/logo`
   wajib auth (requireAuthFlexible: Bearer ATAU ?token=), tapi frontend pasang logo
   sebagai `<img :src="logoUrl">` polos — `<img>` tidak bisa membawa header
   Authorization → fetch tanpa token → 401. File & endpoint sebenarnya sehat
   (200 + PNG 40KB dengan token; ter-verify via curl).
2. **Logo sekali pasang tak bisa dihapus** — PUT branding cuma terima upload BARU;
   tidak ada jalur clear (file + kolom logoPath tetap). Modal SA juga tanpa aksi hapus.

**Fix:**
- `BrandLogo.vue` — `logoSrc` computed append `?token=` dari auth store (endpoint
  requireAuthFlexible sudah support query-token; pola sama dgn download Tangan Kanan).
  Login page (props.text) tak terdampak. NOTE: tambahan `const auth = useAuthStore()`
  WAJIB (computed pertama me-refer `auth` sebelum deklarasi → runtime undefined).
- `superadmin.js` PUT branding — opsi `removeLogo` (multipart field "true"), mutual-
  exclusive dgn upload baru (400 kalau keduanya), idempotent (no-op bila tak ada logo);
  unlink file disk + `logoPath = null` + detail.logoRemoved; audit tetap `branding_update`.
- `SuperAdmin.vue` modal Branding — baris status "Logo terpasang ✓" + tombol
  **Hapus Logo** (dengan batal), auto-cancel kalau admin memilih file baru.

**QA (copy 5099 + prod 5047, Chrome 18801):** E2E removeLogo: 200 + file dihapus
+ logoPath null; idempotent 200; logo+removeLogo bersamaan → 400; re-upload → 200
+ file baru tercatat. Prod: logo Parahita (512×512) fetch `?token=` → 200 PNG 40KB;
SPA login → `<img class=brand-logo-img>` natural 512×512 complete=true, wordmark
"by ChatBareng" (teks sengaja hilang saat logo tampil — by design `showTextWithLogo`
=false; bisa di-on kan kalau diminta).

# v3.9.16 — FITUR: Usage kuota Tangan Kanan di panel tenant (2026-09-25)

**Request (Kanaka 11:41):** tenant bisa lihat sendiri seberapa penuh kuota
Tangan Kanan mereka ("mereka tau kalau sudah mendekati full atau masih banyak").

**Backend:**
- `src/routes/tanganKanan.js` — **GET /api/tk/quota** (tenant-scoped): `current`
  (SUM SharedFile.size), `quota` (plan.tkQuotaBytes; null = unlimited), `percent`
  (0–100), `remaining`. Sumber angka = `checkTkQuota(tid, 0)` yang sama dipakai
  guard upload 403 → tampilan gak mungkin nyimpang dari enforce.

**Frontend (TanganKanan.vue):**
- Bar kuota di bawah search: label "Kuota Tangan Kanan" + "8,3 GB / 10,0 GB" +
  bar tipis. Warna: netral (primary) → **kuning ≥80%** → **merah ≥95%**.
  quota null (plan nihil) → teks "tanpa batas kuota".
- `fetchTkQuota()` dipanggil dari `fetchFolders()` → ke-cover SEMUA jalur refresh
  (mount, upload, delete, socket `tk_file_created/deleted`) — bar selalu fresh.

**QA (copy 5099, Chrome 18801 raw-CDP):** API shape PASS (9×950MB = 8,35GB dari
10GB → 83%); visual PASS — bar amber "8,3 GB / 10,0 GB", file list utuh, layout
bersih.
**Catatan QA:** seed uji 5GB memicu P2023 (`SharedFile.size` = Int, max ~2,14
miliar/row) → /folders 500 di COPY DB — ARTIFAK QA, bukan bug produksi (upload TK
capped 10MB/file via maxMediaSizeMb; mustahil overflow). Backlog: size → BigInt
kalau suatu saat limit upload naik jauh di atas 2GB.

# v3.9.15 — FIX: Branding live update + load saat SPA login (bug "ParahitaAsik") (2026-09-25)

**Bug (Kanaka report 11:02):** superadmin set brandName tenant jadi "ParahitaAsik" →
tersimpan benar di DB + audit `branding_update` OK, TAPI header tenant tetap
"ChatBareng" polos. Dua akar masalah (frontend murni, backend bersih):
1. **Branding cuma di-load di `App.vue onMounted`** (sekali per full page load).
   Login SPA (tanpa reload) tidak pernah memuat brandName → header polos sampai F5.
2. **Tidak ada broadcast saat branding diganti** → tab tenant yang sudah terbuka
   stale sampai refresh manual.

**Fix (4 titik):**
- `stores/auth.js` — `login()` + `impersonate()` kini memanggil `loadBrandingAndPlan()`
  (SPA login langsung tampil brandName; impersonate view-as ikut benar).
- `src/routes/superadmin.js` — PUT branding → broadcast `branding_update`
  `{brandName, hasLogo}` ke room tenant.
- `stores/socket.js` — listener `branding_update` → re-fetch branding tanpa reload,
  dipasang di `init()` (SATU tempat — ter-cover App mount dgn token DAN SPA login
  via Login.vue; versi pertama di App.vue bolong utk jalur SPA login).

**QA (copy DB port 5099, Chrome 18801 raw-CDP):** SPA login e2eqacs → header
`QA Brand Test by ChatBareng` + docTitle benar TANPA reload ✅; SA PUT brandName
baru → tab tenant berubah seketika, flag JS membuktikan tanpa page reload ✅.
Backend/DB tidak berubah — fix 100% additive frontend + 1 broadcast backend.

## v3.9.14 — FITUR: Quote Reply (WhatsApp contextInfo) (2026-09-25)

**Konteks:** Pelanggan di WA asli sering quote-reply; CS sebelumnya kehilangan seluruh
konteks pesan yang di-quote. v3.9.14 membawa quote 2 arah: chip konteks di bubble CS +
`contextInfo` asli WhatsApp di stanza keluar (pelanggan lihat preview quote standar).
Spec: `docs/spec-v3.9.14-quote-reply.md`.

**Backend:**
- `prisma/schema.prisma` — 4 kolom ADDITIVE nullable di `Message`:
  `quotedWaMessageId` (stanzaId in / waMessageId target out),
  `quotedParticipantJid` (penulis quoted, grup; 1:1 null), `quotedSnippet`
  (**terenkripsi** `encryptText`, ≤200 char — chip selamat walau pesan asal di-purge),
  `quotedType` (`text|image|video|audio|sticker|document`). Migration
  `20260925100000_message_quote` (4×ALTER ADD COLUMN — additive-only, tidak ada
  kolom/tabel lama disentuh; aman `migrate deploy`). Tanpa index baru (resolve
  read-time pakai `@@index([waMessageId])` existing).
- `src/wa/pool.js` — helper `extractQuote(msg)` (baca `contextInfo` generik;
  snippet dari `conversation`/`extendedTextMessage.text`/caption/`document.fileName`,
  truncate 200; `@lid` disimpan mentah) + `quotedColumnsFromExtract` (persist inbound
  1:1 & grup) + `buildQuotedShape` (broadcast plaintext + `dbMessageId` resolve
  same-chat via waMessageId; null bila purged) + `sendMessageForTenant` opsi ketiga
  `quoted` → `sock.sendMessage(waJid, {text}, {quoted})` (API Baileys terverifikasi).
- `src/services/groups.js` — persist quoted cols pesan grup masuk + broadcast bawa
  shape `quoted`.
- `src/routes/chats.js` — `POST /:id/reply` menerima `replyToMessageId` opsional;
  guard 400: target tak ada / cross-chat / cross-tenant / `purged=true` / tanpa
  `waMessageId` (row failed/legacy — JANGAN pernah fake stanzaId); persist 4 kolom
  quoted (snippet terenkripsi); payload `quoted` shape §6 (plaintext snippet +
  `dbMessageId`); kolom quoted mentah di-strip dari payload (ciphertext tidak bocor);
  `POST /:id/media` + `replyToMessageId` → **400 eksplisit** (media-quote P1).

**Frontend:**
- `ChatDetail.vue` — chip quote di bubble (ikon tipe + penulis + snippet; klik →
  scroll-to-original + highlight bila `dbMessageId` ada), affordance Reply
  (hover desktop / tombol mobile, hidden pada bubble gagal), composer quote chip
  (penulis + snippet + ✕ batal; satu pending reply — reply baru menggantikan).
- `Dashboard.vue` — state `pendingQuote` + handler; chip clear saat SUKSES dan GAGAL
  kirim (spec §7.3); `{name}`/template tetap jalan saat quote pending.
- `stores/chats.js` — `sendReply(chatId, content, replyToMessageId)`.

**E2E & regresi (DB copy 5099, WA_DISABLED=1):** `scripts/e2e-v3914.cjs` **40/40 PASS**
(reply roundtrip + decrypt-verify, guard 400 lengkap, media+replyTo 400, extractQuote
unit incl. media-quote + truncate 200, read payload shape, isolasi tenant) + regresi
v3.9.13 **39/39**, v3.9.11 **10/10**, v3.9.4/v3.9.5/v3.9.6 **SEMUA PASS**, v3.9.9
**10/10 PASS**; `vite build` exit 0; post-verify row DB: quotedSnippet decrypt = konten
target (lesson #4).

**Catatan deploy:** additive-only → `npx prisma migrate deploy` aman; tidak ada perubahan
seed. Visual chip/scroll = QA Alita/Kanaka.

---

## v3.9.13 — FITUR: Public API v1 — API keys per-tenant (2026-09-24)

**Konteks:** Aplikasi eksternal (mis. program antrean) kini bisa kirim pesan WA
& baca chat via **ChatBareng Public API v1** memakai API key per-tenant.
Trial = produksi (same code path). Spec: `docs/spec-api-keys-v1.md`;
dokumen konsumen: `docs/API-CONSUMER-QUICKSTART.md`.

**Backend:**
- `prisma/schema.prisma` — model **ApiKey** (keyHash unique sha256, prefix 12
  char, scopes CSV, planGated, ratePerMin, lastUsedAt, expiresAt, revokedAt,
  createdByUserId) + kolom ADDITIVE `TenantPlan.featApiAccess` + kolom ADDITIVE
  `ChatEvent.source` ('api' = dari Public API). Migration
  `20260924190000_api_keys` (CREATE TABLE + 2×ALTER ADD COLUMN — tidak ada
  kolom lama diubah). Seed idempoten `prisma/seed-api-access.js`
  (preset max → featApiAccess=true).
- `src/services/apiKeys.js` — generate (`cbk_live_` + 32-byte base64url;
  **raw key NEVER stored/logged** — hanya sha256), verify (hash lookup),
  revoke (idempoten), list, rowToPublic (hash never out), per-key rate limiter
  (in-memory Map, window 60s).
- `src/routes/apiV1.js` (BARU, mount `/api/v1`) — middleware `requireApiKey`
  (Bearer `cbk_…` ATAU `X-API-Key`; urutan: 401 UNAUTHORIZED → 401
  KEY_REVOKED/KEY_EXPIRED → 403 UPGRADE_REQUIRED (plan gate) → 429
  RATE_LIMITED+Retry-After → scope per-endpoint 403 SCOPE_MISSING;
  sukses → `req.tenantId` + `req.apiKey`). Endpoint P1:
  `GET /api/v1/health` (public), `POST /api/v1/messages` (scope `send`;
  target nomor 08/62 → JID, JID `@g.us`/`@s.whatsapp.net`, ATAU nama grup
  eksak tenant; kirim via pool existing `sendMessageForTenant` slot
  auto-resolve; WA off → 503 `WA_BELUM_TERHUBUNG` konsisten route CS;
  audit ChatEvent source 'api'), `GET /api/v1/chats` (scope `read`;
  list 1:1 + pagination cursor `limit`/`cursor`, preview dekrip on-the-fly).
- `src/routes/apiKeys.js` (BARU, mount `/api/api-keys`, JWT admin tenant) —
  list/create/revoke key; create → raw key di response **SEKALI**.
- `src/routes/superadmin.js` — `GET/POST/DELETE /api/sa/tenants/:id/api-keys`
  (onboarding oleh owner, audit `api_key_create`/`api_key_revoke`) + plan
  update menerima field baru `featApiAccess`.
- `src/services/plans.js` — `featApiAccess` masuk preset (**max=true**,
  lite/pro=false) + FEATURE_KEYS + label upsell.
- `src/routes/auth.js` — `/auth/me` features kini bawa `apiAccess`.

**Frontend:**
- Halaman admin **“🔑 API Keys”** (`/admin/api-keys`, gate plan `apiAccess`):
  list keys (name, prefix, scopes, lastUsedAt, badge Revoked), Create modal
  (name + scope checkboxes; raw key tampil SEKALI + copy + warning), Revoke
  dengan konfirmasi (ConfirmDialog). Sidebar + launcher + settings search.
- SuperAdmin plan modal: toggle “Akses API (v1)”.

Dokumentasi konsumen: `docs/API-CONSUMER-QUICKSTART.md` — ditambah section
**"Claim semantics"** (2026-09-25, Kanaka-confirmed philosophy): API actor-less
— kirim TIDAK mengklaim chat / mengubah assignment / mengubah PIC. Chat baru
born-API = open+unassigned+NOT queued; masuk antrean normal saat pelanggan
membalas (FIFO Take). Grup hanya milik tenant; PIC tidak tersentuh; grup yatim
tetap yatim. Audit ChatEvent source 'api' userId null.

**Guidebook (buku panduan):** tab Admin dapat section **"🔑 Public API v1"**
(buat key + scope send/read, show-once, pakai Bearer, target nomor/nama grup
eksak, API tidak pernah klaim chat — balasan pelanggan masuk antrean normal,
grup tetap milik PIC, revoke instan, audit + rate 60/menit). Daftar modul admin
13 → 14. Footer guidebook versi ke v3.9.13. Frontend rebuild + snapshot
`public-pre-build-20260925-0950/`.

**E2E:** `scripts/e2e-v3913.cjs` di DB copy port 5099 (WA_DISABLED=1) —
**39 PASS / 0 FAIL**: lifecycle (SA create → plan-gate 403 → featApiAccess on
→ send 503 auth-PASS nomor/JID/nama-grup → scope-deny 403 → rate-limit 429
+Retry-After → revoke → 401 KEY_REVOKED → idempoten), auth deny paths
(401 UNAUTHORIZED, health public 200, X-API-Key), tenant isolation (list t4
tanpa row t8 — 404/empty, bukan 403 bocor), tenant-admin key mgmt + isolasi.
**Regresi semua PASS:** v3.9.11 (10/10), v3.9.4 (SEMUA), v3.9.5 (SEMUA),
v3.9.6 (15/15), v3.9.9 (SEMUA). Frontend build exit 0.

**Deploy note:** migration ADDITIVE — `npx prisma migrate deploy` aman;
lalu `node prisma/seed-api-access.js` (idempoten) untuk menyalakan
featApiAccess di plan max existing.

## v3.9.12 — Hardening path media portabel (persiapan deploy hosting, 2026-09-24)

**Konteks:** Kanaka mau deploy ke hosting asli (pakai besok). Inventori paket
ketahuan: DB nyimpan path media/sesi **absolut** host dev (`/home/kanakxxx/...`)
— 13 sel (Message.mediaPath 3, Blast.mediaPath 2, SharedFile.storagePath 7,
SaAuditLog 1) + Tenant.waSessionDir/TenantNumber.waSessionDir. Di server lain
semua itu mati. Kunci enkripsi (MSG/MEDIA_ENCRYPTION_KEY) = data-bound — pindah
host TANPA kunci sama = semua chat lama gak kebaca.

**Fix (5 file):**
- `src/wa/media.js` — `resolveMediaFilePath(p)`: absolut (file ada → pakai; gak
  ada → fallback mediaDir by basename) ATAU relatif (join mediaDir) + **containment**
  (hasil wajib di dalam mediaDir — blok `../` & absolut di luar = path-traversal
  guard). `saveMedia` kini simpan **RELATIF** (basename) — data baru portabel
  lintas host. `loadMedia` pakai resolver.
- `chats.js` (hapus chat → unlink loop), `tanganKanan.js` (delete file),
  `blast.js` (hasMedia check), `tenantBackup.js` (collectFilePaths) — semua
  akses disk pakai resolver, bukan path mentah.

**Verifikasi:** unit test resolver (relatif OK, fallback absolut-lama OK,
containment `../`+`/etc`→null, absolut-dalam-mediaDir→lolos) + regresi penuh
E2E hijau (v3.9.11 10/10, v3.9.4 21/21, v3.9.5 13/13, v3.9.6 15/15, v3.9.9 PASS).
- `package.json` postinstall → `scripts/postinstall-frontend.js` (toleran: frontend/ gak ada di paket hosting → lewati build; repo dev tetap install+build).
- v3.9.12c (tambalan audit Kimi-K3 — GO, 0 CRITICAL/HIGH/MEDIUM): (L1) blast
  hasMedia resolve sekali; (L2) unit test resolver diabadikan
  `scripts/test-media-resolver.js` (9/9 PASS); (I3) path RELATIF di env
  (MEDIA_DIR/WA_SESSION_DIR) di-anchor ke ROOT APP di config.js — kebal
  salah-CWD saat boot di hosting.
- v3.9.12d (hasil test paket eksak): `src/prisma.js` — DATABASE_URL `file:` relatif
  di-anchor ABSOLUT ke root app (Prisma resolve relatif ambigu: schema-dir vs CWD
  beda lingkungan — 2 boot test gagal beda cara sebagai bukti); DB paket kini di
  `data/wa-cs-hub.db`; postinstall jalur hosting kini juga `npx prisma generate`
  (fresh npm ci belum punya Prisma client).

## v3.9.11b — Tambalan audit Kimi-K3 v3.9.11 (GO) (2026-09-24)

**Verdict: 0 CRITICAL, 0 HIGH, 0 MEDIUM, 1 LOW (kosmetik), 6 INFO.** Akar fix
dinilai akurat; jalur adopt yatim utuh; anti-hang 404 cepat terbukti; cross-tenant
mustahil (filter tenantId + 404 non-bocor).

- **LOW-1 (ditambal):** `leaveGroup` emit `group_update` kini pakai `leaveJid`
  (konsisten dgn 7 fungsi lain yang emit JID asli) — dampak praktis nol karena
  handler frontend mengabaikan payload, tapi payload kini seragam.
- E2E ulang dgn kode final: v3.9.11 10/10 + regresi penuh PASS.

## v3.9.11 — Fix bug "Ganti PIC" macet + Search & Tab filter di Grup List (2026-09-24)

**QA verified v3.9.10 (13:56)** → push + release v3.9.10 (id 395415793).

**Bug Ganti PIC (lapor Kanaka):** dialog "Menyimpan…" abadi, PIC tak berganti.
- **AKAR (latent sejak porting SaaS):** seluruh service grup nyocokin row by
  `waJid` (JID), frontend SaaS ngirim row-id NUMERIK → `findGroupChat` selalu
  null → jatuh ke jalur ADOPT dengan "JID" angka sampah → `groupMetadata("812")`
  ke Baileys TANPA timeout → request gantung selamanya. Kena SEMUA aksi kelola
  grup ter-adopt (rename, settings, add/remove member, invite reset, PM peserta,
  Ganti PIC) — makanya Assign PIC yatim (JID) jalan, Ganti PIC (angka) macet.
- **FIX:** `findGroupChat` resolve id ATAU JID (angka → by id, bukan grup → 404
  bersih, JANGAN pernah adopt dgn id numerik); 8 titik panggilan WA kini pakai
  `row.waJid` asli; `leaveGroup` resolve id/JID dulu.

**Fitur Grup List (request Kanaka):** search box (nama grup/PIC) + tab filter
admin: Semua / Ada PIC / Belum ada PIC.

**E2E baru `scripts/e2e-v3911.cjs`** (10 check: assign-pic via id numerik 200 +
DB ter-update, unknown-id 404 cepat 6ms, JID path tetap 200, yatim WA off 503
cepat, detail id numerik 503 cepat) PASS + regresi penuh (21/21+13/13+15/15+v3.9.9).

## v3.9.10b — Tambalan audit Kimi-K3 v3.9.10 (GO) (2026-09-24)

**Verdict: 0 CRITICAL, 0 HIGH, 0 MEDIUM, 2 LOW, 2 INFO.** Semua fokus A–F PASS
(backfill race-safe + null-safe di semua konsumen, konvergensi Contact tanpa
deadlock, deep-link JID → toast ramah, orphan intercept konsisten, TDZ fix valid).

- **LOW-1 (ditambal):** backfill pushName dipindah SEBELUM routing born-assigned
  — push pertama ke agent sudah pakai nama kontak (dulu fallback nomor/JID).
- **LOW-2 (ditambal):** guard `:id` numerik diangkat ke `router.param` — berlaku
  untuk SEMUA metode (GET/POST/PUT/PATCH/DELETE), bukan cuma GET.
- INFO-4: komentar v3.9.10b → v3.9.10.
- E2E ulang dgn kode final: 21/21 + 13/13 + 15/15 + v3.9.9 PASS.

## v3.9.10 — QA Kanaka 24 Sep 13:25: 3 temuan grup + 1 TDZ dari log (2026-09-24)

**Temuan (screenshot halaman Grup + halaman utama):**

1. **Nama grup yatim gak kebaca** — di pane w-96, nama & badge & tombol berebut
   satu baris flex-row → `truncate` memeras nama jadi 1-2 huruf (visual: "C").
   **Fix:** nama grup = baris sendiri full-width; badge "BELUM ADA PIC" +
   tombol Assign PIC/Buka pindah ke baris kedua (pola kartu 2 baris).
2. **Tombol "Buka" grup yatim → 500** — id item yatim = JID @g.us; GET
   /api/chats/:id lempar Number(NaN) ke Prisma → 500 "internal server error".
   **Fix:** GET /api/chats/:id non-numerik → 404 bersih; UI: Buka grup yatim
   dialihkan ke dialog Assign PIC (grup belum di-adopt = belum ada thread).
3. **Chat baru dari pesan keluar owner: nama = pushName OWNER** (kasus Nurhayati
   6281331370730: chat 7717 lahir dari pesan keluar 05:31 → contactName
   "Kanaka Prabhata"; pushName balasan Nurhayati tak pernah meng-update).
   **Fix:** (a) create-from-incoming dgn msg.key.fromMe → contactName null
   (pushName owner bukan nama kontak); (b) backfill pushName pelanggan dari
   pesan masuk pertama bila contactName masih kosong (updateMany kondisional,
   anti timpa rename manual CS). Data Nurhayati (chat 7717 + contact 7699)
   di-rename manual ke "Nurhayati".
4. **Bonus dari log prod:** TDZ `Cannot access 'chatId' before initialization`
   di handleIncomingGroupMessage (log skip-adopt pakai chatId sebelum
   deklarasi) — log kini pakai ctx.waJid.

**E2E:** regresi penuh PASS (v3.9.4 21/21 + v3.9.5 13/13 + v3.9.6 15/15 +
v3.9.9 PASS). Frontend build ulang (public/assets).

## v3.9.9b — Tambalan audit Kimi-K3 v3.9.9 (GO-WITH-NOTES) (2026-09-24)

**Verdict: 0 CRITICAL, 0 HIGH, 1 MEDIUM, 3 LOW, 5 INFO.** Semua fokus A–H PASS
(race handleChoice aman, snapshot lengkap, jalur manual no-send, D11 konsisten,
tanpa frontend).

- **MEDIUM-1 (ditambal):** sweep anti-overlap (`sweeping` flag + finally) — tick
  baru skip saat tick lama masih kirim fallback serial; candidates `take:100`
  per-tick (mass-timeout dilepas bertahap); broadcast realtime DULU sebelum loop
  kirim (antrean UI gak menunggu serial-send Baileys).
- LOW-1 (dokumentasi): admin disable antara klaim & fetch config → skip kirim,
  chat tetap ke-release (konsisten D11/D12).
- LOW-2/3 diterima: return semantics manual (fire-and-forget callers), query
  tanpa index menuState (volume kecil, PK-claim index-friendly).
- INFO-4: hitungan E2E diperjelas — 10 check (A0..T4c), di commit note sbg 9
  test-case (T2 pre+seed digabung).
- E2E ulang dgn kode final: v3.9.9 SEMUA PASS + regresi 21/21 + 13/13 + 15/15 PASS.

## v3.9.9 — Fitur: fallbackText terkirim saat TIMEOUT (lapor Kanaka 24 Sep 12:00)

**Test Kanaka:** timeout 30 dtk → chat masuk Unassigned ✅ sesuai desain, TAPI
fallback message TIDAK muncul.

**Akar — gap desain sejak v0.13.0:** timeout release = SILENT (sweep melepas chat
ke antrean tanpa pesan apa pun). fallbackText selama ini hanya kepakai di jalur
D2 (pelanggan bales teks yang tidak cocok opsi menu). Pelanggan yang diam saja
tidak pernah dapat kabar apa-apa sampai CS mengambil alih.

**Fix (releaseAwaiting di menuGateway.js):**
- Jalur TIMEOUT kini **klaim atomik per-chat** (`updateMany where
  menuState='awaiting'`, pola handleChoice) — chat yang kejawab pelanggan tepat
  sebelum sweep TIDAK ikut ke-release dobel; ids eksak → broadcast persis.
- **fallbackText terkirim** ke setiap chat yang ke-claim oleh sweep timeout
  (personalisasi {name}). Kirim gagal (WA mati/disconnect) = non-fatal: release
  tetap jalan, TANPA row message palsu.
- Jalur release manual (PUT enabled=false) tetap TIDAK mengirim — admin sadar
  mematikan gateway; blast pesan ke semua awaiting justru membingungkan (D11).
- Return kini { released, ids, sentFallback } + log jumlah terkirim.

**E2E baru** `scripts/e2e-v399.cjs` (9/9 PASS: config per-slot timeout-10s, seed
awaiting 90s, release done+queuedAt, jalur fallback diattempt di log, tanpa row
message palsu saat WA_DISABLED) + regresi penuh: v3.9.4 21/21 + v3.9.5 13/13 +
v3.9.6 15/15 PASS.

## v3.9.8b — Tambalan audit Kimi-K3 v3.9.8 (GO-WITH-NOTES) (2026-09-24)

**Verdict: 0 CRITICAL, 0 HIGH, 2 MEDIUM, 2 LOW, 3 INFO.** Semua fokus (boot-init
aman WA-disabled, anti-abuse clear-limbo, resolve safety-net konsisten, TDZ bersih,
regresi tenant disabled tercuci) PASS.

- **MEDIUM-1 (ditambal):** anti-steal /assign — CS tidak lagi bisa merebut chat
  milik agent lain tanpa user_id (gate 403; admin tetap boleh reassign paksa).
- **LOW-1 (ditambal):** /resolve clear-limbo kini juga broadcast `menu_waiting_update`
  (chip count realtime, sebelumnya nunggu sweep tick ≤30 dtk).
- **INFO display:** flyout "sisa ? mnt" → "sisa — mnt" (slot disabled lebih halus).
- MEDIUM-2 (edge: tenant disabled dgn sisa awaiting tak tersapu) diterima — mitigasi
  take/resolve-clear sudah aktif, release-on-disable tetap lewat PUT.
- E2E regresi full dengan kode baru: v3.9.4 21/21 + v3.9.5 13/13 + v3.9.6 15/15 PASS.
  Prod restart sehat (sweep started, 2 slot WA connected).

## v3.9.8 — Hotfix: chip "⏳ Menunggu menu" nyangkut + timeout gak pernah jalan (2026-09-24)

**Lapor Kanaka 11:39:** Khoiriyah kena gateway, gak bales, timeout-nya udah lewat
tapi masih "Menunggu menu", dan angkanya justru NAIK (10 → 34 menit).

**Dua akar (keduanya pre-existing sejak v0.13.x/v3.9.x):**
1. **Sweep timeout TIDAK PERNAH di-init di produksi** — rencananya "init dari
   baileys connect" tapi `initMenuGatewaySweep()` gak pernah punya caller (log
   "Sweep timeout started" = 0). Chat awaiting tidak pernah di-release.
2. **Angka naik = ELAPSED, bukan countdown** — flyout menampilkan "menunggu X mnt"
   (durasi sejak intro dikirim) dan Kanaka membacanya sbg sisa timeout. Semantik
   lama memang benar (limbo TIDAK auto-release, hanya flag), tapi tanpa sweep
   jalan, flag itu permanen.

**Kasus Khoiriyah (chat 7709):** awaiting sejak 11:04, TAPI di-take admin (11:37)
+ di-resolve padahal limbo → residu `awaiting` nyangkut selamanya (take/resolve
tidak membersihkan menuState).

**Fix:**
- Sweep di-init **saat boot** (idempoten) di server.js — bukan post-WA-connect.
- `/assign` (take/transfer): bila chat limbo → sekalian `menuState='done'` +
  broadcast `menu_waiting_update` (take admin = niat jelas meng-akhirkan alur menu).
- `/resolve`: safety net sama (limbo → done + menuRequestedAt null).
- `listWaiting` API kini mengembalikan `remainingSeconds` (timeout efektif per-slot)
  + Dashboard flyout menampilkan "sisa X mnt" — hilang ambiguitas elapsed vs sisa.
- E2E: v3.9.4 21/21 + v3.9.5 13/13 + v3.9.6 15/15 PASS (regresi full dengan kode baru).
- Bukti produksi: tick sweep pertama me-release Khoiriyah (done + queued), chip count
  0. Frontend build ulang + restart sehat.

## v3.9.7 — Hotfix: search mati di Blast → Select recipients → tab Chat List (2026-09-24)

**Lapor Kanaka 11:32:** search box di tab Chat List gak berfungsi; tab Kontak normal.

- **Akar:** `fetchChatsForPicker` frontend filter `c.id.toLowerCase()` — di SaaS v3
  `Chat.id` bertipe **Int** (autoincrement) → TypeError → ketangkap catch diam-diam →
  `availableChats` tak pernah ke-update → search tampak mati. Hub non-SaaS lolos karena
  id-nya String (waJid). Satu-satunya pattern `.id.toLowerCase()` di seluruh frontend.
- **Fix:** `String(c.id).toLowerCase()` (BlastComposer.vue). Frontend build ulang +
  restart produksi (2 slot WA connected).

## v3.9.6b — Tambalan audit Kimi-K3 v3.9.6 (GO-WITH-NOTES) + build frontend (2026-09-24)

**Verdict audit 0fea995: GO-WITH-NOTES — 0 CRITICAL, 1 HIGH, 1 MEDIUM, 2 LOW, 4 INFO.**
Isolasi tenant/fallback/adopt-konsistensi/regresi/orphan/dropdown: PASS semua.

- **HIGH-1 (ditambal):** `sendGroupInviteLinks` fallback invite-code memanggil method
  pada socket yang bisa NULL (slot disconnect) → TypeError 500. Kini cek socket dulu.
- **MEDIUM-1 (ditambal):** detail grup ORPHAN pakai slot-0 untuk botJids/botIsAdmin/
  invite-code padahal metadata dari slot lain → slot temuan (`orphanSlot`) kini
  diteruskan ke buildDetailPayload (effSlot).
- **LOW-1 (ditambal):** adopt orphan (assignPic) kini anti-race P2002 (retry pola
  createGroup) — dua admin adopt barengan gak lagi 500.
- **LOW-2 (ditambal):** race-recovery createGroup insert langsung `numberSlot:
  createSlot` (tidak hardcode 0).
- INFO-1: komentar basi "create selalu numberSlot 0" diperbaiki. INFO-3 (resolveLid
  slot-0 utk grup slot-1, non-fatal) diterima sbg follow-up ops. INFO-4: T8 X-FF
  dummy = test hygiene valid, proteksi limiter tetap aktif.
- **Frontend di-BUILD ke produksi** (`npm run build` → public/) — dropdown pilih nomor
  pembuat grup kini live. (Miss: v3.9.6 lupa build — UI belum memuat dropdown.)
- E2E ulang setelah tambalan: v3.9.6 15/15 + v3.9.5 13/13 + v3.9.4 21/21 PASS.
  Prod restart sehat (2 slot WA connected).

## v3.9.6 — Grup slot-aware: pilih nomor admin grup + orphan multi-slot (2026-09-24)

**Permintaan owner 10:47:** (1) bikin grup bisa PILIH nomor mana yang jadi admin WA;
(2) grup yang cuma di-invite ke nomor slot-1 harus tetap kelihatan di menu Grup
(sebelumnya fetch yatim CUMA slot-0 → grup slot-1 tak terlihat sama sekali).

**Desain:** TANPA kolom baru — `Chat.numberSlot` pada row grup = slot PEMILIK grup
(nomor pembuat/admin WA). Row legacy (slot-0) = perilaku lama persis. 1 grup = 1 baris
(v3.9.2 K1-A) tetap.

**Backend (services/groups.js):**
- `createGroup` — body.slot (0..MAX_SLOT, wajib row TenantNumber) → groupCreate via
  socket slot itu; row grup numberSlot = slot itu. Default 0 = status quo.
- Slot-aware end-to-end: fetchGroupMetadata/addParticipants/updateMembers
  (add/remove/promote/demote)/updateGroupInfo/updateSettings/resetInvite/invite-code
  semuanya lewat socket slot PEMILIK row (bukan selalu slot-0).
- assertWaReadySlot: pesan error per-slot ("Nomor slot 1 belum terhubung…").
- Orphan: listOrphanGroups fetch dari SEMUA slot connected (merge by gid, dedup);
  getGroupDetail + adopt (assignPic) + leaveGroup pakai fetchGroupMetadataAnySlot —
  grup yatim milik slot manapun kini terlihat & bisa di-adopt.
- buildDetailPayload/getBotJids/botIsAdminFromMetadata slot-aware (bot = nomor pemilik).
- PM participant & invite-link ke chat 1:1 TETAP slot-0 (isolasi 1:1 status quo);
  kode invite diambil via slot pemilik.
- API create: body.slot; list/detail kini include numberSlot.

**Frontend (GroupListPanel):** dropdown "Nomor pembuat grup (jadi admin WA)" di dialog
Buat Grup — daftar slot + label + status connected, default Nomor utama; fetch on-open.

**E2E v3.9.6 (scripts/e2e-v396.cjs): 15/15 PASS** — validasi slot (400 slot invalid/
tanpa row; 503 WA off konsisten di create/settings/members/rename/invite-reset/leave),
numberSlot persist per-row (legacy 0 + slot-1), adopt orphan 503 rapi.
Regression v3.9.4 (21/21) + v3.9.5 (13/13) tetap PASS. Bonus test-hygiene:
T8 limiter login kini pakai X-FF dummy fixed (bucket IP test utama tidak terbakar).

## v3.9.5b — Tambalan re-audit Kimi-K3 v3.9.5 (GO-WITH-NOTES) (2026-09-24)

**Verdict re-audit d546967: GO-WITH-NOTES — 0 CRITICAL/HIGH/MEDIUM.** 2 LOW + 6 INFO.

- **LOW-1 (ditambal):** expand "Semua nomor" kini filter `slot in [0,1,2]` (defense-in-depth —
  row slot >2 takkan pernah di-resolve runtime).
- **I5 (ditambal):** skrip E2E v3.9.4 + v3.9.5 di-commit ke `scripts/` (reproducible):
  e2e-v394.cjs, e2e-v395.cjs, e2e-reset-superadmin.cjs.
- **LOW-2 (diterima):** race expand concurrent — idempoten + self-healing (P2002-catch);
  pembungkusan $transaction besar opsional, tidak dilakukan (risiko rendah).
- **INFO penting:** proteksi 409 link-all kini efektif utk caller legacy saja (UI baru selalu
  kirim numberSlots → expand per-slot, proteksinya lebih ketat); legacy `{enabled:false}`
  kini full-off semua slot (semantik master-off baru — sesuai QA-UX); tenant 1-nomor regresi
  nihil observable; jalur runtime graceful pada inkonsistensi laten (revertClaim + anti-orphan).

## v3.9.5 — Fix QA round-2 Kanaka 09:38: gateway runtime mati + UX master-toggle (2026-09-24)

**Hasil QA round-2 (09:38):** assigned per-agent ✅, rate limit ✅ (take banyak chat lancar), isolasi auto-reply ✅.
2 fail: gateway tak pernah muncul (bahkan saat di-tick semua nomor) + tick-box masih aktif/dipaksa saat master toggle OFF.

**Bug 1 (utama) — runtime baca config SHARED, menu per-slot tak pernah terbaca:**
`menuGatewayConfigSafe()` di autoReply.js (jalur runtime (b) & freq jalur (c)) selalu
`menuGateway.getConfig(shared)` — row shared disabled → `gatewayOn=false` → intro tak
terkirim walau MG slot enabled. Lolos E2E v3.9.4 karena test API-level tidak menyentuh
jalur runtime ini. Fix: helper jadi slot-aware `menuGatewayConfigSafe(tenantId, chat.numberSlot)`
→ `getConfigForSlot` (row slot menang, fallback shared).

**Bug 2 — "Tick gateway semua nomor" gak jalan:** UI kirim numberSlots=null (Semua nomor)
→ link-all/shared row. Slot dgn row scoped lama (mis. AR teks yang sudah dimatikan) TIDAK
kena fallback shared → tak dapat menu. Fix: `numberSlots===null` eksplisit + `enabled!==false`
→ EXPAND ke semua slot terdaftar sebagai row per-slot eksplisit (bukan fallback). Shared MG
row tetap dinetralkan (anti-bocor, mirror audit HIGH-1).

**Bug 3 — master toggle OFF = full-off + tick-box disabled:**
- Backend: `enabled=false` → SEMUA row MenuGatewayConfig tenant OFF + AR rows mode-menu
  dimatikan (greetEnabled=false, mode text) + release awaiting semua slot. Payload tanpa
  numberSlots valid (tidak dipaksa pilih).
- Frontend: tick-box "Semua nomor" + per-slot `:disabled="!form.enabled"` + hint
  "Nyalakan saklar utama dulu". Guard "centang minimal satu" hanya saat master ON.

**E2E v3.9.5: 13/13 PASS** (expand semua-nomor → row eksplisit per slot + shared tetap off;
configSafe(slot) enabled per slot; master-off full-off; save master-off tanpa tick-box valid).
Satu false-negative test diperbaiki (Number(null)===0 vs shared row).

## v3.9.4 — 6 fix QA Kanaka 24 Sep 05:41 (rate-limit fatal + hybrid AR/MG + UI slot) (2026-09-24)

**Tembakan:** QA report Kanaka 06 poin (05:41). Fix penuh + E2E 21/21 PASS di DB copy (port 5099, WA disabled).

1. **Tombol logout WA per nomor kembali (QA #1)** — AdminWhatsApp: tombol "Logout WA" per slot
   (orange, konfirmasi) → POST /api/wa/logout {slot, confirm:true}. Beda dgn Reconnect (yang TIDAK
   menghapus sesi) dan Hapus Nomor (yang melepas slot/kuota). Sesi dihapus → scan QR ulang; slot & label tetap ada.
2. **UI routing pool/assigned/mix (QA #2)** — dropdown "Routing:" di header (muncul bila >1 slot)
   + per-slot: pilih agent (cs/admin aktif) + checkbox "reassign ke CS lain kalau offline" +
   Simpan Routing. Backend sudah ada sejak v3.9 (resolveRouteForSlot + born-assigned) — ini UI-nya.
3. **Rate limit fatal (QA #3)** — 3 lapis fix:
   - server.js: `app.set('trust proxy','loopback')` → di balik cloudflared tunnel, req.ip = IP klien
     asli (bukan semua dihitung 127.0.0.1 satu bucket).
   - Limiter SPLIT READ/WRITE: GET/HEAD bucket terpisah 1800/min (polling dashboard tidak lagi
     makan jatah aksi tulis), write 300/min (naik dari 100). Env: RATE_LIMIT_PER_MIN /
     RATE_LIMIT_READ_PER_MIN.
   - **Akar fatal:** auth store `fetchMe()` dulu logout paksa untuk SEMUA error (termasuk 429) →
     429 = sesi dihapus = halaman kosong = login juga kena limit (lingkaran setan QA). Sekarang
     logout HANYA saat 401. Plus login limiter terpisah 15/menit (brute-force guard tetap).
4. **Tick-box multi-nomor (QA #4)** — halaman Auto Reply & Menu Gateway: checkbox "Semua nomor" +
   per-slot (badge "menu"/"auto-reply" utk slot dilindungi). Backend: numberSlots (array) +
   numberAll (legacy numberSlot tetap didukung).
5. **Pilihan persist (QA #5)** — dua bug root: (a) `numberSlot` tidak ada di ALLOWED_TOP_FIELDS
   route menu-gateway → save per-slot selalu 400 "Field tidak dikenal" diam-diam; (b) GET tidak
   balikin scope terpilih. Fix: whitelist + GET numberSlots/menuManagedSlots/arManagedSlots.
6. **Hybrid independen (QA #6)** — sinkronisasi saklar Auto Reply ↔ Menu Gateway kini SCOPED per
   slot (bukan updateMany SEMUA row): enableGreetForScope/disableGreetForScope. Sweep timeout &
   releaseAwaiting slot-aware (param slot). Proteksi 2 arah 409: save Auto Reply ke slot menu-managed
   ditolak, dan sebaliknya. Shared/legacy rows dinetralkan saat tick-box eksplisit supaya tidak bocor
   ke slot lain via fallback.

**Bug bonus ketahuan E2E:** PUT autoreply selalu memaksa greetEnabled=true saat greetMode dikirim —
user uncheck greeting = nyala lagi sendiri. Fix: hanya mode 'menu' yang memaksa ON.

**E2E:** 21/21 PASS (login/impersonate, tick-box validasi & persist, proteksi 409 dua arah,
menu-gw per-slot, logout guard, routing assigned + validasi agent, release awaiting SLOT-SCOPED
(slot-0 tetap awaiting saat slot-1 di-disable), login limiter 429). Server produksi restart sehat.

## v3.4.1 — Username unik GLOBAL lintas tenant + case-insensitive (2026-09-22)

- **Request owner (18:50):** tiap tenant bisa bikin user sendiri, tapi login pakai
  username satu ruang nama platform-wide — duplikat lintas tenant = bahaya
  (salah masuk / kebingungan identitas). Pastikan unik + peringatan minta ganti.
- **Guard baru `src/utils/usernameGuard.js`** — dipakai di DUA titik create user:
  `POST /api/users` (admin tenant) dan `POST /api/sa/tenants/:id/admins`
  (superadmin):
  - **Case-insensitive** (`lower()` SQL raw): "KANAKA" vs "kanaka" = bentrok
    (DB @unique SQLite hanya case-sensitive — guard menutup celahnya).
  - **409 ramah + saran konkret**: "Username "X" sudah dipakai. Username bersifat
    unik di seluruh platform (semua perusahaan), jadi ganti ke yang lebih spesifik
    — misalnya: mazaya-andi, andi-mazaya, andi733." Saran diverifikasi tersedia
    (prefix/suffix nama tenant + variasi angka), max 3, dikirim juga sbg array
    `suggestions` (API-friendly).
  - **Privasi lintas tenant**: tidak pernah bocor username itu milik tenant mana.
- **Validation diperkuat** (createUserValidation + superadmin admins): username
  hanya `[A-Za-z0-9._-]` — ruang nama ASCII konsisten agar CI-check lower()
  bisa diandalkan (unicode/homoglyph ditolak 400 sebelum sampai DB).
- **Login path tidak berubah** (findUnique exact) — data existing aman: audit
  9 user, 0 case-collision; username yang sudah dipakai tetap kebaca persis.
- **QA (Alita):** dup CI lintas tenant 409 + saran ('KANAKA' vs 'kanaka' Mazaya,
  'Shieva'/'shieva' via admin tenant), dup milik tenant lain ('parahitaadmin') 409,
  unicode 400, username unik 201, tenant QA Gamma di-purge setelahnya (audit
  survive), WA reconnect kedua tenant, data utuh.

## v3.4 — Plan & Kuota per-Tenant + Fitur Toggle + Branding + Superadmin penuh (2026-09-22)

- **Request owner (15:07/15:25, approved):** paket Lite/Pro/Max + kontrol individual,
  branding per tenant ("X by ChatBareng"), superadmin bisa backup full tenant,
  audit + impersonasi UI. Custom URL per tenant = defer.
- **Plan & preset (LOCKED):** Lite 3 agen / 2 GB TK / 5.000 kontak; Pro 10 / 5 GB /
  10.000; Max 50 / 10 GB / 50.000. Toggle fitur: Analytics, Blast+Pengumuman,
  Menu Gateway, Export/Import Riwayat (+Cekat), CSAT (Lite ✗, Pro/Max ✓),
  Backup GDrive (Lite/Pro ✗, Max ✓). `null` = unlimited. Field `preset`
  informational (nama preset bila persis definisi, "custom" bila menyimpang).
- **Skema:** `TenantPlan` (1:1 tenant, onDelete Cascade — ikut purge; `tkQuotaBytes`
  **BigInt** — Int max 2,1 GB, mustahil simpan 10 GB; catatan deviasi spec, benar
  secara teknis), `SaAuditLog` (actorId/tenantId plain Int tanpa FK — audit
  PERMANEN, tetap hidup setelah tenant di-purge), kolom Tenant: `brandName`,
  `logoPath`.
- **Enforcement:** API-level 403 (bukan cuma hide menu): `users.js` (agent quota),
  `contacts.js` + history/cekat import (contact quota — dicek SEBELUM commit),
  `tanganKanan.js` upload (TK quota = SUM SharedFile.size, scope sengaja hanya TK
  — media chat/blast tidak ikut), `requireFeature()` middleware di analytics/
  blast/announcements/menuGateway/history/cekatImport/csat/gdrive. Pesan error
  ramah + upsell ("Hubungi admin platform untuk upgrade").
- **Kuota kontak di jalur WA masuk:** auto-create kontak di-skip DIAM bila kuota
  penuh (pool.js syncContactFromChat, autoReply, groups) — chat & pesan TETAP
  diproses, tidak pernah memblokir pesan masuk. Log throttle 1x/jam/tenant.
- **Tenant lama (Parahita #4, Mazaya #8) di-seed plan `max` otomatis di boot** —
  fitur yang sebelumnya terbuka tetap terbuka, tidak ada perubahan perilaku.
- **SuperAdmin API & UI:** create tenant dengan dropdown preset (default Lite);
  GET/PUT plan (apply preset + override individual, null = unlimited); usage
  meter per tenant (agen/kontak/TK); branding (brandName 2-50 char + logo
  PNG/JPEG/WEBP max 1 MB, disimpan data/branding/tenant-<id>/, NO svg, purge ikut
  bersihin file logo); **backup full tenant** → tar.gz on-demand (db/*.json per
  tabel + files/ media terenkripsi byte-for-byte + manifest.json dengan key
  fingerprint, TIDAK decrypt, TIDAK menyimpan arsip permanen); audit log viewer
  (filter action/tenant, cursor pagination); tombol impersonate (token 30m,
  backend v3.0) — semua aksi SA tercatat di SaAuditLog.
- **Branding user tenant:** /auth/me diperluas (branding + plan + usage);
  GET /api/branding/logo auth flexible (Bearer ATAU ?token=) utk <img>;
  header/logo/suffix "by ChatBareng" hardcoded frontend (muted); document.title
  ikut; **halaman Login TETAP ChatBareng** (belum ada context tenant pre-login).
  Frontend menu gating via plan.features + route guard + axios 403 toast.
- **Bug fix pasca-review (Alita):** POST /api/sa/tenants 500 "Do not know how to
  serialize a BigInt" — plan raw di-res.json langsung; fix: serialisasi lewat
  planToJson (BigInt → Number). Tenant #9 sempat ter-create sebelum error
  (non-fatal, di-purge saat QA cleanup).
- **Fix migrasi (bug laporan owner 15:49):** template & pengumuman Mazaya
  gibberish setelah migrasi v3.3 — migrasi over-encrypt content yang di app
  disimpan PLAINTEXT. Decrypt in-place 44 template + 4 pengumuman tenant 8
  (0 sisa terenkripsi, verified). `migrate-mazaya-from-hub.cjs` di-patch agar
  tenant berikutnya tidak kena (content tetap plaintext, paritas write path).
- **QA (Alita, smoke penuh):** tenant create 201 (BigInt fix live); feature gate
  Lite 403 vs Pro 200; agent quota 403 di user ke-4 (3/3); contact quota
  403 di kontak ke-3 (override maxContacts=2, preset label → custom);
  TK quota 403 (18 B/1 B) + restore; branding brandName + logo upload +
  /auth/me + serve logo ?token= 200 PNG; backup Mazaya 21,4 MB / 45 entri /
  manifest tables match / filesCopied 12; audit 12 aksi tercatat; purge
  QA Lite & QA Beta — TenantPlan cascade ✓, SaAuditLog survive ✓, data
  Parahita & Mazaya utuh ✓ (chat 2532/2603, msg t4 80 / t8 2603), WA
  reconnect ✓ kedua tenant.

## v3.3 — Tenant Mazaya: migrasi full dari hub non-SaaS (POC 2 tenant paralel) (2026-09-22)

- Request owner (12:03): tenant kedua atas nama **Mazaya** — isinya seluruh
  ChatBareng non-SaaS (users, chat, riwayat pesan, kontak, tag, template,
  pengumuman, blast, file, config) sebagai proof of concept dua tenant
  bekerja bersamaan.
- Metode: skrip migrasi `scripts/migrate-mazaya-from-hub.cjs` (node, one-shot,
  idempoten-guard) — mapping ID lama→baru semua entitas, **re-encrypt konten**
  terenkripsi (key MSG/MEDIA hub → key SaaS; AES-256-GCM enc:v1), copy file
  media (decrypt → re-encrypt), fallback user orphan → superadmin.
- 3 iterasi (rollback via purge v3.1.2 tiap kali): (1) contactTag pakai ID hub
  mentah → P2003, fix map contactMap; (2) audit log grup yatim (19 row GAL
  sisa cleanup grup "hello" — chat asal sudah dihapus di hub, di hub memang
  tanpa FK) → skip; (3) sukses penuh.
- Hasil (verify MISMATCH_TOTAL=0, 23 tabel parity):
  7 user (hash password tetap → login tetap jalan), 2532 chat, 2592 pesan
  (re-encrypted, decrypt-verified), 2528 kontak, 19 tag, 6473 chatTag,
  2510 contactTag, 44 template, 4 announcement, 5 blast + 10 log, 3 folder +
  8 file (media file re-encrypted di disk), 1 scheduled msg, 4 csat, 7 note,
  347 event, 30 purgeLog, + semua config singleton (app/autoReply/appearance
  #FF69B4/csat/backup/menuGateway + 2 opsi).
- Isolasi terverifikasi: token admin Mazaya (shieva) → 200, scope tenant 8;
  Parahita (4) intact. 19 GAL yatim di-skip (audit lama grup yang sudah
  tidak ada — tidak dipakai operasional).
- PENTING: ini SALINAN, bukan move — hub non-SaaS tetap jalan utk nomor
  Mazaya; WA tenant Mazaya di SaaS belum dipair (pesan baru tetap masuk hub).
  Pairing WA = keputusan owner (nomor sama 2 sistem = double auto-reply).
- Backup pra-migrasi: wa-cs-hub/backup/pre-mazaya-20260922-1251/ +
  wa-cs-hub-saas-v3/backup/pre-mazaya-20260922-1251/ (md5 match).

## v3.2 — WhatsApp LIVE per tenant: QR + pairing code + reconnect/logout (2026-09-22)

- Laporan owner (10:54): tenant "Parahita" baru dibikin, scan QR tapi QR GAK
  muncul. Bukan bug runtime — ini fitur fase 2 yang belum diport: v3 masih
  jalan dgn `WA_DISABLED=1` + pool stub fase 1 (endpoint /api/wa/qr memang
  nolak: "koneksi nyata = fase 2").
- Solusi: port real pool dari wa-cs-hub-saas v2 (`src/wa/pool.js`, 889 baris
  produksi) ke v3 + upgrade dari lesson non-SaaS baileys.js v0.15.x:
  - Socket Baileys PER TENANT + auth dir per tenant
    (`data/wa-session/tenant-<id>/`, auto-assign ke Tenant.waSessionDir)
  - QR per tenant: diterima → connectionState 'qr' → data URL on-demand →
    broadcast `wa_status` ke room `tenant:<id>` (frontend AdminWhatsApp
    sudah support sejak awal — tinggal backend-nya)
  - Pairing code per tenant (POST /api/wa/pairing-code, browser kanonik
    `Browsers.ubuntu('Chrome')` — lesson v0.13.8b IQ 400)
  - Reconnect backoff 5s→10s→30s→60s→60s MAX 5x (anti infinite 408 loop);
    loggedOut → hapus dir sesi tenant itu SAJA + clear waPhone
  - Media nyata: downloadMediaMessage → encrypt → save (paritas v2)
  - processIncomingMessage tetap versi v3 (lebih kaya: CSAT consume,
    auto-reopen, menu gateway, auto-reply, push, queue, grup via
    services/groups dgn ctx lengkap)
  - `WA_DISABLED=1` tetap didukung penuh sbg kill-switch (sekarang 0)
- routes/wa.js: stub fase 1 → endpoint nyata (status/qr/phone/reconnect/
  logout w/ ?confirm=true/pairing-code), semua tenant-scoped (requireTenant).
- Deploy: restart 5047 → boot bersih, pool langsung connect tenant "Parahita"
  → QR diterima, menunggu scan.
- E2E live (API, token admin tenant): /api/wa/status → {qrNeeded:true,
  state:'qr', baileysVersion 2.3000.x}; /api/wa/qr → data URL PNG 7.4KB;
  QR diverifikasi image model — clean, scannable, tanpa artefak.
- Sesi existing non-SaaS (5030) TIDAK tersentuh.

## v3.1.3 — Hotfix: delete user gagal (P2003) — 4 relasi User kelewat (2026-09-22)

- Laporan owner (10:31): setelah oslo & magetan di wa-cs-hub non-SaaS terbukti
  kena P2003 (v0.15.3), minta SaaS dipatch juga — "berarti yang di
  ChatBareng-SaaS ada bug yang serupa". Betul: transaksi delete di
  `DELETE /api/users/:id` SaaS identik (15 op) dan kelewat 4 relasi yang sama:
  **ChatNote.userId**, **ScheduledMessage.createdById**, **GDriveLink.user**
  (@unique, kredensial), **BackupLog.user** — semua non-nullable.
- Metode fina (lesson #4): backup DB (md5 match,
  backup/pre-delete-fix-20260922/) → repro di salinan /tmp: transaksi LAMA
  gagal P2003 (bug ke-reproduce), transaksi BARU bersih (deleted, residual
  0, chatNote & schedMsg kepindah ke admin) → baru patch live.
- Patch `src/routes/users.js`: +4 op tenant-scoped di transaksi
  (chatNote.updateMany + scheduledMessage.updateMany transfer ke admin;
  gDriveLink.deleteMany + backupLog.deleteMany). Guard requireTenant tetap.
- Deploy: restart 5047 (pid 38121), login 200, tema netral OK.
- E2E live end-to-end: tenant uji "Uji Del" + admin + cs diseed lengkap
  (chat assigned + pesan + chatNote + schedMsg + gDriveLink + backupLog) →
  DELETE cs via API admin tenant → 200 ok; residual SEMUA relasi = 0;
  chat/pesan/catatan terjaga (chat auto-unassigned, catatan & scheduled
  transfer ke admin). Tenant uji lalu dipurge sendiri via fitur v3.1.2
  (dogfood) — platform kembali bersih; tenant "Parahita" milik owner
  (dibuat 10:19) GAK tersentuh.

## v3.1.2 — Hapus Permanen Tenant (purge) (2026-09-22)

- Laporan owner (09:11): "kenapa tenant cuma bisa di-suspend? ga bisa di-delete
  permanen sekalian?" — Betul: tombol delete memang TIDAK PERNAH ada di UI.
  Endpoint DELETE /tenants/:id (fase 1) sengaja dibatasi tenant KOSONG saja
  (0 user, 0 chat) sebagai guardrail fase awal.
- Fix: POST /api/sa/tenants/:id/purge (superadmin-only) — hapus permanen
  tenant + SELURUH datanya dalam SATU transaksi, urutan child→parent
  menghormati FK Restrict (29 langkah): messages → blasts → csat/scheduled/
  notes/events/logs → join tags → contacts → chats → tags → files/folders →
  announcements → templates → row user-scoped tanpa tenantId via FK
  (pushSubscriptions, gDriveLinks, backupLogs, favoriteMessages) → users →
  configs → tenant. TANPA migrasi schema (cascade DB yang sudah ada dipakai
  untuk BlastLog/AnnouncementRead/FavoriteMessage/ChatTag).
- Guardrail konfirmasi: body { confirmName } WAJIB sama persis dengan nama
  tenant — dicek BACKEND (bukan cuma UI), anti salah-klik untuk operasi
  irreversibel.
- Cleanup pasca-transaksi: file media (message.mediaPath /
  sharedFile.storagePath / blast.mediaPath) dihapus dari disk SETELAH
  transaksi sukses (rollback → file utuh); VACUUM best-effort; socket room
  tenant di-kick (auto-logout saat reconnect); cache themeCss di-invalidate.
- UI SuperAdmin.vue: tombol "Hapus" (merah) per tenant → form konfirmasi
  inline: peringatan dampak + jumlah user/chat, field ketik nama persis,
  tombol "Hapus Permanen" disabled sampai nama cocok persis.
- E2E nyata: tenant uji "Uji Purge" diseed 24 tabel + 3 file media dummy.
  Wrong name → 400 "Konfirmasi gagal"; correct → 200 {users:1, chats:1,
  messages:2, …, filesRemoved:3}. Post-check: SEMUA tabel tenant #3 = 0 row,
  file dummy hilang dari disk, /theme.css?tenant=3 kosong; tenant uji accent
  1 & 2 INTACT (login OK, accent #16A34A/#EA580C, regression 15/15 PASS).
- Bug ditemukan E2E & fixed: nama Prisma model `gDriveLink` (camelCase,
  bukan gdriveLink) → transaksi otomatis rollback, 0 data hilang salah.
  Bukti lagi kenapa E2E nyata > "sudah kutulis jadi pasti jalan".
- Backup DB sebelum implement:
  state/saas-v3-db-backup-before-purge-20260922-0915.db

## v3.1.1 — Superadmin: panel Akun (ganti password mandiri) (2026-09-22)

- Laporan owner (09:01): halaman superadmin "berasa barebones" — tidak bisa
  ganti password sendiri. Betul: superadmin TIDAK punya akses /settings
  (hanya tenant users; router guard v3.0), jadi fitur self-service
  change-password (v0.12.2) tidak pernah tersedia bagi mereka.
- Fix: panel "Akun" baru di SuperAdmin.vue — 3 field (Password saat ini /
  Password baru min 6 / Konfirmasi) + tombol Ganti Password. Reuse endpoint
  `POST /api/auth/change-password` yang sudah ada (requireAuth,
  role-agnostic, verifikasi current password, rate limit ketat 10x/15m) —
  TANPA perubahan backend.
- E2E: superadmin endpoint merespons benar (wrong current → 401
  "Current password incorrect"); round-trip nyata di akun uji (ganti →
  login password baru OK → restore → login password asli OK). Password
  superadmin produksi tidak tersentuh.
- Visual: screenshot Chrome 18801 — panel render bersih, tombol terlihat
  penuh (dicek model image, PASS).

## v3.1 — Isolasi Accent Tema per-Tenant: Login Page Netral (2026-09-22)

- Laporan owner (05:08): multi-tenant SaaS — ganti accent oleh admin tenant
  seharusnya hanya mempengaruhi tenant-nya sendiri, bukan permukaan "umum".
- Audit Alita (05:13): data sudah benar (`AppearanceConfig` per-tenant, PUT
  di-scope dari JWT) TAPI semua endpoint tema PUBLIK masih fallback
  "tenant pertama" (`?tenant=` tak pernah dikirim frontend; user tenant
  memang tidak diberi tahu tenantId-nya). Akibat: (1) accent tenant #1
  bocor ke login page semua orang; (2) accent tenant #2+ tersimpan tapi
  tidak pernah tersajikan, bahkan ke user tenant itu sendiri; (3) cache
  /theme.css satu slot global → risiko cross-tenant CSS.
- Bukti visual SEBELUM fix (Chrome 18801, 2 tenant uji: #16A34A hijau /
  #EA580C oranye): login page tombol "Masuk" HIJAU (bocoran tenant 1),
  dashboard tenant 2 juga HIJAU (tema sendiri tidak tersajikan).
- Backend `src/routes/appearance.js` (v3.1):
  - Fallback `findFirst` ("tenant pertama") DIHAPUS dari 3 handler publik
    (`/api/appearance/public`, `/theme.css`, `/manifest.webmanifest`).
    Tanpa `?tenant=`/`X-Tenant-Id` → netral platform `#6D28D9`
    (public endpoint selalu 200 valid; theme.css kosong = tokens default;
    manifest theme_color = DEFAULT_SEED). `?tenant=N` valid tetap
    didukung (forward-compat subdomain per-tenant); tenant invalid → netral.
  - Cache `/theme.css` kini PER-TENANT (`Map` keyed tenantId | 'default');
    `invalidateThemeCssCache(tenantId)` hapus key itu saja; PUT menghapus
    key tenant yang diubah.
  - `GET /api/appearance` (auth) kini mengikutkan `themeCss` — dipakai
    frontend apply tema tenant runtime (tanpa reload). Semua role tenant
    boleh membaca (tema tampil untuk seluruh tenant).
- Frontend (v3.1):
  - `utils/tenantTheme.js` BARU: `applyTenantThemeCss(css)` inject/replace
    `<style id="tenant-theme">` (idempotent), `loadAndApplyTenantTheme()`
    = GET /api/appearance via JWT + apply + sinkron meta theme-color,
    `clearTenantTheme()` saat logout. tenantId tetap tidak pernah bocor.
  - `App.vue`: bootstrap post-`fetchMe` → apply tema tenant; tanpa sesi →
    clearTenantTheme (permukaan kembali netral).
  - `stores/auth.js`: apply tema setelah `login()` (SPA tanpa reload) dan
    setelah `impersonate()` (superadmin view-as tenant ikut tema tenant);
    `logout()` → clear + meta kembali netral.
  - `utils/themeColor.js`: `syncThemeColorMeta(seed?)` — seed tenant dari
    caller (post-login), tanpa fetch publik; tanpa param = perilaku lama
    (netral pre-login).
  - `index.html` init script: fetch public kini di-guard `token` — sesi
    login tidak menimpa meta dengan warna netral (runtime tenant yang
    pegang). Anti-FOUC `data-theme` tetap selalu jalan.
  - `AdminAppearance.vue`: setelah PUT sukses → apply LIVE tanpa reload;
    pesan "Accent aktif di seluruh app."
- Cascade: `/theme.css` (netral) tetap di-inject index.html; style
  tenant-theme di-append belakang → specificity sama, terakhir menang.
- E2E 15 assertion PASS (scripts/saas31-e2e.sh): endpoint publik tanpa
  tenant netral #6D28D9; `?tenant=1/2` resolve benar; alternasi cache 2x
  tanpa cross-leak; GET auth per-tenant terisolasi; manifest template utuh.
- Bukti visual SETELAH fix: login page ungu netral; dashboard tenant 1
  HIJAU; dashboard tenant 2 ORANYE — screenshot Chrome 18801.
- Test data: tenant "Uji Accent Satu" (#16A34A) + "Uji Accent Dua"
  (#EA580C) + admin `uji_admin1/2` — sengaja dibiarkan untuk regression
  demo; silakan hapus via Superadmin bila tak dipakai.
- Tanpa migrasi DB (schema v3.0 sudah sesuai). `wa-cs-hub-saas-v3` masuk
  BACKUP_TARGETS backup-local.sh di hari yang sama (lesson 2026-08-31).

## v0.15.2 — Bugfix behavior: Admin klik "Chat" dari Kontak kini auto-claim (2026-09-21)

- Laporan owner (12:58): akun Admin klik tombol Chat di halaman Kontak pada
  chat unassigned → chat TIDAK di-claim (masuk Unassigned), padahal akun CS
  langsung di-claim. "Kan aneh banget ya wkwk."
- Root cause: gate v0.5.0 di `POST /api/contacts/:id/open`
  (`claimIfUnassigned`) sengaja membatasi auto-claim hanya role `cs`
  ("admin manual via Take") — keputusan lama yang bikin pengalaman admin
  janggal: chat yang dia inisiasi sendiri malah masuk antrean.
- Fix: gate diperluas ke `cs` ATAU `admin`. Relay (Cabang) TETAP tidak
  boleh klaim (chat relay hanya lewat transfer) — negative test verified.
- E2E: kontak dummy → open sebagai relay (tetap unassigned ✓) → open
  sebagai admin (langsung terklaim ✓, queuedAt null, event `assigned`
  tercatat); test data dibersihkan, antrean asli tidak tersentuh.
- Guidebook: bullets Kontak ("berlaku untuk CS & Admin") + Peran Admin
  diperbarui.

## v0.15.1 — Templates: Export & Import JSON (portabilitas antar-deployment) (2026-09-21)

- Fitur: tombol **⬇️ Export** dan **⬆️ Import** di halaman Admin → Templates.
  Motivasi: deploy ChatBareng di tempat lain tidak boleh mulai dari library
  template kosong — export JSON dari sini, import di sana (hari ini: 44
  template, termasuk 40 hasil import quick replies Cekat.AI).
- `GET /api/templates/export` (admin): 1 file JSON semua template
  `{format:'wa-cs-hub-templates', version:1, exportedAt, exportedBy, counts,
  templates:[{name,keyword,content,category}]}`, filename
  `chatbareng-templates-YYYYMMDD-HHmm.json`.
- `POST /api/templates/import` (admin, multipart `file` .json maks 5MB,
  `?dryRun` untuk preview tanpa tulis DB): sifat AMAN — tidak ada
  delete/update. Keyword sudah ada di DB → **skip** (existing menang); name
  sudah ada (keyword beda) → auto-rename `(import)` / `(import2)` dst; duplikat
  keyword dalam file → entry kedua skip; entry invalid → `errors[]` tanpa
  membatalkan sisanya. Maks 1000 entry per file.
- Frontend: modal konfirmasi (pattern delete-confirm), panel hasil
  created/skipped/renamed + errors scrollable, toast ringkasan, refetch +
  emit `template_update {action:'imported'}` sekali → composer "/" ikut refresh.
- Pure functions (normalizeTemplateEntry, mergeDecision, buildExportPayload,
  parseImportPayload) di-attach ke router untuk unit-test offline (27 test
  Dory + 14 test independen Alita — semua PASS).
- Spec: `docs/spec-v0.15.1-templates-export-import.md`.

## v0.15.0 — Import dari Cekat.AI (tombol admin, auto-convert) (2026-09-21)

- Fitur: section **📥 Import dari Cekat.AI** di Admin → Riwayat → Backup &
  Restore. Upload CSV export conversations Cekat.AI (delimiter `;`, utf-8 atau
  cp1252, maks 50MB / 20.000 baris) → server auto-convert → preview dry-run →
  import. Dipakai ulang oleh owner tanpa perlu konversi manual.
- Aturan konversi = converter Python yang sudah terbukti (import manual
  2026-09-21, 2.509 chat): hanya channel WhatsApp (TikTok/IG skip), phone
  normalisasi 0/8→62, `created_at` WIB→UTC, semua chat → arsip `resolved`
  (fresh start; chat masuk lagi → reopen ke antrean), handled_by → username
  match case-insensitive, tag "Import CekatAI" + label + pipeline asli,
  `first_message` → pesan pertama (kosong → placeholder).
- Engine: `POST /api/history/import` diekstrak dari route ke
  `src/services/historyImport.js` (MECHANICAL move — perilaku identik, kini
  reusable) + `src/services/cekatCsv.js` (parser CSV dengan fallback
  windows-1252) + `src/services/cekatConverter.js` (pure converter) +
  `src/routes/cekatImport.js` (mount `/api/cekat-import`, admin, post-pass
  ContactTag "Import CekatAI" idempotent).
- Idempotent by design: dedup key engine (chatId+ts+direction+sender+content)
  → upload ulang file sama aman (run-2: created 0 / merged 2509 / skipped
  2509 — terverifikasi test offline + import manual).
- Frontend AdminHistory.vue: form upload + tombol Preview (Dry Run) + Import,
  panel hasil rowsTotal/rowsSkipped/chatsCreated/chatsMerged/messagesAdded/
  contactTagsLinked.
- Spec: `docs/spec-v0.15.0-import-cekat.md`.

## v0.14.9 — Bugfix: chat LID hilang dari SEMUA list + banner queue mismatch grup (2026-09-21) — QA LULUS (Alita E2E 10:41 + Kanaka 10:43)

- Laporan Kanaka (10:24): banner "3 Chat baru di antrean" muncul di dashboard,
  tapi tab Unassigned kosong (akun admin).
- **Root cause — jebakan NULL Prisma (pola sama kayak menuState v0.13.3):**
  filter anti-grup v0.14.0 `{ phoneJid: { not: { endsWith: '@g.us' } } }` TIDAK
  match row phoneJid NULL (SQLite 3-valued logic: NULL NOT LIKE → NULL → row
  dibuang). Kontak era LID (WA modern) tersimpan dengan phoneJid NULL → chat
  hilang dari SEMUA tab list, bukan cuma Unassigned. Asumi lama di komentar kode
  "row NULL tetap muncul" terbukti salah secara empiris.
- **List** (`src/routes/chats.js` GET /api/chats): null-escape eksplisit
  `OR: [{ phoneJid: null }, { phoneJid: { not: { endsWith: '@g.us' } } }]` +
  guard id-based `NOT: { id: { endsWith: '@g.us' } }` (id = PK selalu terisi →
  bebas jebakan NULL; grup dengan phoneJid NULL pun tetap terkecualikan).
  Ditaruh di where.AND agar komposabel dengan blok menuState/tagIds yang
  juga append ke where.AND.
- **Banner/queue** (`src/socket/queue.js` queueWhere): tambah
  `NOT: { id: { endsWith: '@g.us' } }` — grup yatim (belum ada PIC) tidak
  terhitung di banner queue dan tidak bisa di-claim via take-next; invariant
  baru: **banner count == isi tab Unassigned**.
- LESSON: pola negasi-OR `NOT (OR phoneJid endsWith ...)` JUGA kena jebakan NULL
  (dry-run hasil 0; `NOT (false OR NULL) = NULL`) — untuk filter kolom
  nullable, SELALU pakai null-escape eksplisit, jangan negasi-OR.
- **QA E2E** (JWT admin lokal, server pasca-restart): queue-count 3 == tab
  Unassigned 3 (Lili, Arya Budi, Loca Images — semuanya @lid) ✅; tab All 8
  chat, 0 grup bocor ✅; WA session reconnect otomatis 10:40:15 ✅; tunnel +
  bit.ly/chatbareng-parahita E2E 200 ✅. Verifikasi Kanaka 10:43 ("udah bisa cek
  3 chat unassigned") → pushed GitHub master + tag v0.14.9.

## v0.14.8 — Guidebook: section Grup + refresh daftar modul admin (2026-09-21) — USER-VERIFIED (Kanaka 10:43)

- Request Kanaka (10:08): panduan belum memuat fitur Grup (v0.14.0–v0.14.7) — "kan
  ada fitur grup itu baru yaa". Konten ditulis dari perilaku aktual kode (bukan tebakan):
  GroupListPanel/GroupManagePanel/Groups.vue, routes/groups.js, services/groups.js,
  CHANGELOG v0.14.0–v0.14.7.
- **Tab 💬 CS — "👥 Grup":** akses halaman Grup (desktop: topbar; mobile: segmen
  Kontak|Grup), buat grup (+ Buat Grup → CS otomatis PIC), balas chat grup (badge
  👥 + jumlah member, nama pengirim per bubble), popover nama pengirim (Simpan
  Kontak / Chat 1:1), panel Kelola Grup (tambah/keluarkan member, promote/demote,
  rename/deskripsi, 4 toggle: pengumuman/kunci info/approval/tambah member),
  reset link undangan (link lama mati), undangan via link untuk kontak LID-only,
  warning: bot wajib admin di grup WA + grup tidak bisa di-Release (ganti PIC lewat
  Assign PIC admin).
- **Tab 🛡️ Admin — "👥 Grup & PIC":** admin melihat semua grup + grup yatim (badge
  "belum ada PIC"), Assign PIC ke user aktif termasuk Cabang, log aksi grup, status
  bot admin.
- **Tab 🏪 Cabang — "Grup (sebagai PIC)":** grup yang di-PIC-kan ke Cabang; Cabang
  tidak bisa membuat grup sendiri (tombol hidden untuk relay).
- **Refresh basi:** section "Admin Panel — 8 Halaman" → "13 Modul" sesuai launcher
  aktual (Users, WhatsApp, Templates, Analytics, Pengumuman, Purge, Backup & Restore,
  Auto Reply, Menu Gateway, CSAT Survey, Backup Drive, Tampilan, Panduan).
- Footer panduan: v0.12.0 → v0.14.8.
- **Deploy:** frontend build saja — chunk `Guidebook-CQQ-DAlB.js` served 200,
  TANPA restart server (health 200, pola v0.12.0 guidebook pertama).
- **QA:** DOM text verified via CDP (section ke-render utuh, tanpa entity bocor) +
  screenshot section Grup dikirim ke Kanaka. USER-VERIFIED Kanaka 10:43 →
  pushed GitHub master + tag v0.14.8.

## v0.14.7 — Invite via Link (kontak LID-only) (2026-09-18) — QA LULUS (Alita E2E 17:27 + Kanaka 17:36)

- Kontak LID-only (tanpa nomor asli — WA menolak add langsung, LID ≠ phone) kini
  tetap bisa diundang: bot kirim LINK UNDANGAN grup ke chat 1:1 mereka (join mandiri).
- **Backend** (`src/services/groups.js`): `sendGroupInviteLinks(user, chatId, lids[],
  groupName)` — pola pmParticipant persis: invite code (metadata → bot admin →
  groupInviteCode fallback), kirim text undangan + link via WA dulu, upsert Chat 1:1
  born-assigned anti-race (P2002 retry), auto-reopen resolved, Message encryptText
  at-rest, broadcast new_message + chat_update. Isolasi dijaga (chat dipegang CS
  lain → error per-target, admin bebas); partial failure per-target; log action
  `invite_link`.
  - Integrasi: `createGroup` body.lids[] → memberResults gabung; `updateMembers`
    (action=add) body.lids[] → results gabung. Validation baru: "phones[] atau lids[]
    wajib diisi".
- **Picker** (`GroupMemberPicker.vue`): kontak LID-only (punya chat 1:1 terhubung)
  kini bisa dicentang — label amber "LID — via link undangan"; masuk daftar final
  sbg chatId (@lid) + flag viaLink; footer "N anggota · M via link undangan";
  chips prefix 🔗. Kontak tanpa nomor DAN tanpa chat tetap tidak bisa dipilih.
- **Panels**: GroupListPanel (buat grup) + GroupManagePanel (tambah member) split
  phones vs lids (`includes('@')`); toast "N link undangan terkirim"; lastResults
  tampil "🔗 link undangan" per-target.
- QA E2E: grup tes "Tes Invite Link (Alita QA)" — Kanaka add langsung ✓ (verify
  metadata WA), Loca link terkirim ✓ (verify msg terenkripsi + link cocok metadata
  inviteUrl + audit log create/add/invite_link). Kanaka confirm 17:36: link
  diterima di akun Loca ✓.

## v0.14.6 — Edit nama kontak manual → tampil di chatlist & header (2026-09-18) — QA LULUS (Kanaka 15:48)

- Lapor: edit nama kontak manual (klik nama di header chat → ganti field nama) tidak
  ter-refleksi ke chatlist & chat header. Harusnya edit manual = overriding nama.
- Root cause: display baca field denormalized `chat.contactName`, tapi PUT
  `/api/contacts/:id` cuma simpen ke row Contact — gak pernah sync ke field display.
  Bukti DB: kontak `name="Master Kanaka Prabhata"` vs `chat.contactName="Kanaka
  Prabhata"` (2 mismatch: Kanaka + MP Desta).
- Fix 3 lapis:
  1. **Server** (`src/routes/contacts.js`): PUT sync nama ke `chat.contactName` +
     broadcast `chat_update { contactName }`; `autoLinkContactChatByPhone` ikut
     sync saat kontak baru ter-link ke chat (nama manual menang).
  2. **Anti-clobber** (`src/wa/baileys.js` contacts.upsert): WA notify (nama profil)
     HANYA boleh isi `chat.contactName` bila belum ada nama manual (Contact row
     linked + name terisi) → edit manual tidak ke-timpa balik oleh event WA.
  3. **Frontend** (`Dashboard.vue`): `handleContactSaved` logika terbalik dibenerin
     (dulu cuma isi bila kosong — sekarang selalu override) + `onChatUpdate`
     reaktif `contactName` (header + chatlist realtime, lintas sesi).
- Backfill one-time: 2 mismatch lama di-sync (Kanaka Prabhata → Master Kanaka
  Prabhata; Desta → MP Desta). Backup DB `/tmp/pre-backfill-name-*.db`.
- Restart server diperlukan; health 200, WA reconnect; chunk Dashboard-btXn256L.js.

## v0.14.5 — TK Link + CSAT + multiline display (2026-09-18) — QA LULUS (Kanaka 13:08 / 13:28 / 13:53)

### Chat multiline: whitespace-pre-line (template tampil segaris lurus)

- Lapor (screenshot 13:50): pesan template multiline ("/" + keyword) tampil
  segaris lurus di ChatBareng, padahal di WA rapi — enter-enter hilang.
  Skenario: agent kirim template → customer copy-paste → balas dgn format
  sama → di WA rapi, di ChatBareng lurus semua → susah dibaca agent.
- Data terbukti BENAR (DB: msg #376/#378 decrypt mengandung `\n`) — ini murni
  display CSS: bubble `ChatDetail.vue` tidak punya `whitespace-pre-line`,
  HTML default collapse newline jadi spasi.
- Fix (frontend-only, satu class): `whitespace-pre-line` di bubble chat →
  semua pesan multiline (template, copy-paste customer, greeting) tampil
  enter-enter dengan benar.
- Chunk shared: fix ke-bundle ke `TanganKanan-IZt54EmJ.js` (Rollup gabung
  ChatDetail + TanganKanan; string fix terverifikasi di chunk yang dilayani).

### CSAT: survey pending expired (fix "CSAT nggak kekirim")

- Lapor: CSAT gak kekirim padahal enabled + chat di-resolve. Dugaan awal Kanaka:
  ikut rules greeting/gateway satu-per-hari — **TIDAK**: CSAT punya jalur guard
  sendiri (lastAutoGreetDate tidak pernah disentuh CSAT).
- Root cause (bukti dari DB): survey #3 (9 Sep 20:05) pending selamanya
  (terkirim, tak pernah dijawab) → guard "max 1 pending per chat" tanpa umur
  → **semua resolve berikutnya skip senyap** (gak ada notif/log ke user).
- Fix (`src/services/csat.js`, satu file, tanpa schema change): pending
  terkirim-tapi-tak-dijawab **> 48 jam = expired** → tidak memblokir survey baru.
  Anti-dobel tetap jalan (pending <48h tetap blokir), guard cooldown per_chat /
  per_agent / hybrid tak tersentuh, balasan rating tetap dialokasikan ke survey
  TERBARU yang terkirim (`orderBy id desc`).
- Diuji dengan copy DB di /tmp (produksi tak disentuh): pending 9 hari → survey
  baru dibuat ✓; pending 1 jam → tetap blokir ✓; cooldown tetap jalan ✓.
- Restart server diperlukan (backend); health 200, WA reconnect.

### TK: kirim Link ke chat (fix CORS network error)

- Lapor: "tangan kanan" gak bisa masukin link ke chat → toast "Failed to send:
  network error".
- Root cause: `confirmInsert()` (TanganKanan.vue) SELALU download file sbg blob
  via `GET /tk/files/:id/download` dulu. Untuk file tipe **link** endpoint itu
  ngerespons `res.redirect(url)` → axios ikut redirect ke domain eksternal →
  CORS blocked → "Network Error". Secara konsep juga salah jalur (link ≠ media).
- Fix (frontend-only): branch `file.type === 'link'` kirim `file.url` sbg **pesan
  teks** via `POST /api/chats/:id/reply` → WA nampilin preview link otomatis.
  Jalur media image/document tidak disentuh.
- Chunk: `TanganKanan-DosOa19l.js` (build 13:07, tanpa restart server).
- Backlog lanjutan di bawah payung v0.14.5 (belum): express-rate-limit trust
  proxy (ERR_ERL_UNEXPECTED_X_FORWARDED_FOR di belakang cloudflared);
  invite-via-link utk kontak LID-only.

## v0.14.4 — Participant Action Menu (2026-09-18) — QA LULUS (Kanaka 12:48)

Di chat grup, nama pengirim di bubble jadi clickable → popover 2 opsi:

- **Backend** (`src/routes/groups.js` + `src/services/groups.js`):
  - `POST /api/groups/:id/participants/:pmJid/save-contact` — nomor asli diambil dari
    metadata WA (`phoneNumber` utk LID participant); pn null → 422 pesan ramah
    "nomor asli belum tersedia"; kontak existing → isi name HANYA bila kosong
    (never overwrite); LID TIDAK PERNAH disimpan sbg phone (lesson 2026-09-18:
    9 kontak polusi LID-as-phone dibersihkan).
  - `POST /api/groups/:id/participants/:pmJid/pm` — kirim 1:1 dari grup:
    isolasi 403 bila chat 1:1 dipegang CS lain; upsert Chat anti-race (P2002 retry,
    pola createGroup); born-assigned ke pengirim TANPA queuedAt; auto-reopen
    resolved; Message terenkripsi at-rest + broadcast pola reply (chats.js).
- **Frontend** (`frontend/src/views/ChatDetail.vue`): label pengirim grup clickable
  (hanya `in` + `participantJid`), popover z-20 (overlay klik-luar + Escape), PM
  composer mini (Enter kirim), sukses PM → `/?chat=<pmJid>` (pola Kontak openChat).
  1:1 tidak berubah sama sekali.

## v0.14.3 — LID participant correctness (2026-09-18) — QA lulus (Kanaka)

Anggota grup WA modern pakai JID `@lid`; tiga lapis bug perbaikan:

- `mergeParticipantResults` match 3-jalur: digits JID respons + `phone_number`
  attrs node respons (Baileys v7) + digits JID terkirim (`sentJid`). Sebelumnya
  sukses terlapor "error" (kasus wadesta 10:47: 2/2 error padahal 1 masuk).
- **409 idempoten**: add target yang sudah member → `ok` "Sudah menjadi member
  grup"; remove target yang sudah keluar → `ok` "Bukan member — sudah keluar".
- `mapToParticipantJids` — remove/promote/demote kirim JID participant ASLI dari
  metadata (sebelumnya phone-jid → WA internal-server-error; kasus kick grup hello
  10:32). Ground-truth `reconcileWithMetadata` utk add/remove.
- Detail payload bawa `pn` (nomor asli bila WA mengirim) + nama kontak dicocokkan
  by LID-atau-pn; `sentJid` tidak bocor ke API response.
- Data: 9 kontak polusi (phone = LID digits) dibersihkan → phone=NULL (backup
  `backup/pre-v0143-lid-*.db`); jalur auto-save diguard agar tak mengulangi.

## v0.14.2 — Grup UI fixes (2026-09-18) — QA lulus bertahap (Kanaka)

- Composer chat grup **stay di bawah** (lapor 09:41): pane detail desktop dilock
  `max-height: calc(100dvh - 69px)` (PageShell tinggi-dokumen → chat rame memanjang,
  composer kebawa scroll).
- **Tangan Kanan** di halaman Grup (rail + panel, pola Dashboard; mobile pakai
  sheet Dashboard existing) — sebelumnya tombol emit ke nowhere.
- Badge "N baru" di list grup **realtime** (lapor 10:16): GroupListPanel kini
  mendengarkan `chat_update` grup (update row tanpa refetch penuh) + buka grup
  = POST /read (badge hilang otomatis di semua PIC/admin).
- Hotfix wiring composer: props `reply-text`/`sending` tidak diteruskan ke
  ChatDetail → tombol send disabled permanen (lapor 07:06); + Enter kirim.
- Nama pengirim bubble: Contact > pushName (nama profil WA per pesan) > LID
  (sebelumnya selalu `+<LID>`).

## v0.14.1 — Group Member Picker + Baileys 7 (2026-09-18) — QA lulus (Kanaka decree 11:55)

- `frontend/src/components/GroupMemberPicker.vue` (BARU, shared): 3 tab —
  **Kontak** (search + filter tag + pilih-semua per halaman, pola BlastComposer),
  **Nomor** (paste banyak: per baris/koma/`;`, preview valid/dibuang + alasan),
  **CSV** (parse penuh client-side: delimiter ,/;/tab, header detection, kolom
  nomor/phone auto, duplikat dihitung sekali). Footer chips final + ringkasan.
  Dipakai di form Buat Grup (GroupListPanel) & "+ Tambah Member"
  (GroupManagePanel; hotfix: import lupa → panel kosong).
- Backend tidak berubah: `phones[]` sudah dinormalisasi `normalizePhone`.
- **Baileys 6.17.16 → 7.0.0-rc14**: fix 406 `not-acceptable` (assertSessions gagal
  utk grup LID-participant; kirim 1:1 tak terdampak). Semua import terverifikasi;
  rollback `backup/baileys-rollback-20260918-0914.tgz`.
- Hotfix race `createGroup` (lapor 05:27): handler `chats.upsert` Baileys bisa
  bikin row Chat duluan → P2002 → 500 (grup sukses di WA, invite tidak terkirim).
  Insert → upsert + retry 1x; update mengisi PIC + `queuedAt: null`.
- Endpoint ops: `POST /api/groups/:id/leave` (bot keluar grup — admin only).


## v0.14.0 — Manajemen Grup (PIC Model) (2026-09-17) — QA LULUS (Kanaka 18 Sep 09:22)
(APPROVED Kanaka 17 Sep 18:02). Fitur grup = jalur BARU di samping jalur 1:1
(grup = born-assigned: picUserId + assignedToId di-set bersamaan → guard existing
otomatis bekerja; grup TIDAK PERNAH lewat antrean/take — spec §3/§4).

- **Backend (dari run sebelumnya, tidak diubah di run ini):** `src/routes/groups.js`
  (8 endpoint: list/detail/create/rename/members/settings/invite-reset/assign-pic),
  `src/services/groups.js` (service layer + WA-ready checks + partial-failure
  per-member + GroupActionLog), `src/server.js` mount `/api/groups`, `src/wa/baileys.js`
  jalur @g.us terpisah, `src/routes/chats.js` exclude @g.us dari list 1:1 (additive
  where), `src/socket/handler.js` room per-user PIC+admin, `prisma/schema.prisma`
  additive (Chat.picUserId, Message.participantJid, GroupActionLog) — SUDAH di-push.
- **Frontend (run ini):**
  - `frontend/src/router.js` — route `/groups` (name: Groups, meta auth), pola /contacts.
  - `frontend/src/views/Groups.vue` (BARU) — halaman Grup: list (GroupListPanel) +
    detail (ChatDetail existing + panel Kelola Grup GroupManagePanel); deep-link
    `?chat=` / `?assign=`; mobile list → detail via Dashboard `?chat=`.
  - `frontend/src/views/GroupListPanel.vue` (BARU) — list grup (PIC: miliknya; admin:
    semua + yatim), tombol "+ Buat Grup" hidden utk role relay, dialog Buat (nama
    wajib, deskripsi opsional, anggota awal multi-nomor, admin: dropdown PIC; CS:
    note "Kamu akan jadi PIC grup ini"), badge yatim "belum ada PIC" + Assign PIC.
  - `frontend/src/views/GroupManagePanel.vue` (BARU) — member list (add/remove/
    promote/demote, partial-failure per-member), toggle announcement/locked/approval/
    memberAddMode (optimistic + revert), reset invite via ConfirmDialog ("link lama
    mati"), rename/description, assign PIC; hint "Bot bukan admin di grup ini" +
    toggle disabled (bukan error mentah).
  - `frontend/src/views/Contacts.vue` — segmen mobile "Kontak | Grup" di atas list
    (desktop tidak berubah; Homerow TIDAK disentuh).
  - `frontend/src/views/ChatDetail.vue` — additive: label pengirim grup (nama Contact
    > +HP dari participantJid), badge "👥 Grup" + jumlah member, avatar inisial nama
    grup; notes/kebab 1:1 disembunyikan utk grup (release di grup akan melepas PIC →
    melanggar invariant born-assigned). Chat 1:1 fallback identik (tidak berubah).
  - `frontend/src/utils/groupsApi.js` (BARU) — peta error ramah: 503
    WA_BELUM_TERHUBUNG, 422 BOT_BUKAN_ADMIN, 403 → ToastStack pesan Indonesia.
- **Self-test:** `scripts/test-v0140.js` (pola test-v0133) — regression guard §7
  8 item via routes ASLI di port acak + DB COPY `/tmp/db-test-v0140.db` (produksi
  tidak disentuh). Hasil: **33 pass / 0 fail**. WA stub in-process test-only utk
  verifikasi shape reply.
- **Guardrail dijaga:** tidak ada prisma db push, tidak ada restart server 5030,
  tidak ada npm run build, tidak ada git commit/push, tidak ada WA keluar.
- **Deploy (Alita):** review diff → `npm run build` di frontend → restart server
  produksi (setsid, log /tmp/chatbareng-server.log) → health 5030 → QA grup nyata
  "ChatBareng QA Grup" → regression guard §7 cek ulang di produksi → PUSH DITAHAN
  sampai USER-VERIFIED (pola v0.13.7).

## v0.13.9 — Pairing Code Reliability Fix (2026-09-15) — MENUNGGU DEPLOY (Alita + Kanaka)

**Konteks:** Login via Pairing Code selalu gagal di HP ("Coba masukan kode lagi…") —
0/11 berhasil (12–15 Sep), sementara QR selalu berhasil. Forensik log: 408 reconnect
loop (1.465 event, mulai sejak boot SEBELUM ada request pairing) + umur socket ±5–11
dtk → kode pairing ke-bind ke socket yang mati sebelum user selesai mengetik di HP.
Spec: `wa-cs-hub-v0.13.9-spec.md` (APPROVED Kanaka 11:20).

- **FIX (K-1, root cause kandidat utama):** socket lama kini di-`end()` + listeners
  dibersihkan (`removeAllListeners` connection.update/creds.update/messages.*) SEBELUM
  reconnect terjadwal di close path (shouldReconnect). Dulu: socket setengah-hidup
  menumpuk (connectToWhatsApp() menimpa `sock` tanpa end) → WA throttle koneksi
  pre-auth → 408 terus. Guard #2770: auto re-issue tidak pernah double-request pada
  socket yang sama (track `pairingIssuedOnInstance`).
- **ADD (§3.2):** semua log `[WA …]` bertimestamp WIB via `waLog()`; socketAge +
  instance counter (`Socket created (instance #N)`, `socketAge: 6.2s`) saat close;
  detail error Boom (message + output.payload dipotong 200 char); log `QR issued
  (instance #N)`; warning sekali `408 loop detected — pairing code akan sering
  berganti; pertimbangkan QR` saat ≥3 close/60 dtk.
- **ADD (§3.3):** pairing pending lifecycle — kode di-issue → `pairingPending`
  (TTL 5 menit, max 20 re-issue); saat socket cycle (close→connecting) kode di-
  issue ULANG otomatis ke nomor yang sama (delay 1.5 dtk + gap ≥5 dtk antar re-issue,
  gap tidak ter-reset per-socket), broadcast `wa_status` membawa field baru
  `pairingCode/pairingIssuedAt/pairingPending/pairingInvalidated/pairingReissueCount`.
  Cooldown 60s kini per-socket-instance (guard #2770 hanya untuk socket yang sama);
  cooldown endpoint manual tidak berubah. Lifecycle reset saat open/logout/reconnect.
- **ADD (§3.4):** auto-reissue saja — retry 3x @2 dtk saat WA_NOT_READY; endpoint
  manual tidak berubah.
- **UI (§4):** mode Pairing Code — countdown "Kode aktif — Xs" (90 dtk dari
  `pairingIssuedAt`), auto-update kode dari broadcast TANPA reload + micro-toast
  "Kode diperbarui otomatis", banner kuning "Sesi pairing berakhir" saat
  `pairingInvalidated`, hint abu-abu "QR lebih andal" saat re-issue ≥3x/menit
  (QR tidak disembunyikan). Cooldown client-side mengikuti kode terbaru tanpa
  menahan tampilan kode baru. **MODE QR TIDAK BERUBAH SAMA SEKALI** (regression gate).
- **Baileys (§5):** TIDAK di-upgrade. Terdeteksi: `latest` = 7.0.0-rc14 (MAJOR +
  ESM-only, butuh Node ≥20, release candidate), jalur legacy = 6.7.24 (revert
  release — body kosong), 6.17.16 masih versi terbaru jalur 6.17.x. Tidak ada
  patch/minor non-breaking tersedia → sesuai aturan spec: STOP, tidak di-upgrade.

**Verifikasi build (Dory):** `node --check src/wa/baileys.js` ✅ · `cd frontend &&
npm run build` ✅ (AdminWhatsApp 11.01 kB) · QR flow review: diff frontend hanya di
blok Pairing Code + state pairing (template QR, handler qrDataUrl, fetchQR utuh) ✅.
**Belum diuji live** — deploy + smoke E2E (spec §8) = tahap terpisah Alita + Kanaka;
produksi TIDAK disentuh selama build ini (WA live via QR 15 Sep, PID 12886/port 5030).

**Risiko deploy:** (1) perubahan perilaku close path — diharapkan menghentikan 408
loop, tapi jika justru reconnect jadi lambat, turunkan `WA_RECONNECT_INTERVAL_MS`;
(2) auto re-issue menambah request pairing otomatis (max 20x/5 menit, gap 5 dtk —
aman terhadap rate limit WA); (3) field baru `wa_status` additive — Dashboard lama
tidak terpengaruh.

**Rollback:** revert commit + rebuild frontend + restart (tanpa perubahan DB/schema).

---

## v0.13.7 — WhatsApp Pairing Dual-Mode: QR + Pairing Code (2026-09-12) — MENUNGGU QA KANAKA

**Konteks:** Skenario WA ke-logout saat HP pemilik nomor away — scan QR butuh kamera +
kehadiran fisik. WhatsApp menyediakan pairing via nomor: web menampilkan kode 8
karakter, HP mengetikkannya (Setelan → Perangkat tertaut → "Tautkan dengan nomor
telepon saja"). Spec APPROVED Kanaka 12:41.

**Yang dibangun (build Dory, review Alita — ADDITIVE ONLY, tanpa perubahan schema):**
- **UI Admin → WhatsApp:** saat disconnected/qrNeeded muncul 2 tab M3 — "Tambahkan
  via QR" (DEFAULT, perilaku existing utuh — regression gate #1) dan "Tambahkan via
  Pairing Code": input nomor digits-only (8–15, strip otomatis via watch), tombol
  "Minta Kode" → POST /api/wa/pairing-code → kode besar terformat XXXX-XXXX +
  Copy + "Minta ulang" + panduan 4 langkah di HP + hint kedaluwarsa. Saat connected
  panel disembunyikan seperti QR sebelumnya. Pairing code ikut live-update via
  broadcast `wa_status.pairingCode`.
- **src/wa/baileys.js (additive):** `requestPairingCode(phoneNormalized)` — guards
  WA_SUDAH_TERHUBUNG (409) / WA_NOT_READY (503); call `sock.requestPairingCode`
  (API terverifikasi Baileys 6.17.16 index.d.ts:145); simpan lastPairingCode+issuedAt
  module-level IN-MEMORY (TIDAK persist DB); broadcast wa_status; reset saat
  connection open / logout / reconnect. `formatPairingCode()` XXXX-XXXX (grup 4-4).
  QR flow TIDAK disentuh sama sekali.
- **src/routes/wa.js (additive):** POST /api/wa/pairing-code (requireAuth+requireAdmin):
  strip non-digit → validasi 8–15 → 400 ramah; 409 sudah terhubung / 503 belum siap
  / 502 gagal upstream; response { code, formatted }. Kode TIDAK PERNAH dikirim ke
  pelanggan — hanya admin yang meminta.

**Verifikasi build:** npm run build frontend ✅ (AdminWhatsApp 8.43 kB) · node --check
kedua file ✅ · diff audit: hanya additive di 3 file ✅ · unit formatter 11/11 pass ✅ ·
restart 5030 (kill PID eksplisit, setsid nohup + disown) → health 200 + "WA Connected"
tanpa re-pair (multi-file auth state persist) ✅ · smoke: /api/wa/qr masih hidup (400
"QR not needed — open"), POST pairing-code saat connected → 409 ramah, nomor invalid
→ 400 ramah, tanpa token → 401, status tetap connected (62881080702624) ✅ ·
cloudflared tidak disentuh ✅. Backup DB: backup/pre-v0.13.7-20260912-124517.db.

**QA Kanaka (checklist spec §5):** default QR ✅ (dicek saat build) · pairing via kode
E2E + kirim pesan pelanggan ⏳ menunggu QA live.

**Rollback:** git revert commit ini + rebuild frontend + restart (backend ikut berubah,
beda dgn v0.13.6 yang frontend-only). DB: restore backup/pre-v0.13.7-*.db bila perlu
(sebenarnya tak perlu — tanpa perubahan schema).

---
## v0.13.6 — Admin Sidebar Desktop + Settings Search (2026-09-12) — USER-VERIFIED ✅ (Kanaka QA live 11:19–11:46, dgn 4 iterasi r2–r5)

**Laporan Kanaka (10:33):** admin panel makin banyak — pengaturan susah dijump; minta dual-panel ala Windows 11 Settings (sidebar + konten) + search pengaturan. Dari tawaran 3 tahap, Kanaka setuju Tahap 1+2 dulu + WAJIB script rollback.

**Yang dibangun (build Dory, review Alita):**
- **AdminShell** — desktop /admin jadi shell 2 kolom ala Windows Settings: sidebar sticky kiri 280px (brand "← Dashboard", search box, list modul ikon+label+desc, item aktif M3) + panel konten kanan. Navigasi route-based → deep-link, refresh, back browser tetap aman. **Mobile 100% unchanged** (semua CSS terkunci `@media (min-width:768px)`).
- **Settings search** — index statis 13 modul, dropdown hasil M3, keyboard ↑↓/Enter/Esc, empty state; skor startsWith > contains per-token (bug "cs"→CSAT ketemu & difix saat build).

**Iterasi QA Kanaka (semua fix langsung oleh Alita):**
- **r2 (11:08):** (1) sidebar/search cuma 8 modul → LENGKAP 13 (spec salah tulis; launcher sebenarnya 13 sejak v0.13.0); (2) sidebar hilang di halaman modul → AdminShell dipindah ke router-level (semua /admin/* + /announcements + /guidebook = children; meta per-child dipertahankan; sidebar v-if admin).
- **r3 (11:29):** sidebar ikut tergulung saat konten panjang → akar = `overflow-x-hidden` di root mem-break `position:sticky` → fix ala Windows Settings: shell-row `100vh + overflow hidden` (halaman tak scroll), panel konten scroll INTERNAL (+ scroll reset saat pindah modul), topbar modul sticky.
- **r4 (11:36):** header modul masih tergulung → akar lapis-2 = PageShell `overflow-x-hidden` jadi scroll-container pasif (sticky nyantol ke dia) → netralkan overflow inner HANYA di dalam `.admin-content` desktop.
- **r5 (11:43):** header desktop masih ada tombol back (5 halaman) + emoji title + nama title gak konsisten dgn sidebar → semua dirapikan: header desktop = title polos tanpa emoji tanpa back; nama title diseragamkan ke sidebar (Users, WhatsApp, Purge, Templates, Backup Drive). Mobile topbar+back tetap utuh.

**Rollback (syarat Kanaka):** tag `pre-v0.13.6-admin-sidebar` (peaceful state) + script `scripts/rollback-v0136.sh` (checkout tag → rebuild frontend → health check; TANPA restart — frontend static). Script keuji beneran saat build (log 3 langkah hijau).

**QA Kanaka:** sidebar persist di semua halaman ✅ · jump antar modul cepat ✅ · search jalan ✅ · sidebar & header statis saat scroll ✅ · header konsisten tanpa back/emoji ✅ · mobile launcher grid utuh ✅ · dark mode ikut ✅.

Deploy: build frontend only (tanpa restart server, tanpa perubahan backend/schema).

**Follow-up polish QoL (12:06–12:14, USER-VERIFIED ✅ Kanaka QA 11:53–12:21):**
- Search chat list & Tangan Kanan diubah jadi pill M3 Expressive identik dgn admin sidebar (rounded-full, surface-container-highest, ikon kaca pembesar pseudo, focus border primary) — 3 search di app sekarang saudara kandung; import M3TextField terpakai ikut dibuang (bundle turun).
- Header Tangan Kanan `min-height:56px` — segaris dgn header nama kontak (border-bottom kedua panel berdampingan jadi satu garis lurus; lapor dgn screenshot).

---
## v0.13.5 — QoL UI: topbar desktop seragam + homerow active pill (2026-09-12) — USER-VERIFIED ✅ (Kanaka QA live 09:51)

**Laporan Kanaka (09:40):** tinggi header desktop beda-beda antar halaman (chat vs admin vs user pages); homerow mobile minta indikator halaman aktif.

**Fix (Alita, tweak kecil langsung — tanpa spawn):**
- **Topbar desktop seragam:** semua halaman pakai `.m3-topbar` (padding identik) tapi isinya beda — Dashboard (logo + chip status + tombol tema 44px) ≈ 68px vs halaman lain (link teks) ≈ 52px. Fix: `@media (min-width:768px){.m3-topbar{min-height:68px}}` — semua topbar desktop disamakan ke tinggi Dashboard. Mobile topbar (safe-area) tidak tersentuh.
- **Homerow active pill:** indikator halaman aktif — pill 52×28 `secondary-container` (token M3, ikut light/dark) absolute-centered di belakang ikon, animasi 180ms. Ikon aktif tetap primary; tinggi homerow & safe-area tidak berubah.

QA Kanaka: header tidak naik-turun lagi antar halaman ✅ · pill indikator tampil ✅.

---
## v0.13.4 — Notifikasi Privacy Fix + Tag Manager + Purge Reset Marker (2026-09-12) — USER-VERIFIED ✅ (Kanaka QA live 07:35–09:32, #1–#6 lulus)

**Laporan Kanaka (07:12):** (1) toast in-app unassigned menampilkan isi chat (bawaan v0.5.0); (2) PWA push / notifikasi sistem masih bocor nama+isi chat ke semua CS & admin; (3) double toast — 1 kejadian muncul 2x (socket + service worker push-inapp).

**Fix (spec `wa-cs-hub-v0.13.4-spec.md` — build Dory, review file-by-file Alita):**
- **A1:** toast in-app HANYA chat-mine, hanya ke pemilik chat. Unassigned = TANPA toast sama sekali (locked Kanaka 07:24) — badge antrean + queue count cukup.
- **A2:** push PWA antrean content-free — "Ada chat baru menunggu di antrean" tanpa nama kontak/isi pesan (tetap ke CS+admin aktif sebagai sinyal kerja). Push chat-mine tetap bawa isi.
- **A3:** double toast dibunuh — handler `push-inapp` skip `kind: 'message'` (toast socket sudah menampilkan saat app visible); kind lain (test/announcement) tetap jalan.
- **B Tag Manager (di Contacts):** chip filter tag (semua role) + panel Kelola Tag admin-only (list + contactCount, lihat kontak ter-afiliasi, export CSV by tag, delete dgn dialog M3, form tambah nama+warna); `GET /api/tags` +contactCount (additive); DELETE tag kini detach ContactTag juga (orphan fix); broadcast `tags_changed`; export `?tagId=` admin-only (403/404 tervalidasi).
- **C Purge:** reset marker auto-reply (lastAutoGreetDate, menuState, menuRequestedAt, menuOptionId + Contact.lastMenuShownAt) — purge = fresh start total, auto reply bisa trigger lagi tanpa reset manual.

**Review Alita:** 1 gap ketemu & hotfix — `GET /api/contacts` kini honor `tagId` (chip filter tidak silent-ignore; commit `ab71711`).

**QA Kanaka (live):** #1 antrean tanpa toast ✅ · #2 notif sistem tanpa isi ✅ · #3 toast mine-only ke Oslo ✅ · #4 tanpa double toast ✅ · #5 tag manager (buat/filter/export/delete) ✅ · #6 purge → marker nol semua ✅.

Deploy: build frontend + restart 5030 (health 200, WA Connected). Tanpa migrasi/schema. Backup: `backup/pre-v0.13.4-20260912-073038.db`.

---
## v0.13.3 — Gateway Entry Fix + Working-Hour Matrix + Frekuensi disatukan (2026-09-12) — USER-VERIFIED ✅ (Kanaka QA live 05:54–07:02, #1–#8 lulus)

**Hasil QA Kanaka (live, pesan WA asli):** #1 limbo (intro masuk, chat tidak muncul di antrean, chip admin ✅) · #2 jawab menu → tag + queue ✅ · #3 fallback "halo" → fallback + antrean ✅ · #4 timeout bekerja sesuai durasi ✅ · #5 luar jam + away ON → away text ✅ · #6 luar jam + away OFF → diem total ✅ · #7 greetMode text → greeting + langsung queue ✅ · #8 chat assigned → tidak ada auto message (bukti DB) ✅.

**Laporan Kanaka (04:19–04:47):** auto reply gateway tidak muncul; outside-hours dimatikan pun tetap hening; dugaan "working hour yang mengatur auto reply".

**Diagnosis (Alita, bukti DB — bukan tebakan):** 3 akar masalah:
1. **RC1:** trigger [B] dievaluasi DI AKHIR handler dgn syarat `queuedAt==null`, padahal auto-queue v0.1.21 mengisi `queuedAt` lebih dulu di handler yang sama → gateway/greeting/away **TIDAK PERNAH jalan utk chat baru** (bukti: `lastAutoGreetDate` tetap 2026-09-11 setelah QA 04:16). Away text v0.7.0 ikut jadi korban = regresi.
2. **RC2:** greeting tidak dijaga jam kerja — hanya short-circuit bila away ON; away OFF → menu bisa terkirim jam 2 pagi.
3. **RC3:** invariant §4.1 (chat awaiting tak terlihat/di-take dari antrean) belum diimplement di queue count/take-next/list/push.

**Fix (spec `wa-cs-hub-v0.13.3-spec.md` — build Dory, review file-by-file Alita):**
- **F1:** E0 early gate (`shouldFlowGateway`) SEBELUM auto-queue & push + matrix di hook akhir: (a) luar jam + away ON → away text saja (queue utuh); (b) dalam jam + mode menu → intro + `awaiting` (D1 limbo beneran: tanpa push/toast take, admin cuma lihat chip ⏳); (c) dalam jam + mode teks → greet text + queue utuh; (d) selain itu diem total. Anti-orphan: flow gagal → chat langsung di-queue-kan (tidak pernah hilang dari radar CS). Guard: chat assigned TIDAK pernah dapat auto message.
- **F2:** di luar jam kerja satu-satunya suara = away text (bila ON). Luar jam + away OFF = diem total.
- **F3:** chat `awaiting` di-exclude dari queue count, take-next, list antrean, dan push "Chat baru di antrean" (jebak NULL Prisma ditangani dgn OR eksplisit `[{menuState:null},{menuState:{not:'awaiting'}}]`).
- **F4 (keputusan Kanaka 05:02):** frekuensi disatukan — `repeatFrequency` Menu Gateway mengatur jalur menu DAN greeting teks; marker bersama `Contact.lastMenuShownAt`; label UI "Frekuensi greeting (menu & teks)".

**Deploy & verifikasi:** build frontend OK + restart 5030 (health 200, WA Connected) + smoke API + 19 unit tests + `node --check` 5 file. Tanpa migrasi/schema. Backup: `backup/pre-v0.13.3-20260912-0520.db`.

**QA (§4 spec):** 13 skenario — poin inti: dalam jam + gateway ON → intro masuk & chat TIDAK muncul di antrean (tanpa notif take); jawab/timeout → baru Take muncul; luar jam + away OFF → diem total (persis skenario gagal 04:16 kemarin).

---
## v0.13.2 — Sinkron 2 arah: toggle Menu Gateway ↔ radio Mode greeting (2026-09-12) — MENUNGGU QA KANAKA

**Laporan Kanaka (02:44, reply v0.13.1):** toggle "Aktif" di Menu Gateway katanya selalu balik ke off setelah simpan, dan gak sinkron dengan radio "Mode greeting" di Auto Reply — jadi gak bisa tau fitur nyala atau enggak.

**Diagnosis (Alita):** persist server BENER (proxy test: PUT enabled=true → tersimpan → GET true). Akar masalah = **dua saklar terpisah yang tidak tersambung**: `enabled` (MenuGatewayConfig) vs `greetMode` (AutoReplyConfig). Radio "Menu gateway" bisa nyala sementara gateway off → fitur gak jalan & tidak kelihatan. Desain buruk v0.13.0, bukan bug persist.

**Fix — satu saklar efektif, sinkron 2 arah:**
- PUT /api/autoreply: `greetMode=menu` → greeting otomatis ON + MenuGatewayConfig.enabled=true; `greetMode=text` → gateway OFF + releaseAwaiting (chat menunggu menu langsung di-queue, konsisten D12). Response bawa `menuGatewayEnabled`.
- PUT /api/menu-gateway: `enabled=true` → greetEnabled=true + greetMode='menu'; `enabled=false` → greetMode='text'. Response bawa `greetMode` (info sinkron).
- GET /api/menu-gateway: bawa `greetMode`+`greetEnabled` (sumber tampilan radio).
- Frontend: badge status + penjelasan "satu saklar efektif 2 arah", toast konfirmasi sinkron di kedua halaman.

**Deploy & verifikasi:** build (index-eFupAnfA.js) + restart 5030 (health 200). E2E 3 arah: toggle ON → greetMode=menu ✅; radio text → gateway OFF ✅; radio menu → gateway ON + greetEnabled=true ✅; restore state bersih (OFF/text).

**QA:** nyalakan toggle di Menu Gateway → simpan → cek Auto Reply → radio harus "Menu gateway". Sebaliknya: radio ke "Teks biasa" → simpan → toggle Menu Gateway ikut mati.

---
## v0.13.1 — QA UX Menu Gateway: intro terpisah dari list + inline tag creation + back button (2026-09-12) — MENUNGGU QA KANAKA

**Feedback Kanaka (01:01-01:09, dari mobile):** (1) preview cuma mengganti teks di dalam introText — kalau intro tanpa list, opsi hilang dari preview; DAN pesan asli ke pelanggan cuma introText doang (list dari opsi gak pernah di-generate); (2) aliases perlu klarifikasi (angka otomatis, aliases = tambahan opsional); (3) tag harusnya bisa dibuat langsung di halaman ini, bukan cuma pilih existing; (4) tombol back Menu Gateway harusnya ke Auto Reply (1 level), bukan skip ke Admin Panel.

**Fix:**
- **composeMenuIntro (service):** pesan asli = introText (kalimat pembuka SAJA — list legacy di-strip regex) + "\n\n" + list bernomor auto-generate dari Opsi Menu (sorted position). Preview UI di frontend identik 1:1 (logika sama persis).
- **Preview dipindah**: kartu terpisah "Preview Pesan ke Pelanggan" SETELAH kartu Opsi Menu (depends on options — urutan logis sesuai feedback).
- **TagSelect.vue (komponen baru):** dropdown pilih tag existing + opsi "+ Buat tag baru…" → input inline nama → POST /api/tags → tag baru auto-terpilih; 409 (tag already exists) = langsung bind ke tag existing (idempoten UX); dipakai di dropdown tag tiap opsi + fallback tag; tag baru di-upsert ke daftar lokal.
- **Alias hint** di kartu Opsi: "Aliases = kata kunci TAMBAHAN opsional — angka 1-8 sudah otomatis tanpa perlu diketik".
- **back-to="/admin/autoreply"** + desktop header "← Auto Reply" (1 level ke halaman asal).

**Deploy & verifikasi:** build live (index-NhsY9qSl.js), restart 5030 (health 200, WA Connected), API re-check: config enabled=false + options Komplain/Lainnya utuh, waiting 200. Compose unit test: intro murni + list generate ✅, intro legacy bawa list di-strip + re-generate ✅.

**Commit:** `2b0c08a` + tag v0.13.1, push GitHub master + tag.

---

## v0.13.0 — Fitur: Menu Gateway (auto reply triage) (2026-09-11) — DEPLOYED, MENUNGGU QA KANAKA

**Fitur (ide Kanaka 18:42, desain locked D1-D12, spec `wa-cs-hub-v0.13.0-menu-gateway-spec.md`):** auto reply triage menu bernomor (IVR-style): pelanggan baru dapat menu (1. Komplain 2. Ambil hasil dst) → jawaban menentukan balasan konfirmasi per opsi + auto-tag ke kontak (persistent, ContactTag) + mirror ke chat → baru chat masuk queue. Chat menunggu pilihan = limbo (gak masuk queue/notif take). Default OFF, zero behavior change.

**Build:** Dory 2 sesi (run#1 backend inti 25m runtime-cut; run#2 route+frontend 11m) + bugfix Alita (TDZ `isGroupChat` — deklarasi baris 805 dipakai di 685 → dipindah ke atas handler + alias isGroupChatTrigger). Backend ~800 baris, frontend ~850 baris.

**Implementasi (final state):**
- Schema: MenuGatewayConfig singleton (tenantId future-proof) + MenuGatewayOption (position unik 1..8) + ContactTag (@@unique, source manual|menu) + Chat.menuState/menuRequestedAt/menuOptionId + Contact.lastMenuShownAt + AutoReplyConfig.greetMode ("text"|"menu") — additive, zero data loss
- Service menuGateway.js: getConfig cache+seed idempoten; startFlow (claim atomik menuState null→awaiting, repeatAllows per_chat/daily/weekly via Contact.lastMenuShownAt WIB); handleChoice (claim atomik awaiting→done — race-safe vs sweep; matchOption: exact number 1..N + alias keyword, normalisasi " 2 )"-style; no-match → fallbackText + tag Lainnya, NO re-prompt; reply per opsi dgn {name}; tagContactAndMirror idempoten + broadcast tagAdded; queueChatAfterMenu: queuedAt=now + emitQueueUpdate; ChatEvent menu_choice); releaseAwaiting (timeout sweep 30s interval mulai post-WA-connect; enabled=false → release semua); pesan auto senderId=null isAuto=true, tanpa firstResponse
- API /api/menu-gateway (admin): GET config+options+waitingCount, GET /waiting, PUT validasi keras (unknown field 400, options 2..8 dgn position unik, tagId divalidasi ke Tag, timeout 10..3600s efektif, partial update OK) dgn $transaction atomic + invalidate + releaseAwaiting saat OFF; greetMode di PUT /api/autoreply (enum, 400 invalid)
- Frontend: AdminMenuGateway.vue (kartu status/intro+preview/opsi 2..8 reorder, dark-safe) + router + Admin launcher 🧭 + Guidebook admin section + Dashboard chip admin "⏳ Menunggu menu (N)" realtime menu_waiting_update + resume-sync refetch + AdminAutoReply radio greetMode (warning saat menu: greeting text gak terkirim)
- Invariants terverifikasi: limbo tidak masuk queue (baileys skip queue-increment utk handledByMenu; menuEligible gate: menuState null + belum queued + bukan consumedAsRating); outside-hours menang (jalur away return sebelum menu); sweep/PUT OFF release idempoten

**Deploy & verifikasi (Alita):** build frontend live (AdminMenuGateway chunk, index-Du9HnRhv.js) → restart 5030 (health 200, DB+WA Connected) → API E2E: GET config (default OFF, options seeded) ✅, GET waiting {count:0} ✅, PUT unknown field → 400 "Field tidak dikenal" ✅, PUT valid 2 opsi → 200 + tersimpan (Komplain/Lainnya) ✅, PUT autoreply greetMode=text → 200 ✅ → unit tests: matcher (1, " 2 )", alias, 0/9/halo→fallback), timeout clamp 10..3600, repeatAllows daily/per_chat ✅. Semua default tetap OFF (behavior identik v0.12.12).

**Rollback:** 3 lapis — DB snapshot `backup/pre-v0.13.0-menu-gw-20260911-1920.db` + git tag `pre-v0.13.0-menu-gw` (@2af69fe) + script `scripts/revert-v0.13.0-menu-gw.sh` (code-only default / --full-db).

**QA Kanaka (checklist):** Admin → Auto Reply → nyalain First-of-Day Greeting + mode "Menu gateway"; Admin → Menu Gateway → Aktif + isi opsi (tag dulu di menu Tag bila perlu) → chat dari HP jam kerja → intro menu; jawab "1" → konfirmasi + tag kontak + masuk queue; jawab "halo" → fallback + tag Lainnya; diam → timeout → queue; CS gak lihat chip; chip admin = 1 saat menunggu.

---

## v0.12.12 — QA UX panel catatan: tombol Simpan selaras + list cap 2 kartu scrollable (2026-09-11) ✅ USER-VERIFIED 11:22

**Laporan Kanaka (screenshot 11:08, mobile):** (1) tombol "Simpan" di form catatan nggak lurus dengan text field (tenggelam ke bawah karena `items-end` + counter di flex row); (2) kartu catatan menumpuk — minta maks 2 kelihatan, sisanya scroll, karena 3+ catatan makan space. Tambahan 11:09: cap 2 kartu berlaku JUGA di desktop view.

**Fix (NotesPanel.vue, frontend-only — komponen shared mobile+desktop jadi cap berlaku global):**
- Tombol Simpan: row `items-stretch` — tombol full-height selaras textarea (`self-stretch inline-flex items-center justify-center`), textarea `flex-1 min-w-0`; counter 0/2000 dipindah ke bawah row (dulu ikut di flex row = penyebab tombol tenggelam)
- List catatan: `max-height: 152px` (≈2 kartu dgn body 2 baris) + `line-clamp-2` di body kartu (text panjang dipotong 2 baris, full text via title hover) → 3+ catatan scrollable, tampilan seragam
- Catatan: cap via max-height pada container scroll — desktop section & mobile collapsible sama-sama terkena

**Deploy:** rebuild frontend (index-8NCez9bp.js), serve 200, live.

**QA:** tulis catatan panjang (>2 baris) → card terpotong 2 baris (tap/hoover = full); isi 3 catatan → list scrollable, panel gak melebar; tombol Simpan lurus sejajar textarea di mobile & desktop.

---

## v0.12.11 — Bugfix: tombol 📝 Notes desktop tidak berfungsi (2026-09-11) ✅ USER-VERIFIED 11:03

**Laporan Kanaka (10:53):** tombol Notes di desktop gak berefek apa-apa — bar catatan & pesan terjadwal tetap muncul; di mobile normal.

**Root cause (ChatDetail.vue):** tombol desktop men-toggle state mobile (`vpanelsMobileOpen`), sementara `vpanelsOpen` di desktop membaca `props.panelsOpen` yang TIDAK pernah dipass parent Dashboard (default `true` selamanya) → klik tidak pernah mengubah apa yang dibaca render.

**Fix (frontend-only):** desktop punya state sendiri `vpanelsDesktopOpen` (di-init dari `props.panelsOpen`, preferensi dipertahankan antar chat); tombol desktop men-toggle state itu; mobile logic tidak berubah (reset per chat tetap).

**Deploy:** rebuild frontend (index-Dq6SRduS.js), serve 200, live.

**QA:** desktop → buka chat → klik 📝 Notes → bar catatan/terjadwal harus kolaps; klik lagi → muncul lagi.

---

## v0.12.10 — Pindahkan toggle Read Receipt: Settings → Admin Panel → WhatsApp (2026-09-11) ✅ USER-VERIFIED 10:47

**Feedback Kanaka (10:44):** toggle "Centang Biru" kurang pas di Settings (yang di-share sama CS) — setting perilaku WhatsApp harusnya di **Admin Panel → WhatsApp**.

**Perubahan (frontend-only, backend nihil sentuh — API /api/app-config admin-only tetap):**
- `views/AdminWhatsApp.vue`: kartu baru "Centang Biru (Read Receipt)" di bawah kartu WhatsApp Connection — M3Switch + toast konfirmasi + rollback optimis (logika dipindah apa adanya)
- `views/Settings.vue`: kartu read receipt dihapus (bersih)

**Deploy:** rebuild frontend (index-6CEtx7uu.js), serve 200, live di server.

**QA:** Kanaka verified — toggle tampil & berfungsi di Admin → WhatsApp ✅

---

## v0.12.9 — Fitur: Read Receipt (centang biru) + toggle admin Settings (2026-09-11) ✅ USER-VERIFIED 10:43

**Latar (diskusi Kanaka 09:37):** pelanggan tidak pernah lihat blue tick walaupun akun bisnis & pelanggan set read state. Root cause: (1) call lama `sock.sendReadReceipt(chatId, undefined, [])` = method gak exist di Baileys v6 + array kosong → error ditelan `catch {}` = no-op total sejak dulu; (2) reply agent gak otomatis imply read (API = aksi terpisah); (3) `readMessages()` Baileys ikut privacy akun (readreceipts != 'all' → 'read-self', gak kelihatan pelanggan).

**Keputusan Kanaka (09:52):** toggle di Settings, **admin-only, universal, DEFAULT OFF** (perilaku lama tetap).

**Implementasi (Alita, backend + frontend):**
- **Schema:** `AppConfig` singleton (id=1): `readReceiptsEnabled` default false, `updatedById`; `npx prisma db push` additive (zero data loss, backup `backup/pre-v0.12.9-receipts-20260911-1001.db` 249KB)
- **Service `receipts.js`:** `markIncomingRead(chatId)` — kirim `sock.sendReceipts(keys, 'read')` EKSPLISIT (bukan readMessages → deterministik, app toggle = sumber keputusan); key = { remoteJid: chatId (LID-aware), id: waMessageId, fromMe: false }; idempoten (status di-DB → 'read' pasca kirim, tak dikirim ulang); broadcast `message_status` per pesan (UI agent sync); gate AppConfig + cache in-memory (invalidate saat PUT)
- **5 hook implied read (fire-and-forget):** reply teks, media reply (chats.js); auto greeting/outside-hours (autoReply.js); pesan terjadwal (v0100Scheduler.js); CSAT survey (csat.js)
- **`/read` route:** replaces no-op lama → receipts service (agent buka chat = blue tick, standard behaviour)
- **API `/api/app-config` (admin):** GET/PUT + validasi boolean + invalidate cache
- **UI Settings:** kartu admin-only "Centang Biru (Read Receipt)" + M3Switch + toast konfirmasi + rollback optimis kalau gagal; default OFF

**Deploy & verifikasi:** restart server 5030 (health 200, WA Connected), E2E API: GET default false → PUT true (valid + invalid type ditolak 400) → POST /read 200 → 5 pesan masuk chat test delivered→read (receipt terkirim, tanpa error di log) → idempoten (re-send = 0). Config dikembalikan **OFF** pasca-test. Build frontend (Settings chunk). Commit + tag v0.12.9 + subtree push GitHub.

**QA:** toggle ON di Settings (admin) → chat pelanggan dari HP Kanaka → biru ✓✓ pas agent buka/balas. Toggle OFF → tetap abu-abu.

---

## v0.12.8 — Fix stale chat list: resume sync setelah app dibekukan Android (2026-09-11) ✅ USER-VERIFIED 08:41

**Laporan Kanaka (screenshot 08:08):** preview chat list menampilkan pesan terakhir dari agent ("Sekarang aku oslo"), bukan latest sebenarnya ("Okee maaf oslo" dari pelanggan). Perilaku standard chat app = preview selalu pesan terakhir apapun arahnya.

**Diagnosis (Alita):** BUKAN desain & BUKAN data server. Audit DB langsung: preview tersimpan di server = "Okee maaf oslo" = latest true (checked 1/mismatch 0). Yang salah = UI stale: preview hanya di-update via socket realtime; PWA dibekukan Android di background → socket putus → event chat_update/new_message hilang → saat app dibuka lagi TIDAK ada refetch (0 handler visibilitychange, 0 refetch on socket reconnect). Stale state = pesan terakhir sebelum freeze.

**Fix (frontend-only, backend nihil sentuh):**
- `stores/socket.js`: hook `onReconnect(cb)` — callback dipanggil setiap event `connect` (termasuk reconnect pasca-freeze)
- `views/Dashboard.vue`: `onAppResumeSync()` — refetch chat list (pakai filter aktif) + queue count + snoozed count + thread aktif (currentChat), dengan debounce 2 dtk (visibilitychange+focus+connect bisa barengan)
- 3 pemicu: (1) socket connect/reconnect, (2) `visibilitychange` → visible, (3) window `focus`
- Cleanup lengkap di onUnmounted (listener + callback + timer)

**Deploy:** rebuild frontend (index-C9NpJbV3.js, Dashboard-CUEhkhFJ.js) — static dari disk, tanpa restart server.
**QA:** buka ChatBareng → home/tidurkan HP → minta pesan masuk → buka app lagi → preview & unread harus update sendiri tanpa pull-to-refresh.

---

---

## v0.7.0 — Auto Greeting: Outside Hours Reply + First-of-Day Greeting (2026-09-09) ✅ USER-VERIFIED

**Fitur (request Kanaka, spec `wa-cs-hub-v0.7.0-spec.md`):**
- **Outside Hours Reply** — pelanggan chat di luar jam operasional → auto balas "di luar jam operasional"
- **First-of-Day Greeting** — chat pertama pelanggan di hari itu (WIB) → auto greeting
- Prioritas dobel-trigger: outside-hours menang. Throttle 1x/hari/pelanggan (marker `Chat.lastAutoGreetDate`, claim atomik, crash-safe — restart tidak kirim ulang)
- Jam operasional per grup hari: Senin–Jumat / Sabtu / Minggu (toggle + jam masing-masing, default 08:00–17:00); hari disabled = dianggap full di luar jam kerja
- **Antrean tidak tersentuh**: chat tetap masuk Queue, tetap harus di-Take, FIFO utuh
- **Analytics aman**: pesan auto disimpan `senderId: null` + `isAuto: true`, tidak mengisi firstResponse; metric CS manusia-only
- Halaman admin `/admin/autoreply` (toggle, teks + `{name}`, preview, jam kerja); badge "⚙️ Otomatis" di bubble chat; default kedua fitur OFF

**Build:** Dory (19m) • **Verifikasi & deploy:** Alita (review kode, reset config state-test → default OFF, deploy by PID) • **USER-VERIFIED 12:40** ("Fiturnya udah bekerja dengan baik, greeting message langsung muncul")

---

## v0.7.1 — QA: zigzag time selector di Jam Operasional mobile (2026-09-09) ✅ USER-VERIFIED

**Laporan Kanaka (screenshot, setelah QA v0.7.0 dari HP):** fitur jalan (greeting muncul), tapi pengaturan jam kerja di mobile jelek — start & end time input terpisah zigzag (start nyangkut di kanan label, end jatuh ke baris bawah) karena `flex-wrap` me-wrap per-input.

**Fix (Alita):** bungkus start–end jadi SATU grup `flex items-center gap-1 shrink-0` (wrap per-grup, bukan per-input), label lebar auto (bukan `w-36`), row pakai `justify-between` + divider tipis antar hari, padding card responsif `p-4 sm:p-6`.

**Deploy:** rebuild frontend (bundle AdminAutoReply-XkJx0AEZ.js, index-BR-geNSq.js) — static dari disk, tanpa restart server. Frontend-only, backend nihil sentuh.

---

**Laporan Kanaka:** admin tidak bisa hapus akun CS "fina" — "Failed to delete: internal server error" (akun CS lain normal dihapus).

**Root cause (log server):** `prisma.user.delete()` kena P2003 foreign key constraint. Handler hard-delete v0.3.5 menangani 9 dari 10 relasi ke User di transaksinya — relasi **PushSubscription** (non-nullable sejak v0.4.0) terlewat. Akun fina punya 1 push subscription (notif HP aktif) → FK menolak delete. CS lain tanpa push sub → delete lancar.

**Fix (1 baris, Alita):** tambah `prisma.pushSubscription.deleteMany({ where: { userId: id } })` di transaksi DELETE `src/routes/users.js`.

**Proses:** backup DB (md5 verified) → reproduce P2003 di salinan DB → bukti fix sukses di salinan → patch live → restart → **user-verified 10:58** ("sudah bisa terhapus").

**Backfill (2026-09-09):** v0.3.4–v0.6.3 sebelumnya hanya tercatat di git log (file ini berhenti di v0.3.3). Ringkasan:
- v0.4.0 — fitur Notifikasi & PWA
- v0.5.0 — Role Cabang (relay) + Online Status/Presence
- v0.5.1 — fix realtime chatlist saat transfer + highlight 'transfer belum dibaca'
- v0.6.0 — Export & Import History Chat (Backup & Restore, admin)
- v0.6.1 — QA: tombol Download Backup tidak terlihat + rentang waktu export
- v0.6.2 — QA kritis: restore pasca soft-purge menghasilkan chatlist kosong
- v0.6.3 — QA: restore pasca-purge memunculkan chat lama sbg chat antrean baru

---

## v0.3.3 — QA: lebar card Templates vs Users tetap beda (fix empiris, 2026-09-02 01:55)

**Feedback Kanaka (01:46, 2 screenshot):** lebar card Templates vs Users masih beda, tidak konsisten — meski `max-w` sudah diseragamkan di v0.3.2.

**Diagnosa empiris (bukan nebak):** ukur geometry DOM beneran via Chrome 18801 + Playwright di viewport 390px:
- Templates: shell **255px** (kartu 53% layar) — padahal max-w identik
- Users: shell 384px (kartu 86%)

**Root cause:** quirk CSS — container `max-w-4xl mx-auto` di dalam parent `flex flex-col` bersifat **shrink-to-fit** terhadap lebar kontennya. Halaman dengan konten "sempit" (Templates) ikut menyusut; halaman dengan konten lebar (Users, tabel 560px) ikut melebar. `max-w` hanya cap atas, tidak memaksa penuh.

**Fix:** tambah `w-full` di container SEMUA halaman (admin launcher, Users, WhatsApp, Purge, Templates, Analytics, Settings, Announcements, Contacts) — `max-w` tetap jadi batas di desktop, mobile selalu full.

**Verifikasi pasca-fix (re-measure):** Templates shell **390px full** (kartu 88%, margin 24/24) vs Users 384px (kartu 86%, margin 24/30 — 6px scrollbar). Konsisten ✓

**Deploy:** frontend-only, build sukses (index-oTBt_dvr.js), live tanpa restart.

---

## v0.3.2 — QA: konsistensi lebar antar halaman admin (2026-09-02 01:45)

**Feedback Kanaka (01:41):** width halaman Templates lebih narrow dibanding Users; lebar card Users & WhatsApp paling cocok; Purge juga beda lagi. Minta diseragamkan.

**Root cause:** setiap halaman admin memakai `max-w` berbeda-beda (Users 4xl, WhatsApp 2xl, Purge 3xl, Templates 5xl, Analytics 7xl, Announcements 6xl, launcher 3xl) — sisa gaya desktop lama yang tidak pernah diseragamkan saat restrukturisasi v0.3.0.

**Fix:** semua 7 halaman admin distandarkan ke `max-w-4xl` (lebar reference: Users & WhatsApp, sesuai preferensi Kanaka):
- Admin launcher: 3xl → 4xl
- WhatsApp: 2xl → 4xl
- Purge: 3xl → 4xl
- Templates: 5xl → 4xl
- Analytics: 7xl → 4xl (konten analytics yang lebar tetap scroll internal)
- Announcements: 6xl → 4xl

**Deploy:** frontend-only, build sukses (index-BGm8O70l.js), live tanpa restart.

---

## v0.3.1 — QA: halaman Templates mobile-friendly (2026-09-02 01:35)

**Feedback Kanaka (01:32, screenshot):** halaman Templates masih belum mobile friendly — tabel kepotong, tombol "+ New Template" tidak keliatan. Usulan: rombak seperti halaman Users (kartu).

**Fix (Templates.vue):**
- **Mobile: kartu per-template** — nama, keyword (code chip), kategori (badge), isi (line-clamp 2 baris), tombol Edit/Delete di bawah. Tidak ada lagi tabel kepotong.
- **Desktop:** tabel tetap (dengan internal scroll min-w-640 dari v0.3.0).
- **"+ New Template":** full-width di mobile (selalu keliatan di atas list), otomatis normal di desktop.
- Empty state diterjemahkan ke Bahasa Indonesia di mobile.

**Deploy:** frontend-only, build sukses (index-CyixVs0v.js), live tanpa restart. Commit `3858651`.

---

## v0.3.0 — Admin jadi launcher ikon + halaman terpisah (2026-09-02 01:04)

**Feedback Kanaka (01:04, QA mobile admin):**
1. Halaman Admin: homerow hilang, header tidak muncul (tidak konsisten dengan page lain).
2. Kategorisasi kacau: tab bar (Users/WhatsApp/Purge/Template) + tiga kartu quick-link (Analytics/Templates/Pengumuman) yang persisten; Templates dobel (tab + kartu, kartunya tidak bisa dipencet); kartu Analytics tidak membuka halaman apa pun.
3. Ide: Admin = launcher ikon, tiap fungsi halaman sendiri dengan header back (konsistensi UX).
4. Tabel Users tidak bisa scroll horizontal.
5. Tabel Message Templates melebar ke samping (bukan scroll horizontal).

**Root cause (#1):** Admin.vue memasang `<PageShell>` di template tapi komponennya TIDAK di-import (kelalaian v0.2.2) — Vue merender unknown element kosong → topbar & homerow tidak muncul di Admin.

**Fix (v0.3.0):**
- **Admin.vue = launcher murni**: 6 ikon modul (Users/WhatsApp/Templates/Analytics/Pengumuman/Purge) — tab bar & quick-links cards dobel dihapus.
- **3 halaman baru**: `AdminUsers.vue`, `AdminWhatsApp.vue`, `AdminPurge.vue` — logika v0.1.x dipindah utuh (create/update/deactivate user, QR session, purge + log), tampilan mobile jadi kartu.
- **PageShell baru mendukung `back-to` prop**: tombol ← universal di topbar mobile sub-page admin.
- **Analytics & Templates**: kini halaman asli (bukan redirect ke tab yang tidak ada), dibungkus PageShell (header desktop-only + topbar mobile dengan back).
- **Tabel Users**: mobile = kartu, desktop = tabel dengan internal scroll.
- **Templates**: tabel dibungkus `overflow-x-auto` + `min-w-[640px]` (scroll internal, tidak melebihi layar).
- Router: `/admin/users|whatsapp|purge` route baru; `/admin/analytics` & `/admin/templates` kini halaman asli (bukan redirect).

**Deploy:** frontend-only, build sukses (index-CDcSQaKv.js), live tanpa restart. Commit `471284f`.

---

## v0.2.7 — QA: tombol Logout tidak ada di mobile (2026-09-02 00:50)

**Feedback Kanaka (00:49):** di mobile tidak ketemu tombol logout di mana pun.

**Root cause:** v0.2.0 merestrukturisasi Settings tapi Logout hanya ditaruh di header desktop (`hidden md:flex`) — di mobile header ke-hidden, tidak ada penggantinya. Pelanggaran spec §1.3 sendiri ("logout di dalam Pengaturan").

**Fix:** section "Logout" baru di halaman Pengaturan (di bawah Change Password) — tombol full-width merah, tampil di SEMUA viewport (mobile & desktop). Handler `handleLogout` existing dipakai ulang.

**Deploy:** frontend-only, build sukses (index-DClEcsan.js), live tanpa restart.

---

## v0.2.6 — QA: judul Tangan Kanan tertutup status bar (2026-09-02 00:30)

**Feedback Kanaka (00:29, screenshot mobile):** tulisan "Tangan Kanan" di atas sheet ketutup status bar HP.

**Root cause:** `viewport-fit=cover` (dipasang v0.2.1 supaya composer tidak kepotong di bawah) membuat konten memanjang ke belakang status bar — tapi top bar sheet Tangan Kanan tidak diberi padding aman atas, jadi menempel di balik jam/battery.

**Fix:** `env(safe-area-inset-top)` ditambahkan di SEMUA header mobile (konsisten, bukan cuma Tangan Kanan):
- TK sheet (Dashboard wrapper): `padding-top` di container sheet
- Chat detail header + Dashboard list topbar: `padding-top: calc(12px + safe-area-inset-top)`
- PageShell topbar (Kontak/Blast/Admin/Settings/Pengumuman): sama

**Deploy:** frontend-only, build sukses (index-DnQa7bJ4.js), live tanpa restart.

---

## v0.2.5 — QA: Tangan Kanan judul dobel + tombol Link salah tempat (2026-09-02 00:15)

**Feedback Kanaka (00:12, screenshot mobile):** (1) tulisan "Tangan Kanan" muncul DUA KALI di atas panel, dua-duanya punya tombol ✕ yang menutup panel; (2) tombol "Link" (🔗) tempatnya nyeleneh di header — tidak konsisten dengan Document/Image yang tombol "+"-nya di section masing-masing.

**Root cause:** (1) sheet wrapper mobile (Dashboard) punya header sendiri "📎 Tangan Kanan" + ✕, sementara komponen TanganKanan juga merender header internal dengan judul + ✕ → dobel di mobile; (2) tombol add-link memang ditaruh di header komponen sejak v0.1.x, bukan di section Link.

**Fix (TanganKanan.vue saja):**
- Header internal `v-if="!mobileFull"` — hidden di mobile sheet (desktop tetap ada).
- Tombol 🔗 dihapus dari header.
- Section Link sekarang punya tombol "+" sendiri (toggle link form) — konsisten dengan Document/Image (`folder.name === 'Link'` tidak lagi dikecualikan).
- Link form dipindah dari area header ke DALAM section Link (muncul tepat di bawah header folder saat "+" ditekan).

**Deploy:** frontend-only, build sukses, live tanpa restart. Commit `673270a`.

---

## v0.2.4 — QA mobile: Blast masih terpotong (2026-09-01 23:50)

**Feedback Kanaka (screenshot 23:44):** halaman Blast masih terpotong — counter "0 chats" kepotong ("0 c…"), tombol "Next →" keluar dari kartu, label step "Rate Limit" ke-wrap 2 baris.

**Root cause:** step indicator (1-2-3-4 dengan label teks "Recipients/Message/Rate Limit/Review") punya min-content ~440px — memaksa seluruh kartu step 1 melebihi lebar layar mobile. Semua elemen di bawahnya (counter, tombol Next) ikut kegeser keluar viewport. `overflow-x-hidden` di ancestor memotongnya (keliatan "terpotong"), bukan menata.

**Fix:**
- Step indicator: label teks `hidden md:inline` (mobile = lingkaran angka saja, pola standar wizard mobile), lingkaran shrink ke w-7 di mobile, connector `min-w-2`.
- Root embedded wrapper + konten Blast: `w-full min-w-0` (izinkan shrink).
- Chat search row: input `min-w-0` (bisa menyusut), select `flex-shrink-0`.
- CSV preview: kolom "Normalized" disembunyikan di mobile (4 kolom muat, bukan 5).

**Deploy:** frontend-only, build sukses (index-yGNrclFI.js), live tanpa restart.

---

## v0.2.3 — QA mobile: recipient dari Kontak + layout tidak kepotong (2026-09-01 21:15)

**Feedback Kanaka (QA Android #3, 21:02):** (1) halaman Blast & Kontak kepotong, tidak bisa scroll samping — idealnya elemen tertata mengikuti lebar layar; (2) Blast recipient selector tidak punya sumber dari Kontak tersimpan (hanya chat list/tags/CSV).

**Fix:**
- **Blast — tab baru "Kontak"** (frontend-only, pipeline backend tidak disentuh):
  - Pilih recipient dari kontak tersimpan (search + "Pilih Semua halaman ini" + load-more pagination).
  - Kontak yang punya chat terdaftar → masuk sebagai chatId (dedupe dengan chat list selection).
  - Kontak TANPA chat → masuk jalur warm/cold number yang sudah ada (sama seperti CSV), dengan normalisasi nomor sama seperti backend.
  - Dedupe: kontak ber-chat gak dobel dengan chat list; kontak cold gak dobel dengan CSV.
  - Summary recipients sekarang: (chat: X, kontak: Y, tags: Z, CSV: W).
- **Kontak (mobile):** tabel diganti kartu per-kontak (nama, nomor, kota/note, badge sumber & status chat, tombol Edit/Chat/Hapus). Desktop tetap tabel.
- **Blast Riwayat (mobile):** list jadi kartu (nama, preview pesan, status, statistik, tanggal); stats grid 4 → 2 kolom di mobile; log tabel dibungkus internal scroll (min-width 640px) — tidak ada lagi konten melebihi layar.

**Deploy:** frontend-only, build sukses (index-T9cP1dqq.js), live tanpa restart. Commit `396d752`. Patch script: `patches/20260901-mobile-qa/patch_v023.py`.

---

## v0.2.2 — QA mobile: konsistensi header + homerow antar page (2026-09-01 20:55)

**Feedback Kanaka (20:45, QA Android):** perilaku homerow/header beda di tiap page — Kontak: header ada, homerow hilang; Blast: header hilang, homerow meleset dari lebar layar & tertutup browser frame; Pengaturan: header ada, homerow hilang. Ekspektasi: semua page punya header + homerow yang mengikuti frame browser.

**Root cause:** PageShell (wrapper standar v0.2.0: topbar + homerow + spacer) TIDAK dipakai oleh satu pun page — Contacts/Settings masih header lama tanpa homerow, Blast memasang `<Homerow/>` manual di dalam konten (root tanpa overflow guard → homerow fixed melebihi layar), Admin/Announcements polos.

**Fix:** semua 5 page list-level (Kontak, Pengaturan, Blast, Admin, Pengumuman) dibungkus PageShell — header lama jadi `hidden md:flex` (desktop-only), mobile dapat topbar + homerow seragam. Blast: Homerow manual dihapus (spacer dobel), tab bar sticky offset di bawah topbar. PageShell: `overflow-x-hidden`. Dashboard tetap render Homerow sendiri (kontrol visible per list/detail).

**Deploy:** frontend-only, build sukses, live tanpa restart. Commit `51315fb`.

---

## v0.2.1 — QA mobile: composer tertutup browser chrome (2026-09-01 20:40)

**Feedback Kanaka (20:36, screenshot):** di chat detail, text field di bawah tidak terlihat — tertutup frame browser. Ekspektasi: behavior-nya sama seperti homerow yang bisa mengikuti frame browser.

**Root cause:** Dashboard root `h-screen` (100vh) + ChatDetail mobile wrapper `fixed inset-0` — di browser mobile, 100vh adalah viewport *expanded* yang mencakup area di balik toolbar bawah → composer nyumbul di balik chrome. Homepage aman karena Homerow memakai `fixed + env(safe-area-inset-bottom)`.

**Fix:** utility `.h-vp` baru (fallback 100vh → 100dvh dynamic viewport) di Dashboard root + ChatDetail mobile wrapper (`fixed top-0 w-full h-vp`). 100dvh mengikuti toolbar browser secara dinamis.

**Deploy:** frontend-only, build sukses. Commit `b1aed86`.
---

## v0.2.0 — Mobile-First UI Restructure (2026-09-01 19:00)

**Built by:** Dory (dari spec `wa-cs-hub-v0.2.0-spec.md`, approved Kanaka) | **Review+deploy:** Alita

**Perubahan (frontend only — backend/DB tidak disentuh):**
- **Homerow bottom nav** — CS: Obrolan/Kontak/Blast/Pengaturan; Admin: +Admin. Unread badge di Obrolan (`unreadTotal` recompute di store). Hidden di chat detail. Safe-area iPhone.
- **List → detail full-screen di mobile** (<768px) — desktop split-panel TIDAK berubah. Back universal (`router.back()` fallback `/`), scroll position list preserved.
- **Header chat: `← | Nama kontak | ⋮ kebab`** — kebab berisi Transfer ▸ (submenu inline), Release (confirm dialog existing), Resolve, 📎 Tangan Kanan. Semua handler v0.1.x dipakai ulang. Desktop juga pakai kebab (tombol inline lama hilang di mobile saja).
- **Composer keyboard-safe** — `visualViewport` resize handler + `viewport-fit=cover, interactive-widget=resizes-content` di index.html; Tangan Kanan jadi full-screen sheet di mobile.
- **Queue banner tetap bottom-fixed DI ATAS homerow** (keputusan Kanaka 18:41) — hanya mobile.
- **Blast** = satu halaman 2 tab (Kirim/Riwayat); `/blast/history` → redirect `?tab=riwayat`.
- **Admin** = tab konsolidasi (Pengguna/Template/Tag/Pengumuman/Purge/Sesi WA/Analytics — Analytics masuk Admin per keputusan Kanaka); route lama redirect.
- **Settings** baru: profil, notif toggle, logout.
- Dashboard.vue (2223 → ~880 lines) dipecah: ChatListPane, ChatDetail, ChatHeader area, FilterChips, QueueBanner, Homerow, KebabMenu, PageShell.
- Regression v0.1.22–27: semua marker masih ada (chats_purged, resolve realtime refetch, fetchChats fallback outgoing/incoming, dedup TK) — verified via grep + build.

**Deploy:** frontend-only, static dari disk (tidak perlu restart). **QA oleh Kanaka di iPhone menyusul.**

# WhatsApp CS Hub — Changelog

All notable changes to this project will be documented in this file.

---

## v0.1.27 — QoL: Resolve dari CS tidak muncul realtime di tab Resolved admin (2026-09-01 15:26)

**QoL (lapor Kanaka setelah v0.1.26 lolos):** CS (non-admin) resolve chat → di tab "Resolved" akun Admin tidak muncul realtime — harus pindah tab dulu (Mine→Resolved) baru chat ke-resolved-nya keliatan.

**Root cause:** sama pola dengan v0.1.26 tapi lewat event `chat_update`: broadcast resolve mengirim `status: 'resolved'` ✓, tapi `updateChat` di store hanya memutasi chat yang SUDAH ada di snapshot list admin. Admin yang sedang menunggu di tab "Resolved" tidak punya chat itu di snapshot (status-nya baru saja berubah dari open) → event diabaikan begitu saja → baru terlihat setelah pindah tab (yang memaksa refetch).

**Fix:** safety-net di `onChatUpdate` (Dashboard.vue) — saat event `status: 'resolved'` masuk, kalau chat belum ada di list (`!inList`) ATAU filter aktif mengecualikan resolved (`mine`/`unassigned` — resolved memang keluar dari filter itu), refetch chatlist dengan filter aktif (`chats.fetchChats(buildFilterParams())`).

**Deploy:** frontend-only — rebuild `index-Dnye0xb9.js`, tanpa restart server.

---

## v0.1.26 — QoL: Chat hasil klaim Kontak tidak muncul di chatlist setelah balas (2026-09-01 15:20)

**QoL (lapor Kanaka setelah v0.1.25 lolos):** klaim chat dari Kontak → jendela kebuka → kirim pesan → terkirim, TAPI chat belum muncul di chatlist — harus pindah tab (Mine→Resolved→Mine) baru muncul.

**Root cause:** chat yang baru diklaim dari Kontak tidak ada di snapshot chatlist (list terakhir di-fetch sebelum klaim). Di `onNewMessage`, branch **incoming** sudah punya safety-net "chat gak ada di list → refetch", tapi branch **outgoing** (balasan pertama CS) tidak — dia cuma update kalau chat-nya ke-find, kalau tidak ada diabaikan. Refetch baru terjadi pas ganti tab.

**Fix:** branch outgoing di `onNewMessage` sekarang refetch chatlist (`chats.fetchChats()`) kalau chat belum ada di list — mirror safety-net branch incoming. Filter tetap dihormati (chat klaim = open + assigned keku = muncul di "Mine").

**Deploy:** frontend-only change — rebuild `index-7IrrKybf.js`, TANPA restart server (static assets tersaji dari disk).

---

## v0.1.25 — Hotfix: Kontak → "Chat" gagal untuk chat unassigned (klaim eksplisit) (2026-09-01 15:00)

**Bug (lapor Kanaka setelah test v0.1.24):** purge real-clean ✓ dan counter antrean ✓, TAPI buka chat dari menu Kontak masih gagal — muncul flyout "gagal membuka chat" padahal chat open + belum di-assign siapapun.

**Root cause:** fix v0.1.24 berhasil bypass masalah list (fetch langsung by ID), tapi guard akses v0.1.21 tetap menolak: `GET /api/chats/:id` mem-block CS membuka chat **unassigned** (403 isolasi antrean). Kanaka test pakai akun CS → 403 → toast guard v0.1.24 muncul. Admin tidak kena karena bypass isolasi.

**Fix (v0.1.25):** `POST /api/contacts/:id/open` — CS yang klik "Chat" di Kontak sekarang **mengklaim chat eksplisit**: open+unassigned → auto-assign ke CS yang klik (race-guard `updateMany where assignedToId:null`, `queuedAt=null`, event `assigned`, broadcast `chat_update` + `queue_update`). Semantik sama dengan take-next, inisiatif dari Kontak. Admin tetap bebas akses tanpa klaim. Toast guard diperjelas: "Chat sudah ditangani CS lain atau tidak dapat diakses."

**Verified e2e (synthetic contact, akun CS fina):** POST /open → chat claimed (assignedToId=fina, queuedAt null, ChatEvent `assigned`) ✓; GET detail chat sebagai CS → 200 ✓. Data sintetis dibersihkan setelah test.

---

## v0.1.24 — Hotfix: Purge "real clean" + buka chat dari menu Kontak gagal (2026-09-01 14:32)

**Bug 1 (lapor Kanaka):** setelah purge, kontak yang sama kirim pesan baru → gak masuk banner "chat baru di antrean" — karena shell chat masih ter-bind ke agent lama. Ekspektasi: purge = real clean, pesan baru harus masuk antrean sebagai chat baru.

**Root cause:** purge v0.1.22 cuma hapus pesan + reset preview; field operasional chat (`assignedToId`, `status`, `resolvedById`, `queuedAt`, counter analytics, `unreadCount`) tetap bawa nilai lama → pesan baru nyantol ke agent lama (open + assigned), bukan masuk antrean.

**Fix:** `POST /api/purge` sekarang REAL CLEAN — reset SEMUA state operasional chat terdampak: `status=open`, `assignedToId=null`, `resolvedAt/resolvedById=null`, `queuedAt=null`, `firstIncomingAt/firstAssignedAt/lastAssignedAt=null`, `firstResponseAt/firstResponseById=null`, `csMessagesSent=0`, `messagesBeforeResolve=null`, `unreadCount=0` — lalu preview dihitung ulang (partial purge tetap aman) + broadcast `chat_update` per chat + `chats_purged` + `queue_update`. Chat yang di-purge penuh muncul lagi sebagai chat baru begitu kontak chat lagi (queuedAt di-set fallback di processIncomingMessage).
- One-time DB cleanup: 7 chat bekas purge test di-reset manual ke state bersih.

**Bug 2 (lapor Kanaka):** menu Kontak → tombol "Chat" → balik ke halaman awal, tampilan chat gak muncul.

**Root cause:** `maybeAutoSelectFromQuery` nungguin chat muncul di chatlist terfilter (`trySelect` loop) — chat resolved/tanpa pesan aktif TIDAK PERNAH ada di list (filter v0.1.22) → retry loop tak berujung → detail gak kebuka.

**Fix:** buka chat dari `?chat=` LANGSUNG via `selectChat({id})` (fetch by ID, tak tergantung list). Guard baru di `selectChat`: kalau fetch gagal (404/403 — mis. CS buka chat unassigned), detail ditutup + toast penjelasan (bukan diam-diam balik ke list). `fetchChat` di store sekarang clear stale chat saat error supaya guard bisa deteksi.

---

## v0.1.23 — Hotfix: Counter antrean telat + gambar Tangan Kanan tidak langsung muncul (2026-09-01 14:20)

**Bug 1 (lapor Kanaka):** 3 chat masuk hampir bersamaan → banner "chat baru di antrean" cuma nampil 1; counter baru bener setelah Take di-click.

**Root cause:** regresi v0.1.22 — filter antrean sekarang mensyaratkan chat punya pesan aktif (`messages: { some: { purged: false } }`), tapi semua emit `queue_update` di `baileys.js` kejadian SEBELUM `message.create` → chat baru belum punya pesan → gak kehitung. Angka baru benar setelah Take karena take-next nge-refetch.

**Fix:** semua `emitQueueUpdate()` di baileys.js dipindah/cabut dari titik prematur (upsertChat, chat.create di processIncoming, auto-reopen, queuedAt fallback) → satu emit di AKHIR handler, setelah pesan tersimpan (hanya untuk pesan incoming).

**Bug 2 (lapor Kanaka, QoL):** gambar dikirim dari Tangan Kanan terkirim ke penerima, tapi tidak langsung muncul di bubble — baru muncul setelah pindah chat lalu kembali.

**Root cause:** `onNewMessage` di Dashboard.vue me-skip semua outgoing message dari diri sendiri (asumsi "sudah ditambahkan oleh sendReply di store") — padahal Tangan Kanan POST langsung ke `/:id/media` tanpa lewat `sendReply`, jadi pesannya tidak pernah masuk state sampai re-fetch REST saat pindah chat.

**Fix:** hapus guard skip-own-outgoing di `onNewMessage` — dedup by `id`/`waMessageId` yang sudah ada mencegah duplikat dengan hasil POST (media route juga broadcast `new_message`).

**Verified:** build frontend OK, server restart OK, WA reconnect tanpa QR, e2e test purge/antrean oleh Kanaka menyusul.

---

## v0.1.22 — Hotfix: Purge tidak menghilangkan chat dari chatlist (2026-09-01)

**Bug (lapor Kanaka):** Login admin → purge messages → chatlist masih nampilin SEMUA chat. Harusnya terhapus.

**Root cause:** Purge cuma menghapus rows `Message` (hard: deleteMany / soft: purged=true). Rows `Chat` tidak disentuh + `lastMessagePreview`/`lastMessageAt` tidak di-reset → chatlist (yang membaca tabel Chat) tetap nampilin "cangkang" chat tanpa isi, dengan preview pesan yang sudah terhapus.

**Fix (Alita):**
- `GET /api/chats`: filter `messages: { some: { purged: false } }` — chat yang tidak punya pesan aktif tidak muncul di chatlist (muncul lagi otomatis begitu kontak kirim pesan baru).
- `POST /api/purge`: setelah purge, reset `lastMessagePreview`/`lastMessageAt` tiap chat terdampak (ke pesan aktif terbaru, atau NULL jika kosong) + broadcast `chat_update` per chat + event baru `chats_purged` {chatIds}.
- `take-next` + queue count: chat tanpa pesan aktif tidak dihitung/diambil dari antrean.
- Frontend: handler `chats_purged` — chat dibuang dari list realtime; kalau sedang dibuka, detail ditutup + toast "Chat dibersihkan". Store: action `removeChats(chatIds)`.
- One-time DB cleanup: preview 5 chat bekas purge di-reset ke NULL.
- **Verified (13:41, purge kedua oleh Kanaka):** chat hilang dari chatlist realtime ✓; DB: 0 pesan aktif, 0 chat tampil; PurgeLog tercatat; chat muncul lagi otomatis saat kontak kirim pesan baru (by design).

---

## v0.1.21.1 — Hotfix: Resolve/Release race condition (2026-08-31 16:54)

**Bug (lapor Kanaka):** Resolve dari akun CS muncul alert "Failed to resolve: Cannot set properties of null (setting 'status')" padahal chat sukses ter-resolved di DB.

**Root cause:** race condition — realtime `chat_update` (status resolved) nyampe SEBELUM HTTP response resolve balik. Handler realtime utk non-admin menutup detail (`currentChat = null`) + pindah tab Resolved; lalu `handleResolve()` lanjut mutasi `currentChat.value.status` → TypeError di chat yang sudah null. Server selalu benar; error dialog bohongan.

**Fix (Alita):** guard di `handleResolve` (early return kalau realtime sudah handle) + guard serupa di `handleRelease` (chat bisa ke-unbind saat confirm dialog masih terbuka). Build frontend ulang. Verified: klik Resolve ✓ dari akun CS → toast "Chat resolved" + DB resolved + tab pindah otomatis, zero dialog error; Release → confirm dialog → toast antrean + DB queuedAt terisi. State test direstore (Norma open+cs1).

---

## v0.1.21 — Queue Discipline + Tangan Kanan Caption (2026-08-31)

**Built by:** Dory (queue discipline backend+frontend, TK caption) | **Spec:** `wa-cs-hub-v0.1.21-spec.md` (feedback CS asli: 5 poin)

### Added — Queue Discipline (Backend)
- **`Chat.queuedAt` (nullable)** — FIFO key antrean. Chat open+unassigned = queue-eligible. Migrasi additive via `npx prisma db push` (zero data loss).
- **`POST /api/chats/take-next`** — ambil chat terdepan antrean: `findFirst orderBy [{queuedAt:asc},{lastMessageAt:asc}]` (SQLite nulls-first → chat lama queuedAt-null pakai lastMessageAt fallback) + race-guard `updateMany where assignedToId:null` + retry loop. Sukses → assign + `queuedAt=null` + ChatEvent `taken_queue` + `assigned` (analytics v0.1.19 compat). Antrean kosong → 404 `Antrean kosong`. Response = objek chat lengkap (frontend auto-select).
- **`GET /api/chats/queue-count`** — jumlah chat open+unassigned (initial fetch banner).
- **Socket `queue_update` {count}** (broadcast) — emit saat masuk/keluar antrean (new chat, customer reopen, release, take). Helper baru `src/socket/queue.js`.
- **Reply lock TOTAL** — semua jalur kirim (reply teks + media endpoint `/api/chats/:id/media`) tolak 403 `Chat belum di-Take. Ambil chat dulu sebelum membalas.` kalau `assignedToId === null` — **BERLAKU JUGA UNTUK ADMIN** (keputusan Kanaka). Audit jalur kirim: reply/media via chats.js (kunci); blast via services/blast (out of scope, admin-only); TK insert & template insert lewat `/media` & `/reply` (terkunci otomatis).
- **Auto-reopen customer (unbind)** — pesan masuk ke chat resolved → `status=open`, `resolvedAt=null`, **`assignedToId=null`** (binding lepas), `queuedAt=now`, ChatEvent `reopened_unassigned`, `queue_update`. (Sebelumnya: reopen tapi binding tetap — CS gak sadar chat diambil orang lain.)
- **Pesan ke chat unassigned open** — `queuedAt` di-set kalau masih null (chat lama); TIDAK di-update kalau sudah ada (posisi FIFO tetap).
- **Chat baru** — create path di baileys.js set `queuedAt=now` langsung.
- **Release** → `queuedAt=now` + ownership check (pemilik/admin) + `queue_update`.
- **Assign manual (admin)** — `queuedAt=null` + ChatEvent `taken_manual_admin` saat take dari antrean. **CS self-assign ke chat unassigned → 403** (anti cherry-picking: harus lewat take-next FIFO).
- **ChatEvents baru:** `taken_queue`, `taken_manual_admin`, `reopened_unassigned` — pattern event existing; event `assigned` tetap di-log di semua take (analytics v0.1.19 regression-safe).

### Added — Filter & Isolasi API (poin #2 & #3)
- **`GET /api/chats?filter=`** — CS (non-admin): `unassigned`/`all` → **403**; `mine` = assignedTo=me AND status=open; `resolved` = resolvedById=me saja. Admin: semua filter, `resolved` = semua user. `handlerId` param: CS cuma boleh diri sendiri (403 intip chat orang lain).
- **Chat detail/messages/search/favorites/read** — `canAccessChat`: admin ATAU assignedTo=me (open) ATAU resolvedById=me. Lainnya → 403.
- **`GET /api/media/:messageId`** — media serve sekarang cek akses chat (CS gak bisa intip media chat orang lain via URL).
- **`GET /api/chats/search-all`** — hasil difilter per akses CS (gak bocor chat orang lain).

### Added — Tangan Kanan Caption (poin #5)
- **`SharedFile.caption` (nullable)** — caption default gambar.
- **Upload image** → modal popup: preview + textarea Caption (opsional) + Batal/Simpan. Dokumen/link tetap flow lama.
- **Insert image ke chat** → modal: preview + caption **pre-filled dari tersimpan, EDITABLE** (edit gak mengubah yang tersimpan) + Batal/Kirim. Caption ikut dikirim sebagai media caption (Baileys).

### Added — Frontend
- **Tab chat list:** admin `Mine|Unassigned|All|Resolved`; CS **`Mine|Resolved` saja** (Unassigned & All hilang).
- **Banner "New Message"** di bawah chat list (semua role): `📨 N chat baru di antrean` + tombol **Take** (identitas chat TIDAK ditampilkan — anti cherry-picking). Real-time via `queue_update` + initial fetch `queue-count`. Take → auto-select chat + toast; 404 → toast "Antrean kosong".
- **Release confirm dialog:** "Yakin mau release chat ini? Chat masuk antrean dan bisa diambil agent lain." [Batal/Release].
- **Real-time reaksi:** chat yang dibuka di-unbind (`assignedTo:null` dari customer reopen/release lain) → non-admin: tutup detail + toast "Chat masuk antrean (binding dilepas)" + refresh list. Chat jadi resolved → keluar dari Mine, pindah tab Resolved + toast.
- **Reply area:** notice amber "Chat belum di-Take" untuk unassigned (semua role — admin juga harus Take dulu).

### Fixed
- **Media endpoint personalization bug** — `chat` direferensikan sebelum di-fetch (caption `{name}` crash path) → fetch chat dipindah ke atas.
- **`chat_update` payload konsisten** — unbind selalu `assignedTo: null` (bukan assignedToId) agar frontend reaksi real-time jalan.

### Verified (cURL + CDP visual, 0 console error)
- Login admin/cs1/wahyu ✓ | CS filter unassigned/all → 403 ✓ | admin unassigned → 200 ✓ | handlerId isolation ✓
- Reply/media ke chat belum-take → 403 (admin & CS, message sesuai spec) ✓ | CS detail unassigned → 403 ✓
- CS assign unassigned → 403 (anti cherry-pick) ✓
- FIFO: release A→B interval 1.2s → take-next urut A dulu ✓
- Race: 2 take-next paralel → 1 sukses + 1×404, no double-assign ✓ | antrean kosong → 404 "Antrean kosong" ✓
- Release → queuedAt set + assignedToId null ✓ | admin manual take → queuedAt null + `taken_manual_admin` ✓
- Resolved isolation: cs1 lihat resolved miliknya saja; resolved wahyu → 403 untuk cs1; resolver tetap akses ✓
- TK upload caption tersimpan ke DB via UI modal ✓ | caption muncul di GET /tk/files ✓ | insert modal caption pre-filled + editable (verified via CDP) ✓
- ChatEvent log: taken_queue, taken_manual_admin, released, assigned, reopened_unassigned ✓
- UI admin: 4 tab + banner live + Take ✓ | UI cs1: 2 tab (Mine|Resolved) + banner ✓
- DB: `prisma db push` additive sukses tanpa flag destruktif; 5 chats + 17 messages + sharedFiles utuh (backup md5-verified pre-build di `backup/pre-v0.1.21-dory/`)

---

## v0.1.20 — Contacts & Heatmap Per-CS (2026-08-31)

**Built by:** Dory + Alita (Dory build crash di akhir; Alita finish: fix export shape, SQLite search, gender/partial-edit, CHANGELOG)

### Added
- **`Contact` model (separate table)** — contacts survive chat purge. Fields: `name`, `phone` (nullable for LID-only, fillable manually), `chatId` (unique link), `birthDate`, `gender` (male/female), `city`, `note`, `source` (chat|import|manual). Index on `phone`.
- **Auto-save hook** (`src/wa/baileys.js`) — every incoming chat upserts a Contact by chatId; only fills empty fields (never overwrites manual edits).
- **Contacts API** (`src/routes/contacts.js`, rewritten):
  - `GET /api/contacts` — list + case-insensitive search (q) + pagination (20/page).
  - `POST /api/contacts` — manual create; phone normalized (08xx/+62 → 62xx); 409 on duplicate phone.
  - `PUT /api/contacts/:id` — partial edit of all fields; gender accepts male/female/m/f/l/p; invalid → 400.
  - `GET /api/contacts/by-chat/:chatId` — get-or-create (covers old chats without backfill).
  - `DELETE /api/contacts/:id` — admin only; chat untouched.
  - `GET /api/contacts/export` — CSV: name,phone,birth_date,gender,city,note,source,chat_id,last_active_at.
  - `POST /api/contacts/import` — CSV upload (5MB): fields name, phone, birth_date, gender, city, note (case-insensitive headers); dedupe in-file; update-on-existing; result {created,updated,skipped,total,errors}.
  - `POST /api/contacts/:id/open` — chat ulang: get-or-create Chat from contact phone; auto-reopen resolved chat (reopenedCount++ + event); 400 if phone unknown (LID unresolved) and no linked chat.
- **Contacts page** (`/contacts`, all roles) — search, table (name, phone, source badge, city, note, last activity), pagination; Import modal with field documentation + **Download Sample CSV**; Export CSV via blob download.
- **Floating "Edit Kontak" button in chat view** — opens `ContactEditModal` overlay (reusable component) without leaving the chat; chat stays selected, no scroll reset.
- **Dashboard auto-select** — `?chat=<id>` query param selects the chat (used by Contacts "Chat" button).
- **Heatmap filter per-CS** (`/admin/analytics`) — dropdown "Semua CS" (from /users/agents); with CS selected heatmap shows "Pesan Dibalas" (outgoing messages by that CS) and "Chat Diambil" (assigned events); `cs` param on `GET /api/analytics/hourly` (invalid → 400).
- **Backfill** — `prisma/backfill-contacts.js` (idempotent).

### Fixed (post-verify, reported by user 14:30) — Verified by user 14:39 ✅
- **Nomor WA dikunci di floating modal** — `ContactEditModal.vue` disabled phone saat dibuka dari chat view (`:disabled="!!chatId"`) — padahal use case utamanya isi nomor manual utk LID-only. Lock dihapus; nomor sekarang editable dari mana aja.
- **Nomor gak sinkron dari chat LID yang udah share** — backfill & hook `syncContactFromChat` set `phone = null` utk SEMUA chat LID, padahal `Chat.contactPhone` udah punya nomor asli (hasil LID→phone resolution v0.1.5). Sekarang: chat LID pakai `contactPhone` kalau itu nomor bener (digit murni ≠ LID digits); tetap null kalau belum resolved. Backfill re-run → nomor kontak existing ke-backfill.

### Fixed (during verification)
- `contacts.js` export shape `module.exports = { router, normalizePhone }` crashed `server.js` mount → import fixed to `.router`.
- SQLite/Prisma 5.10 doesn't support `mode: 'insensitive'` on `contains` → search rewritten as multi-case OR.
- PUT full-replace bug: birthDate/gender were nulled when not sent → now true partial update.
- Gender short forms (m/f/l/p) silently nulled → now normalized everywhere; invalid gender → 400.

---
## v0.1.19 — Analytics & CS Performance (2026-08-31)

**Built by:** Dory + Alita

### Added
- **Lifecycle timestamps on `Chat`** — 9 new columns: `firstIncomingAt`, `firstAssignedAt`, `lastAssignedAt`, `firstResponseAt`, `firstResponseById`, `csMessagesSent`, `messagesBeforeResolve`, `reopenedCount`, `resolvedById`.
- **Event log `ChatEvent`** — new table recording `first_incoming`, `assigned`, `released`, `first_response`, `resolved`, `reopened` events; indexes on `chatId`, `(type, createdAt)`, and `userId`. Enables fair per-user history even after transfer/re-assign.
- **Hook recording in natural handlers** — added passively to:
  - `src/wa/baileys.js` incoming handler: records `first_incoming` once and `reopened` event + counter when a resolved chat receives a new incoming message.
  - `src/routes/chats.js` `POST /:id/assign`: records `firstAssignedAt` once, updates `lastAssignedAt`, logs `assigned` event.
  - `src/routes/chats.js` `POST /:id/release`: logs `released` event.
  - `src/routes/chats.js` `POST /:id/reply` and `POST /:id/media`: records `first_response` once, increments `csMessagesSent`, logs `reopened` if sending to a resolved chat.
  - `src/routes/chats.js` `POST /:id/resolve`: snapshots `messagesBeforeResolve`, records `resolvedById`, logs `resolved` event.
- **Backfill script** — `prisma/backfill-metrics.js` reconstructs `firstIncomingAt`, `firstResponseAt`, `firstResponseById`, `csMessagesSent`, and backfills `first_incoming`/`first_response` events from existing `Message` history.
- **Admin-only Analytics API** — new `src/routes/analytics.js` mounted at `/api/analytics`:
  - `GET /api/analytics/overview?range=7d|30d|all` — KPI totals (chats in, resolved, backlog, durations, effort, reopened).
  - `GET /api/analytics/agents?range=...` — per-CS leaderboard: active chats, total handled (event history), resolved count, avg first response / resolve / takeover, messages sent, last active.
  - `GET /api/analytics/hourly?range=...` — heatmap data 7×24 (customer messages and new chats), computed via raw SQLite `strftime`.
  - `GET /api/analytics/chats?range=...&status=all|open|resolved&page=1` — paginated drill-down lifecycle table.
- **Analytics dashboard** — `frontend/src/views/Analytics.vue` at `/admin/analytics`:
  - Range selector (7 hari / 30 hari / Semua) + refresh.
  - KPI cards: Chat Masuk, Chat Selesai, Backlog Aktif, Avg First Response, Avg Resolve (sejak take), Avg Idle→Takeover.
  - CS performance table with mini bar charts.
  - 7×24 heatmap CSS grid with quartile coloring, toggles Pesan Masuk / Chat Baru.
  - Paginated lifecycle table, status filter.
- **Navigation** — added 📊 Analytics link in `Dashboard.vue` header (admin only) and card + header link in `Admin.vue`.
- **Custom date range** — added: custom date range (`start`/`end`) di semua endpoint analytics + selector "Kustom" dengan date pickers di `frontend/src/views/Analytics.vue`.
- **Route** — registered `/admin/analytics` in `frontend/src/router.js` with `meta: { auth: true, admin: true }`.

### Security & Safety
- All analytics endpoints protected by `requireAuth` + `requireAdmin` (pattern from `users.js`).
- Database migration applied via `npx prisma db push` (additive columns + new table only — no destructive flags).
- Backfill runs against existing data without `DROP`/`TRUNCATE`.

### Verification
- `node --check` passed on all modified/new JS files.
- `npx prisma db push` applied successfully.
- `node prisma/backfill-metrics.js` completed and updated existing chat.
- `npm run build:frontend` succeeded.

---

## v0.1.17 — Placement Revision (2026-08-31)

**Built by:** Dory + Alita

### Changed
- **Announcement placement moved to Tangan Kanan** — removed `AnnouncementBanner` from the chat-list sidebar in `Dashboard.vue`; chat list now shows chats only.
- **New "📢 Pengumuman" section at the top of `TanganKanan.vue`** — always-visible section (before files/folders) that displays unread announcements (pinned first, max 3), expands full content on click, and allows dismiss via ✕ to mark as read.
- **Empty state** — shows "✓ Semua sudah dibaca" when no unread announcements remain.

### Unchanged
- Bell icon + dropdown panel in Dashboard header (badge unread count, expand-to-read).
- Real-time toast on `announcement_new`.
- Admin `Announcements.vue` page and all backend / Socket.IO / API logic.
- Zero database or backend changes.

### Verification
- `node --check` passed for all modified JS files.
- Production build succeeded (136 modules, no errors).
- Server static files served from disk; no restart required for frontend-only change.

---

## v0.1.0 — Initial Release (2026-08-28)

**Built by:** Dory (spawned by Alita)
**Spec:** `wa-cs-hub-spec.md` v2 (Node.js + Baileys stack)

### Phase 1 MVP Features
- Express server + Prisma + SQLite setup
- Baileys WhatsApp connection + QR login + session persistence (`useMultiFileAuthState`)
- Auth system (JWT + bcrypt, login page)
- Chat list + chat detail UI (text messages)
- Real-time incoming/outgoing messages via Socket.IO
- Admin panel: create/list/deactivate users
- WhatsApp tab: QR code display, connection status, reconnect/logout
- Purge tab: soft/hard delete + purge log
- Dockerfile + docker-compose.yml
- .env.example with all config vars
- Cloudflare quick tunnel for external access

### Known Issues (reported by Kanaka, v0.1.0 testing)
- WA Bisnis scan QR gagal (looping reconnect) — WA Personal berhasil
- Dashboard status "connecting" merah padahal Admin panel "connected" hijau
- Reply box tidak muncul setelah take chat (possible CSS responsive issue on mobile)

---

## v0.1.1 — Bug Fixes Round 1 (2026-08-28)

**Built by:** Dory (spawned by Alita)

### Fixed
- **Bug #1: Dashboard status mismatch** — `Dashboard.vue` sekarang fetch `GET /api/wa/status` saat mount, tidak cuma tunggu Socket.IO event. Status langsung akurat saat buka home.
- **Bug #2: Reply box not appearing** — Fix `selectChat()` di `Dashboard.vue`: pastikan `currentChat` ter-set dengan benar setelah `chats.fetchChat()` selesai.Tambah comments clarify flow.
- **Bug #3: Baileys reconnect loop** — Tambah `isConnecting` guard anti-double-connect, `reconnectTimeoutId` buat clear existing timeout, random jitter 0-2000ms. QR scan lebih stabil.

### Post-fix
- Frontend rebuilt (120 modules, no errors)
- Server restarted on port 5030 (clean startup)
- `GET /api/wa/status` returns proper JSON

### Still investigating
- Reply box on mobile viewport (possible CSS responsive issue — sidebar `w-80` fixed width mungkin kepotong di HP)

---

## v0.1.2 — Bug Fixes Round 2 (2026-08-28)

**Fixed by:** Alita (direct fix)

### Fixed
- **Bug #4: Outgoing message bubble muncul 2x** — Pas CS kirim reply, `chats.sendReply()` nambah pesan ke `currentMessages` (optimistic update), tapi Socket.IO `new_message` event juga fire untuk pesan yang sama ke pengirim. Hasilnya: bubble duplikat. Fix: tambah dedup check di `onNewMessage` handler — skip kalau pesan dengan `id` atau `waMessageId` yang sama udah ada di `currentMessages`.

### Notes
- WA gateway OpenClaw di-logout sementara (nomor Parahita dipake buat test WA CS Hub)
- WA Bisnis berhasil connect ke WA CS Hub setelah fix v0.1.1
- Outgoing message confirmed working (pesan sampai ke penerima)

---

## v0.1.3 — Bug Fixes Round 3 (2026-08-28)

**Fixed by:** Alita (direct fix)

### Fixed
- **Bug #5: Unread counter capped at "2"** — Baileys `chats.update` event mengirim `unreadCount` yang unreliable (capped di 2, tidak akurat untuk pesan berturut-turut). Fix: disable unreadCount dari Baileys `chats.update` sepenuhnya. Sekarang **kita count sendiri** di `processIncomingMessage`: setiap pesan masuk → `unreadCount + 1` di DB + emit via Socket.IO. CS buka chat → reset ke 0 via `markRead`.

### Root cause
- Baileys `chats.update` event: `unreadCount` field tidak reliable — WA server capped nilai di 2
- Sebelumnya dua sumber yang overwrite `unreadCount`: `processIncomingMessage` (+1 manual) dan `chats.update` (overwrite dari Baileys). Race condition → counter ganda/capped
- Fix: single source of truth = `processIncomingMessage` increment. `chats.update` hanya update `lastMessageAt`

---

## v0.1.4 — Media Support (2026-08-28)

**Built by:** Dory + Alita

### Added
- **Receive media** — gambar/video/audio/dokumen/stiker dari WA tampil inline di chat bubble
- **Send media** — tombol paperclip di reply box, kirim gambar/video/audio/dokumen + caption
- **Media encryption** — AES-256-GCM, decrypt on-the-fly saat serve
- **JWT auth for media** — `?token=***` query param (karena `<img>` tag ga bisa kirim header)
- **Lightbox** — klik gambar buat zoom full screen, klik di luar buat tutup
- **Download button** — tombol download di pojok kanan atas gambar (hover to show)

### Fixed
- **Bug #6: Bubble width mengikuti window** — `w-fit max-w-[70%]` supaya bubble ngikutin konten pesan, bukan lebar window. Tombol download nempel di pojok kanan atas gambar.

### Files changed
- `src/wa/baileys.js` — `processIncomingMessage` download media via `downloadMediaMessage()`, save encrypted
- `src/routes/chats.js` — `POST /api/chats/:id/media` endpoint (multer + Baileys send)
- `src/routes/media.js` — `GET /api/media/:messageId` accept `?token=` query param
- `frontend/src/views/Dashboard.vue` — media display (img/video/audio/doc), lightbox modal, download button, paperclip upload, `w-fit` bubble

---

## v0.1.5 — LID → Phone Resolution + Chat Lock (2026-08-28)

**Built by:** Dory + Alita

### Added — LID Resolution
- **Baileys patch** — patched `messages-recv.js` to emit `phoneNumberShare` for ALL incoming LID messages with `sender_pn` attr (not just SHARE_PHONE_NUMBER protocol messages)
- **Auto-resolve on incoming** — `processIncomingMessage` captures `sender_pn` from message stanzas, stores real phone number in `contactPhone` + `phoneJid`
- **requestPhoneNumber fallback** — sends protocol message to unresolved LID contacts asking WA to share phone number
- **Resolve on connect** — attempts to resolve all existing `@lid` chats when WA connects
- **Contact export** — `GET /api/contacts/export` (CSV) + `GET /api/contacts` (JSON), admin only
- **Prisma schema** — added `phoneJid` field to Chat model

### Added — Chat Lock
- **Backend guard** — `POST /api/chats/:id/reply` returns 403 if chat is assigned to another CS (not admin)
- **Frontend lock** — reply box replaced with "🔒 This chat is assigned to @username" message when chat is taken by another agent
- Admin can still reply to any chat (override)

### Findings
- USyncQuery CANNOT resolve LID → phone (WA server treats LIDs as opaque)
- `sender_pn` attr on incoming messages is the primary mechanism for LID → phone resolution
- `requestPhoneNumber` protocol message sent as fallback — response depends on contact privacy settings
- Contacts that have already shared phone number show real number; new contacts resolve when they send a message with `sender_pn` in stanza

### Added — Transfer Chat
- **Transfer button** — CS yang take chat bisa transfer ke CS lain (eskalsasi)
- **Endpoint `/api/users/agents`** — CS user bisa fetch list agent aktif (tanpa info sensitif)
- **Permission guard** — CS cuma bisa transfer chat miliknya; admin bisa transfer chat siapapun; CS bukan pemilik ga bisa transfer
- **Frontend** — tombol Transfer ↗ (warna ungu) cuma muncul untuk pemilik chat atau admin

### Fixed
- **Bug #7: Device suffix mismatch** — `phoneNumberShare` event mengirim LID dengan device suffix (`260678896062673:35@lid`) tapi DB simpan tanpa suffix (`260678896062673@lid`). Fix: normalize LID dengan strip `:XX` suffix sebelum query DB
- **Bug #8: CS bisa transfer chat orang lain** — tambah backend guard + frontend hide tombol Transfer untuk non-pemilik

---

## v0.1.6 — Resolve Chat + Customer Tags (2026-08-28)

**Built by:** Dory + Alita

### Added — Resolve Chat
- **Tombol "Resolve ✓"** — CS yang udah selesai handle chat bisa mark as solved (hanya owner atau admin)
- **Auto-reopen** — kalau contact chat lagi setelah resolved, status otomatis balik ke `open`
- **Visual indicator** — green "✓ Resolved" badge di chat header + green ✓ di sidebar
- **Tab "Resolved"** — filter khusus buat lihat chat yang udah resolved
- **Reply box tetap functional** — dengan hint "will reopen chat" kalau CS kirim pesan di chat yang resolved
- **Prisma schema** — added `resolvedAt` field to Chat model

### Added — Customer Tags
- **Tag custom** — CS bisa bikin tag dengan nama + warna (6 pilihan: blue/green/red/yellow/purple/gray)
- **Shared across all users** — tag yang dibuat satu CS langsung sync ke CS lain
- **Multiple tags per chat** — satu chat bisa punya beberapa tag
- **Add/remove tag** — tombol "Add tag" dengan dropdown (list existing tags + input buat bikin baru)
- **Tag badges** — colored pills di chat header + sidebar (first 2 tags)
- **Endpoint `/api/tags`** — CRUD tags (any CS can create, admin only can delete)
- **Endpoint `/api/chats/:id/tags`** — add/remove tag from chat
- **Prisma schema** — new `Tag` model + `ChatTag` join table

### Fixed
- **Bug #9: Tombol "+" tag ga respons** — `onClickOutside` handler langsung close menu pas klik tombol. Fix: `@click.stop` di tombol + dropdown container
- **Bug #10: Tombol "+" ga ada keterangannya** — ganti dari icon "+" doang jadi icon tag + teks "Add tag"

---

## v0.1.7 — Real-time Sync Fixes + Tag Bug Fixes (2026-08-28)

**Fixed by:** Alita (direct fix)

### Fixed — Real-time Sync
- **Transfer chat real-time** — admin transfer → CS lama langsung lihat release, CS baru langsung lihat assign tanpa refresh
- **Tag add/remove real-time** — CS A tambah/hapus tag → CS B langsung lihat update di chat header + chat list sidebar
- **Tag create real-time** — CS A bikin tag baru → CS B langsung lihat di dropdown Add tag
- **Tag delete real-time** — admin hapus tag dari list → semua user langsung lihat tag hilang dari chat list + dropdown
- **Fix:** `onChatUpdate` di frontend sekarang handle `assignedToId`, `tagAdded`, `tagRemoved` + `chats.updateChat()` di store juga handle tag changes
- **Fix:** `@click.stop` di tombol Transfer + Tag dropdown supaya `onClickOutside` ga langsung tutup menu

### Fixed — Tag Bugs
- **Bug #11: Tag dobel** — `addTag()`/`removeTag()` ga push manual lagi, biarin Socket.IO handle (dedup)
- **Bug #12: First create tag "Internal server error"** — lupa import `broadcast` di `tags.js`
- **Bug #13: Tag delete "Internal server error"** — foreign key constraint: hapus `ChatTag` join records dulu sebelum delete tag
- **Bug #14: Admin delete tag ga sync ke user lain** — dual broadcast: `tag_deleted` (dropdown) + `chat_update` dengan `tagRemoved` (chat list)
- **Tag color default** — ubah dari `blue` ke `gray` (color optional)
- **Admin delete tag UI** — section "Admin: click to delete" di dropdown Add tag

### Fixed — requestPhoneNumber Spam
- **Bug #15: requestPhoneNumber dikirim terus-terusan** — setiap pesan masuk dari LID yang belum resolved, request dikirim ulang. Fix: `requestPhoneSentSet` (Set) track siapa yang udah dikirimi request, cuma kirim sekali per contact

---

## v0.1.8 — Chat List Filters (2026-08-28)

**Built by:** Dory

### Added — Chat List Filters
- **Filter by Tag** — multi-select tags, AND logic (chat must have ALL selected tags)
- **Filter by Handler** — dropdown CS users, filter chats assigned to specific user
- **Filter by Date Range** — From/To date pickers, filter by `lastMessageAt`
- **Collapsible Filters section** — expand/collapse, active filter count badge, Clear filters button
- **Backend** — `GET /api/chats` accepts `tagIds`, `handlerId`, `dateFrom`, `dateTo` query params

---

## v0.1.9 — Blast Feature Phase 1 (2026-08-28)

**Built by:** Dory

### Added — Mass Blast
- **3 Recipient Sources:** Select from Chat List (filter + multi-select + Select All), Add from Tags (multi-select), Upload CSV (Phase 2)
- **Message composition** — textarea with `{name}` personalization variable
- **Rate limiting** — presets (Fastest/Medium/Slowest) + custom (delay per msg, group size, delay per group)
- **Blast log** — `Blast` + `BlastLog` Prisma models, full history with per-recipient status
- **Real-time progress** — Socket.IO `blast_progress` + `blast_complete` events
- **Pause/Resume/Cancel** — admin only (Phase 1)
- **API** — POST /api/blast, GET /api/blast, GET /api/blast/:id, pause/resume/cancel/delete

---

## v0.1.10 — Blast Fixes (2026-08-28)

**Built by:** Dory

### Fixed
- **Fix 1: CS bisa blast** — bukan cuma admin. CS bisa create + pause/cancel blast miliknya. Admin tetap manage semua.
- **Fix 2: Tombol "Insert Name"** — toolbar button yang auto-insert `{name}` di cursor position
- **Fix 3: Name null = hapus placeholder** — kalau contact ga punya nama, `{name}` dihapus + cleanup spasi ("Halo {name}, promo!" → "Halo, promo!")
- **Fix 4: Toolbar formatting** — Bold (*), Italic (_), Strikethrough (~), Bullet (- ), Numbering (1. ), Insert Name, Attach (disabled, Phase 2)
- **Fix 5: Progress page realtime** — setelah blast, langsung ke halaman progress (bukan history). Progress bar, stats realtime, live recipient log, Pause/Resume/Cancel, **"Run in Background"** button buat balik ke Dashboard sambil blast jalan

---

## v0.1.11 — Blast Phase 2 + CSV + Fixes (2026-08-28)

**Built by:** Dory + Alita

### Added — Blast Phase 2
- **CSV upload** — upload file CSV, auto-detect delimiter (`;` atau `,`), parse + normalize nomor HP (08xxx → 628xxx), header detection (Indonesian + English), preview table dengan valid/invalid badges, max 5000 rows
- **Cold number warning** — nomor CSV yang belum pernah chat ke WA CS Hub ditandai, checkbox "I understand the risk" required sebelum blast
- **Media attachment (blast)** — kirim gambar + caption ke semua recipient, media di-decrypt sebelum kirim
- **Export blast results** — `GET /api/blast/:id/export` download CSV hasil blast (name, phone, status, error, sent_at)
- **Recipient dedup across sources** — chat list + tags + CSV di-dedup, combined count ditampilkan
- **CSV delimiter auto-detect** — count `;` vs `,` di baris pertama, pakai yang lebih banyak. Handle Excel Indonesia (semicolon) + US (comma)

### Fixed
- **Bug #16: Image blast ga bisa dibuka** — blast service ngirim file encrypted langsung ke Baileys (corrupted). Fix: decrypt via `loadMedia()` dulu sebelum kirim (sama kayak chat biasa)
- **Bug #17: Progress bar ga update** — field name mismatch: backend kirim `sent`/`failed`, frontend baca `totalSent`/`totalFailed` (always undefined). Fix: sesuaikan field names
- **Bug #18: Recipient list dobel** — list di-fetch dari API, terus socket event append row baru → dobel. Fix: single list dengan status checkmark (⏳→✅/❌) yang update in-place, ga append row baru

---

## v0.1.12 — Template Messages (2026-08-28)

**Built by:** Dory + Alita

### Added — Template Messages
- **Admin: Templates page** — create/edit/delete template dengan name, keyword, category, content + formatting toolbar (bold/italic/strikethrough/bullet/numbering + Insert Name)
- **Chat reply box: Template button** — tombol document icon di sebelah paperclip → dropdown dengan search + grouped by category → klik buat insert
- **Slash command detection** — ketik `/` di text field → flyout muncul dengan max 5 matching templates → arrow keys navigasi → Enter insert, Escape close
- **{name} personalization** — jalan di SEMUA outgoing message (ga cuma template), replace dengan contact name atau hapus jika null
- **Real-time sync** — admin edit template → semua CS langsung dapet update via Socket.IO `template_update`
- **Prisma schema** — `MessageTemplate` model (id, name, keyword, content, category, createdBy)
- **API** — GET/POST/PUT/DELETE `/api/templates` (admin only untuk create/edit/delete)

### Fixed
- **Bug #19: Tombol template ga respons** — `onClickOutside` handler langsung nutup dropdown pas klik tombol. Fix: `@click.stop` di tombol template (sama kayak fix tag `+` dan Transfer sebelumnya)

---

## v0.1.13 — Favorite Messages + In-Chat Search (2026-08-28)

**Built by:** Dory + Alita

### Added — Favorite Messages
- **Star icon di tiap bubble** — hover to show, click to toggle favorite (⭐ filled / ☆ empty)
- **Smart positioning** — incoming bubble: star di kanan, outgoing bubble: star di kiri (sisi dalam bubble)
- **⭐ Favorites panel** — button di chat header, list all favorited messages in current chat, click to jump-to-message
- **Per-user favorites** — one favorite per user per message (unique constraint)
- **Prisma schema** — `FavoriteMessage` model (messageId, userId, chatId, unique constraint)
- **API** — POST toggle, GET per-chat favorites, GET all favorites

### Added — In-Chat Message Search
- **Search bar** — search icon button di chat header, expand input bar
- **Real-time search** — debounce 300ms, case-insensitive, min 2 chars
- **Results dropdown** — message preview, sender, timestamp → click to scroll + highlight
- **Highlight** — yellow background ring on matched message, fades after 2s
- **Ctrl+F shortcut** — open search, Escape to close
- **API** — GET /api/chats/:id/search?q=searchterm

### Fixed
- **Bug #20: Star icon kepotong chat list** — posisi star di kiri bubble kepotong sama sidebar. Fix: pindah ke kanan (incoming) / kiri (outgoing) dengan conditional class

---

## v0.1.14 — Global Message Search (2026-08-28)

**Built by:** Dory + Alita

### Added — Global Search in Chat List
- **Search box sidebar ditingkatkan** — sekarang bisa cari pesan di **semua chat** (global message search), bukan cuma nama/phone contact
- **Hasil grouped by chat** — tiap chat yang match ditampilkan dengan avatar, nama, match count, + preview 3 pesan dengan highlighted search term
- **Click result** → buka chat tersebut + scroll ke pesan + highlight yellow ring (reuse in-chat search highlight)
- **Debounce 300ms** — min 2 karakter untuk trigger message search
- **Backend** — `GET /api/chats/search-all?q=searchterm` (Prisma `contains` query across all messages, grouped by chatId)

### Fixed
- **Bug #21: Route ordering 404** — `GET /api/chats/search-all` ke-tangkap sama `router.get('/:id')` (Express match urutan). Fix: pindah route `search-all` + `favorites/all` ke sebelum `/:id`

---

## v0.1.8 — Chat List Filters + Blast Feature Phase 1 (2026-08-28)

**Built by:** Dory + Alita

### Added — Chat List Filters
- **Filter by Tag** — multi-select tag, AND logic (chat must have ALL selected tags)
- **Filter by Handler** — dropdown CS agent, show only chats assigned to selected user
- **Filter by Date Range** — From/To date pickers, filter by `lastMessageAt`
- Collapsible "Filters" section with active count badge + "Clear filters" button
- Backend: `GET /api/chats` accepts `tagIds`, `handlerId`, `dateFrom`, `dateTo` query params

### Added — Blast Feature Phase 1
- **Blast Composer** (`/blast`) — 4-step wizard: Recipients → Message → Rate Limit → Review
  - **Recipient sources:** From Chat List (multi-select + Select All) atau From Tags (multi-select tag)
  - **Personalisasi:** `{name}` variable → replace dengan contact name dari DB
  - **Rate limiting:** Presets (Fastest/Medium/Slowest) + Custom (delay per msg, group size, delay per group)
  - **Estimated time:** auto-calculated dari rate settings
  - **Confirmation modal** sebelum start blast
- **Blast History** (`/blast/history`) — table of all blasts with status badges, click row → detail
  - **Real-time progress** via Socket.IO: progress bar + current recipient
  - **Pause/Resume/Cancel/Delete** buttons (admin only)
  - Per-recipient status: ✅ sent / ❌ failed / ⏳ pending
- **Blast Service** (`src/services/blast.js`) — background execution engine
  - Groups recipients by `groupSize`, sends with `delayPerMsg` between messages
  - Waits `delayPerGroup` between groups
  - Checks blast.status before each send (pause/cancel support)
  - Failed recipients don't stop the whole blast
  - Emits `blast_progress` + `blast_complete` Socket.IO events
- **Prisma schema** — `Blast` + `BlastLog` models with cascade delete
- **API endpoints:** POST/GET/DELETE blast, pause/resume/cancel, preview recipients
- **Admin only** can create/pause/cancel/delete blasts; CS can view own blasts
- **Max recipients:** 1000 per blast (configurable via `BLAST_MAX_RECIPIENTS` env)

---

## v0.1.4 — Media Support (2026-08-28)

**Built by:** Dory (spawned by Alita)

### Added
- **Receive incoming media** — Baileys `downloadMediaMessage()` → encrypt (AES-256-GCM) → save to disk → store metadata in DB. Supports image, video, audio, sticker, document.
- **Send outgoing media** — New `POST /api/chats/:id/media` endpoint. Upload via FormData → encrypt → save → decrypt to buffer → send via Baileys `sendMessage()`. Supports image, video, audio, document.
- **Frontend media display** — Image: inline `<img>` max-width 300px. Video: `<video controls>`. Audio: `<audio controls>`. Document: download link. Caption shown below media if available.
- **Frontend media upload** — Paperclip button in reply box → file picker → upload via FormData. Shows "Sending media..." spinner while uploading.
- **Auth for media serving** — New `requireAuthFlexible` middleware: accepts `Authorization: Bearer` header OR `?token=` query param (needed for `<img>`/`<video>`/`<audio>` tags that can't send headers).

### Infrastructure
- `data/media/` directory auto-created if missing
- Extension derived from mimetype map (jpg, png, webp, mp4, mp3, pdf, etc.)
- `detectMediaType()` helper in baileys.js
- `sendMedia()` function in baileys.js handles per-type Baileys message construction
## v0.1.16 — Announcement Feature (2026-08-31)

**Built by:** Dory + Alita

### Added — Announcements
- **Admin broadcasts** — admins can post one-way text announcements to all CS users with title, plain-text content, pinned flag, optional expiration, and active/inactive status.
- **Real-time delivery** — new/update/delete events broadcast via Socket.IO using the existing `broadcast.emit()` helper.
- **Read tracking** — per-user read state via `AnnouncementRead`; unread count shown on the bell icon; reading an announcement hides it from the user's unread list.
- **Frontend components:**
  - `AnnouncementBanner.vue` — pinned-first, max 3 unread stacked banner inside the Dashboard sidebar; hidden when no unread.
  - Bell icon + dropdown panel in the Dashboard header; expands content and auto marks read; dimmed items for already-read announcements.
  - Toast notification on new announcement while logged in.
  - `Announcements.vue` admin page — table with pinned badge, status (active/expired/inactive), read stats (`X/Y users`), create/edit/delete modal.
- **Backend:**
  - Prisma models `Announcement` and `AnnouncementRead` with cascade delete.
  - `GET /api/announcements` — active, non-expired user view with `readByMe` flag.
  - `GET /api/announcements/all` — admin-only full list with `readCount`/`totalUsers`.
  - `POST /api/announcements` — create (admin only) + emit `announcement_new`.
  - `PUT /api/announcements/:id` — edit fields without resetting read state + emit `announcement_update`.
  - `DELETE /api/announcements/:id` — hard delete + emit `announcement_delete`.
  - `POST /api/announcements/:id/read` — idempotent mark read.
- **Navigation** — `/announcements` route (admin-only) and "Pengumuman" link in Dashboard header; admin panel card added.

### Non-Goals Respected
- No comments/replies, no rich text, no attachments, no scheduling, no push notifications.

### Notes
- `npx prisma db push` applied; `node --check` passed for all modified/created JS/Vue files.
- Frontend build succeeded (138 modules, no errors).
- Dev server restarted and health check passes on port 5030.

### ⚠️ Incident — DB Reset (2026-08-31)
- Builder ran `npx prisma db push --accept-data-loss --force-reset` → **entire DB wiped** (only admin+cs1 re-seeded).
- **Lost permanently:** 9 chats (~84 messages, incl. Friday history), 4 test blasts, 1 template, 1 shared file record, user `wahyu` + original cs1/wahyu password hashes. No backup existed — backup script never covered this project (fixed same day: DB, WA session, media, code, config now in daily backup).
- **Survived:** WA session (connection alive, no QR re-scan), media files on disk, all code/features.
- **Recovery (Alita):** user `wahyu` re-created (temp pw `wahyu123`), independent API verification 14/14 green, welcome announcement seeded, backup script patched + tested.
- **Lesson:** coding-subagent specs must explicitly FORBID destructive DB flags (`--force-reset`, `--accept-data-loss`, `DROP`, `rm`); if a reset is demanded, STOP and report.

---

## v0.1.15 — Cold-Start Crash Fix (2026-08-31)

**Fixed by:** Alita

### Bugfixes
- Removed duplicate `const fs` / `const path` declarations in `src/wa/baileys.js` (leftover from Friday rapid-patch session 16:26; server kept running on old in-memory code so it went unnoticed until Monday cold start)
- Verified: syntax check all `src/` files OK, server boots cleanly, health check 200, WA session auto-reconnected (no QR re-scan needed)

### Verified by user (2026-08-31)
- ✅ **Blast Phase 2 + CSV upload** — tested by Kanaka, works ("udah bisa")
- ✅ **Tangan Kanan (upload/insert)** — tested by Kanaka, works

## v0.1.18 — Hotfix: Tangan Kanan Render Regression (2026-08-31)

**Fixed by:** Alita

### Bug
- v0.1.17 accidentally broke the v-if/v-else chain in `TanganKanan.vue`: the announcements section (`v-if="!loading"`) started a NEW chain between the loading spinner and the folders template, so the folders template (`v-else-if="!loading"`) never rendered — folders, upload buttons, and New-folder UI all disappeared (only the add-link form, which sits OUTSIDE the chain at the top of the sidebar, remained visible).

### Fix (3 attribute changes)
- Loading spinner: back to `v-if="loading"` (also removes a UX regression — whole sidebar no longer flashes "Loading..." during announcement refetch)
- Announcements section: `v-else` (chains to the spinner — renders when not loading)
- Folders template: standalone `v-if="!loading"` (no longer chained to the announcements section)

### Verification
- Source structure confirmed on disk (chain reads correctly, symptom-consistent)
- Rebuilt frontend (vite build) — new bundle `Dashboard-D5DEsV33.js` contains BOTH the Pengumuman section AND New-folder/Upload strings
- Health 200. Visual browser check pending Kanaka reload (all passwords changed post-incident — automated login blocked)

### Lesson
- Post-change verification must regression-test EXISTING features in the touched component, not just the new ones — grep-only verification passed v0.1.17 while the folders were broken.

### Verified by user (2026-08-31 10:50)
- ✅ **Tangan Kanan render regression fixed** — Kanaka: "oke fiturnya udah muncul lagii" — folders + upload + New folder + 📢 Pengumuman semua render bareng di TK setelah reload.

---

## v0.9.1 — Hotfix pasca-revamp: layout height + tombol legacy invisible (2026-09-09) ✅ USER-VERIFIED

**QA Kanaka setelah v0.9.0 rilis — 2 laporan, 2 fix (Alita langsung, tanpa Dory):**

**1. Chat window gak memenuhi tinggi window (composer nyangkut di atas)**
- Root cause: class `.h-vp` (height: 100vh/100dvh, warisan v0.2.1 utk iOS Safari dynamic viewport) definisinya ada di `style.css` lama — revamp ganti ke tokens.css/components.css dan definisinya terhapus, padahal class masih dipakai Dashboard root → rantai tinggi putus, container nyusut ngikutin isi.
- Fix: `.h-vp{height:100vh;height:100dvh}` appended ke tokens.css. Verify runtime Chrome CDP: computedHeight = viewport = 800px, fills:true ✅

**2. Tombol "Import CSV" invisible di light mode**
- Root cause 2 lapis: (a) mapping Tailwind `wa:` colors hilang saat revamp → `bg-wa-dark` jadi kelas mati (background transparan, teks putih di bg terang); (b) shim legacy di components.css salah semantik — `wa-dark` dipetakan ke `surface-container-lowest` (near-white di light) + `!important`, padahal semantik asli `wa-dark` = navy gelap tetap (#0b1a24).
- Fix: mapping `wa.dark/green/light` dikembalikan di tailwind.config.js + shim `.bg-wa-dark → var(--wa-legacy-dark)`. Verify: served CSS `.bg-wa-dark{background-color:var(--wa-legacy-dark)}`, runtime computed = rgb(11,26,36) ✓. Bonus: menolong semua pemakai kelas `wa-*` lain (avatar chat, Settings, AdminHistory).
- **Meta-lesson:** kelas legacy yang masih DIPAKAI wajib diaudit sebelum file CSS lama dibuang; audit visual dark-mode doang gak cukup nangkep bug light-mode; shim legacy harus jaga semantik asli kelasnya.

**USER-VERIFIED 16:19** ("dua bug sudah fix") ✅

---


---

## v0.9.2 — QA: ikon composer dobel (paperclip vs folder) (2026-09-09) ✅ USER-VERIFIED

**Laporan Kanaka:** tombol upload file (kiri) dan Tangan Kanan (kanan) di composer gambarnya sama (keduanya paperclip), susah dibedakan. Minta: upload = klip kertas, Tangan Kanan = folder. Style outline tetap.

**Root cause:** kedua tombol kebetulan memakai SVG path Heroicons `paper-clip` identik (copy-paste saat v0.1.x).

**Fix (Alita):** tombol Tangan Kanan diganti ikon **folder outline** (Heroicons folder, `M3 7v10...`) — paperclip tetap jadi tombol upload. Kedua tombol tetap outline style, tanpa perubahan handler/logika.

**Verified:** runtime Chrome — `paperclip: 1, folder: 1` di composer; audit visual: "clearly different from each other, both outlined".

---


---

## v0.10.0 — Empat Fitur: Snooze + Catatan Internal + CSAT + Pesan Terjadwal (2026-09-09) — QA SIMULASI SELESAI, MENUNGGU QA KANAKA

**Build:** Dory (13m43s, smoke 7/7) • **Deploy & QA simulasi multi-akun:** Alita

**Fitur (spec `wa-cs-hub-v0.10.0-spec.md`):**
- 😴 **Snooze Chat** — hilang dari list sementara (preset 15m/1h/3h/Besok 08:00/custom), balik otomatis via scheduler WIB; pesan pelanggan saat snooze → auto-cancel; FIFO/queuedAt nihil berubah
- 📝 **Catatan Internal** — shared antar CS assigned + admin, real-time socket, delete penulis/admin, rate 1/5s, ≤2000 char, tidak dikirim ke pelanggan
- ⭐ **CSAT Survey** — default OFF; setelah resolve → pelanggan dapat pesan rating 1-5 (template admin + {name}); parse angka/⭐; analytics avg/distribusi/per-CS; isAuto (bukan first-response)
- ⏰ **Pesan Terjadwal** — tulis sekarang kirim nanti (⏰ di composer), cancel oleh pemilik/admin, atomic claim anti-dobel, isAuto

**Schema additive:** Chat.snoozedUntil/snoozedBy + ChatNote + CsatSurvey + CsatConfig (default enabled=false) + ScheduledMessage

**QA simulasi multi-akun (Alita, Chrome CDP + harness):** 3 akun QA (qa_admin/qa_cs1/qa_cs2) + 3 chat dummy TEST-QA-A/B/C di produksi (bertanda, sudah dibersihkan) — hasil:
- ✅ Snooze: POST 200 → hilang dari list `mine`, muncul via `snoozed=1` → auto-expired setelah tick scheduler (log "Snooze selesai")
- ✅ Catatan: POST 201 (assigned CS) → admin GET 200 → CS non-pemilik 403
- ✅ CSAT: default OFF benar; ON + resolve → survey terbuat (guard phone valid bekerja — chat QA awalnya ditolak karena contactPhone invalid, diperbaiki); parseRating & stats endpoint berfungsi
- ✅ Terjadwal: POST 201 → scheduler pick-up → kirim ke nomor dummy → Baileys "Timed Out" (EXPECTED: nomor TEST-QA tidak ada di WhatsApp asli) → status `error` + error tercatat (error path benar); cancel E2E ✓ (status `cancelled`, tidak terkirim)
- ✅ Permission: CS non-pemilik 403 di notes/snooze/scheduled/csat
- ✅ Cleanup: semua artefak TEST-QA dihapus (residual 0/0/0), CSAT dikembalikan OFF, health OK

**Catatan:** pengiriman WA asli (CSAT/scheduled ke pelanggan beneran) belum bisa diuji penuh dari lokal tanpa nomor WA dummy aktif — error path terverifikasi, delivery path menunggu QA Kanaka dengan chat asli.

**Meta-lesson QA harness:** cleanup loop `.then` di dalam `deleteMany().catch()` per model bikin skip-silent saat error; ganti sequential await eksplisit. FK order: chatNote→csatSurvey→scheduledMessage→chatEvent→message→chat→user.

---


---

## v0.10.1 — QA: panel Catatan/Terjadwal selalu bisa dibuka di mobile (2026-09-09) ✅ USER-VERIFIED

**Laporan Kanaka (19:05):** di mobile, buka chat gak ada opsi nampilin Catatan — baru muncul setelah bikin pesan terjadwal.

**Root cause:** `vpanelsOpen` = `panelsOpen && (notes.length > 0 || scheduled.length > 0)` — panel cuma ke-render kalau SUDAH ada isinya → note pertama gak bisa ditulis di chat kosong. Kegagalan verifikasi Alita di v0.10.0 (harusnya ke-catch).

**Fix (Alita, frontend-only):**
1. Panel ke-render **selalu** saat dibuka — desktop default terbuka; mobile via tombol toggle eksplisit di header chat (ikon ✏️, min 44px) + chip "📝 Notes" di desktop topbar
2. Toggle state `vpanelsMobileOpen` per chat (reset saat ganti chat); desktop tetap hormati `panelsOpen` prop
3. Panel kosong menampilkan empty state existing (NotesPanel/ScheduledPanel sudah punya)

**Verified runtime mobile (Chrome CDP, 390×844):** toggle button ada di header chat ✓; tap → panel muncul (`panelVisible: true`) ✓; textarea input catatan tersedia ✓; empty state tampil ✓

---


---

## v0.10.2 — QA: composer mobile — 4 tombol → menu "+" M3 (2026-09-09) — MENUNGGU QA KANAKA

**Laporan Kanaka (19:21, screenshot):** di mobile, text field sempit banget karena 4 tombol (media/template/Tangan Kanan/terjadwal) makan ruang. Usul: masukkan ke tombol "+", tap → bubble menu (M3 Expressive). Kanaka pilih **menu list vertikal**.

**Fix (Alita, frontend-only, ChatDetail.vue):**
- **Mobile (<768px):** 4 tombol diganti SATU tombol **"+"** — tap → `m3-menu` bubble vertikal ke atas: Kirim Media (paperclip) · Template · Tangan Kanan (folder) · Pesan Terjadwal (⏰). Semua handler existing dipakai ulang (file picker, template flyout, TK sheet, schedule dialog) — nihil logika berubah
- **Desktop (≥768px):** TIDAK berubah — 4 tombol tetap eksplisit (efisiensi klik buat CS)
- State `attachMenuOpen`, item menu memanggil aksi lalu menu auto-tutup; tap luar menutup (pola m3-menu kebab)

**Verified runtime mobile (Chrome CDP 390×844, chat aktif):** tap "+" → menu terbuka dengan 4 item ("Kirim Media, Template, Tangan Kanan, Pesan Terjadwal") ✓; audit visual M3: menu rounded, elevated, text field lega ✓. Screenshot: `media/v0102-mobile-attach-menu.png`.

---


---

## v0.10.3 — QA: tap luar menutup flyout/menu (out-of-focus dismiss) (2026-09-09) — MENUNGGU QA KANAKA

**Lapor Kanaka (19:37):** flyout template di mobile gak bisa ditutup kecuali pilih salah satu template — harusnya tap di luar (out-of-focus) menutup.

**Root cause:** floating elements gak punya listener document click — flyout template, menu "+" baru (v0.10.2), dan KebabMenu desktop semuanya kena (mobile sheet kebab sudah aman: punya backdrop).

**Fix (Alita, frontend-only):**
- `ChatDetail.vue`: listener `document.click` → tutup `attachMenuOpen` + `showTemplateDropdown` (m3-menu punya `@click.stop` jadi klik di dalam menu gak menutup — tap luar saja yang nutup)
- `KebabMenu.vue`: sama — document click → tutup dropdown desktop

**Verified:** build OK (index-CjLZxac-.js), listener + `@click.stop` marker tersedia (3 + 8). Runtime verify menyusul di QA manual.

---


---

## v0.10.4 — QA: bubble chat offside karena URL panjang (2026-09-09) — MENUNGGU QA KANAKA

**Lapor Kanaka (19:56, screenshot):** bubble pesan keluar dari layar (offside) kalau chat-nya mengandung URL panjang (docs.google.com/spreadsheets/d/...).

**Root cause:** bubble hanya punya `max-w-[70%]` tanpa aturan word-break — token URL tanpa spasi dianggap SATU kata unbreakable, nolak wrap, dorong bubble melewati tepi container.

**Fix (Alita, frontend-only, ChatDetail.vue):**
- Bubble container: + `break-words` + `overflow-wrap-anywhere` + `min-w-0`
- Content div: + `break-words` + inline `overflow-wrap: anywhere`

**Verified runtime (Chrome CDP, 390×844, chat asli Linabunda yang berisi URL panjang):** 6 bubble diukur — semua `right edge ≤ container right − 16px` (0 overflow). Build index-BcvmDCGx.js / index-yNS7vDpx.css ter-serve.

---


---

## v0.10.5 — QA fix: CSAT loop (rating di-consume diam-diam + cooldown 24 jam per chat) (2026-09-09)

**Lapor Kanaka (20:07, loop chain):** resolve → CSAT → pelanggan bales "4" → chat auto-reopen → masuk queue → di-take → di-resolve lagi → CSAT baru → ∞.

**Root cause:** `maybeHandleCsatReply` mencatat rating TAPI pesan "4" tetap lewat jalur pesan masuk normal → auto-reopen (v0.1.21) → reopen → queue → resolve lagi → survey baru. Dua sistem gak koordinasi.

**Fix (Alita, backend, 2 titik — Opsi A: cooldown per chat, keputusan Kanaka 20:18):**
1. **Silent consume** (`src/wa/baileys.js`): sebelum blok auto-reopen — jika chat `resolved` + ada survey pending (sentAt != null, rating null) + pesan pelanggan = murni rating (parseRating) → atomic claim rating → chat TETAP resolved (tidak reopen/queued), pesan tetap tersimpan (transparan), broadcast `csat_updated` + log. Pesan non-rating ("4 makasih ya") → jalur normal, reopen seperti biasa.
2. **Cooldown 24 jam per chat** (`src/services/csat.js` createSurveyAfterResolve): guard baru — survey terakhir chat itu (apapun statusnya) < 24 jam → skip (log "[CSAT] Cooldown 24 jam — skip"). Loop resolve→survey mati permanen; survey baru boleh lagi setelah 24 jam.

**Verified (QA simulasi):** rating "4" → chat tetap resolved, rating tersimpan, tidak masuk queue; resolve kedua dalam 24 jam → TIDAK ada survey baru; non-rating → reopen normal; >24 jam → survey boleh lagi.

**Rating per-agent (klarifikasi Kanaka):** rating melekat ke CS yang me-resolve saat survey terbit (createdById), kumulatif per-CS di Analytics (avg + distribusi + respons rate).


**Post-verify tambahan (20:30):** QA simulasi loop penuh (chat TEST-QA-LOOP) — STEP 1 resolve → survey #4 terbit ✓; STEP 2 consume rating "4" → rating tersimpan + respondedAt ✓, chat tetap resolved ✓; STEP 3 resolve kedua → cooldown blok survey baru (total tetap 1) ✓. Cleanup: artefak TEST-QA-LOOP dihapus (residual 0), CSAT kembali OFF. Catatan: 2 survey di chat asli Kanaka (177592720191595@lid) dibiarkan — data nyata dari QA Kanaka (id 2 rated 4; id 3 pending — dengan v0.10.5, balasan rating Kanaka akan dikonsumsi silent).

---

## v0.10.6 — QA: cooldown CSAT configurable via admin (mode A/B/C + jam) (2026-09-09) — MENUNGGU QA KANAKA

**Lapor Kanaka (20:55):** opsi A/B/C jangan hardcode — harusnya bisa diganti dari admin panel kapan pun tanpa melibatkan Alita.

**Fix (Alita, backend + frontend):**
- Schema additive: `CsatConfig.cooldownMode` (per_chat/per_agent/hybrid, default per_chat = Opsi A) + `cooldownHours` (default 24, 0–168)
- Guard `createSurveyAfterResolve` jadi dinamis: baca config (cache + invalidate saat PUT)
  - **per_chat (A):** skip jika survey terakhir chat < N jam, apapun agent-nya
  - **per_agent (B):** skip hanya jika agent resolver SAMA dengan survey terakhir < N jam; beda agent → boleh
  - **hybrid (C):** seperti B (agent sama cooldown, beda agent boleh)
  - 0 jam = cooldown mati; guard "max 1 pending per chat" tetap jalan di semua mode
- Route PUT `/api/csat/config`: validasi mode enum + jam 0–168
- UI: kartu "Anti-Spam (Cooldown Survey)" di AdminCsat — dropdown mode (label bahasa manusia) + input jam + hint dinamis; save via API asli → langsung aktif tanpa restart

**QA E2E (4 mode, via API PUT jalur asli admin):**
- TEST A: per_chat + beda agent resolve → 1 survey (BLOCKED ✓)
- TEST B: per_agent + beda agent → 2 survey (BOLEH ✓)
- TEST C: hybrid + agent sama → 1 survey (BLOCKED ✓)
- TEST 0 jam → 2 survey (BOLEH ✓ — cooldown off)
- Cleanup FK-correct: residual 0, config balik default (per_chat/24h/OFF)

---


---

## v0.11.0 — Security: Enkripsi At-Rest isi pesan chat (AES-256-GCM) (2026-09-09) — DEPLOYED & VERIFIED ✅

**Request Kanaka (21:18-21:26):** chat tersimpan plaintext di DB — minta dienkripsi + search & export tetap work + test dummy comprehensive.

**Arsitektur (spec `wa-cs-hub-v0.11.0-spec.md`):**
- `src/services/textCrypto.js` — AES-256-GCM terpusat, format `enc:v1:<iv>:<tag>:<ciphertext>` di `Message.content` & `Chat.lastMessagePreview`; tanpa prefix = legacy plaintext (backward compat); kunci `MSG_ENCRYPTION_KEY` (32-byte, env — BEDA dari MEDIA key); kunci missing → server nolak start
- Titik tulis: inbound (baileys), autoreply, CSAT, scheduled, reply CS, previews — semua dienkripsi
- Titik baca (dekrip on-the-fly): messages API, chat detail, chat list preview, global search (dekrip in-memory kandidat ≤5000), in-chat search, export history (JSON & CSV), favorites
- Migrasi data lama: `src/scripts/migrate-encrypt-messages.js` (batch 500, idempotent, dry-run mode, post-verify built-in)

**Build:** Dory (19m27s, smoke 7/7) • **Migrasi & QA:** Alita

**QA comprehensive (dummy terenkripsi + data nyata):**
- DB raw: `enc:v1:...` tersimpan, **0 plaintext tersisa** (3/3 pesan + semua preview) ✓
- SEARCH GLOBAL (`/search-all?q=`): keyword plaintext **NEMU** ✓ (dekrip in-memory jalan)
- SEARCH IN-CHAT: **NEMU** ✓
- EXPORT (JSON v0.6.0): ciphertext leak **TIDAK** ✓ + keyword plaintext ada ✓ (dekrip jalan)
- CHAT DETAIL & PREVIEW: tidak ada ciphertext leak ✓
- Boot tanpa kunci → exit dengan pesan jelas (fail-safe) ✓
- Artefak QA dihapus (residual bersih)

**Meta-lesson migrasi:** path DB di skrip = resolve relatif CWD, bukan `prisma/data/` (DB asli) — dry-run WAJIB sebelum migrasi nyata (backup md5 `a0bf9a48...` terverifikasi berisi data asli). Kunci backup: `credentials/wa-cs-hub-msg-key.txt` (chmod 600) — hilang = ciphertext tak terbaca.

---


---

## v0.12.7 — Fix PWA: push lenyap saat app visible + status bar Android tidak ikut accent (2026-09-10) ✅ USER-VERIFIED 09:31

**Laporan Kanaka (15:45):** (1) "waktu kamu bilang fix, aku nemu notifikasi. Tapi waktu aku tutup, buka lagi, terus aku tap test notifikasi manual, ga muncul apa apa" — app KEBUKA → tap test → lenyap; (2) "di Android status bar bisa ikut warna app — walaupun di setting aku udah ganti dari ungu ke hijau, warna status bar tetep ungu".

**Root cause (dibuktikan):**
1. **sw.js push handler** `return` tanpa fallback saat ada jendela visible — asumsi in-app toast pengganti, tapi toast in-app cuma ada untuk kind `message` → kind `test` lenyap total.
2. **theme-color hardcoded di 2 tempat**: `<meta name="theme-color">` di index.html + `theme_color` di manifest.webmanifest — TIDAK PERNAH di-update saat PUT /api/appearance. (DB accentSeed masih #6D28D9 @ 15:34:27 WIB — PUT sukses tersimpan tapi isinya ungu; kemungkinan Kanaka sempat ganti hijau lalu balik ungu. Bukan silent-fail: PUT tervalidasi 200/400/401 di sandbox. Dan bahkan kalau DB hijau, status bar tetap ungu karena manifest+meta hardcoded — bug sebenarnya.)

**Fix (build Dory 14m31s, review Alita):**
- **sw.js**: app visible → `postMessage({type:'push-inapp', payload})` ke semua window visible; postMessage gagal/tidak ada window → fallback showNotification (path lama utuh). App tertutup → system notif tetap. + `skipWaiting`/`clients.claim()` — SW baru aktif tanpa tunggu reload.
- **pushInapp.js (baru)** — listener global di App.vue: SW message → toast (semua kind, termasuk test). 
- **`/manifest.webmanifest` dinamis** (server.js, SEBELUM express.static, PUBLIC no-auth): theme_color = accentSeed aktif dari DB, max-age=60, fallback template statis kalau DB error.
- **`/api/appearance/public`** (baru, PUBLIC): `{accentSeed}` utk init script index.html + syncThemeColorMeta().
- **themeColor.js (baru)**: sync meta theme-color live (dark → #141218, light → accentSeed) — dipanggil App.vue mount + AdminAppearance.save() setelah PUT (tanpa reload).

**Test sandbox:** SW simulation 6 skenario PASS (visible→inapp, fallback 4 path); PUT hijau → manifest theme_color #00C853 → restore ungu; /api/appearance/public 200; POST /api/push/test 200 sent:1 (FCM real); prod gak tersentuh sandbox. SW public/ = frontend/public/sw.js byte-identik.

**QA note Kanaka:** setelah deploy, SW baru aktif otomatis (skipWaiting) — tapi PWA yang udah ter-install butuh reload sekali untuk mengambil SW baru + manifest cache max-age=60.

---

## v0.12.6 — Fix push test button: VAPID tidak ter-set di route test (2026-09-10) — MENUNGGU QA KANAKA

**Laporan Kanaka (15:34):** install PWA di HP → nyalain notifikasi → pencet "Kirim test notifikasi" → **nggak muncul apa-apa**.

**Diagnosis Alita (15:37):** dua jalur push beda perilaku — (1) jalur otomatis (`src/push.js`, chat masuk) OK karena `setVapidDetails` di-set di module; (2) **tombol test (`routes/push.js`) bug dari dulu**: `require('web-push')` langsung TANPA VAPID details → FCM nolak **401 "unauthenticated"** → notif gak pernah nyampe. Terverifikasi manual send ke subscription HP Kanaka dengan VAPID set → **201 Created** (notif nyampe).

**Fix (Alita langsung, 2 file):**
- `src/push.js`: export `sendToSubscription` (helper yang dipakai jalur otomatis — sumber kebenaran VAPID + auto-delete sub 410)
- `routes/push.js`: test route pakai helper yang sama (gak ada web-push duplikat), + guard `isVapidConfigured()` → error jelas kalau VAPID gak ter-set

**Test E2E (produksi):** login admin → POST `/api/push/test` → **200 `{success:true, subscriptions:1, sent:1}`** — notif test terkirim ke subscription HP Kanaka (FCM 201).

**Note:** jalur notif chat masuk (sendToUser/sendToActiveRole) SUDAH benar sejak dulu — bug ini cuma di tombol test.

---

## v0.12.5 — Ganti font: Plus Jakarta Sans → Roboto (2026-09-10) ✅ USER-VERIFIED 09:31

**Request Kanaka (15:06):** "ganti font jadi Roboto, kan dia standarnya Material 3 Expressive."

**Isi (Alita langsung, build 2.22s):**
- Dep: `@fontsource/roboto` masuk, `@fontsource/plus-jakarta-sans` keluar (package.json + lock)
- `style.css`: 5 import font (latin 400/500/600/700/800) → Roboto
- `tokens.css`: `--md-sys-font-family` → 'Roboto' dgn fallback chain; komentar type scale diupdate
- `tailwind.config.js`: font stack `jakarta:` (dipakai class font-jakarta legacy) → Roboto
- `components.css` + `BrandLogo.vue`: komentar wordmark diupdate
- Build output: 10 file roboto woff/woff2, 0 file jakarta tersisa

**Catatan:** weight mapping 1:1 (400–800), display-scale 800 tetap jalan (Roboto support 800). Tidak ada perubahan ukuran/layout — font swap doang. QA: hard refresh (Ctrl+Shift+R) — judul & teks jadi Roboto.

---

## v0.12.4 — Enkripsi scope 2 (ChatNote, ScheduledMessage, Blast) + purge = hapus byte dari disk (2026-09-10) ✅ USER-VERIFIED 14:41

**Laporan Kanaka (14:00–14:13):** (1) di DB aktif masih ada plaintext chat JETE (Angga/Isnaini/Elvira — pesan ke-purge tapi byte nyangkut di slack space SQLite, kebaca via raw file read sampai VACUUM manual 14:11); (2) ChatNote/ScheduledMessage/Blast masih plaintext; (3) keputusan: "purge itu harusnya hapus byte dari disk permanen, bukan cuma logical delete" + "chatnote, scheduled message, blast message juga di enkripsi biar total — fix sekarang".

**Isi (build Dory 17m, review+deploy Alita):**
- **Purge = byte permanen dari disk:** semua 3 path purge (soft/hard/fallback) sekarang auto-VACUUM inline (`vacuumAfterPurge()`, gagal VACUUM ≠ gagal purge). **Temuan penting Dory:** VACUUM doang gak cukup untuk soft-purge — baris ke-flag `purged:1` masih live data, byte-nya kehapus gak pernah (terbukti via test: strings tetap hit setelah VACUUM berkali-kali). Fix: soft purge sekarang `purged: true, content: null, mediaPath: null` (baris tetap ada utk dedup backup; semua read path sudah filter `purged:false`). Test soft+hard: strings 0 hit ✓
- **Enkripsi scope 2** (utility `textCrypto` yang sama, prefix `enc:v1:`, key sama): ChatNote.body (create enkrip; GET list + broadcast `note_added` plaintext), ScheduledMessage.body (create enkrip; list per-chat + `/all` dekrip; scheduler dekrip sebelum kirim + personalisasi `{name}` di plaintext; broadcast `scheduled_added` plaintext), Blast.message (create enkrip template mentah; list/detail dekrip; `runBlast` dekrip SEKALI di awal, personalisasi di plaintext — jangan enkripsi hasil replace)
- **Migrasi backfill idempotent:** `src/scripts/migrate-encrypt-scope2.js` (pattern v0.11.0: backup DB + md5 otomatis ke `backup/pre-v0.12.4/`, batch 500, skip yang sudah `enc:v1:`, post-verify round-trip, `--dry-run`/`--run`)

**Test (sandbox dev 5041, DB salinan, prod 5030 gak disentuh):** migrasi 4/4 baris → enc:v1: + idempotent (rerun 0 plaintext) + round-trip 4/4; scheduled: DB ciphertext → terkirim plaintext `Halo Rudy, …` + `{name}` jalan ✓; blast: template at-rest ciphertext → terkirim plaintext benar ✓; note: DB ciphertext → API plaintext ✓; purge hard+soft: marker strings 0 hit setelah auto-VACUUM ✓; regression chats/scheduled/blast/notes/search OK; node --check 8/8; frontend nihil berubah

**Catatan deploy:** migrasi dijalankan dari cwd repo produksi (Prisma auto-env jebakan: client symlink bisa me-load .env prod kalau DATABASE_URL eksplisit gak di-set — Dory nyaris baca DB prod read-only, gak ada write). Live DB di-VACUUM manual 14:11 (byte JETE hilang sebelum deploy).

---

## v0.12.3 — Fix dark mode form Settings: Change Password (2026-09-10) ✅ USER-VERIFIED 13:51

**Laporan Kanaka (13:46, screenshot):** dua fitur v0.12.2 user-verified ✅ (reset via admin + self-change via CS, "sudah bisa semuanya"), tapi field form Ganti Password di Settings kontras salah di dark mode — teks mask dot gak kelihatan.

**Root cause:** 3 input password hardcode `border-gray-300` tanpa bg/text class → inherit `on-surface` terang di atas bg card. Sama persis pola bug composer v0.12.1 — halaman Settings belum masuk audit M3.

**Fix (Alita langsung, 2 file):**
- `Settings.vue` — input Current/New/Confirm: `border-[outline]`, `text-[on-surface]`, `bg-[surface-container-lowest]`, label `on-surface-variant`, error `error` token; focus ring wa-green tetap.
- `tokens.css` — tambah `color-scheme: light` di `:root` + `color-scheme: dark` di `[data-theme=dark]` → kontrol native UA (input, date picker, scrollbar) ikut tema di SEMUA halaman (pre-emptive, bukan cuma Settings).

**Build:** PASS 2.14s (asset baru ter-serve langsung, backend tidak berubah — no restart). Commit `378384c`. **USER-VERIFIED 13:51** ("okeeh sudah fix").

---

## v0.12.2 — Fitur: reset password admin + fix self-service change password (2026-09-10) ✅ USER-VERIFIED 13:46

**Laporan Kanaka (13:28):** "admin nggak ada fitur untuk reset password dari usernya ya? kayaknya penting sehhh" — investigasi Alita menemukan 2 hal: (1) API `PUT /api/users/:id` sudah support field `password` sejak lama tapi UI reset gak pernah dibuat; (2) bug tersembunyi: form "Ganti Password" di Settings manggil endpoint yang sama yang `requireAdmin` → CS biasa ganti password sendiri selalu 403 (fitur self-service rusak diam-diam sejak dulu).

**Fix (build Dory 6m, review+deploy Alita):**
- **Admin reset password user** — tombol 🔑 Reset PW di halaman Kelola Users (desktop row + mobile card, hidden untuk diri sendiri; self-reset lewat Settings). Dialog inline pola ScheduledDialog (Teleport + m3-dialog, token M3 full — aman dark mode): username read-only, password baru + konfirmasi (min 6 char), Enter submit / Esc close, error API ditampilkan, sukses → toast + close. Backend tidak diubah.
- **Endpoint baru `POST /api/auth/change-password`** (requireAuth) — verify `currentPassword` dulu (salah → 401), lalu update `newPassword` (min 6 chars). Rate limit ketat 10 req/15 menit khusus endpoint ini (anti brute-force, limiter global tidak disentuh).
- **Settings.vue** `changePassword()` pindah ke endpoint baru dengan `{currentPassword, newPassword}` — sekarang CS bisa ganti password sendiri dengan benar (current password memang diverifikasi, bukan cuma formality).

**Test API (sandbox dev 5041, DB salinan, produksi tak tersentuh):** current salah → 401 ✅ · <6 char → 400 ✅ · current benar → 200 + login password baru 200 + password lama 401 ✅ · PUT users token CS → 403 (guard regresi utuh) ✅ · PUT users token admin → 200 + login password hasil reset 200 ✅ · rate limit ke-11 → 429 ✅

---

## v0.12.0 — Guidebook: halaman panduan penggunaan (2026-09-10) ✅ USER-VERIFIED 09:32

**Request Kanaka (00:18):** halaman "Guidebook" berisi cara penggunaan + skenario semua fitur per role. Keputusan: link di **Pengaturan** + link **publik di Login** (CS baru bisa baca sebelum akun aktif).

**Isi (spec `wa-cs-hub-v0.12.0-spec.md`):**
- Route `/guidebook` **PUBLIC** (tanpa login — satu-satunya selain /login)
- 3 tab role: 🛡️ Admin · 💬 CS (default) · 🏪 Cabang
- Konten statis M3: step-by-step bernomor + tips callout, dark mode otomatis
- CS: alur harian, transfer/release, snooze, catatan, terjadwal, template, Tangan Kanan, search, kontak, blast, pengaturan
- Admin: 8 halaman admin, manual take, Auto Reply, CSAT + anti-spam, Backup Drive, export/import, purge, pengumuman, analytics
- Cabang: menerima transfer (gak bisa take), transfer-back ke CS/Admin, online status
- 3 titik link: Settings (kartu atas), Login (bawah form, publik), Admin (kartu launcher)

**Build:** Dory (26m, 39/39 smoke) • **Verifikasi:** Alita (struktur + runtime + visual PASS)
**Deploy:** rebuild frontend saja (chunk Guidebook-Cb3gXtGq.js ter-serve 200), tanpa restart. Catatan build: `setTab()` eksplisit (plugin-vue 5.2.4 bisa tree-shake fungsi inline-template).


## v3.4.2 — Panduan dimensi logo di modal Branding superadmin (2026-09-22)

- **Request owner (19:45):** label upload logo cuma bilang "maks 1 MB" (ukuran file),
  padahal yang bikin logo pas di slot header adalah DIMENSI gambar — perlu info
  eksplisit biar tenant tahu upload apa.
- Modal Branding sekarang menampilkan panduan: rasio disarankan 1:1 (kotak) s/d
  4:1 (memanjang), tinggi gambar 64–256px (render tajam di slot ±26px), PNG
  transparan paling rapi, dan catatan bahwa gambar besar otomatis dikecilkan
  (height di-lock, width auto — object-fit contain).
- Frontend-only (SuperAdmin.vue), build ulang + restart. Server & data tidak
  tersentuh.

## v3.5 — LID ↔ Phone Matching + greeting skip CS-initiated (2026-09-22)

- **Bug report owner (19:58, tenant Parahita / kontak "Berliana"):** initiate chat
  dari kontak (nomor hape) → balasan klien nyasar ke chat BARU (@lid) + kontak
  dobel + greeting first-of-day nyasar. Root cause: WA modern pakai LID sebagai
  identitas pengirim; app match chat by waJid mentah → balasan LID = orang baru.
  LID handling (fitur hub v0.13-0.14) tidak ter-port saat migrasi v3.
- **§1 Routing dua arah di `processIncomingMessage` (pool.js):** sebelum
  find-or-create — exact `[tenantId, waJid]` → LID dgn `remoteJidAlt` (rc14) ke
  chat phone-JID → lookup kolom `lidJid` → lookup `phoneJid` (chat LID resolved);
  phone-JID masuk juga bisa route ke chat LID existing (phone-to-lid). Match →
  mapping dua arah dipasang (`Chat.lidJid` BARU / `phoneJid` bila null). Semua
  downstream (persist, unread, CSAT, auto-reply, push, queue) pakai chat hasil
  routing — JID mentah tidak lagi dipakai.
- **§2 Port LID resolver dari hub (tenant-scoped):** listener `chats.phoneNumberShare`
  (normalisasi device suffix), `resolveLidToPhone` (onWhatsApp → USyncQuery),
  inline resolve fire-and-forget utk chat LID yang phoneJid-nya null + merge guard
  transaksional, `requestPhoneNumber` SEKALI per LID (Set per socket). Contact
  LID-only dapat `phone` otomatis setelah resolve.
- **§3 Greeting skip (KEPUTUSAN OWNER):** greeting first-of-day DAN outside-hours
  away text di-skip bila ada pesan out non-auto dari agent (senderId terisi) di
  chat yang sama pada hari WIB yang sama — `lastAutoGreetDate` tetap di-set.
  Chat CS-initiated tidak lagi menyapa otomatis saat klien bales.
- **§4 Open-chat dari kontak dua arah (contacts.js):** `findChatByAnyJid()`
  (waJid → phoneJid → lidJid) — start-chat dari kontak pakai chat existing,
  tidak create dobel.
- **§5 Script repair `fix-lid-dup-chats.cjs`:** dry-run default, `--apply`
  transaksi per pasangan. Deteksi 2 lapis (contactPhone langsung + fallback
  join-by-Contact-name utk chat LID yang contactPhone-nya LID-digits) + guard
  anti double-pairing. Merge: chat phone = canonical, pesan/tag/event/note/csat/
  scheduled dipindah, `lidJid` dipasang, chat LID dihapus. **PATCH REVIEW ALITA
  (20:35):** contact LID di-RELOCATE ke chat phone (bukan dihapus) bila chat phone
  belum punya contact — tanpa patch ini, kontak "Kolonel Kanaka Prabhata" (t8)
  hilang permanen karena contact-nya hanya ada di sisi LID.
- **Eksekusi merge (Alita, app stopped): 6/6 pasangan sukses** — Berliana t4
  (7607→7606, 9 pesan jadi satu), Kolonel Kanaka t8 (5074→5089, 32 pesan + nama
  survive), Nai/Alita/MP Desta/Lili t8. Verify: msg t4=90 t8=2603 (utuh), chat
  t4=21 t8=2527 (dobel kehapus), WA reconnect kedua tenant.
- **Skema:** `Chat.lidJid String?` + `@@index([tenantId, lidJid])` — additive
  murni (db push sukses tanpa destructive). Backup pra-merge:
  `backup/pre-v3.5-20260922-2017/` (2 snapshot: pra-kerja + pre-merge).
- **QA (Dory, smoke 4/4 PASS):** (a) LID→phone chat existing + lidJid set;
  (b) chat LID baru + phoneJid mapping; (c) phone→chat LID existing, pesan
  gabung; (d) greeting skip + marker. Tenant QA di-purge bersih. Counts
  Parahita/Mazaya utuh sebelum/sesudah.

## v3.5.1 — Hotfix routing: exact LID chat lama menang atas phone chat (regresi kasus owner) (2026-09-23)

- **Regresi lapor owner (02:27, tenant Parahita):** setelah v3.5, balasan klien
  STILL nyasar — tapi ke pola BEDA: masuk ke chat LID LAMA (chat #5, sisa test
  auto-reply sehari sebelumnya), bukan chat phone yang baru di-initiate (#7635).
- **Root cause:** routing v3.5 prioritas *exact match LID dulu* — chat LID lama
  yang kebetulan exist menang sebelum `remoteJidAlt` (nomor hape) sempat dicek.
  v3.5 cuma nutup kasus "LID chat belum ada" (Berliana), bukan "LID chat lama ada".
- **Fix (pool.js):** pesan LID yang membawa altJid phone → chat PHONE diprioritaskan
  atas exact LID chat; kalau DUA-DUANYA ada → chat LID lama di-merge inline ke
  chat phone (`mergeLidIntoPhoneChat`) lalu route ke phone. Sisi phone-JID masuk
  juga dapat alternatif altJid LID (sebelum lookup kolom). Merge guard
  `mergeLidIntoPhoneChat` ikut dipatch: contact LID di-RELOCATE ke phone chat bila
  phone chat belum punya contact (paritas patch review v3.5 — jangan buang
  identitas kontak).
- **Repair manual (Alita):** chat #5 (LID lama) → #7635: 7 pesan dipindah, contact
  dobel dibersihkan, `lidJid` dipasang. Verify: 8 pesan nyatu, WA reconnect OK.
- **Verifikasi fix oleh owner (02:44-an):** balasan masuk ke chat yang sama
  (#7635), TIDAK ada chat baru nyasar — dibuktikan contact "kanaka" ke-auto-create
  ulang nempel di chat 7635 (hanya terjadi saat pesan masuk nyamber ke chat itu).
- **Permintaan owner (02:47):** hapus total chat test tsb (kontak sudah dihapus
  owner sendiri) — dieksekusi via one-off script: 10 pesan, 9 chatEvent, 2 file
  media di disk, contact auto-recreate (#7623), chat row — semua verified 0;
  PurgeLog tercatat (reason: owner request).
- Catatan UX: fitur "hapus 1 chat total" belum ada di UI (purge per-chat hanya
  membersihkan pesan, chat row tetap) — kandidat fitur berikutnya.

## v3.6 — Hapus Chat Individual (permanen) dari kebab menu (2026-09-23)

- **Request owner (03:06):** fitur delete chat individual — "tempat paling
  cocok di kebab menu tiap individual chat (bareng resolve dll), fokus delete
  permanen cuma satu chat itu aja."
- **Backend** `DELETE /api/chats/:id` (chats.js, admin-only `requireAdmin`):
  port dari one-off script teruji (chat #7635) — isolasi tenant (404 lintas
  tenant), GroupPic best-effort (introspeksi sqlite_master + cache — model
  GroupPic tidak ada di schema v3.x, helper defensif utk masa depan),
  mediaPath dikumpulkan sebelum transaksi, transaksi hapus: message
  (FavoriteMessage cascade via onDelete: Cascade — diverifikasi schema),
  chatEvent, chatTag, chatNote, csatSurvey, scheduledMessage, contact linked,
  chat row → purgeLog (`chat_delete: kebab menu (v3.6)`) → file media disk
  SETELAH transaksi sukses → broadcast event BARU `chat_deleted` → response
  counts.
- **Frontend:** KebabMenu item `🗑️ Hapus Chat` (merah, paling bawah setelah
  separator, admin-only — desktop dropdown + mobile sheet), confirm dialog
  danger ("Hapus permanen chat ini? … tidak bisa dikembalikan"), handler di
  Dashboard (toast + clear selection + navigasi), socket listener
  `chat_deleted` (hapus dari list tanpa refetch + clear selection kalau chat
  yang kebuka itu yang dihapus oleh admin lain).
- **QA (tenant dummy, purged):** DELETE admin 200 + verify all-zero + media
  file hilang; role cs → 403; lintas tenant → 404 (isolasi); LIVE socket
  event diterima; build OK (snapshot public-pre-build-20260923-0316);
  restart 1x by PID; WA t4+t8 reconnect; data Parahita/Mazaya utuh.

## v3.6.1 — Fix: dialog konfirmasi gak nutup setelah tap Hapus (double-mount ConfirmDialog) (2026-09-23)

- **Lapor owner (03:30):** setelah tap "Hapus" di confirmation dialog, toast
  sukses muncul tapi dialognya TIDAK langsung hilang — harus tap Batal dulu.
- **Root cause (bukan bug fitur baru — laten warisan clone hub):**
  `ConfirmDialog` ke-mount DUA kali — global di `App.vue` (sesuai desain
  "dialog tunggal" utils/confirm.js) + mount kedua nyasar di `Dashboard.vue`
  (ikut kebawa dari hub sejak phase 1 — hub juga punya pola yang sama!).
  Event bus window → DUA dialog identik sama-sama ber-respon satu event
  konfirmasi → tap "Hapus" cuma nutup dialog paling atas (yang paling akhir
  ke-mount = App.vue), kembaran di bawah masih nongol.
- **Fix:** hapus mount + import ConfirmDialog dari Dashboard.vue (App.vue
  tetap jadi satu-satunya wadah). Build ulang + restart. Semua confirmAction
  caller (resolve, release, delete chat, snooze, dll) tetap jalan — resolve
  dialog yang dulu dipasang di Dashboard kini lewat dialog global.
- Catatan: hub non-SaaS punya bug yang sama (Dashboard L298 double-mount) —
  arsip, retired, tidak di-fix (biarkan sebagai catatan historis).

## v3.7 — 2026-09-23
### "Hapus Chat" pilihan kontak + anti-duplicate re-link
- **Kebab menu:** dua item admin-only — "🗑️ Hapus Chat" (kontak DIPERTAHANKAN, default) & "🗑️ Hapus Chat + Kontak" (kontak ikut terhapus, behavior v3.6)
- **API:** `DELETE /api/chats/:id?deleteContact=false|true` — absent = false = keep (detach `contact.chatId=null`, data kontak utuh); purgeLog reason mencatat mode (kept|deleted)
- **Anti-duplicate re-link** — helper baru `src/utils/contactRelink.js` dipanggil di 4 jalur (pool.js syncContactFromChat, GET /api/contacts/by-chat/:chatId, autoReply setContactMenuShown, POST /api/contacts/:id/open): kontak orphan by-phone tenant-scoped di-re-link race-safe (updateMany chatId:null), bukan bikin dobel — kasus "Berliana" tidak kambuh lewat pintu manapun
- **Dialog berbeda** — keep: "Riwayat chat dihapus, kontaknya tetap tersimpan"; delete: dialog v3.6
- QA 8/8 PASS di tenant dummy (id 17, purged bersih); 2 bug ketemu saat QA langsung difix (F1: fallback C4 by-phone tabrak unique chatId → 500; F2: helper orphan-first + unique-safe). Laporan: `docs/report-v3.7.md`

## v3.7.1 — 2026-09-23
### Hotfix branding per-tenant gak tampil di header
- **Bug:** brandName tenant (contoh "Mazaya Fit") tersimpan bener di DB + tersaji via /auth/me, TAPI header cuma nunjukin suffix "by ChatBareng" — nama brand gak pernah muncul.
- **Akar:** `BrandLogo.vue` — computed `effectiveText` (brandName || fallback) ada sejak v3.4 tapi **template nampilin prop `text` mentah** (kosong di header tenant; prop text cuma dipakai Login). Sisa implementasi v3.4.
- **Fix:** template pakai `{{ effectiveText }}` (1 baris) — brandName tenant kini tampil di topbar desktop + mobile, suffix "by ChatBareng" tetap kecil di sebelahnya. Login tetap "ChatBareng" polos (by design).
- Frontend-only, build ulang (index--Z7HdcXL.js + BrandLogo-Ddr-f2ho.js). Verified compiled chunk render pakai computed, bukan prop.
- **Follow-up test Kanaka (15:02):** masih "ChatBareng" doang (malah suffix hilang) → akar kedua: state di `utils/branding.js` = plain object singleton GAK reactive → hard refresh render pertama dgn state kosong, `loadBrandingAndPlan()` isi belakangan → Vue GAK re-render (computed stuck). Repro @vue/reactivity: plain NO, reactive YES. **Fix #2:** state dibungkus `reactive()` (import dari vue) — render ulang otomatis pas fetch selesai. Build final: index-CGRBOmCz.js.
- **v3.7.1 hotfix tambahan — "Logout & Clear Session" gak bisa (Admin WhatsApp):** backend route `POST /api/wa/logout` wajib guard `?confirm=true` (sejak v3.2), frontend masih POST telanjang → 400 'Konfirmasi diperlukan' senyap (console.error doang) → tombol keliatan mati. Fix: teruskan konfirmasi dialog M3 ke API (`?confirm=true`) + toast feedback sukses/gagal. Kena SaaS saja (non-SaaS gak ada guard). Bundle: index-C2M70e0Z.js.

## v3.9 — 2026-09-23
### Multi-Nomor WA per Tenant (Pool / Assigned / Mix)
- **Tiap tenant bisa nautkan hingga 3 nomor WA** (slot 0–2; kuota diatur superadmin via plan `maxNumbers`, hard cap 3; kuota dihitung dari slot yang ADA)
- **3 mode routing** (Tenant.waMode): `pool` (antrean sama, sumber multi-nomor transparan) / `assigned` (nomor → agent tertentu, born-assigned) / `mix` (per-slot: sebagian pool, sebagian assigned + tick reassign-opsional default OFF)
- **Aturan tunggal balas via nomor penerima** — slot asal mati saat reply = kirim GAGAL dgn pesan jelas (JANGAN fallback ke nomor lain, keputusan owner)
- **Auto-reply & menu gateway:** "Terapkan ke: Semua nomor (linked, default) / Nomor ini saja" (per-slot config + fallback shared)
- **Blast:** multi-select nomor pengirim + rotate tiap N pesan (round-robin antar slot connected) + BlastLog senderSlot
- **Superadmin:** modal "Nomor WA" per tenant (slot mgmt + kuota) + plan field Maks. Nomor WA
- **Tenant Admin→WhatsApp:** daftar slot + label + QR/pairing/logout per slot
- Schema additive: `TenantNumber` + `Tenant.waMode` + `Chat.numberSlot` + dst (backup: saas-v3-backup-20260923-155256.db; counts verified 2 tenant/9 user)
- Tenant 1-nomor = zero behavior change (slot-0 = path sesi lama, tidak dimigrasi)
- Report: docs/report-v3.9.md; spec: docs/spec-v3.9-multi-wa.md (keputusan owner locked 18:24)


## v3.9.1 — 2026-09-23 (hotfix audit Kimi)
### 12 bug dari dual-audit (Kimi-K3 & Kimi-K2.7) difix
- **C1/C2:** `logoutTenant(tenantId, slot)` + `disconnectTenant(tenantId, slot)` slot-aware + pakai slotKey (pool key string `tid:slot`) — logout 500 fixed; reconnect per-slot benar
- **BUG-4/5:** LID inline resolve pakai socket slot penerima; reconnect chain membersihkan state lama
- **H1/BUG-1 (sistemik):** semua lookup legacy `where:{tenantId}` pada AutoReplyConfig/MenuGatewayConfig → compound `tenantId_numberSlot` (12 call-site: services, routes, tenantSeed) — autoreply & menu gateway mati total sebelum ini
- **compound-NULL:** Prisma menolak compound key dgn `numberSlot: null` → shared row via `findFirst` + update by id (semua call-site)
- **C3/BUG-12:** endpoint `POST/DELETE /api/wa/numbers*` ditambah (kuota plan.maxNumbers → 403); PUT tetap update-only untuk row yang ada
- **H2/BUG-13:** blast `sendSlot` di-hoist sebelum try (catch crash fixed)
- **BUG-9:** blast round-robin mulai dari `activeSlots[0]` (off-by-one)
- **BUG-10:** SA POST numbers menolak slot > 2 (sebelumnya slot=3 lolos → slot yatim makan kuota)
- **BUG-11:** SA DELETE slot → 409 bila logout gagal (cegah socket hantu)
- **BUG-6:** reply gagal → response API + broadcast membawa `waError` (CS tau slot mana mati)
- **BUG-14:** GET numbers `used` konsisten hitung dari DB
- Verified runtime: `getConfig(4)` OK untuk kedua model (smoke test), 12 file syntax OK, build sukses, app restarted by-PID (54240→56509), health 200, QR siap scan


## v3.9.3 — 2026-09-23 (hotfix re-audit K3)
### 3 catatan dari re-audit Kimi-K3 (verdict GO) difix
- **MEDIUM-1:** blast dedup by phone antar chatIds — kontak sama dengan ≥2 chat (slot beda) kini HANYA dikirim sekali (chat lastMessageAt terbaru; tie → id terkecil). Cegah pelanggan kena blast dobel lintas nomor
- **MEDIUM-2 (carry-over v3.9):** PUT /api/wa/numbers/:slot kini guard kuota plan.maxNumbers saat upsert-create (403) — tutup bypass via API langsung
- **LOW-1:** /open dengan numberSlot invalid eksplisit → 400 (bukan silent-fallback slot-0)
- Unit test dedup PASS (chat dobel 628111 → 1 terpilih, LID-only & phone unik tetap masuk); restart by-PID (61483→62374), health 200

**Tambalan audit Kimi-K3 (GO-WITH-NOTES → GO, commit v3.9.4b):**
- HIGH-1: neutralisasi shared MenuGatewayConfig saat mode menu per-slot dari Auto Reply
  (slot tak dicentang tidak bocor dapat menu via fallback shared).
- MEDIUM-1: proteksi 409 link-all — aktifkan menu "Semua nomor" saat shared AR teks aktif → 409.
- MEDIUM-2: guard save-tanpa-centangan MenuGateway (frontend toast + backend 400 array kosong).
- LOW-2 (XFF spoof smoke-test) = follow-up ops, tidak mengubah kode.
