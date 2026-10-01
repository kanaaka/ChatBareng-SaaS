# Spec v4.5.0 — Resolve-Tanpa-Lompat + Multi-Select Batch Actions

> Request Kanaka (2026-10-01 16:46–16:49, GO 16:49): (A) resolve = detail tutup + TETAP di tab sekarang (nggak lompat ke tab Resolved); (B) multi-select chat list + action bar batch (Resolve / Mark Read / Mark Unread).
> **PEMBATASAN: NO migration, NO schema change. Semua pakai kolom existing.**
> **PEMBATASAN BUILD/TEST: server dev BOLEH hanya dengan copy DB `file:/tmp/...` + `WA_DISABLED=1` — DILARANG KERAS boot server dgn DB prod (`prisma/data/*`). DILARANG: commit/push/tag, sentuh port 5047 (hanya smoke 5099), proses lain jangan di-kill.**
> App root: /home/kanakxxx/.openclaw/workspace/wa-cs-hub-saas-v3 · FE build: `cd frontend && npm run build` (HARUS PASS).

## A — Resolve-tanpa-lompat (FE only)

**Fakta terverifikasi:**
- Lokal resolve: `Dashboard.vue handleResolve()` — set status local, TIDAK menutup detail (admin), dan CSA tidak lulus sini.
- Realtime: `Dashboard.vue onChatUpdate(data)` blok `data.status==='resolved'` (~L1656+): untuk CS non-admin yang MELIHAT chatnya resolved (wasMine) → `changeFilter('resolved')` + tutup detail = INI sumber lompatan (juga kena echo resolve sendiri); untuk admin → toast + refetch, detail tetap terbuka.

**Kerjakan (di `onChatUpdate`, blok resolved):**
1. SEMUA role: bila `currentChat?.id === data.chatId` → tutup detail: `currentChat=null; currentMessages=[];` bila mobile `router.replace('/')`; socketStore.leaveChat TIDAK perlu (server-side resolved room handling existing). JANGAN pindah tab (hapus `changeFilter('resolved')` dari cabang wasMine).
2. Toast ✓ "Chat resolved" (existing — pertahankan, di kedua cabang).
3. Refetch list — gabungkan dengan cond `!inList || filter mine/unassigned` existing: cukup `chats.fetchChats(chats.filterParams)` sekali (chat keluar dari Mine; di All/Resolved tampil sesuai tab).
4. JANGAN ubah `handleResolve` (socket echo menutup detail <100ms — satu jalur perubahan saja). JANGAN ubah jalur resolve di Grup/kebab KebabMenu emit.

**Checklist:**[ ] detail menutup saat resolve (sendiri & orang lain)[ ] tetap tab aktif (tidak ada changeFilter)[ ] toast & list refresh[ ] desktop+mobile sama[ ] tidak ada file backend berubah utk A.

## B — Multi-select + batch actions

**Fakta terverifikasi:**
- Row markup: `ChatListPane.vue` (~L180-241) — avatar circle, `@click="$emit('select', chat)"`, long-press handler `onChatTouchStart` (menu context).
- Long-press context menu: markup ~L262-284 + handler `markManualUnread/unmarkManualUnread` ~L399-420; state `showManualUnreadMenu` dst.
- `filteredChats` computed (~L495) — dipakai render list (search text + server-side filters).
- util manualUnread: `add`/`remove`/`list` sudah diimport di pane (v4.1.3.1); toastStore juga sudah (v4.4.0 F3).
- `chats` store: `resolveChat(chatId)`, `markRead(chatId)` ada; BELUM ada batch.
- List server: `take: 100` — select-all scope = tampilan di list sekarang.

**Kerjakan:**
1. State pane: `selectionMode ref(false)`, `selectedIds ref(new Set())` (pakai `chat.id` number/string konsisten dgn `String(chatId)` manualUnread), hover state per-row utk desktop.
2. **Enter selection:**
   - Desktop: hover row → tickbox kecil overlay di pojok kanan-atas avatar (absolute, z di atas dot unread — dot & badge jangan hilang, cuma tickbox menimpa area kosong avatar bila belum dipilih; bila dipilih → tickbox checked tampil permanen). Klik tickbox row mana pun pertama kali → `selectionMode=true` + chat itu terpilih.
   - Mobile: long-press menu — tambah item **"📋 Pilih chat"** (hanya bila belum selectionMode) di atas item "Tandai belum dibaca". Pilih → `selectionMode=true` + target terpilih + menu tutup.
   - Saat `selectionMode`: klik baris = toggle select (TIDAK open chat). Long-press tetap boleh buka menu tapi item "Pilih chat" jadi "Batalkan pilihan" (clear + exit mode bila kosong).
3. **Action bar** (di pane, di bawah blok Filters — tampil hanya `selectionMode`):
   - `[☑ Select all]` checkbox: checked bila SEMUA `filteredChats` terpilih (indeterminate tidak wajib); klik → select semua `filteredChats` / klik lagi → clear.
   - Counter: `{n} dipilih`.
   - Tombol aksi: `[✓ Resolve]` `[📖 Tandai dibaca]` `[🔵 Tandai belum dibaca]` `[✕]` (keluar mode = clear).
   - Disabled state: aksi disabled saat `n==0` atau proses jalan (loading busy guard).
   - Styling: konsisten pane (M3 chip/gaya existing, teks-xs, flex row, gap). Mobile tetap satu baris horizontal-scrollable.
