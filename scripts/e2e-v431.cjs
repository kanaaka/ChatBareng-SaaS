/**
 * E2E v4.3.1 — Fix DELETE Chat 500 P2002 (per-slot contact reality)
 * (spec docs/spec-v4.3.1-chat-delete-500-p2002.md §3 — S1..S4)
 * Jalur copy-DB :5099 (WA_DISABLED=1 + E2E_OK_SEND=1 + E2E_DEBUG_INBOUND=1) — produksi
 * (5047) TIDAK tersentuh. Pola: scripts/e2e-v430.cjs (super_admin impersonasi ?tenant=).
 *
 * Setup copy-DB (dari repo root — zero-migration, code-only fix):
 *   python3 -c "import shutil; shutil.copy('prisma/data/saas-v3.db','/tmp/saas-v3-e2e-p431.db')"
 *   node prisma/seed-ai-rates.js /tmp/saas-v3-e2e-p431.db
 *   PORT=5099 DATABASE_URL=file:/tmp/saas-v3-e2e-p431.db WA_DISABLED=1 E2E_OK_SEND=1 \
 *     E2E_DEBUG_INBOUND=1 node src/server.js &
 *   node scripts/e2e-reset-superadmin.cjs && set -a && . ./.env && set +a && node scripts/e2e-v431.cjs
 *
 * Skenario (§3):
 *   S1 — nomor sama, 2 chat (slot0+slot1), KEDUA chat punya contact sendiri →
 *        DELETE default → 200; contact chat dihapus = chatId null; contact
 *        sibling TIDAK tersentuh; sibling chat utuh. (D2 — bug P2002 fix)
 *   S2 — setup sama → DELETE ?deleteContact=true → 200; contact chat ini
 *        TERHAPUS; contact sibling tetap ada. (D5)
 *   S3 — sibling TANPA contact sendiri → move masih jalan. (D3 — regressi lama)
 *   S4 — no sibling → orphan chatId=null. (D4 — regressi)
 */
const REPO = '/home/kanakxxx/.openclaw/workspace/wa-cs-hub-saas-v3'
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:5099'
// KRITIS (lesson v4.1.x): dotenv .env berisi DATABASE_URL PROD → DATABASE_URL dipaksa
// ke copy SETELAH dotenv — seluruh proses satu DB copy (service tidak menembak PROD).
const COPY_DB = 'file:/tmp/saas-v3-e2e-p431.db'
require(REPO + '/node_modules/dotenv').config({ path: REPO + '/.env' })
process.env.DATABASE_URL = COPY_DB
// WA stub (lesson v4.3.0): suite ini tidak mengirim WA — pastikan stub aktif bila
// kode in-process tersentuh; server QA juga di-boot dgn flag yang sama.
process.env.WA_DISABLED = '1'
process.env.E2E_OK_SEND = '1'
const { PrismaClient } = require(REPO + '/node_modules/@prisma/client')
// WAJIB: tunjuk DB COPY — jangan pernah sentuh DB produksi dari script test ini
const prisma = new PrismaClient({ datasourceUrl: COPY_DB, log: ['error'] })

const fails = []
let pass = 0
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
  if (!cond) { process.exitCode = 1; fails.push(name) } else { pass++ }
}
async function api(method, path, body, token, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let data = null
  try { data = await res.json() } catch {}
  return { status: res.status, data }
}

// ═══ Seeder — pasangan chat per-slot milik SATU nomor (per-slot contact reality) ═══
let seq = 431000 // prefix unik nomor uji — tidak mungkin tabrakan dgn data prod copy
function nextPhone() {
  const p = `6289995${String(seq).padStart(6, '0')}`
  seq += 7
  return p
}
async function seedSlotChat(tenantId, phone, slot, name) {
  const jid = `${phone}@s.whatsapp.net`
  // compound unique (tenantId, numberSlot, waJid) — slot beda, JID boleh sama
  const chat = await prisma.chat.create({
    data: {
      tenantId, numberSlot: slot, waJid: jid, contactPhone: phone, contactName: name,
      status: 'open', queuedAt: new Date(), lastMessageAt: new Date(),
    },
  })
  return chat
}
async function seedContact(tenantId, phone, chatId, name) {
  return prisma.contact.create({ data: { tenantId, chatId, name, phone, source: 'chat' } })
}

