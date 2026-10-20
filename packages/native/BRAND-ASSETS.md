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
