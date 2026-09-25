-- v3.9.23 — AI Chat Summary (Ollama Cloud): AiConfig singleton + TenantSummaryTemplate.
-- MIGRATION ADDITIVE-ONLY: 2 CREATE TABLE baru. TIDAK ada kolom/tabel lama yang
-- diubah/dihapus. Aman utk prisma migrate deploy.
-- Shadow-replay fresh-clone rusak (legacy) → di copy DB: apply SQL manual + record
-- checksum (pola proven v3.9.14). Prod: `npx prisma migrate deploy` saat release.

-- CreateTable — singleton platform (row id=1; apiKeyEnc ciphertext helper textCrypto)
CREATE TABLE "AiConfig" (
    "id" INTEGER PRIMARY KEY DEFAULT 1,
    "cloudBaseUrl" TEXT NOT NULL DEFAULT 'https://ollama.com',
    "cloudModel" TEXT NOT NULL DEFAULT 'glm-5.3-flash',
    "apiKeyEnc" TEXT,
    "localBaseUrl" TEXT NOT NULL DEFAULT 'http://127.0.0.1:11434',
    "localModel" TEXT,
    "fallbackEnabled" BOOLEAN NOT NULL DEFAULT false,
    "defaultPreset" TEXT NOT NULL DEFAULT 'standard',
    "updatedAt" DATETIME NOT NULL,
    "updatedById" INTEGER
);

-- CreateTable — template summary per-tenant (admin tenant mandiri)
CREATE TABLE "TenantSummaryTemplate" (
    "tenantId" INTEGER PRIMARY KEY,
    "presetKey" TEXT NOT NULL DEFAULT 'standard',
    "customText" TEXT,
    "updatedAt" DATETIME NOT NULL,
    "updatedById" INTEGER
);