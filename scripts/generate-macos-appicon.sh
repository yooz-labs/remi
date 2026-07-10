#!/usr/bin/env bash
# Render the macOS AppIcon PNG set from its SVG source (#658).
# Requires rsvg-convert (brew install librsvg).
set -euo pipefail

command -v rsvg-convert >/dev/null 2>&1 || { echo "ERROR: rsvg-convert not found (brew install librsvg)" >&2; exit 1; }

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT_DIR/packages/macos/design/appicon.svg"
DEST="$ROOT_DIR/packages/macos/Remi/Assets.xcassets/AppIcon.appiconset"

mkdir -p "$DEST"
for px in 16 32 64 128 256 512 1024; do
  rsvg-convert -f png -w "$px" -h "$px" "$SRC" -o "$DEST/icon_${px}.png"
  echo "rendered icon_${px}.png"
done
