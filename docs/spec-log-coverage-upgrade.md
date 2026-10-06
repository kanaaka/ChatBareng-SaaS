# Spec — Log Coverage Upgrade: breadcrumbs bisnis + middleware 4xx (penambahan hotfix-style)

**Status:** APPROVED — order Kanaka 2026-10-05 16:58 "yaudah deh update yang perbaikan log itu" (spec ditulis lalu langsung dianggap approved; dieksekusi hari yg sama)
**Implementasi:** selesai 2026-10-05 — lihat `docs/qa-log-coverage.md` (e2e 76 PASS / 0 FAIL) + CHANGELOG entri "v4.6.4 (log coverage upgrade)"
**Tipe:** BE kecil (call-sites + 1 middleware + 1 retag) — NO schema change, NO version bump
**Parent spec:** `docs/spec-superadmin-system-log.md` (v4.6.4, SHIPPED + merged IT 2026-10-05)
**Origin:** diskusi 16:43–16:58 dengan Kanaka — konklusi: capture layer v4.6.4 hanya menangkap exception (error yang meledak). Bug "salah behaviour" (silent logic bug, validasi 400/409, error frontend yang dihandle sopan) lewat di bawah radar — contoh historis: LID bug 22 Sep, jebakan NULL queue count. Paket ini menutup gap "kamar gelap" itu.

---

## A — Middleware 400/4xx response logging (satu tempat, menutup semua route)

`src/server.js` — pasang response-finish hook (sebelum routes, SEMUA app path):

```js
// v4.6.5-log — breadcrumb SOFT-ERROR: semua response >= 400 ke-log warn
// (kecuali noise yang diabaikan di list DI BAWAH). Satu tempat, nutup semua route.
app.use((req, res, next) => {
  res.on('finish', () => {
    const code = res.statusCode
    if (code < 400) return
    const path = req.originalUrl || req.url
    if (IGNORE_4XX.some(p => path.startsWith(p))) return   // lihat daftar noise
    let tenantId = req.user?.tenantId ?? null
    try {
      const sysLog = require('./services/systemLog')
      sysLog.logWarn(`${req.method} ${path} -> ${code}`, {
        module: guessModule(path), tenantId,
        meta: { status: code, username: req.user?.username || null },
      })
    } catch { /* best-effort */ }
  })
  next()
})
```

**Daftar noise-ignore (JANGAN logging — diem):**
- `/api/health` (probe berkala yang memang gagal kadang; bikin DB penuh tanpa nilai)
- `/api/media/` yang nomor berulang (media yang lama di-retry saat offline — bisa banjir)
- 401/403 dari `/api/auth/` (login gagal = percobaan hacker bot; boleh warn TAPI rate-limit sendiri: cukup 1/menit per (path,code))
- `/api/client-log` itself (menghindari logging loop)

**guessModule(path):** mapping prefix → module konstanta yang sama dengan systemLog (`/api/blast → blast`, `/api/tags|contacts → chat`, `/api/wa → wa`, `/api/sa → tenant`, `/api/history → chat`, `/api/v1 → api-keys`, lainnya `other`) — DILAKUKAN DI SERVICE biar gak ada logic duplikat di server.js.

**Dampak:** semua penolakan sopan (400 validasi tag, 409 duplikat, 403 otorisasi, 500) = otomatis keliatan di menu Log Sistem dengan method+path+status+user. Ini yang bikin "tag gagal disimpan" gak perlu laporan user lagi.

## B — Call-sites bisnis (structured breadcrumbs, pakai logInfo/logWarn)

Semua call-site di bawah: module yang benar, tenant dari konteks, best-effort. JANGAN berubah response/logic apapun — cuma logging tambahan. Format pesan = pendek, konsisten, awali dengan prefix jalur (biar gampang difilter di UI):

