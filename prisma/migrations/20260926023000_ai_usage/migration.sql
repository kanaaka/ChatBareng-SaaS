-- v3.9.24 — AI Usage: cost metering + panel dashboard + rate tabel per-model.
-- MIGRATION ADDITIVE-ONLY: 2 CREATE TABLE baru + 1 ADD COLUMN. TIDAK ada kolom/
-- tabel lama yang diubah/dihapus. Aman utk prisma migrate deploy.
-- Shadow-replay fresh-clone rusak (legacy) → di copy DB: apply SQL manual + record
-- checksum (pola proven v3.9.14/v3.9.23). Prod: `npx prisma migrate deploy` saat release.

-- CreateTable — log pemakaian LLM per-call (summary/preview/test).
-- Snapshot pricing saat call (D3): costUsd dihitung & disimpan saat call — edit rate
-- TIDAK PERNAH mengubah histori. costUsd NULL = model tanpa rate (D4);
-- costUsd 0 + wouldCostUsd = fallback lokal (D5). tenantId NULL = source 'test'.
CREATE TABLE "AiUsageLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tenantId" INTEGER,
    "chatId" INTEGER,
    "source" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "primaryModel" TEXT,
    "viaFallback" BOOLEAN NOT NULL DEFAULT false,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "errorCode" TEXT,
    "rateInput" REAL,
    "rateCached" REAL,
    "rateOutput" REAL,
    "costUsd" REAL,
    "wouldCostUsd" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable -- index query dashboard (per hari + per tenant)
CREATE INDEX "AiUsageLog_createdAt_idx" ON "AiUsageLog"("createdAt");
CREATE INDEX "AiUsageLog_tenantId_createdAt_idx" ON "AiUsageLog"("tenantId", "createdAt");

-- CreateTable — rate per-model (per 1M token, USD; manual-editable di Pengaturan SA)
CREATE TABLE "AiModelRate" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "model" TEXT NOT NULL,
    "inputPerM" REAL NOT NULL,
    "cachedPerM" REAL,
    "outputPerM" REAL NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    "updatedById" INTEGER
);
CREATE UNIQUE INDEX "AiModelRate_model_key" ON "AiModelRate"("model");

-- AlterTable — kurs USD→IDR utk render Rp (dihitung saat render, bukan disimpan — D6)
ALTER TABLE "AiConfig" ADD COLUMN "usdToIdr" REAL NOT NULL DEFAULT 16000;