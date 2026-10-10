# QA — v4.6.9 Auto-reply C+A: outside-hours jalur & marker sendiri (anti-sunyi pasca jam kerja)

**Status:** DONE — e2e baru + regresi penuh 0 FAIL, smoke copy-DB ALL OK
**Spec:** `docs/spec-v4.6.9-outside-priority.md` (APPROVED 2026-10-10 09:20 — Kanaka "okee gas")
**Build:** 2026-10-10 09:21–10:0x WIB (subagent, sesi v4.6.9)
**Produksi TIDAK tersentuh seluruh pengujian** (5047/5062 tetap jalan; semua test =
copy-DB di /tmp + port 5099/5098/5063, WA_DISABLED=1, tanpa tunnel).

---

## 1. Ringkasan perubahan

| File | Perubahan |
|---|---|
| `prisma/schema.prisma` | **1 kolom ADD-ONLY** `Chat.lastAutoOutDate String?` — marker "YYYY-MM-DD" WIB jalur outside-hours (TERPISAH dari `lastAutoGreetDate`; §K2 kuota 1×/hari per jalur). NULL default; kolom/tabel lain TIDAK berubah. |
| `src/services/autoReply.js` | (C) gate human-out `hasHumanOutMessageToday` kini hanya berlaku `!outside` — di luar jam CS off-duty → away tetap keluar walau CS pernah manual-balas hari itu (kasus BITE ME chat=11810 tenant-10, 16:13). (A) jalur (a) outside klaim marker OUT atomik (`updateMany` + OR null + not-today, pola v0.7.0) → `sendAutoText(..., { marker: 'out' })` → send gagal → revert `lastAutoOutDate` SAJA. **Klaim greeting digeser jadi `!cbaiActive0 && !outside0`** (jalur outside lewat jalur (a) dgn klaim OUT-nya sendiri — tanpa ini klaim greeting early-return memblokir kasus §D4.4 greet-pagi+away-sore). `sendAutoText` dapat param `opts.marker` ('out' vs default greeting — SATU fungsi, tanpa duplikasi). CB-AI/menu/greet/repeatAllows/setContactMenuShown UNCHANGED. JSDoc semua titik edit refer spec + invariant baru. |
| `src/routes/purge.js` | Reset purge kini mencakup `lastAutoOutDate: null` juga (purge = fresh start total, kedua marker). |
| `frontend/src/views/AdminAutoReply.vue` | Catatan kecil di panel Outside Hours (§D3, statis): "💡 Pelanggan tetap dapat pesan outside-hours 1×/hari walau CS sudah membalas manual hari itu." |
| `public/assets/` (build) | FE di-build ulang — tooltip masuk bundle (`AdminAutoReply-CjD6lomO.js` ter-verify grep). |
| `scripts/e2e-v469-outside-priority.cjs` | BARU — 10 kasus spec §D4 (detail §3). |
| `version.json` | `v4.6.8` → `v4.6.9`. |
| `CHANGELOG.md` | Entri patch-line v4.6.9 "(auto-reply C+A — outside hours marker terpisah + human-out skip hanya dalam jam kerja)". |
| `docs/SCHEMA-CHANGES.md` | Entri v4.6.9 + DDL eksak (`ALTER TABLE "Chat" ADD COLUMN "lastAutoOutDate" TEXT;`). |

**Invariants yang dijaga (verifikasi e2e):** firstResponseAt hanya via reply manual (K2-f);
chat assigned tidak diproses AR (K2-c jalur reopen); jalur menu/greet + repeatAllows +
MenuGateway tidak berubah (K10); CB-AI tidak klaim/menyentuh marker OUT (K8-b);
purge reset kedua marker (K7-c).

---

## 2. Keputusan implementasi (interpretasi spec)

- **Klaim greeting dibatasi jalur dalam-jam.** Spec §D2.2 menulis klaim greeting "tetap
  untuk greeting/menyentuh semua jalur di-dalam-jam" — implementasi: `if (!cbaiActive0 && !outside0)`
  claim greeting; jalur outside klaim OUT di titiknya sendiri. Tanpa pembatasan ini,
  `claim.count === 0 → return` di top-of-handler memblokir §D4.4 (greeting pagi +
  away sore di hari sama — keputusan eksplisit Kanaka §K2 "DUA-DUANYA diizinkan"),
  bertentangan dengan maksud spec itu sendiri. Diuji K4-d/K4-e/K5-b.
- **Purge reset marker OUT** (tidak dieksplisitkan di spec §D-tetap konsisten pola
  v0.13.4 "fresh start total" — marker greeting existing juga di-reset purge).

## 3. E2E baru — `scripts/e2e-v469-outside-priority.cjs` (copy-DB 5099, WA_DISABLED=1, E2E_OK_SEND=1, E2E_DEBUG_INBOUND=1)

