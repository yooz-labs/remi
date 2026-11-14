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

    @Test func stepMovesOnePhoneDensityAndStopsAtTheEnds() {
        #expect(RemiBoardCardResize.step(from: .row, direction: -1) == .row)
        #expect(RemiBoardCardResize.step(from: .row, direction: 1) == .regular)
        #expect(RemiBoardCardResize.step(from: .regular, direction: 1) == .large)
        #expect(RemiBoardCardResize.step(from: .large, direction: 1) == .large)
        #expect(RemiBoardCardResize.step(from: .large, direction: -1) == .regular)
        #expect(RemiBoardCardResize.step(from: .compact, direction: 0) == .regular)
    }

    @Test func widthTitleUsesSingularForOneColumnAndPluralForMultipleColumns() {
        #expect(RemiBoardCardResize.widthTitle(for: 1) == "1 column wide")
        #expect(RemiBoardCardResize.widthTitle(for: 2) == "2 columns wide")
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

    @Test func nonfiniteTranslationsKeepNonmediumStartsForBothCorners() {
        #expect(RemiBoardCardResize.size(startingAt: .row, verticalTranslation: .nan, topCorner: false) == .row)
        #expect(RemiBoardCardResize.size(startingAt: .row, verticalTranslation: .nan, topCorner: true) == .row)
        #expect(RemiBoardCardResize.size(startingAt: .large, verticalTranslation: .nan, topCorner: false) == .large)
        #expect(RemiBoardCardResize.size(startingAt: .large, verticalTranslation: .nan, topCorner: true) == .large)
        #expect(RemiBoardCardResize.size(startingAt: .regular, verticalTranslation: .infinity, topCorner: false) == .regular)
        #expect(RemiBoardCardResize.size(startingAt: .regular, verticalTranslation: .infinity, topCorner: true) == .regular)
        #expect(RemiBoardCardResize.size(startingAt: .regular, verticalTranslation: -.infinity, topCorner: false) == .regular)
        #expect(RemiBoardCardResize.size(startingAt: .regular, verticalTranslation: -.infinity, topCorner: true) == .regular)
    }

    @Test func tileExtrasLeaveCornerResizeDisabledByDefault() {
        #expect(RemiBoardTileExtras().cornerResize == nil)
    }

    @Test func trailingInsetKeepsComposerAndRowControlsOutsideTheHandleSquare() {
        #expect(RemiBoardCardResize.trailingControlInset == 24)
        #expect(
            RemiBoardCardResize.trailingControlInset + RemiTheme.Spacing.s + RemiTheme.Spacing.xs
                >= RemiTheme.Size.minimumTapTarget
        )
    }

    @Test func noOpFirstResizeCallbackClaimsTheCornerBeforeAConcurrentResize() throws {
        let nativeRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let screen = try String(
            contentsOf: nativeRoot.appendingPathComponent("iPhone/PhoneBoardScreen.swift"),
            encoding: .utf8
        )
        let update = try sourceSlice(
            screen,
            from: "private func updateCardResizePreview(",
            to: "private func finishCardResize("
        )
        let ownershipGuard = try sourceSlice(update, from: "let activeDrag = cardResizeDrags[key]", to: "var drag = activeDrag")
        #expect(ownershipGuard.contains("if let activeDrag, activeDrag.topCorner != topCorner { return false }"))

        let noOpBranch = try sourceSlice(
            update,
            from: "guard next.size != drag.previewSize || next.span != drag.previewSpan else {",
            to: "drag.previewSize = next.size"
        )
        #expect(noOpBranch.contains("if activeDrag == nil { cardResizeDrags[key] = drag }"))
        #expect(noOpBranch.contains("return true"))
    }

    @Test func sourceGuardsCoverResizeHandleWiring() throws {
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
        let resize = try String(
            contentsOf: nativeRoot.appendingPathComponent("RemiKit/Sources/RemiUI/RemiBoardCardResize.swift"),
            encoding: .utf8
        )

        #expect(tile.contains(".overlay(alignment: .topTrailing) { resizeHandle(top: true) }"))
        #expect(tile.contains(".overlay(alignment: .bottomTrailing) { resizeHandle(top: false) }"))
        #expect(tile.contains("if extras.placement == nil, let cornerResize = extras.cornerResize"))
        #expect(tile.contains("private var cornerResizeTrailingInset: CGFloat {"))
        #expect(tile.contains("guard extras.cornerResize != nil, extras.placement == nil else { return 0 }"))
        let header = try sourceSlice(tile, from: "private var header: some View {", to: "private var headerTitleContent")
        let summary = try sourceSlice(tile, from: "private var rowSummary: some View {", to: "private var latestLine: String {")
        let composer = try sourceSlice(tile, from: "private var quickComposer: some View {", to: "private var menu: some View {")
        let contentGutter = ".padding(.trailing, cornerResizeTrailingInset == 0 ? 0 : RemiTheme.Spacing.xs)"
        #expect(header.contains(".padding(.trailing, cornerResizeTrailingInset)"))
        #expect(header.contains(contentGutter))
        #expect(summary.components(separatedBy: ".padding(.trailing, cornerResizeTrailingInset)").count - 1 == 2)
        #expect(summary.components(separatedBy: contentGutter).count - 1 == 2)
        #expect(composer.contains(".padding(.trailing, cornerResizeTrailingInset)"))
        #expect(resize.contains("static let trailingControlInset"))
        #expect(resize.contains("RemiTheme.Size.minimumTapTarget - (RemiTheme.Spacing.s + RemiTheme.Spacing.xs)"))
        #expect(tile.contains(".highPriorityGesture(dragGesture)"))
        #expect(tile.contains("DragGesture(minimumDistance: 1, coordinateSpace: .global)"))
        #expect(tile.contains("if !onDragChanged($0.translation, top) { ignoresDrag = true }"))
        #expect(tile.contains("if !ignoresDrag { onDragEnded($0.translation, top) }"))
        #expect(tile.contains("if isDragging && !dragDidEnd && !ignoresDrag { onDragCancelled(top) }"))
        #expect(tile.contains("width: RemiTheme.Size.minimumTapTarget"))
        #expect(tile.contains("content.hoverEffect(.highlight)"))
        #expect(tile.contains(".accessibilityLabel(\"Resize card\")"))
        #expect(tile.contains(".accessibilityValue(\"\\(sizeTitle), \\(widthTitle)\")"))
        #expect(tile.contains(".accessibilityAction(named: \"Widen\") { onStep(1, 0) }"))
        #expect(tile.contains(".accessibilityAction(named: \"Narrow\") { onStep(-1, 0) }"))
        #expect(tile.contains(".accessibilityAction(named: \"Make taller\") { onStep(0, 1) }"))
        #expect(tile.contains(".accessibilityAction(named: \"Make shorter\") { onStep(0, -1) }"))
        #expect(tile.contains(".onKeyPress(.leftArrow) { onStep(-1, 0); return .handled }"))
        #expect(tile.contains(".onKeyPress(.rightArrow) { onStep(1, 0); return .handled }"))
        #expect(tile.contains(".onKeyPress(.upArrow) { onStep(0, -1); return .handled }"))
        #expect(tile.contains(".onKeyPress(.downArrow) { onStep(0, 1); return .handled }"))
        #expect(tile.contains("Drag up to make the card taller and right to widen."))
        #expect(tile.contains("Drag down to make the card taller and right to widen."))
        #expect(tile.contains("the left and right arrow keys to change width"))
        #expect(tile.contains("the up and down arrow keys to change height"))
        #expect(tile.contains("guard wasDragging, !dragging else { return }"))
        #expect(tile.contains("if !dragDidEnd && !ignoresDrag { onDragCancelled(top) }"))
        #expect(tile.contains("if !onDragChanged($0.translation, top) { ignoresDrag = true }"))
        #expect(screen.contains("guard presentation.isMultiColumn else { return nil }"))
        #expect(screen.contains(".onChange(of: columnLayout.columnCount) { _, _ in cardResizeDrags = [:] }"))
        #expect(screen.contains("cardResizeDrags = cardResizeDrags.filter { live.contains($0.key) }"))
        #expect(screen.contains("guard presentation.isMultiColumn,"))
        #expect(screen.contains("return drag.previewSize"))
        #expect(screen.contains("else { return effectiveSize(for: session) }"))
        #expect(screen.contains("onDragEnded: { translation, topCorner in"))
        #expect(screen.contains("onDragCancelled: { topCorner in cancelCardResize(for: key, topCorner: topCorner) }"))
        #expect(screen.contains("RemiBoardCardResize.step(from: currentSize, direction: sizeDirection)"))

        let update = try sourceSlice(
            screen,
            from: "private func updateCardResizePreview(",
            to: "private func finishCardResize("
        )
        let finish = try sourceSlice(
            screen,
            from: "private func finishCardResize(",
            to: "private func cancelCardResize("
        )
        let cancel = try sourceSlice(
            screen,
            from: "private func cancelCardResize(",
            to: "private func stepCardResize("
        )

        #expect(update.contains("let activeDrag = cardResizeDrags[key]"))
        #expect(update.contains("if let activeDrag, activeDrag.topCorner != topCorner { return false }"))
        #expect(update.contains("var drag = activeDrag ?? CardResizeDrag("))
        #expect(update.contains("guard drag.topCorner == topCorner else { return false }"))
        #expect(update.contains("guard next.size != drag.previewSize || next.span != drag.previewSpan else {"))
        #expect(update.contains("if activeDrag == nil { cardResizeDrags[key] = drag }"))
        #expect(!update.contains("board.setSize"))
        #expect(!update.contains("board.setSpan"))
        #expect(!update.contains("saveBoard()"))
        #expect(finish.contains("let sizeChanged = final.size != drag.startSize"))
        #expect(finish.contains("let spanChanged = final.span != drag.startSpan"))
        #expect(finish.contains("if sizeChanged { board.setSize(final.size, for: key) }"))
        #expect(finish.contains("if spanChanged { board.setSpan(final.span, for: key) }"))
        #expect(finish.contains("cardResizeDrags[key] = nil"))
        #expect(finish.contains("if sizeChanged || spanChanged { saveBoard() }"))
        #expect(finish.components(separatedBy: "saveBoard()").count - 1 == 1)
        #expect(cancel.contains("guard let drag = cardResizeDrags[key], drag.topCorner == topCorner else { return }"))
        #expect(cancel.contains("cardResizeDrags[key] = nil"))
        #expect(!cancel.contains("board.setSize"))
        #expect(!cancel.contains("board.setSpan"))
        #expect(!cancel.contains("saveBoard()"))
    }

    private func sourceSlice(_ source: String, from startMarker: String, to endMarker: String) throws -> String {
        let fullRange = source.startIndex..<source.endIndex
        let startRange = try #require(source.range(of: startMarker, range: fullRange))
        let endRange = try #require(source.range(of: endMarker, range: startRange.upperBound..<source.endIndex))
        return String(source[startRange.lowerBound..<endRange.lowerBound])
    }
}
