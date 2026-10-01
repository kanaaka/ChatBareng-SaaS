# Spec — ChatBareng SaaS v3.9.19: SuperAdmin Dashboard Rework

**Status:** APPROVED (Kanaka 15:40–15:50 — "GO, sidebar 4 item + ganti password P1") → Dory implements end-to-end per **NEW DEFAULT DEV WORKFLOW** (Alita specs → Dory implement → Kimi K3 audit, max 3 round fix loop).

**Priority rationale:** UI sekarang "barebones banget, kacaw di mobile" (Kanaka 15:39). Referensi visual: screenshot "H-care" dashboard (Kanaka, 12:33) — sidebar + metric cards + charts grid.

---

## 0. Verified groundwork (Alita, 2026-09-25)

- SuperAdmin.vue sekarang: **1206 baris single-page** — 5 metric cards, tenant list
  (10 tombol/row + inline forms), audit panel, 4 modal (numbers/validity/plan/branding)
  + admin form + purge confirm, ganti password SA (v3.1.1).
- API endpoints yang udah ada (Dory **tidak perlu bikin ulang**, tinggal pakai):
  - `GET /api/sa/stats` — { tenants, activeTenants, users, chats, messages }
  - `GET /api/sa/tenants` (+ `GET /api/sa/tenants/:id/*` untuk plan/validity/numbers/api-keys/backup)
  - `GET /api/sa/audit?action=&tenantId=&before=`
  - `POST /api/sa/tenants/:id/branding` (JSON { brandName } ATAU multipart logo, removeLogo)
- Analytics field source: `Chat.firstIncomingAt / firstAssignedAt / firstResponseAt /
  resolvedAt / messagesBeforeResolve / reopenedCount` — SEMUA dihitung dari tabel Chat
  (zero migration untuk stats baru).

## 1. Goals

1. Split SuperAdmin.vue jadi **4 view dengan sidebar** (Overview | Tenants | Audit Log | Pengaturan).
2. **Overview** = dashboard baru: metric cards + delta trend, chart trend chat (tab range),
   avg response time line, pie Resolved vs Open, card aksen ungu "Chat hari ini" + sparkline.
3. **Mobile responsive** — sidebar jadi drawer hamburger, cards 2-per-row, charts stack.
4. **Dark mode** ikut token M3 yang udah ada (charts warnanya configurable).
5. **Ganti password SA pindah ke view Pengaturan** (P1 — tempatnya lebih pas).
6. API v1, API keys per-tenant helper, Queue/claim semantics, CSAT/AutoReply/MenuGateway
   TIDAK tersentuh (additive murni).

## 2. Non-goals (P1)

- Pricing/payment gateway editable (visioner — masuk blueprint Pengaturan, dibangun bertahap)
- AI provider key platform (visioner — masuk blueprint Pengaturan, dibangun nanti kalau platform punya AI internal)
- Notif WA on regen multi-tenant (udah live v3.9.18b — gak diubah)
- Chart animasi berat / chart library besar (pakai Chart.js ~60KB gzip aja)

## 3. Layout — Sidebar 4 item (desktop ≥768px)

```
┌─────────┬────────────────────────────────────────────────┐
│ LOGO     │  [card] [card] [card] [card] [card]             │  ← Overview view (default)
│          │─────────────────────────────────────────────────│
│ 📊 Over- │  Trend Chat (line/area)      │ Pie Resolved vs  │
│    view  │  [Hari Ini | 7d | 30d]      │ Open             │
│ 👥 Tenan │──────────────────────────────│──────────────────│
│ 📜 Audit │  Avg Response Time (line)    │ ⭐ Card ungu:    │
│ ⚙️ Peng  │  (line, range ikut tab)      │ "Chat hari ini"  │
│          │                              │ + sparkline      │
└─────────┴────────────────────────────────────────────────┘
```

**Sidebar:**
- Lebar ~240px, full viewport height, fixed (desktop)
- Atas: logo ChatBareng + brandName
- Nav items: 📊 Overview · 👥 Tenants · 📜 Audit Log · ⚙️ Pengaturan
- Active item = primary token M3 (ikut accent tenant / dark mode)
- **Mobile (<768px):** sidebar → drawer hamburger (☰ kiri atas, open/close toggle);
  konten full-width; metric cards 2-per-row; charts stack vertikal; pie full-width.

## 4. View Overview (P1 — dashboard baru)

### 4.1 Metric cards (5, tetap dari GET /api/sa/stats)
- Tenant · Aktif · User · Chat · Pesan
- Tambah delta trend kecil (↑↓ % vs periode lalu) — hitung di frontend dari trends API
- Mobile: 2-per-row

