# Spec v3.9 — Multi-Nomor WA per Tenant (Pool / Assigned / Mix)

> Request owner (Kanaka) 2026-09-23 18:15. Basis: v3.8 (commit 810dd24).
> ⚠️ SPEC DRAFT — menunggu approval owner sebelum eksekusi (Dory).
> Fitur arsitektur terbesar sejauh ini (pool rework + routing per-sender).

## 0. Prinsip kompatibilitas (HARD RULE)
- Tenant dengan **1 nomor** + mode apapun → **behavior identik dgn sekarang** (zero change).
- Existing tenants (Parahita, Mazaya) otomatis: 1 slot, mode=pool → tidak ada perubahan yang terasa.
- Semua fitur lama (antrean, LID mapping, CSAT, greeting) tetap jalan per-slot.

## §1 — Schema (ADDITIVE)

```prisma
model TenantNumber {          // BARU — slot nomor WA per tenant
  id        Int   @id @default(autoincrement())
  tenantId  Int
  slot      Int   @unique([tenantId, slot])  // 0 | 1 | 2 (maks 3)
  label     String?                    // nama bebas: "CS Utama", "Sales", ...
  waSessionDir String?                 // default: tenant-<id>/slot-<slot>
  // mode per nomor (khusus mode MIX):
  routeMode String  @default("pool")   // pool | assigned (khusus slot dgn assign)
  assignedAgentId Int?                // slot assigned → agent ini
  createdAt DateTime @default(now())
}
model Tenant {
  // ... existing
  waMode         String  @default("pool")   // pool | assigned | mix
  maxNumbers     Int     @default(1)        // dari plan; hard cap 3
}
// TenantPlan: + maxNumbers Int?  (null = 1; max 3 — kuota di level plan)
// MenuGatewayConfig & AutoReplyConfig: + numberSlot Int?  (null = "link all")
// Blast: + numberSlots JSON? (pilihan nomor) + rotateEvery Int?  (null = fixed slot)
// Chat: + numberSlot Int? (slot asal pesan masuk — utk reply via nomor yang sama)
// AuditLog: slot context utk aksi pairing/logout
```

## §2 — Pool & routing (inti fitur)

**pool.js rework:** `pool = Map<tenantId, slot[]>` — `slot-0` = slot utama (existing session dir
`tenant-<id>` dipertahankan supaya sesi eksisting gak putus). Semua API existing
(`getStatusForTenant`, `sendMessageForTenant`, dst) → tetap jalan, **default ke slot-0**;
API baru berbentuk `...ForNumber(tenantId, slot, ...)`.

**Connect/pairing per slot:** QR/pairing code per slot (halaman Admin WhatsApp jadi tab/list
per nomor). Logout per-slot. Disconnect satu slot gak ganggu slot lain.

**Inbound routing (per pesan masuk):**
- Semua nomor menerima → set `Chat.numberSlot` = slot asal → routing mode:
  - **pool** → alur antrean existing TANPA perubahan (sumber multi-nomor transparan utk CS)
  - **assigned** → chat langsung assigned ke agent yang di-assign ke slot tsb (born-assigned,
    pola grup PIC v0.14.0; gak masuk antrean umum) + notif ke agent tsb
  - **mix** → per-slot: slot dgn `assignedAgentId` = assigned, sisanya pool
- **Reply routing:** CS balas chat → keluar via nomor yang sama dgn chat masuk (jendela 24-jam).
**Slot asal mati saat reply (owner 18:24):** JANGAN fallback ke nomor lain — pesan tetap harus keluar via nomor yang menerima; kalau slot mati → kirim GAGAL dengan pesan jelas ke CS ("nomor pengirim mati — nyalakan nomor <label> dulu"), gak silent, gak ganti nomor.

**Outgoing initiator (CS initiate chat / blast):** pilih slot (default slot-0).

## §3 — Auto-Reply & Menu Gateway per-nomor
- Config per slot: UI dropdown "Terapkan ke: Semua nomor (linked) / Nomor ini saja".
- `link all` = 1 config untuk semua slot (default, = behavior sekarang).
- Per-nomor = row config per slot (`numberSlot` terisi). Runtime: resolve config slot →
  fallback config shared (null) → disabled.

