# Spec v4.1.4 — FEATURE: Edit Tag (rename + ganti warna) di Tag Manager Kontak

**Request (Kanaka, 2026-09-28 14:26):** di Tag Manager (Kontak) saat ini cuma bisa create/export/delete — tambahkan **Edit tag**: ganti nama dan/atau ganti warna.

## State existing (sudah diverifikasi Alita)
- `prisma/schema.prisma` model Tag: `id, tenantId, name (unique per tenant), color (default 'blue'), createdBy, createdAt, chats ChatTag[], contacts ContactTag[]` — **TIDAK perlu migration** (rename/ganti warna = update field existing).
- `src/routes/tags.js`: GET `/` (semua user), POST `/` (semua user, validColors = blue/green/red/yellow/purple/gray, dup → 409), DELETE `/:id` (**requireAdmin**, hapus ChatTag+ContactTag join + broadcast).
- FE `frontend/src/views/Contacts.vue`: tag panel (showTagPanel) — form tambah (newTagName + newTagColor dari TAG_COLORS) + list tag per-row: dot warna, nama, contactCount, tombol `Lihat kontak` / `Export CSV` / `Hapus`.

## D1 — Backend: PUT /api/tags/:id (BARU, di src/routes/tags.js)
- Middleware: `...rt, requireAdmin` (konsisten dgn DELETE; edit = mutasi resource yang dipakai lintas chat/kontak).
- Flow:
  1. `id = parseInt(req.params.id)`; cari `prisma.tag.findFirst({ where: { id, tenantId: req.tenantId } })` → null = **404** `{ error: 'Tag not found' }`.
  2. Body `{ name?, color? }` (keduanya optional; minimal satu):
     - `name`: kalau dikirim → trim; kosong = **400** `{ error: 'Tag name is required' }`; maxlength 40 (lihat FE) → kalau >40 trim/400 (pilih: **400** tipe liar; >40 char → **400**); **unique check**: `findFirst({ tenantId, name, NOT { id } })` → ada = **409** `{ error: 'Tag already exists', tag }` (bedakan dari self-rename: nama sama dgn dirinya sendiri = OK, lanjut update).
     - `color`: kalau dikirim → validColors sama dgn POST; invalid string → fallback 'blue' (KONSISTEN dgn POST yang juga fallback); bukan string → **400**.
     - Dua-duanya kosong/undefined → **400** `{ error: 'Nothing to update' }`.
  3. `prisma.tag.update({ where: { id }, data: { ...(name!==undefined && {name: name.trim()}), ...(color!==undefined && {color: tagColor}) } })`.
  4. Broadcast (urutan): `broadcast.emitToTenant(tenantId, 'tag_updated', { tag: { ...updated, contactCount: <hitung _count.contacts> } })` + `broadcast.emitToTenant(tenantId, 'tags_changed', { reason: 'tag_updated', tagId })`.
  5. Res **200** `{ tag }` (sertakan contactCount).
- JANGAN ubah GET/POST/DELETE yang existing. JANGAN sentuh route lain.

## D2 — FE Contacts.vue: mode edit inline per-row
- State baru: `editingTagId = ref(null)`, `editTagName = ref('')`, `editTagColor = ref('blue')` (reuse `tagBusy` utk guard double-submit).
- Tombol **Edit** di tiap row (posisi: sebelum Export CSV, style kecil konsisten: `text-xs px-2 py-1 rounded bg-indigo-100 text-indigo-700 hover:bg-indigo-200`): set `editingTagId = t.id; editTagName = t.name; editTagColor = t.color`.
- Row yang diedit berubah jadi form inline (menggantikan tampilan row): input nama (maxlength 40, `@keydown.enter="saveTagEdit"`, autofocus via `nextTick`) + select warna (TAG_COLORS sama dgn form create) + tombol `Simpan` (disabled bila nama kosong || tagBusy || tidak ada perubahan) + tombol `Batal` (reset editingTagId=null). `@keydown.esc="cancelTagEdit"` pada input.
- `saveTagEdit()`: `PUT /api/tags/${editingTagId}` body `{ name: editTagName.trim(), color: editTagColor }` dengan header Authorization bearer auth.token (pola axios existing di file).
  - Sukses → update item di array `tags` in-place (name + color) → toast hijau "Tag diperbarui"; keluar mode edit.
  - 409 → toast merah "Nama tag sudah dipakai" (tetap di mode edit).
  - 404/403/500 → toast error dengan `e.response?.data?.error || e.message`.
- Tombol Edit **hanya untuk admin**: `v-if="auth.isAdmin"` (pola auth store existing; DELETE button dibiarkan perilaku existing — JANGAN diubah di fitur ini).
- Realtime: listener socket existing `tags_changed` di Contacts.vue sudah refetch — pastikan reason 'tag_updated' juga memicu refetch (kalau handler-nya refetch semua reason → tidak perlu ubah; kalau switch reason spesifik → tambahkan case 'tag_updated').

