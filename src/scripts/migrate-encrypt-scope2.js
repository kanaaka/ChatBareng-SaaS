/**
 * v0.12.4 — Migrasi enkripsi scope 2 (plaintext → 'enc:v1:...')
 *
 * Kolom yang dimigrasi (scope 2):
 *   - ChatNote.body
 *   - ScheduledMessage.body
 *   - Blast.message
 *
 * Dipakai:
 *   node src/scripts/migrate-encrypt-scope2.js --dry-run   # hitung + sample, TANPA tulis
 *   node src/scripts/migrate-encrypt-scope2.js --run       # tulis (backup otomatis dulu)
 *
 * Aturan (pattern migrate-encrypt-messages.js v0.11.0):
 * - Backup DB otomatis SEBELUM mulai → backup/pre-v0.12.4/ + file md5
 *   (env BACKUP_DIR optional untuk dev-copy; default <root>/backup/pre-v0.12.4)
 * - Batch 500 rows; HANYA rows TANPA prefix 'enc:v1:' → idempotent (boleh jalan 2×)
 * - Progress log per batch + total waktu
 * - Post-verify: count plaintext tersisa = 0 + sample round-trip dekrip cocok
 * - DILARANG --force-reset / data loss apapun — kalau tool minta reset → STOP.
 * - TIDAK menjalankan migrasi produksi dari sini (Alita yang jalankan manual saat deploy).
 *
 * DB: env DATABASE_URL (default mengikuti .env repo). Untuk dev pakai copy DB di /tmp.
 * CATATAN v0.12.4: kolom target SEMUA non-nullable → kueri where 'not: null' DITOLAK
 * Prisma ("Argument `not` must not be null"); filter plaintext cukup
 * startsWith 'enc:v1:' / NOT startsWith, tanpa klausul null-check.
 */

const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { PrismaClient } = require('@prisma/client')

const BATCH_SIZE = 500
const SAMPLE_SIZE = 5

// ─── Arg parsing ──────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const isRun = args.includes('--run')
const isDry = args.includes('--dry-run')
if (!isRun && !isDry) {
  console.log('Pakai: node src/scripts/migrate-encrypt-scope2.js --dry-run | --run')
  console.log('  --dry-run : hitung rows plaintext + tampilkan sample, TANPA menulis')
  console.log('  --run     : backup DB otomatis → enkripsi batch 500 rows → post-verify')
  process.exit(isRun || isDry ? 0 : 1)
}
if (isRun && isDry) {
  console.error('[MIGRATE] Pilih salah satu: --run ATAU --dry-run (bukan keduanya)')
  process.exit(1)
}

// ─── textCrypto (kunci dari env MSG_ENCRYPTION_KEY, sama dengan server) ───
// Kunci di-decode sekali di module load; missing/invalid → throw jelas.
const { encryptText, decryptTextSafe, isEncrypted } = require('../services/textCrypto')

// ─── DB URL resolve (env > .env repo) ─────────────────────────────────────
const repoRoot = path.resolve(__dirname, '..', '..')

function resolveDbPath() {
  let url = process.env.DATABASE_URL
  if (!url) {
    // Baca .env repo manual (dotenv tidak diload di context script)
    const envFile = path.join(repoRoot, '.env')
    if (fs.existsSync(envFile)) {
      for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^DATABASE_URL=(.+)$/)
        if (m) { url = m[1].trim(); break }
      }
    }
  }
  if (!url) throw new Error('DATABASE_URL tidak ditemukan (env atau .env)')
  let dbPath = url
  if (url.startsWith('file:')) dbPath = url.slice('file:'.length)
  if (!path.isAbsolute(dbPath)) {
    // Prisma resolve path relatif ke folder schema (prisma/), BUKAN repo root.
    // Cek keduanya; file 0-byte = jebakan (empty DB) → pilih yang punya tabel (size > 0).
    const cand1 = path.resolve(repoRoot, dbPath)
    const cand2 = path.resolve(repoRoot, 'prisma', dbPath)
    const c1s = fs.existsSync(cand1) ? fs.statSync(cand1).size : 0
    const c2s = fs.existsSync(cand2) ? fs.statSync(cand2).size : 0
    dbPath = c2s > 0 && c1s === 0 ? cand2 : cand1
  }
  return dbPath
}

