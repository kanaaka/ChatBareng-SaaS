# Spec — wa-cs-hub-saas v3.0 Phase 1: Multi-Tenant di atas ChatBareng v0.15.2

> Ditulis Alita 2026-09-21 malam. Base = **wa-cs-hub-saas-v3** (clone steril ChatBareng
> v0.15.2: TANPA data — gak ada user, chat, kontak; DB fresh, .env baru port 5047).
> Keputusan owner: platform mulai BENAR-BENAR kosong; perusahaan masuk via superadmin,
> bukan migrasi data lama.
>
> Resep desain = port dari `wa-cs-hub-saas/docs/spec-multitenant-phase1.md` (v2.0,
> QA 8/8, 2026-09-02) yang DIADAPTASI untuk 30 model + Baileys 7 + fitur v0.7–v0.15.
> File referensi implementasi lama (boleh dibaca, JANGAN copy mentah — base-nya beda):
> `wa-cs-hub-saas/src/routes/superadmin.js`, `wa-cs-hub-saas/src/wa/pool.js`,
> `wa-cs-hub-saas/frontend/src/views/SuperAdmin.vue`, `wa-cs-hub-saas/src/auth.js`.

## ⛔ HARD CONSTRAINTS (NON-NEGOTIABLE — pelajaran 2026-08-31 & 09-02)

1. NEVER `prisma db push --force-reset` / `--accept-data-loss` / DROP / rm DB.
   Schema baru di DB fresh boleh `npx prisma db push` biasa. Kalau tool minta data-loss → STOP & lapor.
2. **JANGAN sentuh produksi**: `wa-cs-hub/` dan port **5030** = INTACT. `wa-cs-hub-saas/` (v2 lama) = read-only referensi. Semua kerja di repo ini (`wa-cs-hub-saas-v3/`), test di port **5047**, DB di `prisma/data/saas-v3.db`.
3. JANGAN `pkill -f node` — kill by PID dari `ss -ltnp` kalau perlu restart dev server.
4. JANGAN git commit/push — Alita yang review → commit.
5. `WA_DISABLED=1` sudah ada di `.env` TAPI **belum di-handle kode** — base v0.15.2 tidak
   mengenal env ini (boot test 18:49 masih membuat socket + QR). Phase 1 kamu yang
   IMPLEMENT handling-nya (lihat §4 Boot & seed + §5 WA stub): kalau set → skip bootstrap
   Baileys total, endpoint WA balik `{ connected:false, disabled:true }`.
   Server harus boot bersih & health 200 tanpa koneksi WA.
6. DATABASE_URL sudah ABSOLUTE path — jangan ubah jadi relative (pelajaran v2:
   relative `file:./` resolve ke `prisma/prisma/data/`).

## Visi

Satu platform: **super_admin** (owner platform) → bikin **Tenant** (perusahaan:
Mazaya Fit, Parahita, dst) → tiap tenant punya admin/cs/cabang sendiri + **nomor WA
sendiri** (fase 2). Isolasi total antar tenant. Tenant BARU = gak ada data pra-isi:
akun admin pertama dibuat superadmin, sisanya normal lewat UI Users.

## Phase 1 — Scope (fondasi; WA & UI superadmin lengkap = fase 2/3)

### 1. Prisma schema (BREAKING — DB fresh, gak ada data lama yang harus selamat)

Model Tenant baru:
```prisma
model Tenant {
  id            Int      @id @default(autoincrement())
  name          String   @unique
  status        String   @default("active")  // active | suspended
  waPhone       String?  // fase 2
  waSessionDir  String?  // fase 2
  createdAt     DateTime @default(now())
}
```

**User**: `role` jadi `super_admin|admin|cs|relay` + `tenantId Int?` (relasi Tenant;
super_admin = tenantId NULL). Super_admin TIDAK muncul di manajemen user tenant.

**Chat direstrukturisasi (kunci desain — sama dengan v2):**
`id Int @id @default(autoincrement())`, `tenantId Int`, `waJid String`,
`@@unique([tenantId, waJid])`, `@@index([tenantId])`, `@@index([tenantId, waJid])`.
JID grup tetap tersimpan di `waJid` (`@g.us`) — logika anti-grup yang sekarang pakai
`id endsWith '@g.us'` (chats.js, queue.js v0.14.9) PINDAH ke `waJid endsWith '@g.us'`.
Invariant v0.14.9 tetap: banner queue count == isi tab Unassigned, grup gak bisa di-take.

