# WA CS Hub — v0.7.0 Spec: Auto Greeting (Outside Hours Reply + First-of-Day Greeting)

**Status:** ✅ APPROVED Kanaka ("gas", 2026-09-09 11:56) — eksekusi: Dory (dev) + Alita (deploy produksi)
**Penulis spec:** Alita | **Eksekusi (nanti):** Dory
**Tanggal:** 2026-09-09
**Sumber keputusan:** Telegram Kanaka 2026-09-09 11:49–11:53

---

## 0. Konteks & Tujuan

Kanaka mau auto message ke pelanggan:
1. **Outside Hours Reply** — pelanggan chat di luar jam kerja → auto "di luar jam operasional"
2. **First-of-Day Greeting** — pelanggan yang chat **pertama kali di hari itu** → auto greeting

**Prinsip yang WAJIB (keputusan Kanaka eksplisit):**
- Auto message **TIDAK menyentuh antrean sama sekali**: tidak mengubah `queuedAt`, tidak assign,
  tidak mengubah urutan FIFO. Chat tetap masuk Queue dan tetap harus di-"Take" manual oleh CS.
- **Analytics jangan jadi korban**: first-response calculation tetap hanya menghitung pesan CS manusia.
- 1 auto message **per hari per pelanggan** (throttle harian).
- Kalau dua trigger sama-sama kena (chat pertama hari itu terjadi di luar jam kerja) →
  **outside hours yang menang** (hanya 1 pesan terkirim).
- v1 **teks saja** (media menyusul kalau perlu).
- Kirim **langsung** (no delay/cancel logic) — keputusan Alita, diam-diam Kanaka.

---

## 1. Data Model (additive only — zero data loss)

```prisma
model AutoReplyConfig {
  id        Int      @id @default(1)   // singleton row
  // Trigger 1: Outside Hours Reply
  outsideHoursEnabled Boolean @default(false)
  outsideHoursText    String  @default("Halo! Mohon maaf, saat ini berada di luar jam operasional. Pesan Anda sudah kami terima dan akan dibalas saat jam kerja berikutnya. Terima kasih! 🙏")
  // Trigger 2: First-of-Day Greeting
  greetEnabled    Boolean @default(false)
  greetText       String  @default("Halo! Selamat datang 🙏 Ada yang bisa kami bantu?")
  // Jam kerja per tipe hari (keputusan Kanaka: grup Senin–Jumat / Sabtu / Minggu)
  monFriEnabled   Boolean @default(true)
  monFriStart     String  @default("08:00")  // HH:mm WIB
  monFriEnd       String  @default("17:00")
  satEnabled      Boolean @default(true)
  satStart        String  @default("08:00")
  satEnd          String  @default("17:00")
  sunEnabled      Boolean @default(true)
  sunStart        String  @default("08:00")
  sunEnd          String  @default("17:00")
  updatedAt       DateTime @updatedAt
  updatedById     Int?
}

// Message — tambah 1 kolom:
  isAuto      Boolean @default(false)   // true = pesan auto greeting/outside-hours

// Chat — tambah 1 kolom:
  lastAutoGreetDate String?             // "YYYY-MM-DD" (WIB) terakhir kirim auto message
```

**Seed:** kalau row `AutoReplyConfig` id=1 belum ada → create saat server start (idempotent).
Kedua fitur default **OFF** (aman untuk update produksi — tidak ada perilaku baru yang menyala sendiri).

---

## 2. Logika Trigger (service baru: `src/services/autoReply.js`)

Hook di `src/wa/baileys.js` → `messages.upsert` (line ~300), **setelah** flow upsert chat existing,
**hanya untuk** pesan masuk: `!msg.key.fromMe`, bukan grup, `direction === 'in'`.

```
maybeAutoReply(chatId, msg):
  1. cfg = getConfig()               // cache in-memory, invalidate saat PUT config
  2. today = tanggal WIB dari timestamp pesan ("YYYY-MM-DD")
  3. ATOMIC CLAIM (race-safe):
       r = updateMany({ where: { id: chatId, lastAutoGreetDate: { not: today } },
                        data: { lastAutoGreetDate: today } })
       if r.count === 0 → sudah ada auto message hari ini → STOP (throttle 1x/hari)
  4. isOutside = hitung dari jam WIB sekarang (lihat §3)
  5. if (cfg.outsideHoursEnabled && isOutside)  → text = cfg.outsideHoursText
     else if (cfg.greetEnabled)                 → text = cfg.greetText
     else → revert marker (kembalikan nilai lama), STOP (kedua fitur off / tidak relevan)
  6. personalisasi {name} → nama kontak dari Chat (sama seperti logic blast: kalau kosong,
     hapus placeholder + bersihkan spasi ganda/koma menggantung)
  7. kirim via `sendMessage(chatId, text)` yang existing di baileys.js
  8. simpan Message: direction 'out', senderId NULL, senderName 'Auto Reply',
     isAuto true, content = text yang terkirim
  9. broadcast socket event new_message existing (chat list & detail update realtime)
  10. kalau step 7 gagal (send error) → revert marker ke nilai lama + log error
      (pelanggan bisa dapat greeting di pesan berikutnya, tidak hang selamanya)
```

**Anti-dobel & crash-safe:** marker `lastAutoGreetDate` di DB, bukan memory → restart server
tidak pernah mengirim ulang. Claim atomik `updateMany` + kondisi `not: today` mencegah dobel
kalau 2 pesan masuk hampir bersamaan.

