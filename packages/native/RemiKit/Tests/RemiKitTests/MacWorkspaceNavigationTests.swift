import SwiftUI
import Testing
import RemiKit
@testable import RemiUI

@Suite struct MacWorkspaceNavigationTests {
    @Test func machineToggleMovesBetweenThreeAndTwoColumns() {
        let all = RemiMacColumnLayout(visibility: .all, expandedVisibility: .all)
        let twoColumns = all.togglingMachines()

        #expect(twoColumns.visibility == .doubleColumn)
        #expect(twoColumns.expandedVisibility == .doubleColumn)
        #expect(twoColumns.togglingMachines() == all)
    }

    @Test func navigationToggleRestoresTheLastExpandedLayout() {
        let expanded = RemiMacColumnLayout(
            visibility: .doubleColumn,
            expandedVisibility: .doubleColumn
        )
        let focused = expanded.togglingNavigation()

        #expect(focused.visibility == .detailOnly)
        #expect(focused.expandedVisibility == .doubleColumn)
        #expect(focused.togglingNavigation() == expanded)
    }

    @Test func machineToggleFromFocusedConversationRestoresAllColumns() {
        let focused = RemiMacColumnLayout(
            visibility: .detailOnly,
            expandedVisibility: .doubleColumn
        )

        #expect(focused.togglingMachines() == RemiMacColumnLayout(
            visibility: .all,
            expandedVisibility: .all
        ))
    }

    @Test func orderedSelectionWrapsAndHandlesMissingSelection() {
        let ids = ["one", "two", "three"]

        #expect(RemiOrderedSelection.shifted(selection: "one", orderedIDs: ids, offset: -1) == "three")
        #expect(RemiOrderedSelection.shifted(selection: "three", orderedIDs: ids, offset: 1) == "one")
        #expect(RemiOrderedSelection.shifted(selection: nil, orderedIDs: ids, offset: 1) == "one")
        #expect(RemiOrderedSelection.shifted(selection: "missing", orderedIDs: ids, offset: -1) == "three")
        #expect(RemiOrderedSelection.shifted(selection: "one", orderedIDs: ids, offset: -7) == "three")
        #expect(RemiOrderedSelection.shifted(selection: "two", orderedIDs: ids, offset: 0) == "two")
        #expect(RemiOrderedSelection.shifted(selection: nil, orderedIDs: ids, offset: 0) == "one")
    }

    @Test func orderedSelectionReturnsNilForAnEmptyCollection() {
        #expect(RemiOrderedSelection.shifted(
            selection: "missing",
            orderedIDs: [String](),
            offset: 1
        ) == nil)
    }

    @Test func sessionScopesSeparateAttentionLiveAndStoredWork() {
        let sessions = triageSessions

        #expect(RemiSessionScope.all.count(in: sessions) == 4)
        #expect(RemiSessionScope.needsYou.count(in: sessions) == 1)
        #expect(RemiSessionScope.live.count(in: sessions) == 3)
        #expect(RemiSessionScope.stored.count(in: sessions) == 1)
    }

    @Test func triageCombinesScopeAndSearchAcrossUsefulMetadata() {
        let sessions = triageSessions

        #expect(RemiSessionTriage.filtered(sessions: sessions, scope: .live, query: "remi").map(\.id) == ["waiting", "working"])
        #expect(RemiSessionTriage.filtered(sessions: sessions, scope: .all, query: "codex").map(\.id) == ["idle"])
        #expect(RemiSessionTriage.filtered(sessions: sessions, scope: .stored, query: "review later").map(\.id) == ["stored"])
        #expect(RemiSessionTriage.filtered(sessions: sessions, scope: .needsYou, query: "  ").map(\.id) == ["waiting"])
    }

    @Test func triagePreservesVisibleSelectionAndFallsBackDeterministically() {
        #expect(RemiSessionTriage.reconciledSelection(selection: "working", visibleSessionIDs: ["waiting", "working"]) == "working")
        #expect(RemiSessionTriage.reconciledSelection(selection: "stored", visibleSessionIDs: ["waiting", "working"]) == "waiting")
        #expect(RemiSessionTriage.reconciledSelection(selection: "stored", visibleSessionIDs: []) == nil)
    }

    @Test func attentionNavigationWrapsAndIgnoresOtherStatuses() {
        var sessions = triageSessions
        sessions.append(session(id: "waiting-two", status: .needsYou))

        #expect(RemiSessionTriage.nextAttentionSessionID(selection: "waiting", sessions: sessions) == "waiting-two")
        #expect(RemiSessionTriage.nextAttentionSessionID(selection: "waiting-two", sessions: sessions) == "waiting")
        #expect(RemiSessionTriage.nextAttentionSessionID(selection: "working", sessions: sessions) == "waiting")
    }

    @Test func compactDestinationFollowsTheDeepestValidSelection() {
        #expect(RemiMacCompactDestination.resolve(hasMachine: false, hasSession: false) == .machines)
        #expect(RemiMacCompactDestination.resolve(hasMachine: true, hasSession: false) == .sessions)
        #expect(RemiMacCompactDestination.resolve(hasMachine: true, hasSession: true) == .conversation)
        #expect(RemiMacCompactDestination.conversation.column == .detail)
    }

    @Test func needsYouAvailabilityDistinguishesEmptyOfflineAndPartialStates() {
        var connected = MachineState(
            endpoint: MachineEndpoint(host: "one.example", port: 18765),
            displayName: "One"
        )
        connected.status = .connected
        let offline = MachineState(
            endpoint: MachineEndpoint(host: "two.example", port: 18765),
            displayName: "Two"
        )

        #expect(RemiNeedsYouAvailability.resolve(machines: []) == .unconfigured)
        #expect(RemiNeedsYouAvailability.resolve(machines: [offline]) == .offline(total: 1))
        #expect(
            RemiNeedsYouAvailability.resolve(machines: [connected, offline])
                == .partiallyConnected(connected: 1, total: 2)
        )
        #expect(RemiNeedsYouAvailability.resolve(machines: [connected]) == .connected(total: 1))
    }

    private var triageSessions: [RemiSessionSummary] {
        [
            session(id: "waiting", status: .needsYou, project: "remi"),
            session(id: "working", status: .working, project: "remi"),
            session(id: "idle", status: .idle, harness: "codex"),
            session(id: "stored", status: .offline, lastMessage: "Review later", isLive: false),
        ]
    }

    private func session(
        id: String,
        status: RemiSessionStatus,
        project: String = "transit",
        harness: String = "claude",
        lastMessage: String? = nil,
        isLive: Bool = true
    ) -> RemiSessionSummary {
        RemiSessionSummary(
            id: id,
            machineName: "Studio",
            name: id.capitalized,
            harness: harness,
            project: project,
            projectPath: "/Projects/\(project)",
            status: status,
            lastMessage: lastMessage,
            isLive: isLive
        )
    }
}
