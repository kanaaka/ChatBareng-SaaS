-- v4.1.0 — Channels (WA Channel archive, read-only) — spec docs/spec-v4.1.0-channels.md §1.
-- MIGRATION ADDITIVE-ONLY (SATU migration): 2 CREATE TABLE + index unik. ZERO DROP/ALTER
-- destruktif → kode lama aman membaca DB baru; rollback aman 2 lapis (drop 2 tabel saja).
-- Shadow-replay fresh-clone rusak (legacy) → di copy DB: apply SQL manual + record
-- checksum + bookkeeping _prisma_migrations (pola proven v3.9.x/v4.0.0). Prod: `npx prisma migrate deploy`.
--
-- D3 (read-only total): tabel ini TIDAK punya relasi ke Chat/Message/queue — arsip
-- channel sepenuhnya di samping jalur percakapan (NOL sentuh auto-reply/unread/metering).
-- D8: tanpa plan gate — semua tenant aktif otomatis (archive-only, 0 cost LLM).

-- ── Tabel BARU: arsip channel per tenant + slot yang melihatnya (multi-nomor, D1) ──
CREATE TABLE "ChannelArchive" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tenantId" INTEGER NOT NULL,
    "numberSlot" INTEGER NOT NULL DEFAULT 0,
    "waJid" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "updatedById" INTEGER
);
CREATE UNIQUE INDEX "ChannelArchive_tenantId_numberSlot_waJid_key" ON "ChannelArchive"("tenantId", "numberSlot", "waJid");
CREATE INDEX "ChannelArchive_tenantId_idx" ON "ChannelArchive"("tenantId");

-- ── Tabel BARU: postingan channel (dedupe by serverId — idempoten, D2/D6) ──
CREATE TABLE "ChannelPost" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "archiveId" INTEGER NOT NULL,
    "serverId" TEXT,
    "content" TEXT NOT NULL DEFAULT '',
    "mediaPath" TEXT,
    "mediaType" TEXT,
    "mediaMime" TEXT,
    "fromMe" BOOLEAN NOT NULL DEFAULT 0,
    "msgTimestamp" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ChannelPost_archiveId_serverId_key" ON "ChannelPost"("archiveId", "serverId");
CREATE INDEX "ChannelPost_archiveId_idx" ON "ChannelPost"("archiveId");