#!/usr/bin/env bash
# rollback-v0140.sh — Rollback ChatBareng v0.14.0 (fitur Grup) ke kondisi pre-fitur.
# Snapshot sumber: backup/pre-v0.14.0-grup-20260917-180307/ (+ manifest backup/pre-v0.14.0-grup.md5)
#
# Pemakaian:
#   bash scripts/rollback-v0140.sh --check          # tampilkan rencana (tidak mengubah apa pun)
#   bash scripts/rollback-v0140.sh --schema-only    # drop tabel GroupActionLog + kolom Chat.picUserId (jika ada)
#   bash scripts/rollback-v0140.sh --full --yes     # restore PENUH (file + DB) + restart server produksi
#
# CATATAN: --full me-restart server produksi (port 5030). Jalankan saat ChatBareng tidak dipakai CS.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

BK="backup/pre-v0.14.0-grup-20260917-180307"
DB="prisma/data/wa-cs-hub.db"
DB_SNAP="$BK/db/wa-cs-hub.db"
PORT=5030

die() { echo "FATAL: $*" >&2; exit 1; }
[ -f "$DB_SNAP" ] || die "snapshot DB tidak ketemu: $DB_SNAP"
[ -d "$BK/src" ] || die "snapshot src tidak ketemu"

mode="--check"; ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --check) mode="--check" ;;
    --schema-only) mode="--schema-only" ;;
    --full) mode="--full" ;;
    --yes) ASSUME_YES=1 ;;
    *) die "argumen tak dikenal: $arg" ;;
  esac
done

echo "== ROLLBACK v0.14.0 (mode: $mode) =="

if [ "$mode" = "--check" ]; then
  echo "Rencana schema-only : drop tabel GroupActionLog; drop kolom Chat.picUserId bila ada."
  echo "Rencana full        : restore $BK/{src,prisma,frontend-src,package.json,package-lock.json} +"
  echo "                      restore DB dari snapshot + restart server produksi (kill+setsid)."
  echo "Verifikasi md5      : $(wc -l < backup/pre-v0.14.0-grup.md5) entri manifest."
  exit 0
fi

stop_server() {
  local pids
  pids=$(pgrep -f "node src/server.js" || true)
  if [ -n "$pids" ]; then
    echo ">> Stop server produksi (pids: $pids)"
    kill $pids; sleep 3
    pids=$(pgrep -f "node src/server.js" || true)
    [ -n "$pids" ] && { kill -9 $pids; sleep 1; }
  else
    echo ">> Server tidak sedang jalan."
  fi
}

start_server() {
  echo ">> Start server produksi (setsid, log: /tmp/chatbareng-server.log)"
  setsid nohup node src/server.js > /tmp/chatbareng-server.log 2>&1 &
  sleep 5
  local code
  code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "http://localhost:$PORT/" || echo 000)
  echo ">> Health check port $PORT: $code"
  [ "$code" = "200" ] || [ "$code" = "302" ] || echo "!! Health check TIDAK 200 — cek /tmp/chatbareng-server.log"
}

schema_only() {
  python3 - "$DB" <<'EOF'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
if 'GroupActionLog' in tables:
    con.execute("DROP TABLE GroupActionLog"); print(">> dropped: GroupActionLog")
else:
    print(">> GroupActionLog tidak ada (skip)")
cols = {r[1] for r in con.execute("PRAGMA table_info(Chat)")}
if 'picUserId' in cols:
    # SQLite >=3.35: ALTER TABLE DROP COLUMN
    con.execute("ALTER TABLE Chat DROP COLUMN picUserId"); print(">> dropped kolom: Chat.picUserId")
else:
    print(">> Chat.picUserId tidak ada (skip)")
con.commit()
ts = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
print(">> tabel sekarang:", len(ts))
EOF
}

if [ "$mode" = "--schema-only" ]; then
  [ "$ASSUME_YES" = "1" ] || { read -r -p "Jalankan schema-only rollback? [y/N] " a; [ "${a,,}" = "y" ] || die "dibatalkan"; }
  schema_only
  echo ">> Selesai. Server TIDAK di-restart (skema additive — server lama tetap aman)."
  exit 0
fi

# mode full
if [ "$ASSUME_YES" != "1" ]; then
  read -r -p "RESTORE PENUH + RESTART produksi? [ketik RESTORE] " a
  [ "$a" = "RESTORE" ] || die "dibatalkan"
fi

echo ">> Restore file dari snapshot $BK"
rm -rf src prisma frontend/src.tmp 2>/dev/null
cp -r "$BK/src" src
cp -r "$BK/prisma" prisma
cp "$BK/package.json" "$BK/package-lock.json" .
rm -rf frontend/src
cp -r "$BK/frontend-src" frontend/src
if [ -d "$BK/frontend-dist" ]; then rm -rf frontend/dist; cp -r "$BK/frontend-dist" frontend/dist; fi
echo ">> Verifikasi md5 (sample 5 file)"
head -5 backup/pre-v0.14.0-grup.md5 | while read -r sum path; do
  actual=$(md5sum "$path" 2>/dev/null | awk '{print $1}')
  [ "$sum" = "$actual" ] && echo "   OK  $path" || echo "   MISMATCH $path"
done

echo ">> Restore DB dari snapshot"
stop_server
cp "$DB_SNAP" "$DB"
python3 -c "
import sqlite3
c = sqlite3.connect('$DB')
print('>> DB restored:', c.execute('SELECT COUNT(*) FROM Chat').fetchone()[0], 'chats,', c.execute('SELECT COUNT(*) FROM Message').fetchone()[0], 'messages')
"
start_server
echo ">> ROLLBACK FULL SELESAI. Cek ChatBareng + WA session (harus reconnect tanpa QR)."