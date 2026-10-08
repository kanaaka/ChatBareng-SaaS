# Spec v4.6.7 — Chat List "Mine": ZONA FLOAT untuk chat claimed-but-unanswered (baru take = paling atas)

**Status:** APPROVED 2026-10-08 09:21 (Kanaka order build + PAT diberikan; semua keputusan terkunci di §K)
**Tipe:** BE sort-logic + FE chip kecil — **NO schema change, NO migration, NO API baru** (semua kolom yang dibutuhkan SUDAH ADA: `lastAssignedAt`, `firstResponseAt`, `firstAssignedAt`)
**Origin:** lapor Kanaka 09:05 — agent take 10 chat → balas semua → take chat ke-11 → chat ke-11 nyempil DI BAWAH (kalah timestamp dari chat yang di-reply). Posisi "baru take" = kejadian penting (jadi tanggung jawab SEKARANG) tapi tidak terukur oleh `lastMessageAt`.

---

## K — Keputusan Terkunci (Kanaka 09:10 + 09:16)

1. **Zona float:** chat claimed yang **belum pernah di-reply agent** (`firstResponseAt == null`) → tampil DI PALING ATAS list "Mine" user tersebut, **sort `lastAssignedAt` DESC** (terbaru take = paling atas; urutan dalam batch = tak penting — sekali aksi).
2. **Graduate:** begitu agent melakukan **balasan manual pertama** ke chat itu (`firstResponseAt` terisi di route reply) → chat keluar zona float → masuk urutan normal existing (`lastMessageAt` desc). TIDAK ada pengecualian khusus AR/scheduler: AR memang tidak menyentuh chat assigned (invariant v0.13.3, terverifikasi) dan tidak meng-set `firstResponseAt` — jadi graduate HANYA oleh reply manual agent (termasuk reply yang menghasilkan outgoing; quoted/template/media = tetap reply → graduate).
3. **Re-claim (release → take lagi / transfer balik):** `lastAssignedAt` ke-update ulang saat setiap assignment (SUDAH begitu di kode — single & batch & transfer) → chat yang re-claim naik ke atas zona float lagi (masih tanpa reply). Konsisten: "waktu jadi tanggung jawab gue sekarang".
4. **Isolasi & scope:** hanya jalur view **"Mine" milik agent** (assignedToId = current_user). Admin "All"/unassigned/queue/history/export = TIDAK berubah (tetap timestamp normal). Per-agent tidak saling mengganggu.
5. **Persist:** posisi disimpan via kolom DB (`lastAssignedAt`) — refresh/restart/ganti device = posisi tetap (bukan state client).
6. **UI:** chat di zona float diberi **chip halus "🆕 Baru diambil"** di card-nya (chip hilang otomatis setelah graduate) — 1 class conditional FE.
7. **Pes baru dari pelanggan (inbound) ke chat yang masih di zona float:** TIDAK mengubah posisi (tetap di zona float sesuai `lastAssignedAt`) — badge unread tetap jalan seperti biasa. (Kanaka: "biar gak ribet".)

## D1 — Perubahan BE (src/routes/chats.js — jalur list "Mine")

- Di handler GET list chats untuk `filter === 'mine'` (dan jalur ekivalen milik-agent — cek semua yang pakai `orderBy lastMessageAt desc` untuk view agent: baris 140 & 428 → satukan di satu helper):
  1. Query dua zona (single round-trip bila mudah): 
     - `FLOAT = { assignedToId: user.id, status: open, firstResponseAt: null }` orderBy `lastAssignedAt desc`
     - `NORMAL = { assignedToId: user.id, firstResponseAt: { not: null } }` orderBy `lastMessageAt desc` (logic existing, TIDAK diubah)
  2. Gabungkan: `[...FLOAT, ...NORMAL]` (paging cursor/pagination existing ikut sesuaikan — kalau pagination numeric/slice, zona float selalu duluan, sisanya paging normal; kalau pagination berbasis cursor lastMessageAt, split jadi 2 cursor atau sederhanakan: ambil kombinasi limit lalu sort ulang in-memory — pilih paling minimal-diff yang aman; prioritas: 0 regresi paging).
