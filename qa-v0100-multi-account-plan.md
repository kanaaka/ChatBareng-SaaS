# QA Multi-Akun Plan — v0.10.0 Empat Fitur (re: lapor Kanaka 16:51 "akun cs1/wahyu sudah dihapus, bikin sendiri 3 admin + banyak pesan dummy")

**Status:** PLAN SIAP — dieksekusi setelah Dory `dory-wacs-v0100-four-features` selesai + verifikasi struktural Alita.
**Prinsip:** QA di DEV (port 5041, copy DB) — produksi 5030 tidak untuk eksperimen. Semua data test bertanda & dibersihkan setelah.

## Akun test (dibuat sendiri via API admin, pass acak, dicatat di /tmp + logs, TIDAK di credentials/)
| Username | Role | Kebutuhan |
|---|---|---|
| qa_admin | admin | view semua, hapus note siapa pun, CSAT config, scheduled all |
| qa_cs1 | cs | CS assigned — kirim chat, note, snooze |
| qa_cs2 | cs | CS kedua — cek note real-time antar CS, permission 403 |
| (opsional) qa_cs3 | cs | stres list |

## Chat dummy pelanggan (inject via script, TIDAK via WA asli)
- Buat via Prisma langsung: `TEST-QA-A@s.whatsapp.net` (banyak pesan, akan di-snooze), `TEST-QA-B@...` (untuk note), `TEST-QA-C@...` (untuk CSAT + scheduled). contactName = "TEST QA A/B/C" (jelas bertanda).
- Pesan masuk = Message direction 'in', senderId null, chat unreadCount jalan. Semua ID diawali `TEST-QA-`.
- Alternatif kalau perlu full Baileys flow: reuse `wa.sendMessage` hanya untuk outbound test di dev (mode sandbox WA_DISABLED tetap dipatuhi).

## Browser multi-sesi (Chrome 18801 CDP — 1 browser, banyak CONTEXT, bukan 1 tab)
- Playwright `browser.newContext()` per akun → cookie/JWT benar-benar terpisah walau satu Chrome.
- Tab/sesi: qa_admin (context A), qa_cs1 (context B), qa_cs2 (context C) — bisa aktif bersamaan untuk uji real-time (note muncul live di context lain).
- Token di-inject via `addInitScript` (localStorage token+user) — tanpa manual login.
- Screenshot per langkah ke `media/qa100-*.png` + audit image (M3 conformance lanjutan).

## Matriks QA (eksekusi berurutan di dev 5041)
1. **Snooze:** qa_cs1 take/assign chat A → snooze 15m → chat hilang dari Mine, muncul di chip "😴 Snoozed" (cek di context qa_admin juga) → inject pesan baru pelanggan A → snooze auto-cancel + unread benar → FIFO/queuedAt nihil berubah (diff DB sebelum/sesudah).
2. **Catatan:** qa_cs1 buka chat B → tulis note → screenshot context qa_cs2 (note muncul real-time tanpa reload) → qa_admin hapus note CS → 403 utk qa_cs2 hapus note orang lain.
3. **CSAT:** enable via qa_admin (message template + {name}) → resolve chat C → pesan survey muncul (isAuto, bukan first-response — cek analytics angka) → inject balasan "5" → rating tersimpan → stats avg/distribusi/per-CS benar. Lalu disable → resolve chat lain → TIDAK ada survey.
4. **Terjadwal:** qa_cs1 jadwalkan +2 menit di chat C → status pending → auto-terkirim tepat waktu (Message isAuto, senderName "{creator} (terjadwal)") → cancel test di chat A → status cancelled, tidak terkirim.
5. **Permission & regresi:** qa_cs2 → 403 semua endpoint admin; autoreply/backup/blast/health tetap normal.
6. **Cleanup:** hapus semua TEST-QA-* (chat, notes, surveys, scheduled, users QA), hapus akun QA, matikan dev 5041 by PID (verifikasi cwd), rebuild-check.

## Output
- Laporan QA per matriks (pass/fail + bukti screenshot + data diff)
- Bug ditemukan → langsung kufix (frontend-only) atau ditandai utk Dory (backend) → re-verify
- Setelah QA hijau + build stabil → deploy prod by PID → QA manual Kanaka (device asli)