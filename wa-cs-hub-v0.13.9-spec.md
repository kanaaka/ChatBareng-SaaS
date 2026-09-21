# WA CS Hub — v0.13.9 Spec: Pairing Code Reliability Fix

> **Tanggal:** 2026-09-15
> **Author spec:** Alita (operator) — implementasi: Dory
> **Status:** APPROVED by Kanaka (Telegram 2026-09-15 11:20 "boleeh kamu tulis aja")
> **Prioritas:** Medium (produksi aman via QR, tapi pairing code harus jadi backup yang reliable)

---

## 1. Latar Belakang & Root Cause (bukti log, bukan tebakan)

### Gejala
Login via **Pairing Code** selalu gagal di HP: *"Coba masukan kode lagi atau dapatkan kode baru dari perangkat"*.
Login via **QR** selalu berhasil. Terjadi konsisten: 12 Sep (4x kode), 13 Sep (5x), 15 Sep (2x) — 0 berhasil.

### Bukti dari `/tmp/wa-cs-hub.log` + `data/wa-session*/creds.json`
1. **408 reconnect loop**: socket unpaired mati + reconnect tiap ±5–6 detik, BERULANG selama berhari-hari (1.465 event 408 di log; loop mulai di baris 6 log = sejak boot, SEBELUM ada request pairing code).
2. **Pairing code di-bind ke socket yang meng-issue-nya.** Saat socket 408 & reconnect, `pairingEphemeralKeyPair` baru dibuat → kode lama hangus di sisi server WA. Dengan umur socket ±5–11 detik, kode mati SEBELUM user selesai mengetik 8 karakter di HP.
3. **Sisa kode di creds backup**: `XSW9PHHR` (stale-20260912) & `8JYRTXWL` (dead-1348) — kode di-issue, pairing tak pernah selesai. `registered: false` di semuanya.
4. **12 Sep 20:55**: request pairing pertama diikuti `statusCode: undefined` → `401` → sesi ke-bersihkan total (pairing di atas sesi zombie = mematikan).
5. **QR berhasil** (15 Sep 10:11) karena scan QR selesai dalam 2–3 detik — muat dalam umur socket satu siklus. Kode pairing (15–30 detik mengetik) tidak muat.

