import Testing
@testable import RemiUI

@Suite struct MachineCountTextTests {
    @Test func visibleTextSaysActive() {
        #expect(RemiMachineCountText.visible(activeSessions: 0) == "0 active")
        #expect(RemiMachineCountText.visible(activeSessions: 3) == "3 active")
    }

    @Test func accessibilityLabelSaysActiveSessions() {
        #expect(RemiMachineCountText.accessibilityLabel(activeSessions: 1) == "1 active session")
        #expect(RemiMachineCountText.accessibilityLabel(activeSessions: 0) == "0 active sessions")
        #expect(RemiMachineCountText.accessibilityLabel(activeSessions: 49) == "49 active sessions")
    }
}
