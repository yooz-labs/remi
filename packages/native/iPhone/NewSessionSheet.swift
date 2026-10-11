import RemiKit
import RemiUI
import SwiftUI

struct PhoneNewSessionSheet: View {
    @Environment(\.dismiss) private var dismiss

    let machines: [MachineState]
    let recentRepositories: [String: [RecentRepository]]
    let onCreate: (MachineEndpoint, String, String, [String], WorkspaceRequest?) -> Void

    @State private var draft: NewSessionDraft

    init(
        machines: [MachineState],
        recentRepositories: [String: [RecentRepository]],
        onCreate: @escaping (MachineEndpoint, String, String, [String], WorkspaceRequest?) -> Void
    ) {
        self.machines = machines
        self.recentRepositories = recentRepositories
        self.onCreate = onCreate
        _draft = State(initialValue: NewSessionDraft(
            machines: machines,
            recentRepositoriesByMachine: recentRepositories
        ))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Machine", selection: $draft.machineID) {
                        ForEach(machines) { machine in
                            Text(machine.displayName).tag(machine.id)
                        }
                    }
                } header: {
                    Label("Machine", systemImage: "desktopcomputer")
                } footer: {
                    Text("The selected machine provides the available repositories, harnesses, and workspace features.")
                }

                Section {
                    if !draft.recentRepositories.isEmpty {
                        Picker("Recent repository", selection: $draft.repository) {
                            Text("Choose a repository").tag("")
                            ForEach(draft.recentRepositories) { item in
                                VStack(alignment: .leading) {
                                    Text(item.name)
                                    Text(item.repository).font(.caption).foregroundStyle(.secondary)
                                }
                                .tag(item.repository)
                            }
                        }
                    }

                    if draft.workspaceCapable {
                        TextField("Repository path", text: $draft.repository)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    } else {
                        TextField("Existing directory", text: $draft.repository)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                } header: {
                    if draft.workspaceCapable {
                        Label("Repository", systemImage: "folder")
                    } else {
                        Label("Directory", systemImage: "folder")
                    }
                } footer: {
                    if draft.workspaceCapable {
                        Text("Use an absolute path or a path under ~ on this machine.")
                    } else {
                        Text("This machine does not support workspaces yet, so Remi will start in this existing directory.")
                    }
                }

                if draft.workspaceCapable {
                    Section {
                        Toggle("Create a new branch and worktree", isOn: $draft.createsWorktree)
                        if draft.createsWorktree {
                            TextField("Branch name", text: $draft.branch)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                            TextField("Base (optional)", text: $draft.base)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                        }
                    } header: {
                        Label("Workspace", systemImage: "arrow.triangle.branch")
                    } footer: {
                        if draft.createsWorktree {
                            Text("The machine creates a separate worktree next to the repository. Remi does not delete it when the session ends.")
                        } else {
                            Text("The session starts in the repository’s main worktree.")
                        }
                    }
                }

                Section {
                    Picker("Harness", selection: $draft.harness) {
                        ForEach(draft.availableHarnesses, id: \.self) { value in
                            Text(NewSessionDraft.harnessName(value)).tag(value)
                        }
                    }

                    TextField("Model (optional)", text: $draft.model)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .onSubmit(create)
                } header: {
                    Label("Agent", systemImage: "sparkles")
                } footer: {
                    Text("Leave this empty to use the harness default configured on the machine.")
                }

                Section {
                    LabeledContent("Machine", value: draft.selectedMachine?.displayName ?? "Unavailable")
                    LabeledContent("Destination", value: draft.destinationSummary)
                    LabeledContent("Harness", value: NewSessionDraft.harnessName(draft.harness))
                } header: {
                    Label("Launch summary", systemImage: "checklist")
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
                        .disabled(!draft.canCreate)
                        .accessibilityHint("Starts the session using the launch summary")
                }
            }
        }
    }

    private func create() {
        guard let submission = draft.submission else { return }
        onCreate(
            submission.endpoint,
            submission.directory,
            submission.harness,
            submission.arguments,
            submission.workspace
        )
        dismiss()
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

#Preview("New session · Accessibility") {
    PhoneNewSessionSheet(
        machines: [newSessionPreviewMachine],
        recentRepositories: [:],
        onCreate: { _, _, _, _, _ in }
    )
    .environment(\.dynamicTypeSize, .accessibility5)
}
#endif
