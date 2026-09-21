# ChatBareng v0.13.0 — Menu Gateway (Auto Reply Triage) — SPEC

> Status: SPEC FINAL (desain locked dgn Kanaka 2026-09-11, 18:42–19:06 WIB)
> Builder: Dory • Verifier/deployer: Alita • Default: **OFF** (zero behavior change pasca-deploy)
> Catatan versi: nomor **v0.13.0 dialokasikan ke fitur ini**; backlog "multi-nomor WA" bergeser ke **v0.14.0+** (desainnya tetap tersimpan di memory).

---

## 1. Ringkasan

Auto reply tipe ketiga (setelah Outside Hours + First-of-Day Greeting): pelanggan baru menerima **menu bernomor** ("1. Komplain, 2. Ambil hasil, …"). Jawaban pelanggan menentukan:
1. **Balasan konfirmasi** per opsi (custom text per opsi),
2. **Auto-tag** ke **kontak** (persistent antar chat) + mirror ke chat,
3. Baru setelah itu chat **masuk queue** (FIFO existing) dan siap di-Take.

Chat yang belum memilih = **limbo** (tidak masuk queue, tidak trigger notif take). Admin melihat chip indikator. Semua parameter (opsi, tag, timeout, frekuensi) admin-configurable — **zero hardcode**.

## 2. Keputusan desain (LOCKED, Kanaka)

| # | Keputusan |
|---|---|
| D1 | Chat **tidak masuk queue** & tidak trigger notif take sampai pilihan tercatat ATAU timeout/fallback |
| D2 | Jawaban tidak cocok → **jangan loop menu** → auto-tag "Lainnya" (fallback tag, admin-pilih) + langsung queue |
| D3 | Timeout: admin-set, input angka + satuan **detik/menit** (dropdown) |
| D4 | Tag menempel di **kontak** (persistent); v1 mirror ke ChatTag agar filter existing tetap jalan |
| D5 | **Outside-hours SELALU menang**; menu hanya aktif dalam jam kerja |
| D6 | Repeat trigger: admin-configurable — `per_chat` / `daily` / `weekly` (dropdown, bukan hardcode); marker pola greeting |
| D7 | Admin chip "⏳ Menunggu menu (N)" di dashboard; CS tidak melihat chat limbo (model queue sekarang utuh) |
| D8 | v1 = **satu flow global**; schema future-proof (`tenantId` kolom sejak awal; `waAccountId` menyusul utk multi-nomor) |
| D9 | Greeting interplay: First-of-Day Greeting punya **mode**: `text` (default, perilaku lama) atau `menu` (fitur ini). Away tetap text biasa. |
| D10 | Konfirmasi setelah pilih = **reply text per opsi** (custom, dgn `{name}`), lalu tag + queue |
| D11 | Timeout habis → queue **tanpa** menu-tag (beda dgn no-match yang dapat tag "Lainnya") |
| D12 | Fitur default **OFF**; ON/OFF satu toggle; perubahan config aman saat live (chat menunggu di-sweep saat OFF) |

## 3. Skema DB (additive only — `npx prisma db push`, zero data loss; backup DB pre-migrate WAJIB)

```prisma
// v0.13.0 — Menu Gateway (singleton + options)
model MenuGatewayConfig {
  id              Int      @id @default(1) // singleton
  enabled         Boolean  @default(false)
  introText       String   @default("Halo {name}! Silakan pilih topik yang ingin Anda sampaikan:\n1. Komplain\n2. Ambil hasil\n3. Tanya promo")
  fallbackText    String   @default("Terima kasih! CS kami akan segera membalas pesan Anda. 🙏")
  fallbackTagId   Int?                     // tag "Lainnya"; null = tanpa tag
  timeoutValue    Int      @default(30)    // 10..3600 (efektif detik)
  timeoutUnit     String   @default("minutes") // "seconds" | "minutes" (UI dropdown)
  repeatFrequency String   @default("daily")   // "per_chat" | "daily" | "weekly"
  updatedAt       DateTime @updatedAt
  updatedById     Int?
  options         MenuGatewayOption[]
}

model MenuGatewayOption {
  id        Int    @id @default(autoincrement())
  configId  Int
  position  Int                 // urutan tampil = nomor menu (1..8)
  label     String              // "Komplain" (≤50)
  aliases   String  @default("")// csv keyword tambahan, ≤200 (mis. "komplain,keluhan")
  replyText String              // konfirmasi per opsi, ≤500, {name} diizinkan
  tagId     Int?                // tag kontak yg dilekatkan; null = tanpa tag
  config    MenuGatewayConfig @relation(fields: [configId], references: [id], onDelete: Cascade)
}

// v0.13.0 — state gateway per chat (additive kolom)
//   menuState: null | "awaiting" | "done"
//   menuRequestedAt: utk sweep timeout
//   menuOptionId: opsi yg dipilih (audit/analytics; null jika fallback/timeout)
// (di model Chat)
//   menuState       String?
//   menuRequestedAt DateTime?
//   menuOptionId    Int?

// v0.13.0 — tag level KONTAK (persistent) — D4
model ContactTag {
  id         Int      @id @default(autoincrement())
  contactId  Int
  tagId      Int
  source     String   @default("manual") // "manual" | "menu"
  addedById  Int?
  createdAt  DateTime @default(now())
  // @@unique([contactId, tagId]) — idempoten
}

// v0.13.0 — marker frekuensi level kontak (D6)
// (di model Contact)
//   lastMenuShownAt DateTime?
```

