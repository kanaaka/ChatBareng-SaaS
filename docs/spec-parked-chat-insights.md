# SPEC (PARKED) — Chat Insights: Customer Chat Analysis self-service

> **STATUS: PARKED — design disetujui arah besar oleh Kanaka (18:28–18:31 WIB), EKSEKUSI BELUM GO.**
> Jangan spawn Dory / jangan migrate / jangan deploy dari spec ini sampai Kanaka bilang "gas".
> Working name: **Chat Insights** (nama final bebas diubah Kanaka saat GO).
> Sumber diskusi: 2026-09-26 17:43–18:31 (ide Kanaka: "CS Analysis Qontak tapi self-service di ChatBareng, langsung dari halaman Analytics").

## 0. Origin & posisi produk

- Sejalan dengan protocol CS Conversation Analysis (PROTOCOLS/cs-conversation-analysis.md) yang selama ini manual (Alita jalanin script Qontak per request). Chat Insights = versi productize: **tenant sendiri yang pencet tombol**.
- Data native: chat sudah di DB sendiri (Message + Chat), tidak ada pull API eksternal.
- LLM pipeline proven (CB-AI capture + prompt). Ini varian baru, bukan jalur baru.
- **Plan gate:** ikut `featAnalytics` — Lite ✗ / Pro ✓ / Max ✓. Menjadi nilai jual Pro/Max.

## 1. Filosofi terkunci (jangan dilanggar saat implementasi)

1. **LLM mengelabel, KODE yang menghitung.** LLM per-batch keluarkan label kecil terstruktur (JSON, temperature 0, prompt fix). Agregasi angka = kode (deterministik). Ringkasan naratif LLM HANYA dibuat dari angka final hasil agregasi — bukan dari raw chat.
2. **Label di-cache.** Satu chat di-label SEKALI per rentang (kolom label JSON + di-label-oleh run mana). Re-render report dengan kombinasi metrik berbeda = GRATIS (baca cache). Hanya custom question baru = LLM pass tambahan (berbayar).
3. **Disclaimer pattern:** angka final berasal dari COUNT kode; narasi LLM dibungkus jelas "ringkasan dibuat AI" (pola disclaimer v4.1.2).
4. **Privacy opt-in per tenant** (WAJIB): analisis mengirim isi chat customer ke LLM provider tenant → switch opt-in eksplisit + teks jelas di UI sebelum run pertama. Tanpa opt-in → tombol Analisis disabled dengan penjelasan.
5. **Background job + polling.** Analisis ribuan chat = menitan → job worker (pola server copy / worker terpisah atau interval job in-process, desain teknis saat GO), tabel status, FE polling. Tidak ada request sinkron menunggu LLM.

## 2. UI (halaman Analytics → tab/section baru "Chat Insights")

```
Rentang:            (•) 7 hari   ( ) 30 hari   ( ) Custom [tgl s/d tgl]
Metrik standar:     ☑ Booking intent   ☑ Komplain + tingkat   ☑ Diam-setelah-auto-reply
                    ☑ Top pertanyaan/topik   ☐ Sebaran cabang
Pertanyaan khusus:  [________________________]  (opsional, 1 per run)
                    [ Jalankan Analisis ]
--- riwayat run + hasil (dari AnalysisRun, lihat ulang gratis) ---
```

## 3. Metrik standar MVP (Tick tier — proven format CS Analysis Qontak)

1. **Booking intent** — jumlah + yang punya lokasi/cabang disebut
2. **Komplain** — kategori serius / menengah / clean + sampel kutipan
3. **Diam setelah auto-reply** — chat yang terakhir balasan = auto-reply tanpa follow-up agent (pain point lama terdokumentasi 20.2% di data Qontak Juni)
4. **Top pertanyaan/topik** — daftar item/layanan paling ditanya
5. **Sebaran cabang** — cabang yang disebut customer (default OFF, berat)

Custom question (Type tier): schema label = `match Boolean + catatan singkat` — agregasi kode: jumlah match + sampel.

## 4. Data model (draft — final saat GO)

- `AnalysisRun`: id, tenantId, rentangStart/End, metricsJson (tick yang dipilih), customQuestion (null), status (queued/running/done/failed), progress (x/y chat), hasilJson (angka agregat + ringkasan), labelModel, costNote, createdAt/finishedAt.
- `ChatAnalysisLabel` (cache): chatId + runId(atau hash rentang) + labelJson + createdAt. Unique per (chatId, modelHash). Re-run rentang sama = reuse label.
- Tabel baru 2, additive murni, 0 DROP — pola migration v4.1.2.

## 5. Pipeline job (draft)

1. Klik Jalankan → validasi opt-in + rentang ≤ batas (mis. max 90 hari; chat > N di-batch) → buat AnalysisRun queued.
2. Worker: ambil chat + pesan (in-window), batch ~20 chat → LLM keluarkan label JSON per chat → simpan cache → progress++.
3. Setelah semua label: kode agregasi per metrik tick → angka final.
4. LLM ringkasan naratif (1 panggilan, input = angka final + sampel kutipan terpilih) → hasilJson.
5. FE polling status → selesai → render report (angka + narasi + kutipan sampel).
- Gagal per-batch → retry 1× → skip chat itu + catat di report "N chat gagal dianalisis" (jangan gagalkan run penuh).

## 6. Gate + HARAM (Dory) — pola v4.1.2 + lesson 2026-09-26

- **PROD sepenuhnya off-limits untuk subagent:** TIDAK BOLEH start/stop/restart/migrate proses prod apa pun — APA PUN alasannya, termasuk "ditemukan mati"/"pemulihan". Ditemukan prod down → STOP, catat, alert parent; parent yang putuskan.
- Server copy E2E dibiarkan JALAN sampai parent selesai verifikasi; parent yang kill.
- Kimi audit = GATE, bukan optional. Deploy TUNGGAK sampai audit selesai (kecuali Kanaka eksplisit setuju skip).
- Migration additive-only; DB destruktif HARAM (pola 2026-08-31).
- LLM call hanya via mock capture di e2e (tanpa panggil beneran).

## 7. E2E (draft)

- N1 golden: tanpa run → halaman analytics tidak berubah.
- N2 run 7 hari mock: label JSON tersimpan; agregasi angka = hitungan kode (bandingkan manual seed).
- N3 re-run rentang sama + tick beda → 0 panggilan LLM baru (cache); pertanyaan khusus beda → 1 pass baru.
- N4 opt-in off → tombol disabled + teks privacy.
- N5 plan gate: Lite → 403; Pro → 200.
- N6 gagal batch → retry → skip + catatan, run tetap done.
- N7 injection: chat customer berisi teks "instruksi" → label tetap JSON schema (anti-injection line di prompt labeler).
- Regresi penuh pola v4.1.2 (semua suite existing).

## 8. Open questions (untuk Kanaka saat GO)

1. Nama fitur final ("Chat Insights" / lain).
2. Batas rentang MVP (saran: max 90 hari) + estimasi biaya ditampilkan sebelum run?
3. Custom question: 1 per run (saran MVP) atau langsung multi?
4. Ekspor report (PDF/CSV) — v1 atau v2?
5. Labeler pakai LLM provider yang sama dengan CB-AI per tenant, atau provider tetap platform?

## Non-goals (v2+)

Realtime/live analysis, analisis lintas-tenant, auto-schedule mingguan, notifikasi hasil ke WA/Telegram tenant, multi-pertanyaan khusus, perbandingan periode (MoM).