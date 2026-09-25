<template>
  <!--
    v3.0 Phase 1 — Superadmin platform (minimal):
    daftar tenant (nama, status, #user, #chat) + buat Tenant + buat Admin per tenant +
    suspend/activate. Style konsisten (max-w-4xl, card, hijau WA). super_admin saja.
    v3.1.1 — panel Akun: ganti password mandiri (superadmin sengaja tidak punya
    akses /settings → self-service change-password v0.12.2 dipasang di sini).
  -->
  <div class="min-h-screen bg-surface">
    <div class="max-w-4xl mx-auto px-4 py-8">
      <!-- Header -->
      <div class="flex items-center justify-between mb-6">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-[var(--md-sys-shape-corner-m)] flex items-center justify-center"
            style="background: #25D366;">
            <svg class="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm5 13.6c-.2.6-1.2 1.2-1.7 1.2-.4.1-1 .1-1.6-.1-.4-.1-.9-.3-1.5-.5-2.6-1.1-4.3-3.7-4.4-3.9-.1-.2-1-1.4-1-2.6 0-1.2.6-1.8.9-2 .2-.3.5-.3.7-.3h.5c.2 0 .4 0 .6.4l.8 2c.1.2.1.4 0 .6l-.4.6c-.1.2-.3.4-.1.7.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.3 2.4 1.5.3.1.5.1.6-.1l.8-1c.2-.2.4-.2.6-.1l1.9.9c.4.2.4.4.4.6 0 .2 0 .7-.5 1z"/>
            </svg>
          </div>
          <div>
            <h1 class="text-2xl font-bold" :style="{ color: 'var(--md-sys-color-on-surface)' }">Superadmin</h1>
            <p class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
              Platform multi-tenant — @{{ auth.user?.username }}
            </p>
          </div>
        </div>
        <button
          class="m3-btn m3-btn--tonal !min-h-[40px]"
          @click="handleLogout"
        >Keluar</button>
      </div>

      <!-- Stats -->
      <div v-if="stats" class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <div class="sa-card">
          <div class="sa-stat">{{ stats.tenants }}</div>
          <div class="sa-label">Tenant</div>
        </div>
        <div class="sa-card">
          <div class="sa-stat">{{ stats.activeTenants }}</div>
          <div class="sa-label">Aktif</div>
        </div>
        <div class="sa-card">
          <div class="sa-stat">{{ stats.users }}</div>
          <div class="sa-label">User</div>
        </div>
        <div class="sa-card">
          <div class="sa-stat">{{ stats.chats }}</div>
          <div class="sa-label">Chat</div>
        </div>
        <div class="sa-card">
          <div class="sa-stat">{{ stats.messages }}</div>
          <div class="sa-label">Pesan</div>
        </div>
      </div>

      <!-- Form + Tenant -->
      <div class="sa-panel">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-lg font-semibold" :style="{ color: 'var(--md-sys-color-on-surface)' }">Daftar Tenant</h2>
          <button
            class="m3-btn m3-btn--filled !min-h-[40px]"
            @click="showCreate = !showCreate"
          >+ Tenant</button>
        </div>

        <!-- Create tenant form (v3.4 — preset dropdown default Lite) -->
        <div v-if="showCreate" class="sa-form">
          <M3TextField v-model="newTenantName" label="Nama tenant (perusahaan)" type="text" />
          <label class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">Paket awal</label>
          <select v-model="newTenantPreset" class="m3-select sa-select">
            <option value="lite">Lite — 3 agen · 2 GB TK · 5.000 kontak · fitur dasar</option>
            <option value="pro">Pro — 10 agen · 5 GB TK · 10.000 kontak · semua kecuali GDrive</option>
            <option value="max">Max — 50 agen · 10 GB TK · 50.000 kontak · semua fitur</option>
          </select>
          <div class="flex gap-2 justify-end mt-2">
            <button class="m3-btn m3-btn--text !min-h-[40px]" @click="showCreate = false">Batal</button>
            <button class="m3-btn m3-btn--filled !min-h-[40px]" :disabled="creating" @click="createTenant">
              {{ creating ? 'Membuat…' : 'Buat Tenant' }}
            </button>
          </div>
        </div>

        <div v-if="error" class="flex items-start gap-2 text-sm rounded-[var(--md-sys-shape-corner-s)] p-3 mb-4"
          style="background: var(--md-sys-color-error-container); color: var(--md-sys-color-on-error-container);"
          role="alert">
          <span aria-hidden="true">⚠️</span>
          <span>{{ error }}</span>
        </div>
        <div v-if="purgeSuccess" class="flex items-start gap-2 text-sm rounded-[var(--md-sys-shape-corner-s)] p-3 mb-4"
          style="background: var(--md-sys-color-primary-container); color: var(--md-sys-color-on-primary-container);"
          role="status">
          <span aria-hidden="true">✓</span>
          <span>{{ purgeSuccess }}</span>
        </div>

        <!-- Tenant list -->
        <div v-if="loading" class="sa-empty">Memuat…</div>
        <div v-else-if="tenants.length === 0" class="sa-empty">
          Belum ada tenant. Klik <strong>+ Tenant</strong> untuk membuat perusahaan pertama.
        </div>
        <div v-else class="space-y-3">
          <div v-for="t in tenants" :key="t.id" class="sa-tenant">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="font-semibold truncate" :style="{ color: 'var(--md-sys-color-on-surface)' }">#{{ t.id }} · {{ t.name }}</span>
                  <span class="sa-pill sa-pill--plan">{{ planLabel(t) }}</span>
                  <span
                    class="sa-pill"
                    :style="t.status === 'active'
                      ? 'background:#dcfce7;color:#166534;'
                      : 'background:#fee2e2;color:#991b1b;'"
                  >{{ t.status === 'active' ? 'active' : 'suspended' }}</span>
                  <!-- v3.8 — chip masa aktif (validityState) -->
                  <span v-if="validityChip(t)" class="sa-pill" :style="validityChip(t).style">{{ validityChip(t).label }}</span>
                  <!-- v3.8 §A — chip status WA real-time (polling 15s) -->
                  <span v-if="t.waStatus?.disabled" class="sa-pill" style="background:#e5e7eb;color:#374151;">WA off</span>
                  <span v-else-if="t.waStatus?.connected" class="sa-pill" style="background:#dcfce7;color:#166534;">WA terhubung</span>
                  <span v-else-if="t.waStatus?.qrNeeded" class="sa-pill" style="background:#fef9c3;color:#854d0e;">Menunggu scan QR</span>
                  <span v-else class="sa-pill" style="background:#e5e7eb;color:#374151;">Terputus</span>
                  <!-- v3.9 — jumlah nomor + mode -->
                  <span v-if="t.slots && t.slots.length > 1" class="sa-pill" style="background:#dbeafe;color:#1e40af;">{{ t.slots.filter(s => s.status?.connected).length }}/{{ t.slots.length }} nomor · {{ t.waMode }}</span>
                </div>
                <div class="text-sm mt-1" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
                  {{ t.userCount }} user · {{ t.chatCount }} chat
                  <template v-if="t.waPhone"> · WA +{{ t.waPhone }}</template>
                </div>
                <!-- v3.9 — daftar slot per tenant (label + nomor + status per-slot) -->
                <div v-if="t.slots && t.slots.length > 0" class="flex flex-wrap gap-1 mt-2">
                  <span
                    v-for="s in t.slots" :key="s.slot"
                    class="sa-pill"
                    :style="s.status?.connected ? 'background:#dcfce7;color:#166534;' : 'background:#e5e7eb;color:#374151;'"
                    :title="s.waSessionDir || ''"
                  >
                    slot {{ s.slot }}{{ s.label ? ' · ' + s.label : '' }}{{ s.status?.connected ? ' ✓ +' + (s.status.phoneNumber || '') : ' ✕' }}
                  </span>
                </div>
                <!-- v3.4 — usage meter mini + chip fitur aktif -->
                <div v-if="t.usage" class="sa-usage mt-2">
                  <span class="sa-meter" title="Agen">👤 {{ t.usage.agents }}/{{ t.plan?.maxAgents ?? '∞' }}</span>
                  <span class="sa-meter">📇 {{ fmtNum(t.usage.contacts) }}/{{ t.plan?.maxContacts != null ? fmtNum(t.plan.maxContacts) : '∞' }}</span>
                  <span class="sa-meter">🗂️ {{ fmtBytes(t.usage.tkBytes) }}/{{ t.plan?.tkQuotaBytes != null ? fmtBytes(t.plan.tkQuotaBytes) : '∞' }}</span>
                </div>
                <div v-if="t.plan" class="flex flex-wrap gap-1 mt-2">
                  <span v-for="f in activeFeatures(t)" :key="f.key" class="sa-pill sa-pill--feat">{{ f.label }}</span>
                </div>
              </div>
              <div class="flex flex-wrap gap-2 justify-end">
                <!-- v3.9 — kelola nomor per tenant -->
                <button class="m3-btn m3-btn--tonal !min-h-[36px] !text-sm" @click="openNumbersModal(t)">Nomor WA</button>
                <!-- v3.8 — masa aktif tenant -->
                <button class="m3-btn m3-btn--tonal !min-h-[36px] !text-sm" @click="openValidityModal(t)">Masa Aktif</button>
                <button class="m3-btn m3-btn--tonal !min-h-[36px] !text-sm" @click="openPlanModal(t)">Edit Paket</button>
                <button class="m3-btn m3-btn--tonal !min-h-[36px] !text-sm" @click="openBrandingModal(t)">Branding</button>
                <button class="m3-btn m3-btn--tonal !min-h-[36px] !text-sm" :disabled="backingUp === t.id" @click="backupTenant(t)">
                  {{ backingUp === t.id ? 'Membuat…' : 'Backup' }}
                </button>
                <button class="m3-btn m3-btn--tonal !min-h-[36px] !text-sm" @click="impersonateTenant(t)">Impersonate</button>
                <button class="m3-btn m3-btn--tonal !min-h-[36px] !text-sm" @click="openAdminForm(t)">+ Admin</button>
                <button
                  v-if="t.status === 'active'"
                  class="m3-btn m3-btn--tonal !min-h-[36px] !text-sm"
                  @click="setStatus(t, 'suspended')"
                >Suspend</button>
                <button
                  v-else
                  class="m3-btn m3-btn--tonal !min-h-[36px] !text-sm"
                  @click="setStatus(t, 'active')"
                >Activate</button>
                <button
                  class="m3-btn m3-btn--text !min-h-[36px] !text-sm"
                  style="color: var(--md-sys-color-error);"
                  @click="openPurgeForm(t)"
                >Hapus</button>
              </div>
            </div>

            <!-- Create admin form per tenant -->
            <div v-if="adminFormFor === t.id" class="sa-form mt-3">
              <M3TextField v-model="adminUsername" label="Username admin" type="text" />
              <M3TextField v-model="adminPassword" label="Password (min 6)" type="password" />
              <div class="flex gap-2 justify-end mt-2">
                <button class="m3-btn m3-btn--text !min-h-[40px]" @click="adminFormFor = null">Batal</button>
                <button class="m3-btn m3-btn--filled !min-h-[40px]" :disabled="creatingAdmin" @click="createAdmin(t)">
                  {{ creatingAdmin ? 'Membuat…' : 'Buat Admin' }}
                </button>
              </div>
            </div>

            <!-- v3.1.2 — Hapus permanen: konfirmasi ketik nama tenant persis -->
            <div v-if="purgeFormFor === t.id" class="sa-form mt-3" style="border-left: 3px solid var(--md-sys-color-error);">
              <div class="text-sm font-semibold" :style="{ color: 'var(--md-sys-color-error)' }">
                ⚠️ Hapus permanen "{{ t.name }}"
              </div>
              <div class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
                Semua data tenant ini akan dihapus selamanya dan tidak bisa dikembalikan:
                {{ t.userCount }} user, {{ t.chatCount }} chat, semua pesan &amp; file media, kontak, tag,
                template, pengumuman, blast, config — semuanya.
              </div>
              <div class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
                Ketik <strong :style="{ color: 'var(--md-sys-color-on-surface)' }">{{ t.name }}</strong> persis untuk konfirmasi:
              </div>
              <M3TextField v-model="purgeConfirmName" :label="'Ketik: ' + t.name" type="text" />
              <div v-if="purgeError" class="flex items-start gap-2 text-sm rounded-[var(--md-sys-shape-corner-s)] p-3"
                style="background: var(--md-sys-color-error-container); color: var(--md-sys-color-on-error-container);"
                role="alert">
                <span aria-hidden="true">⚠️</span>
                <span>{{ purgeError }}</span>
              </div>
              <div class="flex gap-2 justify-end mt-2">
                <button class="m3-btn m3-btn--text !min-h-[40px]" @click="closePurgeForm">Batal</button>
                <button
                  class="m3-btn m3-btn--filled !min-h-[40px]"
                  style="background: var(--md-sys-color-error); color: var(--md-sys-color-on-error);"
                  :disabled="purging || purgeConfirmName.trim() !== t.name"
                  @click="purgeTenant(t)"
                >
                  {{ purging ? 'Menghapus…' : 'Hapus Permanen' }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- v3.4 — Audit viewer -->
      <div class="sa-panel mt-6">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-lg font-semibold" :style="{ color: 'var(--md-sys-color-on-surface)' }">Audit Log</h2>
          <div class="flex gap-2 items-center">
            <select v-model="auditFilterAction" class="m3-select sa-select !py-1.5">
              <option value="">Semua aksi</option>
              <option v-for="a in AUDIT_ACTIONS" :key="a" :value="a">{{ a }}</option>
            </select>
            <select v-model="auditFilterTenant" class="m3-select sa-select !py-1.5">
              <option value="">Semua tenant</option>
              <option v-for="t in tenants" :key="t.id" :value="String(t.id)">#{{ t.id }} {{ t.name }}</option>
            </select>
            <button class="m3-btn m3-btn--text !min-h-[36px] !text-sm" @click="loadAudit">Muat ulang</button>
          </div>
        </div>
        <div v-if="auditItems.length === 0" class="sa-empty">Belum ada aksi tercatat.</div>
        <div v-else class="sa-audit-list">
          <div v-for="a in auditItems" :key="a.id" class="sa-audit-row">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="sa-pill sa-pill--action">{{ a.action }}</span>
              <span class="text-sm font-medium">@{{ a.actorUsername }}</span>
              <span v-if="a.tenantName" class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">→ #{{ a.tenantId }} {{ a.tenantName }}</span>
              <span class="text-xs ml-auto" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">{{ fmtTime(a.createdAt) }}</span>
            </div>
            <details v-if="a.detail" class="mt-1">
              <summary class="text-xs cursor-pointer" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">detail</summary>
              <pre class="sa-audit-detail text-xs">{{ JSON.stringify(a.detail, null, 2) }}</pre>
            </details>
          </div>
          <div v-if="auditNextBefore" class="text-center mt-3">
            <button class="m3-btn m3-btn--text !min-h-[36px] !text-sm" @click="loadMoreAudit">Muat lebih ({{ auditItems.length }} ditampilkan)</button>
          </div>
        </div>
      </div>

      <!-- v3.9 — Modal Nomor WA per tenant (slot management + kuota) -->
      <div v-if="numbersModalTenant" class="sa-modal-backdrop" @click.self="closeNumbersModal">
        <div class="sa-modal">
          <h3 class="text-lg font-semibold mb-1">Nomor WA — #{{ numbersModalTenant.id }} {{ numbersModalTenant.name }}</h3>
          <p class="text-sm mb-3" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
            Kuota paket: {{ numbersForm.used }}/{{ numbersForm.maxNumbers }} (hard cap 3). Kuota dihitung dari slot yang ADA (disconnect tetap ngitung).
          </p>
          <div class="space-y-2 mb-4">
            <div v-for="s in numbersForm.slots" :key="s.slot" class="flex items-center gap-2 p-2 rounded-lg" style="background: var(--md-sys-color-surface-container-high);">
              <span class="text-sm font-semibold min-w-[70px]">Slot {{ s.slot }}</span>
              <input v-model="s._labelDraft" type="text" placeholder="Label" maxlength="50" class="sa-select !py-1 flex-1 min-w-0" />
              <span class="sa-pill" :style="s.status?.connected ? 'background:#dcfce7;color:#166534;' : 'background:#e5e7eb;color:#374151;'">
                {{ s.status?.connected ? '+' + (s.status.phoneNumber || '?') : (s.status?.state || 'off') }}
              </span>
              <button class="m3-btn m3-btn--text !min-h-[32px] !text-xs" @click="saveSlotRow(s)">Simpan</button>
              <button
                class="m3-btn m3-btn--text !min-h-[32px] !text-xs"
                style="color: var(--md-sys-color-error);"
                :disabled="s.slot === 0"
                @click="deleteSlotRow(s)"
              >Hapus</button>
            </div>
            <div v-if="numbersForm.slots.length === 0" class="sa-empty">Belum ada slot terdaftar (slot-0 implisit jalan).</div>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <M3TextField v-model="newSlot.slot" label="Slot baru (1 / 2)" type="number" min="1" max="2" />
            <M3TextField v-model="newSlot.label" label="Label (opsional)" type="text" />
          </div>
          <div v-if="numbersError" class="text-sm mt-3" style="color: var(--md-sys-color-error);">{{ numbersError }}</div>
          <div class="flex gap-2 justify-end mt-4">
            <button class="m3-btn m3-btn--text !min-h-[40px]" @click="closeNumbersModal">Tutup</button>
            <button class="m3-btn m3-btn--filled !min-h-[40px]" :disabled="numbersSaving" @click="addSlotRow">
              {{ numbersSaving ? 'Menyimpan…' : 'Tambah Slot' }}
            </button>
          </div>
        </div>
      </div>

      <!-- v3.8 — Modal Masa Aktif (4 preset + Date start + preview selesai) -->
      <div v-if="validityModalTenant" class="sa-modal-backdrop" @click.self="closeValidityModal">
        <div class="sa-modal">
          <h3 class="text-lg font-semibold mb-1">Masa Aktif — #{{ validityModalTenant.id }} {{ validityModalTenant.name }}</h3>
          <p class="text-sm mb-3" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
            Sekarang: {{ validityNowLabel(validityModalTenant) }}. Tenant expired tetap bisa login &amp; lihat data (read-only), tapi tidak bisa mengirim apa pun.
          </p>
          <label class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">Preset</label>
          <select v-model="validityForm.preset" class="m3-select sa-select">
            <option value="lifetime">Lifetime — tanpa batas</option>
            <option value="30d">30 Hari</option>
            <option value="1y">1 Tahun</option>
            <option value="custom">Custom — tentukan tanggal selesai</option>
          </select>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
            <div>
              <label class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">Mulai (default hari ini WIB)</label>
              <input v-model="validityForm.startDate" type="date" class="sa-select sa-date-input" />
            </div>
            <div v-if="validityForm.preset === 'custom'">
              <label class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">Selesai (wajib)</label>
              <input v-model="validityForm.endDate" type="date" class="sa-select sa-date-input" />
            </div>
          </div>
          <div class="mt-3 p-3 rounded-[var(--md-sys-shape-corner-m)]" style="background: var(--md-sys-color-surface-container-high);">
            <div class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">Pratinjau selesai:</div>
            <div class="font-semibold" :style="{ color: 'var(--md-sys-color-on-surface)' }">{{ validityPreviewText }}</div>
          </div>
          <div v-if="validityError" class="text-sm mt-3" style="color: var(--md-sys-color-error);">{{ validityError }}</div>
          <div class="flex gap-2 justify-end mt-4">
            <button class="m3-btn m3-btn--text !min-h-[40px]" @click="closeValidityModal">Batal</button>
            <button class="m3-btn m3-btn--filled !min-h-[40px]" :disabled="validitySaving" @click="saveValidity">
              {{ validitySaving ? 'Menyimpan…' : 'Simpan' }}
            </button>
          </div>
        </div>
      </div>

      <!-- v3.4 — Modal Edit Paket -->
      <div v-if="planModalTenant" class="sa-modal-backdrop" @click.self="closePlanModal">
        <div class="sa-modal">
          <h3 class="text-lg font-semibold mb-3">Edit Paket — #{{ planModalTenant.id }} {{ planModalTenant.name }}</h3>
          <label class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">Terapkan preset</label>
          <select v-model="planForm.preset" class="m3-select sa-select">
            <option value="">— jangan ganti preset (custom override) —</option>
            <option value="lite">Lite</option>
            <option value="pro">Pro</option>
            <option value="max">Max</option>
          </select>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
            <M3TextField v-model="planForm.maxAgents" label="Max agen (kosong = ∞)" type="number" min="0" />
            <M3TextField v-model="planForm.maxContacts" label="Max kontak (kosong = ∞)" type="number" min="0" />
            <M3TextField v-model="planForm.maxNumbers" label="Maks. Nomor WA (kosong = 1, max 3)" type="number" min="0" max="3" />
            <M3TextField v-model="planForm.tkQuotaGb" label="Kuota TK (GB, kosong = ∞)" type="number" step="0.1" min="0" />
          </div>
          <div class="grid grid-cols-2 md:grid-cols-3 gap-3 mt-4">
            <label v-for="f in FEATURE_DEFS" :key="f.key" class="sa-feat-toggle">
              <M3Switch v-model="planForm[f.key]" />
              <span class="text-sm">{{ f.label }}</span>
            </label>
          </div>
          <div v-if="planError" class="text-sm mt-3" style="color: var(--md-sys-color-error);">{{ planError }}</div>
          <div class="flex gap-2 justify-end mt-4">
            <button class="m3-btn m3-btn--text !min-h-[40px]" @click="closePlanModal">Batal</button>
            <button class="m3-btn m3-btn--filled !min-h-[40px]" :disabled="planSaving" @click="savePlan">
              {{ planSaving ? 'Menyimpan…' : 'Simpan Paket' }}
            </button>
          </div>
        </div>
      </div>

      <!-- v3.4 — Modal Branding -->
      <div v-if="brandingModalTenant" class="sa-modal-backdrop" @click.self="closeBrandingModal">
        <div class="sa-modal">
          <h3 class="text-lg font-semibold mb-3">Branding — #{{ brandingModalTenant.id }} {{ brandingModalTenant.name }}</h3>
          <M3TextField v-model="brandingForm.brandName" label="Brand name (2-50 char, kosong = ChatBareng)" type="text" />
          <div class="mt-3">
            <label class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">Logo (PNG/JPEG/WEBP, maks 1 MB)</label>
            <!-- v3.4.2 — panduan dimensi biar pas di slot header (tinggi render ±26px, lebar auto) -->
            <div class="text-xs mt-1 leading-snug" style="opacity: .75;">
              Disarankan: rasio 1:1 (kotak) s/d 4:1 (memanjang), tinggi gambar 64–256px biar tajam.
              Logo dirender ±26px di header; PNG transparan paling rapi. Kotak besar (mis. 512×512) aman — otomatis dikecilkan.
            </div>
            <input
              ref="logoInputRef"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              class="sa-file-input"
              @change="onLogoPicked"
            />
            <div v-if="brandingForm.logoPreview" class="mt-2 flex items-center gap-3">
              <img :src="brandingForm.logoPreviewUrl" alt="preview logo" style="max-height: 48px; max-width: 160px; border-radius: 8px;" />
            </div>
            <!-- v3.9.16b — status logo terpasang + aksi hapus (dulu: sekali pasang tak bisa dihapus) -->
            <div v-if="brandingModalTenant.logoPath && !brandingForm.logoFile && !brandingForm.removeLogo" class="mt-2 flex items-center gap-2">
              <span class="text-xs" style="opacity: .75;">Logo terpasang ✓</span>
              <button
                class="m3-btn m3-btn--text !min-h-[32px] !text-xs"
                style="color: var(--md-sys-color-error);"
                @click="brandingForm.removeLogo = true"
              >Hapus Logo</button>
            </div>
            <div v-else-if="brandingForm.removeLogo" class="mt-2 text-xs" style="color: var(--md-sys-color-error);">
              Logo akan dihapus saat Simpan Branding. <button class="underline" @click="brandingForm.removeLogo = false">Batal</button>
            </div>
          </div>
          <!-- Live preview header -->
          <div class="mt-4 p-3 rounded-[var(--md-sys-shape-corner-m)" style="background: var(--md-sys-color-surface-container-high);">
            <div class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">Pratinjau header:</div>
            <div class="flex items-baseline gap-2 mt-1">
              <span class="font-bold" :style="{ color: 'var(--md-sys-color-on-surface)' }">{{ brandingForm.brandName || 'ChatBareng' }}</span>
              <span v-if="brandingForm.brandName" class="text-xs" style="opacity: .6;">by ChatBareng</span>
            </div>
          </div>
          <div v-if="brandingError" class="text-sm mt-3" style="color: var(--md-sys-color-error);">{{ brandingError }}</div>
          <div class="flex gap-2 justify-end mt-4">
            <button class="m3-btn m3-btn--text !min-h-[40px]" @click="closeBrandingModal">Batal</button>
            <button class="m3-btn m3-btn--filled !min-h-[40px]" :disabled="brandingSaving" @click="saveBranding">
              {{ brandingSaving ? 'Menyimpan…' : 'Simpan Branding' }}
            </button>
          </div>
        </div>
      </div>

      <!-- v3.1.1 — Akun: ganti password mandiri -->
      <div class="sa-panel mt-6">
        <h2 class="text-lg font-semibold mb-1" :style="{ color: 'var(--md-sys-color-on-surface)' }">Akun</h2>
        <p class="text-sm mb-4" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
          Ganti password superadmin kamu sendiri — minimal 6 karakter.
        </p>
        <form @submit.prevent="changePassword" class="grid gap-3 max-w-md">
          <M3TextField v-model="pwCurrent" label="Password saat ini" type="password" autocomplete="current-password" required />
          <M3TextField v-model="pwNew" label="Password baru (min 6)" type="password" autocomplete="new-password" minlength="6" required />
          <M3TextField v-model="pwConfirm" label="Konfirmasi password baru" type="password" autocomplete="new-password" minlength="6" required />
          <div v-if="pwError" class="flex items-start gap-2 text-sm rounded-[var(--md-sys-shape-corner-s)] p-3"
            style="background: var(--md-sys-color-error-container); color: var(--md-sys-color-on-error-container);"
            role="alert">
            <span aria-hidden="true">⚠️</span>
            <span>{{ pwError }}</span>
          </div>
          <div v-if="pwSuccess" class="flex items-start gap-2 text-sm rounded-[var(--md-sys-shape-corner-s)] p-3"
            style="background: var(--md-sys-color-primary-container); color: var(--md-sys-color-on-primary-container);"
            role="status">
            <span aria-hidden="true">✓</span>
            <span>{{ pwSuccess }}</span>
          </div>
          <div class="flex justify-end">
            <button type="submit" class="m3-btn m3-btn--filled !min-h-[40px]" :disabled="pwSaving">
              {{ pwSaving ? 'Menyimpan…' : 'Ganti Password' }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup>
// v3.0 — Halaman superadmin minimal (fase 1). Impersonasi view-as = fase 3.
// v3.4 — plan editor (preset + custom), branding modal, backup download, impersonate
// button, usage meter, audit viewer (spec §8).
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import axios from 'axios'
import { useAuthStore } from '../stores/auth'
import M3TextField from '../components/M3TextField.vue'
import M3Switch from '../components/M3Switch.vue'

const API = import.meta.env.VITE_API_URL || ''
const router = useRouter()
const auth = useAuthStore()

const tenants = ref([])
const stats = ref(null)
const loading = ref(true)
const error = ref('')
const showCreate = ref(false)
const newTenantName = ref('')
// v3.4 — preset awal tenant baru (default Lite sesuai spec §8)
const newTenantPreset = ref('lite')
const creating = ref(false)

// v3.4 — metadata fitur & audit
const FEATURE_DEFS = [
  { key: 'featAnalytics', label: 'Analytics' },
  { key: 'featBlast', label: 'Blast + Pengumuman' },
  { key: 'featMenuGateway', label: 'Menu Gateway' },
  { key: 'featHistoryExport', label: 'Export/Import Riwayat' },
  { key: 'featCsat', label: 'CSAT' },
  { key: 'featGdriveBackup', label: 'Backup GDrive' },
  { key: 'featApiAccess', label: 'Akses API (v1)' }, // v3.9.13 — Public API v1
]
const FEATURE_LABELS = Object.fromEntries(FEATURE_DEFS.map((f) => [f.key, f.label]))
const AUDIT_ACTIONS = [
  'tenant_create', 'tenant_update', 'tenant_delete', 'tenant_purge',
  'validity_update', // v3.8 — masa aktif tenant
  'plan_update', 'branding_update', 'backup_download', 'impersonate', 'admin_create',
  'api_key_create', 'api_key_revoke', // v3.9.13 — Public API v1
]
const backingUp = ref(null)

// ─── v3.9 — Modal Nomor WA per tenant ───
const numbersModalTenant = ref(null)
const numbersForm = ref({ slots: [], maxNumbers: 1, used: 0 })
const numbersSaving = ref(false)
const numbersError = ref('')
const newSlot = ref({ slot: 1, label: '' })

async function openNumbersModal(t) {
  numbersModalTenant.value = t
  numbersError.value = ''
  newSlot.value = { slot: 1, label: '' }
  try {
    const { data } = await axios.get(`${API}/api/sa/tenants/${t.id}/numbers`)
    numbersForm.value = {
      slots: (data.slots || []).map((s) => ({ ...s, _labelDraft: s.label || '' })),
      maxNumbers: data.maxNumbers,
      used: data.used,
    }
  } catch (e) {
    numbersError.value = e.response?.data?.error || 'Gagal memuat slot'
  }
}
function closeNumbersModal() {
  numbersModalTenant.value = null
}
async function refreshNumbersModal() {
  const t = numbersModalTenant.value
  if (!t) return
  try {
    const { data } = await axios.get(`${API}/api/sa/tenants/${t.id}/numbers`)
    const prev = new Map(numbersForm.value.slots.map((s) => [s.slot, s]))
    numbersForm.value.slots = (data.slots || []).map((s) => ({ ...s, _labelDraft: prev.get(s.slot)?._labelDraft ?? (s.label || '') }))
    numbersForm.value.maxNumbers = data.maxNumbers
    numbersForm.value.used = data.used
  } catch {}
}
async function addSlotRow() {
  const t = numbersModalTenant.value
  if (!t) return
  numbersSaving.value = true
  numbersError.value = ''
  try {
    await axios.post(`${API}/api/sa/tenants/${t.id}/numbers`, {
      slot: Number(newSlot.value.slot),
      label: String(newSlot.value.label || '').trim() || undefined,
    })
    await refreshNumbersModal()
    await load()
  } catch (e) {
    numbersError.value = e.response?.data?.error || 'Gagal menambah slot'
  } finally {
    numbersSaving.value = false
  }
}
async function saveSlotRow(s) {
  const t = numbersModalTenant.value
  if (!t) return
  numbersError.value = ''
  try {
    await axios.post(`${API}/api/sa/tenants/${t.id}/numbers`, {
      slot: s.slot,
      label: String(s._labelDraft || '').trim() || '',
    })
    s.label = String(s._labelDraft || '').trim() || null
    await load()
  } catch (e) {
    numbersError.value = e.response?.data?.error || 'Gagal menyimpan slot'
  }
}
async function deleteSlotRow(s) {
  const t = numbersModalTenant.value
  if (!t || s.slot === 0) return
  numbersError.value = ''
  try {
    await axios.delete(`${API}/api/sa/tenants/${t.id}/numbers/${s.slot}`)
    await refreshNumbersModal()
    await load()
  } catch (e) {
    numbersError.value = e.response?.data?.error || 'Gagal menghapus slot'
  }
}

// ─── v3.8 §A — Chip WA real-time: polling GET /api/sa/tenants tiap 15s ───
// Silent in-place update (TANPA loading flicker — loading flag tidak disentuh);
// clearInterval saat unmount + tombol refresh manual tetap memanggil load().
// TANPA socket baru (kemungkinan v2 — dicatat di report).
let waPollTimer = null
async function pollTenantsSilent() {
  try {
    const { data } = await axios.get(`${API}/api/sa/tenants`)
    tenants.value = data.tenants // in-place replace — reaktif, tanpa flicker
  } catch {
    // polling gagal (network/error) → senyap; error state tidak diubah (silent)
  }
}
function startWaPolling() {
  stopWaPolling()
  waPollTimer = setInterval(pollTenantsSilent, 15000)
}
function stopWaPolling() {
  if (waPollTimer) { clearInterval(waPollTimer); waPollTimer = null }
}
onUnmounted(() => stopWaPolling())

// ─── v3.8 — Chip masa aktif dari validityState ──
function validityChip(t) {
  const s = t.validityState
  const fmt = (iso) => {
    try { return new Date(iso).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) } catch { return iso }
  }
  if (s === 'lifetime') return { label: 'Lifetime', style: 'background:#e5e7eb;color:#374151;' }
  if (s === 'active' && t.validUntil) return { label: `s/d ${fmt(t.validUntil)}`, style: 'background:#dcfce7;color:#166534;' }
  if (s === 'expiring' && t.validUntil) {
    const days = Math.max(0, Math.ceil((new Date(t.validUntil) - new Date()) / 86400000))
    return { label: `⏰ ${days} hari lagi`, style: 'background:#fef9c3;color:#854d0e;' }
  }
  if (s === 'expired') return { label: `Kedaluwarsa ${t.validUntil ? fmt(t.validUntil) : ''}`, style: 'background:#fee2e2;color:#991b1b;' }
  if (s === 'not_started') return { label: `Mulai ${t.validFrom ? fmt(t.validFrom) : '?'}`, style: 'background:#dbeafe;color:#1e40af;' }
  return null
}
function validityNowLabel(t) {
  const chip = validityChip(t)
  return chip ? chip.label : 'Lifetime'
}

const adminFormFor = ref(null)
const adminUsername = ref('')
const adminPassword = ref('')
const creatingAdmin = ref(false)

async function load() {
  error.value = ''
  try {
    const [t, s] = await Promise.all([
      axios.get(`${API}/api/sa/tenants`),
      axios.get(`${API}/api/sa/stats`),
    ])
    tenants.value = t.data.tenants
    stats.value = s.data
  } catch (e) {
    error.value = e.response?.data?.error || 'Gagal memuat data'
  } finally {
    loading.value = false
  }
}

async function createTenant() {
  if (!newTenantName.value.trim()) return
  creating.value = true
  error.value = ''
  try {
    await axios.post(`${API}/api/sa/tenants`, {
      name: newTenantName.value.trim(),
      preset: newTenantPreset.value || 'lite',
    })
    newTenantName.value = ''
    newTenantPreset.value = 'lite'
    showCreate.value = false
    await load()
  } catch (e) {
    error.value = e.response?.data?.error || 'Gagal membuat tenant'
  } finally {
    creating.value = false
  }
}

// ── v3.4 — helpers tampilan plan/usage ──
function planLabel(t) {
  const p = t.plan?.preset || 'custom'
  return p.charAt(0).toUpperCase() + p.slice(1)
}
function fmtNum(n) {
  return Number(n || 0).toLocaleString('id-ID')
}
function fmtBytes(n) {
  const GB = 1024 ** 3
  const num = Number(n) || 0
  if (num >= GB) return `${(num / GB).toFixed(1).replace('.', ',')} GB`
  const MB = 1024 ** 2
  if (num >= MB) return `${Math.round(num / MB)} MB`
  return `${num} B`
}
function activeFeatures(t) {
  if (!t.plan) return []
  return FEATURE_DEFS.filter((f) => t.plan[f.key]).map((f) => ({ key: f.key, label: f.label }))
}

// ── v3.8 — Modal Masa Aktif (4 preset + Date start default hari-ini-WIB + preview) ──
const validityModalTenant = ref(null)
const validityForm = ref({ preset: 'lifetime', startDate: '', endDate: '' })
const validitySaving = ref(false)
const validityError = ref('')

/** Hari ini (WIB, UTC+7) sebagai date-input value YYYY-MM-DD. */
function wibTodayValue() {
  const now = new Date(Date.now() + 7 * 60 * 60 * 1000)
  return now.toISOString().slice(0, 10)
}
function parseWibDateToIso(dateStr, endOfDay = false) {
  // date-input YYYY-MM-DD → ISO: WIB midnight (atau 23:59:59.999 utk endDate)
  if (!dateStr) return null
  const ms = endOfDay ? (23 * 60 + 59) * 60 * 1000 + 999 : 0
  return new Date(Date.UTC(
    Number(dateStr.slice(0, 4)), Number(dateStr.slice(5, 7)) - 1, Number(dateStr.slice(8, 10)),
    0, 0, 0, ms
  ) - 7 * 60 * 60 * 1000).toISOString()
}
function openValidityModal(t) {
  validityModalTenant.value = t
  validityForm.value = {
    preset: t.validityState === 'lifetime' ? 'lifetime' : 'custom',
    startDate: t.validFrom ? new Date(new Date(t.validFrom).getTime() + 7 * 3600000).toISOString().slice(0, 10) : wibTodayValue(),
    endDate: t.validUntil ? new Date(new Date(t.validUntil).getTime() + 7 * 3600000).toISOString().slice(0, 10) : '',
  }
  validityError.value = ''
}
function closeValidityModal() {
  validityModalTenant.value = null
}
// Preview tanggal selesai sesuai preset + input saat ini
const validityPreviewText = computed(() => {
  const f = validityForm.value
  const fmt = (iso) => {
    try { return new Date(iso).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) } catch { return iso }
  }
  if (f.preset === 'lifetime') return 'Lifetime — tanpa batas waktu'
  const startIso = parseWibDateToIso(f.startDate, false)
  if (!startIso) return 'Pilih tanggal mulai'
  if (f.preset === '30d') {
    const d = new Date(new Date(startIso).getTime() + 30 * 86400000)
    return `${fmt(startIso)} + 30 hari → ${fmt(d.toISOString())}`
  }
  if (f.preset === '1y') {
    const d = new Date(new Date(startIso).getTime())
    d.setUTCFullYear(d.getUTCFullYear() + 1)
    return `${fmt(startIso)} + 1 tahun → ${fmt(d.toISOString())}`
  }
  // custom
  if (!f.endDate) return 'Pilih tanggal selesai (wajib utk Custom)'
  const endIso = parseWibDateToIso(f.endDate, true)
  if (endIso && new Date(endIso) <= new Date(startIso)) return '⚠️ Tanggal selesai harus SETELAH tanggal mulai'
  return `s/d ${fmt(endIso)} (23:59 WIB)`
})
async function saveValidity() {
  const t = validityModalTenant.value
  if (!t) return
  validitySaving.value = true
  validityError.value = ''
  try {
    const body = { preset: validityForm.value.preset }
    if (validityForm.value.startDate) body.startDate = parseWibDateToIso(validityForm.value.startDate, false)
    if (validityForm.value.preset === 'custom') {
      if (!validityForm.value.endDate) { validityError.value = 'endDate wajib untuk preset Custom'; validitySaving.value = false; return }
      body.endDate = parseWibDateToIso(validityForm.value.endDate, true)
    }
    await axios.put(`${API}/api/sa/tenants/${t.id}/validity`, body)
    closeValidityModal()
    await load()
  } catch (e) {
    validityError.value = e.response?.data?.error || 'Gagal menyimpan masa aktif'
  } finally {
    validitySaving.value = false
  }
}

// ── v3.4 — Modal Edit Paket ──
const planModalTenant = ref(null)
const planForm = ref({})
const planSaving = ref(false)
const planError = ref('')

function openPlanModal(t) {
  planModalTenant.value = t
  planForm.value = {
    preset: '', // tidak mengubah apa-apa sampai user pilih
    maxAgents: t.plan?.maxAgents ?? '',
    maxContacts: t.plan?.maxContacts ?? '',
    // v3.9 — kuota nomor WA (null = 1; tampil "" = null? tampil nilai efektif utk edit eksplisit)
    maxNumbers: t.plan?.maxNumbers ?? '',
    tkQuotaGb: t.plan?.tkQuotaBytes != null ? +(t.plan.tkQuotaBytes / 1024 ** 3).toFixed(2) : '',
    featAnalytics: !!t.plan?.featAnalytics,
    featBlast: !!t.plan?.featBlast,
    featMenuGateway: !!t.plan?.featMenuGateway,
    featHistoryExport: !!t.plan?.featHistoryExport,
    featCsat: !!t.plan?.featCsat,
    featGdriveBackup: !!t.plan?.featGdriveBackup,
    featApiAccess: !!t.plan?.featApiAccess, // v3.9.13
  }
  planError.value = ''
}
function closePlanModal() {
  planModalTenant.value = null
}
async function savePlan() {
  const t = planModalTenant.value
  if (!t) return
  planSaving.value = true
  planError.value = ''
  try {
    const body = {}
    if (planForm.value.preset) body.preset = planForm.value.preset
    // angka kosong = unlimited (null); angka terisi = override
    const numOrNull = (v) => (v === '' || v === null || v === undefined ? null : Number(v))
    body.maxAgents = numOrNull(planForm.value.maxAgents)
    body.maxContacts = numOrNull(planForm.value.maxContacts)
    // v3.9 — maxNumbers: kosong = null (=1 server-side); terisi = 0..3 (hard cap 3)
    if (planForm.value.maxNumbers === '' || planForm.value.maxNumbers === null) body.maxNumbers = null
    else {
      const n = Number(planForm.value.maxNumbers)
      body.maxNumbers = Number.isFinite(n) ? Math.max(0, Math.min(3, Math.trunc(n))) : null
    }
    const gb = planForm.value.tkQuotaGb
    body.tkQuotaBytes = gb === '' || gb === null || gb === undefined ? null : Math.round(Number(gb) * 1024 ** 3)
    for (const f of FEATURE_DEFS) body[f.key] = !!planForm.value[f.key]
    await axios.put(`${API}/api/sa/tenants/${t.id}/plan`, body)
    closePlanModal()
    await load()
  } catch (e) {
    planError.value = e.response?.data?.error || 'Gagal menyimpan paket'
  } finally {
    planSaving.value = false
  }
}

function openAdminForm(t) {
  adminFormFor.value = adminFormFor.value === t.id ? null : t.id
  adminUsername.value = ''
  adminPassword.value = ''
}

async function createAdmin(t) {
  creatingAdmin.value = true
  error.value = ''
  try {
    await axios.post(`${API}/api/sa/tenants/${t.id}/admins`, {
      username: adminUsername.value.trim(),
      password: adminPassword.value,
    })
    adminFormFor.value = null
    await load()
  } catch (e) {
    error.value = e.response?.data?.error || 'Gagal membuat admin'
  } finally {
    creatingAdmin.value = false
  }
}

async function setStatus(t, status) {
  error.value = ''
  try {
    await axios.put(`${API}/api/sa/tenants/${t.id}`, { status })
    await load()
  } catch (e) {
    error.value = e.response?.data?.error || 'Gagal mengubah status tenant'
  }
}

// v3.1.2 — Hapus permanen tenant (purge). Endpoint POST /api/sa/tenants/:id/purge
// menyapu SEMUA row milik tenant dalam satu transaksi + file media dari disk.
// Konfirmasi anti salah-klik: ketik nama tenant persis (dicek di backend juga).
const purgeFormFor = ref(null)
const purgeConfirmName = ref('')
const purging = ref(false)
const purgeError = ref('')
const purgeSuccess = ref('')

function openPurgeForm(t) {
  purgeFormFor.value = purgeFormFor.value === t.id ? null : t.id
  purgeConfirmName.value = ''
  purgeError.value = ''
  purgeSuccess.value = ''
  if (purgeFormFor.value) adminFormFor.value = null // jangan dua form sekaligus
}

function closePurgeForm() {
  purgeFormFor.value = null
  purgeConfirmName.value = ''
  purgeError.value = ''
}

async function purgeTenant(t) {
  purging.value = true
  purgeError.value = ''
  try {
    const { data } = await axios.post(`${API}/api/sa/tenants/${t.id}/purge`, {
      confirmName: purgeConfirmName.value,
    })
    const d = data.deleted || {}
    const parts = [`${d.users || 0} user`, `${d.chats || 0} chat`, `${d.messages || 0} pesan`]
    if (data.filesRemoved) parts.push(`${data.filesRemoved} file media`)
    purgeSuccess.value = `Tenant "${t.name}" dihapus permanen — ${parts.join(', ')}.`
    closePurgeForm()
    await load()
  } catch (e) {
    purgeError.value = e.response?.data?.error || 'Gagal menghapus tenant'
  } finally {
    purging.value = false
  }
}

// v3.1.1 — self-service ganti password. Endpoint /api/auth/change-password (v0.12.2)
// sudah role-agnostic (requireAuth; verifikasi current password; rate limit ketat) —
// superadmin tidak punya akses /settings (router guard khusus), jadi panelnya di sini.
const pwCurrent = ref('')
const pwNew = ref('')
const pwConfirm = ref('')
const pwSaving = ref(false)
const pwError = ref('')
const pwSuccess = ref('')

async function changePassword() {
  pwError.value = ''
  pwSuccess.value = ''
  if (pwNew.value !== pwConfirm.value) {
    pwError.value = 'Password baru tidak sama dengan konfirmasinya'
    return
  }
  if ((pwNew.value || '').length < 6) {
    pwError.value = 'Password baru minimal 6 karakter'
    return
  }
  pwSaving.value = true
  try {
    await axios.post(`${API}/api/auth/change-password`, {
      currentPassword: pwCurrent.value,
      newPassword: pwNew.value,
    })
    pwSuccess.value = 'Password berhasil diganti'
    pwCurrent.value = ''
    pwNew.value = ''
    pwConfirm.value = ''
  } catch (e) {
    pwError.value = e.response?.data?.error || 'Gagal mengganti password'
  } finally {
    pwSaving.value = false
  }
}

// ── v3.4 — Modal Branding ──
const brandingModalTenant = ref(null)
const brandingForm = ref({ brandName: '', logoFile: null, logoPreview: false, logoPreviewUrl: '', removeLogo: false })
const brandingSaving = ref(false)
const brandingError = ref('')
const logoInputRef = ref(null)

function openBrandingModal(t) {
  brandingModalTenant.value = t
  brandingForm.value = { brandName: t.brandName || '', logoFile: null, logoPreview: false, logoPreviewUrl: '', removeLogo: false }
  brandingError.value = ''
}
function closeBrandingModal() {
  brandingModalTenant.value = null
}
function onLogoPicked(ev) {
  const file = ev.target?.files?.[0] || null
  brandingForm.value.logoFile = file
  brandingForm.value.logoPreview = !!file
  if (file) brandingForm.value.removeLogo = false // pilih logo baru = batalkan intent hapus
  if (brandingForm.value.logoPreviewUrl) URL.revokeObjectURL(brandingForm.value.logoPreviewUrl)
  brandingForm.value.logoPreviewUrl = file ? URL.createObjectURL(file) : ''
}
async function saveBranding() {
  const t = brandingModalTenant.value
  if (!t) return
  brandingSaving.value = true
  brandingError.value = ''
  try {
    const fd = new FormData()
    fd.append('brandName', brandingForm.value.brandName.trim())
    if (brandingForm.value.logoFile) fd.append('logo', brandingForm.value.logoFile)
    // v3.9.16b — hapus logo (mutual-exclusive dgn upload baru; backend validasi juga)
    if (!brandingForm.value.logoFile && brandingForm.value.removeLogo) fd.append('removeLogo', 'true')
    await axios.put(`${API}/api/sa/tenants/${t.id}/branding`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    closeBrandingModal()
    await load()
  } catch (e) {
    brandingError.value = e.response?.data?.error || 'Gagal menyimpan branding'
  } finally {
    brandingSaving.value = false
  }
}

// ── v3.4 — Backup download (confirm → GET backup → simpan tar.gz) ──
async function backupTenant(t) {
  if (!window.confirm(`Buat backup tar.gz tenant "${t.name}"? Arsip berisi semua data + file media tenant ini.`)) return
  backingUp.value = t.id
  error.value = ''
  try {
    const res = await axios.get(`${API}/api/sa/tenants/${t.id}/backup`, { responseType: 'blob' })
    // content-disposition → filename
    const cd = res.headers['content-disposition'] || ''
    const m = cd.match(/filename="?([^"]+)"?/)
    const fileName = m ? m[1] : `backup-tenant-${t.id}.tar.gz`
    const url = URL.createObjectURL(res.data)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    await loadAudit()
  } catch (e) {
    error.value = e.response?.data?.error || 'Gagal membuat backup'
  } finally {
    backingUp.value = null
  }
}

// v3.4 — Impersonate (endpoint sudah ada; tombol + buka tab baru dgn short token).
// Token view-as ditulis ke sessionStorage tab baru; boot shim di main.js mempromosikan
// token itu ke localStorage SEBELUM auth store terbentuk (same-origin constraint).
async function impersonateTenant(t) {
  if (!window.confirm(`Impersonate tenant "${t.name}"? Tab baru akan dibuka dengan token view-as 30 menit.`)) return
  error.value = ''
  try {
    const { data } = await axios.post(`${API}/api/sa/impersonate/${t.id}`)
    const win = window.open('/', '_blank')
    if (win) {
      // tab baru belum selesai load → tulis ulang sampai shim terbaca (max ~2s)
      const payload = JSON.stringify({ token: data.token, user: { id: auth.user?.id, username: auth.user?.username, role: 'admin', impersonated: true } })
      const write = () => {
        try {
          win.sessionStorage.setItem('__impersonate_boot', payload)
        } catch {}
      }
      write()
      let tries = 0
      const iv = setInterval(() => {
        write()
        if (++tries >= 10) clearInterval(iv)
      }, 200)
    } else {
      error.value = 'Popup diblokir browser — izinkan popup untuk impersonate'
    }
    await loadAudit()
  } catch (e) {
    error.value = e.response?.data?.error || 'Gagal impersonate'
  }
}

// ── v3.4 — Audit viewer ──
const auditItems = ref([])
const auditNextBefore = ref(null)
const auditFilterAction = ref('')
const auditFilterTenant = ref('')
const auditLoading = ref(false)

async function loadAudit(reset = true) {
  auditLoading.value = true
  try {
    if (reset) auditNextBefore.value = null
    const params = { limit: 50 }
    if (auditFilterAction.value) params.action = auditFilterAction.value
    if (auditFilterTenant.value) params.tenantId = auditFilterTenant.value
    if (!reset && auditNextBefore.value) params.before = auditNextBefore.value
    const { data } = await axios.get(`${API}/api/sa/audit`, { params })
    auditItems.value = reset ? data.items : [...auditItems.value, ...data.items]
    auditNextBefore.value = data.nextBefore
  } catch (e) {
    error.value = e.response?.data?.error || 'Gagal memuat audit'
  } finally {
    auditLoading.value = false
  }
}
function loadMoreAudit() {
  loadAudit(false)
}
function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return iso
  }
}

