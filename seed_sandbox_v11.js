// Seed sandbox CB 5057: tenant + plan featApiAccess + admin/cs users + API key 4 scopes.
// Jalankan: DATABASE_URL="file:/tmp/cbtest-e2e.db" node seed_sandbox_v11.js
const { PrismaClient } = require('@prisma/client')
const bcryptjs = require('bcryptjs')
const apiKeys = require('./src/services/apiKeys')

const prisma = new PrismaClient()

async function main() {
  // idempotent: hapus tenant lama kalau ada
  const old = await prisma.tenant.findUnique({ where: { name: 'E2E Sandbox' } })
  if (old) {
    await prisma.tenant.delete({ where: { id: old.id } }).catch(() => {})
    await prisma.user.deleteMany({ where: { username: { in: ['admin-sb', 'cs-sb'] } } }).catch(() => {})
  }

  const tenant = await prisma.tenant.create({ data: { name: 'E2E Sandbox', status: 'active' } })
  await prisma.tenantPlan.create({
    data: { tenantId: tenant.id, preset: 'custom', featApiAccess: true },
  })

  const adminPw = bcryptjs.hashSync('SandboxAdmin2026!', 10)
  const csPw = bcryptjs.hashSync('SandboxCS2026!', 10)

  const admin = await prisma.user.create({
    data: { username: 'admin-sb', passwordHash: adminPw, role: 'admin', tenantId: tenant.id, status: 'active' },
  })
  const cs = await prisma.user.create({
    data: { username: 'cs-sb', passwordHash: csPw, role: 'cs', tenantId: tenant.id, status: 'active' },
  })

  // key full-scope (planGated false — plan sudah featApiAccess, dua-duanya aman)
  const gen = await apiKeys.generate({
    tenantId: tenant.id,
    name: 'E2E full-scope',
    scopes: ['send', 'read', 'choose_slot', 'assign_agent'],
    planGated: false,
    createdByUserId: admin.id,
  })
  // key scope-send-saja (gate test)
  const gen2 = await apiKeys.generate({
    tenantId: tenant.id,
    name: 'E2E send-only',
    scopes: ['send'],
    planGated: false,
    createdByUserId: admin.id,
  })

  console.log(JSON.stringify({
    tenantId: tenant.id,
    adminId: admin.id,
    csId: cs.id,
    fullKey: gen.rawKey,
    sendOnlyKey: gen2.rawKey,
  }, null, 2))
}

main().then(() => prisma.$disconnect()).catch((e) => {
  console.error('SEED ERR:', e.message)
  process.exit(1)
})