**WAJIB: tulis MIGRATION MAP dulu sebelum edit** — tabel 1 baris per titik yang
referensi chatId-as-JID → apa jadinya (Int id / via waJid / via Chat lookup).
Titik minimal yang harus dipetakan (audit sendiri sisanya):
`Message.chatId`, `ChatEvent.chatId`, `ChatTag.chatId`, `ChatNote.chatId`,
`CsatSurvey.chatId`, `ScheduledMessage.chatId`, `GroupActionLog`, `PurgeLog`,
`FavoriteMessage`, `Contact.chatId`, `Blast/BlastLog` recipient, `cekatImport.js`
(chatId `@s.whatsapp.net`), `historyImport.js` (dedup key + chat find-or-create),
`queue.js` (emitQueueUpdate + take-next), `broadcast.js`, `presence.js`,
frontend: query param `?chat=`, localStorage, socket payload `chatId`.
Jangan mulai ngoding sebelum map ini ada di laporan.

**Semua model milik tenant dapat `tenantId Int` + `@@index([tenantId])`:**
Chat, Contact, Message, ChatEvent, Tag, ChatTag, ContactTag, Blast, BlastLog,
MessageTemplate, PurgeLog, SharedFile, SharedFolder, Announcement, AnnouncementRead,
PushSubscription, FavoriteMessage, ChatNote, CsatSurvey, ScheduledMessage,
GroupActionLog, GDriveLink.
**Model config singleton jadi per-tenant** (unique constraint berubah):
AppConfig, AutoReplyConfig, MenuGatewayConfig (+ Option), CsatConfig, AppearanceConfig,
BackupConfig → tambah `tenantId Int` + `@@unique([tenantId])` (atau [tenantId, id] untuk
MenuGatewayOption yang nested ke Config). Boot-seed yang sekarang `id=1` hardcoded
harus jadi seed per-tenant saat tenant dibuat (fungsi `seedTenantDefaults(tenantId)`).
PurgeLog milik user → inherit via userId boleh, tulis komentarnya.

### 2. Auth & middleware (port dari v2, sudah terbukti)

- JWT payload: `{ id, username, role, tenantId }` (tenantId null untuk super_admin).
- Middleware BARU `src/middleware/tenant.js`:
  - `requireSuperAdmin`
  - `requireTenant` — set `req.tenantId`: user tenant → dari JWT; super_admin → WAJIB
    dari `?tenant=` / header `X-Tenant-Id` untuk endpoint ber-scope (else 400).
  - `resolveTenant` — versi lunak (optional) untuk endpoint yang boleh lintas.
- **Isolation helper**: `requireTenant` dipasang di SEMUA route file tenant-scoped
  (23 file routes). SETIAP query Prisma difilter `tenantId: req.tenantId`. Audit
  satu per satu: chats, contacts, groups, templates, tags, tanganKanan, blast,
  analytics, announcements, csat, autoreply, menuGateway, appConfig, appearance,
  history, cekatImport, media, push, scheduled, users, purge, gdrive, wa, auth(me).
- Login: super_admin → response `{ token, user, tenants:[...] }`; user tenant →
  normal `{ token, user }`. Suspended tenant → login 403 (default-deny, keputusan v2).
- Transfer lintas tenant → 403 (target harus `tenantId` sama).

### 3. Superadmin API (`src/routes/superadmin.js`, semua requireSuperAdmin)

- `GET /api/sa/tenants` — list + jumlah user/chat per tenant + waStatus (fase 1: null)
- `POST /api/sa/tenants` `{ name }` — create tenant + `seedTenantDefaults(tenantId)`
- `PUT /api/sa/tenants/:id` — rename / status active|suspended
- `DELETE /api/sa/tenants/:id` — hanya kalau tenant kosong (tanpa chat & tanpa user
  selain tidak ada) — else 400
- `POST /api/sa/tenants/:id/admins` `{username,password}` — akun admin PERTAMA tenant
- `GET /api/sa/stats` — total tenants/users/messages lintas tenant
- `POST /api/sa/impersonate/:tenantId` → short-lived JWT view-as tenant (untuk
  debug; boleh minimal)

