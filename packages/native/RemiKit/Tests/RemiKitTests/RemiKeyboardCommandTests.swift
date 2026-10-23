import Testing
@testable import RemiUI

@Suite struct RemiKeyboardCommandTests {
    private func guardState(
        sheet: Bool = false,
        drawer: Bool = false,
        session: Bool = true,
        machine: Bool = true
    ) -> RemiKeyboardCommandGuard {
        RemiKeyboardCommandGuard(
            sheetIsActive: sheet,
            drawerIsOpen: drawer,
            hasSelectedSession: session,
            hasConnectedMachine: machine
        )
    }

    @Test func everyCommandRunsWhenNothingIsInTheWay() {
        for command in RemiKeyboardCommand.allCases {
            #expect(guardState().allows(command))
        }
    }

    @Test func noCommandRunsBehindASheet() {
        for command in RemiKeyboardCommand.allCases {
            #expect(!guardState(sheet: true).allows(command))
        }
    }

    @Test func focusComposerWaitsForAClosedDrawerAndASession() {
        #expect(!guardState(drawer: true).allows(.focusComposer))
        #expect(!guardState(session: false).allows(.focusComposer))
        #expect(guardState(drawer: true).allows(.toggleSidebar))
    }

    @Test func newSessionNeedsAConnectedMachine() {
        #expect(!guardState(machine: false).allows(.newSession))
        #expect(guardState(machine: false).allows(.nextSession))
    }
}
