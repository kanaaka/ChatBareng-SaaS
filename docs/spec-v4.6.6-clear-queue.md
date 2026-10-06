# Spec v4.6.6 — Admin Clear Queue (kosongkan antrean: bulk-assign + bulk-resolve per tenant)

**Status:** APPROVED 2026-10-06 08:58 (Kanaka order: fitur clear queue buat admin tenant → ship ke IT via PR, pola mirror biasa)
**Tipe:** BE + FE kecil — NO schema change, NO migration (pola penambahan patch line)
**Origin:** lapor Kanaka 08:58 — prod IT (wa.labparahita.co.id) pasca deploy v4.6.4/v4.6.5: aliran pesan nyata akhirnya ter-trigger → 565 chat nyangkut di antrean, tidak ada yang take. Solusi: tombol **self-serve** di UI admin tenant: "Kosongkan Antrean" → semua chat antrean di-assign ke admin + dianggap solved. Vendor (kita) tidak perlu main peran tiap kali — staff IT bisa start fresh sendiri.
**Prinsip:** perilaku = SEMANTIK "resolved oleh admin" yang legitim: chat hilang dari antrean (count turun ke 0), muncul di history resolved, dan **TIDAK memicu CSAT**.

---

## A1 — Endpoint: `POST /api/chats/clear-queue` (`src/routes/chats.js`, mount /api/chats existing)

- **Gate:** `...rt` + `requireAdmin` (CS/relay → 403; admin tenant OK; superadmin via impersonation OK).
- **Body:** `{ confirm: true }` **WAJIB** (tanpa itu → 400 " confirmation required" — benteng dari double-click/preview request).
- **Set definisi antrean = SATU sumber kebenaran:** pakai langsung `queue.queueWhere(req.tenantId)` dari `src/socket/queue.js` (jangan tulis ulang definisi!) — set yang di-clear = set yang dihitung sebagai "565". Dua-duanya gak akan pernah beda.
- **Ukuran & cap:** `findMany({ where: queueWhere, select: { id, csMessagesSent, snoozedUntil, menuState, assignedToId } })`.
  - Semua ≤ 2000 → proses semuanya.
  - > 2000 → proses 2000 TERBARU (order lastMessageAt desc), response kasih `remaining`; UI tombolnya tetap hidup buat klik berikutnya (rolling clear).
- **Per-chat update (loop pola BatchResolve):**
  ```
  data: {
    status: 'resolved',
    resolvedAt: now,
    resolvedById: req.user.id,          // admin yang klik tombol
    assignedToId: req.user.id,          // "di-assign ke admin" sesuai semantik Kanaka
    messagesBeforeResolve: chat.csMessagesSent || 0,
    ...(chat.snoozedUntil ? { snoozedUntil: null, snoozedBy: null } : {}),
    ...(chat.menuState === 'awaiting' ? { menuState: 'done', menuRequestedAt: null } : {}),
  }
  ```
  (limbo clear & snooze clear = safety net yang sama dengan single-resolve v3.9.8 — konsisten.)
- **❌ JANGAN panggil `csat.createSurveyAfterResolve`** — ini jebakan utama: 565 chat fake = 565 CSAT survey nyasar ke kontak nyata + meracuni dashboard CSAT. Clear queue = housekeeping, BUKAN pengalaman customer.
- **Emit (chunked anti-flood):** kelompokkan per 100 chat: per-chat `broadcast.emitToTenant(tenantId,'chat_update',{chatId,status:'resolved',resolvedAt,resolvedById,bulkCleared:true})` + `sleep 50ms` antar chunk. Setelah semua: SATU `queue.emitQueueUpdate(tenantId)` + SATU `menu_waiting_update` bila ada limbo yang dibersihkan (pola BatchResolve).
- **Response:** `{ cleared: <jumlah>, skipped: [...{chatId,reason}], remaining: <0|n> }`
- **SystemLog breadcrumb (pola v4.6.5, WAJIB):** `sysLog.logInfo(\`[ClearQueue] user=X cleared=N tenant=T remaining=R\`, { module:'chat', tenantId, meta:{ cleared, remaining, skipped: skipped.length } })` + tetap `console.log` (passthrough).
- **Error handling:** per-chat try/catch → skipped (pola BatchResolve); global catch → 500 + console.error (otomatis ke-log via layer v4.6.4).

## A2 — UI ("Kosongkan Antrean" di area Antrean admin)

- Lokasi: area/tab Antrean di dashboard admin (temukan komponen queue/antrean — satu-satunya tempat admin melihat "565 chat baru"). Tombol hanya tampil untuk role `admin`.
- Modal konfirmasi (2 langkah): angka live count ("Kosongkan 565 chat dari antrean?" + penjelasan "semua akan diresolusi & di-assign ke kamu (admin), TIDAK mengirim pesan/CSAT ke pelanggan") → klik "Ya, kosongkan" → POST dengan `confirm:true`.
- Pasca-sukses: toast "N chat diresolusi"; list antrean kosong; count header ikut hilang (queue_update socket) — kalau `remaining > 0`, modal muncul lagi dengan sisa count.
- Empty state guard: count 0 → tombol disabled/hidden.

## A3 — QA log yang harus terbukti

- Row `[ClearQueue]` dgn jumlah cleared benar di Log Sistem (module 'chat').
- TIDAK ADA row CSAT survey baru untuk chat yang di-clear (cek tabel CsatSurvey count sama dgn sebelum aksi).

## B — E2E (`scripts/e2e-clearqueue.cjs`, pattern e2e log-coverage: copy-DB + port test 5099 + WA_DISABLED=1)

1. Setup: tenant uji + admin + CS fixture (pola e2e terakhir), buat 30 chat sintetik masuk kriteria queueWhere (beberapa dengan `menuState='awaiting'`, beberapa snoozed).
2. POST clear-queue TANPA confirm → 400.
3. POST dengan confirm (role cs) → 403.
4. POST confirm (admin) → `cleared=30`, semua chat `status=resolved`, `assignedToId=admin.id`, `resolvedAt` terisi.
5. Chat yang tadinya awaiting → `menuState='done'`; yang snoozed → snoozedUntil null.
6. Queue count pasca = 0 (getQueueCount).
7. **CSAT: 0 survey baru dibuat.**
8. Chat grup (`@g.us`) & kontak excludeFromQueue yang disisipkan TIDAK ikut ter-resolved (definisi queueWhere dihormati).
9. SystemLog: row `[ClearQueue] module=chat` muncul; redaksi OK.
10. Cap: simulasikan 2100 chat (bulk insert) → cleared=2000, remaining=100; klik kedua → 100.
11. Regresi: single-resolve & BatchResolve lama tetap jalan normal.

## C — Acceptance checklist

- [ ] e2e 10+ kasus PASS (copy-DB, port test; produksi tak tersentuh)
- [ ] UI button + modal + count live + post-clear refresh terbukti (dev browser)
- [ ] CHANGELOG entri v4.6.6 "(admin clear queue)" — penambahan patch line, TANPA bump struktur
- [ ] docs/qa-v466-clearqueue.md (checklist + bukti)
- [ ] commit local (NO push — ship via Alita: PR #7 ke IT, pola PR #5/#6)
- [ ] Catatan utk PR body: NO schema/migration; CSAT supaya gak nyasar EXPLISIT disebut