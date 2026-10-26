# Native brand assets

The iPhone app icon uses Remi's canonical lowercase `r` letter mark from the
shared Yooz product family. The mark is Fraunces Display 800, matching the
display face used by Notes and the related Transit/Notes letter-mark system.

Canonical source directory:

`../yooz-assets/icons/letter-marks/remi/`, relative to the Remi repository.

| Appearance | Canonical source | Source SHA-256 | Shipping SHA-256 |
|---|---|---|---|
| Light | `r-light.png` | `1ea98ea7ffe987e7386d69dd3fcdab2f5fd6e8b8a1e5b6592619f2a2a2efbd83` | `dff003098795008a3b32e2725cd95b6385c38f18c4178dcc42c4fc1d78c82b6c` |
| Dark | `r-dark.png` | `a16c13e39ecdcef81145ae3418d24692d217071cab268f4698c9544d7fab36e3` | `b6174bb0faf30119315759ff153e1ceb212f46bd059ceaedb72401367bcd1361` |
| Tinted | `r-tinted.png` | `0008ea5234506ab88b6e7dc6599432b99999deb557c483390abc763f2c8bd31e` | `0008ea5234506ab88b6e7dc6599432b99999deb557c483390abc763f2c8bd31e` |

The light and dark source images contain a redundant, fully opaque alpha
channel. Their shipping copies remove that channel without changing RGB pixel
values. The tinted source is copied byte-for-byte because its alpha channel is
the intentional monochrome mask used by iOS tinted icon rendering.

Re-export light and dark deterministically with ImageMagick:

```sh
magick r-light.png -alpha off PNG24:icon-light.png
magick r-dark.png -alpha off PNG24:icon-dark.png
```

Do not redraw or substitute the letterform in this repository. Update the
canonical Yooz asset first, then update the hashes and shipping files together.

## Mac app icon and menu bar icon

The Mac app icon is the iPhone's light icon, so the two apps share one mark.
`Mac/Assets.xcassets/AppIcon.appiconset/icon_1024.png` is a byte-for-byte copy of
`iPhone/Assets.xcassets/AppIcon.appiconset/icon-light.png` (shipping hash above); the smaller sizes
are that file scaled with `sips -z <px> <px>`. Like Transit's Mac icon, the artwork is used as
shipped, with no extra shaping.

The menu bar icon is drawn at run time by `RemiMenuBarIcon` (`RemiKit/Sources/RemiUI/MenuBarIcon.swift`),
as Transit's is: the "r" in a rounded square, one color, as a template image that macOS tints for the
light or dark menu bar. Nothing waiting is a thin outlined square with a filled "r"; something
waiting is a filled square with the "r" knocked out. The letter's shape is
`Mac/Assets.xcassets/MenuBarGlyph.imageset/r-mask.png` (loaded by the Mac app from its asset catalog), the alpha of the tinted icon
(`icon-tinted.png`, a copy of the canonical `r-tinted.png`), cropped to the glyph and halved in size.
Regenerate it after the mark changes, and commit the result:

```sh
uv run packages/native/scripts/generate-menubar-mask.py
```

| Source | Generated | Used by |
|---|---|---|
| `icon-tinted.png` | `r-mask.png` | `RemiMenuBarIcon` |
