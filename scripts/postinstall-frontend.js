// v3.9.12 — postinstall toleran paket hosting:
// - Repo dev: frontend/ ada → npm install + build (perilaku lama package.json).
// - Paket hosting: frontend/ TIDAK disertakan (public/ prebuilt yang diserve)
//   → lewati tanpa gagal, supaya `npm ci` di server hosting sukses.
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const frontendDir = path.join(__dirname, '..', 'frontend')
if (!fs.existsSync(path.join(frontendDir, 'package.json'))) {
  console.log('[postinstall] frontend/ tidak ditemukan — pakai build public/ prebuilt (paket hosting).')
  // v3.9.12c — paket hosting: generate Prisma client otomatis (fresh npm ci di
  // server hosting belum punya client; dev repo generate manual).
  const g = spawnSync('npx', ['prisma', 'generate'], { cwd: path.join(__dirname, '..'), stdio: 'inherit' })
  if (g.status !== 0) {
    console.error('[postinstall] prisma generate gagal — jalankan manual: npx prisma generate')
    process.exit(g.status || 1)
  }
  process.exit(0)
}
console.log('[postinstall] frontend/ ditemukan — npm install + build…')
const r = spawnSync('npm', ['install'], { cwd: frontendDir, stdio: 'inherit' })
if (r.status !== 0) process.exit(r.status || 1)
const b = spawnSync('npm', ['run', 'build'], { cwd: frontendDir, stdio: 'inherit' })
process.exit(b.status || 0)
