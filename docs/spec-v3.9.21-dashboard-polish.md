# Spec v3.9.21 — Dashboard Polish: 4 quirks dari live-QA Kanaka (2026-09-25 19:20)

Baseline: v3.9.20 RELEASED (commit `9260e38`, tag pushed GitHub, prod 5047 PID 85381, health 200).
Semua perubahan **additive**, ZERO migration, jangan sentuh file forbidden.

## Q1 — Sidebar brand margin mepet pojok kiri atas
**File:** `frontend/src/components/SaSidebar.vue`
- Blok brand (`.sa-sidebar__brand` desktop + `.sa-mobile-brand*` topbar mobile) terlalu mepet frame pojok kiri atas → kesan "kepotong".
- Fix: beri ruang manis — padding-top desktop ≥ 20px, padding kiri konsisten dgn nav items (jangan 0); mobile topbar padding ≥ 12px vertikal.
- Pure CSS/scoped-style; layout nav items & drawer TIDAK berubah. Verifikasi visual: brand tidak nempel edge manapun.

## Q2 — Range "Hari Ini" → sumbu HORIZONTAL per JAM (trends + avg-response)
Masalah: today + axis tanggal = 1 titik, gak informatif. Harusnya per jam WIB.

### Backend (`src/routes/superadmin.js`)
- `GET /api/sa/stats/trends?range=today` → shape BARU `{ range:'today', mode:'hourly', dates:['00','01',...,'<jam saat ini WIB>'], counts:[...], total }`
  - labels = jam 00 WIB s/d jam WIB saat ini (inklusif, zero-filled)
  - grouping: `strftime('%H', COALESCE("firstIncomingAt","createdAt")/1000,'unixepoch','+07:00')`
  - window tetap [midnight WIB, +1d) — konsisten dgn semantics existing
  - range today/7d/30d/all/custom NON-today: shape UNCHANGED (`mode` absent / bisa `mode:'daily'` — pilih konsisten, additive)
- `GET /api/sa/stats/avg-response?range=today` → `{ range:'today', mode:'hourly', dates:[jam...], avgMinutes:[...], avgTotal }`
  - bucket per jam WIB dari `firstIncomingAt`; base filters (IS NOT NULL ×2 + firstResponseAt >= firstIncomingAt) WAJIB tetap ada; avgTotal = agregat sum/sum window; hari/jam tanpa data = null
- JANGAN ubah endpoint/shape lain.

### Frontend (`frontend/src/views/SaOverview.vue`)
- ⚠️ **HERO CARD FIX:** `todayChat` sekarang baca `counts[0]` — dengan hourly, `counts[0]` = chat jam 00:00–01:00 doang (SALAH). Ganti ke `tToday.data?.total ?? 0` (total = sum semua jam = chat hari ini).
- Trend chart: jika `trend.mode === 'hourly'` → x tick label format `HH.00` (mis. "14.00"), pointRadius selalu tampil (≤24 titik), maxTicksLimit 8. Kalau daily → perilaku existing.
- Avg chart: sama — hourly label `HH.00`.
- Pie TIDAK berubah.

### E2E (`scripts/e2e-v3919.cjs`)
- Update B6: trends today → 200 + `mode:'hourly'` + dates.length = jam WIB saat ini + 1 (≥ 1) + counts.length == dates.length
- Update B9: seed chat hari ini → `total >= 1` (bukan counts[0])
- Baru: avg-response today → 200 + mode hourly + avgMinutes.length == dates.length

## Q3 — Panel Storage Tangan Kanan (semua tenant)
Motivasi: pertimbangan upgrade server.

### Backend
- Endpoint additive `GET /api/sa/stats/tk-storage` (guard `...sa`):
  ```json
  { "totalBytes": 8900000000, "fileCount": 1234, "perTenant": [ { "tenantId": 8, "tenantName": "Mazaya", "bytes": 8000000000, "files": 1100 }, ... ] }
  ```
- Sumber: `SharedFile` groupBy `tenantId` — `_sum { size }`, `_count`; join nama tenant (semua tenant, termasuk yg 0 byte? cukup yang punya file + tetap sertakan tenant tanpa file dgn bytes 0 biar tabel lengkap — simpel: groupBy saja, lalu map nama).
- `size` Int nullable → null dihitung 0. Total = jumlah semua (JS number aman utk SQLite 64-bit).
- ZERO migration (schema SharedFile existing: `size Int?`).

### Frontend
- Panel kecil di Overview, posisi: **di bawah baris metric cards, sebelum grid chart** — full-width ringkas:
  - Judul "Storage Tangan Kanan", angka besar total human-readable (B/KB/MB/GB — id-ID), sub: "N file · M tenant"
  - Breakdown per tenant 1 baris: nama tenant + size human (sort desc by bytes; tenant 0 file di akhir)
  - Tidak perlu klik/filter — read-only info.

## Q4 — Animasi chart smooth saat load awal
- Saat ini chart terasa "langsung muncul". Tambah animasi Chart.js halus:
  - Line (trend & avg): `animation: { duration: 900, easing: 'easeOutQuart' }` + stagger delay per panel (trend 0ms, pie ~120ms, avg ~240ms) di load awal
  - Doughnut: default rotate+scale anim Chart.js dengan duration ~900ms
  - Sparkline: TETAP `animation: false` (sengaja)
  - Re-render via `refreshPanel()` (ganti range): durasi lebih pendek (~400ms) biar gak lambat — boleh implement via opsi param `renderCharts({ quick })` atau biarkan default; pilih 1, konsisten.
  - destroyCharts → re-create aman; JANGAN pakai lib baru.

## E2E tambahan (scripts/e2e-v3919.cjs — section M)
- M1 `tk-storage` → 200 + totalBytes number ≥ 0 + fileCount ≥ 0 + perTenant array
- M2 tk-storage perTenant entries punya tenantId + bytes number + files number
- M3 trends today mode hourly (gabung dgn update B6 di atas — cukup salah satu tempat, jangan double-count gate)
- Semua check existing (70) + baru = ALL PASS di DB copy.

## Hard prohibitions (sama)
- No prisma migrate/db push/DROP/--force-reset; no sentuh apiV1.js/analytics.js/csat/autoReply/menuGateway/src/auth.js/.env/config/SaTenants/SaAudit/SaPengaturan/SaSidebar-router/SuperAdmin.vue-split; no restart prod 5047; no git commit/tag; no browser.
- Test server copy: `DATABASE_URL="file:/tmp/saas-v3-e2e.db" PORT=5099 WA_DISABLED=1 node src/server.js` — WAJIB env DATABASE_URL eksplisit.

## Gates
1. `npx vite build` (frontend/) exit 0
2. `node --check src/routes/superadmin.js`
3. E2E ALL PASS (70 lama + baru, DB copy 5099)
4. Post-verify fresh curl dgn SA token copy: `stats/trends?range=today` → mode hourly + dates.length = jam+1; `stats/tk-storage` → totalBytes ≥ 0 + perTenant; `stats/avg-response?range=today` → mode hourly.
5. Lapor: file diubah + hasil tiap gate + deviasi spec (kalau ada).