## §4 — Blast
- Form blast: pilih nomor (multi-select) + opsi **rotate tiap N pesan** (N ≥ 1; off = fixed slot).
- Rotasi round-robin antar slot TERPILIH yang connected; slot mati di-skip + warning di log blast.
- `BlastLog` + `senderSlot` (audit nomor pengirim per baris).

## §5 — Superadmin
- Plan: field **Maks. Nomor WA** (0–3; null/0 = 1 default? → KEPUTUSAN: null = 1, supaya kuota
  eksplisit "0/1/2/3"; hard cap 3 di semua jalur).
- UI kartu tenant: daftar slot (label + nomor + status connect per-slot via polling yang sudah ada).
- API: `GET/POST/DELETE /api/sa/tenants/:id/numbers` (cap dgn plan.maxNumbers, 403 bila lebih).
- Tenant UI (Admin → WhatsApp): tab/daftar slot; connect/QR/pairing/logout per slot; label edit.

## §6 — Keputusan default (owner bisa override)
1. **Chat terpisah per nomor** untuk kontak yang sama (JID beda per sesi; merge = risiko duplikat
   "Berliana" lagi — gak digarap di v3.9).
2. **Assigned + agent offline** → chat tetap ditempel ke agent tsb (personal queue), gak di-reassign.
   **Opsi reassign (owner 18:24):** ada tick "reassign ke CS lain kalau agent assigned offline" di
   halaman Admin WhatsApp per-slot — default OFF (gak di-reassign).
3. **Slot mati saat reply** → gak fallback (lihat §2) — pesan ditolak dengan pesan jelas.
   Fallback = pelanggaran aturan "balas via nomor penerima" (owner 18:24).
4. **Kuota nomor dihitung slot yang ADA** (bukan yang ter-connect) — nomor di-disconnect tetap
   ngitung slot.
5. Polling superadmin 15s yang sudah ada (v3.8) dipakai — tiap slot punya status sendiri.

## §7 — QA (tenant dummy self-purge, pola v3.6–3.8)
1. Tambah slot-1 & slot-2 (label + QR masing-masing; verify sesi terpisah di disk)
2. Pool mode: 3 nomor → pesan masuk → antrean umum sama; reply via slot asal
3. Assigned: slot-1 → agent A; pesan masuk via slot-1 → born-assigned ke A (gak lewat antrean)
4. Mix: slot-0 pool, slot-1 assigned, slot-2 pool → masing-masing sesuai
5. Auto-reply: link-all → semua slot; per-nomor → hanya slot itu yang kena
6. Blast: pilih 2 slot + rotateEvery=2 → urutan pengirim round-robin terverifikasi di BlastLog
7. Superadmin: kuota (maxNumbers=1 → slot kedua ditolak 403); naikkan kuota → bisa
8. Regression: tenant 1-nomor lama = zero change (Parahita/Mazaya); v3.8 expired guard tetap jalan

## Constraints (WAJIB)
- 🚫 NEVER `prisma db push --force-reset` / `--accept-data-loss` / DROP / rm DB. Backup DB
  ber-timestamp sebelum push (additive saja). Verify counts.
- Sesi WA slot-0 = path lama (`tenant-<id>`) — JANGAN migrasi/break sesi existing.
- Restart 5047 by-PID 1x; health 200; t4/t8 reconnect (atau QR ready) sebelum lapor.
- fisio 8770 & portable jangan disentuh. NO git commit (review Alita).
- Report: `docs/report-v3.9.md` + ringkas di reply final.
---

# ADDENDUM K1-A — Chat Terpisah Beneran per Slot (owner locked 2026-09-23 20:27)

> **Keputusan owner (20:27):** "Harus terpisah beneran biar nggak menimbulkan error di kemudian hari... Fix model itu yaaa." — Opsi A dipilih: 1 kontak × 3 nomor = 3 chat terpisah. Ini MENIMPA batasan M1 (1 chat/kontak). Re-audit penuh wajib pakai Kimi-K3 setelah fix.