4. **Aksi Backend baru** (`src/routes/chats.js`, mount sama): **perhatikan urutan definition** — taruh SEBELUM `router.get('/:id', ...)` supaya tidak tertelan param route!
   - `POST /api/chats/batch-resolve` `{ chatIds: number[] }` — validasi array 1..100 int. Per item (loop server): cari chat tenant-scoped; izin = MIRROR PERSIS route `POST /:id/resolve` existing (grep cari izinnya — bila ternyata "assignee atau admin", terapkan sama). Boleh → `status='resolved', resolvedAt=now, resolvedById` (ikut bentuk kolom yang dipakai route resolve existing — grep exact field yang di-set di sana; JANGAN mengarang nama kolom); ChatEvent type 'resolved' + 'assigned'-style parity jika route existing menulis event lain — ikuti existing resolve route; `queue.emitQueueUpdate(tenantId)` SEKALI di akhir (bukan per item), broadcast `chat_update` {chatId, status:'resolved', resolvedAt} per item berhasil. Tidak boleh/ter-resolved → kumpulkan skipped {chatId, reason} ('not_allowed'|'already_resolved').
   - `POST /api/chats/batch-read` `{ chatIds: number[] }` — per item: izin = assignee, admin, ATAU resolvedBy? — grep route `POST /:id/read` existing dan COPY policy-nya persis (kalau endpoint read existing terbuka semua session tenant-verified, ikuti itu). Effect: `unreadCount=0`; broadcast `chat_update` {chatId, unreadCount:0} per item. Return {marked, skipped}.
   - KEDUA endpoint WAJIB: ...rt (requireAuth+requireTenant), guard `Array.isArray+every int`, try/catch 500, return JSON `{resolved|marked, skipped:[{chatId,reason}]}`, max 100 ids (lebih → 400).
5. Store `chats.js`: actions `batchResolve(chatIds)` & `batchMarkRead(chatIds)` (axios POST, return data).
6. **Handler aksi di pane:**
   - Resolve: `confirmAction` (pola confirmRelease Dashboard) "Resolve N chat yang dipilih?"; sukses → toast ikon ✓ "N resolved, M dilewati (chat orang lain/sudah resolved)" + refetch `fetchChatsWithFilters()` + clear selection + exit mode (hanya bila semua item diproses — selalu exit biar simple).
   - Baca: langsung (tanpa confirm) → `{marked}` → toast + refetch + clear.
   - Belum dibaca: loop `manualUnreadAdd(id)` (FE-only) → toast `{n} chats ditandai belum dibaca (marker personal perangkat ini)` + clear selection (JANGAN refetch — server state tidak berubah; reactivity dot via event util existing).
   - Kecuali resolve: bila SEMUA skipped → toast warning, tetap jangan crash.
7. Chat yang ter-exclude antrean (v4.4.0) dll TIDAK boleh ikut ke-select di select-all — select-all = `filteredChats` di layar saja (aman by construction).
8. JANGAN ubah: row click normal (non-selectionMode), tab semantics, QueueBanner, homerow.

**Checklist B:**[ ] desktop hover tickbox + first-click unlocks[ ] long-press "Pilih chat"[ ] selectionMode row=toggle bukan open[ ] action bar di bawah Filters[ ] select-all honoring filter aktif + max 100[ ] batch resolve 1 request + skipped jujur + emit queue 1x[ ] batch read server + unreadCount broadcast[ ] unread batch = FE personal marker[ ] confirm dialog resolve[ ] exit mode setelah aksi[ ] tidak ada migration.

## Smoke (copy DB :5099 WA off)
- boot dgn `DATABASE_URL=file:/tmp/<copy> PORT=5099 WA_DISABLED=1` (copy = cp file DB) — superadmin reset bila perlu (pola e2e sebelumnya).
- batch-resolve: 3 chat open unassigned di tenant-8? bila tak ada, buat contact+chat sintetis via API/DB copy. Verify: resolved=3, skipped=0; satu skipped bila 1 dari mereka di-assign ke user lain.
- batch-read: chat baca unreadCount jadi 0; verify via GET.
- CS role user → resolve chat milik agent lain → skipped 'not_allowed' (mirror policy).
- `npm run build` PASS + marker ("Pilih chat", "dipilih") di bundle.

## CHANGELOG
`## [4.5.0] — 2026-10-01` di atas: A) Resolve-tanpa-lompat (detail tutup, tab tidak berubah — FE), B) Multi-select + batch resolve/read/unread (endpoint baru batch-resolve & batch-read (no-migration), select-all honoring filters, mobile long-press entry, mark-unread personal per-device).

## Kontrak laporan
1. Files changed + 1-line summary per fitur. 2. Checklist A & B PASS/FAIL. 3. Build output tail. 4. Smoke hasil (endpoint-by-endpoint). 5. Deviasi ≤10 baris — MENGHENTI (jangan improvisasi) bila fakta beda dari spec (mis. izin resolve bukan asumsi di atas — catat policy asli + ikuti itu).