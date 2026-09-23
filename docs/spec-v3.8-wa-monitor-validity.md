# Spec v3.8 — SuperAdmin WA Monitor + Masa Aktif Tenant (Subscription, READ-ONLY enforcement)

> Request owner (Kanaka) 2026-09-23 15:23; enforcement diubah ke READ-ONLY per owner 15:30.
> Basis: v3.7.1 (commit 3317edb). Dua fitur, satu rilis. Schema change ADDITIVE saja (2 kolom).

## §A — Chip WA real-time di daftar tenant SuperAdmin (approved owner)

**Goal:** superadmin monitor status WA per-tenant real-time tanpa masuk akun tenant.

**Backend:** GET `/api/sa/tenants` SUDAH mengembalikan `waStatus: { connected, qrNeeded, state, phoneNumber, disabled }` (superadmin.js L104, dari `wa.getStatusForTenant`) — **tidak ada perubahan backend**.

**Frontend `SuperAdmin.vue` (kartu tenant, sebelah pill active/suspended):**
- `waStatus.disabled` → chip abu "WA off" (sudah ada, keep)
- `connected` → chip hijau (M3 success-container): "WA terhubung"
- `qrNeeded` → chip kuning (tertiary-container): "Menunggu scan QR"
- else → chip abu/netral: "Terputus"
- Nomor WA tetap di baris info (`+{{t.waPhone}}`)

**Realtime:** polling `GET /api/sa/tenants` tiap **15 detik** selama halaman SuperAdmin aktif (silent, in-place update, tanpa loading flicker), `clearInterval` saat unmount + refresh manual tombol yang sudah ada. TANPA socket baru (catat di report sebagai kemungkinan v2).

## §B — Masa aktif tenant (subscription validity)

### Schema (ADDITIVE — backup dulu, lalu `prisma db push` satu kali)
```prisma
model Tenant {
  // ... existing
  validFrom   DateTime? // mulai masa aktif; null = info saja
  validUntil  DateTime? // null = Lifetime (tanpa batas); < now = kedaluwarsa
}
```
- Existing tenants (Parahita, Mazaya) → kedua kolom tetap null = **Lifetime, zero behavior change**.

### Backend
1. `GET /api/sa/tenants` → sertakan `validFrom`, `validUntil`, + computed `validityState`:
   - `expired` (validUntil < now) · `expiring` (sisa ≤ 7 hari) · `active` · `lifetime` (validUntil null) · `not_started` (validFrom > now)
2. `PUT /api/sa/tenants/:id/validity` (super_admin only) — body:
   `{ preset: '30d'|'1y'|'lifetime'|'custom', startDate?: ISO, endDate?: ISO }`
   - `lifetime` → `validUntil = null` (validFrom boleh diset utk catatan)
   - `30d` / `1y` → `validFrom = startDate || now`, `validUntil = validFrom + durasi`
   - `custom` → wajib `endDate > startDate` (validasi 400 kalau tidak)
   - Response: nilai final + computed state.
3. **Enforcement = READ-ONLY MODE (keputusan owner 15:30 — JANGAN hard-lockout):**
   - Tenant expired TETAP BISA login & melihat tampilan awal (Dashboard). Yang diblokir: SEMUA aksi tulis.
   - **Backend (sumber kebenaran):** middleware `requireActiveSubscription` — diterapkan ke semua route tenant NON-GET (POST/PUT/PATCH/DELETE): kirim/reply pesan, scheduled, blast, template, tag, note, snooze, transfer/resolve/release, autoreply config, appearance, purge, csat, gdrive, wa actions (reconnect/pairing via app) → `403 { error: 'Masa aktif tenant habis. Perbarui langganan untuk menggunakan kembali.', code: 'SUBSCRIPTION_EXPIRED' }` (variant `SUBSCRIPTION_NOT_STARTED` utk validFrom future). **GET/read tetap dibuka** (lihat chat, kontak, statistik, export).
     - Super_admin via impersonate TIDAK kena (superadmin harus tetap bisa memperbarui validity & memakai app utk support tenant).
   - **Low-level send guard** (pool.js send path): block SEMUA pengiriman outgoing — termasuk scheduler & auto-reply (greeting/CSAT) — bila expired. Tidak boleh ada pesan keluar atas nama tenant expired. Incoming WA tetap diterima & tampil (read-only).
   - **/api/auth/me** → sertakan `subscription: { state, validFrom, validUntil }` — frontend pakai utk banner & route guard.
   - **Suspend manual tetap lebih kuat** (suspended = gak bisa login sama sekali, JANGAN auto-un-suspend oleh masa aktif).
   - **Logout** selalu dibolehkan (bukan bagian dari blok tulis).

### Frontend tenant (Dashboard)
- **Banner persistent** di tampilan awal (gak bisa di-close) bila `subscription.state` = expired / not_started:
  - expired: **"Masa berlaku akun habis — Perbarui Langganan untuk menggunakan"**
  - not_started: "Masa aktif dimulai <tanggal> — silakan kembali kemudian"
- **Route guard:** navigasi ke menu apapun selain tampilan awal DIBLOKIR (redirect balik + banner tetap); tombol kirim/reply disabled; **Logout tetap jalan**.
- Aksi tulis yang nyasar ke API langsung → 403 dari middleware → toast error.

### Frontend SuperAdmin
- Kartu tenant: chip masa aktif — "Lifetime" netral · "s/d 23 Okt 2026" hijau · "⏰ 3 hari lagi" kuning · "Kedaluwarsa 20 Sep" merah (dari validityState).
- Modal "Masa Aktif" (tombol baru di kartu): 4 preset (Lifetime / 30 Hari / 1 Tahun / Custom) + **Date start** (default: hari ini WIB; bisa backdate/future) + preview tanggal selesai → Simpan.

### QA (tenant dummy via SA API, self-purge di akhir)
1. Buat tenant QA → default = lifetime (chip netral) → login OK, semua fitur normal
2. Set `30d` start hari ini → chip hijau s/d +30d → login OK, write OK
3. Set custom `endDate` kemarin → LOGIN MASIH LOLOS (read-only, gak ditolak), banner persistent muncul, send reply DITOLAK 403 SUBSCRIPTION_EXPIRED, menu lain gak bisa dibuka (route guard), logout jalan, scheduler/auto-reply gak mengirim apa pun
4. Perpanjang (custom masa depan) → banner hilang, write OK lagi, chip kembali
5. `startDate` di masa depan → banner "belum dimulai", write ditolak, read tetap jalan
6. Regression: Suspend/Activate lama tetap jalan (suspended = gak bisa login, level lebih tinggi dari read-only); existing tenant null = Lifetime tak berubah

### Constraints (WAJIB)
- 🚫 NEVER `--force-reset` / `--accept-data-loss` / DROP / rm DB. `db push` ADDITIVE kolom saja, **backup DB dulu** (`cp prisma/data/saas-v3.db → backup ber-timestamp`) sebelum push, verify counts tenant/user tidak berubah.
- NO git commit (review Alita). Server fisio 8770 & portable instance jangan disentuh; 5030 mati.
- Restart app 5047 by-PID 1x setelah schema push + generate (backend berubah). Health 200 + WA t4/t8 reconnect sebelum lapor.
- Report: `docs/report-v3.8.md` + ringkas di reply final.