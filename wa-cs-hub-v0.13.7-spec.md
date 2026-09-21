# WA CS Hub v0.13.7 — Spec: WhatsApp Pairing Dual-Mode (QR + Pairing Code)

> Status: APPROVED (Kanaka 2026-09-12 12:41) → eksekusi via Dory
> Base: v0.13.6 (commit 131fd41). ADDITIVE ONLY — tanpa perubahan schema/migrasi.

## 1. Context

Skenario Kanaka: WA ke-logout saat HP pemilik nomor away dari komputer → scan QR butuh
kamera + kehadiran fisik. WhatsApp menyediakan pairing via nomor: web menampilkan
kode 8 karakter, HP mengetikkannya (Setelan → Perangkat Tertaut → Tautkan perangkat →
**"Tautkan dengan nomor telepon saja"**). Baileys v6.17.16 yang terpasang sudah punya
`sock.requestPairingCode(phoneNumber): Promise<string>` (terverifikasi di
`lib/Socket/index.d.ts`). ChatBareng saat ini hanya jalur QR — fitur ini menambahkan
mode kedua, user memilih.

## 2. UI — Admin → WhatsApp (desktop & mobile)

Saat `waStatus` tidak terhubung (`qrNeeded`/disconnected): dua opsi berdampingan
(toggle/tab M3):
- **"Tambahkan via QR"** (DEFAULT — perilaku existing utuh: gambar QR + Refresh)
- **"Tambahkan via Pairing Code"**:
  - Input nomor HP (digits only, validasi 8–15 digit setelah strip non-digit)
  - Tombol **"Minta Kode"** → POST /api/wa/pairing-code → tampilkan kode besar
    terformat `XXXX-XXXX` (mis. ABCD-1234)
  - Tombol **Copy** (clipboard) + tombol **"Minta ulang"** (re-request — kode lama
    kedaluwarsa, request ulang = kode baru; idempoten dari sisi server)
  - Panduan langkah di HP (4 langkah di §1) + hint: "Kode berlaku singkat —
    minta ulang bila kedaluwarsa"
- Saat WA sudah terhubung: kedua opsi tidak relevan → panel disembunyikan seperti QR
  sekarang.

## 3. Backend

### `src/wa/baileys.js` (additive)
- Export `async function requestPairingCode(phoneNumberNormalized)`:
  - Guards: `sock` ada; **bukan** `connectionState === 'open'` → throw
    `WA_SUDAH_TERHUBUNG` (route jadikan 409); state bukan fase pairing (belum ada
    socket live) → `WA_NOT_READY` (503).
  - Panggil `sock.requestPairingCode(phoneNumberNormalized)` (digits only, tanpa +).
  - Simpan `lastPairingCode` + `issuedAt` (module-level, in-memory — TIDAK persist DB);
    `broadcast.emit('wa_status', { connected:false, qrNeeded:true, pairingCode: code })`
    → UI yang lagi buka langsung live-update.
  - Reset `lastPairingCode = null` saat `connection === 'open'` & saat logout/reset.
- QR flow TIDAK disentuh (regression gate): default opsi tetap QR.

### `src/routes/wa.js` (additive)
- `POST /api/wa/pairing-code` (`requireAuth` + `requireAdmin`):
  - Body `{ phone }` → strip non-digit → validasi 8–15 digit → error 400 ramah.
  - Map error service → 409 (sudah terhubung) / 503 (socket belum siap) dgn pesan
    Indonesia yang jelas.
  - Response `{ code, formatted }` — `formatted` = XXXX-XXXX (grup 4-4).

## 4. Invariant

1. Perilaku QR existing 100% utuh — default tampilan tetap QR (regression gate #1).
2. Tidak ada perubahan schema/DB — kode pairing TIDAK disimpan persist.
3. Kode TIDAK PERNAH dikirim ke pelanggan — hanya admin yang meminta melihat.
4. Pairing code request hanya valid saat logged-out; connected → 409.
5. Semua fitur existing (session persistence, logout, reset, LID resolve) tak tersentuh.

## 5. QA checklist (Kanaka)

1. Default: halaman WhatsApp saat disconnect → tampil QR seperti sebelumnya.
2. Pilih "Pairing Code" → masukkan nomor → kode 8 karakter muncul terformat.
3. Ketik kode di HP (Tautkan dgn nomor) → terhubung; UI pindah ke Connected; opsi
   pairing hilang.
4. Nomor invalid → pesan ramah, tidak crash.
5. Saat sudah terhubung, minta kode via API → 409 ramah.
6. Copy + Minta ulang berfungsi (kode baru).
7. Mobile: dua opsi enak ditap; input + kode tampil wajar.
8. Setelah pairing via kode: kirim pesan dari pelanggan → masuk chat normal (E2E).

## 6. Rollout & rollback

- Backup DB `backup/pre-v0.13.7-<ts>.db` (prosedural).
- Build + restart 5030 (kill PID eksplisit via ss -tlnp, setsid nohup + disown) →
  smoke: health 200, WA Connected, GET /api/wa/qr masih 200.
- Commit + tag v0.13.7 lokal; PUSH DITAHAN sampai QA Kanaka USER-VERIFIED.
- Rollback: git revert commit + rebuild + restart (backend ikut berubah, jadi perlu
  restart — beda dgn v0.13.6 yang frontend-only).