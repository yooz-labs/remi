# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=10", "numpy>=1.26"]
# ///
"""Derive the "r" alpha mask the Mac menu bar icon is drawn from (#1239).

usage: uv run packages/native/scripts/generate-menubar-mask.py [source.png] [output.png]

The source is the iPhone app's tinted icon
(`packages/native/iPhone/Assets.xcassets/AppIcon.appiconset/icon-tinted.png`), a copy of the
canonical `r-tinted.png` (see BRAND-ASSETS.md). It is a white "r" on a transparent background,
so its alpha channel is already the letter's shape. The result is black with that alpha, cropped
to the glyph's bounding box and halved in size, so the app can draw it as a monochrome template
image at any scale. Nothing is redrawn: the letterform is the brand mark's own.

Commit the output (`RemiKit/Sources/RemiUI/Resources/r-mask.png`); rerun this after the mark
changes. The output is deterministic for a given source.
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image

NATIVE = Path(__file__).resolve().parent.parent


def main() -> None:
    source = (
        Path(sys.argv[1])
        if len(sys.argv) > 1
        else NATIVE / "iPhone/Assets.xcassets/AppIcon.appiconset/icon-tinted.png"
    )
    output = (
        Path(sys.argv[2]) if len(sys.argv) > 2 else NATIVE / "RemiKit/Sources/RemiUI/Resources/r-mask.png"
    )

    alpha = np.asarray(Image.open(source).convert("RGBA"), dtype=np.float64)[:, :, 3] / 255.0
    rows = np.flatnonzero(alpha.max(axis=1) > 0.02)
    cols = np.flatnonzero(alpha.max(axis=0) > 0.02)
    if rows.size == 0 or cols.size == 0:
        sys.exit(f"{source}: found no glyph (is this the white r on a transparent background?)")
    top, bottom, left, right = rows[0], rows[-1] + 1, cols[0], cols[-1] + 1
    alpha = alpha[top:bottom, left:right]

    mask = np.zeros((*alpha.shape, 4), dtype=np.uint8)
    mask[:, :, 3] = np.round(alpha * 255).astype(np.uint8)
    image = Image.fromarray(mask, "RGBA")
    image = image.resize((image.width // 2, image.height // 2), Image.Resampling.LANCZOS)
    image.save(output, optimize=True)
    print(f"{output}: {image.width}x{image.height} (glyph box in the source: x {left}-{right}, y {top}-{bottom})")


if __name__ == "__main__":
    main()
