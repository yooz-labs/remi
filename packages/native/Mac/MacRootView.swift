import RemiUI
import SwiftUI

struct MacRootView: View {
    @State private var selectedMachineID: String? = MacPreviewData.machines.first?.id
    @State private var selectedSessionID: String? = RemiPreviewData.primarySession.id
    @State private var showingNewSession = false

    let machines: [MacMachine]
    let sessions: [RemiSessionSummary]

    init(machines: [MacMachine] = MacPreviewData.machines, sessions: [RemiSessionSummary] = RemiPreviewData.sessions) {
        self.machines = machines
        self.sessions = sessions
    }

    var body: some View {
        if machines.isEmpty {
            MacFirstRunView()
        } else {
            NavigationSplitView {
                MachineSidebar(machines: machines, selectedMachineID: $selectedMachineID)
                    .navigationTitle("Remi")
            } content: {
                SessionColumn(sessions: sessions, selectedSessionID: $selectedSessionID)
                    .navigationTitle("Sessions")
                    .toolbar {
                        Button {
                            showingNewSession = true
                        } label: {
                            Label("New session", systemImage: "plus")
                        }
                    }
            } detail: {
                if let selectedSession = sessions.first(where: { $0.id == selectedSessionID }) {
                    MacSessionDetail(
                        session: selectedSession,
                        transcript: RemiPreviewData.transcript,
                        questions: selectedSession.status == .needsYou ? [RemiPreviewData.binaryQuestion] : []
                    )
                } else {
                    ContentUnavailableView("Select a session", systemImage: "bubble.left.and.bubble.right")
                }
            }
            .sheet(isPresented: $showingNewSession) {
                NewSessionSheet(machines: machines)
            }
        }
    }
}

struct MacFirstRunView: View {
    var body: some View {
        ContentUnavailableView {
            Label("Add your first machine", systemImage: "desktopcomputer.and.macbook")
        } description: {
            Text("Connect Remi to a hub to see its repositories, sessions, and questions in one window.")
        } actions: {
            Text("Machine connection arrives with RemiKit core in M2.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(minWidth: 700, minHeight: 500)
    }
}

#Preview("Mac Window") {
    MacRootView()
        .frame(width: 1180, height: 720)
}

#Preview("Mac Window · Unreachable") {
    MacRootView(machines: MacPreviewData.unreachableMachines, sessions: RemiPreviewData.sessions)
        .frame(width: 1180, height: 720)
}

#Preview("Mac First Run") {
    MacFirstRunView()
}

private struct MachineSidebar: View {
    let machines: [MacMachine]
    @Binding var selectedMachineID: String?

    var body: some View {
        List(selection: $selectedMachineID) {
            ForEach(machines) { machine in
                Section {
                    ForEach(machine.repositories, id: \.self) { repository in
                        Label(repository, systemImage: "folder")
                            .tag(machine.id)
                    }
                } header: {
                    MachineHeader(machine: machine)
                        .tag(machine.id)
                }
            }
        }
        .listStyle(.sidebar)
    }
}

private struct MachineHeader: View {
    let machine: MacMachine

    var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.xxxs) {
            HStack {
                Circle().fill(machine.reachability == .waitingForApproval ? RemiTheme.Color.attention : Color.secondary).frame(width: 7, height: 7)
                Text(machine.name).font(.headline)
            }
            Text(reachabilityText).font(.caption).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    private var reachabilityText: LocalizedStringKey {
        switch machine.reachability {
        case .connected: "Connected"
        case .connecting: "Connecting"
        case .unreachable: "Unreachable"
        case .waitingForApproval: "Waiting for approval"
        }
    }
}

private struct SessionColumn: View {
    let sessions: [RemiSessionSummary]
    @Binding var selectedSessionID: String?

    var body: some View {
        List(sessions, selection: $selectedSessionID) { session in
            RemiSessionRow(session: session)
                .tag(session.id)
        }
    }
}
