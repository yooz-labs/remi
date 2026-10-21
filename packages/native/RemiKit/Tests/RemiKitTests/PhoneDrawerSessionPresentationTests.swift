import Testing
@testable import RemiUI

@Suite struct PhoneDrawerSessionPresentationTests {
    private func session(name: String, project: String, questions: Int = 0) -> RemiSessionSummary {
        RemiSessionSummary(
            id: "s",
            machineName: "Studio",
            name: name,
            harness: "Claude",
            project: project,
            status: .idle,
            openQuestionCount: questions
        )
    }

    @Test func subtitleShowsOnlyMachineWhenProjectRepeatsName() {
        let presentation = PhoneDrawerSessionPresentation(session: session(name: "cli", project: "cli"))
        #expect(presentation.subtitle == "Studio")
    }

    @Test func subtitleIgnoresCaseAndSurroundingSpaceWhenComparing() {
        let presentation = PhoneDrawerSessionPresentation(session: session(name: "CLI ", project: "cli"))
        #expect(presentation.subtitle == "Studio")
    }

    @Test func subtitleJoinsProjectAndMachineOtherwise() {
        let presentation = PhoneDrawerSessionPresentation(session: session(name: "Native iOS", project: "remi"))
        #expect(presentation.subtitle == "remi · Studio")
    }

    @Test func accessibilityLabelIsCompleteInBothCases() {
        let same = PhoneDrawerSessionPresentation(session: session(name: "cli", project: "cli"))
        #expect(same.accessibilityLabel == "cli, project cli, on Studio")
        let other = PhoneDrawerSessionPresentation(session: session(name: "Native iOS", project: "remi", questions: 2))
        #expect(other.accessibilityLabel == "Native iOS, project remi, on Studio, 2 questions waiting")
        let one = PhoneDrawerSessionPresentation(session: session(name: "a", project: "b", questions: 1))
        #expect(one.accessibilityLabel == "a, project b, on Studio, 1 question waiting")
    }
}
