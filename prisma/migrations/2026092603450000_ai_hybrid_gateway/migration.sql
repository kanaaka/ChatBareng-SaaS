-- v3.9.25 — AI Hybrid Gateway Routing: LLM classifier fallback untuk Menu Gateway
-- (spec docs/spec-v3.9.25-ai-hybrid-gateway.md §5). MIGRATION ADDITIVE-ONLY:
-- 4 ADD COLUMN. TIDAK ada kolom/tabel lama yang diubah/dihapus. Default semuanya
-- OFF/empty → perilaku existing 100% terjaga sampai tenant menyalakan sendiri.
-- Shadow-replay fresh-clone rusak (legacy) → di copy DB: apply SQL manual + record
-- checksum (pola proven v3.9.14/v3.9.23/v3.9.24). Prod: `npx prisma migrate deploy`.

-- Toggle per-tenant (default FALSE = perilaku lama, 0 cost, 0 risiko — D5)
ALTER TABLE "MenuGatewayConfig" ADD COLUMN "aiHybrid" BOOLEAN NOT NULL DEFAULT 0;
-- Confidence gate per-tenant (0.50–0.95; slider UI + preset — D3)
ALTER TABLE "MenuGatewayConfig" ADD COLUMN "aiThreshold" REAL NOT NULL DEFAULT 0.7;
-- Deskripsi AI per opsi ≤200 char; kosong → prompt pakai label+aliases (D8)
ALTER TABLE "MenuGatewayOption" ADD COLUMN "aiDescription" TEXT NOT NULL DEFAULT '';
-- Flag plan: preset Lite ✗ / Pro ✓ / Max ✓ (file preset plans.js, bukan migrasi — D5)
ALTER TABLE "TenantPlan" ADD COLUMN "featAiRouting" BOOLEAN NOT NULL DEFAULT 0;