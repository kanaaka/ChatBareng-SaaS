# QA — v4.6.7 Float Zone (chat list take-first ordering)

**Fitur:** di list "Mine" milik agent, chat claimed tapi belum pernah di-reply
(`firstResponseAt == null`) tampil PALING ATAS, sort `lastAssignedAt` DESC (secondary
`id` desc untuk determinisme batch). Begitu reply manual pertama (`firstResponseAt`
terisi) → chat **graduate** ke urutan normal existing (`lastMessageAt` desc — logic
existing TIDAK diubah). Spec APPROVED 2026-10-08 09:21:
`docs/spec-v4.6.7-floatzone.md`.

**Metode:** copy-DB (`/tmp/saas-v3-e2e-floatzone.db`) + port 5099 + `WA_DISABLED=1`
(produksi 5047 TIDAK disentuh; server test self-boot dari harness, di-kill di akhir).
Harness: `scripts/e2e-v467-floatzone.cjs` — pola `e2e-clearqueue.cjs`.

## Hasil e2e 10 kasus (§D3) — 39 PASS / 0 FAIL

| # | Kasus (spec §D3) | Hasil | Bukti singkat |
|---|------------------|-------|---------------|
| 1 | Setup tenant+admin+csA+csB+8 chat, AR-off | PASS | queue-count=8; AR config default (outsideHours=false, greetEnabled=false) |
| 2 | csA take 5 → urutan lastAssignedAt desc (tie id desc) | PASS | K2-a..g: list [8583,8582,8581,8580,8579] = urutan take; semua `inFloatZone=true`; queue 8→3 |
| 3 | Reply manual ke 2 → graduate | PASS | firstResponseAt terisi + firstResponseById=csA; zona float tinggal 3; graduate pindah zona normal di bawah |
| 4 | csB izolasi (2 chat lawas: 1 float + 1 normal) | PASS | mine(csB)=[b1-float, b2-normal]; chat csA tidak bocor; csA tidak lihat chat csB |
| 5 | Persist refresh | PASS | GET ulang → urutan identik `[8583,8582,8581,8579,8580]` (state server/kolom DB) |
| 6 | Inbound baru ke chat float → posisi tetap + unread naik | PASS | posisi tetap (index 1→1); unread +1; masih `inFloatZone=true` |
| 7 | Admin "All" normal | PASS | urutan lastMessageAt desc murni; tidak ada zona-float-first |
| 8 | Re-claim (release→take lagi) → naik puncak | PASS | lastAssignedAt baru → chat paling atas zona, masih float (belum dibalas) |
| 9 | Regresi invariant AR + queue-count | PASS | AR config OFF (default) + guard assignedToId≠null (pool.js §4.3); hanya 2 firstResponseAt dari reply manual; queue-count konsisten (8→3→4→0 per aksi) |
| 10 | search-all & analytics sanity | PASS | search-all 200 (csA); analytics admin 200 (plan Max); analytics CS 403 = role-gate BY DESIGN (unchanged, jalur admin yang di-sanity) |

## Regresi e2e lama (copy-DB masing-masing, WA_DISABLED=1)

| Suite | Port | Hasil | Catatan |
|-------|------|-------|---------|
| e2e-v394.cjs | 5099 | 22 PASS / 0 FAIL | sempat 401/404 → kredensial & fixture terpisah (di bawah) |
| e2e-v395.cjs | 5099 | 13 PASS / 0 FAIL | menu-gateway multi-slot |
| e2e-v396.cjs | 5099 | 15 PASS / 0 FAIL | groups multi-slot |
| e2e-v399.cjs | 5099 | 10 PASS / 0 FAIL | fallbackText timeout path; server log di `/tmp/saas_v3_e2e.log` (path yang dibaca script); rerun perlu bersihkan fixture `waJid like 'e2e-%'` di COPY |
| e2e-v470-systemlogs.mjs | 5098 | 59 PASS / 0 FAIL | SystemLog lintas-tenant |
| e2e-clearqueue.cjs (v4.6.6) | 5099 | 56 PASS / 0 FAIL | self-boot copy-DB sendiri (port dibebaskan dulu) |

Bukti mentah: `/tmp/e2e-v467-floatzone-final.txt`, `/tmp/e2e-v39{4,5,6,9}-r467.log`,
`/tmp/e2e-v470-r467.log`, `/tmp/e2e-clearqueue-r467.log`.

**Catatan fixture regresi:** snapshot DB saat ini tidak lagi punya tenant 4 + user 5
(era v3.99) yang di-impersonate e2e lama → dibuat REPLIKA fixture di COPY saja
(tenant 4, plan max, slot 0&1, 2 user, 2 chat) via `/tmp/fixture-t4-regress.cjs`
(transient, TIDAK di-commit). Produksi tidak tersentuh — diverifikasi: prod `tenants
= [8,10,11]` (tanpa tenant 4) sebelum & sesudah seluruh run.

## Smoke (D4)

- Boot copy-DB fresh di port test → `/api/health` 200.
- API mine list: zona float dulu (inFloatZone=true), normal belakang — sesuai §D1.
- Virtual field `inFloatZone` muncul di semua item response (true/false — tidak pernah
  absen), FE chip terikat flag ini.

## Acceptance (D4)

- [x] e2e 10 kasus PASS (39/0) + regresi e2e existing PASS (semua 0 FAIL)
- [x] build frontend sukses (chunk `Dashboard-DuInD-Lg.js` terbit)
- [x] docs/qa-v4.6.7-floatzone.md + CHANGELOG patch line v4.6.7 "(chat list take-first
      ordering)" — tanpa bump struktur (version.json appVersion v4.6.7 sesuai pola release;
      package.json version tidak disentuh)
- [x] commit lokal RAPI 1 commit — NO push (Alita yang ship ke IT via PR)
- [x] NO migration; NO destructive ops; prod 5047 tidak disentuh; server test di-kill
      di akhir tiap run

## Risiko & catatan reviewer

1. **Pagination**: minimal-diff — per zona take 100 (list lama cap 100 total). Untuk
   agent dengan >100 chat Mine, jumlah baris bisa lebih besar dari implementasi lama
   (float≤100 + normal≤100) namun FE tetap cap 100 item render — perilaku paging
   existing (tanpa tombol halaman) tidak berubah; prioritas spec = "0 regresi paging".
2. **Graduate tanpa reload halaman**: posisi baru terlihat setelah refetch list (aksi
   user biasa men-trigger refetch). Tidak ada perubahan socket — by spec (queue
   count/socket tidak disentuh).
3. **Inbound ke chat float** tidak menggeser posisi (spec §K.7 — "biar gak ribet").
4. Chip FE bergantung `chat.inFloatZone` dari server — fallback bila flag absen:
   chip tidak tampil (aman, tidak error).