# Spec v4.6.0 — Date Separator ala WhatsApp (Chat Detail)

**Status:** SHIPPED 2026-10-02 · **Tipe:** FE-only · **File:** `frontend/src/views/ChatDetail.vue` (+ CHANGELOG)
**Origin:** lapor Kanaka 10:28 "chat 9 hari lalu + hari ini gak ada pembeda" → contoh screenshot WA (pill 8/12/2026, 8/15/2026) 10:30 → GO 10:34.

## D1 — Separation logic
- Array `messages` (ascending, dari API `messages.reverse()`).
- Pill muncul sebelum bubble **pertama** tiap tanggal: `showDateSeparator(list, idx)` → `idx===0` selalu true; selain itu bandingkan (Y,M,D) pesan vs pesan sebelumnya.
- Invalid timestamp → tidak render (false), aman.

## D2 — Label (id-ID, gaya WhatsApp + screenshot Kanaka)
| Jarak | Label |
|---|---|
| Hari ini | `Hari Ini` |
| Kemarin | `Kemarin` |
| 2–6 hari | nama hari (`Rabu`) |
| >6 hari | `DD/MM/YY` → `23/09/26` |

Zona waktu = viewer (browser) — perilaku sama dgn WA Web (server tetap WIB-neutral).

## D3 — Rendering
- `v-for` dipindah ke `<template v-for="(msg, mIdx) in messages" :key="msg.id">` (multi-root per iterasi) — bubble div tetap `:id="'msg-'+msg.id"`, semua styling lama identik.
- Pill: `flex justify-center w-full my-1` + `span px-3 py-1 rounded-full bg-gray-200 text-gray-600 text-xs`.
- Kecocokan scroll/auto-scroll: tak disentuh (`watch(messages.length)` tetap pakai container yang sama).

## D4 — Non-goals / no-touch
- Zero backend, zero schema, zero endpoint, zero migrasi.
- Tidak mengubah `formatTime`, urutan, pagination, favorit, reply-quote.
- Search overlay & favorites panel (jalur render terpisah) tidak disentuh.

## QA
- Logic: same-day no-dup PASS, first-msg pill PASS, midnight rollover PASS, cross-year label `20/12/25` OK.
- Visual (copy-DB :5099, prod zero-touch): SA → impersonate tenant-8 → chat 5088, 9 pesan demo (9d/7d/2d/1d/0d) → **5/5 pill tepat**: `23/09/26`, `25/09/26`, `Rabu`, `Kemarin`, `Hari Ini` (×1, tanpa duplikat).
- Build PASS; live-serve :5047 memuat chunk baru tanpa restart.