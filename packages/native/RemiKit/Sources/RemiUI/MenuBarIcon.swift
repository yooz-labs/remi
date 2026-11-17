#if canImport(AppKit)
import AppKit

/// The Mac menu bar icon: Remi's own "r" in a rounded square, one color (a template image, so
/// macOS tints it for the light or dark menu bar and for the pressed state). Two states, each the
/// inverse of the other, as in Transit's menu bar icon:
///
/// - Nothing waiting: a thin outlined square with a filled "r".
/// - Something needs the person: a filled square with the "r" knocked out.
///
/// The "r" is the brand mark's own shape (`Mac/Assets.xcassets/MenuBarGlyph.imageset/r-mask.png`,
/// an alpha mask cut from the tinted app icon by `scripts/generate-menubar-mask.py`), not a font,
/// drawn at run time so it is crisp at 1x and 2x. The app supplies the mask from its asset
/// catalog: a missing image there is `nil`, where a missing Swift package resource bundle is a
/// crash.
public enum RemiMenuBarIcon {
    /// The standard menu bar icon canvas.
    public static let size = NSSize(width: 18, height: 18)
    /// The square sits this far inside the canvas, so it is 16pt, about the height of the
    /// system's own glyphs beside it.
    static let squareInset: CGFloat = 1
    /// A thin border: a whole number of pixels at 1x and 2x.
    static let borderWidth: CGFloat = 1
    static let cornerRadius: CGFloat = 4
    /// How much of the square's height the "r" takes: 15% less than 0.66, which read as too large
    /// in the real bar. The mark is square, so this is also its width fraction.
    static let glyphHeightFraction: CGFloat = 0.56

    /// The icon for a state, drawn from `mask` (black with the "r" as its alpha), or `nil` when
    /// the mask has no bitmap.
    public static func image(needsYou: Bool, mask: NSImage) -> NSImage? {
        guard let maskBitmap = mask.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            return nil
        }
        let aspect = CGFloat(maskBitmap.width) / CGFloat(maskBitmap.height)
        let image = NSImage(size: size, flipped: false) { rect in
            guard let context = NSGraphicsContext.current?.cgContext else { return false }
            context.saveGState()
            draw(needsYou: needsYou, mask: maskBitmap, aspect: aspect, in: rect, context: context)
            context.restoreGState()
            return true
        }
        image.isTemplate = true
        return image
    }

    /// Rounds to the half point, a whole pixel at 2x, so the "r"'s outer edges land on pixel
    /// boundaries.
    private static func snapped(_ value: CGFloat) -> CGFloat {
        (value * 2).rounded() / 2
    }

    /// Draws one state into `rect`. The knockout (`.destinationOut`) clears what is already
    /// there, so this assumes a transparent destination, which a drawing-handler image always
    /// gets.
    private static func draw(
        needsYou: Bool,
        mask: CGImage,
        aspect: CGFloat,
        in rect: CGRect,
        context: CGContext
    ) {
        context.interpolationQuality = .high
        context.setFillColor(CGColor(gray: 0, alpha: 1))
        context.setStrokeColor(CGColor(gray: 0, alpha: 1))

        let square = rect.insetBy(dx: squareInset, dy: squareInset)
        let glyphHeight = snapped(square.height * glyphHeightFraction)
        let glyphWidth = snapped(glyphHeight * aspect)
        let glyph = CGRect(
            x: snapped(square.midX - glyphWidth / 2),
            y: snapped(square.midY - glyphHeight / 2),
            width: glyphWidth,
            height: glyphHeight
        )

        if needsYou {
            // The fill's outer edge is the outline's outer edge, so both states occupy the same
            // footprint.
            context.addPath(CGPath(roundedRect: square, cornerWidth: cornerRadius, cornerHeight: cornerRadius, transform: nil))
            context.fillPath()
            context.setBlendMode(.destinationOut)
            context.draw(mask, in: glyph)
        } else {
            context.setLineWidth(borderWidth)
            let stroked = square.insetBy(dx: borderWidth / 2, dy: borderWidth / 2)
            context.addPath(CGPath(
                roundedRect: stroked,
                cornerWidth: cornerRadius - borderWidth / 2,
                cornerHeight: cornerRadius - borderWidth / 2,
                transform: nil
            ))
            context.strokePath()
            context.draw(mask, in: glyph)
        }
    }
}
#endif

#if DEBUG && canImport(AppKit)
import SwiftUI

extension RemiMenuBarIcon {
    /// The mask from the Mac asset catalog in the source tree, for the preview.
    static func previewMask() -> NSImage? {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Mac/Assets.xcassets/MenuBarGlyph.imageset/r-mask.png")
        return NSImage(contentsOf: url)
    }
}

/// The icon in both states on a light and a dark menu bar, at its real size and magnified, so the
/// shape can be reviewed without running the app. Template images take the bar's tint.
private struct MenuBarIconGallery: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(["Light", "Dark"], id: \.self) { appearance in
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 24) {
                        ForEach([false, true], id: \.self) { needsYou in
                            HStack(spacing: 14) {
                                icon(needsYou: needsYou, scale: 1)
                                icon(needsYou: needsYou, scale: 6)
                                Text(needsYou ? "needs you" : "idle").font(.caption)
                            }
                        }
                    }
                }
                .padding(14)
                .background(appearance == "Light" ? Color(white: 0.92) : Color(white: 0.16))
                .environment(\.colorScheme, appearance == "Light" ? .light : .dark)
            }
        }
        .padding()
    }

    @ViewBuilder
    private func icon(needsYou: Bool, scale: CGFloat) -> some View {
        if let mask = RemiMenuBarIcon.previewMask(), let image = RemiMenuBarIcon.image(needsYou: needsYou, mask: mask) {
            Image(nsImage: image)
                .renderingMode(.template)
                .interpolation(.none)
                .resizable()
                .frame(width: RemiMenuBarIcon.size.width * scale, height: RemiMenuBarIcon.size.height * scale)
                .foregroundStyle(.primary)
        } else {
            Text("no mask")
        }
    }
}

#Preview("Menu bar icon") { MenuBarIconGallery() }
#endif
