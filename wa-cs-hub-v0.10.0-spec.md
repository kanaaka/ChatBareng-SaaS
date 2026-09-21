# WA CS Hub — v0.10.0 Spec: Snooze + CSAT + Catatan Internal + Pesan Terjadwal

**Status:** ✅ APPROVED Kanaka ("sekarang dong, tambahin empat fitur itu", 2026-09-09 16:41) — eksekusi: Dory (dev) + Alita (verifikasi & deploy)
**Penulis spec:** Alita | **Tanggal:** 2026-09-09
**Konteks:** 4 fitur disetujui Kanaka (ide dari Alita, "ide yang bagus semua"). Design slots sudah disiapkan oleh revamp v0.9.0 (kebab menu, panel kanan, analytics tab).

---

## 0. Prinsip Bersama (berlaku untuk semua 4 fitur)

- Semua model **additive only** — zero data loss, backup + md5 sebelum schema push.
- **Tidak menyentuh** logika antrean (take-next/FIFO), first-response analytics, autoreply v0.7.0, backup v0.8.0 — kecuali titik hook yang ditentukan eksplisit di bawah.
- Waktu = **WIB eksplisit** (pola `wibDateString` v0.7.0). Scheduler = **in-process interval** (pola gdriveBackup v0.8.0), BUKAN cron eksternal.
- Personalisasi `{name}` = pola blast (kosong → placeholder dihapus + bersihkan spasi/koma menggantung).
- Pesan otomatis/terjadwal tersimpan dengan `isAuto: true` / flag setara → tidak dihitung first-response CS manusia (konsisten v0.7.0).
- Komponen UI memakai **design system M3 v0.9.0** (M3TextField, M3Dialog, M3Switch, chip, dsb.) — bukan styling ad-hoc.
- **Guardrails deploy standar** (sama seperti v0.7.0–v0.9.0): prod 5030 jangan disentuh Dory, dev-test 5041 by PID, no git, no pkill, post-verify wajib.

---

## 1. FITUR A — Snooze Chat

**Tujuan:** CS/admin bisa "tunda" chat tertentu supaya keluar dari fokus sementara, lalu otomatis kembali.

### Data model (additive)
```prisma
// Chat — tambah 2 kolom:
snoozedUntil   DateTime?   // null = tidak snooze
snoozedBy      Int?        // userId pen-snooze
```

### Logika
- Akses: **assigned CS + admin** (konsisten permission transfer/release).
- UI: kebab menu (⋮) di chat detail → item baru **"😴 Snooze"** di atas Transfer.
- Preset waktu (chip dialog M3): `15 menit` · `1 jam` · `3 jam` · `Besok 08:00` · **Custom** (datetime picker, Flatpickr sudah ada di stack).
- Saat snooze aktif:
  - Chat **hilang dari list utama** (Mine/Unassigned/All/Resolved) — muncul di **chip filter khusus "😴 Snoozed"** di FilterChips (muncul hanya kalau ada isinya).
  - Header chat detail (kalau sedang dibuka) menampilkan badge "😴 Kembali 17:15".
  - `queuedAt`/assignment/urutan FIFO **tidak berubah** — snooze hanya filter tampilan + timer.
- **Timer in-process** (loop menit WIB, gabung dengan scheduler existing): saat `snoozedUntil <= now` → kosongkan kolom → broadcast `chat_update` + toast ke user terkait "😴 Chat {contactName} kembali dari snooze".
- Chat kembali muncul di list sesuai state assignment-nya (assigned tetap di Mine pemilik; belum assigned tetap di antrean).
- Kalau pelanggan kirim pesan BARU saat chat di-snooze → **snooze auto-canceled** (chat langsung balik muncul + unread jalan) — pesan pelanggan tidak boleh tersembunyi.
- Resolve chat yang sedang snooze → snooze ikut dibersihkan.

### API
- `POST /api/chats/:id/snooze` { until: ISO } (assigned CS/admin)
- `DELETE /api/chats/:id/snooze` (cancel manual)
- List view: server filter `snoozedUntil > now` → exclude dari list utama; endpoint `GET /api/chats?snoozed=1` untuk tab snoozed.

---

## 2. FITUR B — Catatan Internal per Chat

**Tujuan:** CS & admin menitipkan catatan konteks di sebuah chat (riwayat, janji, karakter pelanggan) — **shared** (terlihat semua CS/admin yang berpartisipasi), bukan private.

### Data model (additive)
```prisma
model ChatNote {
  id        Int      @id @default(autoincrement())
  chatId    String
  chat      Chat     @relation(fields: [chatId], references: [id])
  userId    Int
  user      User     @relation(fields: [userId], references: [id])
  body      String
  createdAt DateTime @default(now())
}
```

