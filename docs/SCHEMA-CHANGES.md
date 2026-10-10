# SCHEMA CHANGES — riwayat DDL per rilis (di-share ke tim IT)

> **PROSES (permintaan tim IT, 16:36 WIB 2026-10-02):** SETIAP rilis yang mengubah
> skema database → entri baru di file ini (DDL eksak, ADD-ONLY) + blok DDL dibawa
> di deskripsi PR-nya. Server IT menjalankan DB miliknya sendiri (bukan pack DB),
> jadi DDL harus bisa di-review dan di-apply manual di sana.

---

## v4.6.9 — 2026-10-10 — marker outside-hours terpisah (ADD-ONLY)

- **1 kolom ADD-ONLY** (`Chat.lastAutoOutDate`) — ZERO DROP, zero destruktif; data
  existing: NULL default, kolom lain tidak berubah.
- Fungsi: marker "YYYY-MM-DD" (WIB) terakhir chat dapat balasan auto JALUR OUTSIDE-hours
  (v4.6.9 C+A — anti-sunyi pasca jam kerja; kuota 1×/hari TERPISAH dari greeting
  `lastAutoGreetDate`). Detail: `docs/spec-v4.6.9-outside-priority.md`.
- DDL eksak:

```sql
ALTER TABLE "Chat" ADD COLUMN "lastAutoOutDate" TEXT;
```

- ATAU (RECOMMENDED, kode sudah ≥v4.6.3): `npx prisma db push --skip-generate`
  (additive-only, idempoten, prisma menolak operasi destruktif).

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

---

## v4.6.4 (log menu addition) — 2026-10-05 — Superadmin **System Log** (tabel baru, ADDITIVE MURNI)

- **1 tabel ADD-ONLY** (`SystemLog`) — ZERO DROP, zero perubahan pada tabel/kolom lama.
  Log diagnostik lintas-tenant untuk SUPERADMIN (viewer `/superadmin/logs`); tenant
  TIDAK pernah melihatnya (privasi antar-tenant mutlak).
- `tenantId` plain TANPA FK + `tenantName` snapshot → pola `SaAuditLog`: row tetap
  hidup setelah tenant di-purge (tidak orphan-FK).
- **Redaksi PII DIEKSEKUSI SAAT INGEST** (services/systemLog.js): DB & export sudah
  bersih by construction — nomor WA/NIK (digit ≥8), email, dan blok
  message/body/payload literal di-redaksi sebelum write.
- Retensi otomatis **30 hari** (env `SYSTEMLOG_RETENTION_DAYS` override) — prune
  harian in-process, tanpa cron eksternal. Tidak ada delete manual dari UI.
- Migrasi diterapkan otomatis oleh `npm start` (guard prestart-migrate v2 — db push
  idempoten additive-only, persis pola rilis sebelumnya).

**DDL eksak (dialect SQLite — eksak dari `prisma migrate diff` datamodel lama→baru;
 idempoten bila dijalankan berulang — aman untuk DB server IT):**

```sql
CREATE TABLE IF NOT EXISTS "SystemLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "tenantId" INTEGER,
    "tenantName" TEXT,
    "appVersion" TEXT,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "metaJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "SystemLog_ts_idx" ON "SystemLog"("ts");
CREATE INDEX IF NOT EXISTS "SystemLog_level_ts_idx" ON "SystemLog"("level", "ts");
CREATE INDEX IF NOT EXISTS "SystemLog_module_ts_idx" ON "SystemLog"("module", "ts");
CREATE INDEX IF NOT EXISTS "SystemLog_tenantId_ts_idx" ON "SystemLog"("tenantId", "ts");
```

*(Catatan: bentuk ini setara dgn spec §D8 — versi MySQL di pack diadaptasi ke
 dialect SQLite yang benar-benar dipakai server; `IF NOT EXISTS` ditambah agar
 aman dijalankan berulang. Kolom & index identik.)*

**Verifikasi pasca-apply:**

```bash
sqlite3 data/wa-cs-hub.db "SELECT COUNT(*) FROM sqlite_master WHERE name='SystemLog';"  # >= 1 (tabel ada)
systemctl restart chatbareng
# login superadmin → menu "Log Sistem" → /superadmin/logs harus tampil (list 200)
```