Index & constraint: `@@unique([contactId, tagId])` di ContactTag; opsi unique per (configId, position).

## 4. State machine & flow

```
Pesan masuk (direction=in) pada chat:
  [A] chat.menuState == "awaiting"
        → MENU CHOICE HANDLER (lihat §5). Hasil selalu transisi "done":
          cocok → reply opsi → tag → queue
          tak cocok → fallbackText? → tag "Lainnya" → queue
          (queue = queuedAt=now (FIFO key), status open, broadcast queue_update)
  [B] chat belum pernah diflow (bukan awaiting; belum queued/taken):
      1. Outside hours? → jalankan away existing (D5) — TANPA menu. SELESAI.
      2. Jam kerja + AutoReply.greetMode == "menu" + gateway.enabled
         + repeatFrequency mengizinkan (§6):
           → kirim intro (personalisasi {name})
           → chat.menuState="awaiting", menuRequestedAt=now
           → Contact.lastMenuShownAt=now (marker D6)
           → JANGAN queue, JANGANG trigger take-notif
           → broadcast "menu_waiting_update" (chip admin)
      3. Selain itu → alur existing (greeting text / langsung queue).
  [C] Chat sudah queued/assigned/resolved → gateway TIDAK berlaku.
```

**Sweep timeout** (service `menuGateway.js`, `setInterval` 30 dtk, mulai setelah WA connect):
- `updateMany({ where: { menuState: "awaiting", menuRequestedAt < now - timeoutEfektif }, data: { menuState: "done" } })` → untuk tiap chat yg tertransisi: queue tanpa tag + broadcast.
- **Race-safe:** SEMUA transisi state pakai `updateMany` berkondisi `menuState: "awaiting"` (claim atomik; count=0 = kalah race → skip). Pola sama dgn claim greeting (v0.7.0).
- Admin menonaktifkan flow (`enabled=false` via PUT) → **sekaligus** release semua chat `awaiting` → queue tanpa tag (satuan operasi, idempoten).

**Invariant (HARD RULES):**
1. Chat `awaiting` TIDAK PERNAH muncul di queue/count take/notif — query queue existing wajib exclude `menuState="awaiting"`.
2. Tidak pernah kirim menu 2x ke chat yang sama (state guard).
3. Tidak ada loop menu — max 1 intro per trigger; semua jalur berakhir "done".
4. Pesan auto menu: `senderId=null, isAuto=true` (konsisten v0.7.0 — analytics manusia-only tetap benar), TIDAK mengisi firstResponse.
5. CSAT rating-consumed messages (v0.10.5) tidak memicu menu.
6. Timeout efektif dihitung detik: `unit=seconds ? v : v*60`, clamp 10..3600.

## 5. Pencocokan jawaban (deterministik, tanpa AI)

Normalisasi input: `trim`, lowercase, buang prefix `.,):\-` pada token pertama.
1. **Exact number:** token pertama match `/^(\d+)$/` → jika 1..N (posisi opsi) → opsi tsb. Angka 0 atau >N → fallback (D2).
2. **Alias:** input penuh (atau token pertama) == salah satu alias opsi (case-insensitive) → opsi tsb. Tie → position terkecil.
3. Gagal keduanya → **fallback**: tag "Lainnya" (jika diset) + kirim `fallbackText` + queue. **Tidak pernah re-prompt.**

## 6. Tagging (D4)