const DB_PATH = resolveDbPath()

function md5File(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex')
}

async function backupDatabase() {
  const defaultDir = path.join(repoRoot, 'backup', 'pre-v0.12.4')
  const backupDir = process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : defaultDir
  fs.mkdirSync(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dest = path.join(backupDir, `wa-cs-hub.db.pre-v0124-scope2-${stamp}`)
  fs.copyFileSync(DB_PATH, dest)
  const hash = md5File(dest)
  fs.writeFileSync(dest + '.md5', `${hash}  ${path.basename(dest)}\n`)
  console.log(`[MIGRATE] Backup DB → ${dest}`)
  console.log(`[MIGRATE] MD5: ${hash}`)
  return { dest, hash }
}

// ─── Generic batch processor utk satu kolom (idempotent, skip enc:v1:) ────
/**
 * @param {object} prisma - PrismaClient
 * @param {string} table - nama delegate: 'chatNote' | 'scheduledMessage' | 'blast'
 * @param {string} column - nama kolom: 'body' | 'message'
 * @param {boolean} dry - true = hitung + sample saja
 * @param {Map} backupMap - id → plaintext snapshot (utk round-trip verify)
 * @returns {Promise<{total: number, encrypted: number}>} total plaintext terdeteksi + rows terenkripsi
 */
async function processColumn(prisma, table, column, dry, backupMap) {
  const label = `${table}.${column}`
  let total = 0
  let encrypted = 0
  let batchNo = 0
  for (;;) {
    // v0.12.4: kolom non-nullable → filter plaintext cukup NOT startsWith
    const rows = await prisma[table].findMany({
      where: { [column]: { not: { startsWith: 'enc:v1:' } } },
      select: { id: true, [column]: true },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
    })
    if (!rows.length) break
    batchNo++
    if (dry) {
      for (const r of rows) backupMap.set(r.id, r[column])
      console.log(`[BATCH ${batchNo}] (dry-run) ${rows.length} ${label} plaintext rows terdeteksi (id ${rows[0].id}..${rows[rows.length - 1].id})`)
    } else {
      // Backup plaintext sample SEBELUM update (utk round-trip verify)
      if (batchNo === 1) for (const r of rows.slice(0, SAMPLE_SIZE)) backupMap.set(r.id, r[column])
      for (const r of rows) {
        // Idempotent guard (double check setelah fetch)
        if (isEncrypted(r[column])) continue
        const enc = encryptText(r[column])
        await prisma[table].update({ where: { id: r.id }, data: { [column]: enc } })
        encrypted++
      }
      console.log(`[BATCH ${batchNo}] ${rows.length} ${label} terenkripsi (id ${rows[0].id}..${rows[rows.length - 1].id})`)
    }
    total += rows.length
    if (rows.length < BATCH_SIZE) break
  }
  console.log(`[MIGRATE] ${label} total terdeteksi plaintext: ${total}${isRun ? `, terenkripsi: ${encrypted}` : ''}`)
  return { total, encrypted }
}

// ─── Post-verify ──────────────────────────────────────────────────────────
async function postVerify(prisma, backups) {
  console.log('[VERIFY] Post-verify dimulai...')

  const remaining = { chatNote: 0, scheduledMessage: 0, blast: 0 }
  const columns = { chatNote: 'body', scheduledMessage: 'body', blast: 'message' }

  for (const [table, column] of Object.entries(columns)) {
    // v0.12.4 fix: kolom NON-NULLABLE → kueri 'not: null' ditolak Prisma;
    // count plaintext cukup via isEncrypted di aplikasi.
    const rows = await prisma[table].findMany({
      select: { id: true, [column]: true },
    })
    for (const r of rows) if (!isEncrypted(r[column])) remaining[table]++
    console.log(`[VERIFY] ${table}.${column} plaintext tersisa: ${remaining[table]} (harus 0)`)
  }

  // Sample round-trip: dekrip DB → cocok dengan plaintext snapshot pre-migrasi
  let sampleFail = 0
  for (const [table, column] of Object.entries(columns)) {
    const backupMap = backups[table]
    const sample = await prisma[table].findMany({
      select: { id: true, [column]: true },
      orderBy: { id: 'asc' },
      take: SAMPLE_SIZE,
    })
    let ok = 0
    let verifiable = 0
    for (const s of sample) {
      const orig = backupMap.get(s.id)
      if (orig === undefined) continue // row baru setelah snapshot — skip
      verifiable++
      const dec = decryptTextSafe(s[column])
      if (dec === orig) ok++
      else {
        sampleFail++
        console.error(`[VERIFY] SAMPLE MISMATCH (${table}.${column} id=${s.id}) — dekrip gak cocok backup!`) // tanpa isi
      }
    }
    console.log(`[VERIFY] Sample ${table}.${column} round-trip: ${ok}/${verifiable} cocok`)
  }

  return { remaining, sampleFail }
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  const startedAt = Date.now()
  console.log(`[MIGRATE] Mode: ${isRun ? 'RUN (tulis)' : 'DRY-RUN (baca saja)'}`)
  console.log(`[MIGRATE] DB: ${DB_PATH}`)
  console.log('[MIGRATE] Scope 2: ChatNote.body + ScheduledMessage.body + Blast.message')

  const dbUrl = 'file:' + DB_PATH
  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } })

  try {
    // Backup otomatis SEBELUM mulai (juga untuk dry-run: konsisten & aman)
    const backup = await backupDatabase()

    // Snapshot plaintext utk post-verify (sebelum apa pun ditulis).
    // HANYA nilai plaintext yang disnapshot (ciphertext = sudah terenkripsi —
    // oleh server v0.12.4 atau run migrasi sebelumnya = kondisi normal/idempotent).
    const backups = {
      chatNote: new Map(),
      scheduledMessage: new Map(),
      blast: new Map(),
    }
    const columns = { chatNote: 'body', scheduledMessage: 'body', blast: 'message' }
    for (const [table, column] of Object.entries(columns)) {
      const rows = await prisma[table].findMany({
        select: { id: true, [column]: true }, // kolom non-nullable → tanpa where
      })
      for (const r of rows) {
        if (!isEncrypted(r[column])) backups[table].set(r.id, r[column])
      }
      console.log(`[MIGRATE] Snapshot ${table}.${column}: ${backups[table].size} plaintext rows`)
    }

    // ── Proses per kolom ──
    const stats = {}
    for (const [table, column] of Object.entries(columns)) {
      stats[table] = await processColumn(prisma, table, column, isDry, backups[table])
    }

    // ── Post-verify (wajib: tulis → baca balik & buktikan) ──
    if (isRun) {
      const verify = await postVerify(prisma, backups)
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
      console.log(`[MIGRATE] Total waktu: ${elapsed}s`)
      const plainLeft = Object.values(verify.remaining).reduce((a, b) => a + b, 0)
      if (plainLeft === 0 && verify.sampleFail === 0) {
        console.log('[VERIFY] ✅ SUKSES — 0 plaintext tersisa di 3 kolom scope 2, sample round-trip cocok semua')
        console.log(`[VERIFY] Backup tersedia di ${backup.dest} (md5 ${backup.hash})`)
        process.exitCode = 0
      } else {
        console.error('[VERIFY] ❌ GAGAL — masih ada plaintext/mismatch. JANGAN lanjut deploy; restore backup bila perlu.')
        process.exitCode = 2
      }
    } else {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
      console.log(`[MIGRATE] (dry-run selesai dalam ${elapsed}s — tidak ada perubahan data)`)
      console.log(`[MIGRATE] Untuk eksekusi: node src/scripts/migrate-encrypt-scope2.js --run`)
    }
  } catch (e) {
    console.error('[MIGRATE] ERROR:', e.message)
    console.error('[MIGRATE] Tidak ada perubahan yang menjamin lanjut — periksa error di atas.')
    process.exitCode = 1
  } finally {
    await prisma.$disconnect().catch(() => {})
  }
}

main()