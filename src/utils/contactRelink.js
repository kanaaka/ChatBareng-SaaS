// ═══════════════════════════════════════════════════════════════════
// v3.7 — Anti-duplicate re-link kontak orphan (helper shared).
// ═══════════════════════════════════════════════════════════════════
// Latar: fitur "Hapus Chat" v3.7 mode KEEP — kontak yang di-pertahankan jadi
// orphan (chatId=null, data utuh). Kalau chat yang sama dibuka lagi / orangnya
// chat lagi, sistem WAJIB re-link ke kontak yang SAMA (match by phone,
// tenant-scoped), BUKAN bikin kontak dobel — kasus kontak dobel "Berliana"
// (LID mismatch) tidak boleh kambuh lewat pintu manapun.
//
// Dipakai 4 jalur yang bisa bikin kontak dobel:
//   C1 src/wa/pool.js         — syncContactFromChat (WA masuk / chat sync)
//   C2 src/routes/contacts.js — GET /api/contacts/by-chat/:chatId (get-or-create)
//   C3 src/services/autoReply.js — setContactMenuShown (fallback create minimal)
//   C4 src/routes/contacts.js — POST /api/contacts/:id/open (start chat)
//
// Semantik (RACE-SAFE):
// - HANYA menulis bila row masih benar-benar orphan: updateMany berkondisi
//   { id, tenantId, chatId: null } → count 0 berarti kondisi berubah (proses
//   lain sudah re-link / kontak sudah terhapus) → SKIP, jangan overwrite.
// - patch name/phone hanya fill-empty (tidak menimpa data terisi).
// - TIDAK pernah create row; pemanggil tetap pegang create-path-nya sendiri.
// - chatId wajib; phone wajib (re-link berbasis nomor — LID tanpa nomor
//   diserahkan ke mapping LID v3.5).
// - Non-fatal total: error → log + return null; caller lanjut ke path lama.
// ═══════════════════════════════════════════════════════════════════
const prisma = require('../prisma')

async function relinkOrphanContact(tenantId, phone, chatId, name = null) {
  try {
    const tid = Number(tenantId)
    const cid = Number(chatId)
    if (!tid || !Number.isFinite(cid)) return null
    if (phone === null || phone === undefined) return null
    const phoneNorm = String(phone).trim()
    if (!/^\d+$/.test(phoneNorm)) return null // LID digits / invalid → skip (biarkan mapping LID v3.5)

    // v3.7 — ORPHAN-FIRST: pilih row chatId=null DULU (bukan row tertua), lalu
    // fallback row tertua apapun statusnya. Pola konsisten dgn C2 contacts.js.
    // Bila tidak ada row sama sekali → null (bukan milik helper ini — caller
    // yang create baru).
    let existing = await prisma.contact.findFirst({
      where: { tenantId: tid, phone: phoneNorm, chatId: null },
      orderBy: { id: 'asc' },
      select: { id: true, name: true, phone: true, chatId: true },
    })
    if (!existing) {
      const any = await prisma.contact.findFirst({
        where: { tenantId: tid, phone: phoneNorm },
        orderBy: { id: 'asc' },
        select: { id: true, name: true, phone: true, chatId: true },
      })
      if (!any) return null // belum pernah ada kontak dgn nomor ini
      if (any.chatId === cid) return null // sudah ke-link ke chat ini — no-op
      return null // sudah ke-link ke chat LAIN → BUKAN duplikat; JANGAN disentuh
    }
    if (existing.chatId === cid) return null // no-op (tak mungkin — filter chatId null — tapi defensif)

    // RE-LINK race-safe: hanya bila masih orphan (chatId null). Count 0 = sudah
    // diambil proses lain → JANGAN overwrite. Unique `chatId` (row lain sudah
    // nge-claim chat ini di antara find & update) → treat sebagai null (bukan
    // fatal; caller lanjut ke path-nya sendiri).
    let res
    try {
      res = await prisma.contact.updateMany({
        where: { id: existing.id, tenantId: tid, chatId: null },
        data: { chatId: cid },
      })
    } catch (e) {
      if (String(e?.message || '').includes('Unique constraint failed')) {
        console.log(`[ContactRelink] chat #${cid} sudah di-claim kontak lain (race) — skip re-link`)
        return null
      }
      throw e
    }
    if (res.count !== 1) return null

    // Patch name/phone fill-empty-only (nama chat menang utk chat ini, kontak
    // tidak pernah kehilangan nama lama bila sudah ada).
    const patch = {}
    if (name && !existing.name) patch.name = name
    if (Object.keys(patch).length > 0) {
      try {
        await prisma.contact.updateMany({ where: { id: existing.id, tenantId: tid }, data: patch })
      } catch {}
    }
    console.log(`[ContactRelink] orphan re-link: contact #${existing.id} (phone ${phoneNorm}, tenant ${tid}) → chat #${cid}`)
    return existing.id
  } catch (e) {
    console.error('[ContactRelink] relinkOrphanContact error (non-fatal):', e.message)
    return null
  }
}

module.exports = { relinkOrphanContact }