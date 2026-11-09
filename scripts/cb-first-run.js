#!/usr/bin/env node
// v4.6.13 (MSI v1) — first-run env generator ChatBareng (Windows paket) — ADDITIVE
// Menulis .env dengan secret acak per-install (JWT + kunci media AES-GCM base64 32B
// + password superadmin acak). Kredensial ditulis ke KREDENSIAL-ADMIN.txt di root app
// (peringatan: simpan lalu hapus). OFFLINE — tidak ada fetch jaringan.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const ROOT = path.join(__dirname, '..')
const b64_32 = () => crypto.randomBytes(32).toString('base64')
const isAdminPass = () => crypto.randomBytes(9).toString('base64url') // ±12 karakter

function main() {
  const envPath = path.join(ROOT, '.env')
  if (fs.existsSync(envPath)) {
    console.log('[first-run] .env sudah ada — skip (kredensial tidak diregenerasi).')
    process.exit(0)
  }
  const adminUser = 'superadmin'
  const adminPass = isAdminPass()
  const env = [
    '# Dibuat otomatis saat instalasi pertama (cb-first-run.js). Secret = acak per install.',
    'PORT=5030',
    'NODE_ENV=production',
    'DATABASE_URL=file:./data/wa-cs-hub.db',
    `JWT_SECRET=${crypto.randomBytes(48).toString('base64')}`,
    'MEDIA_DIR=./data/media',
    `MEDIA_ENCRYPTION_KEY=${b64_32()}`,
    'MAX_MEDIA_SIZE_MB=10',
    'CORS_ORIGIN=*',
    'WA_SESSION_DIR=./data/wa-session',
    `SUPERADMIN_USERNAME=${adminUser}`,
    `SUPERADMIN_PASSWORD=${adminPass}`,
    'RATE_LIMIT_PER_MIN=300',
    '# Push notifikasi (opsional) — isi via: npx web-push generate-vapid-keys, lalu tempel di bawah:',
    'VAPID_PUBLIC_KEY=',
    'VAPID_PRIVATE_KEY=',
    'VAPID_SUBJECT=mailto:',
    '',
  ].join('\n')
  fs.writeFileSync(envPath, env, { mode: 0o600 })
  const cred = [
    'Kredensial ChatBareng (dibuat otomatis saat instalasi pertama)',
    `Tanggal: ${new Date().toLocaleString('id-ID')}`,
    'URL:  http://localhost:5030',
    `Superadmin: ${adminUser}`,
    `Password:   ${adminPass}`,
    '',
    'SIMPAN FILE INI DI TEMPAT AMAN, lalu HAPUS setelah login beres',
    '(file ini berisi password akun superadmin).',
    '',
  ].join('\n')
  fs.writeFileSync(path.join(ROOT, 'KREDENSIAL-ADMIN.txt'), cred, { mode: 0o600 })
  console.log('[first-run] ✅ .env dibuat + password superadmin acak di KREDENSIAL-ADMIN.txt')
  console.log('[first-run] Baca KREDENSIAL-ADMIN.txt SEKARANG (simpan, lalu hapus filenya).')
}

main()
