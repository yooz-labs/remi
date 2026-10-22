import Testing
@testable import RemiUI

@Suite struct RemiMachineStripPresentationTests {
    private typealias Strip = RemiMachineStripPresentation

    private func machine(
        _ id: String,
        reachability: RemiMachineReachability = .connected,
        questions: Int = 0
    ) -> RemiMachineSummary {
        RemiMachineSummary(
            id: id,
            name: "Mac \(id)",
            address: "\(id).local:18765",
            reachability: reachability,
            transport: .direct,
            sessionCount: 1,
            openQuestionCount: questions
        )
    }

    private func machines(_ count: Int) -> [RemiMachineSummary] {
        (0..<count).map { machine("m\($0)") }
    }

    @Test func noMachinesShowNothing() {
        #expect(Strip.layout(for: [], isAccessibilitySize: false) == .none)
        #expect(Strip.layout(for: [], isAccessibilitySize: true) == .none)
    }

    @Test func oneMachineIsAHeaderAtAnySize() {
        let one = machines(1)
        #expect(Strip.layout(for: one, isAccessibilitySize: false) == .header(one[0]))
        #expect(Strip.layout(for: one, isAccessibilitySize: true) == .header(one[0]))
    }

    @Test func twoToFourMachinesAreChips() {
        for count in 2...4 {
            #expect(Strip.layout(for: machines(count), isAccessibilitySize: false) == .chips)
        }
    }

    @Test func fiveOrMoreMachinesScroll() {
        #expect(Strip.layout(for: machines(5), isAccessibilitySize: false) == .scrollingChips)
        #expect(Strip.layout(for: machines(9), isAccessibilitySize: false) == .scrollingChips)
    }

    @Test func accessibilitySizeUsesAMenuFromTwoMachines() {
        for count in [2, 4, 5, 9] {
            #expect(Strip.layout(for: machines(count), isAccessibilitySize: true) == .menu)
        }
    }

    @Test func dotStyleCoversEveryReachabilityWithAWord() {
        #expect(Strip.dotStyle(for: .connected) == .filled)
        #expect(Strip.dotStyle(for: .connecting) == .progress)
        #expect(Strip.dotStyle(for: .unreachable) == .hollow)
        #expect(Strip.dotStyle(for: .waitingForApproval) == .dashed)
        #expect(Strip.dotStyle(for: .connected).accessibilityWord == "connected")
        #expect(Strip.dotStyle(for: .connecting).accessibilityWord == "connecting")
        #expect(Strip.dotStyle(for: .unreachable).accessibilityWord == "offline")
        #expect(Strip.dotStyle(for: .waitingForApproval).accessibilityWord == "waiting for approval")
    }

    @Test func onlyUnreachableAndWaitingMachinesAreProblems() {
        let all = [
            machine("a", reachability: .connected),
            machine("b", reachability: .connecting),
            machine("c", reachability: .unreachable),
            machine("d", reachability: .waitingForApproval),
        ]
        let problems = Strip.problems(in: all)
        #expect(problems == [.unreachable(all[2]), .waitingForApproval(all[3])])
        #expect(problems.map(\.message) == ["Mac c is offline", "Mac d is waiting for approval"])
        #expect(Strip.problems(in: Array(all.prefix(2))).isEmpty)
    }

    @Test func problemIDsAreDistinct() {
        let m = machine("c", reachability: .unreachable)
        #expect(Strip.Problem.unreachable(m).id != Strip.Problem.waitingForApproval(m).id)
    }

    @Test func lastKnownIsTheUnreachableMachines() {
        let all = [
            machine("a", reachability: .connected),
            machine("b", reachability: .unreachable),
            machine("c", reachability: .waitingForApproval),
            machine("d", reachability: .connecting),
        ]
        #expect(Strip.lastKnownMachineIDs(in: all) == ["b"])
        #expect(Strip.lastKnownMachineIDs(in: []).isEmpty)
    }

    @Test func accessibilityLabelNamesStateAndWaitingCount() {
        #expect(Strip.accessibilityLabel(for: machine("a", questions: 2)) == "Mac a, connected, 2 waiting")
        #expect(Strip.accessibilityLabel(for: machine("b", reachability: .unreachable)) == "Mac b, offline")
    }

    private func named(_ id: String, _ name: String, address: String) -> RemiMachineSummary {
        RemiMachineSummary(id: id, name: name, address: address, reachability: .connected, transport: .direct, sessionCount: 0)
    }

    @Test func uniqueNamesAreLeftAlone() {
        let all = [named("a", "Studio", address: "1.local:1"), named("b", "Laptop", address: "2.local:1")]
        #expect(Strip.uniqueLabels(for: all) == ["a": "Studio", "b": "Laptop"])
        #expect(Strip.uniqueLabels(for: []).isEmpty)
    }

