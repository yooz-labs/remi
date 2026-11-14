import Foundation
import Testing
@testable import RemiUI

@Suite struct RemiBoardCardPresentationTests {
    @Test func multiColumnPresentationUsesResolvedCount() {
        let rows: [(count: Int, isMultiColumn: Bool)] = [
            (-1, false),
            (0, false),
            (1, false),
            (2, true),
            (3, true),
            (6, true),
        ]

        for row in rows {
            let presentation = RemiBoardCardPresentation(columnCount: row.count)
            #expect(presentation.isMultiColumn == row.isMultiColumn)
            #expect(presentation.sizeChoices == (row.isMultiColumn ? RemiTileSize.phoneDensities : []))
            #expect(presentation.growsToContent == row.isMultiColumn)
        }
    }

    @Test func phoneBoardKeepsOneColumnAndUsesSpanningPlacementForMultiColumn() throws {
        let nativeRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let screen = try String(
            contentsOf: nativeRoot.appendingPathComponent("iPhone/PhoneBoardScreen.swift"),
            encoding: .utf8
        )
        let tile = try String(
            contentsOf: nativeRoot.appendingPathComponent("RemiKit/Sources/RemiUI/BoardTile.swift"),
            encoding: .utf8
        )
        let board = try String(
            contentsOf: nativeRoot.appendingPathComponent("RemiKit/Sources/RemiUI/RemiBoard.swift"),
            encoding: .utf8
        )

        #expect(screen.contains("if !RemiBoardCardPresentation(columnCount: columnLayout.columnCount).isMultiColumn {"))
        #expect(screen.contains("singleColumnStack(ordered: ordered, order: order, liveOrder: liveOrder, reader: reader)"))
        #expect(screen.contains("sizeChoices: presentation.sizeChoices"))
        #expect(screen.contains("growsToContent: presentation.growsToContent"))
        #expect(screen.contains("let placements = RemiBoardColumns.placements("))
        #expect(screen.contains("spans: ordered.map { displayedSpan(for: $0) }"))
        #expect(screen.contains("placements: placements,"))
        #expect(screen.contains(".frame(width: columnLayout.groupWidth, alignment: .top)"))
        #expect(screen.contains(".frame(maxWidth: .infinity)"))
        #expect(screen.contains("guard RemiBoardCardPresentation(columnCount: count).isMultiColumn else { return 1 }"))
        #expect(screen.contains("return min(max(board.span(for: RemiBoardOrder.key(for: session)), 1), count)"))
        #expect(screen.contains(".filter { $0.isLive && displayedSize(for: $0).showsComposer }"))
        #expect(screen.contains("filtered.filter { $0.isLive && displayedSize(for: $0).showsComposer }"))
        #expect(screen.contains("let heights = ordered.map { displayedSize(for: $0).phoneCardHeight }"))
        #expect(screen.contains("let size = displayedSize(for: session)"))
        #expect(!screen.contains("density.showsComposer"))
        #expect(screen.contains(".onChange(of: columnLayout.columnCount) { _, _ in cardResizeDrags = [:] }"))
        #expect(screen.contains("cardResizeDrags = cardResizeDrags.filter { live.contains($0.key) }"))
        #expect(screen.contains("var initialBoard: RemiBoardState? = nil"))
        #expect(
            screen.contains("board = storedBoard == RemiBoardState() ? (initialBoard ?? storedBoard) : storedBoard")
        )
        #expect(screen.contains("initialBoard: mixedSizes ? previewBoard : nil"))
        #expect(tile.contains("RemiBoardTileSizing.growsToContent("))
        #expect(tile.contains("content.frame(minHeight: height)"))
        #expect(tile.contains("content.frame(height: height)"))

        let displayedSpan = try sourceSlice(screen, from: "private func displayedSpan(", to: "    var body: some View {")
        #expect(displayedSpan.contains("guard RemiBoardCardPresentation(columnCount: count).isMultiColumn else { return 1 }"))
        #expect(displayedSpan.contains("drag.previewSpan"))
        #expect(displayedSpan.contains("board.span(for:"))

        let picker = try sourceSlice(
            screen,
            from: "Picker(\"Card size\", selection: Binding(get: { density }, set: { size in",
            to: "densityStorage = size.rawValue"
        )
        #expect(picker.contains("board.clearSizes()"))
        #expect(picker.contains("saveBoard()"))

        let tileSetter = try sourceSlice(screen, from: "onSetSize: { selectedSize in", to: "onTogglePin: {")
        #expect(tileSetter.contains("saveBoard()"))