---

## 3. Aturan Jam Kerja (WIB — Asia/Jakarta)

- Semua hitungan waktu **hard WIB**, bukan timezone server (server UTC). Konversi eksplisit.
- Tipe hari: **Senin–Jumat** (satu grup), **Sabtu**, **Minggu** — masing-masing punya
  toggle + jam mulai + jam selesai sendiri. Default semua: `08:00–17:00`.
- Hari dengan tipe **disabled** (mis. Minggu OFF) dianggap **full di luar jam kerja** hari itu.
- `isOutside = time < start || time > end` (tipe hari aktif), atau `true` (tipe hari disabled).

---

## 4. API Config (admin only)

- `GET /api/autoreply` → config (untuk halaman admin)
- `PUT /api/autoreply` → update (validasi: HH:mm format, start < end, teks ≤ 1000 char,
  placeholder yang diizinkan hanya `{name}`; strip placeholder lain)
- Middleware `requireAuth, requireAdmin` — sama pola dengan routes admin lain.
- Route baru di-mount di `src/server.js`.

---

## 5. Frontend

### 5.1 Halaman Admin: `AdminAutoReply.vue` (baru, route `/admin/autoreply`)
Ikuti pola page admin existing (AdminPurge/AdminUsers — PageShell, lebar konsisten).
Isi:
- Toggle **Outside Hours Reply** + textarea teks + preview (dengan contoh {name} → "Kakak")
- Toggle **First-of-Day Greeting** + textarea teks + preview
- Kartu **Jam Operasional**: 3 baris (Senin–Jumat / Sabtu / Minggu) — masing-masing
  toggle + time input start/end (HH:mm)
- Badge status ringkas di atas: mis. "Aktif · Sen–Jum 08:00–17:00 · Sab/Ming off"
- Save button → PUT → toast sukses (pola existing)
- Nav item baru di menu admin + router entry (`meta: { auth: true, admin: true }`)

### 5.2 Badge di chat detail
Pesan dengan `isAuto: true` → badge kecil **"⚙️ Otomatis"** di bubble (CSS kecil, tidak
mengubah layout bubble). CS paham itu balasan sistem, bukan CS manusia.

---

## 6. Analytics — JANGAN JADI KORBAN (wajib)

- Auto message **TIDAK** mengisi `firstResponseAt` / `firstResponseById` (kolom itu hanya
  di-set oleh jalur reply CS manusia — pastikan hook auto reply melewatinya).
- `senderId: NULL` + `isAuto: true` → metric per-user tidak tercemar.
- Cek dashboard analytics existing (`src/routes/analytics.js`): avg first response tetap
  berbasis `firstResponseAt` dari manusia. Kalau ada query yang menghitung "respons" dari
  tabel Message secara umum, filter `isAuto: false` agar auto message tidak dihitung.
- Auto message TIDAK menaikkan `unreadCount` (direction 'out').

---

## 7. Yang TIDAK berubah (explicit non-goals)

- Antrean: FIFO, take-next, assign, release, resolve, presence, transfer — **nihil sentuhan**
- Blast, template engine (slash `/`), Tangan Kanan, Announcement
- Media handling auto reply (v1 teks; struktur service siap ditambah media nanti)
- Mobile/desktop layout yang sudah shipped (v0.2.0–v0.6.x)

---

## 8. Acceptance Criteria

- [ ] Chat masuk di luar jam kerja (fitur ON) → 1 pesan outside-hours terkirim otomatis
- [ ] Chat masuk pertama di hari itu (dalam jam kerja, fitur ON) → 1 greeting terkirim
- [ ] Chat masuk pertama di hari itu DI LUAR jam kerja (kedua fitur ON) → **hanya outside-hours**
- [ ] Pesan kedua dst. di hari yang sama → TIDAK ada auto message lagi (1x/hari/pelanggan)
- [ ] Restart server → tidak ada auto message terkirim ulang
- [ ] Auto message TIDAK mengubah queuedAt/assignment/urutan antrean; CS tetap Take manual
- [ ] First-response analytics tidak berubah karena auto message (cek angka sebelum/sesudah)
- [ ] Minggu OFF + chat hari Minggu → outside-hours terkirim (bukan greeting)
- [ ] {name} terpersonalisasi dengan nama kontak; kosong → bersih tanpa placeholder
- [ ] Toggle OFF → tidak ada auto message sama sekali
- [ ] Halaman admin: simpan config → reload → nilai persist; validasi jam error jelas
- [ ] Regression: reply CS manusia normal, unread counter, queue banner, analytics page

---

## 9. Rencana Eksekusi (Dory) & Verifikasi (Alita)

- Backend: schema push (additive), service `autoReply.js`, hook baileys, route config
- Frontend: AdminAutoReply.vue + router + nav + bubble badge
- Verifikasi Alita: smoke API (GET/PUT config, validasi), trigger E2E via WA asli
  (minta Kanaka kirim pesan test dari HP di luar jam kerja + reset marker untuk test greeting),
  cek analytics tidak bergeser, cek antrean tidak berubah.
- Estimasi: 1 sesi Dory + QA Kanaka di device nyata.

---
*Spec by Alita, decisions from Kanaka 2026-09-09 (Telegram). Jangan eksekusi sebelum Kanaka approve.*