Skor akhir: **42 PASS / 0 FAIL** (7.9s) — bukti: `docs/qa-v469-outside-e2e-final.txt`.

| # | Kasus (§D4) | Hasil | Bukti kunci |
|---|---|---|---|
| 1 | Migrasi ADD-ONLY | **PASS** (5 check) | K1-a kolom ada; K1-b 3345 rows utuh (marker lama terbaca: 430); K1-d db push ulang = no-op (3345→3345); K1-e DDL share ALTER manual di copy kedua — 3345 rows utuh |
| 2 | Replika BITE ME (jalur RUNTIME asli: 15:32 in-hours → CS human-out 15:33 → resolved → 16:13 pesan → auto-reopen → AR) | **PASS** (6) | K2-d AWAY TERKIRIM ("Away E2E469…"); K2-e `lastAutoOutDate=today` + `lastAutoGreetDate` tetap NULL; K2-f firstResponseAt NULL (invariant) |
| 3 | Anti-spam outside | **PASS** (3) | K3-b pesan ke-2 (16:16) → autoOut tetap 1 (klaim OUT blokir); K3-c marker unchanged |
| 4 | Greeting 1× + outside 1× hari sama (pertanyaan eksplisit Kanaka §K2) | **PASS** (6) | K4-d DUA-DUANYA keluar [Greet, Away]; K4-e kedua marker = today; K4-f anti-spam OUT tetap |
| 5 | Kebalikan 4: outside dulu → dalam-jam | **PASS** (2) | K5-a away 19:00 + marker OUT; K5-b greeting juga keluar (marker greet bebas) — kuota terpisah dua arah |
| 6 | Skip human-out dalam-jam TETAP | **PASS** (2) | K6-a tanpa auto (v3.5 unchanged); K6-b marker greeting di-set oleh skip + OUT tak disentuh |
| 7 | AR invariant + purge | **PASS** (5) | K7-b purge jalur asli 200; K7-c purge reset KEDUA marker; K7-d/e search-all+analytics sanity 200 |
| 8 | CB-AI outside (mode cbai, AiConfig offline = NO_CONFIG) | **PASS** (3) | K8-a away fallback 1× via jalur (a); K8-b counter AI=0 (revert) + OUT ter-klaim jalur (a) — CB-AI sendiri tak nyentuh marker; K8-c pesan ke-2 TIDAK dobel |
| 9 | Send gagal → revert OUT SAJA | **PASS** (3) | K9-a marker OUT balik NULL + zero Message row; K9-b greeting tetap keluar; K9-c pesan berikutnya away terkirim lagi (kuota OUT hidup) |
| 10 | Jalur menu (b) + MenuGateway + repeat intact (in-suite; penuh = §5) | **PASS** (2) | K10-a intro terkirim → awaiting (repeatAllows intact); K10-b jalur menu tak menyentuh marker OUT |

Catatan proses (bukan bug v4.6.9): jalur runtime asli via `/api/wa/inbound`
(kasus 2/3/4) butuh superadmin + `E2E_DEBUG_INBOUND=1`; config yang diubah setelah
server boot harus `invalidateConfig` (AR + MenuGateway — lesson v430).

## 4. Smoke (copy-DB `/tmp/state/saas-v3-smoke-v469.db`, port 5063, WA_OFF)

**ALL OK — 7/7 check** (log: `/tmp/saas-v3-smoke-v469.log`):
- `db push` additive idempoten; kolom `Chat.lastAutoOutDate` ada.
- Boot server 5063 dari copy-DB sukses (proses prod 5047/5062 tidak tersentuh).
- **Log Sistem entry baru stamp `appVersion=v4.6.9`** (server baca `version.json` — acceptance D6).
- Replika kasus 16:13 (in-process AR): away TERKIRIM walau human-out tadi siang;
  `lastAutoOutDate=today` + `lastAutoGreetDate` tak disentuh; pesan ke-2 → tidak dobel.
- Kuota terpisah terverifikasi: greet (10:00) + away (19:00) di hari sama = DUA-DUANYA
  keluar; kedua marker = today.

## 5. Regresi penuh (semua suite) — copy-DB, port test, WA-off