function handleLogout() {
  auth.logout()
  router.push('/login')
}

onMounted(() => {
  load()
  loadAudit()
  // v3.8 §A — polling WA real-time 15s (silent in-place, clear saat unmount)
  startWaPolling()
})
</script>

<style scoped>
.sa-card {
  background: var(--md-sys-color-surface-container);
  border-radius: var(--md-sys-shape-corner-m);
  padding: 12px 16px;
}
.sa-stat {
  font-size: 1.4rem;
  font-weight: 700;
  color: var(--md-sys-color-on-surface);
}
.sa-label {
  font-size: 0.78rem;
  color: var(--md-sys-color-on-surface-variant);
}
.sa-panel {
  background: var(--md-sys-color-surface-container);
  border-radius: var(--md-sys-shape-corner-l);
  box-shadow: var(--md-sys-elevation-1);
  padding: 24px;
}
.sa-form {
  background: var(--md-sys-color-surface-container-high);
  border-radius: var(--md-sys-shape-corner-m);
  padding: 16px;
  margin-bottom: 16px;
  display: grid;
  gap: 8px;
}
.sa-tenant {
  background: var(--md-sys-color-surface-container-high);
  border-radius: var(--md-sys-shape-corner-m);
  padding: 16px;
}
.sa-pill {
  font-size: 0.72rem;
  font-weight: 600;
  border-radius: 999px;
  padding: 2px 10px;
  white-space: nowrap;
}
.sa-empty {
  text-align: center;
  padding: 32px 0;
  color: var(--md-sys-color-on-surface-variant);
}

