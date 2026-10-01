// v0.13.3 — Unit-style tests (node -e style, dipanggil via scripts/test-v0133.js)
// Matrix jam kerja (F2) + unified frequency (F4) — fungsi murni: isOutsideHours,
// repeatAllows, personalizeText. Tidak menyentuh DB / server berjalan.
const path = require('path')
const autoReply = require(path.join(__dirname, '..', 'src', 'services', 'autoReply'))
const menuGateway = require(path.join(__dirname, '..', 'src', 'services', 'menuGateway'))

let pass = 0, fail = 0
function assert(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name} ${extra}`) }
}

// ─── Helper: bangun config AutoReply minimal ─────────────────────────────
function cfg({ monFri = true, start = '08:00', end = '17:00' } = {}) {
  return {
    monFriEnabled: monFri, monFriStart: start, monFriEnd: end,
    satEnabled: false, satStart: '08:00', satEnd: '17:00',
    sunEnabled: false, sunStart: '08:00', sunEnd: '17:00',
  }
}
// Timestamp Jumat 2026-09-11 10:00 WIB (epoch detik) — dalam jam kerja
const FRIDAY_10 = Date.UTC(2026, 8, 11, 3, 0, 0) / 1000
// Jumat 2026-09-11 02:00 WIB — luar jam kerja
const FRIDAY_2AM = Date.UTC(2026, 8, 10, 19, 0, 0) / 1000
// Minggu 2026-09-13 10:00 WIB — hari disabled → outside
const SUNDAY_10 = Date.UTC(2026, 8, 13, 3, 0, 0) / 1000
// Jumat 2026-09-11 17:01 WIB — setelah jam kerja
const FRIDAY_1701 = Date.UTC(2026, 8, 11, 10, 1, 0) / 1000

console.log('[1] isOutsideHours — matrix jam kerja (F2)')
assert('Jumat 10:00 → dalam jam (false)', autoReply.isOutsideHours(cfg(), new Date(FRIDAY_10 * 1000)) === false)
assert('Jumat 02:00 → luar jam (true)', autoReply.isOutsideHours(cfg(), new Date(FRIDAY_2AM * 1000)) === true)
assert('Jumat 17:01 → luar jam (true)', autoReply.isOutsideHours(cfg(), new Date(FRIDAY_1701 * 1000)) === true)
assert('Minggu (hari disabled) → outside', autoReply.isOutsideHours(cfg(), new Date(SUNDAY_10 * 1000)) === true)
assert('Senin-Jumat disabled → selalu outside', autoReply.isOutsideHours(cfg({ monFri: false }), new Date(FRIDAY_10 * 1000)) === true)

console.log('[2] repeatAllows — F4 unified frequency (marker bersama)')
const NOW = new Date(FRIDAY_10 * 1000)
const YESTERDAY = new Date(FRIDAY_10 * 1000 - 24 * 3600 * 1000)
const SAME_DAY = new Date(FRIDAY_10 * 1000 - 2 * 3600 * 1000)
const WEEK_AGO = new Date(FRIDAY_10 * 1000 - 8 * 24 * 3600 * 1000)
const contact = (lastMenuShownAt) => ({ id: 1, lastMenuShownAt })

assert('contact null → allow (chat baru/E0)', autoReply.repeatAllows(null, 'daily', NOW) === true)
assert('contact tanpa lastMenuShownAt → allow', autoReply.repeatAllows(contact(null), 'daily', NOW) === true)
assert('per_chat → selalu allow', autoReply.repeatAllows(contact(SAME_DAY), 'per_chat', NOW) === true)
assert('daily + shown hari ini → block', autoReply.repeatAllows(contact(SAME_DAY), 'daily', NOW) === false)
assert('daily + shown kemarin → allow', autoReply.repeatAllows(contact(YESTERDAY), 'daily', NOW) === true)
assert('weekly + shown 8 hari lalu → allow', autoReply.repeatAllows(contact(WEEK_AGO), 'weekly', NOW) === true)
assert('weekly + shown hari ini → block', autoReply.repeatAllows(contact(SAME_DAY), 'weekly', NOW) === false)
assert('freq null/undefined → allow (permissive defensif)', autoReply.repeatAllows(contact(SAME_DAY), null, NOW) === true)
assert('daily WIB boundary: shown kemarin WIB → allow', autoReply.repeatAllows(contact(new Date('2026-09-10T23:30:00+07:00')), 'daily', NOW) === true)

console.log('[3] menuGateway re-export = satu implementasi (F4)')
assert('menuGateway.repeatAllows === autoReply.repeatAllows', menuGateway.repeatAllows === autoReply.repeatAllows)
assert('re-export jalan: per_chat → true', menuGateway.repeatAllows(contact(SAME_DAY), 'per_chat', NOW) === true)
assert('re-export jalan: daily same-day → false', menuGateway.repeatAllows(contact(SAME_DAY), 'daily', NOW) === false)

console.log('[4] personalizeText — {name}')
assert('{name} terisi', autoReply.personalizeText('Halo {name}, selamat datang', 'Budi') === 'Halo Budi, selamat datang')
assert('{name} kosong → rapi tanpa koma gantung', autoReply.personalizeText('Halo {name}, selamat datang', null) === 'Halo, selamat datang')

console.log(`\nHasil: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)