## A. Identitas chat
1. **Chat unik per (tenantId, numberSlot, waJid)** — ganti `@@unique([tenantId, waJid])` → `@@unique([tenantId, numberSlot, waJid])`.
2. `Chat.numberSlot` jadi **NOT NULL default 0** + backfill `null → 0` (chat lama = milik slot-0). Prisma menolak compound key dgn NULL (lesson v3.9.1) — makanya wajib NOT NULL.
3. Kontak sama yang chat lewat 2 nomor beda tenant = **2 baris Chat berbeda**, masing-masing `numberSlot`-nya tetap (TIDAK toggle mengikuti pesan terakhir).

## B. Routing inbound (pool.js)
4. LID↔phone two-way routing (v3.5/v3.5.1) TETAP jalan, tapi **di-scope per slot**: resolve LID→phone dulu, lalu find-or-create chat by (tenantId, numberSlot, resolvedJid). Merge LID inline hanya antar chat DALAM slot yang sama — JANGAN pernah merge chat lintas slot.
5. Pesan masuk di slot N TIDAK PERNAH menyentuh/mengubah chat milik slot lain (termasuk unread/queue state).

## C. Kontak (model Contact) — identity per phone, bukan per chat
6. Contact TETAP identity per (tenantId, phone) — 1 orang = 1 kontak (blast/tags/CSAT/notes gak boleh dobel).
7. `Contact.chatId @unique` → maknanya **primary chat** (chat terakhir aktif kontak itu). Semua lookup by-chat (`/api/contacts/by-chat/:chatId`) HARUS fallback: by chatId → tidak ketemu → by phone chat itu (lintas slot OK).
8. `contactRelink` (v3.7): re-link tetap by-phone tenant-scoped, target = chat yang sedang aktif (jadi primary). Hapus chat + kontak: kalau kontak masih link ke chat lain milik slot lain → kontak DIPERTAHANKAN (jangan buang identitas).

## D. Reply & send path
9. Reply SELALU via `chat.numberSlot` (sudah jalan di v3.9.1 — pertahankan, no-fallback).
10. Start-chat dari kontak (POST /open) → default slot-0, kecuali UI kirim `numberSlot`.
11. Blast/CSAT/scheduler/autoreply/gateway: pakai path existing per-slot (v3.9) — tidak berubah, TAPI blast & CSAT target chat tetap per-chat (jid sama, slot beda = baris chat beda).

## E. UI
12. Chat list & header chat: badge kecil nomor asal (label slot) di tiap chat — user harus selalu tau chat ini lewat nomor mana.
13. Kontak page: 1 kontak per orang; detail kontak boleh menampilkan daftar chat-nya (nice-to-have, boleh menyusul).
14. Admin WhatsApp: slot list + label + QR per slot (sudah ada) — tambah indikator jumlah chat per slot di daftar slot (nice-to-have).

## F. Migration & safety
15. Backup DB SEBELUM db push (SUDAH: backup/saas-v3-backup-20260923-2036-pre-k1a.db).
16. db push additive: kolom numberSlot NOT NULL default 0 + backfill + ganti unique index. ❌ DILARANG --force-reset/--accept-data-loss/DROP. Kalau Prisma minta destructive → STOP & lapor.
17. Zero-change tenant 1-nomor: Parahita #4 & Mazaya #8 (semua chat numberSlot 0) — perilaku identik sebelum/sesudah.
18. Slot yang masih punya chat → DELETE slot ditolak 409 dgn pesan jelas (pilih logout saja, atau pindahkan chat manual). Update endpoint DELETE tenant-side & SA.

## G. Acceptance
19. Test E2E (tenant dummy): kontak X chat ke nomor A & nomor B → 2 chat terpisah, reply masing-masing via nomor masing-masing, queue pool mode menggabungkan keduanya, assigned mode route per slot.
20. Chat lama (pre-v3.9) tetap kebaca & ke-reply via slot-0.
