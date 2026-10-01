-- v4.1.2 — CB-AI Handoff + Upselling + Disclaimer (spec docs/spec-v4.1.2-handoff-upsell-disclaimer.md §D1/D2/D3/D6).
-- MIGRATION ADDITIVE-ONLY (SATU migration): 3 ADD COLUMN AutoReplyConfig + 1 ADD COLUMN Chat.
-- ZERO DROP / ZERO destruktif → kode lama aman (kolom baru default false/null = perilaku v4.1.1 persis).
-- Copy-DB E2E: apply SQL manual + record checksum + bookkeeping _prisma_migrations
-- (pola proven v3.9.x/v4.0.0/v4.1.0/v4.1.1). Prod: `npx prisma migrate deploy`.
ALTER TABLE "AutoReplyConfig" ADD COLUMN "cbaiUpsellEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AutoReplyConfig" ADD COLUMN "cbaiUpsellDocId" INTEGER REFERENCES "AiKnowledgeDoc"("id") ON DELETE SET NULL;
ALTER TABLE "AutoReplyConfig" ADD COLUMN "cbaiDisclaimer" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Chat" ADD COLUMN "lastHandoffNotifiedAt" DATETIME;