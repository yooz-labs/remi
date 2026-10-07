import RemiKit
import RemiUI
import SwiftUI

struct MacLiveRootView: View {
    let store: MachineStore

    @State private var selectedMachineID: String?
    @State private var selectedSessionID: String?
    @State private var showingNewSession = false
    @State private var showingAddMachine = false

    var body: some View {
        Group {
            if store.machines.isEmpty {
                MacFirstRunView()
            } else {
                NavigationSplitView {
                    List(store.machines, selection: $selectedMachineID) { machine in
                        VStack(alignment: .leading) {
                            Text(machine.displayName).font(.headline)
                            Text(statusText(machine.status)).font(.caption).foregroundStyle(.secondary)
                        }
                        .tag(machine.id)
                    }
                    .navigationTitle("Remi")
                    .toolbar {
                        Button {
                            showingAddMachine = true
                        } label: {
                            Label("Add machine", systemImage: "plus")
                        }
                    }
                } content: {
                    List(visibleSessions, selection: $selectedSessionID) { session in
                        RemiSessionRow(session: session)
                            .tag(session.id)
                    }
                    .navigationTitle("Sessions")
                    .toolbar {
                        Button {
                            showingNewSession = true
                        } label: {
                            Label("New session", systemImage: "plus")
                        }
                        .disabled(sessionCreationMachines.isEmpty)
                    }
                } detail: {
                    if let session = visibleSessions.first(where: { $0.id == selectedSessionID }) {
                        MacSessionDetail(
                            session: session,
                            transcript: transcript(for: session.id),
                            questions: questions(for: session.id),
                            views: store.sessionViewsBySession[session.id] ?? [],
                            transcriptForView: transcript,
                            onSelectView: store.loadTranscript,
                            onAnswer: { questionId, value in
                                store.answer(
                                    sessionId: session.id,
                                    questionId: questionId,
                                    answer: value,
                                    claudeSessionId: rawQuestion(id: questionId)?.claudeSessionId
                                )
                            },
                            onSubmit: { questionId, selections in
                                store.answer(
                                    sessionId: session.id,
                                    questionId: questionId,
                                    answer: "",
                                    claudeSessionId: rawQuestion(id: questionId)?.claudeSessionId,
                                    selections: selections.compactMap { selection in
                                        guard let questionIndex = Int(selection.stepID) else { return nil }
                                        return AnswerSelection(
                                            questionIndex: questionIndex,
                                            optionIndices: selection.optionIDs.compactMap(Int.init).sorted(),
                                            text: selection.text
                                        )
                                    }
                                )
                            },
                            onCancel: { questionId in
                                store.answer(
                                    sessionId: session.id,
                                    questionId: questionId,
                                    answer: "",
                                    claudeSessionId: rawQuestion(id: questionId)?.claudeSessionId,
                                    cancel: true
                                )
                            },
                            onSend: { content in
                                let binding = selectedMachine?.sessions
                                    .first { $0.sessionId == session.id }?.claudeSessionId
                                store.sendChat(
                                    sessionId: session.id,
                                    content: content,
                                    claudeSessionId: binding
                                )
                            },
                            onTerminate: { store.terminateSession(sessionId: session.id) }
                        )
                        .task(id: session.id) { store.loadTranscript(sessionId: session.id) }
                    } else {
                        ContentUnavailableView(
                            "Select a session",
                            systemImage: "bubble.left.and.bubble.right"
                        )
                    }
                }
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if let message = store.latestOperationError ?? store.latestError?.message {
                MacFeedbackBanner(message: message, isError: true, onDismiss: store.clearLatestError)
            } else if let message = store.latestOperationNotice {
                MacFeedbackBanner(message: message, isError: false, onDismiss: store.clearLatestError)
            }
        }
        .task {
            selectedMachineID = selectedMachineID ?? store.machines.first?.id
            store.start()
        }
        .sheet(isPresented: $showingAddMachine) {
            MacAddMachineSheet { host, port in
                store.addMachine(MachineEndpoint(host: host, port: port))
                MachineConfigurationStore.shared.save(store.machines.map(\.endpoint))
            }
        }
        .sheet(isPresented: $showingNewSession) {
            MacLiveNewSessionSheet(
                machines: sessionCreationMachines,
                recentRepositories: store.recentRepositoriesByMachine
            ) { endpoint, directory, harness, args, workspace in
                store.createSession(
                    on: endpoint,
                    directory: directory,
                    harness: harness,
                    args: args,
                    workspace: workspace
                )
            }
        }
    }

    private var selectedMachine: MachineState? {
        store.machines.first { $0.id == selectedMachineID } ?? store.machines.first
    }

    private var sessionCreationMachines: [MachineState] {
        store.machines.filter { $0.status == .connected }
    }

    private var visibleSessions: [RemiSessionSummary] {
        guard let machine = selectedMachine else { return [] }
        return machine.sessions.map { session in
            let questionCount = machine.questions.count { $0.sessionId == session.sessionId }
            return RemiSessionSummary(
                id: session.sessionId,
                machineID: machine.id,
                machineName: machine.displayName,
                name: session.name ?? URL(fileURLWithPath: session.projectPath).lastPathComponent,
                harness: session.harness ?? "claude",
                project: URL(fileURLWithPath: session.projectPath).lastPathComponent,
                status: questionCount > 0 ? .needsYou : status(for: session.status),
                lastMessage: session.lastMessage,
                openQuestionCount: questionCount,
                canTerminate: session.source == "daemon"
            )
        }
    }

    private func questions(for sessionId: String) -> [RemiQuestionCardModel] {
        guard let machine = selectedMachine else { return [] }
        return machine.questions.filter { $0.sessionId == sessionId }.map { message in
            let question = message.question
            return RemiQuestionCardModel(
                id: question.id,
                kind: questionKind(question.kind),
            text: question.text,
            detail: question.detail,
            machineID: machine.id,
            machineName: machine.displayName,
                sessionName: visibleSessions.first(where: { $0.id == sessionId })?.name ?? sessionId,
                options: question.options.map { option in
                    RemiQuestionOption(
                        id: option.value,
                        label: option.label,
                        detail: option.description,
                        role: option.isYes ? .allow : (option.isNo ? .deny : .neutral),
                        grantsForSession: option.standingGrant != nil,
                        isRecommended: option.isRecommended
                    )
                },
                steps: (question.questions ?? []).enumerated().map { index, step in
                    RemiQuestionStep(
                        id: String(index),
                        header: step.header,
                        text: step.text,
                        allowsMultipleSelection: step.multiSelect,
                        allowsFreeText: !step.multiSelect,
                        options: step.options.enumerated().map { optionIndex, option in
                            RemiQuestionOption(
                                id: String(optionIndex),
                                label: option.label,
                                detail: option.description,
                                role: .neutral,
                                isRecommended: option.isRecommended
                            )
                        }
                    )
                },
                terminalOnly: question.terminalOnly ?? false
            )
        }
    }

    private func transcript(for sessionId: String) -> [RemiTranscriptEntry] {
        (store.transcriptsBySession[sessionId] ?? []).compactMap { message in
            let content = message.content.trimmingCharacters(in: .whitespacesAndNewlines)
            if !content.isEmpty {
                return message.role == "user"
                    ? .user(id: message.entryUuid, text: content)
                    : .agent(id: message.entryUuid, text: content)
            }
            guard let tool = message.contentBlocks?.first(where: {
                $0.type == "tool_use" || $0.type == "tool_result"
            }) else { return nil }
            let summary = tool.toolInput ?? tool.toolOutput ?? ""
            return .tool(
                id: message.entryUuid,
                name: tool.toolName ?? "Tool",
                summary: String(summary.prefix(240))
            )
        }
    }

    private func rawQuestion(id: String) -> QuestionMessage? {
        selectedMachine?.questions.first { $0.question.id == id }
    }

    private func status(for value: String) -> RemiSessionStatus {
        switch value {
        case "active": .working
        case "idle": .idle
        default: .offline
        }
    }

    private func questionKind(_ value: String?) -> RemiQuestionKind {
        switch value {
        case "multi_question": .askUser
        case "plan_approval": .planApproval
        default: .permission
        }
    }

    private func statusText(_ status: MachineConnectionStatus) -> String {
        switch status {
        case .disconnected: "Disconnected"
        case .connecting: "Connecting"
        case .connected: "Connected"
        case .waitingForApproval(let fingerprint): "Approve \(fingerprint) locally"
        case .unavailable(let reason): reason ?? "Unavailable"
        }
    }
}

private struct MacFeedbackBanner: View {
    let message: String
    let isError: Bool
    let onDismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: RemiTheme.Spacing.s) {
            Image(systemName: isError ? "exclamationmark.triangle.fill" : "info.circle.fill")
                .foregroundStyle(isError ? .orange : .blue)
            Text(message)
                .font(.subheadline)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("Dismiss", systemImage: "xmark", action: onDismiss)
                .labelStyle(.iconOnly)
                .buttonStyle(.plain)
        }
        .padding(.horizontal, RemiTheme.Spacing.m)
        .padding(.vertical, RemiTheme.Spacing.s)
        .background((isError ? Color.orange : Color.blue).opacity(0.1))
        .accessibilityElement(children: .combine)
    }
}

