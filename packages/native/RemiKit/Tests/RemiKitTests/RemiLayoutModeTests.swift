import SwiftUI
import Testing
@testable import RemiUI

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

    @Test func readableColumnNeverGrowsPastTheCap() {
        #expect(RemiTheme.Size.readableContentWidth == 720)
        #expect(RemiReadableColumn.width(available: 320) == 320)
        #expect(RemiReadableColumn.width(available: 720) == 720)
        #expect(RemiReadableColumn.width(available: 1_000) == 720)
        #expect(RemiReadableColumn.width(available: -5) == 0)
    }

    @Test func sidebarLeavesRoomForAReadableColumn() {
        // The narrowest regular canvas is 700; the sidebar must not take all of it.
        #expect(RemiTheme.Size.sidebarWidth < RemiLayoutMode.regularMinimumWidth / 2)
    }
}