/* v3.4 */
.sa-select {
  width: 100%;
  padding: 10px 12px;
  border-radius: var(--md-sys-shape-corner-s);
  border: 1px solid var(--md-sys-color-outline);
  background: var(--md-sys-color-surface);
  color: var(--md-sys-color-on-surface);
}
/* v3.8 — date input di modal Masa Aktif */
.sa-date-input {
  margin-top: 4px;
  min-height: 44px;
}
.sa-usage {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.sa-meter {
  font-size: 0.78rem;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--md-sys-color-surface-container);
  color: var(--md-sys-color-on-surface-variant);
  white-space: nowrap;
}
.sa-pill--plan {
  background: #dbeafe;
  color: #1e40af;
}
.sa-pill--feat {
  background: #dcfce7;
  color: #166534;
  font-size: 0.68rem;
}
.sa-pill--action {
  background: #ede9fe;
  color: #5b21b6;
}
.sa-audit-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sa-audit-row {
  padding: 8px 10px;
  border-radius: var(--md-sys-shape-corner-s);
  background: var(--md-sys-color-surface-container-high);
}
.sa-audit-detail {
  margin: 6px 0 0;
  padding: 8px;
  border-radius: var(--md-sys-shape-corner-s);
  background: var(--md-sys-color-surface-container);
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.sa-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
  padding: 16px;
}
.sa-modal {
  background: var(--md-sys-color-surface-container);
  border-radius: var(--md-sys-shape-corner-l);
  box-shadow: var(--md-sys-elevation-3);
  padding: 24px;
  width: 100%;
  max-width: 640px;
  max-height: 90vh;
  overflow-y: auto;
}
.sa-feat-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sa-file-input {
  margin-top: 6px;
  font-size: 0.85rem;
}
</style>
