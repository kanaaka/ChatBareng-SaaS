# QA — Log Coverage Upgrade (breadcrumbs bisnis + middleware 4xx + retag)

**Spec:** `docs/spec-superadmin-system-log.md` (parent) + `docs/spec-log-coverage-upgrade.md` (ini)
**Tanggal QA:** 2026-10-05
**Jalur test:** copy-DB `/tmp/saas-v3-e2e-logcov.db` + server port **5099** (`WA_DISABLED=1`)
— produksi port 5047 TIDAK tersentuh. DB copy = salinan `prisma/data/saas-v3.db`
(sebelum run), prisma db push on copy = "already in sync" (zero schema change).
**E2E harness:** `scripts/e2e-log-coverage.cjs` — **76 PASS / 0 FAIL** (12.3s).

## 1. Persiapan (reproducible)

```bash
cd wa-cs-hub-saas-v3
cp prisma/data/saas-v3.db /tmp/saas-v3-e2e-logcov.db
DATABASE_URL=file:/tmp/saas-v3-e2e-logcov.db npx prisma db push --skip-generate
# launch server test (setsid agar survive exec reaping — lesson 2026-10-05):
setsid nohup env PORT=5099 DATABASE_URL=file:/tmp/saas-v3-e2e-logcov.db \
  WA_DISABLED=1 node src/server.js > /tmp/logcov-server-5099.log 2>&1 < /dev/null & disown
# jalankan harness:
node scripts/e2e-log-coverage.cjs
```

## 2. Hasil 12 kasus (spec §E)

| # | Kasus | Hasil | Bukti (ringkas) |
|---|-------|-------|------------------|
| 1 | 400 tag tanpa nama → warn row | ✅ | row `POST /api/tags -> 400`, module=chat, tenant=12, meta `{"status":400,"username":"adm_lgcov_u-…"}`; format persis regex-assert |
| 2 | 409 tag duplikat → warn row | ✅ | row `POST /api/tags -> 409` module=chat tenant=12 |
| 3 | 403 cs akses endpoint admin → warn | ✅ | cs `GET /api/sa/system-logs → 403` → warn row module=tenant (mapping /api/sa), tenant cs benar |
| 4 | Ignore list bekerja | ✅ | `/api/health` 200 no row; health-500 unit (shouldLog4xx=false); `/api/media/` 401 no row; `/api/client-log` self no row; **auth 401: log pertama → kedua ≤60s diredam; 403 beda code tetap log (per (path,code))**; path lain tetap log |
| 5 | Import sukses → IMPORT-DONE | ✅ | row `IMPORT-DONE file=backup.json rows=1 chats=1 dryRun=false tenant=12`, meta `{rows:1,chats:1,dryRun:false}`; isi pesan TIDAK ada di row (privacy) |
| 6 | Import rusak → IMPORT-FAIL | ✅ | row warn `IMPORT-FAIL tenant=12 reason=File bukan JSON yang valid` module=chat |
| 7 | Tag save sukses → TAG-SAVE | ✅ | POST dan PUT sama-sama menghasilkan row `TAG-SAVE name="…" tenant=12` + meta tagId |
| 8 | MSG-IN simulasi pesan WA | ✅ | row `MSG-IN chat=8568 tenant=12` module=chat, meta `{chatId, waJid:ter-redaksi, fromMe:false}`; **isi pesan `rahasia-body` TIDAK ada di message/meta/stack**; dedup 10s: pesan kedua → tetap 1 row; QUEUE-EMIT ikut muncul |
| 9 | Claim chat → module 'chat' (retag Queue) | ✅ | `[Queue] … tenant=12` module=**chat** (console-passthrough tetap module=other by design, stdout persis sama); `[LIST-DEBUG]`, `[BatchResolve]`, `[BatchRead]`, `[Snooze]` semuanya module='chat' + tenant |
| 10 | Redaksi: 0 PII mentah | ✅ | tag bernama nomor `628111222333` → row `TAG-SAVE name="62***2333"`; sweep 0 row tenant berisi nomor mentah di message ATAU metaJson |
| 11 | Flood guard 500 spam | ✅ | tepat **300** info masuk + ≥1 warn `info flood suppressed`; server tetap `/api/health 200` |
| 12 | Boot regresi | ✅ | instance kedua (port 5098, copy DB sendiri): `[Server] running on port 5098`, capture aktif tepat 1×, tanpa `Startup error`, 0 row `[SystemLog]` sejak boot (no self-log-storm), 5× health hit → 0 row log |

## 3. Checklist acceptance (spec §F)

- [x] e2e 12 kasus PASS (copy-DB, port test 5099/5098 — bukan produksi)
- [x] boot bersih, log volume masuk akal (bukan storm)
- [x] breadcrumbs bisnis muncul per module benar (`chat`/`tenant`) — filter UI Log Sistem by module works
- [x] redaksi verified (0 PII mentah di DB — K10 sweep + K5-f + K8-f)
- [x] CHANGELOG entri penambahan hotfix (pola "(log coverage upgrade)", TANPA bump major/minor)
- [x] commit local TANPA push (release pipeline terpisah, pola PR #5)

## 4. Catatan QA penting

1. **Row console-passthrough vs row structured:** retag C menambahkan logInfo
   structured (module='chat' + tenantId) TANPA menghapus console.log — console
   lama TETAP ter-capture wrapper v4.6.4 sbg row module='other'/tenant null
   (stdout behavior tidak berubah, sesuai aturan #6). Jangan kaget melihat
   pasangan row di Log Sistem; row structured-lah yang difilter Modul.
2. **TDZ lesson (caught by e2e iteration):** middleware finish hook WAJIB dipasang
   SETELAH `const app = express()` — versi pertama dipasang sebelum deklarasi →
   `uncaughtException: Cannot access 'app' before initialization` (ter-capture
   sendiri oleh SystemLog — dogfooding yang membuktikan fiturnya bekerja 😄).
   Posisi sekarang: setelah `app.set('trust proxy')`, sebelum route/mounter pertama.
3. **Exec launch lesson:** server test di-launch sbg exec call TERSANDIRI dgn
   `setsid nohup … < /dev/null & disown`; `nohup+disown` tanpa `setsid` mati saat
   exec session direap (skill: exec-environment-quirks).
4. MSG-IN volume: flood guard logInfo global ±300/menit tetap berlaku (tidak
   per-tenant) — proyeksi WA normal jauh di bawah; kalau suatu hari lewat,
   naikkan FLOOD_MAX (env), jangan menumpuk logging.