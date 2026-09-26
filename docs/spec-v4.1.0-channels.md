# SPEC v4.1.0 — Channels (WA Channel archive, read-only)

> **Status: GO Kanaka 12:44** ("ok go, pindah situ aja oke. tapi kalau di mobile mungkin di tempatkan di kontak juga sama kayak grup").
> **Prinsip:** Channel = one-way broadcast — **archive read-only**. NOL sentuh ke auto-reply / menu gateway / antrean / assignment / unread / metering AI (bug v4.0.0c: postingan Channel dijawab Auto Reply — fix hotfix v4.0.0c jadi fondasi jalur ini).

## Keputusan terkunci (diskusi 11:57–12:44)

| # | Keputusan |
|---|---|
| D1 | **Auto-capture:** postingan pertama dari JID `@newsletter` (per tenant+slot) → auto-register + arsip. TANPA manual registration di v1. |
| D2 | Nama channel: best-effort `sock.newsletterMetadata('jid', jid)` → fallback `propName` dari event → fallback JID prefix. Gagal = tetap arsip (nama menyusul). |
| D3 | **Read-only total:** TANPA queue/unread/assignment/CSAT/auto-reply/menuState/metering. Chat row TIDAK dibuat. Pesan postingan TIDAK masuk inbox CS. |
| D4 | **UI placement (Kanaka 12:44):** (a) **Desktop topbar Dashboard** — link "Channel" SETELAH "Grup", SEBELUM "Blast" (admin-gated `v-if="auth.isAdmin"` — pola Admin Panel); (b) **Mobile: tab di halaman Kontak** — segmen jadi `Kontak | Grup | Channel` (pola segmented `mobileTab` existing v0.14.0), panel = `ChannelListPanel`. |
| D5 | **Admin-only:** `requireAuth + requireTenant + requireAdmin` (pola routes/aiKnowledge.js). CS gak lihat. |
| D6 | Media postingan: text tersimpan; media (image/video/doc) → simpan metadata + mediaPath via pipeline media existing bila mudah; kalau rumah → metadata doang + flag `mediaOnly`. Jangan scope-creep. |
| D7 | **NO send capability v1** (Baileys 7.0.0-rc14 gak punya method resmi kirim postingan — dibaca dari node_modules; `sendMessage` ke @newsletter = community-hack). Parked sampai spike resmi. React = ada API-nya tapi juga parked. |
| D8 | **No plan gate v1** (archive-only, 0 cost LLM) — semua tenant aktif otomatis. Toggle per-tenant (matikan capture) = v2 on-demand. |
| D9 | v2 parked: notif "post baru" ke CS/tenant (socket broadcast), draft postingan, schedule post. |

## 1. Migration — SATU, additive murni (2 CREATE TABLE, 0 DROP)

```prisma
model ChannelArchive {
  id           Int      @id @default(autoincrement())
  tenantId     Int
  numberSlot   Int      @default(0) // slot yang melihat channel (multi-nomor)
  waJid        String   // "...@newsletter"
  name         String   @default("") // best-effort (D2)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  updatedById  Int?
  @@unique([tenantId, numberSlot, waJid])
}

model ChannelPost {
  id          Int      @id @default(autoincrement())
  archiveId   Int
  serverId    String?  // msg ID newsletter (server_id — dipakai react nanti)
  content     String   @default("") // teks postingan
  mediaPath   String?  // bila media tersimpan (D6)
  mediaType   String?
  mediaMime   String?
  fromMe      Boolean  @default(false) // postingan admin channel sendiri
  msgTimestamp DateTime?
  createdAt   DateTime @default(now())
  @@unique([archiveId, serverId])
}
```

## 2. Backend — service `src/services/channelArchive.js` (BARU)

- `archiveNewsletterMessage(tenantId, slot, msg)` — dipanggil dari `pool.js` jalur `@newsletter` (GANTI plain-skip v4.0.0c):
  1. resolve/create `ChannelArchive` by (tenantId, slot, waJid) — nama best-effort D2
  2. dedupe by (archiveId, serverId) — upsert-skip kalau sudah ada (idempoten)
  3. simpan post (content/media per D6) — TANPA menyentuh Chat/queue/counter apa pun
  4. **SELALU return null-ish** → caller `messages.upsert` continue (tidak create chat) — kontrak: fungsi ini TIDAK BOLEH throw ke runtime path (try/catch log-only)
