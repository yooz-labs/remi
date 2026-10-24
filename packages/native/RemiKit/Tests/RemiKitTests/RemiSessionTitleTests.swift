import Testing
@testable import RemiUI

@Suite struct RemiSessionTitleTests {
    private func session(
        name: String,
        machineName: String = "yahyas-mcm",
        machineID: String = "m1"
    ) -> RemiSessionSummary {
        RemiSessionSummary(
            id: "s1",
            machineID: machineID,
            machineName: machineName,
            name: name,
            harness: "Claude",
            project: "transit",
            status: .idle
        )
    }

    @Test func stripsTheMachinePrefixFromRealHubNames() {
        #expect(RemiSessionTitle.short(name: "yahyas-mcm:transit/dev", machineName: "yahyas-mcm") == "transit/dev")
        #expect(session(name: "yahyas-mcm:transit/dev").displayTitle == "transit/dev")
        #expect(session(name: "yahyas-mcm:transit/dev").name == "yahyas-mcm:transit/dev")
    }

    @Test func leavesOtherNamesAlone() {
        #expect(RemiSessionTitle.short(name: "transit/dev", machineName: "yahyas-mcm") == "transit/dev")
        #expect(RemiSessionTitle.short(name: "other:transit/dev", machineName: "yahyas-mcm") == "other:transit/dev")
        #expect(RemiSessionTitle.short(name: "yahyas-mcm", machineName: "yahyas-mcm") == "yahyas-mcm")
        #expect(RemiSessionTitle.short(name: "yahyas-mcm-2:a", machineName: "yahyas-mcm") == "yahyas-mcm-2:a")
    }

    @Test func matchIsExactAndCaseSensitive() {
        #expect(RemiSessionTitle.short(name: "Yahyas-MCM:transit", machineName: "yahyas-mcm") == "Yahyas-MCM:transit")
    }

    @Test func keepsTheNameWhenNothingWouldRemain() {
        #expect(RemiSessionTitle.short(name: "yahyas-mcm:", machineName: "yahyas-mcm") == "yahyas-mcm:")
        #expect(RemiSessionTitle.short(name: "yahyas-mcm:  ", machineName: "yahyas-mcm") == "yahyas-mcm:  ")
        #expect(RemiSessionTitle.short(name: ":a", machineName: "") == ":a")
    }

    @Test func stripsOnlyOnePrefix() {
        #expect(RemiSessionTitle.short(name: "m:m:a", machineName: "m") == "m:a")
    }

    @Test func machinesSharingANameStripTheirOwnPrefixAndKeepDistinctLabels() {
        let machines = [
            RemiMachineSummary(id: "a", name: "Studio", address: "10.0.0.1:18765", reachability: .connected, transport: .direct, sessionCount: 1),
            RemiMachineSummary(id: "b", name: "Studio", address: "10.0.0.2:18765", reachability: .connected, transport: .direct, sessionCount: 1),
        ]
        let labels = RemiMachineStripPresentation.uniqueLabels(for: machines)
        #expect(labels["a"] != labels["b"])
        let first = session(name: "Studio:app/dev", machineName: "Studio", machineID: "a")
        let second = session(name: "Studio:app/dev", machineName: "Studio", machineID: "b")
        #expect(first.displayTitle == "app/dev")
        #expect(second.displayTitle == "app/dev")
        // The presentation row tells them apart by the machine label, not the title.
        let one = PhoneDrawerSessionPresentation(session: first, machineLabel: labels["a"])
        let two = PhoneDrawerSessionPresentation(session: second, machineLabel: labels["b"])
        #expect(one.subtitle != two.subtitle)
    }

    @Test func escapedDisplayTextIsComparedAsShown() {
        let tricky = session(name: "yahyas-mcm:evil\u{202E}name")
        #expect(tricky.displayTitle == tricky.name.dropFirst("yahyas-mcm:".count))
        #expect(!tricky.displayTitle.contains("\u{202E}"))
    }

    @Test func searchFindsByTheShortOrFullName() {
        let all = [session(name: "yahyas-mcm:transit/dev")]
        #expect(RemiSessionFilter.apply(to: all, query: "transit/dev", machineKey: nil).count == 1)
        #expect(RemiSessionFilter.apply(to: all, query: "mcm:transit", machineKey: nil).count == 1)
        #expect(RemiSessionTriage.filtered(sessions: all, scope: .all, query: "mcm:transit").count == 1)
        #expect(RemiSessionTriage.filtered(sessions: all, scope: .all, query: "transit/dev").count == 1)
    }

    @Test func rowSubtitleAndLabelUseTheShortAndFullNames() {
        let presentation = PhoneDrawerSessionPresentation(session: session(name: "yahyas-mcm:transit/dev"))
        #expect(presentation.title == "transit/dev")
        #expect(presentation.accessibilityLabel.hasPrefix("yahyas-mcm:transit/dev, project"))
    }
}
