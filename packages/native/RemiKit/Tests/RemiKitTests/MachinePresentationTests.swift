import RemiUI
import Testing

@Test func machineSummaryDefaultsToNoOpenQuestions() {
    let summary = RemiMachineSummary(
        id: "machine",
        name: "Workstation",
        address: "workstation.local:18765",
        reachability: .connected,
        transport: .direct,
        sessionCount: 2
    )

    #expect(summary.openQuestionCount == 0)
}

@Test func machineSummaryCarriesOpenQuestionCount() {
    let summary = RemiMachineSummary(
        id: "machine",
        name: "Workstation",
        address: "workstation.local:18765",
        reachability: .connected,
        transport: .direct,
        sessionCount: 2,
        openQuestionCount: 3
    )

    #expect(summary.openQuestionCount == 3)
}
