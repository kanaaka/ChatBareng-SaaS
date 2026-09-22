# SaaS v3 Phase 1.1 — Spec: Isolasi Accent Tema per-Tenant (Login Page Netral)

Tanggal: 2026-09-22 · Author: Alita · Executor: Dory · Repo: `wa-cs-hub-saas-v3/` (port 5047)

## Latar

Phase 1 multi-tenant sudah membuat `AppearanceConfig` per-tenant (tenantId unique)
dan endpoint auth (GET/PUT `/api/appearance`) sudah benar di-scope dari JWT.
TAPI semua permukaan tema PUBLIK masih punya fallback "tenant pertama":

- `src/routes/appearance.js` → handler `/api/appearance/public`, `themeCssHandler`
  (GET `/theme.css`), `manifestHandler` (GET `/manifest.webmanifest`) resolve tenant
  via `?tenant=` / header `X-Tenant-Id`, dan kalau tidak ada →
  `prisma.tenant.findFirst({ orderBy: { id: 'asc' } })`.
- Frontend TIDAK PERNAH mengirim `?tenant=`, dan user tenant memang sengaja tidak
  diberi tahu tenantId-nya (keputusan transparansi Phase 1 — jangan diubah).

Akibat (terkonfirmasi audit 2026-09-22, DB masih 0 tenant jadi belum terlihat user):
1. Admin tenant #1 ganti accent → login page (permukaan "umum") ikut berubah
   untuk SEMUA orang.
2. Admin tenant #2+ ganti accent → tersimpan di DB tapi tidak pernah tampil di
   mana pun, bahkan untuk user tenant itu sendiri.
3. Cache `/theme.css` satu slot global (`themeCssCache`) — kalau theming per-tenant
   aktif, CSS tenant A bisa tersajikan ke tenant B.

## Tujuan

1. Pre-auth (login page, manifest, theme.css tanpa param) = NETRAL platform default
   `#6D28D9` — tidak bisa dipengaruhi tenant mana pun.
2. Post-login = accent tenant aktif, di-apply RUNTIME dari endpoint auth
   (tenantId tetap tidak bocor ke klien).
3. Cache per-tenant.
4. `?tenant=N` eksplisit tetap didukung (forward-compat fase subdomain per-tenant).

## ⛔ Larangan (WAJIB)

- TIDAK ADA perubahan schema/migrasi DB — tabel sudah benar. JANGAN jalankan
  `prisma migrate`, `prisma db push` (apalagi `--force-reset` / `--accept-data-loss`),
  `migrate reset`, DROP, atau `rm` pada DB/file data apa pun. Kalau merasa butuh
  migrasi → STOP & laporkan. (Insiden 2026-08-31: DB produksi ke-wipe.)
- JANGAN restart/matiin server live (port 5047) — deploy, restart & E2E urusan Alita.
- Scope edit: HANYA di dalam repo `wa-cs-hub-saas-v3/`. Jangan sentuh file di luar repo.
- Jangan ubah behavior auth/isolasi lain (`requireTenant` dsb.) — ini murni tema tampilan.

## Perubahan Backend — `src/routes/appearance.js`

1. Hapus fallback `prisma.tenant.findFirst` di KETIGA handler publik
   (`/public`, `themeCssHandler`, `manifestHandler`).
   - Tanpa `?tenant=` / `X-Tenant-Id` valid → default netral:
     - `/api/appearance/public` → `{ accentSeed: DEFAULT_SEED }` (SELALUS 200 JSON
       valid — init script index.html bergantung pada ini).
     - `themeCssHandler` → serve string kosong `''` (tokens.css default = netral).
     - `manifestHandler` → `theme_color = DEFAULT_SEED`.
   - Dengan `?tenant=N` valid → resolve config tenant itu (perilaku sekarang dipertahankan).
2. Cache `/theme.css`: ganti satu slot `themeCssCache` jadi `Map` keyed tenant
   (key = tenantId, atau `'default'` untuk tanpa tenant). `invalidateThemeCssCache`
   menerima tenantId dan menghapus key itu saja; PUT `/api/appearance` invalidasi
   key `req.tenantId`.
