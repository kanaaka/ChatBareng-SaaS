# ChatBareng v0.14.0 — Manajemen Grup (PIC Model)

**Status: APPROVED Kanaka (17 Sep 18:02) — IN EKSEKUSI.**
**Eksekutor: Dory (kode) + Alita (deploy/QA/rollback). Rollback siap sebelum satu baris kode diubah.**

## 0. Rollback & Safety (WAJIB DIBACA DORY DULU)

- Snapshot kondisi sekarang: `backup/pre-v0.14.0-grup-20260917-180307/` (DB asli `prisma/data/wa-cs-hub.db` di-backup via sqlite online-backup API: 31 tabel, Chat 17, Message 35, User 6, 0 grup @g.us) + `src/`, `prisma/`, `frontend/src`, `package.json`, manifest md5 `backup/pre-v0.14.0-grup.md5` (70 file).
- Script rollback: `scripts/rollback-v0140.sh` — `--check` (rencana), `--schema-only` (drop tabel/kolom baru), `--full` (restore penuh + restart).
- **LARANGAN KERAS (lesson 2026-08-31, DB ke-wipe):**
  - NEVER `prisma db push --force-reset` / `--accept-data-loss`
  - NEVER `DROP TABLE/COLUMN`, `DELETE FROM` massal, `rm` DB apapun
  - Migration yang BOLEH: `npx prisma db push` untuk perubahan **additive murni** (tabel baru + kolom baru). Kalau tool minta reset/data-loss → **STOP & report**, jangan lanjut.
  - Dory TIDAK me-restart server produksi (Alita yang restart), TIDAK git push/commit.

## 1. Konteks & Fakta Terverifikasi

- Baileys 6.17.16 terpasang; API grup tersedia (verified di `node_modules/@whiskeysockets/baileys/lib/Socket/groups.d.ts`):
  `groupCreate`, `groupFetchAllParticipating`, `groupMetadata`, `groupParticipantsUpdate(jid, participants[], action: promote|demote|add|remove)` (return per-member status — handle partial failure), `groupSettingUpdate(jid, 'announcement'|'not_announcement'|'locked'|'unlocked')`, `groupInviteCode`, `groupRevokeInvite`, `groupUpdateSubject`, `groupUpdateDescription`, `groupJoinApprovalMode(jid,'on'|'off')`, `groupMemberAddMode(jid,'admin_add'|'all_member_add')`.
- Kode existing: chat `@g.us` dikenali (`isGroupChat` di baileys.js); Menu Gateway skip grup; TIDAK ada fitur grup sama sekali.
- DB real: `prisma/data/wa-cs-hub.db` (bukan dev.db yang kosong). Server produksi: port 5030, `node src/server.js`.
- **0 grup @g.us di DB saat ini** → tidak ada migrasi data lama; fitur purely forward.

## 2. Perilaku Existing yang TERKUNCI (hasil verifikasi kode 17 Sep — DORY JANGAN UBAH)

| Perilaku | Fakta di kode |
|---|---|
| Tab Unassigned | Admin-only (`chats.js` v0.1.21: CS → 403 "Filter ini hanya untuk admin") |
| CS & antrean | CS TIDAK melihat antrean sama sekali; hanya angka via `queue_update {count}` |
| Baca chat unassigned | **Admin BISA baca isi** via tab Unassigned |
| Balas chat unassigned | 403 reply-lock TOTAL (admin juga) — `assertTaken` |
| Akses detail chat | `canAccessChat`: admin, pemilik open, atau resolver |
| Limbo Menu Gateway | v0.13.3 invariant: awaiting tidak masuk antrean/list |
| Snooze/Purge/CSAT/Blast | Flow existing utuh |

**Prinsip: fitur grup = jalur BARU di samping jalur 1:1. Endpoint existing hanya dapat field/eksklusi tambahan, tidak ada perubahan shape/behavior.**

## 3. Model Grup (keputusan LOCKED Kanaka)

- **PIC model**: setiap grup punya **1 PIC** (User). PIC = pemilik penuh grup (baca, balas, kelola).
- **Pembuatan**: admin bikin → pilih PIC (default: admin sendiri); CS bikin → **otomatis PIC dia**; **Cabang (relay) tidak bisa bikin** — tombol hidden (bukan disabled).
- **Ganti PIC**: admin only, kapan saja.
- **Cabang boleh dijadikan PIC** oleh admin (tetap gak bisa bikin grup lain).
- **Matriks visibility** (grup = born-assigned, TIDAK PERNAH lewat antrean/take):

| Peran | List grup | Isi chat grup | Notif realtime grup | Kelola (member/setting) |
|---|---|---|---|---|
| PIC | miliknya | ✅ | ✅ | ✅ |
| Admin | semua + yatim | ✅ semua | ✅ | ✅ |
| CS lain | ❌ tidak ada | ❌ 403 | ❌ | ❌ |
| Cabang non-PIC | ❌ tidak ada | ❌ 403 | ❌ | ❌ |