## D3 — FE sinkron realtime tab lain (chat list dropdown + filter chips)
- `frontend/src/views/ChatListPane.vue` sudah listen `tag_created`/`tag_deleted` (onTagCreated/onTagDeleted memanipulasi `allTags`). Tambah listener `tag_updated`: update item di `allTags` in-place (cari by id → replace name/color; tidak ada → abaikan). Dipasang di onMounted socketStore.on('tag_updated', onTagUpdated) + cleanup di onUnmounted.
- Dashboard.vue juga punya allTags sendiri (handler di Dashboard) — cek & tambah listener sama persis di sana (socketStore.on('tag_updated', ...) + off di onUnmounted) supaya dropdown chat detail ikut segar.

## D4 — E2E smoke (copy-DB, pola e2e-v4121, server copy PORT 5099, JANGAN prod)
- NEW `scripts/e2e-v414.cjs` (~14 check, BASE http://localhost:5099, pola login SA di e2e-v4121.cjs — SUPERADMIN_USERNAME/PASSWORD dari env):
  - S0 login superadmin (copy db) 200 + token.
  - N1 POST tag "EditQA A" (color red) → 201; POST tag "EditQA B" (blue) → 201.
  - N2 PUT tag A `{ name: 'EditQA A2', color: 'green' }` → 200 + echo name/color.
  - N3 GET / → tag A2 ada dgn color green + contactCount field tetap ada (regresi shape).
  - N4 PUT tag A2 `{ name: 'EditQA B' }` (dup dgn tag B) → **409**.
  - N5 PUT tag A2 `{ name: 'EditQA A2' }` (self-rename sama) → **200** (bukan 409).
  - N6 PUT `{ color: 'hijau_muda' }` → fallback blue 200; PUT `{ color: 12345 }` → **400**.
  - N7 PUT `{}` → **400** Nothing to update.
  - N8 attach tag ke 1 chat via endpoint existing (POST /api/chats/:id/tags — cek nama routenya di chats.js) → rename tag → GET chat detail → nama tag baru tampil (join tetap intact).
  - N9 buat user tenant non-admin → PUT → **403**.
  - N10 PUT tag id tenant lain (buat tenant kedua di copy db atau pakai id liar 999999) → **404**.
  - N11 DELETE tag A2 → 200; GET → hilang; emit tags_changed (verify via log broadcast TIDAK wajib — skip).
  - R12: jalankan `scripts/e2e-v4121.cjs` terhadap copy db yang sama (urutan: v414 dulu atau copy baru terpisah) — **61/61 tetap PASS** (regresi backend).
- Node --check: src/routes/tags.js.

## NON-GOALS
- Tidak ada migration/prisma schema change (field name/color sudah ada).
- Tidak mengubah warna valid list, tidak menambah kategori warna baru.
- CB-AI/autoReply/aiKnowledge: LOCKED (Kanaka 11:27) — jangan sentuh.
- Tidak mengubah perilaku tombol Hapus/Export/Lihat kontak.

## Constraints (lesson wajib)
- NEVER `--force-reset`/`--accept-data-loss`/`DROP`/`rm` on any DB; tool minta reset → STOP & report.
- **Prod 5047 TIDAK disentuh.** Server copy 5099 untuk e2e (copy-DB, bukan prod db). Kill server copy sendiri setelah selesai (boleh — 5099 bukan prod; lesson: PARENT yang kill PROD, bukan copy).
- Build verifikasi FE: `cd frontend && npx vite build --outDir /tmp/cb-tagedit-dist-test --emptyOutDir` (exit 0).
- JANGAN commit/tag — parent yang finalisasi. JANGAN install/uninstall node_modules. Jangan jalankan `prisma migrate`/`db push` apapun (schema TIDAK berubah).
- Backend baru = satu route PUT + broadcast; jangan refactor kode existing.

## Deliverable Dory (OUTPUT WAJIB di akhir turn)
1. File berubah: `src/routes/tags.js`, `frontend/src/views/Contacts.vue`, (opsional `frontend/src/views/Dashboard.vue` + `frontend/src/views/ChatListPane.vue` utk D3), `scripts/e2e-v414.cjs`, CHANGELOG.md (header paling atas `# v4.1.4 — FEATURE: Edit tag — rename + ganti warna (request Kanaka 2026-09-28 14:26)` + 1 paragraf ringkas).
2. Bukti: node --check OK; e2e-v414 hasil lengkap (X/14 PASS); e2e-v4121 regresi 61/61 PASS di copy DB; build exit 0 + grep bukti "Simpan"/`tag_updated` di chunk hasil /tmp.
3. `git status --short` (project dir) — konfirmasi hanya file di atas.
4. Konfirmasi eksplisit: prod 5047 tidak disentuh, tidak ada prisma command, tidak commit, copy server 5099 sudah di-kill.