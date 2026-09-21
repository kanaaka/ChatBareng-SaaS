#!/bin/bash
# revert-ui-v0.9.0.sh — Auto revert UI WA CS Hub ke exact state sebelum revamp v0.9.0
# Dibuat 2026-09-09 (request Kanaka) SEBELUM revamp dimulai.
# Revert point: git tag pre-v0.9.0-ui-revamp (81af5c2 dst) + snapshot fisik backup/pre-v0.9.0-ui/
#
# PAKAI:
#   bash revert-ui-v0.9.0.sh --check   → lihat apa saja yang akan direvert (tanpa mengubah)
#   bash revert-ui-v0.9.0.sh --run     → jalankan revert lengkap
#   bash revert-ui-v0.9.0.sh --run --no-frontend  → skip rebuild frontend (pakai bundle snapshot)
#
# Yang direvert:
#   1. Frontend source (frontend/src, index.html, configs) → dari git tag
#   2. Frontend BUILD OUTPUT (public/) → dari snapshot tar.gz (bundle lama yang terlanjur ilang
#      dari tracking git) — di-restore TANPA rebuild, supaya 100% byte-identik dengan yang sekarang
#   3. File backend yang mungkin keubah kalau Dory over-scope (src/, prisma/schema.prisma) → dari git tag
#   4. .env TIDAK disentuh (kredensial aman)
#   5. DB TIDAK disentuh oleh default (schema revamp = frontend only) — kalau Dory iseng push schema,
#      ada opsi manual di bawah (prisma db push dari schema tag + restore backup DB, baca catatan)
#
# Setelah revert: restart server by PID (dibahas di output), health check, selesai.

set -euo pipefail

HUB="/home/kanakxxx/.openclaw/workspace/wa-cs-hub"
TAG="pre-v0.9.0-ui-revamp"
SNAP="$HUB/backup/pre-v0.9.0-ui"
REPO="/home/kanakxxx/.openclaw/workspace"   # git root workspace (hub adalah subfolder)

MODE="${1:-}"
[ "$MODE" = "--check" ] || [ "$MODE" = "--run" ] || {
  echo "Pakai: bash $0 --check | --run [--no-frontend]"; exit 1; }

cd "$REPO"

echo "=== 1/4 Status git vs tag $TAG ==="
git log --oneline -1 "$TAG"
git diff --stat "$TAG" -- wa-cs-hub/frontend/src wa-cs-hub/frontend/index.html wa-cs-hub/frontend/tailwind.config.js wa-cs-hub/frontend/vite.config.js wa-cs-hub/frontend/package.json wa-cs-hub/frontend/postcss.config.js wa-cs-hub/src wa-cs-hub/prisma/schema.prisma | tail -5
if [ "$MODE" = "--check" ]; then
  echo "(check only — tidak ada perubahan dilakukan)"
fi

echo "=== 2/4 Frontend source + backend over-scope → checkout dari tag ==="
if [ "$MODE" = "--run" ]; then
  git checkout "$TAG" -- \
    wa-cs-hub/frontend/src \
    wa-cs-hub/frontend/index.html \
    wa-cs-hub/frontend/tailwind.config.js \
    wa-cs-hub/frontend/vite.config.js \
    wa-cs-hub/frontend/package.json \
    wa-cs-hub/frontend/postcss.config.js \
    wa-cs-hub/src \
    wa-cs-hub/prisma/schema.prisma
  # hapus file frontend baru hasil revamp yang tidak dikenal tag (aman: hanya .vue/.css/.js di src)
  git diff --name-only --diff-filter=A "$TAG" -- wa-cs-hub/frontend/src | while read -r f; do
    [ -f "$f" ] && rm -f "$f" && echo "removed: $f"
  done
  echo "checkout OK"
else
  echo "(check only)"
fi

echo "=== 3/4 Bundle build (public/) dari snapshot fisik ==="
if [ "$MODE" = "--run" ] && [[ "${2:-}" != "--no-frontend" ]]; then
  tar -xzf "$SNAP/frontend-src-and-build.tar.gz" -C "$HUB" public/
  echo "public/ restored dari snapshot (byte-identik, TANPA rebuild)"
elif [ "$MODE" = "--run" ]; then
  echo "--no-frontend: bundle public/ TIDAK diubah (pakai snapshot manual nanti)"
else
  echo "(check only — snapshot tersedia: $SNAP/frontend-src-and-build.tar.gz)"
fi

echo "=== 4/4 Post-verify ==="
if [ "$MODE" = "--run" ]; then
  # bundle harus balik ke yang sekarang
  echo "index.html sekarang mereferensi bundle:"; grep -oE "index-[A-Za-z0-9_-]+\.js" "$HUB/public/index.html" | head -1
  git status --short -- wa-cs-hub/ | head -10
  echo ""
  echo "✅ Revert selesai. Langkah terakhir (manual):"
  echo "   1. Restart server BY PID (jangan pkill!):"
  echo "      kill \$(ps aux | grep 'node src/server.js' | grep -v grep | awk '{print \$2}' | head -1)"
  echo "      cd $HUB && setsid nohup node src/server.js > /tmp/wa-cs-hub.log 2>&1 & disown"
  echo "   2. curl http://localhost:5030/api/health  → harus {\"status\":\"ok\"}"
  echo "   3. Hard-refresh browser (Ctrl+Shift+R) → UI lama balik"
  echo ""
  echo "   Kalau SCHEMA DB ikut keubah Dory (tidak seharusnya — revamp frontend only):"
  echo "   gunakan backup DB: $SNAP/wa-cs-hub.db (stop server dulu, replace, start lagi)."
  echo "   ATAU: cd $HUB && npx prisma db push (dari schema hasil checkout tag) — additive-safe."
else
  echo "(check only — jalankan dengan --run untuk eksekusi)"
fi