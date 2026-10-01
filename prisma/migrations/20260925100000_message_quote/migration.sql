-- v3.9.14 — Quote Reply (WhatsApp contextInfo): 4 kolom ADDITIVE nullable di Message.
-- MIGRATION ADDITIVE-ONLY: hanya ALTER TABLE ADD COLUMN. TIDAK ada kolom/tabel lama
-- yang diubah/dihapus. Aman utk prisma migrate deploy.
-- Catatan: SQLite tidak mendukung IF NOT EXISTS untuk ADD COLUMN — script ini
-- TIDAK idempotent (prisma men-track state migrasi, satu kali apply).

-- AlterTable — stanzaId (in) / waMessageId target (out)
ALTER TABLE "Message" ADD COLUMN "quotedWaMessageId" TEXT;

-- AlterTable — full JID penulis pesan yang di-quote (grup; 1:1 null)
ALTER TABLE "Message" ADD COLUMN "quotedParticipantJid" TEXT;

-- AlterTable — snippet ≤200 char terenkripsi (encryptText) — fallback chip saat pesan asal purged
ALTER TABLE "Message" ADD COLUMN "quotedSnippet" TEXT;

-- AlterTable — text|image|video|audio|sticker|document (ikon chip)
ALTER TABLE "Message" ADD COLUMN "quotedType" TEXT;