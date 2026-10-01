# Spec v4.1.3 — FEATURE: Emoji Picker di Composer Chat (FE-only)

**Request (Kanaka, 2026-09-28 11:55):** "di bagian text field di chat, boleh dong masukin tombol untuk pilih daftar emoji — soalnya ada dari mereka yang gaada shortcut masukin emoji." CS agent desktop butuh tombol emoji; mobile native keyboard sudah punya.

## Goal
Tombol emoji di composer `ChatDetail.vue` → popover picker (Sering dipakai + kategori) → insert emoji di posisi kursor input reply.

## Scope (FE-only — 0 backend, 0 DB, 0 migration, 0 dependency baru)
- NEW `frontend/src/components/EmojiPicker.vue`
- EDIT `frontend/src/views/ChatDetail.vue` (tombol + state + wiring)
- EDIT `CHANGELOG.md` (header baru di atas: `# v4.1.3 — FEATURE: Emoji picker composer (GO Kanaka 2026-09-28)`)
- Parent replyText wiring TIDAK diubah (input existing sudah emit `update:replyText` — pakai jalur yang sama).

## Desain (terkunci)

**D1 — Tombol:**
- Desktop (`!isMobile`): tombol khusus di composer bar, posisi kiri input (setelah tombol ⏰ jadwalkan), pola visual persis tombol composer lain: `text-gray-500 hover:text-wa-green p-2 rounded-full hover:bg-gray-100 flex-shrink-0`, ikon smiley SVG outline 24×24 stroke currentColor, `title="Emoji"`, `:disabled="sendingMedia"`.
- Mobile (`isMobile`): item ke-5 di menu "+" — ikon smiley + label "Emoji", pola persis 4 item existing (Kirim Media/Template/Tangan Kanan/Pesan Terjadwal), min touch 44×44.

**D2 — Popover picker:**
- Muncul di ATAS composer: `absolute bottom-full left-0 mb-2 z-40`, width ~340px (mobile: `max-w-[calc(100vw-24px)]`), max-height ~320px overflow-y-auto.
- Section + isi (hardcode array di komponen, ~100 emoji, tanpa lib — SEMUA kategori netral/multi-tenant, TIDAK ada kategori spesifik klinik/industri; revisi Kanaka 12:07):
  - "Sering dipakai" — localStorage key `cb_emoji_recent` (max 16, LRU, unshift+dedupe; kosong → section disembunyikan)
  - HANYA 3 kategori di atas (revisi Kanaka 12:07 — hapus "Kesehatan & Objek", tidak ada kategori spesifik industri karena ChatBareng dipakai semua tenant)
  - "Smileys & Perasaan" (LENGKAP ~40) — 😀😃😄😁😆😅🤣😂🙂🙃😉😊😇🥰😍🤩😘😗☺😚😙🥲😋😛😜🤪😝🤑🤗🤭🤫🤔🤨😐😑😶😏😒🙄😬🤥😌😔😪🤤😴😷🤒🤕🤢🤮🥵🥶😵🥳🥺😢😭😤😠😡🤬🤯😳🥱
  - "Gestur & Tangan" (~24) — 👋🤚🖐️✋🖖👌🤌🤏✌️🤞🤟🤘🤙👈👉👆👇☝️👍👎✊👊👏🙌👐🤲🤝🙏
  - "Hati & Keluarga" (~24) — ❤️🧡💛💚💙💜🖤🤍💔❣️💕💞💓💗💖💘💝💋👶🧒👦👧🧑👨👩👨‍👩‍👦👨‍👩‍👧‍👦👩‍👩‍👦🧑‍🤝‍🧑
  - (Dory boleh trim ±beberapa emoji yang render-nya buruk, tapi 3 kategori ini tetap; tidak menambah kategori industri apa pun)
- Grid: tombol min 40×40 (ideal 44), `text-2xl`, rounded-lg, hover `bg-surface-container-high`, tap highlight none.
- Header section kecil (`text-xs uppercase on-surface-variant`, sticky tidak wajib).
- Tutup: klik area luar (backdrop `fixed inset-0 z-30` transparan @click close — pola paling aman), tombol ✕ kecil di kanan-atas panel, tombol Esc (keydown di panel bila fokus). Insert TIDAK menutup popover (biar bisa multi-emoji).
- Dark/light: var M3 sama dgn template dropdown (`surface-container`, `outline-variant`, `on-surface`, `surface-container-high`). Kontras AA.

**D3 — Insert at cursor:**
- Baca `replyInputRef.value.selectionStart/End` sebelum insert (fallback: akhir string), splice ke `replyText`, `emit('update:replyText', newVal)`.
- `nextTick` → restore cursor ke `insertPos + emoji.length` (gagal = cursor end, bukan error).
- Komponen menerima `replyText` via prop? TIDAK perlu — cukup emit dengan string hasil; posisi kursor dibaca Dory dari `replyInputRef` (sudah ada ref-nya di ChatDetail).

**D4 — Safety layout:**
- Popover absolute (di luar flow) — TIDAK boleh mengubah `composerHeight` (visualViewport pattern §3.2). Verifikasi: buka picker lalu ketik → composer tidak lompat.
- Menu "+" mobile tetap berfungsi; item Emoji menutup menu lalu buka popover.
- Tidak mengubah perilaku template dropdown / slash flyout / media / quote chip.

## NON-GOALS
- Backend, route, prisma, migration: 0 perubahan.
- CB-AI / autoReply / aiKnowledge / fallback: **JANGAN disentuh** (Kanaka 2026-09-28 11:27: fallback = by design, lock).
- Tidak ada dependency npm baru, tidak ubah package.json.

## Constraints (lesson wajib)
- NEVER use `--force-reset` / `--accept-data-loss` / `DROP` / `rm` on any DB. Kalau tool minta reset → STOP & report.
- **Prod 5047 TIDAK disentuh.** JANGAN jalankan `vite build` ke dist prod — verifikasi build pakai outDir terpisah:
  `cd frontend && npx vite build --outDir /tmp/cb-emoji-dist-test --emptyOutDir`
- Jangan install/uninstall node_modules. Jangan sentuh Chrome profile / cookie.

## Deliverable Dory
1. Kode + CHANGELOG header v4.1.3.
2. Build exit 0 (outDir /tmp) + bukti: `grep -rl "EmojiPicker\|Sering dipakai" /tmp/cb-emoji-dist-test/assets | head -3`.
3. Laporan: daftar file berubah + jumlah baris, daftar emoji final per kategori, konfirmasi D1–D4, konfirmasi 0 file backend tersentuh (`git status --short`).