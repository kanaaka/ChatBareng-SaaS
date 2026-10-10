# Spec v4.6.9 — Auto-reply C+A: outside-hours dapet jalur & marker sendiri (anti-sunyi, kuota terpisah)

**Status:** APPROVED 2026-10-10 09:20 (Kanaka "okee gas" — semua keputusan terkunci §K)
**Parent:** konteks investigasi 8-9 Okt (BITE ME kasus) + spec v4.6.7/v4.6.8 (shipped)
**Origin:** kemarahan pelanggan (BITE ME / chat 11810, tenant-10): 15:32 chat masuk → di-take CS 53 detik + dibalas manual → 16:13 pelanggan kejar (SUDAH luar jam kerja MonFri=16:00) → AUTO GAK JALAN → skip log: "[AutoReply] greeting skip — agent sudah menyapa duluan hari ini: chat=11810" (16:13:20) → pelanggan sunyi total → marah.

---

## K — Keputusan Terkunci (Kanaka 09:16 & 09:20)

1. **C — Human-out skip GAK berlaku buat jalur outside-hours**: gate `hasHumanOutMessageToday` (v3.5) hanya valid di dalam jam kerja (mencegah AR nabrak CS aktif). Di LUAR jam kerja CS sudah off-duty → away-text HARUS keluar walau CS pernah nyapa manual hari itu.
2. **A — Marker & kuota TERPISAH**: outside-hours dapet marker sendiri `lastAutoOutDate` (kolom Chat baru, ADDITIVE — 1 kolom string date); greeting tetap pakai markers existing (`lastAutoGreetDate` claim + `lastMenuShownAt` F4). Jadi "1x masing-masing": greeting pagi + outside sore/tengah-malam di hari yang sama = DUA-DUANYA diizinkan.
3. **Outside = definisi existing** (ikut jam kerja Mon Fri 08:00-16:00 / Sat 08:00-14:00 / Sun 08:00-17:00, `isOutsideHours`) — TANPA window terpisah baru.
4. **Anti-spam tetap:** tiap jalur 1x/hari masing-masing (greeting via claim existing; outside via claim `lastAutoOutDate` baru, pola atomic claim-revert sama persis). CB-AI tetap budget-limit sendiri (TIDAK nyentuh marker — unchanged).
5. **Edge-case diakui (documented, diterima):** pesan masuk dalam-jam (mis. 15:59) yang auto-msg-nya terkirim sesaat setelah jam kerja (16:00+) bisa dapet away text di hari yang sama greeting dipakai — quantum kecil, tercatat di QA doc.

## D1 — Schema (ADDITIVE murni)

```prisma
// model Chat — tambah 1 kolom (setelah lastAutoGreetDate):
lastAutoOutDate String? // v4.6.9 — marker 1x/hari jalur outside-hours (TERPISAH dari greeting)
```
- Migration: prisma `db push --skip-generate` additive + DDL share di docs/SCHEMA-CHANGES.md (feedback IT wajib, pola v4.6.3):
  `ALTER TABLE "Chat" ADD COLUMN "lastAutoOutDate" TEXT;`
- TIDAK ada kolom lain yang berubah; data existing: NULL default.

## D2 — Logic (src/services/autoReply.js — handler maybeAutoReply & sendAutoText)

1. **Geser gate human-out:** blok `if (await hasHumanOutMessageToday(...))` (baris ~782) PINDAH/di-syaratkan: hanya berlaku bila `!outside`. Implementasi minimal:
   - bila `outside == false` → jalur skip existing persis (set greeting marker + return).
   - bila `outside == true` → LEWATI skip human-out → lanjut jalur (a).
2. **Claim terpisah untuk outside:** atomic claim existing (`lastAutoGreetDate`) tetap untuk greeting/menyentuh semua jalur di-dalam-jam. Untuk jalur (a) outside:
   - claim atomic BARU pada `lastAutoOutDate` (same pattern updateMany + OR null + not-today; claim dulu → kirim → gagal kirim → revert marker OUT-nya saja).
   - claim `lastAutoGreetDate` TIDAK dibutuhkan utk jalur outside (marker OUT menggantikan penuh di jalur (a)) — TAPI hati-hati race: greeting jalur menu/text tetap pakai claim lama (TIDAK berubah).
   - `sendAutoText` saat ini mem-null-kan `lastAutoGreetDate` kalau send gagal (revert klaim kita) → perlu parameter mode: `sendAutoText(chat, text, today, { marker: 'out' })` → revert `lastAutoOutDate`; default tetap `lastAutoGreetDate` (greeting/menyapa). Jangan dipecah 2 fungsi (duplikasi logika) — cukup flag.
3. **Jalur (a) baris ~812:** jadi:
   ```js
   if (cfg.outsideHoursEnabled && outside) {
     // v4.6.9 (C+A): claim marker OUT sendiri (bukan lastAutoGreetDate),
     // HUMAN-OUT SKIP TIDak berlaku di luar jam kerja (CS off-duty),
     // kirim away; gagal → revert OUT-nya.
     ... claim lastAutoOutDate (atomic) ...
     const awaySent = await sendAutoText(chat, cfg.outsideHoursText, today, { marker: 'out' })
     return { sent: !!awaySent }
   }
   ```
