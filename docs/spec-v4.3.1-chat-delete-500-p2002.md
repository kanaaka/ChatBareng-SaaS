# ChatBareng v4.3.1 — Fix DELETE Chat 500 P2002 (per-slot contact reality) — SPEC

> Status: **GO 2026-10-01 05:51 WIB (Kanaka)** — ticket dari QA real-WA Alita (reports/qa-v4.3.0-2026-10-01.md, Finding #1).
> Builder: Dory • Spec/verifier/deployer: Alita • DB: **NOL perubahan schema** (code-only fix).

---

## 1. Bug (terverifikasi live, prod tenant-10)

`DELETE /api/chats/:id` (mode default, contact KEEP) → **500 P2002** bila nomor pelanggan punya ≥2 chat
di tenant yang sama (contoh nyata: chat 8370 slot0 + chat 8371 slot1, kontak 8184 + 8185).

**Akar (`src/routes/chats.js`):**
- `detachContactKeepIdentity()` (jalur default): sibling chat ada → `tx.contact.updateMany({where:{id, chatId}, data:{chatId: otherChat.id}})` — memindahkan contact ke sibling.
- Asumsi lama v3.9.2 K1-A: SATU contact per nomor (belum per-slot). Sekarang tiap chat auto-punya contact sendiri → `Contact.chatId @unique` → P2002 → transaksi rollback → 500. Chat jadi tak-bisa-dihapus selamanya.
- Path `deleteContact=true` (`deleteContactOnlyIfNotShared()`) TIDAK crash, tapi semantic-nya meleset: sibling selalu punya contact sendiri → identitas TIDAK akan hilang bila contact chat ini dihapus; current code jadi selalu skip delete → FK set-null mengorbankan contact jadi orphan tak-disengaja.

## 2. Keputusan desain (LOCKED)

| # | Keputusan |
|---|---|
| D1 | **Behaviour user-facing NOL perubahan** selain status 500→200: satu orang chat ke 2 slot = TETAP 2 chat terpisah + 2 contact sendiri. Jangan sentuh chat creation, routing balasan per-slot (`sendMessageForTenant {slot: chat.numberSlot}`), atau model data. |
| D2 | `detachContactKeepIdentity()` — sibling ada **dan sibling punya contact sendiri** (`tx.contact.findUnique({where:{chatId: otherChat.id}})`) → JANGAN pindahkan; detach sendiri: `data:{chatId:null}` (pola orphan v3.7 — data identitas utuh, identity tetap terjaga via contact milik sibling). |
| D3 | `detachContactKeepIdentity()` — sibling ada **tanpa contact sendiri** (kasus legacy/langka) → perilaku lama TETAP (move contact ke sibling — merge sah karena sibling memang kosong). |
| D4 | No sibling → orphan (chatId null) — UNCHANGED (byte-compat). |
| D5 | `deleteContactOnlyIfNotShared()` (deleteContact=true) — sibling ada + sibling punya contact sendiri → hapus contact chat ini (intent admin dihormati; identitas nomor tetap hidup via contact sibling). Sibling tanpa contact sendiri → pertahankan identitas: detach ke chatId=null (bukan skip-diam → FK set-null; eksplisit supaya konsisten). No sibling → hapus (unchanged). |
| D6 | Cek SEMUA caller kedua helper (grep; ada pemakaian selain DELETE handler?) — kalau ada, pastikan semantic baru aman untuk semuanya; kalau ada yang butuh perilaku lama, pecah jadi fungsi terpisah JANGAN ubah shared helper diam-diam. |
| D7 | Zero schema/migration change. Zero endpoint shape change (response counts + purgeLog tetap). `P2002` race-safety tetap berlaku (bila terjadi race, transaksi rollback + 500 — fallback natural, dokumentasikan di komentar). |

## 3. QA (wajib sebelum lapor selesai)

1. **QA Server copy-DB** pola resmi: kopet prod DB → `/tmp/saas-v3-e2e-p431.db` → server QA port **5099** + `WA_DISABLED=1`. JANGAN sentuh prod (prod DB, 5047, tunnel, bit.ly — off-limits).
2. **e2e-v431 baru** (kasus minimal 4):
   - S1: nomor sama, 2 chat (slot0+slot1), kedua chat punya contact sendiri → DELETE default → 200; contact chat dihapus = chatId null; contact sibling TIDAK tersentuh; sibling chat utuh.
   - S2: sama, DELETE `?deleteContact=true` → 200; contact chat ini terhapus; contact sibling tetap ada.
   - S3: sibling TANPA contact sendiri → move masih jalan (D3 — regressi perilaku lama).
   - S4: no sibling → orphan chatId=null (D4 — regressi).
3. **Regressi penuh:** e2e-v430 (53) + v421 (54) + v420 (57) + v4121 (61) — semua PASS.
4. Build/boot check server (`node src/server.js` di QA copy) — BE-only, FE build tidak wajib tapi pastikan repo tetap build.

## 4. Laravel-kah? Bukan — kontrak teknis repo ini

- Server: Node/Express + Prisma + SQLite. Stack JANGAN diubah. Bahasa komentar: Indonesia (konsisten codebase).
- **DAUR ULANG DILARANG:** `prisma db push --force-reset` / `--accept-data-loss` / `DROP` / `rm` / reset apapun pada DB mana pun — STOP & report bila tooling menuntut.
- Commit: `fix(v4.3.1): chat delete 500 P2002 — sibling-contact-aware detach/delete (per-slot contact reality)` + JANGAN push/tag (Alita yang audit → deploy → tag).

## 5. Deliverable Dory (lapor balik ke parent session)

1. Daftar file berubah + ringkasan diff.
2. Matrix hasil e2e-v431 + 4 regression suites (PASS/FAIL per suite).
3. Deviasi dari spec (kalau ada + alasan).
4. Jangan sentuh: `wa-cs-hub-saas-v3/prisma/data/saas-v3.db` (prod), server 5047, tunnel, config openclaw.

> Catatan: chat 8370/8371 + contact 8184/8185 di prod = fixture bukti QA live (sengaja dibiarkan `resolved`). Setelah fix di-deploy, ALITA yang hapus sebagai verifikasi prod terakhir — bukan tugas Dory.