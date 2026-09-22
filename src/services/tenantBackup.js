// v3.4 — Backup SATU tenant (on-demand, superadmin) → tar.gz (spec §7).
// Isi arsip:
//   manifest.json   — metadata + row count per tabel + keyFingerprint
//   db/<table>.json — dump SEMUA row tenant per tabel (raw, termasuk payload
//                     terenkripsi enc:v1 — JANGAN decrypt) + tenant.json (Tenant+TenantPlan)
//   files/          — copy file media byte-for-byte (encrypted on disk):
//                     message.mediaPath, sharedFile.storagePath, blast.mediaPath,
//                     tenant.logoPath (skip null/tidak ada di disk)
// Arsip dibuat di /tmp, dikirim via res.download, unlink setelah kirim (finally).
// Row besar: findMany batch 1000 → tulis stream (jangan JSON.stringify sekali jalan).
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const prisma = require('../prisma')

// Daftar tabel = SAMA dengan urutan purge di superadmin.js (spec §7):
// tenant-scoped + user-scoped via user.tenantId.
const BACKUP_TABLES = [
  ['messages', (tid) => prisma.message.findMany({ where: { tenantId: tid } })],
  ['blasts', (tid) => prisma.blast.findMany({ where: { tenantId: tid } })],
  ['csatSurveys', (tid) => prisma.csatSurvey.findMany({ where: { tenantId: tid } })],
  ['scheduledMessages', (tid) => prisma.scheduledMessage.findMany({ where: { tenantId: tid } })],
  ['groupActionLogs', (tid) => prisma.groupActionLog.findMany({ where: { tenantId: tid } })],
  ['chatNotes', (tid) => prisma.chatNote.findMany({ where: { tenantId: tid } })],
  ['chatEvents', (tid) => prisma.chatEvent.findMany({ where: { tenantId: tid } })],
  ['chatTags', (tid) => prisma.chatTag.findMany({ where: { chat: { tenantId: tid } } })],
  ['contactTags', (tid) => prisma.contactTag.findMany({ where: { tenantId: tid } })],
  ['contacts', (tid) => prisma.contact.findMany({ where: { tenantId: tid } })],
  ['chats', (tid) => prisma.chat.findMany({ where: { tenantId: tid } })],
  ['tags', (tid) => prisma.tag.findMany({ where: { tenantId: tid } })],
  ['sharedFiles', (tid) => prisma.sharedFile.findMany({ where: { tenantId: tid } })],
  ['sharedFolders', (tid) => prisma.sharedFolder.findMany({ where: { tenantId: tid } })],
  ['announcements', (tid) => prisma.announcement.findMany({ where: { tenantId: tid } })],
  ['purgeLogs', (tid) => prisma.purgeLog.findMany({ where: { tenantId: tid } })],
  ['messageTemplates', (tid) => prisma.messageTemplate.findMany({ where: { tenantId: tid } })],
  ['pushSubscriptions', (tid) => prisma.pushSubscription.findMany({ where: { user: { tenantId: tid } } })],
  ['gdriveLinks', (tid) => prisma.gDriveLink.findMany({ where: { user: { tenantId: tid } } })],
  ['backupLogs', (tid) => prisma.backupLog.findMany({ where: { user: { tenantId: tid } } })],
  ['favoriteMessages', (tid) => prisma.favoriteMessage.findMany({ where: { user: { tenantId: tid } } })],
  ['users', (tid) => prisma.user.findMany({ where: { tenantId: tid } })],
  ['appConfigs', (tid) => prisma.appConfig.findMany({ where: { tenantId: tid } })],
  ['autoReplyConfigs', (tid) => prisma.autoReplyConfig.findMany({ where: { tenantId: tid } })],
  ['backupConfigs', (tid) => prisma.backupConfig.findMany({ where: { tenantId: tid } })],
  ['appearanceConfigs', (tid) => prisma.appearanceConfig.findMany({ where: { tenantId: tid } })],
  ['csatConfigs', (tid) => prisma.csatConfig.findMany({ where: { tenantId: tid } })],
  ['menuGatewayOptions', (tid) => prisma.menuGatewayOption.findMany({ where: { tenantId: tid } })],
  ['menuGatewayConfigs', (tid) => prisma.menuGatewayConfig.findMany({ where: { tenantId: tid } })],
]

const BATCH = 1000 // disediakan bila tabel super-gede; dump v1 pakai findMany per tabel (row tenant < 10k)
void BATCH

/** Kumpulkan path file media dari row yang relevan (spec §7). */
function collectFilePaths(tenant, tables) {
  const paths = new Set()
  const add = (p) => {
    if (p && typeof p === 'string') paths.add(p)
  }
  for (const m of tables.messages || []) add(m.mediaPath)
  for (const f of tables.sharedFiles || []) add(f.storagePath)
  for (const b of tables.blasts || []) add(b.mediaPath)
  if (tenant.logoPath) add(tenant.logoPath)
  return [...paths].filter((p) => fs.existsSync(p))
}

