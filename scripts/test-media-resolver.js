// v3.9.12c (audit L2) — unit test resolveMediaFilePath diabadikan supaya bisa
// di-re-run: node scripts/test-media-resolver.js  (exit 1 bila ada yg gagal)
process.env.MEDIA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'media-resolver-test-'))
const { saveMedia, loadMedia, resolveMediaFilePath } = require('../src/wa/media')
const fs = require('fs'), path = require('path')
let pass = 0, fail = 0
const t = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name) }
;(async () => {
  const buf = Buffer.from('TEST-MEDIA-' + Date.now())
  const rel = await saveMedia(buf, 'enc')
  t('saveMedia return RELATIF (tanpa slash)', !rel.includes('/') && rel.endsWith('.enc'))
  t('loadMedia relatif OK', loadMedia(rel).equals(buf))
  t('fallback absolut host-lama OK', loadMedia('/home/lama-host/lama/data/media/' + rel).equals(buf))
  t('null → null', resolveMediaFilePath(null) === null)
  t("'' → null", resolveMediaFilePath('') === null)
  t('traversal ../ → null', resolveMediaFilePath('../../etc/passwd') === null)
  t('absolut luar mediaDir (file ada) → null', resolveMediaFilePath('/etc/hostname') === null)
  t('absolut dalam mediaDir → lolos', !!resolveMediaFilePath(path.join(process.env.MEDIA_DIR, rel)))
  t('absolut mediaDir-persis → base (diizinkan, baca file = EISDIR di konsumen)', resolveMediaFilePath(process.env.MEDIA_DIR) === path.resolve(process.env.MEDIA_DIR))
  console.log(`\n${pass} PASS, ${fail} FAIL`)
  process.exit(fail ? 1 : 0)
})().catch(e => { console.error('FATAL', e.message); process.exit(1) })
