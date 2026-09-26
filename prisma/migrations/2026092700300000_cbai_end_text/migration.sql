-- v4.1.2.1 — Hotfix: CB-AI per-slot config merge + "End of AI Replies"
-- (spec docs/spec-v4.1.2.1-cbai-endtext-merge.md §D2).
-- MIGRATION ADDITIVE-ONLY (SATU migration): 1 ADD COLUMN AutoReplyConfig.
-- ZERO DROP / ZERO destruktif → kode lama aman (kolom baru NULL = template bawaan
-- DEFAULT_CBAI_END_TEXT — perilaku v4.1.2 persis).
-- Copy-DB E2E: apply SQL manual + record checksum + bookkeeping _prisma_migrations
-- (pola proven v3.9.x/v4.0.0/v4.1.0/v4.1.1/v4.1.2). Prod: `npx prisma migrate deploy`.
ALTER TABLE "AutoReplyConfig" ADD COLUMN "cbaiEndText" TEXT NULL;