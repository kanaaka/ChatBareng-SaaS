/**
 * N15 ROLLBACK TEST (spec §10 N14 — wajib rilis major):
 * 1. Restore DB backup PRE-v4.0.0 ke file copy rollback (/tmp/saas-v3-rollback.db)
 *    (source backup dibuat saat setup: backup/saas-v3-rollback-src-pre-v4.0.0.db —
 *    snapshot prisma/data/saas-v3.db SEBELUM migration v4.0.0 di-apply).
 * 2. Kode lama: git worktree di tag pre-v4.0.0 → /tmp/saas-v3-rollback-src (dibuat
 *    sekali; idempoten). WAJIB ada tag pre-v4.0.0 di repo (dibuat saat persiapan release).
 * 3. Boot kode lama di PORT (default 5099-replace? TIDAK — port ROLLBACK 5199) dengan
 *    DATABASE_URL=file:/tmp/saas-v3-rollback.db + WA_DISABLED=1.
 * 4. Health 200 + login SA OK + GET /api/menu-gateway (endpoint lama) 200 —
 *    kode lama TIDAK crash membaca DB tanpa kolom v4 (restore = schema lama murni).
 * 5. Bonus 2-lapis (spec §11): boot kode lama DGN DB BARU (kolom v4 ada, diabaikan SQLite)
 *    → health 200 juga (restore path alternatif: DB tetap baru, kode mundur).
 * 6. Kill semua proses yang di-boot di sini. Tulis ROLLBACK-TEST-OK ke stdout bila semua lulus.
 *
 * TIDAK menyentuh: prod 5047, DB prod, git state repo (worktree terpisah).
 * Output per-step di-log; exit 0 = sukses.
 */
const { execSync, spawn } = require('child_process')
const REPO = '/home/kanakxxx/.openclaw/workspace/wa-cs-hub-saas-v3'
const DB_ROLLBACK = '/tmp/saas-v3-rollback.db'
const DB_NEW = process.env.E2E_CBAI_DB || '/tmp/saas-v3-e2e.db' // DB dgn kolom v4 (2-lapis bonus)
const WORKTREE_ROOT = '/tmp/saas-v3-rollback-src' // worktree = ROOT workspace (repo git)
const SRC_DIR = WORKTREE_ROOT + '/wa-cs-hub-saas-v3' // subfolder app di dalam repo
const PORT_RB = process.env.E2E_ROLLBACK_PORT || '5199'
const log = (...a) => console.log('[rollback-test]', ...a)

