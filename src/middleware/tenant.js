// v3.0 — Isolasi tenant middleware (default-deny).
// Dipisah dari auth.js agar jelas batasnya; diekspor ulang dari auth.js agar
// pemanggil lama tetap jalan. File ini dokumentasi-canonical: SEMUA route
// tenant-scoped WAJIB memasang requireTenant dan memfilter query Prisma
// dengan `tenantId: req.tenantId`.
// v3.8 — + requireActiveSubscription (guard masa aktif, READ-ONLY enforcement):
// pasang SETELAH requireTenant pada SEMUA route NON-GET (POST/PUT/PATCH/DELETE).
const {
  requireSuperAdmin,
  requireTenant,
  resolveTenant,
  forbidSuperAdmin,
  requireActiveSubscription,
} = require('../auth')

module.exports = {
  requireSuperAdmin,
  requireTenant,
  resolveTenant,
  forbidSuperAdmin,
  requireActiveSubscription,
}