# Spec v4.1.3.1 — FEATURE: "Tandai Belum Dibaca" (Mark as Unread) di Chat List (FE-only)

**Request (Kanaka, 2026-09-28 13:19):** tombol/aksi "Tandai belum dibaca" via klik-kanan pada chat di chat list. Skenario: agent mau bales, tapi tiba-tiba mengerjakan lain → chat ditandai biar gak lupa bales.

## Pendekatan (terkunci — pilih A)
**Opsi A — client-side personal marker (localStorage), NO backend, NO migration, NO restart:**
- Ini REMINDER pribadi agent (pola sama dgn WhatsApp "mark as unread" yang juga per-device). Chat lain/agent lain tidak perlu lihat.
- Zero-downtime, deploy ringan, tidak menyentuh prod backend.

**NON-GOAL (opsi B, jangan dikerjakan):** kolom DB `manualUnread` + endpoint + badge team-wide — hanya jika Kanaka minta eksplisit nanti (butuh migration + restart prod).

## Goal
Klik-kanan chat di chat list → menu kecil "Tandai belum dibaca" → chat dapat indikator (dot biru + bold) → marker hilang otomatis saat chat dibuka. Persist across reload.

## Scope
- NEW `frontend/src/utils/manualUnread.js` — helper kecil:
  - localStorage key **`cb_manual_unread`** = JSON object `{ "<chatId>": true }` (urutan key = insertion order).
  - API: `list()` → object; `has(chatId)`; `add(chatId)`; `remove(chatId)`; cap **300** entry — saat add melebihi, evict key pertama (LRU-ish by insertion order).
  - Semua operasi try/catch (localStorage full/private mode → silent no-op, jangan crash).
- EDIT `frontend/src/views/ChatListPane.vue`:
  - **D1 — Klik kanan (desktop):** `@contextmenu.prevent` pada row chat → menu kontekstual kecil di posisi cursor (`position: fixed`, z-50, var M3 `surface-container` + `outline-variant`, rounded-lg shadow-xl, w-56). Item:
    - Jika BELUM ditandai: "🔴 Tandai belum dibaca" (label persis: **Tandai belum dibaca**; ikon dot biru/merah bebas — pilih dot biru `bg-blue-500` konsisten dgn WhatsApp).
    - Jika SUDAH ditandai: "Tandai sudah dibaca" (remove marker).
    - Menu ditutup: klik item, klik backdrop (`fixed inset-0 z-40` transparan), Esc, scroll list, atau pindah route.
  - **D2 — Long-press (mobile):** `touchstart` + timer 500ms → buka menu yang sama di posisi sentuh; cancel saat `touchmove`/`touchend` sebelum 500ms. JANGAN mengganggu tap normal (buka chat).
  - **D3 — Indikator:** bila marker aktif **DAN** `chat.unreadCount == 0`: dot biru kecil (`w-2.5 h-2.5 rounded-full bg-blue-500`) di pojok kanan-atas avatar + teks judul/nama `font-semibold`. Bila `unreadCount > 0` (unread asli), badge unread existing menang — dot TIDAK dobel.
  - **D4 — Marker hilang saat dibuka:** emit event existing open-chat tetap; di handler open (Dashboard.vue tempat `listChat.unreadCount = 0` di line ~717): `manualUnread.remove(chat.id)` + re-render list. Juga remove saat agent MENGIRIM pesan di chat itu (sudah dibalas = sudah dikerjakan) — hook di handler send sukses.
  - Dark/light: kontras AA, var M3 sama dgn menu lain.
- EDIT `frontend/src/views/Dashboard.vue` — wiring D4 (open + send-success → remove marker).
- EDIT `CHANGELOG.md` — header paling atas: `# v4.1.3.1 — FEATURE: Tandai belum dibaca di chat list (GO Kanaka 2026-09-28 13:19)` + 1 paragraf ringkas (request + skenario; FE-only 0 backend 0 DB; personal per-device seperti WhatsApp).

## NON-GOALS
- Backend/route/prisma/migration/socket: 0 perubahan. JANGAN sentuh src/*.
- CB-AI/autoReply/aiKnowledge/fallback: LOCKED (Kanaka 11:27) — jangan disentuh.
- Tidak ada dependency baru, tidak ubah package.json.

## Constraints (lesson wajib)
- NEVER `--force-reset`/`--accept-data-loss`/`DROP`/`rm` on any DB; kalau tool minta reset → STOP & report.
- **Prod 5047 TIDAK disentuh.** Build verifikasi HANYA: `cd frontend && npx vite build --outDir /tmp/cb-unread-dist-test --emptyOutDir` (harus exit 0).
- Jangan install/uninstall node_modules. Jangan sentuh Chrome profile/cookie. Parent yang deploy ke public/ + commit/tag (lesson v4.1.3: JANGAN commit sendiri — parent yang finalisasi).
- Re-render list: marker harus update segera setelah add/remove (reactive store/computed, bukan hard refresh).

## Deliverable Dory
1. Kode 3 file (manualUnread.js baru + ChatListPane.vue + Dashboard.vue) + CHANGELOG header v4.1.3.1.
2. Build exit 0 (outDir /tmp) + bukti grep `Tandai belum dibaca` & `cb_manual_unread` di chunk hasil /tmp build.
3. Laporan: file berubah + ringkas perubahan per D1–D4; konfirmasi 0 file backend tersentuh (`git status --short` output lengkap); konfirmasi tidak ada prisma command.