4. **CB-AI jalur outside** (mode 'cbai'): TIDAK berubah — budget-limit sendiri, tidak pakai marker OUT (tapi juga TIDAK set OUT) — biar CB-AI and outside-text tidak berebut kuota (cbai end-text + away jangan dobel). Jaga: bila outside0 && outsideHoursMode==='cbai' → jalur CB-AI seperti existing, dan setelah CB-AI used=true → TIDAK claim & TIDAK set marker OUT apa pun (biar besok tetap ada kuota away bila mode dimatikan).
5. **Menu Gateway (gateway per-slot) TIDAK berubah.** greet menu/text logic TIDAK berubah. repeatAllows (F4) tidak berubah.
6. **Komentar/JSdoc di semua titik yang diubah** — refer spec ini + invariant baru ("C: human-out hanya di dalam jam kerja").

## D3 — UI/Settings (frontend)

- TIDAK ada setting baru (definisi outside tetap ikut jam kerja).
- Halaman settings auto-reply (AutoReplyConfig panel): catatan tooltip kecil di "Outside Hours" — "Pelanggan tetap dapat pesan outside-hours 1x/hari walau CS sudah membalas manual hari itu" (biar user paham behavior). Render teks statis saja.

## D4 — E2E (scripts/e2e-v469-outside-priority.cjs — copy-DB + port 5099/5063 + WA-off pattern)

1. **Migrasi ADD-ONLY:** kolom lastAutoOutDate muncul; 72+ rows utuh; kolom lama tidak berubah; migrate ulang = no-op.
2. **Kasus BITE ME replika:** chat → pesan masuk di dalam jamkerja (set lastAutoGreetDate via greeting? tanpa greeting on — cukup: human-out) → CS manual balas (insert Message out manual) → jam "16:13" (di luar jamkerja; inject dbTimestamp) → pesan masuk → AWAY TERKIRIM (mock) + lastAutoOutDate=today + lastAutoGreetDate TIDAK berubah.
3. **Anti-spam outside:** pesan lagi (masih luar jam, hari sama) → gak away kedua kalinya (claim OUT blokir) + lastAutoOutDate unchanged.
4. **Greeting 1x + outside 1x di hari sama (pertanyaan KANAKA):** chat baru A: dalam jam → greet text keluar + marker greeting; lalu (inject waktu luar-jam) pesan masuk → away text keluar + marker OUT. DUA-DUANYA keluar di hari sama; kuota terpisah verified.
5. **Kebalikan 4:** outside dulu (malam), lalu pagi dalam jam → greeting keluar (markernya bebas).
6. **Skip human-out di dalam jam tetap:** chat B dalam jam + CS manual balas dulu → pesan masuk → tidak ada auto (skip existing) + marker di-set (unchanged behavior).
7. **AR invariant:** assigned chat tidak di-proses (unchanged); purge/import/analytics/search-all tidak terpengaruh.
8. **CB-AI outside path:** mode cbai + outside → budget path digunakan; away text TIDAK dobel; marker OUT tidak berubah.
9. **Send gagal → revert OUT saja** (marker OUT null-able kembali; pelanggan berhak di pesan berikutnya).
10. **regresi:** e2e-v394/395/396/399 + v4.6.4 log + v4.6.6 clearqueue + v4.6.7 floatzone + v4.6.8 floatzone-v2 = ALL PASS (jumlah sesuai suite; catat di laporan).

## D5 — Versioning & docs & ship

- version.json → **v4.6.9**
- CHANGELOG entri patch-line: "v4.6.9 (auto-reply C+A — outside hours marker terpisah + human-out skip hanya dalam jam kerja)"
- docs/qa-v4.6.9-outside.md (checklist + bukti e2e) + docs/SCHEMA-CHANGES.md (+DDL share)
- commit lokal 1: `feat(v4.6.9): outside reply gets own marker + skips human-out gate (anti-sunyi pasca jam kerja)`
- NO push (Alita yang ship PR #10 pola graft), NO tunnel, NO prod 5047 sentuh (test via copy-DB + port test; WA-off)

## D6 — Acceptance & risiko

- [ ] e2e 10 kasus PASS + regresi SELURUH suite PASS
- [ ] db push additive verified di copy-DB (0 data hilang; kolom lama utuh)
- [ ] appVersion = v4.6.9 di Log Sistem entry baru
- [ ] Laporan: file list + commit + e2e tabel + smoke + deviasi + risiko
- Risiko: (1) race claim OUT vs claim greeting saat pesan masuk mepet jam-kembali — mitigate: atomic updateMany per-marker (independen, no deadlock); (2) behavior change: pelanggan yang sebelum-nya "senyap di luar jam" bakal mulai dapat away-text — ini FEATURE (yang diminta), tapi pastikan teks-nya informatif (config existing tenant per-tenant) — catatan ke Kanaka: cek tenant-10 config outside text-nya (udah ok: "hubungi WA Center..." — informative).