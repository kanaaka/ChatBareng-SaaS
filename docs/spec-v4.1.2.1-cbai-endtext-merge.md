# SPEC v4.1.2.1 — Hotfix: CB-AI per-slot config drift + "End of AI Replies"

> Status: **GO Kanaka 00:19 (2026-09-27)** — "Okee coba di fix ya" + desain baru field End of AI Replies.
> Base: v4.1.2 (commit `7162367`, tag `v4.1.2`). Dua akar masalah dari QA Kanaka 19:07–19:08:
> (1) setting CB-AI nyasar — toggle di kartu CB-AI nulis row SHARED, tapi runtime per-slot
> pilih row slot dulu → slot-1 Parahita baca `cbaiDisclaimer=0` (mati) + mode ke-clobber
> `text` pas save 19:08:55; (2) limit-habis pakai teks FIX template — Kanaka mau field teks
> editable tenant.

## D1 — Runtime merge config (fix akar: CB-AI = tenant-level)

`getConfigForSlot(tenantId, slot)` (src/services/autoReply.js): setelah pilih row slot,
**overlay field CB-AI dari row shared** (`numberSlot: null`) bila shared row ada:
- Overlay (shared MENANG): `cbaiLimit, cbaiInfoFooter, cbaiBotName, cbaiBotRole, cbaiHumanAgentLabel, cbaiDisclaimer, cbaiUpsellEnabled, cbaiUpsellDocId, cbaiEndText`
- Row slot TIDAK ada / shared TIDAK ada → perilaku existing (compat).
- Field TRIGGER tetap per-slot (JANGAN disentuh): `outsideHoursEnabled/Mode/Text, greetEnabled/Mode/Text, jam harian, repeatFrequency, greetMode 'menu' semantics`.
- Hasil: kartu CB-AI (PUT `/ai-knowledge/config` → selalu tulis row shared, line 203) kini berlaku ke SEMUA slot. Per-slot Auto Reply page gak bisa lagi menimpa/membawa setting CB-AI.
- ⚠️ Jangan ubah `getConfig()` (shared) — sudah bener.

## D2 — Field baru `cbaiEndText` ("End of AI Replies")

- Migration SATU additive: `2026092700300000_cbai_end_text` → `ALTER TABLE "AutoReplyConfig" ADD COLUMN "cbaiEndText" TEXT NULL;` (0 DROP). schema.prisma sync.
- Konstanta `DEFAULT_CBAI_END_TEXT = 'Balasan oleh Agent AI dibatasi sampai {n} pesan per chat (reset 24 jam). Chat kamu akan dibalas oleh {label}, harap ditunggu 🙏'` (di aiKnowledge.js).
- `maybeSendHandoffNotice` (autoReply.js): teks = `cfg.cbaiEndText?.trim()` BILA terisi, else `DEFAULT_CBAI_END_TEXT`. Lalu substitusi variabel OLEH KODE: `{n}` → limit efektif (clamped), `{label}` → `cbaiHumanAgentLabel` (dari row shared via D1 merge) atau `'agen kami'` bila kosong. Substitusi juga berlaku di teks custom.
- **Cap 1×/24 jam TETAP** (`lastHandoffNotifiedAt`) — anti-spam. Tidak dihitung counter. TIDAK dapat disclaimer. Outside-hours limit → tetap away text (UNCHANGED). Gateway path → UNCHANGED (tanpa notice, fallback replyText existing).
- Routes: PUT `/ai-knowledge/config` whitelist + `cbaiEndText` (string ≤500 char; lebih → 400; null/'' = pakai default). GET echo. PUT `/autoreply` (per-slot) TIDAK menerima field ini (tenant-level).
- FE AdminAiKnowledge.vue kartu CB-AI: textarea "End of AI Replies" + hint: *"Kosong = pakai template bawaan. Variabel: {n} = batas pesan, {label} = nama agent manusia."*

## D3 — Fallback semantics (KONFIRMASI — UNCHANGED, bukan kode baru)

- `covered:false` (LLM jawab tapi gak cover) & LLM error/API down → default fallback text (in-hours `greetText`, outside `outsideHoursText`) + counter++ — PERSIS existing (Kanaka 00:19: "kalau LLM tidak merespon... kembalinya ke default text").
- HANYA limit-exhausted in-hours yang pakai `cbaiEndText` (D2).

