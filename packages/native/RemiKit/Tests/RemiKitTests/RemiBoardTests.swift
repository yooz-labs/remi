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

    @Test func twoSessionsWithTheSameKeyShowOnceAndKeepTheFirst() {
        let first = session("a", .working)
        let second = session("a", .idle)
        let result = RemiBoardOrder.arrange(
            [first, session("b"), second], state: RemiBoardState(), interactions: [:], held: [:], now: now
        )
        #expect(result.count == 2)
        #expect(result.filter { $0.id == "a" }.map(\.status) == [.working])
    }

    @Test func slotsPastTheEndKeepTheirRelativeOrder() {
        let sessions = [session("a"), session("b"), session("c")]
        var state = RemiBoardState()
        state.pin(RemiBoardOrder.key(for: sessions[0]), atSlot: 9)
        state.pin(RemiBoardOrder.key(for: sessions[1]), atSlot: 10)
        #expect(order(sessions, state: state) == ["c", "a", "b"])
    }

    @Test func aHeldTileThatDisappearedIsSkippedAndANewTileFillsItsPlace() {
        let sessions = [session("a", .working), session("new", .needsYou), session("c", .idle)]
        let held = [
            RemiBoardOrder.key(for: session("gone")): 0,
            RemiBoardOrder.key(for: sessions[0]): 1,
            RemiBoardOrder.key(for: sessions[2]): 2,
        ]
        #expect(order(sessions, held: held) == ["new", "a", "c"])
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

    @Test func aConnectedMachinesMissingSessionIsPruned() {
        let gone = RemiBoardOrder.key(for: session("gone", machine: "one"))
        let kept = RemiBoardOrder.key(for: session("kept", machine: "one"))
        var state = RemiBoardState()
        state.pin(gone, atSlot: 0)
        state.setSize(.large, for: gone)
        state.pin(kept, atSlot: 1)
        let changed = state.prune(live: [kept], connectedMachines: ["one"])
        #expect(changed)
        #expect(!state.isPinned(gone))
        #expect(state.size(for: gone) == .regular)
        #expect(state.isPinned(kept))
    }

    @Test func aDisconnectedMachinesEntriesStayWhileItsListIsMissing() {
        let away = RemiBoardOrder.key(for: session("away", machine: "two"))
        var state = RemiBoardState()
        state.pin(away, atSlot: 0)
        state.setSize(.large, for: away)
        let changed = state.prune(live: [], connectedMachines: ["one"])
        #expect(!changed)
        #expect(state.isPinned(away))
        #expect(state.size(for: away) == .large)
    }

    @Test func pruningNothingReportsNoChange() {
        var state = RemiBoardState()
        let changed = state.prune(live: [], connectedMachines: ["one"])
        #expect(!changed)
    }

    @Test func aKeyNamesItsMachine() {
        let key = RemiBoardOrder.key(for: session("s", machine: "box"))
        #expect(RemiBoardOrder.machineID(ofKey: key) == "box")
        #expect(RemiBoardOrder.machineID(ofKey: "no-separator") == "no-separator")
    }

    // MARK: writing

    @Test func aFocusedComposerMeansWriting() {
        #expect(RemiBoardOrder.isWriting(hasFocus: true, drafts: [:], composerKeys: []))
    }

    @Test func aDraftOnAShownTileMeansWriting() {
        #expect(RemiBoardOrder.isWriting(hasFocus: false, drafts: ["a": "hi"], composerKeys: ["a", "b"]))
    }

    @Test func aDraftOfATileNotOnScreenDoesNotFreezeTheBoard() {
        #expect(!RemiBoardOrder.isWriting(hasFocus: false, drafts: ["gone": "hi"], composerKeys: ["a"]))
    }

    @Test func emptyDraftsAreNotWriting() {
        #expect(!RemiBoardOrder.isWriting(hasFocus: false, drafts: ["a": ""], composerKeys: ["a"]))
    }

    @Test func heldSlotsFollowTheShownOrderEvenWithARepeatedKey() {
        #expect(RemiBoardOrder.held(from: ["a", "b", "a", "c"]) == ["a": 0, "b": 1, "c": 3])
        #expect(RemiBoardOrder.held(from: []).isEmpty)
    }

    // MARK: drag payload

    @Test func aDragPayloadRoundTripsToItsKey() {
        let key = RemiBoardOrder.key(for: session("s", machine: "m"))
        #expect(RemiBoardOrder.key(fromPayload: RemiBoardOrder.payload(for: key)) == key)
    }

    @Test func textThatIsNotATilePayloadIsRejected() {
        #expect(RemiBoardOrder.key(fromPayload: "just some selected text") == nil)
        #expect(RemiBoardOrder.key(fromPayload: "m\u{1F}s") == nil)
        #expect(RemiBoardOrder.key(fromPayload: "") == nil)
    }

    @Test func anEmptyKeyInAPayloadIsRejected() {
        #expect(RemiBoardOrder.key(fromPayload: RemiBoardOrder.payload(for: "")) == nil)
    }

    @Test func activityDatesReadWithAndWithoutFractionalSeconds() {
        #expect(RemiBoardOrder.activityDate("2026-10-28T10:00:00Z") == Date(timeIntervalSince1970: 1_793_181_600))
        #expect(RemiBoardOrder.activityDate("2026-10-28T10:00:00.500Z") == Date(timeIntervalSince1970: 1_793_181_600.5))
        #expect(RemiBoardOrder.activityDate("yesterday") == nil)
        #expect(RemiBoardOrder.activityDate(nil) == nil)
    }

    // MARK: next tile

    @Test func afterSendingFocusMovesToTheNextTileAndWrapsAround() {
        #expect(RemiBoardOrder.next(after: "a", in: ["a", "b", "c"]) == "b")
        #expect(RemiBoardOrder.next(after: "c", in: ["a", "b", "c"]) == "a")
        #expect(RemiBoardOrder.next(after: "a", in: ["a"]) == nil)
        #expect(RemiBoardOrder.next(after: "x", in: ["a", "b"]) == "a")
    }

    @Test func theNextTileComesFromTheOrderTheCallerGivesSoFinishedOnesCanBeLeftOut() {
        // The board passes only the live tiles; "done" is not in the list, so it is never next.
        #expect(RemiBoardOrder.next(after: "a", in: ["a", "c"]) == "c")
        #expect(RemiBoardOrder.next(after: "c", in: ["a", "c"]) == "a")
        // Sending from a tile that has since left the list goes to the first live tile.
        #expect(RemiBoardOrder.next(after: "done", in: ["a", "c"]) == "a")
    }

    @Test func tilesPackIntoTheShortestColumnInReadingOrder() {
        #expect(RemiBoardOrder.columns(heights: [100, 100, 100, 100], count: 2) == [[0, 2], [1, 3]])
        // A tall first tile leaves the other column to take the next three.
        #expect(RemiBoardOrder.columns(heights: [400, 100, 100, 100], count: 2) == [[0], [1, 2, 3]])
        #expect(RemiBoardOrder.columns(heights: [], count: 3) == [[], [], []])
        #expect(RemiBoardOrder.columns(heights: [1, 2], count: 0) == [[0, 1]])
    }

    // MARK: what the board shows

    private func live(_ id: String, _ status: RemiSessionStatus = .idle, machine: String = "m") -> RemiSessionSummary {
        RemiSessionSummary(
            id: id, machineID: machine, machineName: machine, name: id, harness: "claude", project: "p",
            status: status, isLive: status != .offline
        )
    }

    @Test func finishedSessionsStayOffTheBoardUnlessAsked() {
        let sessions = [live("a"), live("done", .offline), live("b", .working)]
        #expect(RemiBoardOrder.visible(sessions, machineID: nil, onlyNeedsYou: false, showFinished: false).map(\.id) == ["a", "b"])
        #expect(RemiBoardOrder.visible(sessions, machineID: nil, onlyNeedsYou: false, showFinished: true).map(\.id) == ["a", "done", "b"])
    }

    @Test func theFiltersNarrowTheBoard() {
        let sessions = [live("a", machine: "one"), live("b", .needsYou, machine: "two"), live("c", machine: "two")]
        #expect(RemiBoardOrder.visible(sessions, machineID: "two", onlyNeedsYou: false, showFinished: false).map(\.id) == ["b", "c"])
        #expect(RemiBoardOrder.visible(sessions, machineID: nil, onlyNeedsYou: true, showFinished: false).map(\.id) == ["b"])
        #expect(RemiBoardOrder.visible(sessions, machineID: "one", onlyNeedsYou: true, showFinished: false).isEmpty)
    }

    @Test func aTileShowsTheLatestEntriesItsSizeHasRoomFor() {
        let entries = (0..<30).map { RemiTranscriptEntry.agent(id: "e\($0)", text: "m\($0)") }
        #expect(RemiBoardOrder.feed(entries, size: .compact).count == RemiTileSize.compact.feedEntries)
        #expect(RemiBoardOrder.feed(entries, size: .large).first?.id == "e\(30 - RemiTileSize.large.feedEntries)")
        #expect(RemiBoardOrder.feed(entries, size: .large).last?.id == "e29")
        #expect(RemiBoardOrder.feed([], size: .regular).isEmpty)
    }

    @Test func aNegativeStoredSlotIsClampedAndNeverTraps() {
        let state = RemiBoardState(storage: "{\"pinnedSlots\":{\"k\":-3},\"sizes\":{}}")
        #expect(state.slot(of: "k") == 0)
        let sessions = [session("a"), session("b")]
        var hostile = RemiBoardState()
        hostile.pin("m\u{1F}b", atSlot: 0)
        #expect(RemiBoardOrder.arrange(sessions, state: hostile, interactions: [:], held: ["m\u{1F}a": -5], now: now).count == 2)
    }

    // MARK: Mac freeform layout

    @Test func aLegacyBoardKeepsItsPinsAndPresetHeightsWhenPlacedAutomatically() {
        let a = session("a")
        let b = session("b")
        let aKey = RemiBoardOrder.key(for: a)
        let bKey = RemiBoardOrder.key(for: b)
        let state = RemiBoardState(storage: "{\"pinnedSlots\":{\"m\\u001fb\":0},\"sizes\":{\"m\\u001fb\":\"large\"}}")
        let frames = RemiBoardOrder.layout([a, b], state: state, interactions: [:], now: now, viewportWidth: 350)

        #expect(state.slot(of: bKey) == 0)
        #expect(state.size(for: bKey) == .large)
        #expect(state.frame(for: aKey) == nil)
        #expect(frames[bKey]?.height == 640)
        #expect((frames[aKey]?.y ?? 0) >= (frames[bKey]?.maxY ?? 0))
        #expect(!state.storageValue.contains("\"frames\""))
    }

    @Test func malformedFramesAreIgnoredPerTileWithoutLosingLegacyState() {
        let storage = #"{"pinnedSlots":{"legacy":2},"sizes":{"legacy":"large"},"frames":{"valid":{"x":12,"y":18,"width":340,"height":260},"small":{"x":0,"y":0,"width":120,"height":260},"negative":{"x":-1,"y":0,"width":340,"height":260},"wrongType":{"x":"bad","y":0,"width":340,"height":260},"nonfinite":{"x":1e400,"y":0,"width":340,"height":260}}}"#
        let state = RemiBoardState(storage: storage)

        #expect(state.slot(of: "legacy") == 2)
        #expect(state.size(for: "legacy") == .large)
        #expect(state.frame(for: "valid") == RemiBoardFrame(x: 12, y: 18, width: 340, height: 260))
        #expect(state.frame(for: "small") == nil)
        #expect(state.frame(for: "negative") == nil)
        #expect(state.frame(for: "wrongType") == nil)
        #expect(state.frame(for: "nonfinite") == nil)
    }

    @Test func explicitFramesRoundTripAndOnlyValidFramesAreStored() {
        var state = RemiBoardState()
        let frame = RemiBoardFrame(x: 52, y: 88, width: 480, height: 360)

        let accepted = state.setFrame(frame, for: "tile")
        let rejected = state.setFrame(RemiBoardFrame(x: -1, y: 0, width: 340, height: 260), for: "bad")
        #expect(accepted)
        #expect(!rejected)
        #expect(RemiBoardState(storage: state.storageValue).frame(for: "tile") == frame)
        #expect(RemiBoardState(storage: state.storageValue).frame(for: "bad") == nil)
    }

    @Test func resizingClampsBothDimensionsAndMovesCannotCrossTheOrigin() {
        let frame = RemiBoardFrame(x: 0, y: 0, width: 340, height: 260)
        let smaller = frame.resized(by: CGSize(width: -5_000, height: -5_000))
        let larger = frame.resized(by: CGSize(width: 5_000, height: 5_000))

        #expect(smaller == frame)
        #expect(larger.width == RemiBoardFrame.maximumWidth)
        #expect(larger.height == RemiBoardFrame.maximumHeight)
        #expect(!frame.moved(by: CGSize(width: -1, height: 0)).isValid)
        #expect(!frame.moved(by: CGSize(width: 0, height: -1)).isValid)
        #expect(!RemiBoardFrame(x: 100_000, y: 0, width: 340, height: 260).isValid)
    }

    @Test func tilesWithTheSameSessionIdOnDifferentMachinesGetSeparateFrames() {
        let sessions = [session("same", machine: "one"), session("same", machine: "two")]
        let frames = RemiBoardOrder.layout(sessions, state: RemiBoardState(), interactions: [:], now: now, viewportWidth: 900)
        let firstKey = RemiBoardOrder.key(for: sessions[0])
        let secondKey = RemiBoardOrder.key(for: sessions[1])

        #expect(firstKey != secondKey)
        #expect(frames[firstKey] != nil)
        #expect(frames[secondKey] != nil)
        #expect(frames[firstKey] != frames[secondKey])
    }

    @Test func layoutPreventsOverlapAndTouchingFramesRemainValid() {
        let sessions = [session("a"), session("b"), session("c"), session("d")]
        var state = RemiBoardState()
        let firstFrameStored = state.setFrame(RemiBoardFrame(x: 16, y: 16, width: 520, height: 300), for: "m\u{1F}a")
        // A second valid saved frame overlaps the first. Layout keeps the first and places this
        // tile automatically, repairing the collision in the rendered board without dropping state.
        let secondFrameStored = state.setFrame(RemiBoardFrame(x: 200, y: 80, width: 420, height: 360), for: "m\u{1F}b")
        #expect(firstFrameStored)
        #expect(secondFrameStored)
        let frames = RemiBoardOrder.layout(sessions, state: state, interactions: [:], now: now, viewportWidth: 900)
        let placed = Array(frames.values)
        for left in placed.indices {
            for right in placed.indices where right > left {
                #expect(!placed[left].intersects(placed[right]))
            }
        }

        let touching = RemiBoardFrame(x: 356, y: 16, width: 340, height: 260)
        #expect(!RemiBoardFrame(x: 16, y: 16, width: 340, height: 260).intersects(touching))
    }

    @Test func hiddenAndDisconnectedFramesReserveSpaceForNewAndReturningSessions() {
        let returning = session("returning", machine: "one")
        let other = session("other", machine: "one")
        let key = RemiBoardOrder.key(for: returning)
        let stored = RemiBoardFrame(x: 700, y: 120, width: 460, height: 340)
        var state = RemiBoardState()
        let storedFrame = state.setFrame(stored, for: key)
        #expect(storedFrame)

        let before = RemiBoardOrder.layout([returning, other], state: state, interactions: [:], now: now, viewportWidth: 700)
        let newSession = session("new", machine: "one")
        let withNew = RemiBoardOrder.layout([returning, other, newSession], state: state, interactions: [:], now: now, viewportWidth: 700)
        #expect(withNew[key] == stored)
        #expect(withNew[RemiBoardOrder.key(for: newSession)] != nil)
        #expect(!withNew[RemiBoardOrder.key(for: newSession)]!.intersects(stored))

        // A filter hides the tile at render time, while the full layout still contains its frame.
        let filtered = RemiBoardOrder.visible([returning, other, newSession], machineID: "one", onlyNeedsYou: true, showFinished: false)
        #expect(filtered.isEmpty)
        let afterFilter = RemiBoardOrder.layout([returning, other, newSession], state: state, interactions: [:], now: now, viewportWidth: 500)
        #expect(afterFilter[key] == withNew[key])

        let preservedWhileDisconnected = state.prune(live: [RemiBoardOrder.key(for: other)], connectedMachines: [])
        #expect(!preservedWhileDisconnected)
        #expect(state.frame(for: key) == stored)
        let reconnected = RemiBoardOrder.layout([returning, other], state: state, interactions: [:], now: now, viewportWidth: 500)
        #expect(reconnected[key] == before[key])
    }

    @Test func narrowViewportsDoNotChangeSavedPositionsAndCanvasIncludesVisibleBounds() {
        let tile = session("saved")
        let key = RemiBoardOrder.key(for: tile)
        let frame = RemiBoardFrame(x: 1_400, y: 1_100, width: 500, height: 400)
        var state = RemiBoardState()
        let storedFrame = state.setFrame(frame, for: key)
        #expect(storedFrame)
        let wide = RemiBoardOrder.layout([tile], state: state, interactions: [:], now: now, viewportWidth: 1_600)
        let narrow = RemiBoardOrder.layout([tile], state: state, interactions: [:], now: now, viewportWidth: 500)
        let canvas = RemiBoardOrder.canvasSize(visibleFrames: [key: frame], viewport: CGSize(width: 500, height: 300))

        #expect(wide[key] == frame)
        #expect(narrow[key] == frame)
        #expect(canvas.width >= frame.maxX + 16)
        #expect(canvas.height >= frame.maxY + 16)
    }

    @Test func resetRestoresAutomaticLayoutAndPruningIncludesFrames() {
        let gone = RemiBoardOrder.key(for: session("gone", machine: "one"))
        var state = RemiBoardState()
        state.pin(gone, atSlot: 1)
        state.setSize(.large, for: gone)
        let storedGoneFrame = state.setFrame(RemiBoardFrame(x: 100, y: 100, width: 400, height: 400), for: gone)
        let pruned = state.prune(live: [], connectedMachines: ["one"])
        #expect(storedGoneFrame)
        #expect(pruned)
        #expect(state.frame(for: gone) == nil)

        state.pin("manual", atSlot: 0)
        state.setSize(.large, for: "manual")
        let storedManualFrame = state.setFrame(RemiBoardFrame(x: 100, y: 100, width: 400, height: 400), for: "manual")
        #expect(storedManualFrame)
        state.resetLayout()
        #expect(state.pinnedKeys.isEmpty)
        #expect(state.size(for: "manual") == .regular)
        #expect(state.frame(for: "manual") == nil)
    }

    // MARK: phone density

    @Test func aRowIsTheCompactPhoneDensityAndShowsNoFeedOrComposer() {
        #expect(RemiTileSize.row.estimatedHeight < RemiTileSize.compact.estimatedHeight)
        #expect(!RemiTileSize.row.showsComposer)
        #expect(!RemiTileSize.row.showsFeed)
        for size in [RemiTileSize.compact, .regular, .large] {
            #expect(size.showsComposer)
            #expect(size.showsFeed)
        }
    }

    @Test func thePhoneOffersCompactMediumAndLong() {
        #expect(RemiTileSize.phoneDensities == [.row, .regular, .large])
        #expect(RemiTileSize.phoneDensities.map(\.densityTitle) == ["Compact", "Medium", "Long"])
        #expect(RemiTileSize(storedDensity: "nonsense") == .regular)
        #expect(RemiTileSize(storedDensity: RemiTileSize.large.rawValue) == .large)
    }

    @Test func aSavedDensityTheMacOnlyOffersFallsBackToMedium() {
        for stored in ["row", "regular", "large"] {
            #expect(RemiTileSize.phoneDensity(stored: stored) == RemiTileSize(rawValue: stored))
        }
        #expect(RemiTileSize.phoneDensity(stored: "compact") == .regular)
        #expect(RemiTileSize.phoneDensity(stored: "nonsense") == .regular)
        #expect(RemiTileSize.phoneDensity(stored: "") == .regular)
    }

    @Test func aStoredSizeSurvivesAnOlderBoardWithoutRows() {
        // A board saved before `row` existed still decodes.
        #expect(RemiBoardState(storage: "{\"pinnedSlots\":{\"k\":1},\"sizes\":{\"k\":\"large\"}}").size(for: "k") == .large)
    }

    @Test func unsentDraftsOfAMachineThatIsNotSettledAreKept() {
        let a = RemiBoardOrder.key(for: session("a", machine: "one"))
        let b = RemiBoardOrder.key(for: session("b", machine: "two"))
        let gone = RemiBoardOrder.key(for: session("gone", machine: "one"))
        let drafts = [a: "keep", b: "keep too", gone: "lost"]
        // Machine one is settled and no longer lists "gone": its draft goes. Machine two is not
        // settled, so its sessions missing from a reconnecting list keep their drafts.
        let kept = RemiBoardOrder.keeping(drafts, live: [a], settledMachines: ["one"])
        #expect(kept == [a: "keep", b: "keep too"])
        #expect(RemiBoardOrder.keeping(drafts, live: [a, b, gone], settledMachines: ["one", "two"]) == drafts)
        #expect(RemiBoardOrder.keeping(drafts, live: [], settledMachines: []) == drafts)
    }
}
