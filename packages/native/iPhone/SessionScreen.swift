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
    let onDismissOutgoing: (String) -> Void
    let onTerminate: () -> Void
    let onClose: () -> Void
    let focusQuestionRequest: String?
    /// Reports the draft, pushed conversation and reading position, so the shell can hand
    /// them back if it rebuilds this screen (a switch between compact and regular width).
    let onViewStateChange: (RemiSessionViewState) -> Void
    /// The terminal and files panes a machine offers (#1639); chat only by default.
    let panes: SessionPanes

    @State private var pane: PhoneSessionPane
    @State private var draft: String
    @State private var selectedViewID: String
    @State private var composerDismissRequest = 0
    @State private var focusState: PhoneQuestionFocusState
    @State private var confirmingTermination = false
    @State private var isSearchPresented = false
    @State private var searchFocusRequest = 0
    @State private var reviewState = RemiTranscriptReviewState()
    @State private var reviewMemory = RemiConversationReviewMemory()
    @State private var visibleEntryID: String?
    @State private var expandedEntryIDs: Set<String> = []
    @State private var transcriptRows: [RemiTranscriptRow] = []
    @State private var followsLatest: Bool
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
        onDismissOutgoing: @escaping (String) -> Void = { _ in },
        onTerminate: @escaping () -> Void = {},
        onClose: @escaping () -> Void = {},
        focusQuestionRequest: String? = nil,
        restoredState: RemiSessionViewState = RemiSessionViewState(),
        onViewStateChange: @escaping (RemiSessionViewState) -> Void = { _ in },
        panes: SessionPanes = .chatOnly,
        initialPane: PhoneSessionPane = .chat
    ) {
        self.panes = panes
        _pane = State(initialValue: panes.availability.state(for: initialPane).isAvailable ? initialPane : .chat)
        self.session = session
        self.transcript = transcript
        self.questions = questions
        self.views = views
        self.viewsLoaded = viewsLoaded
        self.isLoadingTranscript = isLoadingTranscript
        // A conversation the route names (a notification) wins over the one left open.
        _selectedViewID = State(initialValue: initialConversationID ?? restoredState.selectedViewID)
        _draft = State(initialValue: restoredState.draft)
        // A saved position inside a tool run that starts collapsed points at its group.
        let openViewID = initialConversationID ?? restoredState.selectedViewID
        _visibleEntryID = State(initialValue: RemiTranscriptGrouping.restoredRowID(
            restoredState.visibleEntryID,
            entries: openViewID.isEmpty ? transcript : transcriptForView(openViewID)
        ))
        _followsLatest = State(initialValue: restoredState.followsLatest)
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
        self.onDismissOutgoing = onDismissOutgoing
        self.onTerminate = onTerminate
        self.onClose = onClose
        self.focusQuestionRequest = focusQuestionRequest
        self.onViewStateChange = onViewStateChange
    }

    private var viewState: RemiSessionViewState {
        RemiSessionViewState(
            draft: draft,
            selectedViewID: selectedViewID,
            visibleEntryID: visibleEntryID,
            followsLatest: followsLatest
        )
    }

    var body: some View {
        switch pane {
        case .chat:
            chatBody
        case .terminal:
            paneBody { TerminalPane(panes: panes) }
        case .files:
            paneBody { FilesPane(panes: panes) }
        }
    }

    /// The terminal and files panes: the identity header, the switcher, and the pane.
    private func paneBody<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.s) {
            SessionIdentityHeader(
                machineName: session.machineName, project: session.project, harness: session.harness,
                status: session.status
            )
            .padding(.horizontal, RemiTheme.Spacing.m)
            .padding(.top, RemiTheme.Spacing.s)
            PanePicker(offered: panes.availability.offeredPanes, selection: $pane)
                .padding(.horizontal, RemiTheme.Spacing.m)
            content()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .navigationTitle(session.displayTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if session.canTerminate || panes.availability.hasAnyPane {
                ToolbarItem(placement: .topBarTrailing) { sessionActions }
            }
        }
        .confirmationDialog(
            // The full name: this confirms a destructive action, so it names the session exactly as the
            // hub does and does not shorten it by the machine prefix (#1647).
            "Exit \(session.name)?", isPresented: $confirmingTermination, titleVisibility: .visible
        ) {
            Button("Exit session", role: .destructive) {
                onTerminate()
                onClose()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The agent process and its Remi session will close. Its transcript remains available for later review.")
        }
        .onChange(of: panes.availability) { _, availability in
            if !availability.state(for: pane).isAvailable { pane = .chat }
        }
    }

    private var chatBody: some View {
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

                            PanePicker(offered: panes.availability.offeredPanes, selection: $pane)

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
                            RemiTranscriptRowsView(
                                rows: transcriptRows,
                                expandedEntryIDs: $expandedEntryIDs
                            ) { entry in
                                RemiTranscriptEntryView(
                                    entry: entry,
                                    onDismissOutgoing: onDismissOutgoing,
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
                        .scrollTargetLayout()
                        .remiReadableScrollColumn()
                        .id(RemiTranscriptScrollTarget.latest)
                    }
                    .modifier(RemiTranscriptScrollBehavior(followsLatest: $followsLatest,
                        isReviewing: isSearchPresented || focusedQuestionID != nil,
                        onFollow: { scrollToLatest(using: proxy) }))
                    .scrollPosition(id: $visibleEntryID, anchor: .top)
                    // A tap on the transcript puts the composer's keyboard away; the draft stays.
                    // It asks the composer to let go, so a tap that lands on another text field
                    // (a question's free-text answer) does not fight that field for focus.
                    .simultaneousGesture(TapGesture().onEnded { composerDismissRequest += 1 })
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
                    .onChange(of: groupingInput, initial: true) { _, input in
                        transcriptRows = input.rows
                    }
                }
            }

        }
        .remiSessionInteractionBar(
            draft: $draft,
            state: interactionState,
            onSend: onSend,
            onInterrupt: nil
        )
        .environment(\.remiComposerDismissRequest, composerDismissRequest)
        .navigationTitle(session.displayTitle)
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
                if session.canTerminate || panes.availability.hasAnyPane {
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
                if session.canTerminate || panes.availability.hasAnyPane {
                    ToolbarItem(placement: .topBarTrailing) {
                        sessionActions
                    }
                }
            }
        }
        .confirmationDialog(
            // The full name: this confirms a destructive action, so it names the session exactly as the
            // hub does and does not shorten it by the machine prefix (#1647).
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
        .onChange(of: panes.availability) { _, availability in
            if !availability.state(for: pane).isAvailable { pane = .chat }
        }
        .onChange(of: viewState) { _, state in onViewStateChange(state) }
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
            // Offered only for a pane the machine can serve (RemiPaneAvailability).
            let offered = panes.availability.offeredPanes
            if offered.count > 1 {
                Section("View") {
                    ForEach(offered, id: \.self) { offeredPane in
                        Button {
                            pane = offeredPane
                        } label: {
                            Label(PanePicker.title(offeredPane), systemImage: PanePicker.systemImage(offeredPane))
                        }
                        .disabled(offeredPane == pane)
                    }
                }
            }
            if session.canTerminate {
                Button("Exit session", systemImage: "xmark.circle", role: .destructive) {
                    confirmingTermination = true
                }
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
            proxy.scrollTo(displayRowID(entryID), anchor: .center)
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
                    // What is running is next to Main, however many finished ones there are.
                    ForEach(conversations.tabs) { view in
                        RemiConversationChip(
                            title: conversations.title(for: view),
                            systemImage: "person.2.fill",
                            active: view.active,
                            selected: selectedViewID == view.agentId
                        ) { selectedViewID = view.agentId }
                    }
                }
                .padding(.vertical, 2)
            }
            .scrollIndicators(.hidden)

            // Outside the scrolling chips, so it is always in reach however many are running.
            if !conversations.earlier.isEmpty { earlierMenu }
        }
    }

    private var conversations: RemiConversationTabs {
        RemiConversationTabs(views: views, selectedViewID: selectedViewID)
    }

    /// Finished conversations. They stay reachable, but do not take a chip each.
    private var earlierMenu: some View {
        Menu {
            ForEach(conversations.earlier) { view in
                Button(conversations.title(for: view), systemImage: "person.2.fill") {
                    selectedViewID = view.agentId
                }
            }
        } label: {
            Text("Earlier \(conversations.earlier.count)")
                .font(.subheadline.weight(.semibold))
                .frame(minHeight: RemiTheme.Size.minimumTapTarget)
                .padding(.horizontal, RemiTheme.Spacing.s)
                .background(RemiTheme.Color.elevatedSurface, in: Capsule())
                .overlay { Capsule().stroke(RemiTheme.Color.hairline, lineWidth: 1) }
                .contentShape(.rect)
        }
        .accessibilityLabel("Earlier conversations, \(conversations.earlier.count)")
        .accessibilityHint("Finished subagent conversations")
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