async function main() {
  // ═══════════ S0 — login super_admin (copy DB) + tenant khusus uji ═══════════
  const sa = await api('POST', '/api/auth/login', { username: process.env.SUPERADMIN_USERNAME, password: process.env.SUPERADMIN_PASSWORD })
  check(`S0 superadmin login (copy db) status=${sa.status} tok=${!!sa.data?.token}`, sa.status === 200 && !!sa.data?.token)
  const saTok = sa.data?.token
  if (!saTok) return process.exit(1)

  // Tenant terisolasi khusus suite ini — QA fixture prod (chat 8370/8371 tenant-10)
  // TIDAK disentuh sama sekali (semua seed + DELETE hanya di tenant baru ini).
  const tName = 'e2e-v431-' + Date.now()
  const tenant = await prisma.tenant.create({ data: { name: tName, status: 'active' } })
  const T = tenant.id
  const qs = `?tenant=${T}`
  console.log(`S0 tenant uji #${T} (${tName}) dibuat di copy DB`)

  // ═══════════ S1 — sibling dua-duanya punya contact sendiri, DELETE default (D2) ═══════════
  {
    const phone = nextPhone()
    const chatA = await seedSlotChat(T, phone, 0, 'S1 A (slot0)')
    const chatB = await seedSlotChat(T, phone, 1, 'S1 B (slot1)')
    const contactA = await seedContact(T, phone, chatA.id, 'S1 Contact A')
    const contactB = await seedContact(T, phone, chatB.id, 'S1 Contact B')

    const r = await api('DELETE', `/api/chats/${chatA.id}${qs}`, undefined, saTok)
    check(`S1-a DELETE default chat slot0 (sibling punya contact sendiri) → 200, BUKAN 500 P2002 status=${r.status}`, r.status === 200, JSON.stringify(r.data).slice(0, 150))
    check('S1-b response shape tetap (ok+deleteContact+deleted) — D7', r.data?.ok === true && r.data?.deleteContact === false && typeof r.data?.deleted?.contacts === 'number')

    const chatAGone = await prisma.chat.findUnique({ where: { id: chatA.id } })
    check('S1-c chat dihapus hilang', !chatAGone)
    const cA = await prisma.contact.findUnique({ where: { id: contactA.id } })
    check('S1-d contact chat dihapus masih ada, chatId=null (detach sendiri, data identitas utuh)', !!cA && cA.chatId === null, `chatId=${cA?.chatId}`)
    const cB = await prisma.contact.findUnique({ where: { id: contactB.id } })
    check('S1-e contact sibling TIDAK tersentuh (chatId tetap sibling)', !!cB && cB.chatId === chatB.id, `chatId=${cB?.chatId} expect=${chatB.id}`)
    const chatBRow = await prisma.chat.findUnique({ where: { id: chatB.id } })
    check('S1-f sibling chat utuh', !!chatBRow)
    // purgeLog tetap tercatat (audit trail unchanged)
    const purge = await prisma.purgeLog.findFirst({ where: { tenantId: T, reason: { contains: 'chat_delete' } }, orderBy: { id: 'desc' } })
    check('S1-g purgeLog tetap tercatat (unchanged)', !!purge)
  }

  // ═══════════ S2 — sibling sibling-contact-aware, deleteContact=true (D5) ═══════════
  {
    const phone = nextPhone()
    const chatC = await seedSlotChat(T, phone, 0, 'S2 C (slot0)')
    const chatD = await seedSlotChat(T, phone, 1, 'S2 D (slot1)')
    const contactC = await seedContact(T, phone, chatC.id, 'S2 Contact C')
    const contactD = await seedContact(T, phone, chatD.id, 'S2 Contact D')

    const r = await api('DELETE', `/api/chats/${chatC.id}?deleteContact=true&tenant=${T}`, undefined, saTok)
    check(`S2-a DELETE deleteContact=true chat slot0 → 200 status=${r.status}`, r.status === 200, JSON.stringify(r.data).slice(0, 150))
    check('S2-b response deleteContact=true + contacts terhitung', r.data?.ok === true && r.data?.deleteContact === true && r.data?.deleted?.contacts === 1)

    const cCGone = await prisma.contact.findUnique({ where: { id: contactC.id } })
    check('S2-c contact chat ini TERHAPUS (intent admin dihormati)', !cCGone)
    const cD = await prisma.contact.findUnique({ where: { id: contactD.id } })
    check('S2-d contact sibling tetap ada (identitas nomor hidup via sibling)', !!cD && cD.chatId === chatD.id)
    const chatDRow = await prisma.chat.findUnique({ where: { id: chatD.id } })
    check('S2-e sibling chat utuh', !!chatDRow)
  }

  // ═══════════ S3 — sibling TANPA contact sendiri → move (D3 — regressi lama) ═══════════
  {
    const phone = nextPhone()
    const chatE = await seedSlotChat(T, phone, 0, 'S3 E (slot0)')
    const chatF = await seedSlotChat(T, phone, 1, 'S3 F (slot1, tanpa contact)')
    const contactE = await seedContact(T, phone, chatE.id, 'S3 Contact E')
    // chatF SENGAJA tidak dibuatkan contact (kasus legacy/langka)

    const r = await api('DELETE', `/api/chats/${chatE.id}${qs}`, undefined, saTok)
    check(`S3-a DELETE default chat dgn sibling kosong → 200 status=${r.status}`, r.status === 200)
    const cE = await prisma.contact.findUnique({ where: { id: contactE.id } })
    check('S3-b contact PINDAH ke sibling (move masih jalan — merge sah)', !!cE && cE.chatId === chatF.id, `chatId=${cE?.chatId} expect=${chatF.id}`)
    const chatFRow = await prisma.chat.findUnique({ where: { id: chatF.id } })
    check('S3-c sibling chat utuh milik contact legacy', !!chatFRow)
  }

  // ═══════════ S4 — no sibling → orphan chatId=null (D4 — regressi) ═══════════
  {
    const phone = nextPhone()
    const chatG = await seedSlotChat(T, phone, 0, 'S4 G (slot0, no sibling)')
    const contactG = await seedContact(T, phone, chatG.id, 'S4 Contact G')

    const r = await api('DELETE', `/api/chats/${chatG.id}${qs}`, undefined, saTok)
    check(`S4-a DELETE default chat tanpa sibling → 200 status=${r.status}`, r.status === 200)
    const cG = await prisma.contact.findUnique({ where: { id: contactG.id } })
    check('S4-b contact orphan chatId=null (unchanged byte-compat D4)', !!cG && cG.chatId === null)
  }

  // ═══════════ S5 — sanity: fixture prod QA (chat 8370/8371, contact 8184/8185, tenant-10) utuh ═══════════
  {
    const fx = await prisma.chat.findMany({ where: { id: { in: [8370, 8371] } }, select: { id: true, tenantId: true } })
    const fc = await prisma.contact.findMany({ where: { id: { in: [8184, 8185] } }, select: { id: true, chatId: true } })
    check('S5 fixture QA prod tidak tersentuh (chat 8370+8371 masih ada di tenant-10)', fx.length === 2 && fx.every((c) => c.tenantId === 10), JSON.stringify(fx.map((c) => c.id)))
    check('S5-b fixture contact 8184+8185 masih live (belum dihapus)', fc.length === 2)
  }

  await prisma.$disconnect()
  console.log(`\n=== e2e-v431: ${pass} PASS / ${fails.length} FAIL ===`)
  if (fails.length) { console.log('FAILED:', fails.join(' | ')); process.exitCode = 1 }
  process.exit(process.exitCode || 0)
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })