#!/usr/bin/env bash
# Stage the built web UI into the macOS app's Resources (#649).
#
# The Xcode target carries packages/macos/Remi/Resources/web as a folder
# reference; this script populates it from packages/web/dist. Xcode itself
# never invokes bun (PATH/sandbox fragility) — a pre-build phase only
# VERIFIES index.html exists and points here when it does not.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIR="$ROOT_DIR/packages/web"
STAGE_DIR="$ROOT_DIR/packages/macos/Remi/Resources/web"

echo "[1/2] Building web UI..."
(cd "$WEB_DIR" && bun run build)

echo "[2/2] Staging dist -> $STAGE_DIR"
mkdir -p "$STAGE_DIR"
rsync -a --delete --exclude .gitkeep "$WEB_DIR/dist/" "$STAGE_DIR/"

echo "Staged $(find "$STAGE_DIR" -type f | wc -l | tr -d ' ') files."
