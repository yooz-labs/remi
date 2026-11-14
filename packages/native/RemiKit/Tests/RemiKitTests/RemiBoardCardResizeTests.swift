import Foundation
import Testing
@testable import RemiUI

@Suite struct RemiBoardCardResizeTests {
    @Test func bottomCornerFollowsTheFingerAcrossLiteralMidpoints() {
        #expect(RemiBoardCardResize.size(startingAt: .regular, verticalTranslation: 0, topCorner: false) == .regular)
        #expect(RemiBoardCardResize.size(startingAt: .regular, verticalTranslation: 60, topCorner: false) == .regular)
        #expect(RemiBoardCardResize.size(startingAt: .regular, verticalTranslation: 90, topCorner: false) == .regular)
        #expect(RemiBoardCardResize.size(startingAt: .regular, verticalTranslation: 100, topCorner: false) == .large)
        #expect(RemiBoardCardResize.size(startingAt: .regular, verticalTranslation: -73, topCorner: false) == .row)
        #expect(RemiBoardCardResize.size(startingAt: .regular, verticalTranslation: -72, topCorner: false) == .row)
    }

    @Test func compactAndLongStartsStepAtTheLiteralBoundaries() {
        #expect(RemiBoardCardResize.size(startingAt: .row, verticalTranslation: 40, topCorner: false) == .row)
        #expect(RemiBoardCardResize.size(startingAt: .row, verticalTranslation: 72, topCorner: false) == .regular)
        #expect(RemiBoardCardResize.size(startingAt: .large, verticalTranslation: -100, topCorner: false) == .regular)
        #expect(RemiBoardCardResize.size(startingAt: .large, verticalTranslation: -101, topCorner: false) == .regular)
    }

    @Test func topCornerMirrorsTheBottomCorner() {
        #expect(RemiBoardCardResize.size(startingAt: .regular, verticalTranslation: -100, topCorner: true) == .large)
        #expect(RemiBoardCardResize.size(startingAt: .regular, verticalTranslation: 72, topCorner: true) == .row)
    }

    @Test func nonPhoneStartingSizeCountsAsMedium() {
        #expect(RemiBoardCardResize.size(startingAt: .compact, verticalTranslation: 0, topCorner: false) == .regular)
        #expect(RemiBoardCardResize.size(startingAt: .compact, verticalTranslation: -73, topCorner: false) == .row)
    }

    @Test func extremeAndNonfiniteTranslationsAreBounded() {
        #expect(
            RemiBoardCardResize.size(
                startingAt: .regular,
                verticalTranslation: CGFloat.greatestFiniteMagnitude,
                topCorner: false
            ) == .large
        )
        #expect(
            RemiBoardCardResize.size(
                startingAt: .regular,
                verticalTranslation: -CGFloat.greatestFiniteMagnitude,
                topCorner: false
            ) == .row
        )
        #expect(RemiBoardCardResize.size(startingAt: .large, verticalTranslation: .infinity, topCorner: false) == .large)
        #expect(RemiBoardCardResize.size(startingAt: .regular, verticalTranslation: .nan, topCorner: false) == .regular)
        #expect(RemiBoardCardResize.size(startingAt: .compact, verticalTranslation: .nan, topCorner: false) == .regular)
    }

    @Test func tileExtrasLeaveCornerResizeDisabledByDefault() {
        #expect(RemiBoardTileExtras().cornerResize == nil)
    }

    @Test func handleWiringKeepsMacPathAndPersistsOnlyCompletedDrags() throws {
        let nativeRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let tile = try String(
            contentsOf: nativeRoot.appendingPathComponent("RemiKit/Sources/RemiUI/BoardTile.swift"),
            encoding: .utf8
        )
        let screen = try String(
            contentsOf: nativeRoot.appendingPathComponent("iPhone/PhoneBoardScreen.swift"),
            encoding: .utf8
        )

        #expect(tile.contains(".overlay(alignment: .topTrailing) { resizeHandle(top: true) }"))
        #expect(tile.contains(".overlay(alignment: .bottomTrailing) { resizeHandle(top: false) }"))
        #expect(tile.contains("if extras.placement == nil, let cornerResize = extras.cornerResize"))
        #expect(tile.contains(".highPriorityGesture(dragGesture)"))
        #expect(tile.contains("width: RemiTheme.Size.minimumTapTarget"))
        #expect(tile.contains("content.hoverEffect(.highlight)"))
        #expect(tile.contains(".accessibilityValue(sizeTitle)"))
        #expect(tile.contains(".accessibilityAction(named: \"Make larger\")"))
        #expect(tile.contains(".accessibilityAction(named: \"Make smaller\")"))
        #expect(screen.contains("guard presentation.isMultiColumn else { return nil }"))
        #expect(screen.contains("onDragEnded: { translation, topCorner in"))
        #expect(screen.contains("onDragCancelled: { cancelCardResize(for: key) }"))

        let updateStart = try #require(screen.range(of: "private func updateCardResizePreview(")?.lowerBound)
        let finishStart = try #require(screen.range(of: "private func finishCardResize(")?.lowerBound)
        let cancelStart = try #require(screen.range(of: "private func cancelCardResize(")?.lowerBound)
        let stepStart = try #require(screen.range(of: "private func stepCardResize(")?.lowerBound)
        let update = String(screen[updateStart..<finishStart])
        let finish = String(screen[finishStart..<cancelStart])
        let cancel = String(screen[cancelStart..<stepStart])

        #expect(!update.contains("board.setSize"))
        #expect(!update.contains("saveBoard()"))
        #expect(finish.contains("board.setSize(finalSize, for: key)"))
        #expect(finish.components(separatedBy: "saveBoard()").count - 1 == 1)
        #expect(cancel.contains("resizingCardPreviewSizes[key] = nil"))
        #expect(!cancel.contains("board.setSize"))
        #expect(!cancel.contains("saveBoard()"))
    }
}
