import RemiKit
import RemiUI
import SwiftUI
import UIKit

struct SessionScreen: View {
    let session: RemiSessionSummary
    let transcript: [RemiTranscriptEntry]
    let questions: [RemiQuestionCardModel]
    let views: [SessionViewMeta]
    let viewsLoaded: Bool
    /// Whether the transcript of a conversation (the session id or a subagent id) is still arriving.
    let isLoadingTranscript: (String) -> Bool
    let transcriptForView: (String) -> [RemiTranscriptEntry]
    let onSelectView: (String) -> Void
    let onAnswer: (String, String) -> Void
    let onSubmit: (String, [RemiQuestionStepSelection]) -> Void
    let onCancel: (String) -> Void
    let onSend: (String) async -> Bool
    let onTerminate: () -> Void
    let onClose: () -> Void
    let focusQuestionRequest: String?

    @State private var draft = ""
    @State private var selectedViewID = ""
    @State private var focusState: PhoneQuestionFocusState
    @State private var confirmingTermination = false
    @State private var isSearchPresented = false
    @State private var searchFocusRequest = 0
    @State private var reviewState = RemiTranscriptReviewState()
    @State private var reviewMemory = RemiConversationReviewMemory()
    @State private var visibleEntryID: String?
    @State private var followsLatest = true
    @State private var latestScrollRequest = 0
    @State private var reviewSessionID: String
    @AccessibilityFocusState private var accessibilityQuestionID: String?

