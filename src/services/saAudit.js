// v3.4 — Audit log superadmin (spec §2/§5): trail PERMANEN semua aksi SA.
// tenantId/actorId plain (tanpa FK) → row tetap hidup walau tenant di-purge.
// TIDAK pernah dibaca/dihapus oleh purge tenant (spec §2).
const prisma = require('../prisma')

/**
 * audit(actor, action, tenantId|null, tenantName|null, detail)
 * @param {object} actor req.user superadmin (id, username)
 * @param {string} action salah satu: tenant_create|tenant_update|tenant_delete|
 *   tenant_purge|plan_update|branding_update|backup_download|impersonate|admin_create
 * @param {object|null} detail objek ringkas → diserialisasi JSON (dipotong 8KB)
 * Best-effort: kegagalan audit TIDAK pernah menggagalkan aksi utama.
 */
async function audit(actor, action, tenantId = null, tenantName = null, detail = null) {
  try {
    let detailJson = null
    if (detail !== null && detail !== undefined) {
      try {
        detailJson = JSON.stringify(detail)
      } catch {
        detailJson = String(detail)
      }
      if (detailJson && detailJson.length > 8000) detailJson = detailJson.slice(0, 8000)
    }
    await prisma.saAuditLog.create({
      data: {
        actorId: actor?.id ?? null,
        actorUsername: actor?.username ?? 'unknown',
        action: String(action),
        tenantId: tenantId == null ? null : Number(tenantId),
        tenantName: tenantName == null ? null : String(tenantName).slice(0, 120),
        detailJson,
      },
    })
  } catch (e) {
    console.error('[SaAudit] write error (non-fatal):', e.message)
  }
}

module.exports = { audit }