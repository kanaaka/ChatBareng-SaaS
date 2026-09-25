<template>
  <!--
    v3.9.19 — SuperAdmin DIPILAH jadi shell (AdminShell) + 4 child view:
      /superadmin            → SaOverview.vue  (dashboard baru: cards + charts)
      /superadmin/tenants    → SaTenants.vue   (list + 10 tombol + 4 modal + admin/purge)
      /superadmin/audit      → SaAudit.vue     (audit log + filter + cursor)
      /superadmin/pengaturan → SaPengaturan.vue (ganti password + branding platform)
    Komponen SaSidebar.vue = layout shell (sidebar desktop / drawer mobile).
    Router tetap /superadmin (meta.superadmin preserved). Semua state & handler logic
    existing dipindah UTUH ke child views (zero behavior change; additive murni).
  -->
  <SaSidebar>
    <router-view />
  </SaSidebar>
</template>

<script setup>
// v3.9.19 — shell SuperAdmin: layout sidebar + child router-view.
// Semua logic (list tenant, 10 tombol/row, 4 modal, admin form, purge confirm,
// audit viewer, ganti password) kini tinggal di child views masing-masing:
// SaOverview / SaTenants / SaAudit / SaPengaturan.
import SaSidebar from '../components/SaSidebar.vue'
</script>