// Reset password superadmin di DB COPY (BUKAN produksi) — biar E2E bisa login
const REPO = '/home/kanakxxx/.openclaw/workspace/wa-cs-hub-saas-v3'
require(REPO + '/node_modules/dotenv').config({ path: REPO + '/.env' })
process.env.DATABASE_URL = 'file:/tmp/saas-v3-e2e.db'
const { PrismaClient } = require(REPO + '/node_modules/@prisma/client')
const { hashPassword } = require(REPO + '/src/auth')
const prisma = new PrismaClient({ datasourceUrl: 'file:/tmp/saas-v3-e2e.db' })
;(async () => {
  const u = await prisma.user.findFirst({ where: { role: 'super_admin' } })
  if (!u) { console.log('NO superadmin row'); process.exit(1) }
  console.log('found:', u.username, 'status:', u.status)
  const hash = await hashPassword(process.env.SUPERADMIN_PASSWORD)
  await prisma.user.update({ where: { id: u.id }, data: { passwordHash: hash, status: 'active' } })
  console.log('password reset OK (copy db only)')
  await prisma.$disconnect()
})().catch((e) => { console.error(e.message); process.exit(1) })