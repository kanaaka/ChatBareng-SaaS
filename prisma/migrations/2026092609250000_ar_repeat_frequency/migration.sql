-- v4.0.0a hotfix (QA Kanaka 09:15) — repeatFrequency PINDAH ke AutoReplyConfig (D10).
-- Kolom NULLABLE: row lama (belum di-save via UI baru) = NULL → runtime fallback ke
-- MenuGatewayConfig.repeatFrequency (setting lama tetap hidup — back-compat).
-- MIGRATION ADDITIVE-ONLY (1 ADD COLUMN, 0 DROP/destruktif).
ALTER TABLE "AutoReplyConfig" ADD COLUMN "repeatFrequency" TEXT;