| Suite | Port | Hasil | Catatan |
|---|---|---|---|
| e2e-v394.cjs (v3.9.4) | 5099 | **22 PASS / 0 FAIL** | SEMUA PASS; `docs/qa-v469-regress-v394-final.txt` |
| e2e-v395.cjs (v3.9.5) | 5099 | **13 PASS / 0 FAIL** | gateway runtime per-slot |
| e2e-v396.cjs (v3.9.6) | 5099 | **15 PASS / 0 FAIL** | groups multi-slot (WA-off 503 paths) |
| e2e-v399.cjs (v3.9.9) | 5099 | **10 PASS / 0 FAIL** | fallbackText timeout-release; fixture `waJid like 'e2e-%'` dibersihkan rerun |
| e2e-log-coverage.cjs (v4.6.4) | 5099 | **76 PASS / 0 FAIL** | system-logs coverage lengkap |
| e2e-clearqueue.cjs (v4.6.6) | 5099 (self-boot) | **56 PASS / 0 FAIL** | clear-queue |
| e2e-v467-floatzone.cjs (revisi) | 5099 (self-boot) | **36 PASS / 0 FAIL** | float zone revisi formula v2 |
| e2e-v468-floatzone-v2.cjs | 5099 (self-boot) | **44 PASS / 0 FAIL** | take lifts once, activity wins |
| e2e-v470-systemlogs.mjs | 5098 | **59 PASS / 0 FAIL** | run-1: 58/1 (S3-g flake timing insert fire-and-forget — bukan regresi kode: logika redaksi/log tidak disentuh v4.6.9; retry pada copy fresh = ALL PASS; kemarin v4.6.8 juga sempat flake varian flood-window) |
| e2e v4.6.9 (baru) | 5099 | **42 PASS / 0 FAIL** | §3 |

**TOTAL: 373 PASS / 0 FAIL.** Semua server test dibunuh di akhir (`ss -ltn`: 5098/5099/5063 bersih); proses prod 5047/5062 tidak pernah disentuh sepanjang pengujian.

### Catatan lingkungan regresi (lesson, bukan bug v4.6.9)
- Suite v394–v399 saling-chained SATU copy DB (v394 menciptakan TenantNumber slot-1
  yang di-andalkan v395 T1b; urutan eksekusi persis daftar spec). Copy dasar dibangun
  dari backup era-Sep yang masih memuat tenant-4 (`backup/pre-v3.5-20260922-2017/saas-v3-pre-v351.db`
  + 24 chat TenantNumber tenant-4 di-seed slot 0+1 — replika kondisi QA kemarin),
  lalu `db push` additive menyamakan ke schema kini. Pack DB saat ini TIDAK lagi memuat
  tenant-4 (tenant-4 lama Parahita sudah dihapus era delete-fix) → tanpa ini, A1
  impersonate tenant-4 = 404.
- v399 membaca LOG server di path tetap `/tmp/saas_v3_e2e.log` → server 5099 harus
  redirect log ke sana saat menjalankan v399.
- v396/v399 menegaskan jalur send-GAGAL (503 WA_BELUM_TERHUBUNG) → server regresi
  TANPA `E2E_OK_SEND=1`; suite v4.6.9 baru yang pakai OK_SEND (self-boot sendiri).

## 6. Acceptance (§D6)

- [x] e2e 10 kasus PASS + regresi SELURUH suite PASS (373 PASS / 0 FAIL)
- [x] db push additive verified di copy-DB (0 data hilang; kolom lama utuh; K1-b/d/e)
- [x] appVersion = v4.6.9 di Log Sistem entry baru (smoke §4; stamp proses server)
- [x] Laporan: file list + commit + e2e tabel + smoke + deviasi + risiko

## 7. Risiko & catatan reviewer

1. **Behavior change yang disengaja:** pelanggan yang sebelumnya "senyap di luar jam
   setelah CS manual-balas" kini mulai menerima away-text 1×/hari — INI FEATURE yang
   diminta (C). Teks per-tenant dari `outsideHoursText` existing — tenant-10 sudah
   ok ("hubungi WA Center…" — informatif; dicatat Kanaka di §D6 risiko).
2. **Edge-case diakui (documented, diterima spec §K.5):** pesan in-hours tepat mepet
   16:00 yang auto-msg-nya terkirim sesaat setelah jembatan bisa dapat away di hari
   yang sama greeting terpakai — quantum kecil, sudah tercatat di spec.
3. Race claim OUT vs claim greeting = atomic `updateMany` per-marker (independen,
   tidak saling menunggu — no deadlock; claim OUT terjadi SETELAH gate CB-AI dan
   gate human-out dalam-jam, tiap marker punya guard-nya sendiri).
4. **Kuota OUT tidak dipengaruhi CB-AI** — CB-AI (mode 'cbai') tidak klaim/menyentuh
   marker OUT (spec §D2.4; diuji K8-b) — bila tenant mematikan cbai besok, kuota away
   tetap tersedia.
5. Purge kini mereset marker OUT juga (fresh start total — konsisten pola marker
   greeting v0.13.4).
6. Skema ADD-ONLY murni; DDL share untuk IT ada di `docs/SCHEMA-CHANGES.md`
   (`ALTER TABLE "Chat" ADD COLUMN "lastAutoOutDate" TEXT;`) — prisma db push
   menghasilkan kolom yang sama.