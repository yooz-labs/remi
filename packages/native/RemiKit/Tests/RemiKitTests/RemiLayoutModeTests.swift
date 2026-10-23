import SwiftUI
import Testing
@testable import RemiUI

@MainActor
@Suite struct RemiLayoutModeTests {
    @Test func sizeClassDecides() {
        #expect(RemiLayoutMode.resolve(horizontalSizeClass: .regular, width: 300) == .regular)
        #expect(RemiLayoutMode.resolve(horizontalSizeClass: .compact, width: 1_200) == .compact)
    }

    @Test func widthStandsInOnlyWithoutASizeClass() {
        #expect(RemiLayoutMode.resolve(horizontalSizeClass: nil, width: 699) == .compact)
        #expect(RemiLayoutMode.resolve(horizontalSizeClass: nil, width: 700) == .regular)
        #expect(RemiLayoutMode.resolve(horizontalSizeClass: nil) == .compact)
    }

    /// Lays out `remiReadableColumn()` in a canvas of `canvas` points and returns the
    /// width the content got and where its leading edge landed.
    private func column(in canvas: CGFloat) -> (width: CGFloat, leading: CGFloat) {
        final class Box: @unchecked Sendable { var frame = CGRect.zero }
        let box = Box()
        let view = Color.clear
            .frame(height: 10)
            .background {
                GeometryReader { proxy in
                    box.frame = proxy.frame(in: .named("canvas"))
                    return Color.clear
                }
            }
            .remiReadableColumn()
            .frame(width: canvas, height: 50)
            .coordinateSpace(name: "canvas")
        let renderer = ImageRenderer(content: view)
        _ = renderer.cgImage
        return (box.frame.width, box.frame.minX)
    }

    @Test func narrowCanvasIsUnchanged() {
        let narrow = column(in: 320)
        #expect(narrow.width == 320)
        #expect(narrow.leading == 0)
    }

    @Test func canvasAtTheCapIsUnchanged() {
        #expect(column(in: 720).width == 720)
    }

    @Test func wideCanvasGetsACenteredCappedColumn() {
        let wide = column(in: 1_000)
        #expect(wide.width == 720)
        #expect(wide.leading == 140)
    }
}