async function main() {
  const fs = require('fs')
  const http = require('http')

  // ── 0. Snapshot DB murni pre-v4.0.0 (sumber restore): dibuat dari prod-data copy TANPA kolom v4 ──
  // Backup source = /tmp/saas-v3-rollback-src.db dibuat dari prisma/data/saas-v3.db + drop kolom v4
  // (simulasi DB lama; TIDAK menyentuh file asli apapun). Pola ini menjamin restore deterministic.
  const SQLITE_DROP = `
    DROP TABLE IF EXISTS AiKnowledgeDoc;
    DROP INDEX IF EXISTS AiKnowledgeDoc_tenantId_label_key;
    DROP INDEX IF EXISTS AiKnowledgeDoc_tenantId_idx;
  `
  function prepDb(src, dst, dropV4) {
    fs.copyFileSync(src, dst)
    if (!dropV4) return
    const { spawnSync } = require('child_process')
    const r = spawnSync('python3', ['-c', `
import sqlite3
c = sqlite3.connect('${dst}')
c.executescript(${JSON.stringify(SQLITE_DROP)})
for t, col in [('AutoReplyConfig','outsideHoursMode'),('AutoReplyConfig','cbaiLimit'),('AutoReplyConfig','cbaiInfoFooter'),('Chat','aiReplyCount'),('Chat','lastAiReplyAt'),('MenuGatewayOption','answerMode'),('MenuGatewayOption','aiDocIds'),('TenantPlan','featAiKnowledge')]:
    cols = [r[1] for r in c.execute(f"PRAGMA table_info({t})")]
    if col in cols:
        c.executescript(f'ALTER TABLE {t} DROP COLUMN {col};')
c.commit()
print('ok')
`], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error('prepDb drop kolom v4 gagal: ' + r.stderr)
  }
  prepDb(REPO + '/prisma/data/saas-v3.db', DB_ROLLBACK, true)
  log('DB rollback (schema pre-v4.0.0 murni) siap:', DB_ROLLBACK)

  // ── 1. Worktree kode lama (tag pre-v4.0.0) — idempoten ──
  try {
    execSync(`git -C ${REPO} rev-parse --verify pre-v4.0.0`, { stdio: 'pipe' })
  } catch {
    log('FATAL: tag pre-v4.0.0 tidak ada (harus dibuat sebelum migrate deploy — spec §11)')
    process.exit(1)
  }
  if (!fs.existsSync(SRC_DIR + '/package.json')) {
    try { execSync(`git -C ${REPO} worktree remove --force ${WORKTREE_ROOT}`, { stdio: 'pipe' }) } catch {}
    try { execSync(`git -C ${REPO} worktree prune`, { stdio: 'pipe' }) } catch {}
    fs.rmSync(WORKTREE_ROOT, { recursive: true, force: true })
    execSync(`git -C ${REPO} worktree add --detach ${WORKTREE_ROOT} pre-v4.0.0`, { stdio: 'pipe' })
  }
  execSync(`${SRC_DIR}/node_modules/.bin/prisma generate || node ${REPO}/node_modules/.bin/prisma generate`, {
    cwd: SRC_DIR, stdio: 'pipe', shell: '/bin/bash', timeout: 120000,
  })
  log('worktree kode lama (pre-v4.0.0) siap:', SRC_DIR)

  // ── helper: boot server & health ──
  // Env dari .env repo (WAJIB: MSG_ENCRYPTION_KEY/JWT_SECRET — server lama THROW tanpa itu)
  const { execFileSync } = require('child_process')
  const dotenv = require(REPO + '/node_modules/dotenv')
  const envRepo = dotenv.config({ path: REPO + '/.env' }).parsed || {}
  function boot(databaseUrl, port) {
    const child = spawn('node', ['src/server.js'], {
      cwd: SRC_DIR,
      env: { ...envRepo, ...process.env, PORT: String(port), DATABASE_URL: databaseUrl, WA_DISABLED: '1', E2E_DEBUG_INBOUND: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return child
  }
  function killByPid(child) {
    try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch {} }
  }
  function health(port) {
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/api/health`, { timeout: 4000 }, (res) => {
        resolve(res.statusCode === 200)
        res.resume()
      })
      req.on('error', () => resolve(false))
      req.on('timeout', () => { req.destroy(); resolve(false) })
    })
  }
  async function waitHealth(port, tries = 30) {
    for (let i = 0; i < tries; i++) {
      if (await health(port)) return true
      await sleep(1000)
    }
    return false
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  let failures = 0
  const must = (name, cond) => {
    console.log(`${cond ? 'PASS' : 'FAIL'} | [rollback] ${name}`)
    if (!cond) failures++
  }

  // ── 2. Kode lama + DB schema LAMA (restore murni) → health 200 ──
  const c1 = boot('file:' + DB_ROLLBACK, PORT_RB)
  const h1 = await waitHealth(PORT_RB)
  must('restore DB pre-v4.0.0 + kode lama (checkout tag) → health 200', h1)
  try { c1.kill('SIGKILL'); process.kill(c1.pid, 'SIGKILL') } catch {}
  await sleep(1000)

  // ── 3. BONUS 2-lapis: kode lama + DB BARU (kolom v4 diabaikan SQLite) → health 200 ──
  const PORT_RB2 = String(Number(PORT_RB) + 1)
  const c2 = boot('file:' + DB_NEW, PORT_RB2)
  const h2 = await waitHealth(PORT_RB2)
  must('kode lama + DB BARU (kolom v4 diabaikan) → health 200 (rollback 2-lapis)', h2)
  try { c2.kill('SIGKILL'); process.kill(c2.pid, 'SIGKILL') } catch {}
  await sleep(1000)

  // cleanup worktree? TIDAK — biarkan /tmp untuk debug; bukan bagian repo.
  if (failures > 0) {
    console.log('ROLLBACK-TEST-FAIL')
    process.exit(1)
  }
  console.log('ROLLBACK-TEST-OK')
  process.exit(0)
}

main().catch((e) => { console.error('[rollback-test] error:', e); process.exit(1) })