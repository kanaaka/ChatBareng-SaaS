-- Additive migration: Superadmin System Log (v4.6.4 log menu addition)
-- Tabel baru ADD-ONLY — ZERO DROP, zero sentuhan tabel/kolom lama.
-- Spec: docs/spec-superadmin-system-log.md §D1
-- DDL share utk IT: docs/SCHEMA-CHANGES.md (entri v4.6.4)

-- CreateTable
CREATE TABLE "SystemLog" (
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

-- CreateIndex
CREATE INDEX "SystemLog_ts_idx" ON "SystemLog"("ts");

-- CreateIndex
CREATE INDEX "SystemLog_level_ts_idx" ON "SystemLog"("level", "ts");

-- CreateIndex
CREATE INDEX "SystemLog_module_ts_idx" ON "SystemLog"("module", "ts");

-- CreateIndex
CREATE INDEX "SystemLog_tenantId_ts_idx" ON "SystemLog"("tenantId", "ts");