- Tambah field virtual di response: `inFloatZone: true` bila `firstResponseAt == null && lastAssignedAt != null` (buat UI chip).
- TIDAK menyentuh: `search-all`, `/:id`, analytics, purge, history import, socket `queue_update` (tidak berubah — antrean count tidak terkait).
- **WAJIB komentar kode** di atas helper: referensi spec ini + invariants (AR tak sentuh assigned; graduate = firstResponseAt).

## D2 — Perubahan FE (frontend Dashboard.vue "Mine" list + card component)

- Render urutan langsung dari response (server sudah kirim sesuai zona — FE cukup ikut urutan; TIDAK ada sort FE tambahan).
- Chip: `v-if chat.inFloatZone` → badge kecil "🆕 Baru diambil" (warna: amber/hijau tipis; hilang pas graduate — refresh akan tanpa chip otomatis karena server kirim `inFloatZone:false`).
- GAK ada perubahan lain (unread badge/toast notif/klik/chatDetail tetap).

## D3 — E2E (scripts/e2e-v467-floatzone.cjs — pola e2e existing: copy-DB + port test + WA off)

1. Setup: tenant + admin + 2 CS (csA, csB) + 8 chat unassigned + AR-off.
2. csA take 5 (batch) → GET mine(csA): kelima tampil; urut = lastAssignedAt desc (batch: mtime sama ~ sama detik — toleransi & determinisme: urutan stable (secondary key id desc)).
3. csA reply manual ke 2 dari 5 (outbound via API reply) → `firstResponseAt` terisi; GET mine: 2 yang kerespon TIDAK lagi di zona float; 3 sisanya tetap di atas (paling atas dulu sesuai take terakhir).
4. csB punya 2 chat "Mine" sendiri (dibuat lebih awal + lastMessageAt lawas) → GET mine(csB): isolasi tetap (csA gak melihat chat csB); csB list urut normal.
5. Posisi persist: GET mine ulang (simulasi refresh) → zona float tetap (urutan sama) — bukan state client.
6. Chat float menerima inbound baru (simulasi pesan masuk via API/DB update lastMessageAt+message insert TANPA reply agent) → posisi tetap di zona float (urutan gak berubah), unreadCount naik.
7. Pusat/admin view "All": urutan = lastMessageAt desc semua (TIDAK ada zona) — regressi guard.
8. Take ulang re-claim: release csA → chat kembali antrean → csA take lagi → lastAssignedAt baru → muncul teratas zona float (masih tanpa reply).
9. Regresi: AR tidak memproses chat assigned (invariant v0.13.3) — tak berubah; queue count tetap (take mengurangi antrean seperti biasa).
10. Search-all & analytics: tidak terpengaruh (sanity 200).

## D4 — Acceptance & deploy

- [ ] e2e 10 kasus PASS + regresi e2e existing (v399/v394/v395/v396/v399 + v470 systemlog smoke) PASS
- [ ] build frontend sukses (chunk Dashboard)
- [ ] docs/qa-v4.6.7-floatzone.md + CHANGELOG entri penambahan patch line (nomor final: v4.6.7; tanpa bump structure; "(chat list take-first ordering)")
- [ ] commit lokai RAPI: 1 commit `feat(v4.6.7): chat list take-first ordering (float zone) — Mine list: claimed-unanswered on top by lastAssignedAt` (NO push — Alita yang ship ke IT)
- [ ] NO migration; NO destructive ops; prod 5047 tidak disentuh (test di copy-DB port lain)

---

### Catatan eksekusi
- Dory: baca spec + kode jalur `filter==='mine'` (baris 140/428) → implement minimal diff → e2e → lapor.
- Alita (pasca laporan Dory): review → QA playground → mirror ship ke IT (pola PR: graft 1 commit atas main IT — PAT sudah ada di chat 09:21 dari Kanaka: ghp_5AU…elw8, gunakan via VAR shell; scrub pasca).