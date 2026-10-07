import RemiKit
import RemiUI
import SwiftUI

struct SessionScreen: View {
    @Environment(\.dismiss) private var dismiss
    let session: RemiSessionSummary
    let transcript: [RemiTranscriptEntry]
    let questions: [RemiQuestionCardModel]
    let views: [SessionViewMeta]
    let transcriptForView: (String) -> [RemiTranscriptEntry]
    let onSelectView: (String) -> Void
    let onAnswer: (String, String) -> Void
    let onSubmit: (String, [RemiQuestionStepSelection]) -> Void
    let onCancel: (String) -> Void
    let onSend: (String) -> Void
    let onTerminate: () -> Void

    @State private var draft = ""
    @State private var selectedViewID = ""
    @State private var confirmingTermination = false

    init(
        session: RemiSessionSummary,
        transcript: [RemiTranscriptEntry],
        questions: [RemiQuestionCardModel],
        views: [SessionViewMeta] = [],
        initialConversationID: String? = nil,
        transcriptForView: @escaping (String) -> [RemiTranscriptEntry] = { _ in [] },
        onSelectView: @escaping (String) -> Void = { _ in },
        onAnswer: @escaping (String, String) -> Void = { _, _ in },
        onSubmit: @escaping (String, [RemiQuestionStepSelection]) -> Void = { _, _ in },
        onCancel: @escaping (String) -> Void = { _ in },
        onSend: @escaping (String) -> Void = { _ in },
        onTerminate: @escaping () -> Void = {}
    ) {
        self.session = session
        self.transcript = transcript
        self.questions = questions
        self.views = views
        _selectedViewID = State(initialValue: initialConversationID ?? "")
        self.transcriptForView = transcriptForView
        self.onSelectView = onSelectView
        self.onAnswer = onAnswer
        self.onSubmit = onSubmit
        self.onCancel = onCancel
        self.onSend = onSend
        self.onTerminate = onTerminate
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: RemiTheme.Spacing.m) {
                    SessionIdentityHeader(
                        machineName: session.machineName,
                        project: session.project,
                        harness: session.harness,
                        status: session.status
                    )

                    if !views.isEmpty {
                        ConversationPicker(
                            views: views,
                            selectedViewID: $selectedViewID
                        )
                    }

                    if !selectedViewID.isEmpty, visibleTranscript.isEmpty {
                        ContentUnavailableView(
                            "Conversation not available yet",
                            systemImage: "bubble.left.and.bubble.right",
                            description: Text("The subagent may not have written its first message.")
                        )
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, RemiTheme.Spacing.l)
                    }

                    ForEach(visibleTranscript) { entry in
                        RemiTranscriptEntryView(entry: entry)
                    }

                    ForEach(selectedViewID.isEmpty ? questions : []) { question in
                        RemiQuestionCard(
                            model: question,
                            onAnswer: { onAnswer(question.id, $0) },
                            onSubmit: { onSubmit(question.id, $0) },
                            onCancel: { onCancel(question.id) }
                        )
                    }
                }
                .padding(RemiTheme.Spacing.m)
            }

            Divider()

            if selectedViewID.isEmpty {
                RemiComposer(
                    text: $draft,
                    promptWaiting: !questions.isEmpty,
                    onSend: {
                        let content = draft
                        draft = ""
                        onSend(content)
                    },
                    onInterrupt: {}
                )
                .padding(RemiTheme.Spacing.s)
            } else {
                Label("Subagent conversations are read-only", systemImage: "eye")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .padding(.horizontal, RemiTheme.Spacing.m)
            }
        }
        .navigationTitle(session.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if session.canTerminate {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu("Session actions", systemImage: "ellipsis.circle") {
                        Button("Exit session", systemImage: "xmark.circle", role: .destructive) {
                            confirmingTermination = true
                        }
                    }
                }
            }
        }
        .confirmationDialog(
            "Exit \(session.name)?",
            isPresented: $confirmingTermination,
            titleVisibility: .visible
        ) {
            Button("Exit session", role: .destructive) {
                onTerminate()
                dismiss()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The agent process and its Remi session will close. Its transcript remains available for later review.")
        }
        .onChange(of: selectedViewID) { _, newValue in
            onSelectView(newValue.isEmpty ? session.id : newValue)
        }
        .onChange(of: views.map(\.agentId)) { _, agentIDs in
            if !selectedViewID.isEmpty, !agentIDs.contains(selectedViewID) {
                selectedViewID = ""
            }
        }
    }

    private var visibleTranscript: [RemiTranscriptEntry] {
        selectedViewID.isEmpty ? transcript : transcriptForView(selectedViewID)
    }
}

private struct ConversationPicker: View {
    let views: [SessionViewMeta]
    @Binding var selectedViewID: String

    var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.xs) {
            Text("Conversation").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
            ScrollView(.horizontal) {
                HStack(spacing: RemiTheme.Spacing.xs) {
                    ConversationButton(
                        title: "Main",
                        active: true,
                        selected: selectedViewID.isEmpty
                    ) { selectedViewID = "" }
                    ForEach(views) { view in
                        ConversationButton(
                            title: view.agentType,
                            active: view.active,
                            selected: selectedViewID == view.agentId
                        ) { selectedViewID = view.agentId }
                    }
                }
                .padding(.vertical, 2)
            }
            .scrollIndicators(.hidden)
        }
    }
}

private struct ConversationButton: View {
    let title: String
    let active: Bool
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: RemiTheme.Spacing.xxs) {
                Circle()
                    .fill(active ? Color.green : Color.secondary.opacity(0.5))
                    .frame(width: 7, height: 7)
                Text(title).fixedSize(horizontal: false, vertical: true)
            }
            .font(.subheadline.weight(.semibold))
            .frame(minHeight: 44)
            .padding(.horizontal, RemiTheme.Spacing.s)
            .contentShape(.rect)
        }
        .buttonStyle(.glass)
        .tint(selected ? RemiTheme.Color.attention : nil)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityHint(active ? "Active conversation" : "Finished conversation")
    }
}

private struct SessionIdentityHeader: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let machineName: String
    let project: String
    let harness: String
    let status: RemiSessionStatus

    var body: some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: RemiTheme.Spacing.xxs) {
                SessionLocation(machineName: machineName, project: project, harness: harness)
                RemiStatusBadge(status: status)
            }
        } else {
            HStack(alignment: .top, spacing: RemiTheme.Spacing.s) {
                SessionLocation(machineName: machineName, project: project, harness: harness)
                Spacer(minLength: RemiTheme.Spacing.xs)
                RemiStatusBadge(status: status)
            }
        }
    }
}

private struct SessionLocation: View {
    let machineName: String
    let project: String
    let harness: String

    var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.xxs) {
            Text("\(machineName) / \(project)")
                .font(RemiTheme.Typography.code)
                .foregroundStyle(.secondary)
            Text(harness).font(.caption.weight(.semibold)).textCase(.uppercase).foregroundStyle(.tertiary)
        }
    }
}
