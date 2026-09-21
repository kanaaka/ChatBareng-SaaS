// ═══════════════════════════════════════════════════════════════════════
// v0.14.0 — Manajemen Grup (PIC Model) — routes (spec §5)
// v3.0 — SEMUA endpoint tenant-scoped: requireTenant + tenantId dari JWT/impersonasi.
// Semua endpoint grup: WA belum open → 503 WA_BELUM_TERHUBUNG (service);
// bot bukan admin → 422 BOT_BUKAN_ADMIN (BUKAN 500) — spec §0/§3/§5.
// Akses grup = PIC & admin saja (matriks §3); CS lain/cabang non-PIC → 403.
// Semua aksi → GroupActionLog (ditulis di service).
// ═══════════════════════════════════════════════════════════════════════

const express = require('express')
const router = express.Router()
const { requireAuth, requireTenant } = require('../auth')
const groups = require('../services/groups')

const rt = [requireAuth, requireTenant]

function sendGroupError(res, e) {
  if (e instanceof groups.GroupServiceError) {
    return res.status(e.status).json({ error: e.message, code: e.code })
  }
  console.error('[Groups] route error:', e?.message || e)
  return res.status(500).json({ error: 'Internal server error' })
}

// GET /api/groups — PIC: miliknya; admin: semua + yatim; lainnya: [] (spec §5)
router.get('/', ...rt, async (req, res) => {
  try {
    const items = await groups.listGroups(req.user, req.tenantId)
    res.json({ groups: items })
  } catch (e) {
    sendGroupError(res, e)
  }
})

// GET /api/groups/:id — metadata + members + botIsAdmin (PIC/admin saja)
// :id = waJid grup (@g.us) — row Chat di-resolve via [tenantId, waJid].
router.get('/:id', ...rt, async (req, res) => {
  try {
    const detail = await groups.getGroupDetail(req.user, req.tenantId, req.params.id)
    res.json(detail)
  } catch (e) {
    sendGroupError(res, e)
  }
})

// POST /api/groups — create (relay → 403; CS → self PIC; admin → picUserId opsional)
router.post('/', ...rt, async (req, res) => {
  try {
    const result = await groups.createGroup(req.user, req.tenantId, req.body || {})
    res.status(201).json(result)
  } catch (e) {
    sendGroupError(res, e)
  }
})

// PATCH /api/groups/:id — rename/description (PIC/admin, bot admin required)
router.patch('/:id', ...rt, async (req, res) => {
  try {
    const result = await groups.updateGroupInfo(req.user, req.tenantId, req.params.id, req.body || {})
    res.json(result)
  } catch (e) {
    sendGroupError(res, e)
  }
})

// POST /api/groups/:id/members — {phones[], action: add|remove|promote|demote}
// Respons per-member {phone, status, error?} — partial failure friendly (spec §5)
router.post('/:id/members', ...rt, async (req, res) => {
  try {
    const result = await groups.updateMembers(req.user, req.tenantId, req.params.id, req.body || {})
    res.json(result)
  } catch (e) {
    sendGroupError(res, e)
  }
})

// POST /api/groups/:id/settings — {announcement?, locked?, approval?, memberAddMode?}
router.post('/:id/settings', ...rt, async (req, res) => {
  try {
    const result = await groups.updateSettings(req.user, req.tenantId, req.params.id, req.body || {})
    res.json(result)
  } catch (e) {
    sendGroupError(res, e)
  }
})

// POST /api/groups/:id/invite-reset — revoke+new code (UI confirm wajib — link lama mati)
router.post('/:id/invite-reset', ...rt, async (req, res) => {
  try {
    const result = await groups.resetInvite(req.user, req.tenantId, req.params.id)
    res.json(result)
  } catch (e) {
    sendGroupError(res, e)
  }
})

// POST /api/groups/:id/leave — bot keluar grup (admin; ops cleanup grup uji/orphan)
router.post('/:id/leave', ...rt, async (req, res) => {
  try {
    const result = await groups.leaveGroup(req.user, req.tenantId, req.params.id)
    res.json(result)
  } catch (e) {
    sendGroupError(res, e)
  }
})

// POST /api/groups/:id/assign-pic — admin only; juga mengisi assignedToId (spec §4)
router.post('/:id/assign-pic', ...rt, async (req, res) => {
  try {
    const result = await groups.assignPic(req.user, req.tenantId, req.params.id, req.body?.picUserId)
    res.json(result)
  } catch (e) {
    sendGroupError(res, e)
  }
})

// ═══════════════════════════════════════════════════════════════════════
// v0.14.4 — Participant Action Menu (tap nama pengirim di bubble grup):
// simpan peserta ke Kontak + kirim pesan pribadi (chat 1:1). pmJid = full JID
// participant (biasanya @lid) — URL-encoded otomatis oleh axios frontend.
// ═══════════════════════════════════════════════════════════════════════

// POST /api/groups/:id/participants/:pmJid/save-contact — simpan peserta → Kontak
router.post('/:id/participants/:pmJid/save-contact', ...rt, async (req, res) => {
  try {
    const result = await groups.saveParticipantContact(req.user, req.tenantId, req.params.id, req.params.pmJid)
    res.json(result)
  } catch (e) {
    sendGroupError(res, e)
  }
})

// POST /api/groups/:id/participants/:pmJid/pm — {content} kirim pesan pribadi
router.post('/:id/participants/:pmJid/pm', ...rt, async (req, res) => {
  try {
    const result = await groups.pmParticipant(req.user, req.tenantId, req.params.id, req.params.pmJid, req.body || {})
    res.json(result)
  } catch (e) {
    sendGroupError(res, e)
  }
})

module.exports = router