private struct MacAddMachineSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var host = "127.0.0.1"
    @State private var port = 18765
    let onAdd: (String, Int) -> Void

    var body: some View {
        Form {
            TextField("Host or IP address", text: $host)
            TextField("Port", value: $port, format: .number)
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }
                Button("Add") {
                    onAdd(host.trimmingCharacters(in: .whitespacesAndNewlines), port)
                    dismiss()
                }
                .buttonStyle(.glassProminent)
                .disabled(host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !(1...65535).contains(port))
            }
        }
        .padding(24)
        .frame(width: 420)
    }
}

private struct MacLiveNewSessionSheet: View {
    @Environment(\.dismiss) private var dismiss
    let machines: [MachineState]
    let recentRepositories: [String: [RecentRepository]]
    let onCreate: (MachineEndpoint, String, String, [String], WorkspaceRequest?) -> Void

    @State private var machineID: String?
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
        _machineID = State(initialValue: machines.first?.id)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.m) {
            Text("New session").font(.title2.weight(.semibold))

            Form {
                Picker("Machine", selection: $machineID) {
                    ForEach(machines) { machine in
                        Text(machine.displayName).tag(Optional(machine.id))
                    }
                }

                if !repositories.isEmpty {
                    Picker("Recent repository", selection: $repository) {
                        Text("Choose a repository").tag("")
                        ForEach(repositories) { item in
                            Text("\(item.name) — \(item.repository)").tag(item.repository)
                        }
                    }
                }

                TextField(workspaceCapable ? "Repository" : "Existing directory", text: $repository)

                if workspaceCapable {
                    Toggle("Create a new branch", isOn: $createsWorktree)
                    if createsWorktree {
                        TextField("Branch", text: $branch)
                        TextField("Base (optional)", text: $base)
                    }
                }

                Picker("Harness", selection: $harness) {
                    ForEach(harnesses, id: \.self) { value in
                        Text(harnessName(value)).tag(value)
                    }
                }
                TextField("Model (optional)", text: $model)
            }

            Text(helperText)
                .font(.footnote)
                .foregroundStyle(.secondary)

            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }
                Button("Create") {
                    guard let machine = machines.first(where: { $0.id == machineID }) else { return }
                    let args = model.isEmpty ? [] : ["-m", model]
                    let workspace: WorkspaceRequest?
                    if workspaceCapable {
                        let worktree = createsWorktree
                            ? WorktreeRequest(
                                branch: trimmedBranch,
                                base: base.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
                            )
                            : nil
                        workspace = WorkspaceRequest(repository: trimmedRepository, worktree: worktree)
                    } else {
                        workspace = nil
                    }
                    onCreate(machine.endpoint, trimmedRepository, harness, args, workspace)
                    dismiss()
                }
                .buttonStyle(.glassProminent)
                .disabled(!canCreate)
            }
        }
        .padding(24)
        .frame(width: 560)
        .onAppear { selectDefaultsForMachine() }
        .onChange(of: machineID) { _, _ in selectDefaultsForMachine() }
    }

    private var selectedMachine: MachineState? {
        machines.first { $0.id == machineID }
    }

    private var workspaceCapable: Bool {
        selectedMachine?.capabilities.contains("workspaces") == true
    }

    private var repositories: [RecentRepository] {
        guard let machineID else { return [] }
        return recentRepositories[machineID] ?? []
    }

    private var harnesses: [String] {
        let values = selectedMachine?.harnesses ?? ["claude"]
        return values.isEmpty ? ["claude"] : values
    }

    private var trimmedRepository: String {
        repository.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var trimmedBranch: String {
        branch.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canCreate: Bool {
        selectedMachine != nil && !trimmedRepository.isEmpty && (!createsWorktree || !trimmedBranch.isEmpty)
    }

    private var helperText: String {
        if !workspaceCapable {
            return "This machine does not support workspaces yet. Remi will start in the existing directory."
        }
        return createsWorktree
            ? "The machine creates a worktree next to the repository. Remi does not delete it when the session ends."
            : "The session starts in the repository’s main worktree."
    }

    private func selectDefaultsForMachine() {
        if !harnesses.contains(harness) { harness = harnesses[0] }
        if repository.isEmpty, let recent = repositories.first { repository = recent.repository }
        if !workspaceCapable { createsWorktree = false }
    }

    private func harnessName(_ value: String) -> String {
        switch value {
        case "claude": "Claude Code"
        case "codex": "Codex"
        default: value.capitalized
        }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

#if DEBUG
private var workspacePreviewMachine: MachineState {
    var machine = MachineState(
        endpoint: MachineEndpoint(host: "studio.local", port: 18765),
        displayName: "Studio"
    )
    machine.status = .connected
    machine.capabilities = ["workspaces"]
    machine.harnesses = ["claude", "codex"]
    return machine
}

#Preview("Workspace session") {
    MacLiveNewSessionSheet(
        machines: [workspacePreviewMachine],
        recentRepositories: [
            workspacePreviewMachine.id: [
                RecentRepository(
                    repository: "~/Documents/git/remi",
                    name: "remi",
                    lastUsedAt: "2026-10-07T12:00:00Z"
                ),
            ],
        ],
        onCreate: { _, _, _, _, _ in }
    )
}
#endif
