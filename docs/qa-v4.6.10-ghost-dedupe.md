# QA v4.6.10 — [No content] ghost messages + history-sync dedupe

**Status:** DONE — e2e baru + regresi penuh 0 FAIL. **Produksi 5047/5062 tidak pernah disentuh** (semua test copy-DB port 5099/5098, WA_DISABLED=1; semua server test dibunuh di akhir, `ss -ltn` bersih).

## 1. Lingkup perubahan (semua ingest-filter — ZERO kolom baru / zero schema change)

| File | Perubahan |
|---|---|
| `src/wa/pool.js` | (1) Gerbang anti-ghost `shouldPersistIncomingMessage` (exported): §1a protocol events / body kosong non-media → skip; §1b dedupe by (tenantId + waMessageId + same chat via waJid/phoneJid/lidJid); §2 anti-flip dariMe (lokal menang); participant-view utk row OUT lokal → skip + backfill konten row lama `[No content]`; fail-open saat lookup error. (2) Final race-guard sebelum `message.create` 1:1 (max 1 row per chat+waMessageId). (3) Upsert handler jalur 'notify' digerbangi; jalur 'append' replay history-sync TETAP di-drop (perilaku prod lama: replay masal berisiko flood + efek samping unread/push/auto-reply; self-upsert internal Baileys `messages-send.js` L1137 juga lewat 'append'). |
| `src/services/groups.js` | Dedupe pesan grup: row (tenantId, chatId, waMessageId) sama → skip (replay/ACK grup tidak dobel). |
| `src/services/historyImport.js` | Dedupe import: backup bawa waMessageId nyata → (tenant, chat, waMessageId) sama di-skip; `messagesAdded` hanya hitung pesan yang benar-benar masuk (skipped dilaporkan terpisah). |
| `scripts/e2e-v4610-ghost-dedupe.cjs` | e2e baru (37 cek, unit-level gate + jalur runtime asli). |

Root cause terverifikasi kode Baileys 7.0.0-rc14: `sendMessage()` kirim ke diri sendiri via wrapper `deviceSentMessage` (`messages-send.js`) → WA ACK balik → upsert 'notify' fromMe=true tanpa body (proto `EPHEMERAL_SYNC_RESPONSE`) → pool lama menyimpan row `content NULL` = bubble `[No content]` OUT; reopen/history-sync replay pesan sama tanpa dedupe → row dobel + participant-view `fromMe=false` → arah terbalik (flip).

## 2. E2E v4.6.10 — `scripts/e2e-v4610-ghost-dedupe.cjs` :5099 copy-DB

**37 PASS / 0 FAIL (1.7s)** — bukti mentah: `docs/qa-v4610-ghost-dedupe-e2e-final.txt`.

| Kasus | Cek | Hasil |
|---|---|---|
| U1 (gate unit) | protocolMessage echo self-send / senderKeyDistribution / reactionMessage / message={} / message undefined → semua SKIP (5) | **5/0** |
| U2 (gate unit) | teks nyata IN, initiate OUT "ice cream", media+caption → semua lolos persist (3) | **3/0** |
| C1 replika Kanaka | take via route assign asli → initiate "ice cream" via route reply asli → PERSIS 1 row (OUT, sent, waMessageId, konten utuh) → echo upload (protocol, id SAMA) via `/api/wa/inbound` runtime asli → skip → tetap 1 row → ghost empty-body lain juga skip (8) | **8/0** |
| C2 reopen/history-sync | replay OUT (konten sama, fromMe=true) → skip; participant-view (fromMe=false) utk row OUT lokal → TIDAK flip TIDAK dobel; jumlah tetap 1, arah tetap OUT, konten utuh (5) | **5/0** |
| C3 dedupe IN | pesan IN nyata persist → replay (key.id + chat sama) → skip; tetap 1 row (3) | **3/0** |
| C4 ghost | ghost tidak bikin chat baru / unread (1) | **1/0** |
| C5 legacy backfill | row lama `[No content]` OUT + participant sync bawa teks → konten ter-backfill, tanpa row baru, arah tetap OUT (3) | **3/0** |
| C6 replay append-gate unit | replay konten yang sudah ada → skip; replay konten BARU → lolos; replay kosong → skip (3) | **3/0** |
| C7 scope dedupe | waMessageId sama tapi JID/chat beda → lolos (bukan duplikat) (1) | **1/0** |

## 3. Regresi penuh — copy-DB, port test, WA-off