        let densityMenu = try sourceSlice(
            screen,
            from: "private var densityMenu: some View {",
            to: "private var overflowMenu: some View {"
        )
        #expect(densityMenu.contains("RemiBoardCardPresentation(columnCount: columnLayout.columnCount).isMultiColumn"))
        #expect(densityMenu.contains("board.hasExplicitSizes || board.hasExplicitSpans"))
        #expect(densityMenu.contains("Button(\"Reset card sizes and widths\""))
        let reset = try sourceSlice(
            densityMenu,
            from: "Button(\"Reset card sizes and widths\", systemImage: \"arrow.counterclockwise\") {",
            to: ".help("
        )
        #expect(reset.contains("board.clearSizes()"))
        #expect(reset.contains("board.clearSpans()"))
        #expect(reset.contains("saveBoard()"))

        let spanStorage = try sourceSlice(board, from: "public func span(for key:", to: "public var savedFrames:")
        #expect(spanStorage.contains("max(1, spans[key] ?? 1)"))
        #expect(spanStorage.contains("spans[key] = span"))
        #expect(!spanStorage.contains("columnCount"))

        let macHandle = try sourceSlice(
            tile,
            from: "@ViewBuilder private func resizeHandle(top: Bool)",
            to: "@ViewBuilder private func cornerResizeHandle(top: Bool)"
        )
        #expect(macHandle.contains("placement.onResizeTopRightDrag($0.translation, false)"))
        #expect(macHandle.contains(".accessibilityAction(named: \"Widen\")"))
        #expect(macHandle.contains(".onKeyPress(.leftArrow)"))
        #expect(!macHandle.contains("cornerResize"))

        let phoneHandle = try sourceSlice(
            tile,
            from: "private struct RemiBoardResizeHandle: View",
            to: "private struct RemiBoardPointerHoverEffect: ViewModifier"
        )
        #expect(phoneHandle.contains(".accessibilityAction(named: \"Widen\")"))
        #expect(phoneHandle.contains(".accessibilityAction(named: \"Narrow\")"))
        #expect(phoneHandle.contains(".accessibilityAction(named: \"Make taller\")"))
        #expect(phoneHandle.contains(".accessibilityAction(named: \"Make shorter\")"))
        #expect(phoneHandle.contains(".onKeyPress(.leftArrow)"))
        #expect(phoneHandle.contains(".onKeyPress(.rightArrow)"))
        #expect(phoneHandle.contains(".onKeyPress(.upArrow)"))
        #expect(phoneHandle.contains(".onKeyPress(.downArrow)"))
        #expect(phoneHandle.contains(".accessibilityValue(\"\\(sizeTitle), \\(widthTitle)\")"))
        #expect(phoneHandle.contains("DragGesture(minimumDistance: 1, coordinateSpace: .global)"))

        let dragUpdate = try sourceSlice(
            screen,
            from: "private func updateCardResizePreview(",
            to: "private func finishCardResize("
        )
        #expect(dragUpdate.contains("if let activeDrag, activeDrag.topCorner != topCorner { return false }"))
        #expect(dragUpdate.contains("drag.startSpan"))
        #expect(dragUpdate.contains("drag.previewSpan"))
        #expect(dragUpdate.contains("guard next.size != drag.previewSize || next.span != drag.previewSpan else { return true }"))
        #expect(!dragUpdate.contains("if activeDrag == nil { cardResizeDrags[key]"))
        #expect(dragUpdate.contains("cardResizeDrags[key] = drag"))

        let finish = try sourceSlice(screen, from: "private func finishCardResize(", to: "private func cancelCardResize(")
        #expect(finish.contains("board.setSize(final.size, for: key)"))
        #expect(finish.contains("board.setSpan(final.span, for: key)"))
        #expect(finish.contains("if sizeChanged || spanChanged { saveBoard() }"))

        let cancel = try sourceSlice(screen, from: "private func cancelCardResize(", to: "private func stepCardResize(")
        #expect(cancel.contains("cardResizeDrags[key] = nil"))
        #expect(!cancel.contains("board.setSize"))
        #expect(!cancel.contains("board.setSpan"))
        #expect(!cancel.contains("saveBoard()"))

        let trailingInset = try sourceSlice(tile, from: "private var cornerResizeTrailingInset:", to: "private var canSend:")
        #expect(trailingInset.contains("guard extras.cornerResize != nil, extras.placement == nil else { return 0 }"))
        #expect(tile.contains("cornerResizeTrailingInset"))
    }

    private func sourceSlice(_ source: String, from startMarker: String, to endMarker: String) throws -> String {
        let fullRange = source.startIndex..<source.endIndex
        let startRange = try #require(source.range(of: startMarker, range: fullRange))
        let endRange = try #require(source.range(of: endMarker, range: startRange.upperBound..<source.endIndex))
        return String(source[startRange.lowerBound..<endRange.lowerBound])
    }
}
