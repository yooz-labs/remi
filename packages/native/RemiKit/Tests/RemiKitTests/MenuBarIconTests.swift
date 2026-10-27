import Foundation
import Testing
@testable import RemiUI

@Suite struct MenuBarStatusTests {
    private func label(_ status: RemiMenuBarStatus) -> String { String(localized: status.accessibilityLabel) }

    @Test func nothingWaitingIsIdleWithNoCount() {
        let status = RemiMenuBarStatus(pendingCount: 0, identityAvailable: true)
        #expect(!status.needsYou)
        #expect(status.count == nil)
        #expect(label(status) == "Remi, no pending requests")
    }

    @Test func waitingRequestsFillTheIconAndShowTheCount() {
        let one = RemiMenuBarStatus(pendingCount: 1, identityAvailable: true)
        #expect(one.needsYou)
        #expect(one.count == 1)
        #expect(label(one) == "Remi, 1 pending request")
        let several = RemiMenuBarStatus(pendingCount: 4, identityAvailable: true)
        #expect(several.count == 4)
        #expect(label(several) == "Remi, 4 pending requests")
    }

    @Test func withoutAnIdentityNothingCanBeAnswered() {
        let status = RemiMenuBarStatus(pendingCount: 3, identityAvailable: false)
        #expect(!status.needsYou)
        #expect(status.count == nil)
        #expect(label(status) == "Remi unavailable")
    }

    @Test func aNegativeCountIsNone() {
        let status = RemiMenuBarStatus(pendingCount: -2, identityAvailable: true)
        #expect(status.pendingCount == 0)
        #expect(!status.needsYou)
    }
}

#if canImport(AppKit)
import AppKit

@Suite struct MenuBarIconTests {
    /// The mask the Mac app ships, read from its asset catalog in the source tree.
    private func mask() throws -> NSImage {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Mac/Assets.xcassets/MenuBarGlyph.imageset/r-mask.png")
        return try #require(NSImage(contentsOf: url), "the menu bar glyph mask is missing from the Mac asset catalog")
    }

    /// The icon drawn into a 2x bitmap (36 by 36 pixels): the alpha of every pixel.
    private func alphas(needsYou: Bool) throws -> [[Double]] {
        let mask = try mask()
        let image = try #require(RemiMenuBarIcon.image(needsYou: needsYou, mask: mask))
        let side = 36
        let rep = try #require(NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: side, pixelsHigh: side, bitsPerSample: 8,
            samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
            bytesPerRow: 0, bitsPerPixel: 0))
        let context = try #require(NSGraphicsContext(bitmapImageRep: rep))
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        image.draw(in: NSRect(x: 0, y: 0, width: side, height: side))
        NSGraphicsContext.restoreGraphicsState()
        return (0..<side).map { y in
            (0..<side).map { x in Double(rep.colorAt(x: x, y: y)?.alphaComponent ?? 0) }
        }
    }

    @Test func theMaskIsBundledAndIsTheLettersShape() throws {
        let mask = try mask()
        let bitmap = try #require(mask.cgImage(forProposedRect: nil, context: nil, hints: nil))
        #expect(bitmap.width > 100 && bitmap.height > 100)
        // Cropped to the glyph, so it is not a wide or tall strip.
        let aspect = Double(bitmap.width) / Double(bitmap.height)
        #expect(aspect > 0.7 && aspect < 1.4)
    }

    @Test func bothStatesAreMonochromeTemplatesOnTheStandardCanvas() throws {
        let mask = try mask()
        for needsYou in [false, true] {
            let image = try #require(RemiMenuBarIcon.image(needsYou: needsYou, mask: mask))
            #expect(image.isTemplate)
            #expect(image.size == RemiMenuBarIcon.size)
        }
    }

    @Test func theStatesAreInversesInsideTheSameBorder() throws {
        let idle = try alphas(needsYou: false)
        let filled = try alphas(needsYou: true)
        var border = 0, letter = 0, interior = 0, outside = 0
        var letterRows = Set<Int>(), letterColumns = Set<Int>()
        for y in idle.indices {
            for x in idle[y].indices {
                let (a, b) = (idle[y][x], filled[y][x])
                if a > 0.9 && b > 0.9 { border += 1 }
                else if a > 0.9 && b < 0.1 { letter += 1; letterRows.insert(y); letterColumns.insert(x) }
                else if a < 0.1 && b > 0.9 { interior += 1 }
                else if a < 0.1 && b < 0.1 { outside += 1 }
            }
        }
        // A shared outline; the letter filled when idle and knocked out when waiting; the rest of
        // the square the other way round; and the margin around the square empty in both.
        #expect(border > 40)
        #expect(letter > 40)
        #expect(interior > letter)
        #expect(outside > 0)
        // The letter sits in the middle of the canvas, clear of the border.
        let top = letterRows.min() ?? 0, bottom = letterRows.max() ?? 99
        let left = letterColumns.min() ?? 0, right = letterColumns.max() ?? 99
        #expect(top >= 6 && bottom <= 29 && left >= 6 && right <= 29)
        // The mark is square, so its box is about square, and it sits in the middle of the canvas.
        #expect(abs((bottom - top) - (right - left)) <= 3)
        #expect(abs(Double(top + bottom) / 2 - 17.5) <= 1.5)
        #expect(abs(Double(left + right) / 2 - 17.5) <= 1.5)
        // And it is a good part of the square, not a speck, but with room round it: a little over a
        // half of the 16 pt square, which is 18 pixels at 2x.
        #expect(bottom - top + 1 >= 17 && bottom - top + 1 <= 19)
    }

    @Test func theEmptyStateHasAnEmptyMiddleAndTheWaitingStateAFilledOne() throws {
        let idle = try alphas(needsYou: false)
        let filled = try alphas(needsYou: true)
        // Just inside the left border, level with the middle and clear of the letter: empty when idle, solid when waiting.
        #expect(idle[18][5] < 0.1)
        #expect(filled[18][5] > 0.9)
    }
}
#endif