    @Test func collidingNamesGetTheAddress() {
        let all = [
            named("a", "yahyas-mcm", address: "127.0.0.1:18790"),
            named("b", "yahyas-mcm", address: "127.0.0.1:18791"),
            named("c", "Studio", address: "10.0.0.2:18765"),
        ]
        #expect(Strip.uniqueLabels(for: all) == [
            "a": "yahyas-mcm (127.0.0.1:18790)",
            "b": "yahyas-mcm (127.0.0.1:18791)",
            "c": "Studio",
        ])
    }

    @Test func problemMessageAndAccessibilityLabelTakeALabel() {
        let m = machine("c", reachability: .unreachable)
        #expect(Strip.Problem.unreachable(m).message(label: "Mac (addr)") == "Mac (addr) is offline")
        #expect(Strip.Problem.waitingForApproval(m).message(label: "X") == "X is waiting for approval")
        #expect(Strip.accessibilityLabel(for: m, label: "Mac (addr)") == "Mac (addr), offline")
    }

    @Test func oneOrTwoProblemsAreListedWithLabels() {
        let a = named("a", "Same", address: "h:1")
        let b = RemiMachineSummary(id: "b", name: "Same", address: "h:2", reachability: .unreachable, transport: .direct, sessionCount: 0)
        let c = RemiMachineSummary(id: "c", name: "Other", address: "h:3", reachability: .waitingForApproval, transport: .direct, sessionCount: 0)
        #expect(Strip.problemRows(in: [a]).isEmpty)
        let rows = Strip.problemRows(in: [a, b, c])
        #expect(rows.map(\.message) == ["Same (h:2) is offline", "Other is waiting for approval"])
        #expect(Set(rows.map(\.id)).count == 2)
    }

    @Test func threeOrMoreProblemsCollapseToOneSummary() {
        let all = (0..<5).map { machine("m\($0)", reachability: .unreachable) }
        let rows = Strip.problemRows(in: all)
        #expect(rows == [.summary(count: 5)])
        #expect(rows[0].message == "5 machines need attention")
        #expect(rows[0].accessibilityLabel == "5 machines need attention")
        #expect(Strip.problemRows(in: Array(all.prefix(3))) == [.summary(count: 3)])
        #expect(Strip.problemRows(in: Array(all.prefix(2))).count == 2)
    }

    @Test func equalNamesWithEqualAddressesAreNumberedInIDOrder() {
        let all = [
            named("c", "Studio", address: "127.0.0.1:1"),
            named("a", "Studio", address: "127.0.0.1:1"),
            named("b", "Studio", address: "127.0.0.1:1"),
        ]
        let expected = [
            "a": "Studio (127.0.0.1:1) 1",
            "b": "Studio (127.0.0.1:1) 2",
            "c": "Studio (127.0.0.1:1) 3",
        ]
        #expect(Strip.uniqueLabels(for: all) == expected)
        #expect(Strip.uniqueLabels(for: all.reversed()) == expected)
    }

    @Test func equalNamesWithDifferentAddressesAreNotNumbered() {
        let all = [named("a", "Studio", address: "h:1"), named("b", "Studio", address: "h:2")]
        #expect(Strip.uniqueLabels(for: all) == ["a": "Studio (h:1)", "b": "Studio (h:2)"])
    }

    @Test func namesAreComparedCaseSensitively() {
        let all = [named("a", "Studio", address: "h:1"), named("b", "studio", address: "h:1")]
        #expect(Strip.uniqueLabels(for: all) == ["a": "Studio", "b": "studio"])
    }

    @Test func fourMachinesAreChipsAndFiveScrollAtNormalSizes() {
        #expect(Strip.layout(for: machines(4), isAccessibilitySize: false) == .chips)
        #expect(Strip.layout(for: machines(5), isAccessibilitySize: false) == .scrollingChips)
    }

    @Test func exactlyOneProblemIsOneMachineRow() {
        let bad = machine("b", reachability: .unreachable)
        let rows = Strip.problemRows(in: [machine("a"), bad])
        #expect(rows == [.machine(.unreachable(bad), label: "Mac b")])
        #expect(rows[0].message == "Mac b is offline")
    }

    @Test func everyStateHasItsOwnSymbol() {
        let styles: [Strip.DotStyle] = [.filled, .progress, .hollow, .dashed]
        #expect(Set(styles.map(\.symbolName)).count == 4)
        #expect(Strip.dotStyle(for: .connected).symbolName == "circle.fill")
        #expect(Strip.dotStyle(for: .connecting).symbolName == "circle.dotted")
        #expect(Strip.dotStyle(for: .unreachable).symbolName == "wifi.slash")
        #expect(Strip.dotStyle(for: .waitingForApproval).symbolName == "person.badge.clock")
    }
}