### Logika & UI
- Siapa boleh nulis: CS assigned + admin (sama dengan reply permission). Semua catatan **terlihat oleh admin & CS yang pegang chat** (shared).
- UI: **tab/section "📝 Catatan"** di panel kanan chat detail (desktop: dalam area chat detail; mobile: di atas composer sebagai section collapsible). List notes urut terbaru di bawah + input tambah (M3TextField multiline, tombol simpan).
- Tampilan note = kartu kecil M3 (surface-variant) dengan nama penulis + waktu + isi. **Delete** hanya oleh penulis sendiri atau admin.
- Real-time: socket event `note_added` / `note_deleted` (pola broadcast existing) — semua viewer chat yang sama update live.
- Notes **TIDAK dikirim ke pelanggan** — murni internal (tanpa panggilan sendMessage).
- Search note sederhana: filter dari search box existing (opsional, boleh skip v1).
- Batas: body ≤ 2000 char; rate 1 note / 5 detik / user (anti spam klik).

### API
- `GET /api/chats/:id/notes` (assigned CS/admin)
- `POST /api/chats/:id/notes` { body }
- `DELETE /api/chats/notes/:noteId` (penulis/admin)

---

## 3. FITUR C — CSAT (Customer Satisfaction Rating)

**Tujuan:** setelah chat di-resolve, pelanggan otomatis dapat pesan survey rating 1–5; hasil masuk dashboard analytics. **Default OFF** (toggle admin) — karena mengirim pesan ke pelanggan asli.

### Data model (additive)
```prisma
model CsatSurvey {
  id          Int       @id @default(autoincrement())
  chatId      String
  chat        Chat      @relation(fields: [chatId], references: [id])
  token       String    @unique       // token unik utk parse balasan
  sentAt      DateTime?
  rating      Int?                    // 1–5
  respondedAt DateTime?
  createdById Int                       // CS yang resolve
}

// AppearanceConfig-style singleton:
model CsatConfig {
  id        Int     @id @default(1)
  enabled   Boolean @default(false)
  message   String  @default("Halo {name}! Terima kasih sudah menghubungi kami 🙏 Bagaimana pengalaman Anda hari ini? Balas dengan angka 1–5 (1 = kurang, 5 = sangat puas).")
}
```

### Logika
- **Trigger:** `handleResolve` sukses + `CsatConfig.enabled` + chat punya nomor pelanggan → buat CsatSurvey (token unik) → kirim via `sendMessage` (pola autoReply v0.7.0, `isAuto: true`, `senderId: null`, tanpa menyentuh firstResponse). `sentAt` terisi.
- **Parse balasan:** hook `messages.upsert` (inbound) — jika chat punya CsatSurvey dengan `rating = null` dan isi pesan = **angka 1–5** (terima juga "⭐" tunggal = 1; variasi ⭐⭐⭐⭐⭐ = 5) → simpan rating + `respondedAt`, broadcast `csat_updated`. Pesan pelanggan tetap tampil normal di chat (transparan).
- **Anti-spam:** 1 survey per event resolve; jika chat reopen → resolve lagi → survey baru dibuat (yang lama tetap tersimpan sebagai riwayat; dashboard pakai yang terrespond terakhir per chat).
- Kalau pelanggan balas selain angka → diabaikan (bukan rating), survey tetap pending sampai 7 hari (bisa di-expire lewat scheduler, opsional).
- Pesan survey memakai template text yang **diedit admin** (textarea di admin, maks 1000 char, support `{name}`).

### UI & Analytics
- Admin: kartu **"⭐ CSAT Survey"** (toggle ON/OFF + editor pesan + preview {name}) — taruh di Admin page (nav item baru atau section di AdminAutoReply-style page terpisah `/admin/csat`).
- Analytics: tab/section **"⭐ CSAT"** di halaman Analytics — rata-rata rating, distribusi 1–5, jumlah respons vs survey terkirim, rata-rata per-CS (join resolvedById). Endpoint admin-only.
- Badge kecil di chat detail: rating pelanggan terakhir (kalau ada) — "⭐ 5".

### API
- `GET/PUT /api/csat/config` (admin) · `GET /api/csat/stats?from=&to=` (admin) · `GET /api/csat/list` (admin, riwayat)

---

## 4. FITUR D — Pesan Terjadwal

**Tujuan:** CS menulis pesan sekarang, dikirim otomatis di waktu tertentu (mis. reminder pelanggan besok pagi). Bisa dibatalkan sebelum terkirim.