### Kandidat akar masalah 408 loop (urut prioritas investigasi)
- **[K-1] Socket lama tidak di-end saat close-408.** Handler `connection.update` → `close` dengan `shouldReconnect=true` hanya set `reconnectTimeoutId`; socket lama TIDAK di-`end()` (bandingkan: `reconnect()` manual SELALU `sock.end()` dulu). Dugaan: socket setengah-hidup menumpuk → WA menolak/throttle koneksi pre-auth baru → 408 terus.
- **[K-2] Kredensial pre-auth rusak** (noise keys basi dari sesi gagal) — namun loop berlanjut bahkan setelah `clearSessionDir()` penuh (12–13 Sep), jadi ini kandidat lemah.
- **[K-3] Upstream Baileys 6.17.16** — ada known issues seputar pairing code (issue #2770 double-request; PR #2768 browser canonical — sudah diatasi v0.13.8b).

---

## 2. Lingkaran Masalah (scope)

**IN scope:**
- Perilaku reconnect/close pada state unpaired (baileys.js)
- Lifecycle pairing code: server state, cooldown, auto re-issue
- UI admin WhatsApp: AdminWhatsApp.vue (mode Pairing Code)
- Logging diagnostik koneksi WA
- Evaluasi upgrade Baileys (terpisah, opsional, non-breaking)

**OUT of scope (JANGAN disentuh):**
- ❌ Schema DB / prisma — **TIDAK ADA perubahan DB sama sekali di versi ini**
- ❌ Menu Gateway, AutoReply, Queue, CSAT, scheduler — jangan tersentuh
- ❌ QR flow yang sudah jalan — regression risk = NOL ditoleransi
- ❌ Logout/disconnect WA produksi — hub SEDANG LIVE (terhubung via QR 15 Sep 10:11, nomor 62881080702624:7). **DILARANG logout, reconnect, atau restart server tanpa koordinasi dengan Kanaka.**

---

## 3. Perubahan Backend — `src/wa/baileys.js`

### 3.1 [FIX UTAMA — K-1] Defensive socket cleanup saat close
Di handler `connection.update` → `connection === 'close'`, SEBELUM menjadwalkan reconnect:
```js
// v0.13.9 — end socket lama secara eksplisit sebelum reconnect terjadwal.
// Dulu: 408 loop → reconnect timeout → connectToWhatsApp() bikin socket BARU
// tanpa meng-end socket lama (berbeda dgn reconnect() manual yang selalu end()).
// Socket setengah-hidup menumpuk → WA throttle koneksi pre-auth → 408 terus.
try {
  if (sock) {
    sock.ev.removeAllListeners('connection.update')
    sock.ev.removeAllListeners('creds.update')
    sock.ev.removeAllListeners('messages.upsert')
    sock.ev.removeAllListeners('messages.update')
    try { sock.end(new Error('v0.13.9 cleanup before reconnect')) } catch {}
    sock = null
  }
} catch (e) { /* non-fatal */ }
```
⚠️ Hati-hati race condition dengan `isConnecting` dan handler lain yang memakai variabel `sock` — pastikan urutan aman: capture referensi socket lama ke variabel lokal dulu, end itu, baru schedule reconnect. JANGAN meng-end socket yang justru sedang dipakai proses pairing.

### 3.2 Logging diagnostik (Phase A — selalu aktif, murah)
- **Timestamp di SEMUA log `[WA]`** — sekarang log tidak bertimestamp, menyulitkan forensik. Format: `[WA 2026-09-15T10:02:00+07:00]` (WIB). Implementasi: helper `waLog(...)` yang wrap console.log, atau prefix manual. Terapkan minimal pada: connect/close/reconnect/qr/pairing.
- **Durasi koneksi**: catat `socketCreatedAt` per socket; saat close, log umur socket: `[WA] Connection closed, statusCode: 408, socketAge: 6.2s, instance: #47`.
- **Detail error Boom** saat close: log `lastDisconnect?.error?.message` dan `output.payload` (dipotong 200 char) — bukan cuma statusCode.
- **Counter instance socket** `socketInstanceCount` (increment tiap makeWASocket) — biar kelihatan kalau socket menumpuk.
- **QR issued log**: handler `qr` saat ini tidak log ke console → tambahkan `[WA] QR issued (instance #N)` supaya kelihatan apakah tiap siklus 408 sempat mengeluarkan QR.

### 3.3 Pairing pending + auto re-issue
State baru (in-memory, reset saat logout/open):
```js
let pairingPending = false          // true sejak kode di-issue sampai open/expiry
let pairingPendingSince = null      // ISO timestamp
const PAIRING_PENDING_TTL_MS = 5 * 60 * 1000   // hangus setelah 5 menit
const PAIRING_REISSUE_MAX = 20                 // batas re-issue per sesi pairing
let pairingReissueCount = 0
```
Perilaku:
1. `requestPairingCode()` sukses → `pairingPending = true`, `pairingPendingSince = now`, reset `pairingReissueCount = 0`.
2. Di handler `connection.update`:
   - `connection === 'open'` → `pairingPending = false` (pairing selesai / QR masuk).
   - `connection === 'close'` dengan `pairingPending === true` dan TTL belum lewat dan `pairingReissueCount < MAX` → saat socket baru mencapai state `'connecting'` (atau `'qr'`), **otomatis re-issue pairing code** ke nomor yang sama, +1 ke `pairingReissueCount`, broadcast kode baru via `wa_status` (field baru: `pairingCode`, `pairingIssuedAt`, `pairingInvalidated: false`). Delay re-issue: 1.5 detik setelah state connecting (beri handshake settle).
   - TTL lewat / MAX tercapai → `pairingPending = false` + broadcast `{ pairingPending: false, pairingInvalidated: true }`.
3. **Cooldown jadi per-socket-instance**: saat `connectToWhatsApp()` membuat socket baru → `lastPairingCodeIssuedAt = null` (cooldown 60s lama adalah guard anti double-request pada socket yang SAMA — risiko #2770 tidak ada antar-socket). Tambahkan gap minimum 5 detik antar re-issue di dalam logika auto-reissue.
4. Jika 408 loop terdeteksi aktif (≥3 close tanpa `open` dalam 60 dtk — lacak via array timestamp close) → log warning sekali: `[WA] 408 loop detected — pairing code akan sering berganti; pertimbangkan QR`.

### 3.4 Guard `WA_NOT_READY` diperlunak (kecil)
Saat auto-reissue, state bisa sempat `'close'` — retry max 3x dengan jarak 2 dtk sebelum menyerah (dan biarkan siklus reconnect berikutnya mencoba lagi). Jangan ubah perilaku endpoint manual.

---

## 4. Perubahan Frontend — `frontend/src/views/AdminWhatsApp.vue`

Mode QR: **JANGAN diubah sama sekali.** Semua di mode Pairing Code saja.

1. **Countdown masa berlaku kode**: pakai `pairingIssuedAt` dari `wa_status`; tampil "Kode aktif — Xs" (dihitung dari TTL 90 detik tampilan; server TTL 5 menit, UI menampilkan 90 dtk terakhir sebagai urgensi. Simpel: UI countdown dari momen kode diterima, 90 dtk, habis → tampil "Kode kemungkinan hangus — minta ulang").
2. **Kode auto-update**: saat broadcast `wa_status` membawa `pairingCode` baru (hasil auto re-issue), **langsung ganti kode yang tampil** (tanpa reload), reset countdown, tampilkan micro-toast "Kode diperbarui otomatis".
3. **Banner invalidation**: jika `pairingInvalidated: true` → banner kuning "Sesi pairing berakhir — klik Minta Kode untuk mulai lagi" + tombol minta kode tetap tersedia.
4. **Info jujur**: jika re-issue terdeteksi ≥3x dalam 1 menit, tampilkan hint abu-abu: "Koneksi pairing sedang tidak stabil (kode sering berganti). QR lebih andal saat ini." — jangan sembunyikan QR.
5. Simpan perilaku copy + cooldown tombol seperti sekarang, tapi cooldown client-side mengikuti kode terbaru (bukan menahan tampilan kode baru).

---

## 5. Evaluasi Upgrade Baileys (terpisah — boleh skip jika berisiko)

- Current: `@whiskeysockets/baileys 6.17.16`.
- Cek versi terbaru + changelog terkait: pairing code, 408/timed out, reconnect.
- ATURAN: hanya upgrade PATCH/MINOR non-breaking. Kalau butuh major atau ada breaking change → STOP, tulis temuan di laporan, jangan upgrade.
- Kalau upgrade dilakukan: build + smoke test login QR di **session dir terpisah** (bukan data/wa-session produksi!). Contoh: salin kode ke folder temp, jalankan dengan `WA_SESSION_DIR=/tmp/wa-test-session node -e "..."` skrip kecil yang hanya connect & disconnect.

---

## 6. Constraint KERAS (dari lessons-learned — PELANGGARAN = GAGAL)

1. **NEVER** `--force-reset`, `--accept-data-loss`, `DROP`, `rm -rf` pada DB apapun. Versi ini TIDAK menyentuh DB sama sekali.
2. **NEVER** logout/reconnect/disconnect WA produksi (`data/wa-session` — sedang LIVE). Jangan jalankan server di port 5030 untuk test — pakai port bebas (mis. 5999) + session dir /tmp kalau perlu smoke test.
3. **NEVER** restart `node src/server.js` produksi (PID jangan disentuh). Deploy = tahap terpisah yang dikoordinasikan Alita + Kanaka.
4. Jangan ubah file di luar: `src/wa/baileys.js`, `frontend/src/views/AdminWhatsApp.vue`, `CHANGELOG.md`, `package.json` (hanya jika upgrade Baileys disetujui aman).
5. Frontend build wajib lolos: `cd frontend && npm run build` tanpa error. Backend wajib lolos `node --check src/wa/baileys.js`.

---

## 7. Acceptance Criteria

| # | Kriteria | Cara verifikasi |
|---|---|---|
| 1 | Socket lama di-end + listeners dibersihkan sebelum reconnect (close path) | code review + log `instance` menunjukkan cleanup |
| 2 | Semua log `[WA]` bertimestamp WIB + socketAge saat close | grep log setelah smoke test |
| 3 | Pairing code auto re-issue saat socket cycle saat pairingPending | smoke test di session dir /tmp: simulate close → kode baru ter-broadcast |
| 4 | Cooldown reset per socket instance; max 20 re-issue + TTL 5 menit | code review + unit log |
| 5 | UI: countdown, auto-update kode, banner invalidation, hint QR | build sukses + screenshot halaman admin (mode pairing) |
| 6 | QR flow tidak berubah perilaku | code review — diff frontend hanya di blok Pairing Code |
| 7 | Build frontend + syntax check backend lolos | command output |

---

## 8. Rencana Verifikasi E2E (TERPISAH — butuh Kanaka)

Setelah deploy (koordinasi Alita + Kanaka, WA produksi sengaja di-disconnect di jam sepi):
1. Logout → status Disconnected → minta kode pairing di UI admin.
2. Ketik kode di HP dalam ≤30 dtk → HARUS terhubung.
3. Skenario lambat (biarkan kode hangus) → UI harus auto re-issue + tetap bisa pairing dengan kode terbaru.
4. Hasil dicatat di CHANGELOG + memory.

---

## 9. CHANGELOG entry (draft — Dory tulis final)

```
## v0.13.9 — Pairing Code Reliability Fix (2026-09-15)
- FIX: socket lama kini di-end() + listeners dibersihkan sebelum reconnect (408 loop — root cause kandidat utama)
- ADD: timestamp WIB + socketAge + instance counter di log [WA]
- ADD: pairing pending lifecycle — auto re-issue kode saat socket cycle (TTL 5 mnt, max 20x, cooldown per-socket)
- UI: countdown masa berlaku kode, auto-update kode tanpa reload, banner invalidation, hint QR
- QR flow: tidak berubah
```