-- v4.0.0 — ChatBareng AI (CB-AI) Knowledge Auto-Reply (spec docs/spec-v4.0.0-cbai-knowledge.md §4).
-- MIGRATION ADDITIVE-ONLY (SATU migration): 1 CREATE TABLE + 8 ADD COLUMN. TIDAK ada
-- kolom/tabel lama yang diubah/dihapus (0 DROP) → kode lama aman membaca DB baru
-- (SQLite abaikan kolom asing) = rollback 2 lapis (spec §11). Default semuanya
-- OFF/text → perilaku existing 100% terjaga sampai tenant menyalakan sendiri.
-- Shadow-replay fresh-clone rusak (legacy) → di copy DB: apply SQL manual + record
-- checksum (pola proven v3.9.14/v3.9.23/v3.9.24/v3.9.25). Prod: `npx prisma migrate deploy`.

-- ── Tabel BARU: dokumen knowledge per-tenant (closed-book KB, D1/D2) ──
CREATE TABLE "AiKnowledgeDoc" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tenantId" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL DEFAULT 'file',
    "fileName" TEXT,
    "content" TEXT NOT NULL,
    "charCount" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT 1,
    "updatedById" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "AiKnowledgeDoc_tenantId_label_key" ON "AiKnowledgeDoc"("tenantId", "label");
CREATE INDEX "AiKnowledgeDoc_tenantId_idx" ON "AiKnowledgeDoc"("tenantId");

-- ── AutoReplyConfig + 3 kolom (D3/D4/D5) ──
-- Mode balasan di luar jam: "text" (perilaku lama) | "cbai" (AI jaga malam)
ALTER TABLE "AutoReplyConfig" ADD COLUMN "outsideHoursMode" TEXT NOT NULL DEFAULT 'text';
-- Budget balasan AI per chat per jendela 24 jam (1..10; default 3)
ALTER TABLE "AutoReplyConfig" ADD COLUMN "cbaiLimit" INTEGER NOT NULL DEFAULT 3;
-- Footer "(info per <tgl>)" di jawaban AI — default ON
ALTER TABLE "AutoReplyConfig" ADD COLUMN "cbaiInfoFooter" BOOLEAN NOT NULL DEFAULT 1;
-- (greetMode: kolom existing — value "cbai" ditambahkan di layer app, tanpa ALTER)

-- ── Chat + 2 kolom (window 24 jam + counter shared CB-AI & gateway-knowledge, D5/D6) ──
ALTER TABLE "Chat" ADD COLUMN "aiReplyCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Chat" ADD COLUMN "lastAiReplyAt" DATETIME;

-- ── MenuGatewayOption + 2 kolom (D9 all-in-one: per-opsi answerMode + scope KB) ──
ALTER TABLE "MenuGatewayOption" ADD COLUMN "answerMode" TEXT NOT NULL DEFAULT 'text';
ALTER TABLE "MenuGatewayOption" ADD COLUMN "aiDocIds" TEXT NOT NULL DEFAULT '';

-- ── TenantPlan + 1 kolom (plan gate CB-AI; preset Lite ✗ / Pro ✓ / Max ✓ di plans.js — D8) ──
ALTER TABLE "TenantPlan" ADD COLUMN "featAiKnowledge" BOOLEAN NOT NULL DEFAULT 0;