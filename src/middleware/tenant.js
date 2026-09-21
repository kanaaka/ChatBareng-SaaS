// v3.0 Phase 1 — Isolasi tenant middleware (default-deny).
// Dipisah dari auth.js agar jelas batasnya; diekspor ulang dari auth.js agar
// pemanggil lama tetap jalan. File ini dokumentasi-canonical: SEMUA route
// tenant-scoped WAJIB memasang requireTenant dan memfilter query Prisma
// dengan `tenantId: req.tenantId`.
const {
  requireSuperAdmin,
  requireTenant,
  resolveTenant,
  forbidSuperAdmin,
} = require('../auth')

module.exports = {
  requireSuperAdmin,
  requireTenant,
  resolveTenant,
  forbidSuperAdmin,
}