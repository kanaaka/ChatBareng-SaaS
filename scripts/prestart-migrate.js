#!/usr/bin/env node
/**
 * v4.6.3 — PRESTART MIGRATE GUARD v2 (self-healing)
 *
 * Incident (2026-10-02, server hosting IT wa.labparahita.co.id):
 *   kode v4.5.0+ di atas DB era v4.3.1 yang belum di-migrasi → endpoint
 *   antrean (queue-count / take-next) gagal P2022 "column excludeFromQueue
 *   does not exist" → banner claim agent tidak pernah muncul.
 *   Skip migrasi = gagal diam-diam (tidak ada indikator sampai fitur
 *   pemakai kolom baru dipakai).
 *
 * v2 (ubah dari v4.6.2/v1): jalur sinkron di-UNIFIKASI dgn `db push` +
 * rekonsiliasi riwayat — supaya aman TERHADAP semua bentuk DB, termasuk
 * DB yang kolomnya pernah ditambah MANUAL (DDL share permintaan IT):
 * v1 jalur `migrate deploy` bisa crash "duplicate column" pada kondisi itu.
 *
 * Algoritma:
 *   1. File DB belum ada            → `migrate deploy` penuh (install fresh;
 *                                     riwayat migrasi tercatat lengkap)
 *   2. DB ada                       → SELALU `db push --skip-generate`
 *                                     (idempoten; ADDITIVE-ONLY: prisma menolak
 *                                     destructive sendiri → start batal LOUD,
 *                                     jauh lebih baik dari 500 diam-diam)
 *   3. DB ber-riwayat (_prisma_migrations ada) & ada folder migrasi yang
 *      belum tercatat               → `migrate resolve --applied` per folder
 *                                     (JUJUR: langkah 2 baru saja menyamakan
 *                                     DB ke schema.prisma = end-state superset
 *                                     semua migrasi)
 * NEVER `--accept-data-loss` / reset (lesson 2026-08-31).
 * DATABASE_URL di-absolutisasi terhadap APP ROOT (lesson 2026-09-02:
 * `file:./` relative di-resolve prisma CLI terhadap dir schema, bukan app root).
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const MIGRATIONS_DIR = path.join(ROOT, 'prisma', 'migrations')

try { require('dotenv').config({ path: path.join(ROOT, '.env') }) } catch {}

const rawUrl = process.env.DATABASE_URL || ''
let dbFile = rawUrl.startsWith('file:') ? rawUrl.slice(5) : rawUrl
if (dbFile && !path.isAbsolute(dbFile)) dbFile = path.resolve(ROOT, dbFile)
if (!dbFile) {
  console.log('[prestart-migrate] DATABASE_URL tidak terbaca — guard dilewati.')
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
  console.log(`[prestart-migrate] ${label || 'sync'} → npx prisma ${args.join(' ')}`)
  const r = spawnSync('npx', ['prisma', ...args], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: 'file:' + dbFile },
    stdio: 'inherit',
  })
  if (r.status !== 0) {
    console.error('[prestart-migrate] ══════════════════════════════════════════════════')
    console.error('[prestart-migrate]  MIGRASI/SYNC GAGAL (exit ' + r.status + ') — app TIDAK dijalankan.')
    console.error('[prestart-migrate]  DB: ' + dbFile)
    console.error('[prestart-migrate]  Bila prisma menyebut data loss → JANGAN paksai:')
    console.error('[prestart-migrate]  review dulu: npx prisma migrate status — lalu hubungi developer.')
    console.error('[prestart-migrate] ══════════════════════════════════════════════════')
    process.exit(r.status || 1)
  }
}

;(async () => {
  const folders = migrationFolders()

  // 1) Install fresh (file DB belum ada)
  if (!fs.existsSync(dbFile)) {
    if (folders.length === 0) {
      console.log('[prestart-migrate] DB belum ada & tidak ada folder migrations — skip.')
      process.exit(0)
    }
    runPrisma(['migrate', 'deploy'], 'DB baru (install fresh)')
    console.log(`[prestart-migrate] ✅ migrasi penuh diterapkan (${folders.length} migrasi).`)
    process.exit(0)
  }

  // 2) Introspeksi: ada tabel riwayat migrasi? folder mana yang belum tercatat?
  process.env.DATABASE_URL = 'file:' + dbFile
  const { PrismaClient } = require('@prisma/client')
  const prisma = new PrismaClient()
  let hasHistory = false
  let pending = []
  try {
    const t = await prisma.$queryRawUnsafe(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='_prisma_migrations'"
    )
    hasHistory = Array.isArray(t) && t.length > 0
    if (hasHistory) {
      const rows = await prisma.$queryRawUnsafe('SELECT migration_name FROM _prisma_migrations')
      const applied = new Set(rows.map((r) => String(r.migration_name)))
      pending = folders.filter((f) => !applied.has(f))
    }
  } finally {
    await prisma.$disconnect().catch(() => {})
  }
  if (hasHistory && pending.length) {
    console.log(`[prestart-migrate] PENDING (${pending.length} belum tercatat): ${pending.join(', ')}`)
  }

  // 3) Sinkronkan SKEMA (idempoten; additive-only; destructive → prisma menolak → LOUD)
  runPrisma(['db', 'push', '--skip-generate'], 'Sinkron schema.prisma vs DB')

  // 4) Rekonsiliasi riwayat (jujur — langkah 3 baru menyamakan DB ke schema.prisma)
  if (hasHistory && pending.length) {
    for (const f of pending) runPrisma(['migrate', 'resolve', '--applied', f], 'Catat riwayat')
  }

  console.log('[prestart-migrate] ✅ schema & riwayat migrasi sinkron — lanjut start.')
  process.exit(0)
})().catch((e) => {
  console.error('[prestart-migrate] GAGAL (unexpected):', e.message)
  console.error('[prestart-migrate] app TIDAK dijalankan — perbaiki DB dulu, supaya tidak 500 diam-diam.')
  process.exit(1)
})