## D4 — Data fix prod (DIBATALKAN oleh Kanaka 00:42)

**CANCELLED — owner intent:** slot-1 Parahita `greetMode/outsideHoursMode = 'text'` adalah setting yang **disengaja Kanaka** ("Emang aku yang set itu jadi text replies"). BUKAN clobber bug. **JANGAN sentuh row tenant 10 saat deploy** — tidak ada data fix. Dory juga sudah HARAM menyentuhnya (rule spec).

Catatan historis (root-cause analysis tetap valid utk kode): sebelum 19:08:55 slot-1 jalur CB-AI aktif (log: counter 1→2→fallback→3 di chat 7908); save 19:08:55 = Kanaka sendiri mengubah mode jadi text.

## E2E — `scripts/e2e-v4121.cjs` (pola v4120; server copy 5099; WAJIB apply migration baru ke copy-DB + bookkeeping SEBELUM e2e — lesson v4.1.1)

- **N1 merge**: slot row `cbaiDisclaimer=false` stale + shared row `true` → jawaban chat slot AKHIRnya ber-disclaimer (merge jalan). Dan `cbaiUpsellEnabled` shared → upsell jalan di slot.
- **N2 custom end text**: `cbaiEndText` custom berisi `{n}` & `{label}` → limit habis → teks terkirim = custom SUDAH disubstitusi; `lastHandoffNotifiedAt` ter-set; counter tidak nambah.
- **N3 empty end text** → default template terkirim (dengan substitusi {n}/{label}).
- **N4 cap**: pesan ke-2 setelah limit dalam 24 jam → bisu (tanpa notice kedua).
- **N5 covered:false** → fallback greetText + counter++ (default text).
- **N6 LLM error** (mock 500) → fallback greetText + counter++.
- **N7 golden off-state**: tenant tanpa slot-row + semua cbai kosong/mati → prompt byte-identik (tanpa `<persona>/<upsell>`, tanpa disclaimer).
- **N8 validasi**: `cbaiEndText` 501 char → 400; valid string → 200 + echo; PUT /autoreply dgn `cbaiEndText` → field diabaikan (tidak masuk row slot).
- **REGRESI PENUH** copy sama: e2e-v4120(68) + e2e-v4110(42) + e2e-v4100(32) + e2e-v4000(78) + e2e-v3925(59) + e2e-v3924(72) + e2e-v3919(121; flaky 429/401 → cooldown 60–65s re-run).

## Gates

`node --check` semua file diubah; `prisma format+validate+generate`; `npx vite build` exit 0 DARI `frontend/` (build keluar ke `../public` — verifikasi bundle baru berisi `cbaiEndText`); migration additive-only.
**⚠️ BIARKAN server copy 5099 JALAN sampai parent selesai verifikasi — parent yang kill.**

## ⚠️ HARAM (Dory) — KATEGORI, bukan contoh literal

1. **PROD sepenuhnya off-limits: TIDAK BOLEH start/stop/restart/migrate proses apa pun di prod (5047) atau DB prod — APA PUN alasannya, termasuk "ditemukan mati"/"pemulihan"/"service down". Ditemukan prod down → STOP, catat di laporan, alert parent; parent yang memutuskan.**
2. DB destruktif apa pun (NEVER --force-reset/--accept-data-loss/DROP/rm — STOP & report).
3. Commit/push/tag.
4. Kirim WA beneran.
5. Ubah fallback default texts, greetText/outsideHoursText, atau nempel disclaimer/end-text ke jalur fallback.
6. Data fix D4 adalah tugas PARENT saat deploy — jangan sentuh row tenant 10 di DB mana pun selain copy e2e.

## Pipeline (Kanaka-locked)

Dory implement → Alita verify mandiri → **Kimi audit = GATE (WAJIB, tidak di-skip)** → Alita deploy (backup → migrate deploy → data fix D4 → restart by-PID → smoke) → commit+tag `v4.1.2.1` → push → report + re-QA Kanaka.

## Non-goals (v2+)

Repeat notice tiap pesan (sekarang cap 24 jam), End-of-AI untuk outside-hours & gateway, per-slot CB-AI settings UI, edit teks disclaimer.