# QA — v4.6.6 Admin Clear Queue

Spec: `docs/spec-v4.6.6-clear-queue.md` (APPROVED 2026-10-06)
Tanggal QA: 2026-10-06 · Jalur: **copy-DB** `file:/tmp/saas-v3-e2e-clearqueue.db` + port **5099** + `WA_DISABLED=1` — produksi (port 5047) TIDAK tersentuh.

## Acceptance checklist (spec §C)

- [x] e2e 11 kasus PASS — `scripts/e2e-clearqueue.cjs`: **56 PASS / 0 FAIL** (5.1s)
- [~] UI button + modal + count live + post-clear refresh — DITERAPKAN (komponen `ClearQueueDialog.vue`, tombol di banner antrean Dashboard hanya role admin; refresh list+count via refetch eksplisit + socket `queue_update` natif; remaining>0 → modal tetap terbuka). Verifikasi saat QA: `vite build` sukses (bukti syntax/dependency) + inspeksi kode; **browsertime dev belum dijalankan** — wajib dicek reviewer di dev browser sebelum merge PR.
- [x] CHANGELOG entri v4.6.6 "(admin clear queue)" — penambahan patch line, TANPA bump major/minor, package.json & version.json tidak diubah
- [x] commit local (NO push — ship via Alita: PR ke IT, pola PR #5/#6)
- [x] Catatan PR body: NO schema/migration; CSAT sengaja TIDAK dipanggil (spec §A1) — disebut eksplisit

## Bukti e2e (ringkas per kasus — full output pasca commit)

| # | Kasus (spec §B) | Hasil | Bukti inti |
|---|---|---|---|
| 1 | Setup tenant+admin+CS+30 chat antrean | PASS | `S0-f queue-count=30`; fixture: 27 polos + 3 snoozed; 3 awaiting (limbo §4.1) sbg fixture invarian; grup + exclude-tag fixture |
| 2 | POST tanpa confirm → 400 | PASS | `K2-a/b/c` (tanpa confirm / false / string) semuanya 400 + `K2-d` antrean tetap 30 |
| 3 | POST confirm (role cs) → 403 | PASS | `K3-a` 403 "Admin access required" + `K3-b` antrean tetap 30 |
| 4 | POST confirm (admin) → cleared=30 | PASS | `K4-b` 30/[]/0; `K4-c/d/e` semua resolved+assignedToId=admin+resolvedAt; `K4-f/g` messagesBeforeResolve=csMessagesSent |
| 5 | Safety net snooze/limbo | PASS | `K5-c/d` snoozedUntil+snoozedBy null; `K5-a/b` fixture awaiting (LUAR antrean) tidak tersentuh — invariant §4.1 |
| 6 | Queue count pasca = 0 | PASS | `K6-a` queue-count=0 + `K6-b` paritas via `queueWhere` (SATU SUMBER KEBENARAN) = 0 |
| 7 | CSAT 0 survey baru | PASS | `K7-a/b` 0 survey; **CSAT tenant DIPAKSA enabled** (S0-g) — kontras `K11-e`: resolve manual = 1 survey (hook tetap hidup, clear-queue memang TIDAK memanggil) |
| 8 | Grup & excludeFromQueue dihormati | PASS | `K8-a/b/c` @g.us dan kontak ber-tag exclude tetap open/unassigned, tidak di daftar cleared |
| 9 | SystemLog + redaksi | PASS | `K9-b/c` row structured module='chat' tenant=12; `K9-d/e` format+meta benar; `K9-g` row passthrough console ada (by design v4.6.4); `K9-f` 0 nomor mentah |
| 10 | Cap 2100 | PASS | `K10-c` 2000+remaining=100; `K10-d` 100 tersisa = TERLAMA (order lastMessageAt desc); `K10-e` klik ke-2 (superadmin impersonate ?tenant=) → 100/0; `K10-g` CSAT T2 tetap 0 |
| 11 | Regresi jalur lama | PASS | `K11-a/b` take-next FIFO normal; `K11-c/d` single-resolve; `K11-e` CSAT hook jalur manual hidup; `K11-f/g` batch-resolve; `K11-i` breadcrumb [BatchResolve] tetap terlog |

Ringkasan akhir run: `=== e2e-clearqueue: 56 PASS / 0 FAIL (5.1s) ===` — bukti penuh: `docs/qa-v466-clearqueue-e2e-final.txt`

## Catatan desain (untuk reviewer)

1. **Set clear = SATU SUMBER KEBENARAN `queue.queueWhere(tenantId)`** — chat `menuState='awaiting'` (limbo Menu Gateway) TIDAK termasuk antrean (invariant §4.1, banner count == tab Unassigned) → tidak di-clear; field limboClear tetap terpasang (pola BatchResolve) sebagai safety net konsisten.
2. **CSAT**: `csat.createSurveyAfterResolve` TIDAK ada di jalur clear-queue (spec §A1). e2e membuktikan dengan tenant CSAT-enabled: 0 survey pasca clear; 1 survey normal saat resolve manual (kontras).
3. **Skipped vs remaining**: `remaining = sisa sebelum aksi (di atas cap) + skipped per-chat` — angka realistis untuk rolling clear UI (modal muncul lagi bila > 0).
4. **Cap test memakai tenant kedua** (2100 chat createMany — pesan dibuat batch kedua) agar angka fixture kasus utama tetap bersih.
5. **Best-effort logging**: sysLog.logInfo dalam try/catch — kegagalan log tidak pernah menggagalkan aksi utama (hard rule #5).
6. NO schema change/DDL — hanya penambahan handler + komponen; package.json, version.json, prisma/schema.prisma tidak diubah.

## Cara menjalankan ulang

```bash
cd /home/kanakxxx/.openclaw/workspace/wa-cs-hub-saas-v3
node scripts/e2e-clearqueue.cjs
# (self-contained: copy DB prisma/data/saas-v3.db → /tmp, prisma db push --skip-generate
#  ke COPY, spawn src/server.js PORT=5099 WA_DISABLED=1 — server child di-kill di akhir)
```