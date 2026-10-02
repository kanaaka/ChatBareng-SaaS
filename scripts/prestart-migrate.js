#!/usr/bin/env node
/**
 * v4.6.2 — PRESTART MIGRATE GUARD (auto-migrate on start)
 *
 * Latar (incident 2026-10-02, server hosting IT wa.labparahita.co.id):
 *   Server menjalankan KODE v4.5.0+ dengan DB era v4.3.1 yang belum
 *   di-migrasi → setiap endpoint queue (queue-count / take-next) yang
 *   join ke Tag.excludeFromQueue → 500 "column does not exist" → banner
 *   claim agent tidak pernah muncul. Skip migrasi = gagal SILENT.
 *
 * Fungsi:
 *   - Jalan SEBELUM `npm start` (npm lifecycle `prestart` — otomatis).
 *   - IDEPOTEN: DB sudah lengkap → exit 0 tanpa menulis apa pun.
 *   - ADDITIVE-ONLY policy: pakai `prisma migrate deploy` (tidak pernah
 *     reset) atau `prisma db push` TANPA --accept-data-loss — kalau drift
 *     ternyata destructive → prisma menolak dengan error → exit 1 LOUD
 *     (npm start batal — jauh lebih baik daripada 500 diam-diam).
 *     NEVER gunakan --accept-data-loss / reset (lesson 2026-08-31).
 *   - Dua mode deteksi:
 *     (a) DB dengan riwayat migrasi (tabel _prisma_migrations ada) →
 *         bandingkan nama folder `prisma/migrations/` vs applied →
 *         ada pending → `migrate deploy`.
 *     (b) DB TANPA tabel riwayat (hasil `db push` / hand-built) →
 *         `db push --skip-generate` (apply diff skema — additive).
 *   - DB file BELUM ADA (install fresh) → langsung `migrate deploy`
 *     (build schema penuh + catat riwayat = kondisi paling bersih).
 *
 * LESSON terkait (jangan dihapus):
 *   - DATABASE_URL `file:./relative` di-resolve prisma CLI terhadap dir
 *     schema (bukan app root) → SELALU absolutisasi terhadap APP ROOT
 *     sebelum invoke CLI/deteksi (lesson 2026-09-02).
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const MIGRATIONS_DIR = path.join(ROOT, 'prisma', 'migrations')

// .env toleran — env dari process manager tetap menang (dotenv tidak override)
try { require('dotenv').config({ path: path.join(ROOT, '.env') }) } catch {}

const rawUrl = process.env.DATABASE_URL || ''
let dbFile = rawUrl.startsWith('file:') ? rawUrl.slice(5) : rawUrl
if (dbFile && !path.isAbsolute(dbFile)) dbFile = path.resolve(ROOT, dbFile)
if (!dbFile) {
  console.log('[prestart-migrate] DATABASE_URL tidak terbaca — guard dilewati (env menyeluruh).')
  process.exit(0)
}

function migrationFolders() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return []
  return fs.readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort()
}

function runPrisma(args, label) {
  console.log(`[prestart-migrate] ${label} → npx prisma ${args.join(' ')}`)
  const r = spawnSync('npx', ['prisma', ...args], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: 'file:' + dbFile },
    stdio: 'inherit',
  })
  if (r.status !== 0) {
    console.error('')
    console.error('[prestart-migrate] ══════════════════════════════════════════════════')
    console.error('[prestart-migrate]  MIGRASI GAGAL (exit ' + r.status + ')')
    console.error('[prestart-migrate]  DB: ' + dbFile)
    console.error('[prestart-migrate]  Bila error menyebut data loss → JANGAN paksai:')
    console.error('[prestart-migrate]  jalankan `npx prisma migrate status` lalu hubungi developer.')
    console.error('[prestart-migrate] ══════════════════════════════════════════════════')
    process.exit(r.status || 1)
  }
}

async function inspectPending() {
  process.env.DATABASE_URL = 'file:' + dbFile
  const { PrismaClient } = require('@prisma/client')
  const prisma = new PrismaClient()
  try {
    const hasHistory = await prisma.$queryRawUnsafe(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='_prisma_migrations'"
    )
    if (!Array.isArray(hasHistory) || hasHistory.length === 0) {
      return { mode: 'db-push', applied: [] }
    }
    const appliedRows = await prisma.$queryRawUnsafe('SELECT migration_name FROM _prisma_migrations')
    const applied = appliedRows.map((r) => String(r.migration_name))
    const folders = migrationFolders()
    const pending = folders.filter((f) => !applied.includes(f))
    return { mode: 'deploy', applied, pending }
  } finally {
    await prisma.$disconnect().catch(() => {})
  }
}

;(async () => {
  const folders = migrationFolders()

  // Install fresh (DB file belum ada): build penuh via deploy (riwayat tercatat rapi)
  if (!fs.existsSync(dbFile)) {
    if (folders.length === 0) {
      console.log('[prestart-migrate] DB belum ada & tidak ada folder migrations — skip.')
      process.exit(0)
    }
    runPrisma(['migrate', 'deploy'], 'DB baru ditemukan (install fresh)')
    console.log('[prestart-migrate] ✅ migrasi penuh diterapkan (' + folders.length + ' migrasi).')
    process.exit(0)
  }

  const { mode, pending } = await inspectPending()

  if (mode === 'deploy') {
    if (!pending || pending.length === 0) {
      console.log('[prestart-migrate] OK — skema DB mutakhir, tidak ada migrasi pending.')
      process.exit(0)
    }
    console.log('[prestart-migrate] PENDING DETECTED (' + pending.length + '): ' + pending.join(', '))
    runPrisma(['migrate', 'deploy'], 'Apply migrasi pending')
    console.log('[prestart-migrate] ✅ migrasi pending selesai diterapkan.')
    process.exit(0)
  }

  // mode db-push: DB tanpa riwayat migrasi (hand-built / db push) → apply diff skema
  if (folders.length === 0) {
    console.log('[prestart-migrate] OK — tanpa folder migrations & tanpa riwayat.')
    process.exit(0)
  }
  console.log('[prestart-migrate] DB tanpa riwayat migrasi (db-push/hand-built) → apply diff skema (additive).')
  runPrisma(['db', 'push', '--skip-generate'], 'Sync skema')
  console.log('[prestart-migrate] ✅ skema sinkron dgn schema.prisma.')
  process.exit(0)
})().catch((e) => {
  console.error('[prestart-migrate] GAGAL (unexpected):', e.message)
  console.error('[prestart-migrate] app TIDAK dijalankan — perbaiki DB dulu, supaya tidak 500 diam-diam.')
  process.exit(1)
})