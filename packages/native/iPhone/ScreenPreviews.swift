#if DEBUG
import RemiKit
import RemiUI
import SwiftUI

private struct HomePreview: View {
    let questions: [RemiQuestionCardModel]
    let sessions: [RemiSessionSummary]
    let machines: [RemiMachineSummary]
    var machineStates: [MachineState] = []

    var body: some View {
        NavigationStack {
            HomeScreen(
                questions: questions,
                sessions: sessions,
                machines: machines,
                sessionMachines: machineStates
            )
        }
    }
}

private var unavailableDirectState: MachineState {
    var machine = MachineState(
        endpoint: MachineEndpoint(host: "192.168.1.42", port: 18_765),
        displayName: "Studio Mac"
    )
    machine.status = .unavailable(reason: "The connection was refused.")
    return machine
}

private var unavailableDirectSummary: RemiMachineSummary {
    RemiMachineSummary(
        id: unavailableDirectState.id,
        name: unavailableDirectState.displayName,
        address: unavailableDirectState.endpoint.displayAddress,
        reachability: .unreachable,
        transport: .direct,
        sessionCount: 0
    )
}

private struct SessionPreview: View {
    var initialConversationID: String? = nil
    var initialQuestionID: String? = nil

    var body: some View {
        NavigationStack {
            SessionScreen(
                session: RemiPreviewData.primarySession,
                transcript: RemiPreviewData.transcript,
                questions: [RemiPreviewData.binaryQuestion],
                views: [
                    SessionViewMeta(agentId: "explore", agentType: "Explore", active: true),
                    SessionViewMeta(agentId: "review", agentType: "code-reviewer", active: false),
                ],
                initialConversationID: initialConversationID,
                initialQuestionID: initialQuestionID,
                transcriptForView: { _ in RemiPreviewData.transcript }
            )
        }
    }
}

private struct ShellPreview: View {
    @State private var state: PhoneShellState
    let machines: [RemiMachineSummary]
    let sessions: [RemiSessionSummary]
    let initialQuery: String

    init(
        isDrawerOpen: Bool,
        machines: [RemiMachineSummary] = RemiPreviewData.machines,
        sessions: [RemiSessionSummary] = RemiPreviewData.sessions,
        filter: PhoneDrawerFilter = .all,
        initialQuery: String = ""
    ) {
        let route = PhoneSessionRoute(
            machineKey: RemiPreviewData.primarySession.machineID,
            sessionID: RemiPreviewData.primarySession.id
        )
        self.machines = machines
        self.sessions = sessions
        self.initialQuery = initialQuery
        _state = State(initialValue: PhoneShellState(
            destination: .session(route),
            isDrawerOpen: isDrawerOpen,
            drawerFilter: filter
        ))
    }

    var body: some View {
        PhoneShell(state: $state) {
            SessionPreview()
        } drawer: {
            PhoneDrawerView(
                sessions: sessions,
                machines: machines,
                filter: state.drawerFilter,
                initialQuery: initialQuery,
                questionCount: 1,
                destination: state.destination,
                canCreateSession: true,
                onClose: { state.closeDrawer() },
                onSelectAllMachines: { state.clearFilter() },
                onSelectMachine: { state.selectMachineFilter($0) },
                onSelectInbox: { state.select(.inbox) },
                onSelectSession: { state.select(.session(PhoneSessionRoute(machineKey: $0.machineID, sessionID: $0.id))) },
                onNewSession: {},
                onAddMachine: {},
                onPreferences: {}
            )
        }
    }
}

/// Machines for the drawer previews, in the shapes `MachineStore` produces. The first is
/// the preview data's Studio; the others are connected unless a state is given.
private func drawerMachines(_ count: Int, states: [Int: RemiMachineReachability] = [:]) -> [RemiMachineSummary] {
    let names = ["Studio", "Laptop", "Mac mini", "Office iMac", "Build server", "Home server"]
    return (0..<count).map { index in
        RemiMachineSummary(
            id: index == 0 ? "studio" : "machine-\(index)",
            name: names[index],
            address: index == 0 ? "127.0.0.1:18765" : "100.72.14.\(index):18765",
            reachability: states[index] ?? .connected,
            transport: index == 0 ? .local : .direct,
            sessionCount: 1,
            openQuestionCount: index == 0 ? 1 : 0
        )
    }
}

/// One session per machine, plus the preview data's sessions on Studio.
private func drawerSessions(on machines: [RemiMachineSummary]) -> [RemiSessionSummary] {
    let others = machines.dropFirst().map { machine in
        RemiSessionSummary(
            id: "session-\(machine.id)",
            machineID: machine.id,
            machineName: machine.name,
            name: "Work on \(machine.name)",
            harness: "Claude",
            project: "remi",
            lastActivity: "2026-10-21T09:00:00Z",
            status: .working,
            lastMessage: "Running the test suite"
        )
    }
    return RemiPreviewData.sessions + others
}

private struct PairingPreview: View {
    var draft = AddMachineDraft()

    var body: some View {
        NavigationStack { PairingScreen(draft: draft) }
    }
}

@MainActor private var rejectedRelayDraft: AddMachineDraft {
    struct Rejected: Error {}
    let draft = AddMachineDraft { _ in throw Rejected() }
    draft.mode = .relay
    draft.relayToken = "expired-token"
    _ = draft.makeEndpoint()
    return draft
}

private struct FirstRunPreview: View {
    var body: some View {
        NavigationStack { FirstRunScreen() }
    }
}

private struct EmptyHomePreview: View {
    var body: some View {
        HomePreview(questions: [], sessions: [], machines: RemiPreviewData.machines)
    }
}