1. **Pesan masuk** (`src/wa/baileys.js` atau di handler upsert utama — temukan 1 titik pusat: setiap pesan WA yang masuk dari socket):
   `logInfo('MSG-IN chat=N tenant=N', { module:'chat', tenantId, meta:{ waJid: redacted-id, chatId, fromMe } })`
   — dedup 10s & flood guard TIDAK memasukkan ini secara salah karena tenantId beda per tenant (deviasi #3 Dory: dedup key per tenant). Kalau volume tinggi, cek flood guard 300/menit (diukur realistis: 300/menit jauh di atas pesan WA real rata-rata).
2. **Queued update** (`src/socket/queue.js` emitQueueUpdate):
   `logInfo('QUEUE-EMIT tenant=N count=N', { module:'chat', tenantId, meta:{ count } })`
   — bug "count gak update" jadi kelihatan: dipanggil atau tidak, dengan nilai berapa.
3. **Claim/Take** (sudah BUKAN log baru, tapi perlu module retag): ubah `console.log('[Queue] ...')` existing di `src/routes/chats.js:782` jadi pakai `sysLog.logInfo(..., { module:'chat', tenantId, meta:{ ... } })` — stdout tetap tampil (passthrough).
   Sama untuk BatchResolve/BatchRead/Snooze (retag pakai module 'chat').
4. **Tag save** (`src/routes/tags.js` POST/PUT/PATCH):
   setelah sukses: `logInfo('TAG-SAVE name="N" tenant=N', { module:'chat', tenantId, meta:{ tagId } })`
5. **Tag assign ke chat** (`src/routes/chats.js:1621` area chatTag.create):
   `logInfo('CHAT-TAG chat=N tag=N', { module:'chat', tenantId })`
6. **Import chat** (`src/routes/history.js` POST /import):
   setelah sukses: `logInfo('IMPORT-DONE file=N rows=N chats=N', { module:'chat', tenantId, meta:{ rows, chats } })`
   di catch yang sudah ada (1 tempat): tambahkan `logWarn('IMPORT-FAIL …', { module:'chat', tenantId, err })`

Semua yang sudah `console.log` breadcrumb JANGAN dihapus — cukup di-retag ke module yang benar (lihat C).

## C — Retag breadcrumb existing (biar filter Modul bener)

`src/routes/chats.js` line yang sudah ada `[LIST-DEBUG]`, `[Snooze]`, `[Queue]`, `[BatchResolve]`, `[BatchRead]` — ganti `console.log` menjadi `sysLog.logInfo(..., { module:'chat', tenantId: req.tenantId, meta:{ ... } })` (tenantId eksplisit; LIST-DEBUG jangan logInfo — cukup tetap stdout? → ganti pakai logInfo juga, module 'chat', tapi cek di e2e: LIST-DEBUG bisa 1/menit per request — jangan sampai bermasalah dengan flood guard).

## D — Anti-slop (keamanan log volume & kebersihan)

- Dedup 10s + flood guard 300/menit **tetap jalan** di seluruh call-site B (di service-nya).
- **Semua** field tetap lewat redactText (nomor WA, email, id grup, body) — gak ada PII nyempul.
- Khusus `MSG-IN`: jangan log isi pesan sama sekali — hanya chat ID + tenant (privacy by design).
- Volume proyeksi: ~10–30 row/menit peak WA + breadcrumb bisnis — jauh dari flood guard 300. Kalau nanti terbukti lebih, naikkan flood guard, bukan canggungi logging-nya.

## E — E2E (file baru `scripts/e2e-log-coverage.cjs` — pola e2e existing)

1. Trigger response 400 (tag tanpa nama) → warn row: path+status, tenant + user benar   2. 409 (tag duplikat) → warn row muncul
3. Trigger 403 (cs akses endpoint admin) → warn row
4. Health endpoint gagal (simulate) → TIDAK log (ignore list bekerja)
5. Import sukses → IMPORT-DONE muncul dgn jumlah rows benar
6. Import CSV rusak → IMPORT-FAIL warn + detail
7. Tag save sukses → TAG-SAVE info
8. Pesan WA simulasi masuk → MSG-IN info dgn tenant sesuai
9. Claim chat → row dengan module 'chat' (BUKAN 'other')
10. Redaksi: field meta tidak boleh berisi nomor/email mentah
11. Flood: spam 500 logInfo → ≤300 masuk + 1 warn suppress, server tetap 200 OK
12. Boot regresi: clean boot tanpa error capture-layer, no self-log-storm

## F — Acceptance checklist

- [ ] e2e 10+ kasus PASS (copy-DB, port test)
- [ ] boot bersih, log volume masuk akal (bukan storm)
- [ ] UI Log Sistem: breadcrumbs bisnis muncul rapi per module (filter by tag 'chat' gampang)
- [ ] redaksi verified (0 PII di DB)
- [ ] CHANGELOG entri penambahan hotfix (pola v4.6.x "(log coverage upgrade)") + docs/qa-log-coverage.md
- [ ] commit local JANGAN push (release pipeline terpisah, pola PR #5)