# Spec v3.9.20 — Per-Chart Date Ranges + Custom + All Time

**Request (Kanaka 17:59):** "Yang resolved vs open juga di kasih date range dong yang response time juga. Sama semua date range nya tambahin custom dan all time."

## Context (state saat ini, v3.9.19 live)
- SaOverview.vue: 1 shared `range` ref (today|7d|30d) — tab kontrol HANYA tampil di panel Trend Chat; pie Resolved vs Open & line Avg Response ikut nilai shared itu tanpa kontrol sendiri.
- Backend `parseSaRange(req)` (src/routes/superadmin.js ~L672) cuma terima today|7d|30d.
- DB datetime = **INTEGER ms epoch** — grouping WAJIB `col/1000, 'unixepoch', '+07:00'` (lesson round-2 v3.9.19: tanpa itu hasil NULL → chart 0).
- Saat ini resolution endpoint: resolved = `resolvedAt >= since`; open = `createdAt >= since AND (resolvedAt null OR status != 'resolved')` → legacy chats (Cekat.AI import, resolvedAt=NULL tapi status='resolved') tak terhitung → pie 0% di semua window.

## Scope P1

### A. Backend — src/routes/superadmin.js (additive, ZERO migration)
1. **Range params diperluas** (refactor `parseSaRange` → terima object query):
   - `today` (1 hari WIB), `7d`, `30d` — behavior existing preserved.
   - `all` → window = all time (tanpa filter since; dates = dari hari data-pertama s/d hari ini WIB, per-hari).
   - `custom` → WAJIB `?from=YYYY-MM-DD&to=YYYY-MM-DD` (tanggal WIB). Validasi: format valid, `from <= to`, `to <= hari ini (WIB)`, span (inklusif) <= 366 hari → selain itu **400** dgn pesan jelas.
2. **Window helper** diperluas: support `days=null` (all) dan `{from,to}` → `sinceIso` = midnight WIB `from`, `untilIso` = midnight WIB (`to`+1d). Semua query window-scoped pakai `COALESCE(firstIncomingAt, createdAt)` (konsisten dgn trends existing).
3. **GET /api/sa/stats/trends** — support all & custom. Shape existing preserved: `{ range, today, dates[], counts[], total }` (+ untuk custom boleh tambah `from`,`to`). dates zero-filled per hari WIB.
4. **GET /api/sa/stats/avg-response** — same range semantics; `avgMinutes[]` aligned ke dates (hari tanpa data = null), `avgTotal` = agregat window (bukan mean-of-means), null kalau tak ada pasangan response.
5. **GET /api/sa/stats/resolution** — same range semantics **+ semantics fix (implisit di-approve lewat request)**:
   - Set window = chats masuk dalam window: `COALESCE(firstIncomingAt, createdAt) >= since` (all = tanpa filter).
   - `resolved` = count(set WHERE `status='resolved' OR resolvedAt IS NOT NULL`); `open` = count(set) − resolved.
   - Rationale: legacy chats berstatus resolved (resolvedAt NULL era pra-v3.9.14) jadi kehitung → All Time pie nunjukin rasio riil.
   - Shape existing preserved: `{ range, resolved, open, percentResolved, percentOpen }`.
6. Ketiga endpoint tetap `...sa`. JANGAN sentuh endpoint/field lain.

### B. Frontend — frontend/src/views/SaOverview.vue SAJA
1. State: ganti shared `range` ref → 3 state terpisah: `trendRange`, `respRange`, `pieRange` (default `'7d'`).
2. Setiap panel (Trend Chat, Avg Response, Resolved vs Open) punya bar kontrol sendiri — reuse style `.sa-tab`: tab = `Hari Ini | 7 Hari | 30 Hari | All Time | Custom`.
3. Pilih `Custom` → tampil row date-picker: 2 `<input type=date>` (from/to; default from = today−29 WIB, to = today) + tombol "Terapkan" → fetch dgn `range=custom&from&to`. Invalid (from>to / kosong) → tampil pesan inline kecil, jangan fetch.
4. Fetch: tiap chart fetch dgn range miliknya; perubahan range 1 chart HANYA refetch chart itu (cards & sparkline & delta logic existing jangan rusak — mereka tetap pakai trends today/7d/30d seperti sekarang).
5. Delta "↑ x% vs periode lalu": hidden (null) untuk all & custom.
6. Pie legend label menyesuaikan window: "Hari ini (WIB)" / "7 hari terakhir" / "30 hari terakhir" / "All time" / "dd MMM – dd MMM".
7. Mobile: kontrol flex-wrap (sudah ada pattern-nya).
8. JANGAN ubah SaTenants/SaAudit/SaPengaturan/SaSidebar/router.

### C. E2E — tambah section di scripts/e2e-v3919.cjs (port 5099, DB copy, WA_DISABLED=1)
- `trends?range=all` → 200, dates monotonic, total >= total 7d.
- `trends?range=custom&from=<20 hari lalu>&to=<today WIB>` → 200, dates.length = span, counts aligned, total >= 0.
- `avg-response?range=all` & `?range=custom` → 200, avgTotal number|null.
- `resolution?range=all` → 200 & **percentResolved > 0** (copy DB ada legacy resolved 2.504) & open >= 0.
- `resolution?range=custom` → 200.
- Invalid: `range=custom` tanpa from/to → 400; `from > to` → 400; format bogus → 400; span > 366 → 400.
- Seluruh 54 check existing tetap PASS (regresi) + regresi cepat v3.9.13/v3.9.14 kalau script-nya jalan.

### D. Hard prohibitions (SEMUA round)
- No destructive DB ops; no prisma schema/migration changes (zero-migration locked).
- JANGAN sentuh: `src/routes/apiV1.js`, `analytics.js`, csat, autoReply, menuGateway, `src/auth.js`, `.env`, config.
- No restart prod 5047; test di 5099 saja; kill hanya PID milik sendiri.
- No git commit/tag oleh Dory; no browser/Chrome.

### E. Verification gate (lapor semua)
- `npx vite build` exit 0.
- `node scripts/e2e-v3919.cjs` ALL PASS (54 lama + section baru).
- `node --check src/routes/superadmin.js`.
- Post-verify fresh: `resolution?range=all` percentResolved > 0 di copy DB; `trends?range=custom` dates.length benar.
- CHANGELOG.md: draft section v3.9.20.