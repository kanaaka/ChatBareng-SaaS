// v3.9.13 — Seed idempoten: TenantPlan preset 'max' → featApiAccess=true.
// Dijalanin sekali setelah deploy (Aman: idempoten — row non-max TIDAK disentuh).
// Usage: node prisma/seed-api-access.js
const path = require('path')
process.env.NODE_ENV = process.env.NODE_ENV || 'production'
const { PrismaClient } = require('@prisma/client')

// Default: DB produksi dari .env (DATABASE_URL). Override via argumen utk DB copy.
const prisma = new PrismaClient({
  datasources: process.argv[2] ? { db: { url: 'file:' + process.argv[2] } } : undefined,
})

async function main() {
  const result = await prisma.tenantPlan.updateMany({
    where: { preset: 'max' },
    data: { featApiAccess: true },
  })
  console.log(`[Seed] featApiAccess=true untuk plan preset 'max' → ${result.count} tenant di-update`)
}

main()
  .catch((e) => {
    console.error('[Seed] error:', e.message)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())