### 4. Boot & seed (DATA KOSONG — beda dari v2!)

Boot: `prisma db push` fresh → server start → jika user super_admin belum ada →
create dari env `SUPERADMIN_USERNAME`/`SUPERADMIN_PASSWORD` (sudah ada di .env).
**TIDAK ada default tenant, TIDAK ada default admin.** Semua tenant dibuat via
superadmin. WA_DISABLED=1 → skip bootstrap Baileys total, endpoint WA balik
`{ connected:false, disabled:true }` (fitur permanen v2).

### 5. WA pool (STUB fase 1)

`src/wa/pool.js`: `Map tenantId → { sock, status }`. Fase 1 = modul ada + interface
jalan (getSocket(tenantId) → null saat disabled) TAPI gak ada koneksi nyata.
Refactor `src/wa/baileys.js` → semua `processIncomingMessage` menerima `tenantId`,
semua lookup chat pakai `[tenantId, waJid]`. Outgoing (reply/blast/media/scheduled/
autoreply/menuGateway) resolve socket via pool. Koneksi nyata + QR per tenant = fase 2.

### 6. Socket.io

Room per tenant: join `tenant:<tenantId>` saat auth. SEMUA broadcast
(chat_update, new_message, queue_update, announcement_*, history_imported,
template_update, presence_update, wa_status) → `io.to('tenant:'+X)`.
Presence map per tenant (`getOnlineUserIds(tenantId)`). Super_admin gak masuk
room tenant (kecuali impersonasi).

### 7. Frontend (minimal fase 1)

- Login: super_admin → redirect `/superadmin` — halaman sederhana: daftar tenant
  (nama, status, #user, #chat), tombol + Tenant, + Admin untuk tenant, suspend/activate.
  Style konsisten (max-w-4xl, card, hijau WA — boleh mirip SuperAdmin.vue v2 tapi
  sesuaikan field).
- Router guard: super_admin dilarang masuk `/` tanpa impersonasi; user tenant gak
  melihat apapun soal tenant (transparan).
- Halaman tenant user: TIDAK ada perubahan visual sama sekali (mereka gak boleh tahu).

### 8. History export/import & Cekat import

- Export: scope tenant req.user (super_admin wajib `?tenant=`). Import: masuk ke
  tenant req.user (super_admin wajib `?tenant=`). Dedup key + chatId tetap — tambahkan
  tenantId di dedup composition supaya tenant lain gak dianggap duplikat.
- `cekatImport.js` converter: chatId sekarang = via find-or-create Chat `[tenantId, waJid]`
  (engine historyImport sudah ditangani map di atas).

## Out of scope (fase 2/3 — JANGAN dikerjakan sekarang)

Multi-socket WA nyata + QR per tenant + connectTenant + reconnect backoff (fase 2),
UI superadmin lengkap + branding per tenant + billing/kuota (fase 3), migrasi data
produksi 5030 (keputusan owner: TIDAK ADA migrasi — platform mulai kosong),
Postgres, domain/tunnel.

## Verifikasi WAJIB sebelum claim done (Alita akan re-verify semua)

1. `npx prisma db push` di DB fresh sukses; migration map di laporan.
2. `npm run build` frontend sukses.
3. Smoke DEV port **5047** (`WA_DISABLED=1` sudah di .env):
   - Boot: auto-seed super_admin dari env; TIDAK ada tenant/user lain (DB kosong total).
   - Login superadmin → buat Tenant "Alpha" + admin Alpha → login admin Alpha →
     bikin CS via API users.
   - Buat Tenant "Beta" + admin Beta.
   - **Isolasi**: admin Alpha bikin template/tag/kontak → admin Beta GET → gak
     keliatan. CS Alpha akses resource Alpha yang bukan miliknya → sesuai aturan lama.
   - Non-superadmin akses `/api/sa/*` → 403. Suspended tenant login → 403.
   - `processIncomingMessage` unit-call dengan tenantId beda, JID SAMA → dua chat
     terpisah (`[tenantId, waJid]` unique bekerja).
   - historyImport dry-run per tenant → chat masuk tenant yang benar.
4. Server boot tanpa Baileys, health 200, log jelas "WA disabled".
5. Laporan: migration map + file list + hasil verifikasi + penyimpangan.