### Data model (additive)
```prisma
model ScheduledMessage {
  id          Int       @id @default(autoincrement())
  chatId      String
  chat        Chat      @relation(fields: [chatId], references: [id])
  createdById Int
  user        User      @relation(fields: [createdById], references: [id])
  body        String
  scheduledAt DateTime                  // WIB
  status      String    @default("pending") // pending | sent | cancelled | error
  sentAt      DateTime?
  error       String?
}
```

### Logika
- **Compose:** di composer chat — tombol ikon **⏰** di samping tombol kirim → M3 dialog: textarea pesan (prefill dari draft reply) + datetime picker (Flatpickr, WIB) + tombol **"Jadwalkan"**. Validasi: `scheduledAt > now + 2 menit`, body ≤ 4000 char.
- **Scheduler in-process** (loop menit WIB, gabung scheduler existing): ambil `status=pending AND scheduledAt <= now` → kirim via `sendMessage` → status `sent` + `sentAt`. Pesan tersimpan di Message dengan `senderId: null, senderName: '{creator} (terjadwal)'`, `isAuto: true` (tidak dihitung first-response) — plus broadcast `new_message` (chat & list update realtime).
- **Gagal kirim** → status `error` + pesan error, toast ke creator.
- **Cancel:** pemilik ATAU admin bisa batalkan selama status pending (`POST /api/scheduled/:id/cancel`).
- **Chat di-resolve/transfer** → pesan tetap terkirim sesuai jadwal (v1, KISS — catat di report).
- **List:** panel "⏰ Terjadwal" — di chat detail (section collapsible seperti Catatan) menampilkan pesan pending chat itu (pemilik/admin bisa cancel); admin punya view semua di Admin page (opsional, boleh v2).
- CS hanya melihat/membatalkan miliknya + admin semua. Personalisasi `{name}` jalan saat pengiriman.

### API
- `POST /api/scheduled` { chatId, body, scheduledAt } · `GET /api/scheduled?chatId=` · `POST /api/scheduled/:id/cancel` · `GET /api/scheduled/all` (admin)

---

## 5. Non-goals (explicit)

- Tidak mengubah take-next/FIFO/release/resolve logic (kecuali hook resolve → CSAT yang ditentukan)
- Tidak ada template survey bergambar/NPS header v1 — teks + angka saja
- Tidak ada edit catatan (append + delete saja) — edit di v2
- Tidak ada recurring scheduled message (sekali kirim)
- Tidak ada notifikasi push khusus untuk note/snooze (cukup in-app toast + badge)

## 6. Acceptance Criteria

- [ ] Snooze 15 menit → chat hilang dari list utama, muncul di chip "😴 Snoozed", balik otomatis tepat waktu + toast
- [ ] Pesan pelanggan saat snooze → snooze auto-cancel, chat langsung muncul, unread benar
- [ ] Snooze tidak mengubah queuedAt/assignment; FIFO tetap
- [ ] Catatan: CS assigned tambah note → CS lain & admin lihat real-time; pelanggan TIDAK menerima apa pun; delete hanya penulis/admin
- [ ] CSAT ON + resolve → pelanggan terima pesan survey (isAuto, bukan first-response); balas "5" → rating tersimpan + muncul di analytics; balas teks biasa → diabaikan
- [ ] CSAT OFF (default) → resolve TIDAK mengirim apa pun
- [ ] Pesan terjadwal: jadwal +2 menit → terkirim otomatis, muncul di chat + status sent; cancel sebelum jadwal → tidak terkirim
- [ ] Pesan terjadwal isAuto (tidak dihitung first-response), personalisasi {name} jalan
- [ ] Semua endpoint non-admin terlindungi (CS bukan pemilik → 403)
- [ ] Restart server → scheduler jalan lagi, tidak ada kirim dobel; snooze/notes/scheduled persist
- [ ] Regression: autoreply, backup, blast, analytics angka lama, chat flow normal
- [ ] Mobile: semua UI baru responsif (M3 pola v0.9.x, touch target ≥44px)

## 7. Rencana Eksekusi (Dory) & Verifikasi (Alita)

- Estimasi: 1 sesi Dory besar (4 fitur) — kalau timeout lane, lanjutkan berdasarkan artefak di disk (bukan mulai ulang).
- Verifikasi Alita: struktur (schema additive, routes, bundle), smoke API per fitur, runtime Chrome (snooze chip, note real-time antar 2 sesi, dialog jadwal), analytics tidak bergeser, antrean utuh.
- Deploy: restart by PID (verifikasi cwd!), config default (CSAT OFF), lalu QA Kanaka.
- Setelah user-verified: changelog + commit + push GitHub (batch dengan v0.9.2 yang masih pending).

---
*Spec by Alita, dari request Kanaka 2026-09-09 16:41. Detail keputusan mikro diambil Alita (ditandai); Kanaka bisa veto kapan pun sebelum/ sesuai QA.*