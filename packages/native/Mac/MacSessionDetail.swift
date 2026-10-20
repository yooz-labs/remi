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
    let onSelectView: (String) -> Void
    let onAnswer: (String, String) -> Void
    let onSubmit: (String, [RemiQuestionStepSelection]) -> Void
    let onCancel: (String) -> Void
    let onSend: (String) async -> Bool
    let onResume: (() -> Void)?
    let onTerminate: () -> Void

    @State private var draft = ""
    @State private var selectedViewID = ""
    @State private var focusedQuestionID: String?
    @State private var confirmingTermination = false
    @State private var isSearchPresented = false
    @State private var searchFocusRequest = 0
    @State private var reviewState = RemiTranscriptReviewState()
    @State private var reviewMemory = RemiConversationReviewMemory()
    @State private var visibleEntryID: String?
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
        onSelectView: @escaping (String) -> Void = { _ in },
        onAnswer: @escaping (String, String) -> Void = { _, _ in },
        onSubmit: @escaping (String, [RemiQuestionStepSelection]) -> Void = { _, _ in },
        onCancel: @escaping (String) -> Void = { _ in },
        onSend: @escaping (String) async -> Bool = { _ in true },
        onResume: (() -> Void)? = nil,
        onTerminate: @escaping () -> Void = {}
    ) {
        self.session = session
        self.transcript = transcript
        self.questions = questions
        self.views = views
        self.viewsLoaded = viewsLoaded
        _selectedViewID = State(initialValue: initialConversationID ?? "")
        _focusedQuestionID = State(initialValue: initialQuestionID)
        _reviewSessionID = State(initialValue: session.id)
        self.transcriptForView = transcriptForView
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
                onTerminate: { confirmingTermination = true }
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
                            if visibleTranscript.isEmpty && visibleQuestions.isEmpty {
                                MacConversationEmptyState(
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
                    }
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
                    .onChange(of: visibleTranscript) { _, entries in
                        reviewState.refresh(entries: entries)
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
            "Exit \(session.name)?",
            isPresented: $confirmingTermination,
            titleVisibility: .visible
        ) {
            Button("Exit session", role: .destructive, action: onTerminate)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The agent process and its Remi session will close. Its transcript remains available for later review.")
        }
        .toolbar {
            if #available(macOS 26.1, *) {
                ToolbarItemGroup {
                    firstActivityButton
                    latestActivityButton
                    searchButton
                }
                .visibilityPriority(.high)
            } else {
                ToolbarItemGroup {
                    firstActivityButton
                    latestActivityButton
                    searchButton
                }
            }
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

    private var searchButton: some View {
        Button("Search conversation", systemImage: "magnifyingglass") {
            isSearchPresented = true
            searchFocusRequest += 1
        }
        .keyboardShortcut("f", modifiers: .command)
        .disabled(visibleTranscript.isEmpty)
        .help("Search conversation")
    }

    private var latestActivityButton: some View {
        Button("Jump to latest activity", systemImage: "arrow.down.to.line") {
            guard let latestActivityID else { return }
            withAnimation(.easeInOut(duration: 0.2)) {
                visibleEntryID = latestActivityID
            }
        }
        .labelStyle(.iconOnly)
        .keyboardShortcut(.downArrow, modifiers: .command)
        .disabled(latestActivityID == nil || visibleEntryID == latestActivityID)
        .help("Jump to latest activity (Command-↓)")
    }

    private var firstActivityButton: some View {
        Button("Jump to first activity", systemImage: "arrow.up.to.line") {
            guard let firstActivityID else { return }
            withAnimation(.easeInOut(duration: 0.2)) {
                visibleEntryID = firstActivityID
            }
        }
        .labelStyle(.iconOnly)
        .keyboardShortcut(.upArrow, modifiers: .command)
        .disabled(firstActivityID == nil || visibleEntryID == firstActivityID)
        .help("Jump to first activity (Command-↑)")
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

    private func copyToPasteboard(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    private func closeSearch() {
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
            Menu {
                Button {
                    selectedViewID = ""
                } label: {
                    Label("Main", systemImage: selectedViewID.isEmpty ? "checkmark" : "bubble.left.fill")
                }
                if !views.isEmpty { Divider() }
                ForEach(views) { view in
                    Button {
                        selectedViewID = view.agentId
                    } label: {
                        Label(
                            RemiConversationSelection.title(for: view, among: views),
                            systemImage: selectedViewID == view.agentId ? "checkmark" : "person.2.fill"
                        )
                    }
                }
            } label: {
                Label("Choose conversation", systemImage: "bubble.left.and.bubble.right")
                    .labelStyle(.iconOnly)
                    .frame(minWidth: RemiTheme.Size.minimumTapTarget)
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .help("Choose a main or subagent conversation")

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

            GlassEffectContainer(spacing: RemiTheme.Spacing.xxs) {
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
        selectedViewID = RemiConversationSelection.shiftedViewID(
            selectedViewID: selectedViewID,
            views: views,
            offset: offset
        )
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
            Text(verbatim: session.name)
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
#endif
