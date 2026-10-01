# WA CS Hub v0.13.3 — Spec: Gateway Entry Fix + Working-Hour Matrix

> Status: APPROVED (Kanaka 2026-09-12 05:02, dgn tambahan F4 satukan frekuensi) → eksekusi via Dory
> Base: v0.13.2 (commit 9b8684c). Semua perubahan additive di `src/wa/baileys.js`,
> `src/services/autoReply.js`, `src/services/menuGateway.js`, `src/socket/queue.js`,
> `src/routes/chats.js`. Tanpa migrasi DB, tanpa perubahan schema.

## 1. Context — 3 akar masalah (laporan Kanaka 2026-09-12 02:44–04:47)

RC1 — **Pintu masuk gateway mati total.** Handler `processIncomingMessage` menjalankan
auto-queue v0.1.21 lebih dulu (chat open+unassigned → `queuedAt` terisi), baru trigger
gateway [B] dicek DI AKHIR handler dengan syarat `queuedAt == null`. Akibatnya chat baru
SELALU ter-queue sebelum pintu dicek → flow menu (D1 limbo) tidak pernah terjadi,
greeting text pun tidak pernah terkirim. Bukti: QA Kanaka 04:16 → chat masuk queue,
`lastAutoGreetDate` tetap "2026-09-11" (hook tidak pernah jalan).
Bonus: outside-hours away text (v0.7.0) ikut mati untuk chat baru karena dibungkus
gate `menuEligible` yang sama (regresi v0.13.0).

RC2 — **Greeting tidak dijaga jam kerja.** Jalur greeting/menu tidak mengecek jam kerja
kecuali away text ON (short-circuit). Away OFF → menu bisa terkirim jam 2 pagi.
Melanggar prinsip "jam kerja menang" (niat D5).

RC3 — **Invariant §4.1 belum diimplementasi.** `getQueueCount`, `emitQueueUpdate`,
take-next, dan list queue tidak meng-exclude `menuState="awaiting"` → chat limbo
terlihat di antrean, bisa di-take, dan malah sort paling depan (queuedAt null).

## 2. Fix design

### F1 — Trigger tunggal + matrix keputusan (perbaiki RC1 + RC2 sekaligus)

Dua titik sentuh di `processIncomingMessage` (blok existing TIDAK direorder, hanya
ditambahi gate):

**E0 — Early gate, SEBELUM blok auto-queue v0.1.21 dan blok push:**
```
gatewayFlowCandidate =
  !fromMe && !group && !consumedAsRating
  && chat.status == 'open' && chat.assignedToId == null && chat.menuState == null
  && !isOutsideHours(cfgAutoReply, dbTimestamp)          // jam kerja saja
  && cfgAutoReply.greetEnabled && cfgAutoReply.greetMode == 'menu'
  && menuGW.enabled && repeatAllows(contact, cfg.repeatFrequency)
```
Bila TRUE → chat TIDAK masuk antrean (skip auto-queue), TIDAK ada push
"Chat baru di antrean", TIDAK emit queue_update. Ini membuat D1 utuh sejak
detik pertama: tanpa ini, chat sempat ter-queue + toast take-notif palsu
terkirim sebelum intro terkirim (gap ketemu dari konfirmasi Kanaka 04:56).
repeatAllows(null)=true → chat baru selalu lolos (contact row belum ada di
titik ini — aman).

**Hook akhir handler (freshChat re-fetch tetap) — matrix keputusan:**

```
Pesan masuk pelanggan (bukan fromMe/grup/CSAT-consumed):
  eligible = freshChat.menuState == null
          && freshChat.assignedToId == null
          && freshChat.status == 'open'
  (queuedAt SENGGAJA diabaikan — auto-queue boleh sudah mengisinya)
  eligible == false → tidak ada auto message, alur normal lanjut. SELESAI.

  outside = isOutsideHours(cfgAutoReply, dbTimestamp)   // hari disabled = outside

  a) outside && outsideHoursEnabled  → away text (D5). Queue TIDAK disentuh
     (chat tetap di antrean untuk CS besok). Marker once/day tetap berlaku.
  b) !outside && greetEnabled && greetMode=='menu' && gateway.enabled
     && repeatAllows(contact, repeatFrequency):
       → startFlow: kirim intro (composeMenuIntro) → claim atomik
         menuState null→'awaiting' (queuedAt memang sudah null bawaan E0)
       → Contact.lastMenuShownAt = now
       → broadcast menu_waiting_update (chip admin) + queue_update
       → inilah D1 limbo: TIDAK di queue sampai jawab/timeout.
       → repeat blocked → skip total (TANPA fallback greet text — menu sudah
         pernah ditunjukkan kontak hari ini; teks greeting ganda membingungkan).
       → ANTI-HILANG: bila startFlow gagal (gateway baru OFF, send gagal, race)
         DAN chat belum queued (bawaan E0) → queue-kan (queuedAt=now) +
         queue_update. Chat tidak boleh hilang dari radar CS.
  c) !outside && greetEnabled && greetMode=='text'
     && repeatAllows(contact, menuGW.repeatFrequency)   // F4 — frekuensi disatukan
       → greet text (queue utuh) + Contact.lastMenuShownAt = now
         (marker BERSAMA dgn menu; upsert-or-skip bila contact row belum ada).
       → repeat blocked → skip total (tanpa fallback greet).
  d) selain itu → diem total (tanpa auto message).
```

