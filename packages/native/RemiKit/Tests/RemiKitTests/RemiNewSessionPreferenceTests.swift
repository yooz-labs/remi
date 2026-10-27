import Testing
@testable import RemiUI

@Suite struct RemiNewSessionPreferenceTests {
    private let labels = ["a": "Studio", "b": "Studio (127.0.0.1:2)"]

    @Test func anOfflinePreferredMachineIsNamedWithItsUniqueLabel() {
        #expect(RemiNewSessionPreference.unavailableNote(preferredMachineID: "b", availableMachineIDs: ["a"], labels: labels)
            == "Studio (127.0.0.1:2) is not connected. Choose another machine.")
    }

    @Test func noNoteWhenThereIsNothingToSay() {
        #expect(RemiNewSessionPreference.unavailableNote(preferredMachineID: nil, availableMachineIDs: ["a"], labels: labels) == nil)
        #expect(RemiNewSessionPreference.unavailableNote(preferredMachineID: "a", availableMachineIDs: ["a"], labels: labels) == nil)
        #expect(RemiNewSessionPreference.unavailableNote(preferredMachineID: "zz", availableMachineIDs: ["a"], labels: labels) == nil)
    }

    @Test func noMachineConnectedStillNamesThePreferredOne() {
        #expect(RemiNewSessionPreference.unavailableNote(preferredMachineID: "a", availableMachineIDs: [], labels: labels)
            == "Studio is not connected. Choose another machine.")
    }
}