function slugify(name) {
  return String(name || 'tenant')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'tenant'
}

function tsStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

function keyFingerprint() {
  const key = process.env.MSG_ENCRYPTION_KEY || ''
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 8)
}

/**
 * createTenantBackup(tenantId) → { filePath, fileName, manifest }
 * Caller WAJIB meng-unlink filePath setelah selesai (res.download + finally).
 */
async function createTenantBackup(tenantId) {
  const tid = Number(tenantId)
  if (!Number.isFinite(tid) || tid <= 0) throw new Error('Invalid tenantId')
  const tenant = await prisma.tenant.findUnique({
    where: { id: tid },
    include: { plan: true },
  })
  if (!tenant) throw new Error('Tenant not found')

  // 1) Dump semua tabel (findMany penuh per tabel — v1; row tenant biasanya < 10k)
  const tables = {}
  for (const [name, findFn] of BACKUP_TABLES) {
    tables[name] = await findFn(tid)
  }

  // 2) Kumpulkan + copy file media ke staging files/
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-backup-'))
  const dbDir = path.join(tmpDir, 'db')
  const filesDir = path.join(tmpDir, 'files')
  fs.mkdirSync(dbDir, { recursive: true })
  fs.mkdirSync(filesDir, { recursive: true })

  try {
    const tableCounts = {}
    for (const [name] of BACKUP_TABLES) {
      const rows = tables[name] || []
      tableCounts[name] = rows.length
      const out = fs.createWriteStream(path.join(dbDir, `${name}.json`))
      await new Promise((resolve, reject) => {
        out.on('error', reject)
        out.on('finish', resolve)
        out.write('[')
        let first = true
        for (const row of rows) {
          if (!first) out.write(',')
          first = false
          out.write(JSON.stringify(row))
        }
        out.write(']')
        out.end()
      })
    }

    // tenant.json = row Tenant + TenantPlan (spec §7) — BigInt dinormalisasi string
    const { logoPath, plan, ...tenantRow } = tenant
    void logoPath
    const tenantPlanRow = plan
      ? { ...plan, tkQuotaBytes: plan.tkQuotaBytes == null ? null : String(plan.tkQuotaBytes) }
      : null
    fs.writeFileSync(
      path.join(dbDir, 'tenant.json'),
      JSON.stringify({ tenant: tenantRow, tenantPlan: tenantPlanRow }, null, 2)
    )

    // files/ — nama arsip = sha1(path absolut).<ext> (relatif, hindari path absolut di tar)
    const copiedFiles = []
    for (const abs of collectFilePaths(tenant, tables)) {
      try {
        const hash = crypto.createHash('sha1').update(abs).digest('hex')
        const ext = path.extname(abs) || '.bin'
        const arcName = `${hash}${ext}`
        fs.copyFileSync(abs, path.join(filesDir, arcName))
        copiedFiles.push({ source: abs, arc: `files/${arcName}`, size: fs.statSync(abs).size })
      } catch (e) {
        copiedFiles.push({ source: abs, arc: null, error: e.message })
      }
    }

    // 3) manifest.json
    const manifest = {
      app: 'wa-cs-hub-saas-v3',
      version: 'v3.4',
      tenantId: tid,
      tenantName: tenant.name,
      createdAt: new Date().toISOString(),
      note: 'Payloads terenkripsi (enc:v1) dengan key platform MSG/MEDIA — restore butuh .env key yang sama.',
      tables: tableCounts,
      filesCopied: copiedFiles.filter((f) => f.arc).length,
      filesError: copiedFiles.filter((f) => !f.arc).length,
      keyFingerprint: keyFingerprint(),
    }
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

    // 4) tar.gz (system tar — child_process; -C staging agar isi arsip relatif)
    const fileName = `saas-backup-tenant${tid}-${slugify(tenant.name)}-${tsStamp()}.tar.gz`
    const outPath = path.join(os.tmpdir(), fileName)
    // deterministic tar: --sort=name, owner/mode normalize (DR-friendly)
    execFileSync('tar', [
      '-czf', outPath,
      '--sort=name',
      '--owner=0', '--group=0', '--numeric-owner',
      '-C', tmpDir,
      'manifest.json', 'db', 'files',
    ], { stdio: 'pipe' })

    return { filePath: outPath, fileName, manifest, stagingDir: tmpDir }
  } catch (e) {
    // gagal → bersihkan staging
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
    throw e
  }
}

/** Hapus staging dir + arsip tmp (dipanggil caller di finally). */
function cleanupBackup({ filePath, stagingDir }) {
  try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath) } catch {}
  try { if (stagingDir && fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true }) } catch {}
}

module.exports = { createTenantBackup, cleanupBackup, BACKUP_TABLES }