    init(
        session: RemiSessionSummary,
        transcript: [RemiTranscriptEntry],
        questions: [RemiQuestionCardModel],
        views: [SessionViewMeta] = [],
        viewsLoaded: Bool = true,
        isLoadingTranscript: @escaping (String) -> Bool = { _ in false },
        initialConversationID: String? = nil,
        initialQuestionID: String? = nil,
        transcriptForView: @escaping (String) -> [RemiTranscriptEntry] = { _ in [] },
        onSelectView: @escaping (String) -> Void = { _ in },
        onAnswer: @escaping (String, String) -> Void = { _, _ in },
        onSubmit: @escaping (String, [RemiQuestionStepSelection]) -> Void = { _, _ in },
        onCancel: @escaping (String) -> Void = { _ in },
        onSend: @escaping (String) async -> Bool = { _ in true },
        onTerminate: @escaping () -> Void = {},
        onClose: @escaping () -> Void = {},
        focusQuestionRequest: String? = nil
    ) {
        self.session = session
        self.transcript = transcript
        self.questions = questions
        self.views = views
        self.viewsLoaded = viewsLoaded
        self.isLoadingTranscript = isLoadingTranscript
        _selectedViewID = State(initialValue: initialConversationID ?? "")
        _focusState = State(initialValue: PhoneQuestionFocusState(
            initial: initialQuestionID,
            loaded: questions.map(\.questionID)
        ))
        _reviewSessionID = State(initialValue: session.id)
        self.transcriptForView = transcriptForView
        self.onSelectView = onSelectView
        self.onAnswer = onAnswer
        self.onSubmit = onSubmit
        self.onCancel = onCancel
        self.onSend = onSend
        self.onTerminate = onTerminate
        self.onClose = onClose
        self.focusQuestionRequest = focusQuestionRequest
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

                            switch conversationPlaceholder {
                            case .loading:
                                PhoneConversationLoadingState()
                            case .empty:
                                PhoneConversationEmptyState(
                                    isSubagent: !selectedViewID.isEmpty,
                                    isFinished: !session.isLive
                                )
                            case .loadingMore:
                                ProgressView("Loading earlier messages")
                                    .controlSize(.small)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                    .frame(maxWidth: .infinity)
                            case .none:
                                EmptyView()
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
                        .scrollTargetLayout()
                        .padding(RemiTheme.Spacing.m)
                        .remiReadableColumn()
                        .id(RemiTranscriptScrollTarget.latest)
                    }
                    .modifier(RemiTranscriptScrollBehavior(followsLatest: $followsLatest,
                        isReviewing: isSearchPresented || focusedQuestionID != nil,
                        onFollow: { scrollToLatest(using: proxy) }))
                    .scrollPosition(id: $visibleEntryID, anchor: .top)
                    .modifier(SessionNavigationBarBehavior())
                    .onAppear { focusQuestion(using: proxy) }
                    .onChange(of: questions.map(\.questionID)) { _, questionIDs in
                        focusState.questionsChanged(questionIDs)
                        if focusedQuestionID != nil {
                            focusQuestion(using: proxy)
                        } else {
                            accessibilityQuestionID = nil
                        }
                    }
                    .onChange(of: focusQuestionRequest) { _, request in
                        guard let request else { return }
                        focusState.request(request, loaded: questions.map(\.questionID))
                        // Clear now and announce in a later transaction, so VoiceOver
                        // announces the same question again when it is re-notified.
                        accessibilityQuestionID = nil
                        Task { @MainActor in focusQuestion(using: proxy) }
                    }
                    .onChange(of: reviewState.selectedEntryID) { _, entryID in
                        scrollToSearchResult(entryID, using: proxy)
                    }
                    .onChange(of: visibleTranscript) { previous, entries in
                        reviewState.refresh(entries: entries)
                        if previous.last?.id != entries.last?.id { scrollToLatest(using: proxy) }
                    }
                    .onChange(of: latestScrollRequest) { _, _ in scrollToLatest(using: proxy) }
                }
            }

        }
        .remiSessionInteractionBar(
            draft: $draft,
            state: interactionState,
            onSend: onSend,
            onInterrupt: nil
        )
        .navigationTitle(session.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if #available(iOS 27.0, *) {
                // Jump and Search have nothing to act on in an empty conversation: show them
                // once there are entries instead of as disabled noise.
                if !visibleTranscript.isEmpty {
                    ToolbarItem(placement: .topBarTrailing) {
                        latestActivityButton
                    }
                    .visibilityPriority(.high)
                    ToolbarItem(placement: .topBarTrailing) {
                        searchButton
                    }
                    .visibilityPriority(.high)
                }
                if session.canTerminate {
                    ToolbarItem(placement: .topBarTrailing) {
                        sessionActions
                    }
                    .visibilityPriority(.low)
                }
            } else {
                if !visibleTranscript.isEmpty {
                    ToolbarItem(placement: .topBarTrailing) {
                        latestActivityButton
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        searchButton
                    }
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
                onClose()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The agent process and its Remi session will close. Its transcript remains available for later review.")
        }
        .onChange(of: selectedViewID) { oldValue, newValue in
            focusState.clear()
            accessibilityQuestionID = nil
            guard reviewSessionID == session.id else {
                reviewSessionID = session.id
                restoreReview(for: conversationID(viewID: newValue))
                onSelectView(newValue.isEmpty ? session.id : newValue)
                return
            }
            preserveReview(for: conversationID(viewID: oldValue))
            restoreReview(for: conversationID(viewID: newValue))
            onSelectView(newValue.isEmpty ? session.id : newValue)
        }
        .onChange(of: session.id) { _, _ in
            reviewMemory.reset()
            resetReview()
            visibleEntryID = nil
            followsLatest = true
            latestScrollRequest += 1
            if selectedViewID.isEmpty {
                reviewSessionID = session.id
            } else {
                selectedViewID = ""
            }
        }
        .onChange(of: viewsLoaded, initial: true) { _, loaded in
            guard loaded else { return }
            reconcileConversationSelection()
        }
        .onChange(of: views.map(\.agentId)) { _, _ in
            guard viewsLoaded else { return }
            reconcileConversationSelection()
        }
    }

    private func reconcileConversationSelection() {
        let resolved = RemiConversationSelection.reconciledViewID(
            selectedViewID: selectedViewID,
            views: views,
            viewsLoaded: viewsLoaded
        )
        if resolved != selectedViewID { selectedViewID = resolved }
    }

    /// What stands in for the entries: loading, empty, or nothing. Open questions count as content.
    private var conversationPlaceholder: RemiConversationPlaceholder {
        RemiConversationPlaceholder.resolve(
            isLoading: isLoadingTranscript(selectedViewID.isEmpty ? session.id : selectedViewID),
            hasEntries: !visibleTranscript.isEmpty || !visibleQuestions.isEmpty
        )
    }

    private var searchButton: some View {
        Button("Search conversation", systemImage: "magnifyingglass") {
            followsLatest = false
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

    private var latestActivityID: String? {
        RemiTranscriptNavigation.latestActivityID(entryIDs: visibleTranscript.map(\.id),
            questionIDs: visibleQuestions.map(\.questionID))
    }

    private var latestActivityButton: some View {
        Button("Jump to latest activity", systemImage: "arrow.down.to.line") {
            focusState.clear()
            accessibilityQuestionID = nil
            resetReview()
            followsLatest = true
            latestScrollRequest += 1
        }
        .disabled(latestActivityID == nil || followsLatest)
    }

    private var visibleTranscript: [RemiTranscriptEntry] {
        selectedViewID.isEmpty ? transcript : transcriptForView(selectedViewID)
    }

    private var interactionState: RemiSessionInteractionState {
        .resolve(
            sessionIsLive: session.isLive,
            selectedViewID: selectedViewID,
            hasWaitingQuestions: !questions.isEmpty
        )
    }

    private var searchQueryBinding: Binding<String> {
        Binding(
            get: { reviewState.query },
            set: { reviewState.update(query: $0, entries: visibleTranscript) }
        )
    }

    private var visibleQuestions: [RemiQuestionCardModel] {
        RemiConversationSelection.visibleQuestions(
            questions,
            selectedViewID: selectedViewID,
            focusedQuestionID: focusedQuestionID
        )
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

    private var focusedQuestionID: String? { focusState.focused }

    private func focusQuestion(using proxy: ScrollViewProxy) {
        guard let focusedQuestionID,
              questions.contains(where: { $0.questionID == focusedQuestionID })
        else { return }
        followsLatest = false
        withAnimation(.easeInOut(duration: 0.25)) {
            proxy.scrollTo(focusedQuestionID, anchor: .center)
        }
        accessibilityQuestionID = focusedQuestionID
    }

    private func scrollToSearchResult(_ entryID: String?, using proxy: ScrollViewProxy) {
        guard let entryID else { return }
        followsLatest = false
        withAnimation(.easeInOut(duration: 0.2)) {
            proxy.scrollTo(entryID, anchor: .center)
        }
    }

    private func closeSearch() {
        followsLatest = false
        isSearchPresented = false
        reviewState.reset()
    }

    private func resetReview() {
        isSearchPresented = false
        reviewState.reset()
    }

    private func conversationID(viewID: String) -> String {
        viewID.isEmpty ? session.id : viewID
    }

    private func preserveReview(for conversationID: String) {
        reviewMemory.save(
            RemiConversationReviewSnapshot(
                reviewState: reviewState,
                visibleEntryID: visibleEntryID,
                isSearchPresented: isSearchPresented
            ),
            for: conversationID
        )
    }

    private func restoreReview(for conversationID: String) {
        let snapshot = reviewMemory.snapshot(for: conversationID)
        reviewState = snapshot.reviewState
        visibleEntryID = snapshot.visibleEntryID
        isSearchPresented = snapshot.isSearchPresented
        followsLatest = snapshot.visibleEntryID == nil && !snapshot.isSearchPresented
        if followsLatest { latestScrollRequest += 1 }
    }

    private func scrollToLatest(using proxy: ScrollViewProxy) {
        guard followsLatest, !isSearchPresented, focusedQuestionID == nil,
              latestActivityID != nil else { return }
        proxy.scrollTo(RemiTranscriptScrollTarget.latest, anchor: .bottom)
    }
}

private struct SessionNavigationBarBehavior: ViewModifier {
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    @Environment(\.accessibilitySwitchControlEnabled) private var switchControl
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 27.0, *) {
            content.toolbarMinimizationBehavior(behavior, for: .navigationBar)
        } else {
            content
        }
    }

    @available(iOS 27.0, *)
    private var behavior: ToolbarMinimizationBehavior {
        let minimizes = RemiNavigationBarPolicy.minimizesOnScroll(
            voiceOver: voiceOver,
            switchControl: switchControl,
            accessibilitySize: dynamicTypeSize.isAccessibilitySize
        )
        return minimizes ? .onScrollDown : .never
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
                    RemiConversationChip(
                        title: "Main",
                        systemImage: "bubble.left.fill",
                        active: true,
                        selected: selectedViewID.isEmpty
                    ) { selectedViewID = "" }
                    ForEach(views) { view in
                        RemiConversationChip(
                            title: RemiConversationSelection.title(for: view, among: views),
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

private struct PhoneConversationLoadingState: View {
    var body: some View {
        VStack(spacing: RemiTheme.Spacing.s) {
            ProgressView()
            Text("Loading conversation")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, RemiTheme.Spacing.xl)
        .accessibilityElement(children: .combine)
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
