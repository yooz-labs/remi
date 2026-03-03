#!/bin/bash
set -euo pipefail

VERSION="${1:?Usage: publish-npm.sh <version> [--dry-run]}"
DRY_RUN=""
if [[ "${2:-}" == "--dry-run" ]]; then
  DRY_RUN="--dry-run"
fi

# Validate semver format
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-.+)?$ ]]; then
  echo "Error: VERSION must be semver (e.g. 1.2.3), got: $VERSION" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NPM_DIR="$ROOT_DIR/npm"

PLATFORMS=("darwin-arm64" "darwin-x64" "linux-arm64" "linux-x64")

echo "==> Building all platform binaries..."
cd "$ROOT_DIR"
bun run build:all

echo "==> Validating built binaries..."
for PLAT in "${PLATFORMS[@]}"; do
  BINARY="$ROOT_DIR/dist/remi-$PLAT"
  if [[ ! -f "$BINARY" || ! -s "$BINARY" ]]; then
    echo "Error: Missing or empty binary for $PLAT at $BINARY" >&2
    exit 1
  fi
  echo "  OK: remi-$PLAT ($(wc -c < "$BINARY" | tr -d ' ') bytes)"
done

echo "==> Updating versions to $VERSION..."

# Use env vars to avoid shell interpolation into JS
# npm publish is used here because bun publish does not support provenance or scoped packages
MAIN_PKG="$NPM_DIR/remi/package.json" PKG_VERSION="$VERSION" node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync(process.env.MAIN_PKG, 'utf8'));
pkg.version = process.env.PKG_VERSION;
for (const key of Object.keys(pkg.optionalDependencies || {})) {
  pkg.optionalDependencies[key] = process.env.PKG_VERSION;
}
fs.writeFileSync(process.env.MAIN_PKG, JSON.stringify(pkg, null, 2) + '\n');
"

for PLAT in "${PLATFORMS[@]}"; do
  PLAT_DIR="$NPM_DIR/remi-$PLAT"

  # Update version via env var
  PLAT_PKG="$PLAT_DIR/package.json" PKG_VERSION="$VERSION" node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync(process.env.PLAT_PKG, 'utf8'));
  pkg.version = process.env.PKG_VERSION;
  fs.writeFileSync(process.env.PLAT_PKG, JSON.stringify(pkg, null, 2) + '\n');
  "

  # Copy binary
  mkdir -p "$PLAT_DIR/bin"
  cp "$ROOT_DIR/dist/remi-$PLAT" "$PLAT_DIR/bin/remi"
  chmod +x "$PLAT_DIR/bin/remi"

  echo "==> Publishing @yooz-labs/remi-$PLAT@$VERSION..."
  (cd "$PLAT_DIR" && npm publish --access public $DRY_RUN)
done

echo "==> Publishing @yooz-labs/remi@$VERSION..."
(cd "$NPM_DIR/remi" && npm publish --access public $DRY_RUN)

echo "==> Done. Published @yooz-labs/remi@$VERSION"
