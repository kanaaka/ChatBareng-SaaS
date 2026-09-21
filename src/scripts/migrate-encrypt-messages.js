/**
 * v0.11.0 — Migrasi enkripsi at-rest isi pesan lama (plaintext → 'enc:v1:...')
 *
 * Dipakai:
 *   node src/scripts/migrate-encrypt-messages.js --dry-run   # hitung + sample, TANPA tulis
 *   node src/scripts/migrate-encrypt-messages.js --run       # tulis (backup otomatis dulu)
 *
 * Aturan (spec v0.11.0 §5):
 * - Backup DB otomatis SEBELUM mulai → backup/pre-v0.11.0/ + file md5
 *   (env BACKUP_DIR optional untuk dev-copy; default <root>/backup/pre-v0.11.0)
 * - Batch 500 rows; HANYA rows TANPA prefix 'enc:v1:' → idempotent (boleh jalan 2×)
 * - Update Message.content + Chat.lastMessagePreview
 * - Progress log per batch + total waktu
 * - Post-verify: count plaintext tersisa = 0 + sample round-trip dekrip cocok
 * - DILARANG --force-reset / data loss apapun — kalau tool minta reset → STOP.
 * - TIDAK menjalankan migrasi produksi dari sini (Alita yang jalankan manual).
 *
 * DB: env DATABASE_URL (default mengikuti .env repo). Untuk dev pakai copy DB di /tmp.
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
  console.log('Pakai: node src/scripts/migrate-encrypt-messages.js --dry-run | --run')
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
    // v0.11.0 fix (Alita): Prisma resolve path relatif ke folder schema (prisma/),
    // BUKAN repo root — jebakan yang sama dengan dev-copy lama. Cek keduanya;
    // file 0-byte = jebakan (empty DB) → pilih yang punya tabel (size > 0).
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
  const defaultDir = path.join(repoRoot, 'backup', 'pre-v0.11.0')
  const backupDir = process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : defaultDir
  fs.mkdirSync(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dest = path.join(backupDir, `wa-cs-hub.db.pre-v0110-${stamp}`)
  fs.copyFileSync(DB_PATH, dest)
  const hash = md5File(dest)
  fs.writeFileSync(dest + '.md5', `${hash}  ${path.basename(dest)}\n`)
  console.log(`[MIGRATE] Backup DB → ${dest}`)
  console.log(`[MIGRATE] MD5: ${hash}`)
  return { dest, hash }
}

// ─── Post-verify ──────────────────────────────────────────────────────────
async function postVerify(prisma, backupMessages, backupChats) {
  console.log('[VERIFY] Post-verify dimulai...')

  // 1) Count plaintext tersisa (Message.content)
  let plainMsg = 0
  let plainChat = 0
  let cur = null
  // Count in batches via cursor (avoid loading everything)
  for (;;) {
    const rows = await prisma.message.findMany({
      where: { content: { not: null }, ...(cur ? { id: { gt: cur } } : {}) },
      select: { id: true, content: true },
      orderBy: { id: 'asc' },
      take: 1000,
    })
    if (!rows.length) break
    for (const r of rows) if (!isEncrypted(r.content)) plainMsg++
    cur = rows[rows.length - 1].id
  }
  let plainChatCount = 0
  const chats = await prisma.chat.findMany({ select: { id: true, lastMessagePreview: true } })
  for (const c of chats) {
    if (c.lastMessagePreview != null && !isEncrypted(c.lastMessagePreview)) plainChatCount++
  }
  console.log(`[VERIFY] Message plaintext tersisa: ${plainMsg} (harus 0)`)
  console.log(`[VERIFY] Chat preview plaintext tersisa: ${plainChatCount} (harus 0)`)

  // 2) Sample round-trip: dekrip DB → cocok dengan plaintext backup (pre-migrasi)
  const msgSample = await prisma.message.findMany({
    where: { content: { not: null } },
    orderBy: { id: 'asc' },
    take: SAMPLE_SIZE,
  })
  let sampleOk = 0
  let sampleFail = 0
  for (const s of msgSample) {
    const orig = backupMessages.get(s.id)
    if (orig === undefined) continue // row baru setelah backup — skip
    const dec = decryptTextSafe(s.content)
    if (dec === orig) sampleOk++
    else {
      sampleFail++
      console.error(`[VERIFY] SAMPLE MISMATCH (id=${s.id}) — dekrip gak cocok backup!`) // tanpa isi
    }
  }
  console.log(`[VERIFY] Sample Message round-trip: ${sampleOk}/${msgSample.filter((s) => backupMessages.has(s.id)).length} cocok, ${sampleFail} mismatch`)
  const chatSample = chats.filter((c) => c.lastMessagePreview != null).slice(0, SAMPLE_SIZE)
  let chatOk = 0
  let chatVerifyable = 0
  for (const s of chatSample) {
    const orig = backupChats.get(s.id)
    // Preview yang TIDAK ada di snapshot (null pre-migrasi) gak bisa diverifikasi round-trip
    if (orig === undefined) continue
    chatVerifyable++
    const dec = decryptTextSafe(s.lastMessagePreview)
    if (dec === orig) chatOk++
  }
  console.log(`[VERIFY] Sample Chat preview round-trip: ${chatOk}/${chatVerifyable} cocok (yang gak ter-verifiable: preview null pre-migrasi / row baru)`)

  return { plainMsg, plainChatCount, sampleFail, chatMismatch: chatVerifyable - chatOk }
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  const startedAt = Date.now()
  console.log(`[MIGRATE] Mode: ${isRun ? 'RUN (tulis)' : 'DRY-RUN (baca saja)'}`)
  console.log(`[MIGRATE] DB: ${DB_PATH}`)

  // Prisma client — ambil URL dari env yang sama dengan server
  const dbUrl = 'file:' + DB_PATH
  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } })

  try {
    // Backup otomatis SEBELUM mulai (juga untuk dry-run: konsisten & aman)
    const backup = await backupDatabase()

    // ── Snapshot plaintext utk post-verify (sebelum apa pun ditulis) ──
    // HANYA nilai yang masih PLAINTEXT yang bisa di-verify round-trip-nya
    // (nilai ciphertext = sudah terenkripsi sebelum skrip jalan — oleh server
    // v0.11.0 atau run migrasi sebelumnya; itu memang kondisi normal/idempotent).
    const backupMessages = new Map()
    const backupChats = new Map()
    const chatRows = await prisma.chat.findMany({
      where: { lastMessagePreview: { not: null } },
      select: { id: true, lastMessagePreview: true },
    })
    for (const c of chatRows) {
      if (!isEncrypted(c.lastMessagePreview)) backupChats.set(c.id, c.lastMessagePreview)
    }

    // ── Proses Message per batch (hanya TANPA prefix enc:v1:) ──
    let totalMsg = 0
    let batchNo = 0
    for (;;) {
      const rows = await prisma.message.findMany({
        where: { content: { not: null, not: { startsWith: 'enc:v1:' } } },
        select: { id: true, content: true },
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
      })
      if (!rows.length) break
      batchNo++
      if (isDry) {
        // Dry-run: hitung + simpan sample plaintext (tidak menulis)
        for (const r of rows) backupMessages.set(r.id, r.content)
        console.log(`[BATCH ${batchNo}] (dry-run) ${rows.length} plaintext rows terdeteksi (id ${rows[0].id}..${rows[rows.length - 1].id})`)
      } else {
        // Backup plaintext sample SEBELUM update (utk round-trip verify)
        if (batchNo === 1) for (const r of rows.slice(0, SAMPLE_SIZE)) backupMessages.set(r.id, r.content)
        for (const r of rows) {
          // Idempotent guard (double check setelah fetch)
          if (isEncrypted(r.content)) continue
          const enc = encryptText(r.content)
          await prisma.message.update({ where: { id: r.id }, data: { content: enc } })
        }
        console.log(`[BATCH ${batchNo}] ${rows.length} messages terenkripsi (id ${rows[0].id}..${rows[rows.length - 1].id})`)
      }
      totalMsg += rows.length
      if (rows.length < BATCH_SIZE) break
    }
    console.log(`[MIGRATE] Message total terdeteksi plaintext: ${totalMsg}`)

    // ── Proses Chat.lastMessagePreview ──
    let totalChat = 0
    if (isRun) {
      let previewUpdated = 0
      for (const [chatId, preview] of backupChats) {
        if (preview == null || isEncrypted(preview)) continue
        await prisma.chat.update({
          where: { id: chatId },
          data: { lastMessagePreview: encryptText(preview) },
        })
        previewUpdated++
      }
      totalChat = previewUpdated
    }
    console.log(`[MIGRATE] Chat.lastMessagePreview ${isRun ? `terenkripsi: ${totalChat}` : `(dry-run) terdeteksi plaintext: ${[...backupChats.values()].filter((v) => v != null && !isEncrypted(v)).length}`}`)

    // ── Post-verify (wajib, lesson #4: tulis → baca balik & buktikan) ──
    if (isRun) {
      const verify = await postVerify(prisma, backupMessages, backupChats)
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
      console.log(`[MIGRATE] Total waktu: ${elapsed}s`)
      if (verify.plainMsg === 0 && verify.plainChatCount === 0 && verify.sampleFail === 0 && verify.chatMismatch === 0) {
        console.log('[VERIFY] ✅ SUKSES — 0 plaintext tersisa, sample round-trip cocok semua')
        console.log(`[VERIFY] Backup tersedia di ${backup.dest} (md5 ${backup.hash})`)
        process.exitCode = 0
      } else {
        console.error('[VERIFY] ❌ GAGAL — masih ada plaintext/mismatch. JANGAN lanjut deploy; restore backup bila perlu.')
        process.exitCode = 2
      }
    } else {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
      console.log(`[MIGRATE] (dry-run selesai dalam ${elapsed}s — tidak ada perubahan data)`)
      console.log(`[MIGRATE] Untuk eksekusi: node src/scripts/migrate-encrypt-messages.js --run`)
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