-- v4.4.0 — Tag exclude-from-queue (silent block)
-- (spec docs/spec-v4.4.0-blue-ticks-take-tag-exclude-resolve.md F3).
-- MIGRATION ADDITIVE-ONLY: 1 ADD COLUMN Tag. ZERO DROP / ZERO destruktif.
-- Default false = perilaku v4.3.x persis (tidak ada tag yang mengecualikan antrean).
-- Prod: `npx prisma migrate deploy` (pola proven v3.9.x..v4.1.2.1).
ALTER TABLE "Tag" ADD COLUMN "excludeFromQueue" BOOLEAN NOT NULL DEFAULT false;