Catatan implementasi:
- Klaim marker `lastAutoGreetDate` (atomic updateMany) tetap dipakai sebagai gate
  sekali-per-hari-per-chat, dipanggil SEBELUM matrix (pola v0.7.0), revert bila
  tidak ada jalur yang mengirim ATAU send gagal.
- `sendAutoText` / `sendAutoMessage` tidak berubah (senderName 'Auto Reply',
  isAuto=true, tanpa firstResponse, implied read tetap).
- Broadcast `chat_update` saat intro sukses wajib membawa `queuedAt: null` +
  `menuState: 'awaiting'` agar UI admin sinkron.
- Sweep timeout (menuGateway) sudah mengembalikan awaiting → queue (queuedAt=now);
  tidak berubah.

### F2 — Working-hour gate di jalur greeting (perbaiki RC2)

Tercakup di matrix F1: greeting/menu HANYA di `!outside`. Di luar jam kerja satu-
satunya suara adalah away text (bila ON). Away OFF di luar jam = diem total.
Tidak ada config baru — pakai jadwal hari yang sudah ada di AutoReplyConfig.

### F3 — Enforce invariant §4.1 (perbaiki RC3)

Tambah filter awaiting di SEMUA query antrean:
- `src/socket/queue.js` getQueueCount + emitQueueUpdate
- `src/routes/chats.js` take-next (candidate findFirst)
- List antrean dashboard (query yang memakai `status:'open', assignedToId:null`)
- ⚠️ JEBAK NULL: di Prisma, `{ menuState: { not: 'awaiting' } }` TIDAK match row
  NULL. Wajib pakai `OR: [{ menuState: null }, { menuState: { not: 'awaiting' } }]`.
- Chat awaiting yang menunggu JUGA di-exclude dari push "Chat baru di antrean"
  (baileys.js blok push) — chat limbo tidak boleh menge-notif take (D1).

### F4 — Frekuensi disatukan (keputusan Kanaka 05:02)

Setting `repeatFrequency` di Menu Gateway kini mengatur SEMUA jalur greeting
(menu DAN teks biasa), bukan cuma menu:
- Jalur c (greetMode='text') menambahkan syarat `repeatAllows(contact, repeatFrequency)`
  sebelum kirim; marker = `Contact.lastMenuShownAt` (sama dgn menu) → kontak yang
  hari ini sudah dapat MENU tidak dapat GREETING lagi di chat keduanya, sebaliknya
  juga berlaku.
- `lastAutoGreetDate` (1x/hari/chat, hard cap gabungan semua auto message) tetap
  jadi lapisan kedua.
- UI: label frekuensi di halaman admin diganti "Frekuensi greeting (menu & teks)"
  di Menu Gateway page (dan di Auto Reply page bila ditampilkan). Nilai & endpoint
  TIDAK berubah — hanya label.

## 3. Invariant (hard rules — sama v0.13.0, kini benar-benar di-enforce)

1. Chat awaiting tidak pernah muncul di queue/count/take/push-notif.
2. Menu tidak pernah 2x ke chat yang sama (state guard + claim atomik).
3. Chat assigned (sudah diambil CS) TIDAK pernah memicu greeting/menu/away
   (guard `assignedToId == null` di matrix).
4. Di luar jam kerja: hanya away text yang boleh terkirim (bila ON).
5. Analytics manusia-only tetap: auto message tidak mengisi firstResponse*.

## 4. QA checklist (Kanaka, SETELAH build Dory — baru ini tugasnya kamu 😄)

Setup: gateway ON (greetMode menu), away sesuai skenario, jam kerja default 08–17.

1. **Dalam jam + gateway ON** → chat baru: intro menu masuk, chat TIDAK ada di
   antrean, chip admin +1, CS tidak lihat apa pun (tanpa push/toast "Chat baru
   di antrean"). ← inti D1, dulu tidak pernah jalan
2. Jawab "1" → konfirmasi + tag + masuk antrean + queue_update.
3. Jawab "halo" → fallbackText + tag "Lainnya" + antrean, tanpa menu kedua.
4. Timeout (set 10 detik) → sweep → masuk antrean tanpa tag.
5. **Luar jam + away ON** → away text terkirim (sekali/hari), TANPA menu, chat
   tetap di antrean.
6. **Luar jam + away OFF** → total diem (skenario gagal 04:16 kemarin, kini benar).
7. **Dalam jam + greetMode text** → greeting text, chat langsung di antrean.
7b. F4: repeat daily → kontak sama, chat kedua di hari sama (greetMode text) →
    TANPA greeting, langsung antrean; per_chat → tiap chat baru dapat greeting.
7c. F4: kontak yang hari ini sudah dapat MENU → tidak dapat GREETING text lagi
    di hari sama (marker bersama), dan sebaliknya.
8. Chat yang sudah di-assign CS → pesan pelanggan lanjutan TIDAK memicu apa pun.
9. Chat awaiting tidak bisa di-take & tidak menaikkan hitungan antrean (F3).
10. Repeat daily → kontak sama chat kedua di hari sama → tanpa menu (queue
    langsung); besok → menu lagi.

## 5. Rollout & rollback

- Backup DB pre-deploy: `backup/pre-v0.13.3-<ts>.db` (tanpa migrasi, hanya safety).
- Deploy: build frontend (bila tersentuh) → restart 5030 (kill PID eksplisit) →
  smoke: health 200, WA Connected, queue-count tidak berubah utk chat biasa.
- Rollback: `git revert` commit v0.13.3 + restart. Tanpa perubahan data.
- Commit + tag `v0.13.3` + push GitHub setelah QA Kanaka USER-VERIFIED.