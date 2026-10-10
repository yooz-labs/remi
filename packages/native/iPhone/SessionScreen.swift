import RemiKit
import RemiUI
import SwiftUI
import UIKit

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
    @State private var focusedQuestionID: String?
    @State private var confirmingTermination = false
    @State private var isSearchPresented = false
    @State private var searchFocusRequest = 0
    @State private var reviewState = RemiTranscriptReviewState()
    @AccessibilityFocusState private var accessibilityQuestionID: String?

    init(
        session: RemiSessionSummary,
        transcript: [RemiTranscriptEntry],
        questions: [RemiQuestionCardModel],
        views: [SessionViewMeta] = [],
        initialConversationID: String? = nil,
        initialQuestionID: String? = nil,
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
        _focusedQuestionID = State(initialValue: initialQuestionID)
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
            ScrollViewReader { proxy in
                VStack(spacing: 0) {
                    if isSearchPresented {
                        RemiTranscriptSearchBar(
                            query: searchQueryBinding,
                            resultPosition: reviewState.resultPosition,
                            resultCount: reviewState.matchingEntryIDs.count,
                            onPrevious: { reviewState.selectPrevious() },
                            onNext: { reviewState.selectNext() },
                            onClose: closeSearch
                        )
                        .id(searchFocusRequest)
                    }

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

                            if visibleTranscript.isEmpty && visibleQuestions.isEmpty {
                                PhoneConversationEmptyState(
                                    isSubagent: !selectedViewID.isEmpty,
                                    isFinished: !session.isLive
                                )
                            }

                            ForEach(focusedQuestions) { question in
                                questionCard(question)
                            }

                            let matchingEntryIDs = Set(reviewState.matchingEntryIDs)
                            ForEach(visibleTranscript) { entry in
                                RemiTranscriptEntryView(
                                    entry: entry,
                                    isSearchMatch: matchingEntryIDs.contains(entry.id),
                                    isSelectedSearchMatch: reviewState.selectedEntryID == entry.id
                                )
                                .id(entry.id)
                                .contextMenu {
                                    Button("Copy", systemImage: "doc.on.doc") {
                                        UIPasteboard.general.string = entry.copyText
                                    }
                                }
                            }

                            ForEach(remainingQuestions) { question in
                                questionCard(question)
                            }
                        }
                        .padding(RemiTheme.Spacing.m)
                    }
                    .modifier(SessionNavigationBarBehavior())
                    .onAppear { focusQuestion(using: proxy) }
                    .onChange(of: questions.map(\.questionID)) { _, questionIDs in
                        guard let focusedQuestionID else { return }
                        if questionIDs.contains(focusedQuestionID) {
                            focusQuestion(using: proxy)
                        } else {
                            self.focusedQuestionID = nil
                            accessibilityQuestionID = nil
                        }
                    }
                    .onChange(of: reviewState.selectedEntryID) { _, entryID in
                        scrollToSearchResult(entryID, using: proxy)
                    }
                    .onChange(of: visibleTranscript) { _, entries in
                        reviewState.refresh(entries: entries)
                    }
                }
            }

        }
        .remiSessionInteractionBar(
            draft: $draft,
            state: interactionState,
            onSend: onSend,
            onInterrupt: {}
        )
        .navigationTitle(session.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if #available(iOS 27.0, *) {
                ToolbarItem(placement: .topBarTrailing) {
                    searchButton
                }
                .visibilityPriority(.high)
                if session.canTerminate {
                    ToolbarItem(placement: .topBarTrailing) {
                        sessionActions
                    }
                    .visibilityPriority(.low)
                }
            } else {
                ToolbarItem(placement: .topBarTrailing) {
                    searchButton
                }
                if session.canTerminate {
                    ToolbarItem(placement: .topBarTrailing) {
                        sessionActions
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
            focusedQuestionID = nil
            accessibilityQuestionID = nil
            resetReview()
            onSelectView(newValue.isEmpty ? session.id : newValue)
        }
        .onChange(of: session.id) { _, _ in
            selectedViewID = ""
            resetReview()
        }
        .onChange(of: views.map(\.agentId)) { _, agentIDs in
            if !selectedViewID.isEmpty, !agentIDs.contains(selectedViewID) {
                selectedViewID = ""
            }
        }
    }

    private var searchButton: some View {
        Button("Search conversation", systemImage: "magnifyingglass") {
            isSearchPresented = true
            searchFocusRequest += 1
        }
        .disabled(visibleTranscript.isEmpty)
    }

    private var sessionActions: some View {
        Menu("Session actions", systemImage: "ellipsis.circle") {
            Button("Exit session", systemImage: "xmark.circle", role: .destructive) {
                confirmingTermination = true
            }
        }
    }

    private var visibleTranscript: [RemiTranscriptEntry] {
        selectedViewID.isEmpty ? transcript : transcriptForView(selectedViewID)
    }

    private var interactionState: RemiSessionInteractionState {
        if !session.isLive { return .finished }
        if !selectedViewID.isEmpty { return .liveSubagent }
        return .liveMain(promptWaiting: !questions.isEmpty)
    }

    private var searchQueryBinding: Binding<String> {
        Binding(
            get: { reviewState.query },
            set: { reviewState.update(query: $0, entries: visibleTranscript) }
        )
    }

    private var visibleQuestions: [RemiQuestionCardModel] {
        guard !selectedViewID.isEmpty else { return questions }
        guard let focusedQuestionID else { return [] }
        return questions.filter { $0.questionID == focusedQuestionID }
    }

    private var focusedQuestions: [RemiQuestionCardModel] {
        guard let focusedQuestionID else { return [] }
        return visibleQuestions.filter { $0.questionID == focusedQuestionID }
    }

    private var remainingQuestions: [RemiQuestionCardModel] {
        guard let focusedQuestionID else { return visibleQuestions }
        return visibleQuestions.filter { $0.questionID != focusedQuestionID }
    }

    private func questionCard(_ question: RemiQuestionCardModel) -> some View {
        RemiQuestionCard(
            model: question,
            onAnswer: { onAnswer(question.questionID, $0) },
            onSubmit: { onSubmit(question.questionID, $0) },
            onCancel: { onCancel(question.questionID) }
        )
        .id(question.questionID)
        .accessibilityFocused($accessibilityQuestionID, equals: question.questionID)
    }

    private func focusQuestion(using proxy: ScrollViewProxy) {
        guard let focusedQuestionID,
              questions.contains(where: { $0.questionID == focusedQuestionID })
        else { return }
        withAnimation(.easeInOut(duration: 0.25)) {
            proxy.scrollTo(focusedQuestionID, anchor: .center)
        }
        accessibilityQuestionID = focusedQuestionID
    }

    private func scrollToSearchResult(_ entryID: String?, using proxy: ScrollViewProxy) {
        guard let entryID else { return }
        withAnimation(.easeInOut(duration: 0.2)) {
            proxy.scrollTo(entryID, anchor: .center)
        }
    }

    private func closeSearch() {
        isSearchPresented = false
        reviewState.reset()
    }

    private func resetReview() {
        isSearchPresented = false
        reviewState.reset()
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
    @Namespace private var glassNamespace
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

            GlassEffectContainer(spacing: RemiTheme.Spacing.xs) {
                ScrollView(.horizontal) {
                    HStack(spacing: RemiTheme.Spacing.xs) {
                        ConversationButton(
                            id: "main",
                            title: "Main",
                            systemImage: "bubble.left.fill",
                            active: true,
                            selected: selectedViewID.isEmpty,
                            glassNamespace: glassNamespace
                        ) { selectedViewID = "" }
                        ForEach(views) { view in
                            ConversationButton(
                                id: view.agentId,
                                title: view.agentType,
                                systemImage: "person.2.fill",
                                active: view.active,
                                selected: selectedViewID == view.agentId,
                                glassNamespace: glassNamespace
                            ) { selectedViewID = view.agentId }
                        }
                    }
                    .padding(.vertical, 2)
                }
                .scrollIndicators(.hidden)
            }
        }
    }
}

private struct ConversationButton: View {
    let id: String
    let title: String
    let systemImage: String
    let active: Bool
    let selected: Bool
    let glassNamespace: Namespace.ID
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
        .glassEffectID(id, in: glassNamespace)
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
    let isFinished: Bool

    var body: some View {
        ContentUnavailableView(
            title,
            systemImage: systemImage,
            description: Text(description)
        )
        .frame(maxWidth: .infinity)
        .padding(.vertical, RemiTheme.Spacing.xl)
    }

    private var title: String {
        if isFinished { return "No recorded conversation" }
        return isSubagent ? "Conversation not available yet" : "Waiting for activity"
    }

    private var systemImage: String {
        if isFinished { return "checkmark.circle" }
        return isSubagent ? "person.2" : "bubble.left.and.bubble.right"
    }

    private var description: String {
        if isFinished { return "This finished session has no transcript entries to review." }
        return isSubagent
            ? "This subagent has not written its first message yet."
            : "Agent messages, tool activity, and questions will appear here."
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
