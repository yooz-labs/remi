import RemiKit
import RemiUI
import SwiftUI

struct MacSessionDetail: View {
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
            MacSessionToolbarHeader(
                session: session,
                onTerminate: { confirmingTermination = true }
            )
            if !views.isEmpty {
                MacConversationPicker(views: views, selectedViewID: $selectedViewID)
                    .padding(.horizontal, RemiTheme.Spacing.m)
                    .padding(.vertical, RemiTheme.Spacing.xs)
            }
            Divider()

            ScrollView {
                LazyVStack(alignment: .leading, spacing: RemiTheme.Spacing.m) {
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
                .frame(maxWidth: 760)
                .padding(RemiTheme.Spacing.l)
                .frame(maxWidth: .infinity)
            }

            Divider()
            if selectedViewID.isEmpty {
                RemiComposer(text: $draft, promptWaiting: !questions.isEmpty, onSend: {
                    let content = draft
                    draft = ""
                    onSend(content)
                }, onInterrupt: {})
                    .padding(RemiTheme.Spacing.s)
            } else {
                Label("Subagent conversations are read-only", systemImage: "eye")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: RemiTheme.Size.minimumTapTarget)
                    .padding(.horizontal, RemiTheme.Spacing.m)
            }
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
        .confirmationDialog(
            "Exit \(session.name)?",
            isPresented: $confirmingTermination,
            titleVisibility: .visible
        ) {
            Button("Exit session", role: .destructive, action: onTerminate)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The agent process and its Remi session will close. Its transcript remains available for later review.")
        }
    }

    private var visibleTranscript: [RemiTranscriptEntry] {
        selectedViewID.isEmpty ? transcript : transcriptForView(selectedViewID)
    }
}

private struct MacConversationPicker: View {
    let views: [SessionViewMeta]
    @Binding var selectedViewID: String

    var body: some View {
        HStack(spacing: RemiTheme.Spacing.s) {
            Text("Conversation")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)

            ScrollView(.horizontal) {
                HStack(spacing: RemiTheme.Spacing.xs) {
                    MacConversationButton(
                        title: "Main",
                        active: true,
                        selected: selectedViewID.isEmpty
                    ) { selectedViewID = "" }

                    ForEach(views) { view in
                        MacConversationButton(
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

private struct MacConversationButton: View {
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
                Text(title).lineLimit(1)
            }
            .font(.subheadline.weight(.semibold))
            .frame(minHeight: RemiTheme.Size.minimumTapTarget)
            .padding(.horizontal, RemiTheme.Spacing.s)
            .contentShape(.rect)
        }
        .buttonStyle(.glass)
        .tint(selected ? RemiTheme.Color.attention : nil)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityHint(active ? "Active conversation" : "Finished conversation")
    }
}

private struct MacSessionToolbarHeader: View {
    let session: RemiSessionSummary
    let onTerminate: () -> Void

    var body: some View {
        HStack(spacing: RemiTheme.Spacing.s) {
            VStack(alignment: .leading, spacing: RemiTheme.Spacing.xxxs) {
                Text(session.name).font(.headline)
                Text("\(session.machineName) / \(session.project) · \(session.harness)")
                    .font(RemiTheme.Typography.code)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            RemiStatusBadge(status: session.status)
            if session.canTerminate {
                Menu("Session actions", systemImage: "ellipsis.circle") {
                    Button("Exit session", systemImage: "xmark.circle", role: .destructive) {
                        onTerminate()
                    }
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
            }
        }
        .padding(.horizontal, RemiTheme.Spacing.m)
        .padding(.vertical, RemiTheme.Spacing.xs)
    }
}

#if DEBUG
#Preview("Subagent conversations") {
    MacSessionDetail(
        session: RemiSessionSummary(
            id: "native-ios",
            machineName: "Studio",
            name: "Native iOS",
            harness: "Claude",
            project: "remi",
            status: .needsYou,
            canTerminate: true
        ),
        transcript: RemiPreviewData.transcript,
        questions: [],
        views: [
            SessionViewMeta(agentId: "explore", agentType: "Explore", active: true),
            SessionViewMeta(agentId: "review", agentType: "Code reviewer", active: false),
        ],
        transcriptForView: { _ in RemiPreviewData.transcript }
    )
    .frame(width: 900, height: 650)
}
#endif
