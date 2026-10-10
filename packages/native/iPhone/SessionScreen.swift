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

                    if visibleTranscript.isEmpty, selectedViewID.isEmpty ? questions.isEmpty : true {
                        PhoneConversationEmptyState(isSubagent: !selectedViewID.isEmpty)
                    }

                    ForEach(visibleTranscript) { entry in
                        RemiTranscriptEntryView(entry: entry)
                    }

                    ForEach(selectedViewID.isEmpty ? questions : []) { question in
                        RemiQuestionCard(
                            model: question,
                            onAnswer: { onAnswer(question.questionID, $0) },
                            onSubmit: { onSubmit(question.questionID, $0) },
                            onCancel: { onCancel(question.questionID) }
                        )
                    }
                }
                .padding(RemiTheme.Spacing.m)
            }
            .modifier(SessionNavigationBarBehavior())

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
        .onChange(of: session.id) { _, _ in
            selectedViewID = ""
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

private struct SessionNavigationBarBehavior: ViewModifier {
    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 27.0, *) {
            content.toolbarMinimizationBehavior(.onScrollDown, for: .navigationBar)
        } else {
            content
        }
    }
}

private struct ConversationPicker: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let views: [SessionViewMeta]
    @Binding var selectedViewID: String

    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: RemiTheme.Spacing.xs))
            : AnyLayout(HStackLayout(alignment: .center, spacing: RemiTheme.Spacing.s))

        layout {
            Label("Conversations", systemImage: "bubble.left.and.bubble.right")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)

            ScrollView(.horizontal) {
                HStack(spacing: RemiTheme.Spacing.xs) {
                    ConversationButton(
                        title: "Main",
                        systemImage: "bubble.left.fill",
                        active: true,
                        selected: selectedViewID.isEmpty
                    ) { selectedViewID = "" }
                    ForEach(views) { view in
                        ConversationButton(
                            title: view.agentType,
                            systemImage: "person.2.fill",
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
    let systemImage: String
    let active: Bool
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: RemiTheme.Spacing.xs) {
                Image(systemName: systemImage)
                    .foregroundStyle(selected ? Color.primary : .secondary)
                Text(title).lineLimit(1)
                Circle()
                    .fill(active ? Color.primary.opacity(0.72) : Color.secondary.opacity(0.35))
                    .frame(width: 6, height: 6)
            }
            .font(.subheadline.weight(.semibold))
            .frame(minHeight: RemiTheme.Size.minimumTapTarget)
            .padding(.horizontal, RemiTheme.Spacing.s)
            .contentShape(.rect)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.capsule)
        .overlay {
            Capsule()
                .stroke(selected ? Color.primary.opacity(0.32) : .clear, lineWidth: 1)
                .allowsHitTesting(false)
        }
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityLabel("\(title), \(active ? "active" : "finished")")
        .accessibilityHint(active ? "Active conversation" : "Finished conversation")
    }
}

private struct PhoneConversationEmptyState: View {
    let isSubagent: Bool

    var body: some View {
        ContentUnavailableView(
            isSubagent ? "Conversation not available yet" : "Waiting for activity",
            systemImage: isSubagent ? "person.2" : "bubble.left.and.bubble.right",
            description: Text(
                isSubagent
                    ? "This subagent has not written its first message yet."
                    : "Agent messages, tool activity, and questions will appear here."
            )
        )
        .frame(maxWidth: .infinity)
        .padding(.vertical, RemiTheme.Spacing.xl)
    }
}

private struct SessionIdentityHeader: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let machineName: String
    let project: String
    let harness: String
    let status: RemiSessionStatus

    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: RemiTheme.Spacing.s))
            : AnyLayout(HStackLayout(alignment: .top, spacing: RemiTheme.Spacing.s))

        layout {
            SessionLocation(machineName: machineName, project: project, harness: harness)
                .layoutPriority(1)

            if !dynamicTypeSize.isAccessibilitySize {
                Spacer(minLength: RemiTheme.Spacing.xs)
            }

            RemiStatusBadge(status: status)
        }
        .padding(.bottom, RemiTheme.Spacing.xxs)
    }
}

private struct SessionLocation: View {
    let machineName: String
    let project: String
    let harness: String

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: RemiTheme.Spacing.m) {
                SessionMetadataLabel(value: machineName, systemImage: "desktopcomputer")
                    .fixedSize(horizontal: true, vertical: false)
                SessionMetadataLabel(value: project, systemImage: "folder")
                    .fixedSize(horizontal: true, vertical: false)
                SessionMetadataLabel(value: harness, systemImage: "cpu")
                    .fixedSize(horizontal: true, vertical: false)
            }

            VStack(alignment: .leading, spacing: RemiTheme.Spacing.xxs) {
                SessionMetadataLabel(value: machineName, systemImage: "desktopcomputer")
                SessionMetadataLabel(value: project, systemImage: "folder")
                SessionMetadataLabel(value: harness, systemImage: "cpu")
            }
        }
    }
}

private struct SessionMetadataLabel: View {
    let value: String
    let systemImage: String

    var body: some View {
        Label {
            Text(value)
                .lineLimit(1)
        } icon: {
            Image(systemName: systemImage)
        }
        .font(.subheadline)
        .foregroundStyle(.secondary)
    }
}
