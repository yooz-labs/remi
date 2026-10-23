import Testing
@testable import RemiUI

@Suite struct RemiShellChromeTests {
    private func route(_ id: String = "s1") -> PhoneSessionRoute {
        PhoneSessionRoute(machineKey: "m1", sessionID: id)
    }

    @Test func compactKeepsTheDrawerChromeExactly() {
        let chrome = RemiShellChrome.resolve(mode: .compact)
        #expect(!chrome.usesSidebar)
        #expect(chrome.showsMenuButton)
        #expect(chrome.showsDrawerCloseButton)
        #expect(chrome.showsDimLayer)
        #expect(chrome.edgePanEnabled(isDrawerOpen: false, isAtRoot: true))
        #expect(!chrome.edgePanEnabled(isDrawerOpen: true, isAtRoot: true))
        #expect(!chrome.edgePanEnabled(isDrawerOpen: false, isAtRoot: false))
    }

    @Test func regularHidesDrawerChromeAndDisablesTheEdgePan() {
        let chrome = RemiShellChrome.resolve(mode: .regular)
        #expect(chrome.usesSidebar)
        #expect(!chrome.showsMenuButton)
        #expect(!chrome.showsDrawerCloseButton)
        #expect(!chrome.showsDimLayer)
        #expect(!chrome.edgePanEnabled(isDrawerOpen: false, isAtRoot: true))
    }

    @Test func sidebarEnvironmentNeverBlocksFreezesOrClaimsFocus() {
        let sidebar = RemiShellChrome.resolve(mode: .regular).sidebarEnvironment
        #expect(!sidebar.blocksTaps)
        #expect(!sidebar.orderFrozen)
        #expect(!sidebar.isOpen)
        #expect(RemiShellChrome.resolve(mode: .compact).sidebarEnvironment == nil)
    }

    @Test func becomingRegularClosesTheDrawerAndKeepsTheSession() {
        var state = PhoneShellState(
            destination: .session(route()),
            isDrawerOpen: true,
            pendingFocus: PhoneQuestionFocus(machineKey: "m1", sessionID: "s1", questionID: "q1"),
            drawerFilter: .machine("m1")
        )
        state.layoutModeChanged(to: .regular)
        #expect(!state.isDrawerOpen)
        #expect(state.destination == .session(route()))
        #expect(state.pendingFocus?.questionID == "q1")
        #expect(state.drawerFilter == .machine("m1"))
    }

    @Test func becomingCompactChangesNothing() {
        var state = PhoneShellState(destination: .session(route()), isDrawerOpen: false)
        let before = state
        state.layoutModeChanged(to: .compact)
        #expect(state == before)
    }
}
