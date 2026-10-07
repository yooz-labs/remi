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
                    }
                } detail: {
                    if let session = visibleSessions.first(where: { $0.id == selectedSessionID }) {
                        MacSessionDetail(
                            session: session,
                            transcript: transcript(for: session.id),
                            questions: questions(for: session.id),
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
                                            optionIndices: selection.optionIDs.compactMap(Int.init).sorted()
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
                            }
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
            MacLiveNewSessionSheet(machines: store.machines) { endpoint, directory, harness, args in
                store.createSession(
                    on: endpoint,
                    directory: directory,
                    harness: harness,
                    args: args
                )
            }
        }
    }

    private var selectedMachine: MachineState? {
        store.machines.first { $0.id == selectedMachineID } ?? store.machines.first
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
    let onCreate: (MachineEndpoint, String, String, [String]) -> Void

    @State private var machineID: String?
    @State private var directory = ""
    @State private var harness = "claude"
    @State private var model = ""

    init(
        machines: [MachineState],
        onCreate: @escaping (MachineEndpoint, String, String, [String]) -> Void
    ) {
        self.machines = machines
        self.onCreate = onCreate
        _machineID = State(initialValue: machines.first?.id)
    }

    var body: some View {
        Form {
            Picker("Machine", selection: $machineID) {
                ForEach(machines) { machine in
                    Text(machine.displayName).tag(Optional(machine.id))
                }
            }
            TextField("Existing directory", text: $directory)
            Picker("Harness", selection: $harness) {
                Text("Claude Code").tag("claude")
                Text("Codex").tag("codex")
            }
            TextField("Model (optional)", text: $model)
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }
                Button("Create") {
                    guard let machine = machines.first(where: { $0.id == machineID }) else { return }
                    let args = model.isEmpty ? [] : ["-m", model]
                    onCreate(machine.endpoint, directory, harness, args)
                    dismiss()
                }
                .buttonStyle(.glassProminent)
                .disabled(directory.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(24)
        .frame(width: 520)
    }
}
