# WhatsApp CS Hub

Multi-agent WhatsApp customer service hub — satu nomor WA, banyak CS agent. Node.js, Baileys, Express, Vue 3 (PWA), Socket.IO, Prisma/SQLite.

> **Current: v0.13.5** — lihat [CHANGELOG.md](CHANGELOG.md) untuk riwayat rilis lengkap (semua versi USER-VERIFIED).

## Features

### Core
- **WhatsApp Connection** — Baileys multi-device WebSocket, QR login via web UI, session persistence, LID→phone resolution
- **Multi-user Auth** — JWT + bcrypt, role admin / CS / relay (Cabang), password management
- **Chat Management** — real-time chat list, FIFO queue (Take Next), assign/release/transfer, snooze, notes per chat, resolve + reopen
- **Real-time** — Socket.IO: pesan, typing indicator, status, queue update, sinkron multi-tab

### Automation
- **Menu Gateway (v0.13.x)** — auto-reply triage IVR-style: chat baru disambut intro + menu bernomor (2–8 opsi, alias keyword), chat *limbo* (tidak terlihat di antrean) sampai pelanggan memilih / timeout / fallback; pilihan → konfirmasi + tag kontak + masuk antrean; frekuensi per kontak (`per_chat` / `daily` / `weekly`); chip admin "⏳ Menunggu menu"
- **Auto Reply (v0.7.0+)** — outside-hours away text + first-of-day greeting; jadwal jam operasional per kelompok hari (Sen–Jum / Sabtu / Minggu, WIB); matrix working-hours (luar jam = away text saja); cap 1 auto message per chat per hari
- **Scheduled Messages & Blast** — kirim terjadwal + blast massal dengan progress & template
- **CSAT** — survey kepuasan otomatis setelah resolve, konsumsi rating otomatis

### Data & Privacy
- **Contacts CRM** — kontak persistent (nama, kota, catatan, source), import/export CSV, **Tag Manager** (chip filter, panel kelola admin, export CSV by tag, tanpa orphan join rows)
- **Enkripsi at-rest** — isi pesan AES-256-GCM (`MSG_ENCRYPTION_KEY`), media terenkripsi
- **Notifikasi berlapis** — toast in-app hanya untuk chat milik sendiri; PWA web push (VAPID) dengan notifikasi antrean *content-free* (tanpa nama/isi pesan); read receipt (centang biru) dengan toggle admin
- **Purge** — soft/hard delete + reset marker auto-reply (fresh start total)

### Lain-lain
- **Analytics** — CS performance, first-response time, heatmap per-CS, chat events
- **Backup** — Google Drive (OAuth), scheduler internal
- **PWA** — installable, service worker push, safe-area mobile, dark mode (Material 3 theming)
- **Docker Ready** — Dockerfile + docker-compose

## Quick Start

### Using Docker (recommended)

```bash
# Clone and configure
git clone <repo> && cd wa-cs-hub
cp .env.example .env

# Edit .env — set JWT_SECRET, MEDIA_ENCRYPTION_KEY, MSG_ENCRYPTION_KEY
nano .env

# Build and run
docker compose up -d --build

# View logs
docker compose logs -f
```

### Manual (Node.js 20+)

```bash
# Install dependencies
npm install

# Create .env
cp .env.example .env
# Edit secrets in .env (lihat tabel Configuration di bawah)

# Database migration + seed
npx prisma migrate dev --name init
npm run seed

# Build frontend
npm run build:frontend

# Start server
npm start
```

Open `http://localhost:5030` in your browser.

### Generate secrets

```bash
# JWT_SECRET
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
# MEDIA_ENCRYPTION_KEY (64-char hex)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# MSG_ENCRYPTION_KEY (base64 32-byte — WAJIB, server menolak start tanpa ini)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# VAPID keys (web push)
npx web-push generate-vapid-keys
```

## Default Admin

- Username: `admin`
- Password: `admin123`
- **Change this immediately after first login!**

## Configuration

