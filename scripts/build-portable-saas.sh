#!/usr/bin/env bash
# =====================================================================
# scripts/build-portable-saas.sh — build Installer Windows ChatBareng SAAS
# =====================================================================
# Rebuild tooling OSS utk sahabat-repo itu sendiri; dijalankan di LINUX
# (makensis + pkg + npm cross-platform flags). TIDAK menyentuh DB/data produksi.
#
# Output: /tmp/cb-saas-installer/ChatBareng-Install.exe (NSIS, per-user launch).
# Prasyarat: apt install nsis; node>=20; network (unduh node.exe/cloudflared/engine).
# =====================================================================
set -euo pipefail

REPO="${REPO:-/home/kanaka/.openclaw/workspace/wa-cs-hub-saas-v3}"   # mirror subtree SAAS
WORK=/tmp/cb-saas-installer
STAGING=$WORK/payload
NODE_WIN_VER="v24.10.0"   # LTS win-x64 nodejs.org (launcher paket pkg = node20; app = node24)
PKG_VER="6.4.1"           # @yao-pkg/pkg (fork; base node20)

echo "==> 0. Bersihkan staging"
rm -rf "$WORK"
mkdir -p "$STAGING/app" "$WORK/pkgwork"

echo "==> 1. Salin source repo ke payload/app (TANPA dev junk)"
rsync -a --exclude node_modules --exclude data --exclude .env --exclude logs src/ "$STAGING/app/src/"
rsync -a --exclude data prisma/ "$STAGING/app/prisma/"
rsync -a scripts/ "$STAGING/app/scripts/"
rsync -a public/ "$STAGING/app/public"
cp package.json package-lock.json version.json LICENSE README.md "$STAGING/app/" 2>/dev/null || true

echo "==> 2. npm ci produksi utk Windows (os=win32 cpu=x64)"
cd "$STAGING/app"
npm ci --omit=dev --ignore-scripts --os=win32 --cpu=x64 --no-audit --no-fund

echo "==> 3. Prisma generate (binaryTargets=[native,windows] di schema)"
npx prisma generate
find node_modules/.prisma/client -name "query_engine-windows.dll.node" | grep -q . || { echo "FATAL: query engine windows hilang"; exit 1; }

echo "==> 4. schema-engine-windows.exe (utk db push first-run di PC user)"
EV=$(node -e "console.log(require('./node_modules/@prisma/engines-version/package.json').prisma.enginesVersion)")
curl -m 300 -L -sS -o /tmp/se.gz "https://binaries.prisma.sh/all_commits/$EV/windows/schema-engine.exe.gz"
gunzip -c /tmp/se.gz > node_modules/@prisma/engines/schema-engine-windows.exe
file node_modules/@prisma/engines/schema-engine-windows.exe | grep -q PE32 || { echo "FATAL: engine bukan PE"; exit 1; }

echo "==> 5. node.exe v24 win-x64 resmi"
curl -m 300 -L -sS -o "$STAGING/app/node.exe" "https://nodejs.org/dist/$NODE_WIN_VER/win-x64/node.exe"
file "$STAGING/app/node.exe" | grep -q PE32 || { echo "FATAL: node.exe bukan PE"; exit 1; }

echo "==> 6. cloudflared.exe resmi (latest release)"
curl -m 300 -L -sS -o "$STAGING/cloudflared.exe" \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
file "$STAGING/cloudflared.exe" | grep -q PE32 || { echo "FATAL: cloudflared bukan PE"; exit 1; }

echo "==> 7. Launcher SAAS: pkg node20-win-x64 = Mulai-ChatBareng.exe"
cd "$WORK/pkgwork" && cp "$REPO/launcher/launcher-saas.js" . 2>/dev/null || cp "$REPO/launcher/launcher-saas.js" .
npm install --no-save "@yao-pkg/pkg@$PKG_VER" --no-audit --no-fund
npx pkg launcher-saas.js -t node20-win-x64 -o "$STAGING/Mulai-ChatBareng.exe"
[ -f "$STAGING/Mulai-ChatBareng.exe" ] || { echo "FATAL launcher"; exit 1; }

echo "==> 8. Docs user"
cp "$REPO/launcher/CARA-PAKAI.txt" "$STAGING/CARA-PAKAI.txt"

echo "==> 9. QA statis: tidak ada .db/.env/secrets bocor dari repo"
find "$STAGING" -not -path "*/node_modules/*" \( -name "*.db" -o -name "*.db-journal" -o -name ".env" -o -name "KREDENSIAL*" -o -name "*.enc" \) | grep . && { echo "FATAL bocor data"; exit 1; }
echo "qa statis OK (0 leak)"

echo "==> 10. NSIS"
NSIS_SCRIPT="${REPO}/scripts/msi-build/chb-saas.nsi"
cd "$WORK"
makensis -DROOT="$STAGING" -DOUTFILE="$WORK/ChatBareng-Install.exe" "$NSIS_SCRIPT" | tail -4
ls -la "$WORK/ChatBareng-Install.exe"
sha256sum "$WORK/ChatBareng-Install.exe"
echo "SELESAI: $WORK/ChatBareng-Install.exe"