3. Auth GET/PUT `/api/appearance` tidak berubah (sudah benar). Hanya jalur
   invalidasi cache (poin 2) yang disentuh.

## Perubahan Frontend

4. Runtime tenant theme — util baru, mis. `frontend/src/utils/tenantTheme.js`:
   - `applyTenantTheme(seedHex)`: generate variabel `--md-sys-color-*` via
     `@material/material-color-utilities` (ikuti pola builder preview di
     `AdminAppearance.vue` / `src/services/appearance.js` — nama variabel HARUS
     sama dengan tokens.css) → inject/replace `<style id="tenant-theme">` di
     `<head>` (idempotent — dipanggil 2x tidak menumpuk tag).
   - Return seed agar caller bisa update meta theme-color.
5. Bootstrap: `App.vue` onMounted setelah `fetchMe()` sukses →
   `GET /api/appearance` (axios, Bearer otomatis terpasang) →
   `applyTenantTheme(seed)` + `syncThemeColorMeta` dengan seed tenant
   (light mode = seed tenant; dark tetap `#141218`).
6. Setelah login sukses: panggil juga applyTenantTheme di action `login()` store
   auth SETELAH token tersimpan (bootstrap App.vue tidak jalan kalau navigasi
   tanpa full reload) — idempotent, aman dipanggil 2x.
7. `frontend/src/utils/themeColor.js` — `syncThemeColorMeta` accept optional
   param `seed`: kalau ada, pakai itu (jangan fetch public lagi). Tanpa param →
   perilaku lama (pre-login, netral).
8. `frontend/index.html` init script: bagian fetch `/api/appearance/public` +
   update meta theme-color → GUARD: skip update meta kalau
   `localStorage.getItem('token')` ada (post-login, runtime yang pegang meta).
   Bagian anti-FOUC `data-theme` TETAP jalan apa pun kondisinya.
9. `AdminAppearance.vue` setelah PUT sukses → `applyTenantTheme(newSeed)`
   (apply live tanpa reload) + ubah pesan info "reload halaman untuk melihat…"
   → "Accent aktif di seluruh app."
10. Link injection `/theme.css` di index.html dibiarkan apa adanya
    (netral pre-login; post-login `<style id="tenant-theme">` di-append
    belakangan di head → cascade menang, specificity sama).

## Build & Commit (Dory)

- `node --check src/routes/appearance.js`
- `cd frontend && npm run build` — WAJIB sukses tanpa error (outDir `../public`).
- Update `CHANGELOG.md` — entry baru paling atas, style konsisten entry sebelumnya.
- `git add -A && git commit` dengan pesan jelas (repo sudah pakai git flow).

## Verifikasi lokal (Dory — cukup sepuas ini; jangan start server)

- `node --check` lolos + build frontend sukses.
- `grep -n "findFirst" src/routes/appearance.js` → tidak ada lagi di 3 handler publik
  (hanya boleh tersisa di jalur eksplisit `?tenant=`, kalau perlu).

## E2E (Alita, setelah deploy)

DB masih 0 tenant. Alita akan: bikin test tenant via API superadmin → set accent
via impersonate → verifikasi `?tenant=` resolve, login page tetap netral, apply
post-login jalan → screenshot Chrome 18801 → lapor Kanaka.

## Acceptance Criteria

1. `GET /api/appearance/public`, `GET /theme.css`, `GET /manifest.webmanifest`
   TANPA param → selalu netral `#6D28D9`, apa pun accent tenant #1.
2. Admin tenant #2 ganti accent → tersimpan DAN tampil untuk user tenant #2
   sendiri setelah login; tenant lain & login page tidak terpengaruh.
3. Cache tidak mungkin cross-tenant (keyed per tenantId).
4. tenantId tidak pernah muncul di payload/klien tenant (kecuali flow
   superadmin impersonate yang sudah ada).
5. Build frontend sukses; CHANGELOG + commit rapi.