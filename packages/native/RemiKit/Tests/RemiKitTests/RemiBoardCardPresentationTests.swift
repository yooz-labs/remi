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

    @Test func phoneBoardCallSitesUseTheSharedPresentationRules() throws {
        let nativeRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let screen = try String(
            contentsOf: nativeRoot.appendingPathComponent("iPhone/PhoneBoardScreen.swift"),
            encoding: .utf8
        )

        #expect(screen.contains("if !RemiBoardCardPresentation(columnCount: columnLayout.columnCount).isMultiColumn {"))
        #expect(screen.contains("sizeChoices: presentation.sizeChoices"))
        #expect(screen.contains("growsToContent: presentation.growsToContent"))
        #expect(screen.contains("columnCount: columnLayout.columnCount\n        )"))
        #expect(screen.contains(".filter { $0.isLive && effectiveSize(for: $0).showsComposer }"))
        #expect(screen.contains("filtered.filter { $0.isLive && effectiveSize(for: $0).showsComposer }"))
        #expect(screen.contains("let heights = ordered.map { effectiveSize(for: $0).phoneCardHeight }"))
        #expect(!screen.contains("density.showsComposer"))
        #expect(screen.contains(".onChange(of: composerKeys) { _, keys in"))
        #expect(screen.contains("if let focusedKey = focus, !keys.contains(focusedKey) { focus = nil }"))

        let pickerStart = try #require(
            screen.range(of: "Picker(\"Card size\", selection: Binding(get: { density }, set: { size in")?.lowerBound
        )
        let pickerEnd = try #require(
            screen.range(of: "densityStorage = size.rawValue", range: pickerStart..<screen.endIndex)?.upperBound
        )
        let pickerSetter = String(screen[pickerStart..<pickerEnd])
        #expect(pickerSetter.contains("board.clearSizes()"))
        #expect(pickerSetter.contains("saveBoard()"))
        #expect(pickerSetter.contains("densityStorage = size.rawValue"))

        let tileSetterStart = try #require(screen.range(of: "onSetSize: { selectedSize in")?.lowerBound)
        let tileSetterEnd = try #require(
            screen.range(of: "onTogglePin: {", range: tileSetterStart..<screen.endIndex)?.lowerBound
        )
        #expect(String(screen[tileSetterStart..<tileSetterEnd]).contains("saveBoard()"))

        let menuStart = try #require(screen.range(of: "private var densityMenu: some View {")?.lowerBound)
        let menuEnd = try #require(screen.range(of: "private var overflowMenu: some View {")?.lowerBound)
        let densityMenu = String(screen[menuStart..<menuEnd])
        #expect(densityMenu.contains("RemiBoardCardPresentation(columnCount: columnLayout.columnCount).isMultiColumn"))
        #expect(densityMenu.contains("board.hasExplicitSizes"))
        #expect(densityMenu.contains("Button(\"Reset card sizes\""))

        let resetStart = try #require(
            screen.range(of: "Button(\"Reset card sizes\", systemImage: \"arrow.counterclockwise\") {")?.lowerBound
        )
        let resetEnd = try #require(
            screen.range(of: "\n                }", range: resetStart..<screen.endIndex)?.lowerBound
        )
        let resetAction = String(screen[resetStart..<resetEnd])
        #expect(resetAction.contains("board.clearSizes()"))
        #expect(resetAction.contains("saveBoard()"))
    }
}
