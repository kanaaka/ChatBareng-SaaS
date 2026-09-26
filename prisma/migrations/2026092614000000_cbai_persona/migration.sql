-- v4.1.1 — CB-AI Persona (spec docs/spec-v4.1.1-persona.md §D1/D6).
-- MIGRATION ADDITIVE-ONLY (SATU migration): 3 ADD COLUMN TEXT NOT NULL DEFAULT ''.
-- ZERO DROP / ZERO destruktif → kode lama aman (kolom baru kosong = perilaku v4.1.0 persis).
-- Copy-DB E2E: apply SQL manual + record checksum + bookkeeping _prisma_migrations
-- (pola proven v3.9.x/v4.0.0/v4.1.0). Prod: `npx prisma migrate deploy`.
ALTER TABLE "AutoReplyConfig" ADD COLUMN "cbaiBotName" TEXT NOT NULL DEFAULT '';
ALTER TABLE "AutoReplyConfig" ADD COLUMN "cbaiBotRole" TEXT NOT NULL DEFAULT '';
ALTER TABLE "AutoReplyConfig" ADD COLUMN "cbaiHumanAgentLabel" TEXT NOT NULL DEFAULT '';