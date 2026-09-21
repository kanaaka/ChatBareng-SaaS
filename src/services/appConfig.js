/**
 * v0.12.9 — AppConfig service: pengaturan read receipts (admin tenant, universal
 * utk tenant-nya). v3.0 — PER-TENANT: satu row per tenant (@@unique([tenantId])).
 * Cache in-memory per-tenant sampai invalidate() (dipanggil saat PUT sukses) —
 * dibaca di hot path (receipts) tanpa query tambahan per pesan.
 */
const prisma = require('../prisma')

const cache = new Map() // tenantId → AppConfig row

async function getConfig(tenantId) {
  const tid = Number(tenantId)
  if (!Number.isFinite(tid)) throw new Error('appConfig.getConfig butuh tenantId')
  if (cache.has(tid)) return cache.get(tid)
  // Upsert idempotent: kalau row belum ada (tenant tanpa seed), buat dengan default
  const cfg = await prisma.appConfig.upsert({
    where: { tenantId: tid },
    update: {},
    create: { tenantId: tid },
  })
  cache.set(tid, cfg)
  return cfg
}

function invalidate(tenantId) {
  if (tenantId === undefined) cache.clear()
  else cache.delete(Number(tenantId))
}

module.exports = { getConfig, invalidate }