| Suite | Port | Hasil | Bukti |
|---|---|---|---|
| e2e-v394.cjs (v3.9.4) | 5099 | **22 PASS / 0 FAIL** | `docs/qa-v4610-regress-e2e-v394.txt` |
| e2e-v395.cjs (v3.9.5) | 5099 | **13 PASS / 0 FAIL** | `docs/qa-v4610-regress-e2e-v395.txt` |
| e2e-v396.cjs (v3.9.6) | 5099 | **15 PASS, 0 FAIL** | `docs/qa-v4610-regress-e2e-v396.txt` |
| e2e-v399.cjs (v3.9.9) | 5099 | **10 PASS / 0 FAIL** | `docs/qa-v4610-regress-e2e-v399.txt` |
| e2e-log-coverage.cjs (v4.6.4) | 5099 (pre-boot) | **76 PASS / 0 FAIL** | `docs/qa-v4610-regress-log-coverage.txt` |
| e2e-clearqueue.cjs (v4.6.6) | 5099 (self-boot) | **56 PASS / 0 FAIL** | `docs/qa-v4610-regress-clearqueue.txt` |
| e2e-v467-floatzone.cjs (v4.6.7 rev) | 5099 (self-boot) | **36 PASS / 0 FAIL** | `docs/qa-v4610-regress-v467-floatzone.txt` |
| e2e-v468-floatzone-v2.cjs (v4.6.8) | 5099 (self-boot) | **44 PASS / 0 FAIL** | `docs/qa-v4610-regress-v468-floatzone-v2.txt` |
| e2e-v469-outside-priority.cjs (v4.6.9) | 5099 (self-boot, fair-copy*) | **42 PASS / 0 FAIL** | `docs/qa-v4610-regress-v469-outside-fair.txt` |
| e2e-v470-systemlogs.mjs | 5098 | **59 PASS / 0 FAIL** (retry; run-1 57/2) | `docs/qa-v4610-regress-v470-systemlogs.txt` |
| e2e v4.6.10 (baru) | 5099 (self-boot) | **37 PASS / 0 FAIL** | §2 |

**TOTAL: 374 PASS / 0 FAIL.**

Catatan lingkungan (bukan bug v4.6.10):
- *Fair-copy v469: pack DB repo kini SUDAH memuat kolom `lastAutoOutDate` (v4.6.9 sudah dipakai produksi). Suite K1e melakukan ALTER manual atas copy dari pack ("pra-migrasi" era kemarin) → fair replika: kolom di-drop dulu dari base (`/tmp/saas-v3-e2e-v469-fair-base.db`), suite committed tidak diubah — hanya jalannya via salinan `/tmp` dgn sumber copy K1e diganti fair-base. Hasil = identik QA kemarin (42/0).
- v470 S3-e/f run-1 (57/2): flake timing insert fire-and-forget jalur client-log (`got=undefined` — row belum terbaca saat cek) — kelas sama dgn flake S3-g terdokumentasi v4.6.8/v4.6.9; retry copy fresh = **59/0 ALL PASS**. Jalur itu tidak disentuh v4.6.10.
- Suite v394–v399 chained SATU copy DB dari `backup/pre-v3.5-20260922-2017/saas-v3-pre-v351.db` (tenant-4 utuh, 24 chat) + seed `TenantNumber` tenant-4 slot 0+1 + `db push` additive — replika persis prosedur QA v4.6.9.

## 4. Risiko & catatan reviewer

1. **Jalur 'append' tetap di-drop** (perilaku prod lama dipertahankan): replay history-sync masal tidak pernah persist sebelumnya; mengebarkannya berisiko flood + efek samping (unread++/push/auto-reply utk pesan LAMA). Ghost-gate + race-guard menutup duplikasi/flip di jalur live 'notify' (kasus prod yang dilaporkan). Kalau kelak butuh ingest replay berkonten, aktifkan via `processIncomingMessage(..., { historySync: true })` — gate-nya sudah siap (sudah diuji C6).
2. **Dedupe scope = tenant + chat sama** (via waJid/phoneJid/lidJid): waMessageId sama pada JID/chat BEDA tetap lolos (C7) — broadcast/multi-chat tidak salah-skip. Di luar chat 1:1 ada guard serupa utk grup.
3. **REVOKE (protocolMessage type REVOKE) ikut di-skip** sebagai row: sebelumnya revoke yang terlanjur lolos justru JADI bubble `[No content]` (bagian dari bug ini). Fitur "hapus pesan" memang belum pernah ditangani pool — tidak ada regresi perilaku.
4. **Backfill konten** hanya terjadi bila row lama `content NULL` dan sync bawa teks nyata — arah row TIDAK pernah diubah (zero mutation kecuali mengisi konten yang memang kosong).
5. FE `[No content]` guard (`v-if="!msg.content && !msg.mediaType"`) tidak diubah — kini hanya mungkin tampak utk row legacy; data lama bisa pulih via backfill (C5) atau jalur purge yang existing.
6. Commit lokal SAJA (NO push — Alita yang ship PR #11); version.json = v4.6.10; schema DB tidak diubah (tidak perlu `db push` di produksi).