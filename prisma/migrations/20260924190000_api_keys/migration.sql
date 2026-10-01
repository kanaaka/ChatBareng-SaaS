-- v3.9.13 — Public API v1: ApiKey per-tenant + plan gate featApiAccess.
-- MIGRATION ADDITIVE-ONLY: CREATE TABLE baru + ALTER TABLE ADD COLUMN.
-- TIDAK ada kolom/tabel lama yang diubah/dihapus. Aman utk prisma migrate deploy.

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tenantId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "scopes" TEXT NOT NULL,
    "planGated" BOOLEAN NOT NULL DEFAULT true,
    "ratePerMin" INTEGER NOT NULL DEFAULT 60,
    "lastUsedAt" DATETIME,
    "expiresAt" DATETIME,
    "revokedAt" DATETIME,
    "createdByUserId" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApiKey_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ApiKey_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "ApiKey_tenantId_idx" ON "ApiKey"("tenantId");

-- AlterTable — v3.9.13: plan gate Public API (max=true; lite/pro default false)
ALTER TABLE "TenantPlan" ADD COLUMN "featApiAccess" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable — v3.9.13: audit sumber event (null = jalur lama; 'api' = Public API v1)
ALTER TABLE "ChatEvent" ADD COLUMN "source" TEXT;