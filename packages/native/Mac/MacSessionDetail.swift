import AppKit
import RemiKit
import RemiUI
import SwiftUI

struct MacSessionDetail: View {
    let session: RemiSessionSummary
    let transcript: [RemiTranscriptEntry]
    let questions: [RemiQuestionCardModel]
    let views: [SessionViewMeta]
    let viewsLoaded: Bool
    let transcriptForView: (String) -> [RemiTranscriptEntry]
    let isLoadingTranscript: (String) -> Bool
    let onSelectView: (String) -> Void
    let onAnswer: (String, String) -> Void
    let onSubmit: (String, [RemiQuestionStepSelection]) -> Void
    let onCancel: (String) -> Void
    let onSend: (String) async -> Bool
    let onResume: (() -> Void)?
    let onTerminate: () -> Void
    let onDraftChange: (String) -> Void

    @State private var draft: String
    @State private var selectedViewID = ""
    @State private var focusedQuestionID: String?
    @State private var confirmingTermination = false
    @State private var isSearchPresented = false
    @State private var searchFocusRequest = 0
    @State private var reviewState = RemiTranscriptReviewState()
    @State private var reviewMemory = RemiConversationReviewMemory()
    @State private var visibleEntryID: String?
    @State private var expandedEntryIDs: Set<String> = []
    @State private var transcriptRows: [RemiTranscriptRow] = []
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
        initialConversationID: String? = nil,
        initialQuestionID: String? = nil,
        transcriptForView: @escaping (String) -> [RemiTranscriptEntry] = { _ in [] },
        isLoadingTranscript: @escaping (String) -> Bool = { _ in false },
        onSelectView: @escaping (String) -> Void = { _ in },
        onAnswer: @escaping (String, String) -> Void = { _, _ in },
        onSubmit: @escaping (String, [RemiQuestionStepSelection]) -> Void = { _, _ in },
        onCancel: @escaping (String) -> Void = { _ in },
        onSend: @escaping (String) async -> Bool = { _ in true },
        onResume: (() -> Void)? = nil,
        onTerminate: @escaping () -> Void = {},
        initialDraft: String = "",
        onDraftChange: @escaping (String) -> Void = { _ in }
    ) {
        _draft = State(initialValue: initialDraft)
        self.onDraftChange = onDraftChange
        self.session = session
        self.transcript = transcript
        self.questions = questions
        self.views = views
        self.viewsLoaded = viewsLoaded
        _selectedViewID = State(initialValue: initialConversationID ?? "")
        _focusedQuestionID = State(initialValue: initialQuestionID)
        _reviewSessionID = State(initialValue: session.id)
        self.transcriptForView = transcriptForView
        self.isLoadingTranscript = isLoadingTranscript
        self.onSelectView = onSelectView
        self.onAnswer = onAnswer
        self.onSubmit = onSubmit
        self.onCancel = onCancel
        self.onSend = onSend
        self.onResume = onResume
        self.onTerminate = onTerminate
    }

    var body: some View {
        VStack(spacing: 0) {
            MacSessionToolbarHeader(
                session: session,
                onCopyID: { copyToPasteboard(session.id) },
                onCopyDirectory: { copyToPasteboard(session.projectPath) },
                onResume: onResume,
                onTerminate: { confirmingTermination = true },
                canJumpToFirst: firstActivityID != nil && firstActivityID.map(displayRowID) != visibleEntryID,
                canJumpToLatest: latestActivityID != nil && !followsLatest,
                onJumpToFirst: jumpToFirstActivity,
                onJumpToLatest: jumpToLatestActivity
            )
            if !views.isEmpty {
                MacConversationPicker(views: views, selectedViewID: $selectedViewID)
                    .padding(.horizontal, RemiTheme.Spacing.m)
                    .padding(.vertical, RemiTheme.Spacing.xxs)
            }
            Divider()

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
                            switch conversationPlaceholder {
                            case .loading:
                                MacConversationLoadingState()
                            case .empty:
                                MacConversationEmptyState(
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
                            RemiTranscriptRowsView(
                                rows: transcriptRows,
                                expandedEntryIDs: $expandedEntryIDs
                            ) { entry in
                                RemiTranscriptEntryView(
                                    entry: entry,
                                    isSearchMatch: matchingEntryIDs.contains(entry.id),
                                    isSelectedSearchMatch: reviewState.selectedEntryID == entry.id
                                )
                                .id(entry.id)
                                .contextMenu {
                                    Button("Copy", systemImage: "doc.on.doc") {
                                        copyToPasteboard(entry.copyText)
                                    }
                                }
                            }

                            ForEach(remainingQuestions) { question in
                                questionCard(question)
                            }
                        }
                        .frame(maxWidth: 860)
                        .padding(.horizontal, RemiTheme.Spacing.m)
                        .padding(.vertical, RemiTheme.Spacing.m)
                        .frame(maxWidth: .infinity)
                        .scrollTargetLayout()
                        .id(RemiTranscriptScrollTarget.latest)
                    }
                    .modifier(RemiTranscriptScrollBehavior(followsLatest: $followsLatest,
                        isReviewing: isSearchPresented || focusedQuestionID != nil,
                        onFollow: { scrollToLatest(using: proxy) }))
                    .scrollPosition(id: $visibleEntryID, anchor: .top)
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
                    .onChange(of: visibleTranscript) { previous, entries in
                        reviewState.refresh(entries: entries)
                        if previous.last?.id != entries.last?.id { scrollToLatest(using: proxy) }
                    }
                    .onChange(of: latestScrollRequest) { _, _ in scrollToLatest(using: proxy) }
                    .onChange(of: groupingInput, initial: true) { _, input in
                        transcriptRows = input.rows
                    }
                }
            }
            .remiSessionInteractionBar(
                draft: $draft,
                state: interactionState,
                onSend: onSend,
                onInterrupt: nil
            )
        }
        .onChange(of: draft) { _, text in onDraftChange(text) }
        .onChange(of: selectedViewID) { oldValue, newValue in
            focusedQuestionID = nil
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
        .confirmationDialog(
            // The full name: this confirms a destructive action, so it names the session exactly as the
            // hub does and does not shorten it by the machine prefix (#1647).
            "Exit \(session.name)?",
            isPresented: $confirmingTermination,
            titleVisibility: .visible
        ) {
            Button("Exit session", role: .destructive, action: onTerminate)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The agent process and its Remi session will close. Its transcript remains available for later review.")
        }
        // A focused value, not a scene value: Find in Conversation only applies while focus is in
        // the conversation, so the session list's own search field keeps Command-F when the
        // list has focus. The toolbar's search button works regardless of focus.
        .focusedValue(
            \.macConversations,
            views.isEmpty ? nil : MacConversationActions(move: { offset in
                selectedViewID = RemiConversationSelection.shiftedViewID(
                    selectedViewID: selectedViewID,
                    views: views,
                    offset: offset
                )
            })
        )
        .focusedValue(
            \.macFind,
            RemiMacCommandAvailability.canFind(
                hasOpenConversation: true,
                entryCount: visibleTranscript.count
            ) ? MacFindActions(find: openSearch) : nil
        )
        .toolbar {
            if #available(macOS 26.1, *) {
                ToolbarItemGroup {
                    transcriptToolbarButtons
                }
                .visibilityPriority(.high)
            } else {
                ToolbarItemGroup {
                    transcriptToolbarButtons
                }
            }
        }
    }

    /// Navigation and search only mean something once there is a conversation to move through.
    @ViewBuilder
    private var transcriptToolbarButtons: some View {
        if !visibleTranscript.isEmpty || !visibleQuestions.isEmpty {
            searchButton
        }
    }

    /// What stands in for the entries: loading, empty, or nothing. Open questions count as content.
    private var conversationPlaceholder: RemiConversationPlaceholder {
        RemiConversationPlaceholder.resolve(
            isLoading: isLoadingTranscript(selectedViewID.isEmpty ? session.id : selectedViewID),
            hasEntries: !visibleTranscript.isEmpty || !visibleQuestions.isEmpty
        )
    }

    private func reconcileConversationSelection() {
        let resolved = RemiConversationSelection.reconciledViewID(
            selectedViewID: selectedViewID,
            views: views,
            viewsLoaded: viewsLoaded
        )
        if resolved != selectedViewID { selectedViewID = resolved }
    }

    private var searchButton: some View {
        Button("Search conversation", systemImage: "magnifyingglass", action: openSearch)
        .disabled(visibleTranscript.isEmpty)
        .help("Search conversation")
    }

    /// Also the Find in Conversation menu command; its shortcut lives there, not on the button.
    private func openSearch() {
        followsLatest = false
        isSearchPresented = true
        searchFocusRequest += 1
    }

    private func jumpToLatestActivity() {
        focusedQuestionID = nil
        accessibilityQuestionID = nil
        resetReview()
        followsLatest = true
        latestScrollRequest += 1
    }

    private func jumpToFirstActivity() {
        guard let firstActivityID else { return }
        followsLatest = false
        withAnimation(.easeInOut(duration: 0.2)) {
            visibleEntryID = displayRowID(firstActivityID)
        }
    }

    /// The entries the transcript groups and the ones it must keep visible (search matches).
    private var groupingInput: RemiTranscriptGroupingInput {
        RemiTranscriptGroupingInput(
            entries: visibleTranscript,
            pinnedEntryIDs: Set(reviewState.matchingEntryIDs)
        )
    }

    /// The id of the row showing `entryID`: the entry, or the collapsed tool group hiding it.
    private func displayRowID(_ entryID: String) -> String {
        RemiTranscriptGrouping.rowID(for: entryID, in: transcriptRows, expanded: expandedEntryIDs) ?? entryID
    }

    private var visibleTranscript: [RemiTranscriptEntry] {
        selectedViewID.isEmpty ? transcript : transcriptForView(selectedViewID)
    }

    private var latestActivityID: String? {
        RemiTranscriptNavigation.latestActivityID(
            entryIDs: visibleTranscript.map(\.id),
            questionIDs: visibleQuestions.map(\.questionID)
        )
    }

    private var firstActivityID: String? {
        RemiTranscriptNavigation.firstActivityID(
            entryIDs: visibleTranscript.map(\.id),
            questionIDs: visibleQuestions.map(\.questionID)
        )
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
            proxy.scrollTo(displayRowID(entryID), anchor: .center)
        }
    }

    private func copyToPasteboard(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
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
        // Map through the new conversation's own rows: a saved position inside a tool run
        // that is collapsed now points at its group.
        let restoredRows = RemiTranscriptGroupingInput(
            entries: visibleTranscript,
            pinnedEntryIDs: Set(snapshot.reviewState.matchingEntryIDs)
        ).rows
        visibleEntryID = snapshot.visibleEntryID.map {
            RemiTranscriptGrouping.rowID(for: $0, in: restoredRows, expanded: expandedEntryIDs) ?? $0
        }
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

/// The conversations of the open session: Main and its subagents. Small pills in one row; when
/// they do not fit, one menu holds them. Previous and Next Conversation are in the Go menu.
private struct MacConversationPicker: View {
    let views: [SessionViewMeta]
    @Binding var selectedViewID: String

    var body: some View {
        ViewThatFits(in: .horizontal) {
            pills
                .fixedSize(horizontal: true, vertical: false)
            menu
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var pills: some View {
        HStack(spacing: RemiTheme.Spacing.xs) {
            RemiConversationChip(
                title: "Main",
                systemImage: "bubble.left.fill",
                active: true,
                selected: selectedViewID.isEmpty,
                compact: true
            ) { selectedViewID = "" }

            ForEach(views) { view in
                RemiConversationChip(
                    title: title(for: view),
                    systemImage: "person.2.fill",
                    active: view.active,
                    selected: selectedViewID == view.agentId,
                    compact: true
                ) { selectedViewID = view.agentId }
            }
        }
    }

    private var menu: some View {
        Menu {
            Button {
                selectedViewID = ""
            } label: {
                Label("Main", systemImage: selectedViewID.isEmpty ? "checkmark" : "bubble.left.fill")
            }
            Divider()
            ForEach(views) { view in
                Button {
                    selectedViewID = view.agentId
                } label: {
                    Label(
                        title(for: view),
                        systemImage: selectedViewID == view.agentId ? "checkmark" : "person.2.fill"
                    )
                }
            }
        } label: {
            Label(currentTitle, systemImage: "bubble.left.and.bubble.right")
                .font(.caption.weight(.semibold))
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("Choose a main or subagent conversation")
    }

    private var currentTitle: String {
        guard let view = views.first(where: { $0.agentId == selectedViewID }) else { return "Main" }
        return title(for: view)
    }

    /// The agent's type, numbered when two share it ("general-purpose 2"), rather than the id
    /// suffix the shared title adds, which is long and means nothing to the person.
    private func title(for view: SessionViewMeta) -> String {
        let base = RemiConversationSelection.title(for: view, among: [view])
        let sameType = views.filter { RemiConversationSelection.title(for: $0, among: [$0]) == base }
        guard sameType.count > 1, let index = sameType.firstIndex(where: { $0.agentId == view.agentId }) else {
            return base
        }
        return "\(base) \(index + 1)"
    }
}

private struct MacConversationLoadingState: View {
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

private struct MacConversationEmptyState: View {
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

private struct MacSessionToolbarHeader: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let session: RemiSessionSummary
    let onCopyID: () -> Void
    let onCopyDirectory: () -> Void
    let onResume: (() -> Void)?
    let onTerminate: () -> Void
    let canJumpToFirst: Bool
    let canJumpToLatest: Bool
    let onJumpToFirst: () -> Void
    let onJumpToLatest: () -> Void

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .center, spacing: RemiTheme.Spacing.m) {
                sessionIdentity
                Spacer(minLength: RemiTheme.Spacing.m)
                sessionControls
            }

            VStack(alignment: .leading, spacing: RemiTheme.Spacing.xs) {
                sessionIdentity
                sessionControls
            }
        }
        .padding(.horizontal, RemiTheme.Spacing.m)
        .padding(.vertical, RemiTheme.Spacing.xs)
    }

    private var sessionIdentity: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.xxxs) {
            Text(verbatim: session.displayTitle)
                .font(.headline)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)

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
    }

    private var sessionControls: some View {
        HStack(spacing: RemiTheme.Spacing.xs) {
            RemiStatusBadge(status: session.status)
            if let onResume {
                Button(action: onResume) {
                    if session.isResuming {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("Resume", systemImage: "play.fill")
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(session.isResuming)
                .help("Resume this session")
            }
            Menu {
                // Not toolbar buttons or Command-arrow shortcuts: those moved the text cursor in
                // the message field.
                Button("Jump to first activity", systemImage: "arrow.up.to.line", action: onJumpToFirst)
                    .disabled(!canJumpToFirst)
                Button("Jump to latest activity", systemImage: "arrow.down.to.line", action: onJumpToLatest)
                    .disabled(!canJumpToLatest)
                Divider()
                Button("Copy session ID", systemImage: "doc.on.doc", action: onCopyID)
                Button("Copy directory", systemImage: "folder", action: onCopyDirectory)
                if session.canTerminate {
                    Divider()
                    Button("Exit session", systemImage: "xmark.circle", role: .destructive) {
                        onTerminate()
                    }
                }
            } label: {
                Label("Session actions", systemImage: "ellipsis.circle")
                    .labelStyle(.iconOnly)
                    .frame(
                        minWidth: RemiTheme.Size.minimumTapTarget,
                        minHeight: RemiTheme.Size.minimumTapTarget
                    )
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .help("Session actions")
        }
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

#Preview("Hub name and tool runs") {
    MacSessionDetail(
        session: RemiPreviewData.hubNamedSession,
        transcript: RemiPreviewData.toolRunTranscript,
        questions: [],
        views: [],
        transcriptForView: { _ in RemiPreviewData.toolRunTranscript }
    )
    .frame(width: 900, height: 650)
}
#endif
