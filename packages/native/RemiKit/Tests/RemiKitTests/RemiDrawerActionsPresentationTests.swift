import Testing
@testable import RemiUI

@Suite struct RemiDrawerActionsPresentationTests {
    @Test func standardSizesKeepEveryActionInline() {
        let presentation = RemiDrawerActionsPresentation(isAccessibilitySize: false)
        #expect(presentation.inline == [.newSession, .addMachine, .preferences])
        #expect(presentation.menu.isEmpty)
        #expect(!presentation.hasMenu)
    }

    @Test func accessibilitySizesMoveTheRestIntoOneMenu() {
        let presentation = RemiDrawerActionsPresentation(isAccessibilitySize: true)
        #expect(presentation.inline == [.newSession])
        #expect(presentation.menu == [.addMachine, .preferences])
        #expect(presentation.hasMenu)
    }

    @Test func newSessionIsAlwaysInlineAndNeverInTheMenu() {
        for accessibility in [false, true] {
            let presentation = RemiDrawerActionsPresentation(isAccessibilitySize: accessibility)
            #expect(presentation.inline.first == .newSession)
            #expect(!presentation.menu.contains(.newSession))
        }
    }

    @Test func everyActionAppearsExactlyOnce() {
        for accessibility in [false, true] {
            let presentation = RemiDrawerActionsPresentation(isAccessibilitySize: accessibility)
            let all = presentation.inline + presentation.menu
            #expect(all.count == 3)
            #expect(Set(all.map { "\($0)" }).count == 3)
        }
    }

    @Test func actionsSitAtTheTopOnlyAtAccessibilitySizes() {
        #expect(RemiDrawerActionsPresentation(isAccessibilitySize: false).placement == .bottom)
        #expect(RemiDrawerActionsPresentation(isAccessibilitySize: true).placement == .top)
    }
}
