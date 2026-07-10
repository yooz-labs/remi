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
  # --dpi 72: rsvg-convert defaults to 96 DPI (CSS px), but PDF points are
  # 72/inch — without this an 18x18 SVG lands as a 13.5pt page and the menu
  # bar renders the icon 25% small (#746 review, verified via pdfinfo).
  rsvg-convert -f pdf --dpi-x=72 --dpi-y=72 "$src" -o "$dest"
  echo "rendered $dest ($(pdfinfo "$dest" 2>/dev/null | grep 'Page size' || echo 'pdfinfo unavailable'))"
done
