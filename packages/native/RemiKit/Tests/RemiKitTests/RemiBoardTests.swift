import Foundation
import Testing
@testable import RemiUI

@Suite struct RemiBoardTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func session(
        _ id: String, _ status: RemiSessionStatus = .idle, minutesAgo: Double? = nil, machine: String = "m"
    ) -> RemiSessionSummary {
        RemiSessionSummary(
            id: id,
            machineID: machine,
            machineName: machine,
            name: id,
            harness: "claude",
            project: "p",
            lastActivity: minutesAgo.map { now.addingTimeInterval(-$0 * 60).formatted(.iso8601) },
            status: status
        )
    }

    private func order(
        _ sessions: [RemiSessionSummary],
        state: RemiBoardState = RemiBoardState(),
        interactions: [String: Date] = [:],
        held: [String: Int] = [:]
    ) -> [String] {
        RemiBoardOrder.arrange(sessions, state: state, interactions: interactions, held: held, now: now).map(\.id)
    }

    // MARK: columns

    @Test func columnsFollowTheWidthAndStayWithinBounds() {
        #expect(RemiBoardOrder.columnCount(width: 300) == 1)
        #expect(RemiBoardOrder.columnCount(width: 700) == 2)
        #expect(RemiBoardOrder.columnCount(width: 1_100) == 3)
        #expect(RemiBoardOrder.columnCount(width: 10_000) == RemiBoardOrder.maximumColumns)
        #expect(RemiBoardOrder.columnCount(width: 0) == 1)
    }

    // MARK: automatic order

    @Test func aQuestionComesFirstThenRecentTypingThenWorkThenIdleThenOffline() {
        let sessions = [
            session("offline", .offline, minutesAgo: 1),
            session("idle", .idle, minutesAgo: 1),
            session("working", .working, minutesAgo: 30),
            session("typed", .idle, minutesAgo: 90),
            session("question", .needsYou, minutesAgo: 600),
        ]
        let key = RemiBoardOrder.key(for: sessions[3])
        #expect(order(sessions, interactions: [key: now.addingTimeInterval(-60)])
            == ["question", "typed", "working", "idle", "offline"])
    }

    @Test func anOldInteractionNoLongerLiftsATile() {
        let sessions = [session("idle", .idle, minutesAgo: 1), session("typed", .idle, minutesAgo: 90)]
        let key = RemiBoardOrder.key(for: sessions[1])
        #expect(order(sessions, interactions: [key: now.addingTimeInterval(-3_600)]) == ["idle", "typed"])
    }

    @Test func withinATierTheMoreRecentSessionComesFirstAndTiesFallBackToName() {
        let sessions = [
            session("b", .working, minutesAgo: 5),
            session("a", .working, minutesAgo: 5),
            session("c", .working, minutesAgo: 1),
        ]
        #expect(order(sessions) == ["c", "a", "b"])
    }

    @Test func theSameSessionIdOnTwoMachinesStaysTwoTiles() {
        let sessions = [session("s", machine: "one"), session("s", machine: "two")]
        #expect(RemiBoardOrder.key(for: sessions[0]) != RemiBoardOrder.key(for: sessions[1]))
        #expect(order(sessions).count == 2)
    }

    // MARK: pinned and held tiles

    @Test func aPinnedTileKeepsItsSlotWhileTheRestReorder() {
        let sessions = [
            session("idle", .idle),
            session("question", .needsYou),
            session("working", .working),
        ]
        var state = RemiBoardState()
        state.pin(RemiBoardOrder.key(for: sessions[0]), atSlot: 0)
        #expect(order(sessions, state: state) == ["idle", "question", "working"])
    }

    @Test func aHeldTileDoesNotJumpWhileItsComposerIsInUse() {
        let sessions = [session("a", .idle), session("b", .needsYou), session("c", .idle)]
        let held = [RemiBoardOrder.key(for: sessions[0]): 0]
        #expect(order(sessions, held: held).first == "a")
    }

    @Test func aSlotPastTheEndIsClampedAndCollisionsTakeTheNextFreeSlot() {
        let sessions = [session("a"), session("b"), session("c")]
        var state = RemiBoardState()
        state.pin(RemiBoardOrder.key(for: sessions[0]), atSlot: 9)
        state.pin(RemiBoardOrder.key(for: sessions[1]), atSlot: 9)
        let result = order(sessions, state: state)
        #expect(Set(result) == ["a", "b", "c"])
        #expect(result.count == 3)
    }

    @Test func movingATileOntoAnotherTakesItsPlaceAndPinsIt() {
        let sessions = [session("a", .needsYou), session("b", .working), session("c", .idle)]
        var state = RemiBoardState()
        let current = order(sessions)
        state.move(
            RemiBoardOrder.key(for: sessions[2]),
            onto: RemiBoardOrder.key(for: sessions[0]),
            in: current.map { id in RemiBoardOrder.key(for: sessions.first { $0.id == id }!) }
        )
        let result = order(sessions, state: state)
        #expect(result.first == "c")
        #expect(Set(result) == ["a", "b", "c"])
        #expect(state.isPinned(RemiBoardOrder.key(for: sessions[2])))
    }

    @Test func unpinningReturnsATileToAutomaticOrder() {
        let sessions = [session("a", .needsYou), session("b", .idle)]
        var state = RemiBoardState()
        let key = RemiBoardOrder.key(for: sessions[1])
        state.pin(key, atSlot: 0)
        #expect(order(sessions, state: state).first == "b")
        state.unpin(key)
        #expect(order(sessions, state: state).first == "a")
    }

    // MARK: state

    @Test func sizesDefaultToRegularAndAreRemembered() {
        var state = RemiBoardState()
        #expect(state.size(for: "k") == .regular)
        state.setSize(.large, for: "k")
        #expect(state.size(for: "k") == .large)
    }

    @Test func stateRoundTripsAndToleratesGarbage() {
        var state = RemiBoardState()
        state.pin("k", atSlot: 2)
        state.setSize(.compact, for: "k")
        #expect(RemiBoardState(storage: state.storageValue) == state)
        #expect(RemiBoardState(storage: "nope") == RemiBoardState())
        #expect(RemiBoardState(storage: "") == RemiBoardState())
    }

    @Test func pruningForgetsSessionsThatAreGone() {
        var state = RemiBoardState()
        state.pin("gone", atSlot: 0)
        state.setSize(.large, for: "gone")
        state.pin("kept", atSlot: 1)
        state.prune(keeping: ["kept"])
        #expect(!state.isPinned("gone"))
        #expect(state.size(for: "gone") == .regular)
        #expect(state.isPinned("kept"))
    }

    // MARK: next tile

    @Test func afterSendingFocusMovesToTheNextTileAndWrapsAround() {
        #expect(RemiBoardOrder.next(after: "a", in: ["a", "b", "c"]) == "b")
        #expect(RemiBoardOrder.next(after: "c", in: ["a", "b", "c"]) == "a")
        #expect(RemiBoardOrder.next(after: "a", in: ["a"]) == nil)
        #expect(RemiBoardOrder.next(after: "x", in: ["a", "b"]) == "a")
    }
}