- `listArchives(tenantId)` / `listPosts(archiveId, {limit, cursor})` — utk FE
- Fail-closed: semua error di-log, runtime WA TIDAK pernah crash karena archive.

## 3. Backend — integrasi `src/wa/pool.js`

`messages.upsert` handler: JID `@newsletter` → `channelArchive.archiveNewsletterMessage(...)` (try/catch) → `continue` (tetap TIDAK ke `processIncomingMessage`). Guard defense-in-depth di `processIncomingMessage` entry (v4.0.0c) TETAP: `@newsletter` → return null (jalur archive di upsert sudah selesai sebelum situ).

## 4. Backend — routes `src/routes/channels.js` (BARU, mount `/api/channels`)

- `GET /` — list archives (name, waJid, postCount, lastPostAt) milik tenant
- `GET /:id/posts?limit=50&before=<id>` — postingan terbaru dulu (cursor)
- Semua `...rt` admin-only (D5). Tanpa plan gate (D8). SA `?tenant=` pola existing.

## 5. Frontend — 2 titik + 1 halaman

1. **Halaman `Channels.vue` (BARU, `/channels`):** PageShell "Channel" — list channel (nama, JID, jumlah post, post terakhir) → klik → drawer/list postingan read-only (konten + waktu + badge media; fromMe badge "dari kamu"). Pagination simple. TANPA v-html.
2. **Dashboard.vue topbar (desktop):** `<router-link to="/channels">Channel</router-link>` SETELAH Grup, `v-if="auth.isAdmin"` (D4a).
3. **Contacts.vue (mobile):** segmen `Kontak | Grup | Channel` — tambah tombol ketiga + `mobileTab === 'channels'` → `<ChannelListPanel>` panel list; klik channel → detail postingan (pola GroupListPanel). (D4b)
4. Router: `{ path: '/channels', name: 'Channels', component: ..., meta: { auth: true } }` — guard admin di halaman level (redirect bila !isAdmin, pola halaman lain).
5. Admin search index (AdminShell.vue) + entry "Channel" (sectionHint 'Admin Panel').

## 6. E2E — `scripts/e2e-v4100.cjs` (server copy 5099, pola e2e-v4000; E2E_OK_SEND=1 + E2E_DEBUG_INBOUND=1)

- N1 POST `/api/wa/inbound` @newsletter JID baru → archive ter-create + post tersimpan (content match) — `handled=false`
- N2 dedupe: kirim pesan sama (serverId sama) → post TIDAK dobel (count 1)
- N3 fromMe=true → post tersimpan dgn fromMe=true
- N4 GET /api/channels → archive muncul (nama/jid/postCount); GET posts → isi benar
- N5 admin tenant lain → 404/isolasi (tenant-scoped); CS token → 403 (admin-only)
- N6 media post (imageMessage tanpa caption) → arsip dengan metadata media (content kosong + mediaType) — tanpa crash
- N7 chat row TIDAK dibuat utk JID @newsletter (regresi N17 v4000 tetap hijau)
- Regresi: v4000 78 + v3925 59 + v3924 72 + v3919 121 — SEMUA PASS.

## 7. Gates & rollout

- `node --check` file baru/ubah; `prisma format+validate+generate`; migration additive-only (2 CREATE TABLE); `npx vite build` exit 0 (log PENUH); prod untouched sampai release.
- Deploy: backup VACUUM INTO → `migrate deploy` → restart by-PID → smoke (GET /api/channels no-token 401; health; 3 WA slot) → commit + tag `v4.1.0` → push → release report.
- Non-goals: send postingan (D7 — spike terpisah) · reaksi (parked) · notif post baru (v2) · plan gate (D8) · import riwayat lama dari WA (v2 on-demand — data lama bisa di-backfill via newsletterMetadata fetch kalau diminta).

## 8. Pertanyaan (balas bareng GO impl — default sudah dipilih, tinggal veto)

1. Default capture = ON untuk semua tenant (D8, tanpa toggle) — OK?
2. Nama halaman/route: "Channel" (tunggal, mengikuti istilah WA app) — OK?