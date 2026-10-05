// v0.1.21 — Queue discipline helpers
// v3.0 — queue count PER TENANT. emitQueueUpdate(tenantId) wajib menyertakan tenantId.
// v0.13.3 — Invariant §4.1 (Menu Gateway): chat menuState='awaiting' (limbo) TIDAK
// dihitung antrean / tidak terlihat di queue_update. JEBAK NULL Prisma:
// { menuState: { not: 'awaiting' } } TIDAK match row NULL → wajib OR eksplisit
// [{ menuState: null }, { menuState: { not: 'awaiting' } }].
// v0.14.9 — exclude grup dari antrean (waJid-based, bukan id — id sekarang Int).
const prisma = require('../prisma')
const broadcast = require('./broadcast')
// v4.6.4-log (spec docs/spec-log-coverage-upgrade.md §B2) — breadcrumbs QUEUE-EMIT:
// bug "count gak update" jadi kelihatan (dipanggil/tidak, dgn nilai berapa). Info
// flood-guarded ±300/menit; best-effort via systemLog.
const systemLog = require('../services/systemLog')

// Filter antrean bersama (v0.13.3): open + unassigned + punya pesan aktif +
// BUKAN awaiting + BUKAN grup. Chat awaiting = milik alur Menu Gateway (limbo).
// Chat grup = alur PIC sendiri. Invariant: banner count == isi tab Unassigned.
function queueWhere(tenantId) {
  return {
    tenantId,
    status: 'open',
    assignedToId: null,
    messages: { some: { purged: false } },
    OR: [{ menuState: null }, { menuState: { not: 'awaiting' } }],
    // v0.14.9 (v3 port) — exclude grup dari antrean: waJid endsWith '@g.us'
    // (id primary key selalu terisi → NOT bebas jebakan NULL; waJid juga not-null).
    // v4.4.0 F3 — exclude JUGA chat yang kontaknya ber-tag excludeFromQueue=true
    // (silent block: chat tetap tampil normal di list, hanya tidak masuk antrean
    // untuk di-take). NOT array = grup ATAU kontak ber-tag. Chat TANPA contact
    // (Chat.contact Contact? nullable) tidak match inner relation → TETAP masuk
    // antrean (by design). Yang membatasi = tag level KONTAK (ContactTag);
    // tag level chat (ChatTag) tidak memengaruhi antrean.
    NOT: [
      { waJid: { endsWith: '@g.us' } },
      { contact: { tags: { some: { tag: { excludeFromQueue: true } } } } },
    ],
  }
}

async function getQueueCount(tenantId) {
  // v0.1.22 — chat tanpa pesan aktif (habis purge) tidak dihitung antrean
  // v0.13.3 — exclude menuState='awaiting' (invariant §4.1)
  return prisma.chat.count({ where: queueWhere(tenantId) })
}

// Broadcast 'queue_update' {count} ke room tenant.
async function emitQueueUpdate(tenantId) {
  try {
    const count = await prisma.chat.count({ where: queueWhere(tenantId) })
    broadcast.emitToTenant(tenantId, 'queue_update', { count })
    // v4.6.4-log §B2 — breadcrumbs bisnis (best-effort; stdout TIDAK berubah)
    try {
      systemLog.logInfo(`QUEUE-EMIT tenant=${Number(tenantId)} count=${count}`, {
        module: 'chat',
        tenantId: tenantId == null ? null : Number(tenantId),
        meta: { count },
      })
    } catch { /* best-effort */ }
    return count
  } catch (e) {
    console.error('[queue] emitQueueUpdate error:', e.message)
    return null
  }
}

module.exports = { getQueueCount, emitQueueUpdate, queueWhere }
