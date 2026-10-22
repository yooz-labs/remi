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

    @Test func lastKnownSessionsSaySoInTheSubtitleAndLabel() {
        let presentation = PhoneDrawerSessionPresentation(
            session: session(name: "Native iOS", project: "remi"),
            isLastKnown: true
        )
        #expect(presentation.isLastKnown)
        #expect(presentation.subtitle == "remi · Studio · Last known")
        #expect(presentation.accessibilityLabel == "Native iOS, project remi, on Studio, last known, machine offline")
        let same = PhoneDrawerSessionPresentation(session: session(name: "cli", project: "cli"), isLastKnown: true)
        #expect(same.subtitle == "Studio · Last known")
    }

    @Test func sessionsAreNotLastKnownByDefault() {
        let presentation = PhoneDrawerSessionPresentation(session: session(name: "a", project: "b"))
        #expect(!presentation.isLastKnown)
        #expect(!presentation.subtitle.contains("Last known"))
        #expect(!presentation.accessibilityLabel.contains("last known"))
    }

    @Test func machineLabelReplacesTheMachineName() {
        let presentation = PhoneDrawerSessionPresentation(
            session: session(name: "Native iOS", project: "remi"),
            isLastKnown: true,
            machineLabel: "Studio (127.0.0.1:1)"
        )
        #expect(presentation.subtitle == "remi · Studio (127.0.0.1:1) · Last known")
        #expect(presentation.accessibilityLabel.contains("on Studio (127.0.0.1:1)"))
        let same = PhoneDrawerSessionPresentation(session: session(name: "cli", project: "cli"), machineLabel: "S (a)")
        #expect(same.subtitle == "S (a)")
    }
}