- **Grup yatim** (bot ditambahkan orang dari luar ChatBareng → ada @g.us baru tanpa PIC): muncul HANYA di tab Grup versi admin, badge "belum ada PIC" + tombol assign. Bukan di tab Unassigned (tab itu tetap murni 1:1).
- **Bot bukan admin WA di grup**: aksi manajemen terkunci oleh WhatsApp itu sendiri → UI deteksi & disable dengan hint "Bot bukan admin di grup ini" (bukan error 500). Backend tetap kirim, tangkap error Baileys → 422 `BOT_BUKAN_ADMIN`.

## 4. Schema (ADDITIVE MURNI)

```prisma
// Chat: kolom baru (additive)
picUserId Int?
pic       User? @relation("groupPics", fields: [picUserId], references: [id])

// User: relation balik
groupsAsPic Chat[] @relation("groupPics")

// Message: kolom baru (additive) — pengirim di grup
participantJid String?

// Tabel baru
model GroupActionLog {
  id           Int      @id @default(autoincrement())
  chatId       Int
  actorUserId  Int
  action       String   // create|add|remove|promote|demote|setting|invite_reset|rename|assign_pic
  detail       String?
  createdAt    DateTime @default(now())
}
```

Implementasi kunci: saat grup dibuat/di-adopt → set **BOTH** `picUserId` **AND** `assignedToId = picUserId` → seluruh guard existing (reply-lock, canAccessChat owner branch) otomatis bekerja untuk grup tanpa diubah.

## 5. Endpoint Baru (`src/routes/groups.js`)

- `GET /api/groups` — PIC: miliknya; admin: semua + yatim; lainnya: `[]`. Exclude dari list utama: `GET /api/chats` semua filter dapat `phoneJid: { not: { endsWith: '@g.us' } }` (additive where saja).
- `GET /api/groups/:id` — metadata + members (nama dari Contact bila ada) + `botIsAdmin` flag. Access: PIC/admin saja.
- `POST /api/groups` — create (subject, description?, participants[]?, picUserId? admin-only field). CS → self PIC. Relay → 403.
- `PATCH /api/groups/:id` — rename/description (PIC/admin, bot admin required).
- `POST /api/groups/:id/members` — `{phones[], action: add|remove|promote|demote}` → respons per-member `{phone, status, error?}` (partial failure friendly).
- `POST /api/groups/:id/settings` — `{announcement?, locked?, approval?, memberAddMode?}`.
- `POST /api/groups/:id/invite-reset` — revoke+new code (UI confirm wajib — link lama mati).
- `POST /api/groups/:id/assign-pic` — **admin only**; juga mengisi assignedToId.
- Semua aksi → tulis `GroupActionLog`. Semua endpoint group: WA belum open → 503 `WA_BELUM_TERHUBUNG` (UI: banner, bukan error mentah).
- **Socket**: event chat-scoped untuk @g.us hanya ke PIC + admin. `queue_update`/queueWhere **TIDAK disentuh** (0 grup → angka antrean otomatis benar).

## 6. UI

- **Desktop**: nav item "Grup" di sidebar (setelah Kontak) → halaman Grup (list + tombol "+ Buat Grup" di header; hidden untuk relay).
- **Mobile**: di halaman Kontak, segmen "Kontak | Grup" (Homerow TIDAK berubah).
- Detail grup = chat pane existing (bubble + tampil nama/HP participant dari `participantJid`), panel kanan: member list + aksi (role-gated).
- Dialog buat grup: nama, deskripsi, anggota awal (opsional), [admin: dropdown PIC]; CS lihat note "Kamu akan jadi PIC grup ini".
- Semua gaya mengikuti M3 Expressive + pola komponen existing (M3TextField, ConfirmDialog, ToastStack, dll).

## 7. Regression Guard — WAJIB di-self-test Dory + diakui di report

1. CS `GET /api/chats?filter=unassigned` → 403; `filter=all` → fallback mine.
2. `POST` balas ke chat unassigned → 403 (admin juga).
3. CS buka detail chat orang lain → 403.
4. `queue_update` tidak berubah (grup gak masuk hitungan — queueWhere untouched).
5. Menu Gateway limbo invariant utuh.
6. Take/transfer/resolve/CSAT/blast/templates/snooze/purge: no shape change.
7. Endpoint existing tetap lulus dengan payload lama (additive fields only).
8. Grup TIDAK muncul di tab Unassigned maupun list Mine CS lain.

## 8. QA & Deploy (Alita)

1. Dory selesai → Alita review diff + `npm run build` di frontend + restart server produksi (setsid, log /tmp/chatbareng-server.log) + health check 5030.
2. QA di grup uji WA nyata: **"ChatBareng QA Grup"** (Kanaka + nomor bot) — semua aksi dites di situ dulu.
3. **PUSH DITAHAN sampai USER-VERIFIED** (pola v0.13.7). Regression guard §7 dicek ulang di produksi.

## 9. Out of scope (v0.15+ kandidat)

Auto-welcome member baru, blast ke grup, UI approve join-request, multiple PIC per grup.