- Saat opsi dipilih: upsert `ContactTag(contactId, tagId, source="menu")` (idempoten) + **mirror** `ChatTag(chatId, tagId)` (addedById=null, via helper baru `tagContactAndMirror()`) → filter tag chat existing & dashboard chips tetap jalan tanpa refactor.
- Mirror juga dibuat saat fallback (tag "Lainnya") bila fallbackTagId ter-set.
- Tidak menghapus tag lama — additive saja.
- Future (v0.14+): ContactTag jadi sumber kebenaran; UI filter bisa baca kontak-level.

## 7. Repeat frequency (D6) — marker WIB

| Frekuensi | Rule |
|---|---|
| `per_chat` | tiap chat baru yang masuk (default perilaku greeting) |
| `daily` | intro terkirim hanya jika `Contact.lastMenuShownAt` bukan hari kalender WIB ini (format `Asia/Jakarta`, konsisten lastAutoGreetDate) |
| `weekly` | ≥7 hari sejak `lastMenuShownAt` |

Marker di-contact (bukan chat) agar lintas-chat; chat-level marker tidak dipakai utk frekuensi.

## 8. API

- `GET /api/menu-gateway` (admin) → config + options[] + waitingCount
- `PUT /api/menu-gateway` (admin) → validasi (mirip autoreply.js):
  `enabled` bool; `introText` ≤1000 `{name}`-only; opsi **2..8**, `label` ≤50, `aliases` csv ≤200 (≤5 item), `replyText` ≤500 (≥1 opsi wajib punya replyText), `position` unik 1..8; `fallbackText` ≤500; `tagId`/`fallbackTagId` harus id Tag valid/null; `timeoutValue` int, unit in {seconds, minutes}, efektif 10..3600s; `repeatFrequency` in {per_chat, daily, weekly}. Unknown fields ditolak. Save → invalidate cache.
- `GET /api/menu-gateway/waiting` (admin) → `{ count, chats: [{id, contactName, phone, waitedSeconds}] }` (chip + flyout)
- Interaksi `AutoReplyConfig`: + kolom `greetMode String @default("text")` (enum: text|menu) — di-edit di halaman AdminAutoReply (radio 2 pilihan + link ke halaman gateway).

## 9. Admin UI

**Halaman baru `/admin/menu-gateway`** (router meta admin; launcher kartu di Admin.vue; masuk Guidebook admin):
- Kartu 1 — Status & trigger: toggle `enabled`, mode greeting (radio: Teks biasa / Menu gateway), repeat frequency dropdown, timeout (number + unit dropdown), fallback text + fallback tag dropdown.
- Kartu 2 — Intro: textarea `{name}` + preview live + counter.
- Kartu 3 — Opsi (reorder ↑↓, add/remove, max 8 min 2): per baris = nomor otomatis (position), label, aliases csv, reply text, tag dropdown (daftar Tag existing; hint "buat tag dulu di menu Tag" bila kosong).
- Semua save via PUT (satu tombol Simpan per halaman, pattern AdminAutoReply).
- Konfirmasi menghapus opsi yang punya tag → M3 dialog existing.

**Dashboard (admin-only):** chip "⏳ Menunggu menu (N)" dekat chip antrean; klik → flyout daftar chat menunggu (nama, kontak, waited); read-only (tidak bisa take dari flyout). Update realtime via broadcast `menu_waiting_update {count}`; fallback refetch on resume-sync (v0.12.8 hook).

**CS (non-admin):** tidak melihat apa pun terkait menu; chat muncul di queue seperti biasa setelah "done".

## 10. Integrasi hook (titik sentuh kode)

1. `services/autoReply.js` — first-of-day trigger: baca `greetMode`; `menu` → delegasi ke `menuGateway.startFlow(chatId)` (return bool "handled"); outside-hours path TIDAK berubah.
2. `wa/baileys.js` `processIncomingMessage` — setelah save message & sebelum queue/unread-final: jika `chat.menuState=="awaiting"` → `menuGateway.handleChoice(chatId, text)` (skip queue-increment path lama untuk transisi queue milik gateway; pesan tetap tersimpan + preview + broadcast new_message normal). Else jika chat belum queued → cek trigger [B].
3. `services/menuGateway.js` (BARU) — config cache (invalidate on PUT, pola appConfig), startFlow, handleChoice, sweep timeout (interval 30 dtk, mulai post-connect; idempoten), tagging+mirror, broadcast.
4. `routes/menuGateway.js` (BARU) — API §8.
5. `server.js` — mount route + boot service.
6. `frontend` — halaman Admin + chip + `greetMode` control di AdminAutoReply + routes + guidebook section (tab Admin).
7. Queue query (dashboard/queue count/take) — exclude `menuState: "awaiting"`.

