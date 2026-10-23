import Testing
@testable import RemiUI

@Suite struct RemiSessionViewStateTests {
    private func key(_ id: String = "s1", machine: String = "m1") -> RemiSessionKey {
        RemiSessionKey(machineID: machine, sessionID: id)
    }

    @Test func aNewSessionStartsBlank() {
        #expect(RemiSessionViewStateStore().state(for: key()) == RemiSessionViewState())
    }

    @Test func draftSubagentAndReadingPositionSurviveALayoutChange() {
        var store = RemiSessionViewStateStore()
        var shell = PhoneShellState(destination: .session(PhoneSessionRoute(machineKey: "m1", sessionID: "s1")))
        store.update(key()) {
            $0.draft = "half a thought"
            $0.selectedViewID = "explore"
            $0.visibleEntryID = "entry-7"
            $0.followsLatest = false
        }

        // Compact to regular rebuilds the screen: it reads its state back from the store.
        shell.layoutModeChanged(to: .regular)
        let restored = store.state(for: key())

        #expect(shell.selectedSessionKey == key())
        #expect(restored.draft == "half a thought")
        #expect(restored.selectedViewID == "explore")
        #expect(restored.visibleEntryID == "entry-7")
        #expect(!restored.followsLatest)
    }

    @Test func sessionsAreKeptApartIncludingAcrossMachines() {
        var store = RemiSessionViewStateStore()
        store.update(key("s1", machine: "m1")) { $0.draft = "one" }
        store.update(key("s1", machine: "m2")) { $0.draft = "two" }
        #expect(store.state(for: key("s1", machine: "m1")).draft == "one")
        #expect(store.state(for: key("s1", machine: "m2")).draft == "two")
        #expect(store.state(for: key("s2", machine: "m1")).draft == "")
    }

    @Test func resettingToDefaultsLeavesNoEntry() {
        var store = RemiSessionViewStateStore()
        store.update(key()) { $0.draft = "x" }
        store.update(key()) { $0.draft = "" }
        #expect(store == RemiSessionViewStateStore())
    }
}
