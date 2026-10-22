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

    @Test func noActivityOrAnUnparsableOneAddsNothing() {
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

@Suite struct DisplayTextEscapingTests {
    private let rlo = "evil\u{202E}txt"
    private let control = "a\u{0007}b"

    @Test func sessionAndMachineNamesAreEscapedInTheModels() {
        let session = RemiSessionSummary(
            id: "s", machineName: rlo, name: rlo, harness: "Claude", project: control,
            status: .idle, lastMessage: control, resumeError: control
        )
        #expect(session.name == "evil\\u202Etxt")
        #expect(session.machineName == "evil\\u202Etxt")
        #expect(session.project == "a\\u0007b")
        #expect(session.lastMessage == "a\\u0007b")
        #expect(session.resumeError == "a\\u0007b")
        let machine = RemiMachineSummary(
            id: "m", name: rlo, address: control, reachability: .connected, transport: .direct, sessionCount: 0
        )
        #expect(machine.name == "evil\\u202Etxt")
        #expect(machine.address == "a\\u0007b")
    }

    @Test func identifiersAndTheProjectPathStayRaw() {
        let session = RemiSessionSummary(
            id: "s\u{202E}", machineName: rlo, name: "n", harness: "h", project: "p",
            projectPath: "/tmp/\(control)", status: .idle
        )
        #expect(session.id == "s\u{202E}")
        #expect(session.machineID == rlo)
        #expect(session.projectPath == "/tmp/\(control)")
    }

    @Test func presentationsNeverContainTheRawCharacters() {
        let session = RemiSessionSummary(id: "s", machineName: rlo, name: rlo, harness: "h", project: control, status: .idle)
        let presentation = PhoneDrawerSessionPresentation(session: session)
        for text in [presentation.subtitle, presentation.accessibilityLabel] {
            #expect(!text.unicodeScalars.contains { $0.value == 0x202E || $0.value == 7 })
        }
        let machine = RemiMachineSummary(id: "m", name: rlo, address: "a", reachability: .unreachable, transport: .direct, sessionCount: 0)
        let labels = RemiMachineStripPresentation.uniqueLabels(for: [machine])
        #expect(labels["m"] == "evil\\u202Etxt")
        #expect(RemiMachineStripPresentation.problemRows(in: [machine]).first?.message == "evil\\u202Etxt is offline")
    }

    @Test func cardNamesAreEscaped() {
        let card = RemiQuestionCardModel(
            id: "q", kind: .permission, text: "run \(rlo)", machineName: rlo, sessionID: "s", sessionName: control
        )
        #expect(card.machineName == "evil\\u202Etxt")
        #expect(card.sessionName == "a\\u0007b")
        #expect(card.text == "run evil\\u202Etxt")
    }

    @Test func modelsFollowTheSharedReferenceCorpus() throws {
        let tests = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        struct Corpus: Decodable { let cases: [[String: String]] }
        let corpus = try JSONDecoder().decode(Corpus.self, from: Data(contentsOf: tests.appendingPathComponent("Fixtures/display-text.json")))
        for sample in corpus.cases {
            let text = try #require(sample["text"])
            let expected = try #require(sample["expected"])
            let machine = RemiMachineSummary(id: "m", name: text, address: "a", reachability: .connected, transport: .direct, sessionCount: 0)
            #expect(machine.name == expected)
        }
    }
}

@Suite struct RemiDisplayTextTests {
    @Test func wrapsTheSharedPolicy() {
        #expect(RemiDisplayText.escape("a\u{202E}b") == "a\\u202Eb")
        #expect(RemiDisplayText.escape("plain\ttext\n") == "plain\ttext\n")
    }
}
