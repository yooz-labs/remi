#!/bin/bash
set -euo pipefail

VERSION="${1:?Usage: publish-npm.sh <version> [--dry-run]}"
DRY_RUN=""
if [[ "${2:-}" == "--dry-run" ]]; then
  DRY_RUN="--dry-run"
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NPM_DIR="$ROOT_DIR/npm"

PLATFORMS=("darwin-arm64" "darwin-x64" "linux-arm64" "linux-x64")

echo "==> Building all platform binaries..."
cd "$ROOT_DIR"
bun run build:all

echo "==> Updating versions to $VERSION..."

# Update main package version and optionalDependencies versions
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('$NPM_DIR/remi/package.json', 'utf8'));
pkg.version = '$VERSION';
for (const key of Object.keys(pkg.optionalDependencies || {})) {
  pkg.optionalDependencies[key] = '$VERSION';
}
fs.writeFileSync('$NPM_DIR/remi/package.json', JSON.stringify(pkg, null, 2) + '\n');
"

for PLAT in "${PLATFORMS[@]}"; do
  PLAT_DIR="$NPM_DIR/remi-$PLAT"

  # Update version
  node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('$PLAT_DIR/package.json', 'utf8'));
  pkg.version = '$VERSION';
  fs.writeFileSync('$PLAT_DIR/package.json', JSON.stringify(pkg, null, 2) + '\n');
  "

  # Copy binary
  mkdir -p "$PLAT_DIR/bin"
  cp "$ROOT_DIR/dist/remi-$PLAT" "$PLAT_DIR/bin/remi"
  chmod +x "$PLAT_DIR/bin/remi"

  echo "==> Publishing @yooz-labs/remi-$PLAT@$VERSION..."
  cd "$PLAT_DIR"
  npm publish --access public $DRY_RUN
done

echo "==> Publishing @yooz-labs/remi@$VERSION..."
cd "$NPM_DIR/remi"
npm publish --access public $DRY_RUN

echo "==> Done. Published @yooz-labs/remi@$VERSION"
