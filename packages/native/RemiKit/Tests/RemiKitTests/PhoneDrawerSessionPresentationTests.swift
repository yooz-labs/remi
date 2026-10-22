import Foundation
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

    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private let english = Locale(identifier: "en_US")

    private func active(hoursAgo: Double) -> RemiSessionSummary {
        let date = now.addingTimeInterval(-hoursAgo * 3600)
        return RemiSessionSummary(
            id: "s",
            machineName: "Studio",
            name: "cli",
            harness: "Claude",
            project: "cli",
            lastActivity: date.formatted(.iso8601),
            status: .idle
        )
    }

    @Test func subtitleAndLabelCarryTheRelativeLastActivity() {
        let presentation = PhoneDrawerSessionPresentation(session: active(hoursAgo: 2), now: now, locale: english)
        #expect(presentation.subtitle == "Studio · 2h ago")
        #expect(presentation.accessibilityLabel == "cli, project cli, on Studio, last active 2 hours ago")
    }

    @Test func lastKnownStaysAfterTheTime() {
        let presentation = PhoneDrawerSessionPresentation(
            session: active(hoursAgo: 48), isLastKnown: true, now: now, locale: english
        )
        #expect(presentation.subtitle == "Studio · 2d ago · Last known")
        #expect(presentation.accessibilityLabel.hasSuffix(", last known, machine offline"))
    }

    private func active(secondsAgo: Double, lastActivity: String? = nil, custom: Bool = false) -> RemiSessionSummary {
        RemiSessionSummary(
            id: "s",
            machineName: "Studio",
            name: "cli",
            harness: "Claude",
            project: "cli",
            lastActivity: custom ? lastActivity : now.addingTimeInterval(-secondsAgo).formatted(.iso8601),
            status: .idle
        )
    }

    private func present(_ session: RemiSessionSummary, locale: Locale? = nil) -> PhoneDrawerSessionPresentation {
        PhoneDrawerSessionPresentation(session: session, now: now, locale: locale ?? english)
    }

    @Test func aFutureOrJustNowActivityTimeReadsNow() {
        for seconds in [-3.0, 0.0] {
            let presentation = present(active(secondsAgo: seconds))
            #expect(presentation.subtitle == "Studio · now")
            #expect(presentation.accessibilityLabel == "cli, project cli, on Studio, last active now")
        }
    }

    @Test func noActivityOrAnUnparseableOneAddsNothing() {
        for session in [active(secondsAgo: 0, lastActivity: nil, custom: true),
                        active(secondsAgo: 0, lastActivity: "not a date", custom: true)] {
            let presentation = present(session)
            #expect(presentation.subtitle == "Studio")
            #expect(presentation.accessibilityLabel == "cli, project cli, on Studio")
        }
    }

    @Test func secondsAndMinutesBoundaries() {
        #expect(present(active(secondsAgo: 30)).subtitle == "Studio · 30s ago")
        #expect(present(active(secondsAgo: 300)).subtitle == "Studio · 5m ago")
        #expect(present(active(secondsAgo: 300)).accessibilityLabel == "cli, project cli, on Studio, last active 5 minutes ago")
    }

    @Test func aNonEnglishLocaleIsRespected() {
        let presentation = present(active(hoursAgo: 2), locale: Locale(identifier: "fr_FR"))
        #expect(presentation.subtitle != "Studio · 2h ago")
        #expect(presentation.subtitle.hasPrefix("Studio · "))
        // The system's abbreviated French reads "-2 h" (the .short style reads "il y a 2 h").
        #expect(presentation.subtitle.contains("2 h"))
        #expect(presentation.accessibilityLabel.contains("il y a 2 heures"))
    }
}
