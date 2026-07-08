#!/usr/bin/env bash
# Render the menu-bar icon template PDFs from their SVG sources (#650).
# Requires rsvg-convert (brew install librsvg). PDFs are vector template
# images: macOS tints them by ALPHA for light/dark menu bars.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESIGN_DIR="$ROOT_DIR/packages/macos/design"
ASSETS_DIR="$ROOT_DIR/packages/macos/Remi/Assets.xcassets"

for variant in idle local remote; do
  src="$DESIGN_DIR/menubar-$variant.svg"
  dest="$ASSETS_DIR/menubar-$variant.imageset/menubar-$variant.pdf"
  rsvg-convert -f pdf "$src" -o "$dest"
  echo "rendered $dest"
done
