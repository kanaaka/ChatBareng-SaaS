const { PrismaClient } = require('@prisma/client')
const bcrypt = require('bcryptjs')

const prisma = new PrismaClient()

async function main() {
  const existing = await prisma.user.findUnique({ where: { username: 'admin' } })
  if (existing) {
    console.log('Admin user already exists, skipping seed.')
    return
  }
  
  const passwordHash = await bcrypt.hash('admin123', 12)
  await prisma.user.create({
    data: {
      username: 'admin',
      passwordHash,
      role: 'admin',
      status: 'active'
    }
  })
  console.log('Default admin user created (username: admin, password: admin123)')
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())