## 11. Edge cases (invariant)

- Pelanggan bales non-menu saat awaiting → fallback segera (tanpa re-prompt).
- Pelanggan kirim media tanpa caption saat awaiting → fallback (mediaType bukan angka).
- Menu dikirim, lalu admin edit opsi sebelum jawaban → jawaban dinilai terhadap config TERBARU (cache invalidated on save).
- Chat awaiting + server restart → state di DB; sweep lanjut setelah boot. (Tahan: pesan intro TIDAK dikirim ulang.)
- Dua pesan cepat berturut saat awaiting → keduanya dinilai; yang pertama menentukan transisi (atomik), detiknya jadi pesan biasa masuk thread.
- `enabled=false` saat ada awaiting → sweep langsung queue-kan semua (tanpa tag), chip = 0.
- LID chat → normal (chatId = remoteJid asli, sama seperti receipt v0.12.9).
- Blast/pesan terjadwal/scheduled TIDAK terpengaruh (hanya direction=in pada chat aktif).

## 12. Testing (QA checklist)

1. Default OFF → perilaku 100% sama seperti v0.12.x (regression gate).
2. ON + greetMode=menu → chat baru jam kerja → intro masuk, chat TIDAK di queue, chip admin +1, CS tidak lihat.
3. Jawab "1" → konfirmasi opsi-1 terkirim → kontak ter-tag (cek ContactTag + mirror ChatTag) → masuk queue → admin bisa assign/take → notif queue_update jalan.
4. Jawab "2." / " 2 )" / alias keyword → sama dgn #3 (normalisasi).
5. Jawab "halo" → fallback: tag "Lainnya" + fallbackText + queue, TANPA menu kedua.
6. Timeout (set 10 detik utk test) → sweep 30s → queue tanpa tag; pesan pelanggan berikutnya setelahnya = alur biasa (tidak memicu menu lagi pada chat itu).
7. Repeat daily → chat kedua di hari sama dari kontak sama → TIDAK dapat menu (langsung queue); besok → menu lagi. `per_chat` → tiap chat baru. `weekly` → ≥7 hari.
8. Outside hours → away existing, tanpa menu; jam kerja berikutnya pesan lanjutan → menu muncul (jika frekuensi izin).
9. Admin OFF-kan saat 3 chat awaiting → 3 chat langsung queue, chip = 0.
10. greetMode=text (default) → menu tidak pernah muncul walau gateway ON (gateway hanya dipakai greetMode=menu).
11. Admin PUT invalid (opsi <2, timeout 5s, alias >200) → 400 + pesan validasi.
12. Dark mode + mobile: halaman admin responsive (pattern AdminAutoReply v0.7.1).

## 13. Rollout & rollback

- Backup DB pre-migrate (`backup/pre-v0.13.0-menu-gw-<ts>.db`).
- Deploy: `npx prisma db push` (additive) → build frontend → restart 5030 (kill PID eksplisit — EADDRINUSE lesson) → smoke: health 200, WA Connected, GET/PUT endpoint, chip=0.
- **Rollback = set enabled=false** (semua fitur dorman; data tag yang sudah menempel tidak di-roll-back — itu by design, tag = data operasional). Migrasi additive tidak perlu dibalik.
- Feature tidak menyentuh: enkripsi (v0.11/v0.12.4), receipts (v0.12.9), purge, backup.

## 14. Future (out of scope v1 — hanya disiapkan secara schema)

- Multi-flow per nomor WA: tambah `waAccountId` di config/options (kolom sudah ada `tenantId` di semua tabel baru).
- Analytics pilihan menu (distribusi opsi per periode) — ChatEvent `menu_choice` opsional (rekomendasi: catat event saat pilih; tampilan analytics menyusul).
- Multi-level submenu (menu → submenu) — jika diminta, jadi v0.15.

## 15. Estimasi & pembagian kerja

- **Dory (build):** schema + service menuGateway + hooks (autoReply, baileys) + API + admin page + chip + greetMode control + tests (~1.5–2 jam).
- **Alita (deploy/verify):** backup DB, review kode vs spec (validasi 400, race-safe transisi, exclude queue), `prisma db push`, build, restart, E2E WA dua-perangkat (oslo/Kanaka), QA checklist §12, commit+tag+push GitHub, changelog, snapshot memory.
- **QA Kanaka:** dari HP — alur menu end-to-end + admin editor.