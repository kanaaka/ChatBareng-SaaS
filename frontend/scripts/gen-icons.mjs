// v0.4.0 — Generate PWA icons dari 1 SVG (lingkaran hijau + gelembung chat putih)
// via sharp. Jalankan sekali: `node scripts/gen-icons.mjs` (dari frontend/)
// Hasil di-commit, script hanya perlu dijalankan ulang kalau desain berubah.
import sharp from 'sharp'
import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(__dirname, '..', 'public', 'icons')
fs.mkdirSync(outDir, { recursive: true })

// Sumber SVG: lingkaran hijau #25d366 + gelembung chat putih (clean style)
const svg = (size, iconScale = 1) => {
  const s = size
  const cx = s / 2
  const r = (s / 2) * 0.98
  // gelembung chat digambar dalam viewBox 100x100 lalu di-scale
  const bubble = `
    <g transform="translate(${cx - (50 * iconScale * s / 512)}, ${cx - (52 * iconScale * s / 512)}) scale(${iconScale * s / 512})">
      <path d="M50 12 C27 12 9 27.5 9 46.5 c0 10.8 5.9 20.4 15.1 26.7 L20.5 86 c-0.6 2.1 1.6 3.9 3.5 2.9 l14.5-7.6 c3.7 0.8 7.6 1.2 11.5 1.2 23 0 41-15.5 41-34.5 S73 12 50 12 z"
        fill="#ffffff"/>
      <circle cx="33" cy="46.5" r="4.6" fill="#25d366"/>
      <circle cx="50" cy="46.5" r="4.6" fill="#25d366"/>
      <circle cx="67" cy="46.5" r="4.6" fill="#25d366"/>
    </g>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
    <circle cx="${cx}" cy="${cx}" r="${r}" fill="#25d366"/>
    ${bubble}
  </svg>`
}

// Badge monokrom (untuk notification badge — putih polos, OS yang mewarnai)
const badgeSvg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 72 72">
  <path d="M36 10 C21.6 10 10 20.5 10 33.5 c0 7.2 3.9 13.6 10.1 17.8 L17.5 60 c-0.4 1.4 1.1 2.6 2.3 1.9 l9.7-5.1 c2.5 0.5 5 0.8 7.5 0.8 15.4 0 28-10.5 28-23.5 S51.4 10 36 10 z"
    fill="#ffffff"/>
</svg>`

const jobs = [
  { file: 'icon-192.png', size: 192, scale: 0.78 },
  { file: 'icon-512.png', size: 512, scale: 0.78 },
  { file: 'maskable-512.png', size: 512, scale: 0.62 },  // padding aman ~20%
  { file: 'apple-touch-icon.png', size: 180, scale: 0.78 },
  { file: 'favicon.png', size: 64, scale: 0.78 },
  { file: 'badge-72.png', size: 72, badge: true },
]

for (const job of jobs) {
  const source = job.badge ? badgeSvg(job.size) : svg(job.size, job.scale)
  await sharp(Buffer.from(source))
    .resize(job.size, job.size)
    .png()
    .toFile(path.join(outDir, job.file))
  console.log('✓', job.file)
}
console.log('Icons generated in', outDir)