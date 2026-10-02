# SCHEMA CHANGES — riwayat DDL per rilis (di-share ke tim IT)

> **PROSES (permintaan tim IT, 16:36 WIB 2026-10-02):** SETIAP rilis yang mengubah
> skema database → entri baru di file ini (DDL eksak, ADD-ONLY) + blok DDL dibawa
> di deskripsi PR-nya. Server IT menjalankan DB miliknya sendiri (bukan pack DB),
> jadi DDL harus bisa di-review dan di-apply manual di sana.

---

## v4.4.0 — 2026-10-01 (migrasi `2026100107400000_v440_tag_exclude_queue`) ← **GAP SAAT INI di server IT**

- **1 kolom ADD-ONLY** (`Tag.excludeFromQueue`) — ZERO DROP, zero destruktif.
  Default `false` = perilaku v4.3.x persis (tidak ada tag yang meng-exclude antrean).
- DDL eksak (identik dengan `prisma/migrations/2026100107400000_v440_tag_exclude_queue/migration.sql`):

```sql
ALTER TABLE "Tag" ADD COLUMN "excludeFromQueue" BOOLEAN NOT NULL DEFAULT false;
```

---

## v4.6.2 + v4.6.3 — 2026-10-02 — BUKAN perubahan skema (infra)

- `scripts/prestart-migrate.js` (npm lifecycle `prestart`): tiap `npm start` →
  cek pending migration + sinkron skema otomatis (`db push`, additive-only,
  idempoten, destructive = ditolak prisma dengan jelas). Guard ini yang membuat
  perubahan skema future TIDAK BISA lagi ke-skip diam-diam.

---

## Sebelum v4.4.0

- Migrasi era v0.x–v4.3.x ada di folder `prisma/migrations/`
  (`20260827225202_init` … `2026092700300000_cbai_end_text`) — masing-masing punya
  `migration.sql` yang bisa di-review.
- DB dari paket hosting v4.3.1 **sudah termasuk SEMUA migrasi itu** (terverifikasi).

---

## Cara apply di server IT (pilih SATU)

1. **RECOMMENDED — universal (DB pack ATAU hand-built):**
   ```bash
   cd /home/id/chatbareng-saas
   cp data/wa-cs-hub.db data/wa-cs-hub.db.bak-$(date +%F)
   npx prisma db push --skip-generate
   ```
   `db push` menyamakan SKEMA KESELURUHAN (bukan cuma 1 kolom) terhadap
   `schema.prisma` — semua drift kolom/tabel yang kurang ditambahkan;
   prisma menolak sendiri operasi yang berpotensi menghilangkan data
   (TANPA `--accept-data-loss` = tidak pernah destructive).

2. `npx prisma migrate deploy` — HANYA jika DB punya tabel riwayat
   `_prisma_migrations` (mis. berasal dari paket).

3. Manual murni SQL — jalankan DDL v4.4.0 di atas langsung.

⚠️ **Interaksi yang perlu dihindari:** DDL manual (jalur 3) kemudian diikuti
   `migrate deploy` (jalur 2) = crash "duplicate column". Aman jika:
   pakai jalur 1, ATAU sudah memakai kode v4.6.3+ (guard v2 self-heal —
   jalur deploy lama sudah dihapus, `resolve` otomatis).

## Verifikasi pasca-apply

```bash
sqlite3 data/wa-cs-hub.db "SELECT excludeFromQueue FROM Tag LIMIT 1;"   # kolom ada
systemctl restart chatbareng   # restart unit server mereka
curl http://127.0.0.1:5047/api/chats/queue-count -H "Authorization: Bearer <token-tenant>"   # harus angka, bukan 500
```

## Commitment ke depan

Setiap PR rilis dengan perubahan skema akan:
1. Memiliki folder `prisma/migrations/<ts>_<nama>/migration.sql` (standar Prisma)
2. Menambah entri di file ini dengan DDL eksak
3. Membawa blok **"Perubahan skema & DDL"** di deskripsi PR