#Preview("Home · Light") { HomePreview(questions: [RemiPreviewData.binaryQuestion], sessions: RemiPreviewData.sessions, machines: RemiPreviewData.machines).preferredColorScheme(.light) }
#Preview("Home · Dark") { HomePreview(questions: [RemiPreviewData.binaryQuestion], sessions: RemiPreviewData.sessions, machines: RemiPreviewData.machines).preferredColorScheme(.dark) }
#Preview("Home · Accessibility") { HomePreview(questions: [RemiPreviewData.binaryQuestion], sessions: RemiPreviewData.sessions, machines: RemiPreviewData.machines).environment(\.dynamicTypeSize, .accessibility5) }
#Preview("Home · Compact") { HomePreview(questions: RemiPreviewData.questionStates, sessions: RemiPreviewData.sessions, machines: RemiPreviewData.machines).frame(width: 320) }
#Preview("Home · Stored session") { HomePreview(questions: [], sessions: Array(RemiPreviewData.sessions.suffix(1)), machines: Array(RemiPreviewData.machines.prefix(1))).preferredColorScheme(.light) }
#Preview("Home · Attention queue") { HomePreview(questions: RemiPreviewData.questionStates, sessions: RemiPreviewData.sessions, machines: RemiPreviewData.machines).preferredColorScheme(.light) }
#Preview("Home · Direct Recovery") {
    HomePreview(
        questions: [],
        sessions: [],
        machines: [unavailableDirectSummary],
        machineStates: [unavailableDirectState]
    )
}
#Preview("Home · Direct Recovery · Accessibility") {
    HomePreview(
        questions: [],
        sessions: [],
        machines: [unavailableDirectSummary],
        machineStates: [unavailableDirectState]
    )
    .environment(\.dynamicTypeSize, .accessibility5)
}

#Preview("Session · Light") { SessionPreview().preferredColorScheme(.light) }
#Preview("Session · Dark") { SessionPreview().preferredColorScheme(.dark) }
#Preview("Session · Accessibility") { SessionPreview().environment(\.dynamicTypeSize, .accessibility5) }
#Preview("Session · Notification focus") {
    SessionPreview(initialQuestionID: RemiPreviewData.binaryQuestion.questionID)
}
#Preview("Session · Subagent question focus") {
    SessionPreview(
        initialConversationID: "explore",
        initialQuestionID: RemiPreviewData.binaryQuestion.questionID
    )
}

#Preview("Shell · Drawer closed") { ShellPreview(isDrawerOpen: false) }
#Preview("Shell · Drawer open · Light") { ShellPreview(isDrawerOpen: true).preferredColorScheme(.light) }
#Preview("Shell · Drawer open · Dark") { ShellPreview(isDrawerOpen: true).preferredColorScheme(.dark) }
#Preview("Shell · Drawer open · Accessibility") { ShellPreview(isDrawerOpen: true).environment(\.dynamicTypeSize, .accessibility5) }

#Preview("Drawer · 1 machine") {
    ShellPreview(isDrawerOpen: true, machines: drawerMachines(1), sessions: RemiPreviewData.sessions)
}
#Preview("Drawer · 3 machines") {
    let machines = drawerMachines(3)
    return ShellPreview(isDrawerOpen: true, machines: machines, sessions: drawerSessions(on: machines))
}
#Preview("Drawer · 3 machines · Filtered") {
    let machines = drawerMachines(3)
    return ShellPreview(isDrawerOpen: true, machines: machines, sessions: drawerSessions(on: machines), filter: .machine("machine-1"))
}
#Preview("Drawer · 6 machines") {
    let machines = drawerMachines(6)
    return ShellPreview(isDrawerOpen: true, machines: machines, sessions: drawerSessions(on: machines))
}
#Preview("Drawer · Offline and approval") {
    let machines = drawerMachines(3, states: [1: .unreachable, 2: .waitingForApproval])
    return ShellPreview(isDrawerOpen: true, machines: machines, sessions: drawerSessions(on: machines))
}
#Preview("Drawer · Search, no results") {
    let machines = drawerMachines(3)
    return ShellPreview(isDrawerOpen: true, machines: machines, sessions: drawerSessions(on: machines), initialQuery: "no such session")
}
#Preview("Drawer · 3 machines · Accessibility") {
    let machines = drawerMachines(3)
    return ShellPreview(isDrawerOpen: true, machines: machines, sessions: drawerSessions(on: machines))
        .environment(\.dynamicTypeSize, .accessibility5)
}
#Preview("Drawer · 3 machines · Dark") {
    let machines = drawerMachines(3)
    return ShellPreview(isDrawerOpen: true, machines: machines, sessions: drawerSessions(on: machines))
        .preferredColorScheme(.dark)
}

#Preview("Pairing · Light") { PairingPreview().preferredColorScheme(.light) }
#Preview("Pairing · Dark") { PairingPreview().preferredColorScheme(.dark) }
#Preview("Pairing · Accessibility") { PairingPreview().environment(\.dynamicTypeSize, .accessibility5) }
#Preview("Pairing · Relay error") { PairingPreview(draft: rejectedRelayDraft) }

#Preview("First Run · Light") { FirstRunPreview().preferredColorScheme(.light) }
#Preview("First Run · Dark") { FirstRunPreview().preferredColorScheme(.dark) }
#Preview("First Run · Accessibility") { FirstRunPreview().environment(\.dynamicTypeSize, .accessibility5) }

#Preview("Empty · Light") { EmptyHomePreview().preferredColorScheme(.light) }
#Preview("Empty · Dark") { EmptyHomePreview().preferredColorScheme(.dark) }
#Preview("Empty · Accessibility") { EmptyHomePreview().environment(\.dynamicTypeSize, .accessibility5) }
#endif