### 4.2 Chart Trend Chat (line/area)
- **Data source:** `GET /api/sa/stats/trends?range=today|7d|30d` — jumlah chat baru
  per hari (semua tenant), grouped **WIB** (Asia/Jakarta; server UTC — konversi di query).
- Range tabs: **Hari Ini / 7 Hari / 30 Hari** (default 7d)
- Chart type: line/area (Chart.js)

### 4.3 Avg Response Time (line)
- **Data source:** `GET /api/sa/stats/avg-response?range=today|7d|30d` — rata-rata
  `firstResponseAt − firstIncomingAt` per hari (menit), semua tenant, grouped WIB
- Chart type: line (Chart.js)

### 4.4 Pie Resolved vs Open
- **Data source:** `GET /api/sa/stats/resolution?range=today|7d|30d` — { resolved,
  open, percentResolved, percentOpen }
- Chart type: donut/pie (Chart.js)
- Legend + persentase, klik slice = optional filter (nice-to-have, tidak wajib P1)

### 4.5 Card aksen ungu (focal point ala referensi)
- Solid primary M3 background (purple-ish di light, tetap terlihat di dark)
- Metric besar: "Chat hari ini" (hitung dari `GET /api/sa/stats/trends?range=today`)
- Sparkline mini (7 titik terakhir) di bawah angka

## 5. View Tenants (P1 — pindah + dirapikan)

Semua konten existing (list tenant, 10 tombol/row, inline forms, 4 modal:
numbers/validity/plan/branding + admin form + purge confirm) tetap berfungsi.
Tambahan / rapi-kan:
- Search box (by name)
- Chip filter status (all | active | suspended)
- Badge paket + validity tetap
- Pagination (20/50/100 per page — server-side `?page=&pageSize=`)

## 6. View Audit Log (P1 — pindah, fungsionalitas sama)

- Filter action + tenant (existing)
- Pagination cursor (existing `?before=`)
- Detail collapsible (existing)
- Muat lebih (existing)

## 7. View Pengaturan (P1 — pindah + tambahan)

- **Ganti password SA** — pindah dari SuperAdmin.vue (existing, fungsionalitas sama:
  current + new + confirm)
- **Branding platform (P1 sekarang):** brandName "ChatBareng" editable — dipakai di
  sidebar superadmin. **Storage (amended 2026-09-25, audit F1):** SaAuditLog row
  permanen `action='platform_branding'` (detailJson `{brandName, platformBrand,
  reset}`) — BUKAN AppConfig (tak punya kolom brandName; zero-migration §9 locked).
  Row tak pernah di-purge; GET = findFirst orderBy id desc; "" = reset ke
  "ChatBareng". Login page tetap ChatBareng polos, topbar tenant tetap brandName
  tenant masing-masing (by design)
- **Definisi paket editable (P2, masuk backlog)** — placeholder section di view
  Pengaturan (bukan kosong, tulis "Pricing & payment gateway: dibangun bertahap —
  v3.9.20+")
- **AI provider key (P2, backlog)** — placeholder section
- **Ganti password SA** = POST `/api/auth/change-password` (existing endpoint)

## 8. E2E & QA (scripts/e2e-v3919.cjs — port 5099 DB copy)

- GET /api/sa/stats/trends → shape { dates: [...], counts: [...] } (WIB grouping)
- GET /api/sa/stats/avg-response → shape { avgMinutes: [...], avgTotal: N }
- GET /api/sa/stats/resolution → shape { resolved, open, percentResolved }
- GET /api/sa/tenants dengan search/filter → 200 + filter works
- Tenant isolation tetap (t12 lihat slot-0 miliknya)
- SuperAdmin.vue split: router tetap /superadmin → AdminShell (sidebar) → 4 child view
- Regressions: v3.9.13 (39/39), v3.9.14 (40/40), v3.9.11 (10/10), v3.9.4–v3.9.9 ALL PASS
- Frontend build exit 0
- Visual QA (Chrome 18801): Overview cards render, trend chart muncul, pie donut
  muncul, card ungu sparkline, Tenants view search+filter, Pengaturan ganti password
  works, mobile drawer works

## 9. Explicit invariants (locked)

- Zero migration (additive only; semua chart dihitung dari tabel Chat)
- API v1 untouched (actor-less semantics locked 2026-09-25)
- Public API notify (v3.9.18) untouched
- API keys per-tenant untouched (SA helper tetap di row tenant)
- No destructive DB ops (lesson #8); additive murni
- WIB grouping: server UTC → konversi di query (strftime '+07:00' atau JS offset)
- Multi-line/encrypted content round-trips MUST be post-verified (lesson #4)