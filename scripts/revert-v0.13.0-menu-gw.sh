#!/usr/bin/env bash
# revert-v0.13.0-menu-gw.sh — rollback fitur Menu Gateway v0.13.0 ke state pre-v0.13.0.
# Dibuat 2026-09-11 (Kanaka request: "jangan sampai lupa bikin rollback ke state yang sekarang").
# Idempoten — aman dijalankan berulang.
#
# Usage:
#   ./scripts/revert-v0.13.0-menu-gw.sh             # code-only rollback (DEFAULT, aman)
#   ./scripts/revert-v0.13.0-menu-gw.sh --full-db   # + restore snapshot DB 19:20 WIB
#
# Mode default (code-only): DB TIDAK disentuh — tabel baru (MenuGateway*, ContactTag)
# tetap ada tapi tak dipakai (dead schema, harmless). Recovery tercepat, zero data loss.
# Mode --full-db: restore snapshot DB pra-fitur. ⚠️ PESAN PELANGGAN YANG MASUK SETELAH
# 19:20 WIB 2026-09-11 AKAN HILANG dari DB (snapshot = kondisi 19:20). Gunakan hanya
# jika code-only rollback tidak cukup / DB rusak.
set -euo pipefail

APP_DIR="/home/kanakxxx/.openclaw/workspace/wa-cs-hub"
WS="/home/kanakxxx/.openclaw/workspace"
TAG="pre-v0.13.0-menu-gw"
SNAP="$APP_DIR/backup/pre-v0.13.0-menu-gw-20260911-1920.db"
DB="$APP_DIR/prisma/data/wa-cs-hub.db"
LOG=/tmp/wa-cs-hub.log
MODE="${1:-}"

cd "$WS"

echo "[1/7] Stop server 5030 (kill PID eksplisit — lesson EADDRINUSE 2026-09-11)"
PID=$(ss -tlnp 2>/dev/null | grep ':5030' | grep -oP 'pid=\K[0-9]+' | head -1 || true)
if [ -n "$PID" ]; then kill "$PID"; sleep 3; echo "  stopped pid $PID"; else echo "  (server tidak jalan)"; fi

if [ "$MODE" = "--full-db" ]; then
  echo "[2/7] FULL-DB: restore snapshot $SNAP"
  cp -f "$SNAP" "$DB"
  echo "  ⚠️  DB = kondisi 19:20 WIB 2026-09-11"
else
  echo "[2/7] Code-only: DB tidak disentuh (tabel baru jadi dead schema, aman)"
fi

echo "[3/7] Revert kode wa-cs-hub → tag $TAG"
git checkout "$TAG" -- wa-cs-hub/

echo "[3b] Bersihkan file BARU buatan v0.13.0 (dead code) — spec & backup dipertahankan"
git diff --name-only --diff-filter=A "$TAG" -- wa-cs-hub/src wa-cs-hub/frontend/src 2>/dev/null | while read -r f; do
  [ -f "$f" ] && rm -f "$f" && echo "  removed: $f"
done || true

echo "[4/7] prisma generate (client match schema lama)"
cd "$APP_DIR" && npx prisma generate >/dev/null 2>&1

echo "[5/7] Build frontend"
cd frontend && npm run build >/dev/null 2>&1

echo "[6/7] Restart server"
cd "$APP_DIR"
setsid nohup npm start > "$LOG" 2>&1 < /dev/null & disown
sleep 8

echo "[7/7] Health check"
CODE=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:5030/api/health 2>/dev/null || echo 000)
echo "  health: $CODE"
[ "$CODE" = "200" ] || { echo "  ❌ BUKAN 200 — cek $LOG"; exit 1; }
grep -q "Connected to WhatsApp" "$LOG" && echo "  WA: Connected ✅" || echo "  WA: belum connect (cek $LOG)"
echo "ROLLBACK SELESAI (mode: ${MODE:-code-only})"