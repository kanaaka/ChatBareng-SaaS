#!/usr/bin/env bash
# ============================================================================
# rollback-v0136.sh — Rollback frontend v0.13.6 (Admin Sidebar + Settings Search)
# ============================================================================
# SYARAT Kanaka (spec v0.13.6 §5): kembalikan UI ke kondisi pre-v0.13.6
# (git tag pre-v0.13.6-admin-sidebar) TANPA restart server — frontend static.
#
# Yang dilakukan:
#   1. git checkout pre-v0.13.6-admin-sidebar -- wa-cs-hub/frontend/src
#   2. npm run build:frontend (output → wa-cs-hub/public, dilayani server jalan)
#   3. curl health check http://localhost:5030/api/health
#   4. Log semua langkah ke wa-cs-hub/logs/rollback-v0136.log
#
# Idempoten: aman dijalankan berulang. TIDAK menyentuh src/ server, DB, Prisma,
# backup service, Homerow.vue, atau proses server (frontend static — build saja).
#
# CATATAN: state git working tree frontend/src di-overwrite ke versi tag.
# Kalau mau balik lagi ke v0.13.6 setelah rollback, jalankan:
#   git checkout HEAD -- wa-cs-hub/frontend/src && npm run build:frontend
# ============================================================================
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR="$REPO_ROOT/wa-cs-hub"
LOG_DIR="$APP_DIR/logs"
LOG_FILE="$LOG_DIR/rollback-v0136.log"
TAG="pre-v0.13.6-admin-sidebar"

mkdir -p "$LOG_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

log "=== ROLLBACK v0.13.6 START (frontend-only, tanpa restart server) ==="

# Guard: repo git + tag tersedia
if ! git -C "$REPO_ROOT" rev-parse --verify "$TAG" >/dev/null 2>&1; then
  log "ERROR: tag $TAG tidak ditemukan di repo $REPO_ROOT — rollback dibatalkan"
  exit 1
fi

# [1/3] Checkout file frontend/src dari tag rollback
log "[1/3] git checkout $TAG -- wa-cs-hub/frontend/src"
if git -C "$REPO_ROOT" checkout "$TAG" -- wa-cs-hub/frontend/src; then
  log "[1/3] OK — frontend/src dikembalikan ke kondisi tag"
else
  log "ERROR: git checkout gagal — rollback dibatalkan (tidak ada perubahan build)"
  exit 1
fi

# [2/3] Rebuild frontend (output static → wa-cs-hub/public; server tidak disentuh)
log "[2/3] npm run build:frontend (cwd=$APP_DIR)"
if (cd "$APP_DIR" && npm run build:frontend) >>"$LOG_FILE" 2>&1; then
  log "[2/3] OK — build frontend selesai"
else
  log "ERROR: build frontend gagal — cek log di atas"
  exit 1
fi

# [3/3] Health check server (harus tetap hidup — tidak ada restart)
log "[3/3] curl http://localhost:5030/api/health"
HTTP_CODE=$(curl -s -m 10 -o /dev/null -w '%{http_code}' http://localhost:5030/api/health || echo "000")
log "[3/3] HTTP status: $HTTP_CODE"
if [ "$HTTP_CODE" = "200" ]; then
  log "=== ROLLBACK v0.13.6 SELESAI — UI kembali ke pre-v0.13.6, server tetap jalan ==="
  exit 0
else
  log "ERROR: health check gagal (HTTP $HTTP_CODE) — frontend sudah di-rebuild versi lama; server mungkin down (cek manual)"
  exit 1
fi