See `.env.example` for all configuration options:

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 5030 | Server port |
| DATABASE_URL | file:./data/wa-cs-hub.db | SQLite path |
| JWT_SECRET | (change me) | JWT signing secret |
| MEDIA_ENCRYPTION_KEY | (change me) | AES-256 key (64-char hex) untuk media |
| MSG_ENCRYPTION_KEY | (required) | AES-256 key (base64 32-byte) untuk isi pesan — server tidak start tanpa ini |
| MAX_MEDIA_SIZE_MB | 10 | Max upload size |
| CORS_ORIGIN | * | CORS policy |
| WA_SESSION_DIR | ./data/wa-session | Baileys session storage |
| RATE_LIMIT_PER_MIN | 100 | API rate limit |
| VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY | — | Web push (notifikasi PWA) |
| GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET | — | OAuth Google Drive backup |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| WA Connector | Baileys (@whiskeysockets/baileys) v6 |
| Backend | Express.js + Socket.IO |
| Database | SQLite (Prisma ORM) |
| Frontend | Vue 3 + Tailwind CSS + Pinia (PWA, Material 3 theming) |
| Auth | JWT + bcrypt |
| Push | Web Push (VAPID) + service worker |
| Deployment | Docker + docker-compose |

## Architecture

```
Browser (CS Agent, PWA) ←→ Express + Vue + Socket.IO ←→ Baileys (WhatsApp WebSocket)
                            ↕                        ↕
                     Prisma / SQLite          Web Push (VAPID)
```

Baileys connects directly to WhatsApp's multi-device protocol via WebSocket — no browser, no Chromium needed.

## Admin Panel

Login as admin → `/admin` (launcher ikon, satu halaman per modul):

1. **Users** — create/edit/deactivate CS agents, role & password management
2. **WhatsApp** — QR / reconnect / logout, toggle read receipt
3. **Auto Reply** — away text, first-of-day greeting (teks / menu), jam operasional per hari
4. **Menu Gateway** — opsi menu (label, alias, reply text, tag), fallback, timeout, frekuensi
5. **Templates** — template pesan cepat
6. **CSAT** — konfigurasi survey kepuasan
7. **Purge** — soft/hard delete pesan (reset marker auto-reply ikut)
8. **Backup** — Google Drive backup manual & scheduler

## API Endpoints

Spesifikasi lengkap per-versi ada di root repo (`wa-cs-hub-v0.*-spec.md`) dan riwayat perubahan di [CHANGELOG.md](CHANGELOG.md).

## Public API v1 (API Keys) — v3.9.13

Aplikasi eksternal (mis. program antrean) kirim pesan WA & baca chat via ChatBareng
memakai API key per-tenant. Trial = produksi (same code path).
Dokumen konsumen lengkap: `docs/API-CONSUMER-QUICKSTART.md`.

**Autentikasi:** setiap request bawa header `Authorization: Bearer cbk_live_…`
(juga diterima `X-API-Key: cbk_live_…`). Raw key hanya tampil sekali saat dibuat
(halaman admin **🔑 API Keys** atau via superadmin) — simpan seperti password.

```bash
BASE=https://<domain-atau-tunnel>
KEY=cbk_live_xxxx…

# Liveness (tanpa key)
curl "$BASE/api/v1/health"

# Kirim pesan ke nomor (08…/62… otomatis dinormalisasi ke 62…@s.whatsapp.net)
curl -X POST "$BASE/api/v1/messages" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"target": "081234567890", "text": "Antrian #12, silakan datang"}'
# → 200 {"ok":true,"waMessageId":"…"} · WA belum connect → 503 WA_BELUM_TERHUBUNG

# Kirim ke grup — JID @g.us ATAU nama grup eksak milik tenant
curl -X POST "$BASE/api/v1/messages" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"target": "Nama Grup Eksak", "text": "Pengumuman…"}'

# List chat (pagination cursor sederhana)
curl "$BASE/api/v1/chats?limit=20" -H "Authorization: Bearer $KEY"
# → {"chats":[…],"nextCursor":"1695…|42"} — halaman berikut: ?limit=20&cursor=<nextCursor>
```

**Kode error:** `401 UNAUTHORIZED` (key salah/absent) · `401 KEY_REVOKED/KEY_EXPIRED`
· `403 SCOPE_MISSING` (key tanpa scope endpoint tsb) · `403 UPGRADE_REQUIRED`
(plan tenant belum featApiAccess — aktifkan via superadmin/plan max) ·
`429 RATE_LIMITED` (+`Retry-After`, default 60 req/menit per key) ·
`503 WA_BELUM_TERHUBUNG` (QR slot belum discan).

**Kelola key (UI tenant-admin):** halaman `/admin/api-keys` — list (prefix,
scopes, lastUsedAt, badge revoked), create (raw key show-once + copy), revoke
(instan). Superadmin: `GET/POST/DELETE /api/sa/tenants/:id/api-keys` + field
`featApiAccess` di `PUT /api/sa/tenants/:id/plan`.

## License

Private project.