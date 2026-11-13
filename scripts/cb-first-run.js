#!/usr/bin/env node
// v4.6.14 (MSI v4) — first-run env generator ChatBareng Windows — ADDITIVE
// .env ditulis di %ALLUSERSPROFILE%\ChatBareng (ProgramData — writable runtime, tidak di
// Program Files). Secret acak per-install. Kredensial → KREDENSIAL-ADMIN.txt di folder sama.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// Basis data: CB_DATA_DIR (set installer) | default = folder app root (dev/NSIS per-user)
const PDIR = process.env.CB_DATA_DIR || path.join(__dirname, '..')
const envPath = path.join(PDIR, '.env')

function main() {
  fs.mkdirSync(path.join(PDIR, 'data', 'media'), { recursive: true })
  fs.mkdirSync(path.join(PDIR, 'data', 'wa-session'), { recursive: true })
  if (fs.existsSync(envPath)) {
    console.log('[first-run] .env sudah ada — skip (kredensial tidak diregenerasi).')
    process.exit(0)
  }
  const adminUser = 'superadmin'
  const adminPass = crypto.randomBytes(9).toString('base64url')
  const pd = PDIR.split('\\').join('/') // path windows style forward-slash utk file: URL
  const env = [
    '# ChatBareng — dibuat otomatis saat jalankan pertama (data di ProgramData, bukan Program Files)',
    'PORT=5030',
    'NODE_ENV=production',
    `DATABASE_URL=file:${pd}/data/wa-cs-hub.db`,
    `JWT_SECRET=${crypto.randomBytes(48).toString('base64')}`,
    `MEDIA_DIR=${pd}/data/media`,
    `MEDIA_ENCRYPTION_KEY=${crypto.randomBytes(32).toString('base64')}`,
    'MAX_MEDIA_SIZE_MB=10',
    'CORS_ORIGIN=*',
    `WA_SESSION_DIR=${pd}/data/wa-session`,
    `SUPERADMIN_USERNAME=${adminUser}`,
    `SUPERADMIN_PASSWORD=${adminPass}`,
    'RATE_LIMIT_PER_MIN=300',
    '# Push notifikasi (opsional) — isi via: npx web-push generate-vapid-keys',
    'VAPID_PUBLIC_KEY=',
    'VAPID_PRIVATE_KEY=',
    'VAPID_SUBJECT=mailto:',
    '',
  ].join('\n')
  fs.writeFileSync(envPath, env, { mode: 0o600 })
  const cred = [
    'Kredensial ChatBareng (dibuat otomatis saat jalankan pertama)',
    `Tanggal: ${new Date().toLocaleString('id-ID')}`,
    'URL:  http://localhost:5030',
    `Superadmin: ${adminUser}`,
    `Password:   ${adminPass}`,
    '',
    'SIMPAN FILE INI DI TEMPAT AMAN, lalu HAPUS setelah login beres.',
    `Semua data app: ${PDIR} (backup = copy folder ini).`,
    '',
  ].join('\n')
  fs.writeFileSync(path.join(PDIR, 'KREDENSIAL-ADMIN.txt'), cred, { mode: 0o600 })
  console.log('[first-run] ✅ .env dibuat di ' + envPath)
  console.log('[first-run] ✅ Kredensial superadmin: ' + path.join(PDIR, 'KREDENSIAL-ADMIN.txt') + ' — baca sekarang, simpan, lalu hapus filenya.')
}

main()
