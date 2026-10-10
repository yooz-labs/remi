import RemiKit
import RemiUI
import SwiftUI

struct PhoneNewSessionSheet: View {
    @Environment(\.dismiss) private var dismiss

    let machines: [MachineState]
    let recentRepositories: [String: [RecentRepository]]
    let onCreate: (MachineEndpoint, String, String, [String], WorkspaceRequest?) -> Void

    @State private var machineID: String
    @State private var repository = ""
    @State private var harness = "claude"
    @State private var model = ""
    @State private var createsWorktree = false
    @State private var branch = ""
    @State private var base = ""

    init(
        machines: [MachineState],
        recentRepositories: [String: [RecentRepository]],
        onCreate: @escaping (MachineEndpoint, String, String, [String], WorkspaceRequest?) -> Void
    ) {
        self.machines = machines
        self.recentRepositories = recentRepositories
        self.onCreate = onCreate
        _machineID = State(initialValue: machines.first?.id ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Machine", selection: $machineID) {
                        ForEach(machines) { machine in
                            Text(machine.displayName).tag(machine.id)
                        }
                    }
                    .onChange(of: machineID) { _, _ in
                        selectDefaultsForMachine(resetRepository: true)
                    }
                } header: {
                    Label("Machine", systemImage: "desktopcomputer")
                } footer: {
                    Text("The selected machine provides the available repositories, harnesses, and workspace features.")
                }

                Section {
                    if !repositories.isEmpty {
                        Picker("Recent", selection: $repository) {
                            Text("Choose a repository").tag("")
                            ForEach(repositories) { item in
                                VStack(alignment: .leading) {
                                    Text(item.name)
                                    Text(item.repository).font(.caption).foregroundStyle(.secondary)
                                }
                                .tag(item.repository)
                            }
                        }
                    }

                    if workspaceCapable {
                        TextField("Repository path", text: $repository)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    } else {
                        TextField("Existing directory", text: $repository)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                } header: {
                    if workspaceCapable {
                        Label("Repository", systemImage: "folder")
                    } else {
                        Label("Directory", systemImage: "folder")
                    }
                } footer: {
                    if workspaceCapable {
                        Text("Use an absolute path or a path under ~ on this machine.")
                    } else {
                        Text("This machine does not support workspaces yet, so Remi will start in this existing directory.")
                    }
                }

                if workspaceCapable {
                    Section {
                        Toggle("Create a new branch and worktree", isOn: $createsWorktree)
                        if createsWorktree {
                            TextField("Branch name", text: $branch)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                            TextField("Base (optional)", text: $base)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                        }
                    } header: {
                        Label("Workspace", systemImage: "arrow.triangle.branch")
                    } footer: {
                        if createsWorktree {
                            Text("The machine creates a separate worktree next to the repository. Remi does not delete it when the session ends.")
                        } else {
                            Text("The session starts in the repository’s main worktree.")
                        }
                    }
                }

                Section {
                    Picker("Harness", selection: $harness) {
                        ForEach(harnesses, id: \.self) { value in
                            Text(Self.harnessName(value)).tag(value)
                        }
                    }

                    TextField("Model (optional)", text: $model)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Label("Agent", systemImage: "sparkles")
                } footer: {
                    Text("Leave this empty to use the harness default configured on the machine.")
                }
            }
            .navigationTitle("New session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { create() }
                        .disabled(!canCreate)
                }
            }
            .onAppear { selectDefaultsForMachine(resetRepository: repository.isEmpty) }
        }
    }

    private var selectedMachine: MachineState? {
        machines.first { $0.id == machineID }
    }

    private var workspaceCapable: Bool {
        selectedMachine?.capabilities.contains("workspaces") == true
    }

    private var repositories: [RecentRepository] {
        recentRepositories[machineID] ?? []
    }

    private var harnesses: [String] {
        let offered = selectedMachine?.harnesses ?? ["claude"]
        return offered.isEmpty ? ["claude"] : offered
    }

    private var trimmedRepository: String {
        repository.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canCreate: Bool {
        guard selectedMachine != nil, !trimmedRepository.isEmpty else { return false }
        return !createsWorktree || !branch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func selectDefaultsForMachine(resetRepository: Bool) {
        if !harnesses.contains(harness) {
            harness = harnesses[0]
        }
        if resetRepository {
            repository = repositories.first?.repository ?? ""
        }
        if !workspaceCapable {
            createsWorktree = false
        }
    }

    private func create() {
        guard let selectedMachine, canCreate else { return }
        let workspace: WorkspaceRequest?
        if workspaceCapable {
            let worktree = createsWorktree
                ? WorktreeRequest(
                    branch: branch.trimmingCharacters(in: .whitespacesAndNewlines),
                    base: base.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
                )
                : nil
            workspace = WorkspaceRequest(repository: trimmedRepository, worktree: worktree)
        } else {
            workspace = nil
        }
        let args = HarnessLaunchArguments.model(model)
        onCreate(selectedMachine.endpoint, trimmedRepository, harness, args, workspace)
        dismiss()
    }

    private static func harnessName(_ harness: String) -> String {
        switch harness {
        case "claude": "Claude Code"
        case "codex": "Codex"
        default: harness.capitalized
        }
    }
}

#if DEBUG
private var newSessionPreviewMachine: MachineState {
    var machine = MachineState(
        endpoint: MachineEndpoint(host: "studio.local", port: 18765),
        displayName: "Studio"
    )
    machine.status = .connected
    machine.capabilities = ["workspaces"]
    machine.harnesses = ["claude", "codex"]
    return machine
}

#Preview("New session") {
    PhoneNewSessionSheet(
        machines: [newSessionPreviewMachine],
        recentRepositories: [
            newSessionPreviewMachine.id: [
                RecentRepository(
                    repository: "/Users/yahya/Projects/remi",
                    name: "remi",
                    lastUsedAt: "2026-10-08T20:00:00.000Z"
                )
            ]
        ],
        onCreate: { _, _, _, _, _ in }
    )
}
#endif

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
