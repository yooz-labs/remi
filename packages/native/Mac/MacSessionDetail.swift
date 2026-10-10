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
                    if visibleTranscript.isEmpty, selectedViewID.isEmpty ? questions.isEmpty : true {
                        MacConversationEmptyState(isSubagent: !selectedViewID.isEmpty)
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
                    MacConversationButton(
                        title: "Main",
                        systemImage: "bubble.left.fill",
                        active: true,
                        selected: selectedViewID.isEmpty
                    ) { selectedViewID = "" }

                    ForEach(views) { view in
                        MacConversationButton(
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

            HStack(spacing: RemiTheme.Spacing.xxs) {
                conversationNavigationButton(
                    title: "Previous conversation",
                    systemImage: "chevron.left",
                    key: .leftArrow,
                    offset: -1
                )
                conversationNavigationButton(
                    title: "Next conversation",
                    systemImage: "chevron.right",
                    key: .rightArrow,
                    offset: 1
                )
            }
        }
    }

    private func conversationNavigationButton(
        title: LocalizedStringKey,
        systemImage: String,
        key: KeyEquivalent,
        offset: Int
    ) -> some View {
        Button {
            selectConversation(offsetBy: offset)
        } label: {
            Label(title, systemImage: systemImage)
                .labelStyle(.iconOnly)
                .frame(minWidth: RemiTheme.Size.minimumTapTarget)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
        .keyboardShortcut(key, modifiers: [.command, .option])
        .help(title)
    }

    private func selectConversation(offsetBy offset: Int) {
        let conversationIDs = [""] + views.map(\.agentId)
        let currentIndex = conversationIDs.firstIndex(of: selectedViewID) ?? 0
        let nextIndex = (currentIndex + offset + conversationIDs.count) % conversationIDs.count
        selectedViewID = conversationIDs[nextIndex]
    }
}

private struct MacConversationButton: View {
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

private struct MacConversationEmptyState: View {
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

private struct MacSessionToolbarHeader: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let session: RemiSessionSummary
    let onTerminate: () -> Void

    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: RemiTheme.Spacing.s))
            : AnyLayout(HStackLayout(alignment: .center, spacing: RemiTheme.Spacing.m))

        layout {
            VStack(alignment: .leading, spacing: RemiTheme.Spacing.xxxs) {
                Text(verbatim: session.name)
                    .font(.title3.weight(.semibold))
                    .lineLimit(2)

                ViewThatFits(in: .horizontal) {
                    HStack(spacing: RemiTheme.Spacing.m) {
                        metadataLabel(session.machineName, systemImage: "desktopcomputer")
                        metadataLabel(session.project, systemImage: "folder")
                        metadataLabel(session.harness, systemImage: "cpu")
                    }

                    VStack(alignment: .leading, spacing: RemiTheme.Spacing.xxxs) {
                        metadataLabel(session.machineName, systemImage: "desktopcomputer")
                        metadataLabel(session.project, systemImage: "folder")
                        metadataLabel(session.harness, systemImage: "cpu")
                    }
                }
            }
            .layoutPriority(1)

            if !dynamicTypeSize.isAccessibilitySize {
                Spacer()
            }

            HStack(spacing: RemiTheme.Spacing.s) {
                RemiStatusBadge(status: session.status)
                if session.canTerminate {
                    Menu("Session actions", systemImage: "ellipsis.circle") {
                        Button("Exit session", systemImage: "xmark.circle", role: .destructive) {
                            onTerminate()
                        }
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                    .help("Session actions")
                }
            }
        }
        .padding(.horizontal, RemiTheme.Spacing.m)
        .padding(.vertical, RemiTheme.Spacing.s)
    }

    private func metadataLabel(_ value: String, systemImage: String) -> some View {
        Label {
            Text(verbatim: value)
                .lineLimit(1)
        } icon: {
            Image(systemName: systemImage)
        }
        .font(.subheadline)
        .foregroundStyle(.secondary)
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
