const path = require('path')
const fs = require('fs')
const { PrismaClient } = require('@prisma/client')

// v3.9.12c — resolusi DATABASE_URL file: RELATIF → ABSOLUT ter-anchor ke root
// app (src/..). Alasan: Prisma resolve 'file:./data/x.db' terhadap lokasi
// schema.prisma di beberapa lingkungan & terhadap CWD di lingkungan lain —
// ambigu & gak deterministik antara dev vs hosting (bukti: 2 boot test gagal
// beda cara, 2026-09-24). Anchor eksplisit bikin paket hosting jalan di
// folder manapun: 'file:./data/x.db' → <app-root>/data/x.db.
const APP_ROOT = path.resolve(__dirname, '..')
const rawUrl = process.env.DATABASE_URL || ''
if (rawUrl.startsWith('file:') && !path.isAbsolute(rawUrl.slice('file:'.length))) {
  const rel = rawUrl.slice('file:'.length)
  const abs = path.resolve(APP_ROOT, rel)
  if (fs.existsSync(abs)) process.env.DATABASE_URL = 'file:' + abs
  // file belum ada (boot pertama DB kosong) → biarkan Prisma create
  // dgn path absolut yg konsisten (bukan relative-ambiguous)
  else process.env.DATABASE_URL = 'file:' + abs
}

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
})

module.exports = prisma