/**
 * v3.0 Phase 1 — Seed default PER-TENANT (dipanggil saat superadmin create tenant).
 *
 * Dipindah dari server.js (boot global) ke sini: config singleton & folder sistem
 * tidak lagi global id=1 — semua jadi per-tenant via @@unique([tenantId]).
 * Idempoten: aman dipanggil ulang untuk tenant yang sama (find-first guard).
 *
 * Dipanggil dari: POST /api/sa/tenants (superadmin.js).
 */

const prisma = require('../prisma')

/**
 * Seed semua default milik satu tenant. Idempoten.
 * @param {number} tenantId
 * @returns {Promise<{ seeded: string[] }>} daftar item yang benar-benar dibuat
 */
async function seedTenantDefaults(tenantId) {
  const tid = Number(tenantId)
  if (!Number.isFinite(tid) || tid <= 0) throw new Error('Invalid tenantId')
  const seeded = []

  // ── 1. Folder sistem Tangan Kanan (Image / Document / Link) ──
  const systemFolders = ['Image', 'Document', 'Link']
  for (const name of systemFolders) {
    const existing = await prisma.sharedFolder.findFirst({
      where: { tenantId: tid, name, isSystem: true },
    })
    if (!existing) {
      await prisma.sharedFolder.create({ data: { tenantId: tid, name, isSystem: true } })
      seeded.push(`folder:${name}`)
    }
  }

  // ── 2. AutoReplyConfig (v0.7.0 — default kedua fitur OFF) ──
  const ar = await prisma.autoReplyConfig.findUnique({ where: { tenantId: tid } })
  if (!ar) {
    await prisma.autoReplyConfig.create({ data: { tenantId: tid } })
    seeded.push('autoReplyConfig')
  }

  // ── 3. AppearanceConfig (v0.9.0 — default ungu Parahita) ──
  const ap = await prisma.appearanceConfig.findUnique({ where: { tenantId: tid } })
  if (!ap) {
    const { buildCssVars, DEFAULT_SEED } = require('./appearance')
    await prisma.appearanceConfig.create({
      data: { tenantId: tid, accentSeed: DEFAULT_SEED, themeCss: buildCssVars(DEFAULT_SEED) },
    })
    seeded.push('appearanceConfig')
  }

  // ── 4. CsatConfig (v0.10.0 — default OFF) ──
  const cs = await prisma.csatConfig.findUnique({ where: { tenantId: tid } })
  if (!cs) {
    await prisma.csatConfig.create({ data: { tenantId: tid } })
    seeded.push('csatConfig')
  }

  // ── 5. BackupConfig (v0.8.0 — default OFF) ──
  const bc = await prisma.backupConfig.findUnique({ where: { tenantId: tid } })
  if (!bc) {
    await prisma.backupConfig.create({ data: { tenantId: tid } })
    seeded.push('backupConfig')
  }

  // ── 6. AppConfig (v0.12.9 — read receipts default OFF) ──
  const ac = await prisma.appConfig.findUnique({ where: { tenantId: tid } })
  if (!ac) {
    await prisma.appConfig.create({ data: { tenantId: tid } })
    seeded.push('appConfig')
  }

  // ── 7. MenuGatewayConfig (v0.13.0 — default OFF, tanpa opsi) ──
  const mg = await prisma.menuGatewayConfig.findUnique({ where: { tenantId: tid } })
  if (!mg) {
    await prisma.menuGatewayConfig.create({ data: { tenantId: tid } })
    seeded.push('menuGatewayConfig')
  }

  if (seeded.length) {
    console.log(`[TenantSeed] Tenant #${tid} seeded: ${seeded.join(', ')}`)
  } else {
    console.log(`[TenantSeed] Tenant #${tid} sudah lengkap (idempotent skip)`)
  }
  return { seeded }
}

module.exports = { seedTenantDefaults }