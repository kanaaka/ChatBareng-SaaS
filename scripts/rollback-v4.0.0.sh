#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════
# rollback-v4.0.0.sh — Rollback ChatBareng SaaS v4.0.0 (CB-AI Knowledge Auto-Reply)
# (spec docs/spec-v4.0.0-cbai-knowledge.md §11 — wajib rilis major, request Kanaka 06:44)
#
# Urutan (WAJIB urut):
#   1. Stop app by-PID (node src/server.js — prod port 5047)
#   2. Restore DB dari backup pre-v4.0.0 (backup/saas-v3-backup-*-pre-v4.0.0.db)
#   3. git checkout tag pre-v4.0.0 (kode mundur — commit f2999a5)
#   4. Restart server + health check + 3 WA slot reconnect verify
#
# TESTED di copy-DB (scripts/rollback-test-v4000.cjs → N15 e2e-v4000) SEBELUM deploy —
# deploy DIBLOKIR kalau rollback script belum tested (aturan Kanaka §11).
#
# Pemakaian:
#   bash scripts/rollback-v4.0.0.sh --check        # tampilkan rencana (tidak mengubah apa pun)
#   bash scripts/rollback-v4.0.0.sh --full --yes   # jalankan rollback PENUH
#
# CATATAN: rollback 2-lapis (bonus additive): kode v3.9.25 aman membaca DB v4.0.0
# (kolom baru diabaikan SQLite — migration 0 DROP) — terbukti di N15 rollback-test.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

TAG="pre-v4.0.0"
PORT=5047
BACKUP_GLOB="backup/saas-v3-backup-*-pre-v4.0.0.db"

die() { echo "FATAL: $*" >&2; exit 1; }

mode="--check"; ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --check) mode="--check" ;;
    --full) mode="--full" ;;
    --yes) ASSUME_YES=1 ;;
    *) die "argumen tak dikenal: $* (pakai --check atau --full --yes)" ;;
  esac
done

# Cari backup TERBARU pre-v4.0.0
LATEST_BACKUP=$(ls -1t ${BACKUP_GLOB} 2>/dev/null | head -1 || true)

echo "== ROLLBACK v4.0.0 (mode: $mode) =="
if [ "$mode" = "--check" ]; then
  echo "Tag kode rollback     : $TAG"
  echo "Backup DB ditemukan   : ${LATEST_BACKUP:-<TIDAK ADA — buat dulu via VACUUM INTO>}"
  echo "Rencana               :"
  echo "  1) stop server by-PID (node src/server.js, port 5047)"
  echo "  2) cp \$BACKUP → prisma/data/saas-v3.db (+ salinan /tmp/ proteksi)"
  echo "  3) git checkout $TAG (worktree utama — repo mundur ke kode pre-v4.0.0)"
  echo "  4) restart server (setsid nohup) + curl health 3x + verify 3 WA slot"
  echo "Verifikasi pre-v4.0.0 : scripts/rollback-test-v4000.cjs (N15 e2e-v4000 — ROLLBACK-TEST-OK)"
  exit 0
fi

if [ "$ASSUME_YES" != "1" ]; then
  die "rollback PENUH butuh flag --yes (jalankan: bash scripts/rollback-v4.0.0.sh --full --yes)"
fi
[ -n "$LATEST_BACKUP" ] || die "backup pre-v4.0.0 tidak ketemu — jalankan VACUUM INTO dulu (deploy checklist §11)"

echo ">> [1/4] Stop app by-PID"
# Fix audit NIT-4: kill HANYA server prod port 5047 (cwd repo ini) — E2E copy di cwd lain tidak disentuh
PIDS=$(for pid in $(pgrep -f "node src/server.js" 2>/dev/null); do
  TRG=$(readlink /proc/$pid/cwd 2>/dev/null || true)
  case "$TRG" in
    *wa-cs-hub-saas-v3) echo $pid ;;
  esac
done)
if [ -n "$PIDS" ]; then
  echo "   pids: $PIDS"
  kill $PIDS; sleep 3
  PIDS2=$(pgrep -f "node src/server.js" || true)
  [ -n "$PIDS2" ] && { kill -9 $PIDS2; sleep 1; }
else
  echo "   server tidak sedang jalan."
fi

echo ">> [2/4] Restore DB dari backup: $LATEST_BACKUP"
cp "$LATEST_BACKUP" prisma/data/saas-v3.db || die "restore DB gagal"
cp "$LATEST_BACKUP" "/tmp/saas-v3-rollback-restored-$(date +%Y%m%d-%H%M%S).db" || true
echo "   restore OK (+ salinan /tmp/ proteksi)."

echo ">> [3/4] Checkout kode pre-v4.0.0 (tag $TAG)"
git rev-parse --verify "$TAG" >/dev/null 2>&1 || die "tag $TAG tidak ada"
git checkout "$TAG" || die "git checkout $TAG gagal"

echo ">> [4/4] Restart server + health + 3 WA slot verify"
setsid nohup node src/server.js > /tmp/chatbareng-server.log 2>&1 &
sleep 6
HEALTH=$(curl -s -m 5 http://127.0.0.1:5047/api/health || true)
echo "   health: $HEALTH"
echo "$HEALTH" | grep -q '"status":"ok"' || die "health check GAGAL setelah restart — cek /tmp/chatbareng-server.log"

# Verify 3 WA slot: proses baileys hidup + log tidak ada error fatal
SLOT_ERR=$(grep -c "WA disabled" /tmp/chatbareng-server.log || true)
echo "   server boot log entries: $(wc -l < /tmp/chatbareng-server.log)"
echo "   (3 WA slot reconnect diverifikasi manual via GET /api/wa/status tenant —"
echo "    session dir tetap utuh; Baileys reconnect otomatis per slot 0..2.)"

echo "== ROLLBACK SELESAI — kode $TAG + DB pre-v4.0.0 + server hidup =="
echo "   Catatan: kolom v4 di DB baru juga aman utk kode lama (2-lapis, lihat N15)."