import RemiKit
import RemiUI
import SwiftUI

/// The phone's landing view: every active session as a card. The toolbar sets one density for every
/// card; from two columns, a card's own menu can override it until the toolbar or "Reset card sizes"
/// is used. A long press previews the conversation, and the cards that need the person come first.
///
/// The list never reorders while you are writing: with a field focused or a draft waiting,
/// every card keeps its place, and the order refreshes when you stop.
struct PhoneBoardScreen: View {
    private struct CardResizeDrag: Equatable {
        let startSize: RemiTileSize
        var previewSize: RemiTileSize
        let startSpan: Int
        var previewSpan: Int
        let columnWidth: CGFloat
        let columnCount: Int
        let topCorner: Bool
    }

    let sessions: [RemiSessionSummary]
    let machines: [RemiMachineSummary]
    /// Machines that are connected and have loaded their session list. Only these, once they
    /// have also settled, may have a pin pruned: a machine that just reconnected lists no
    /// sessions yet, and that is not the sessions being gone.
    let loadedMachines: Set<String>
    let questions: [RemiQuestionCardModel]
    let errorMessage: String?
    let noticeMessage: String?
    let transcript: (RemiSessionSummary) -> [RemiTranscriptEntry]
    let onAnswer: (String, String, String, String) -> Void
    let onSubmit: (String, String, String, [RemiQuestionStepSelection]) -> Void
    let onCancel: (String, String, String) -> Void
    let onOpen: (RemiSessionSummary) -> Void
    let onSend: (RemiSessionSummary, String) async -> Bool
    /// Whether a connected machine can start a session; without one the plus gives way to Add
    /// machine, as on the Inbox.
    let canCreateSession: Bool
    let onNewSession: () -> Void
    let onPresentPairing: () -> Void
    let onPresentPreferences: () -> Void
    let onManageMachines: () -> Void
    let onDismissError: () -> Void
    let onDismissNotice: () -> Void
    /// Preview and test seed used only when no board state has been stored.
    var initialBoard: RemiBoardState? = nil

    @AppStorage("remi.phone.board") private var boardStorage = ""
    @AppStorage("remi.phone.board.density") private var densityStorage = RemiTileSize.regular.rawValue
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var board = RemiBoardState()
    /// One entry per claimed card resize drag; captured on its first callback and removed when it ends or is invalidated.
    @State private var cardResizeDrags: [String: CardResizeDrag] = [:]
    @State private var boardLoaded = false
    @State private var interactions: [String: Date] = [:]
    @State private var drafts: [String: String] = [:]
    @State private var shownOrder: [String] = []
    @State private var machineFilter: String?
    @State private var onlyNeedsYou = false
    @State private var showFinished = false
    /// The sole resolved column state; starts narrow so the first frame keeps the one-column stack.
    @State private var columnLayout = RemiBoardColumns.resolve(paneWidth: 0)
    /// When each loaded machine entered `loadedMachines`, for the settling grace period.
    @State private var loadedAt: [String: Date] = [:]
    @State private var graceTick = 0
    @FocusState private var focus: String?
    @State private var focusTask: Task<Void, Never>?

    private var density: RemiTileSize { RemiTileSize.phoneDensity(stored: densityStorage) }

    private func effectiveSize(for session: RemiSessionSummary) -> RemiTileSize {
        RemiTileSize.effectivePhoneSize(
            toolbarDensity: density,
            explicitSize: board.explicitSize(for: RemiBoardOrder.key(for: session)),
            columnCount: columnLayout.columnCount
        )
    }

    private func displayedSize(for session: RemiSessionSummary) -> RemiTileSize {
        let presentation = RemiBoardCardPresentation(columnCount: columnLayout.columnCount)
        guard presentation.isMultiColumn,
              let drag = cardResizeDrags[RemiBoardOrder.key(for: session)]
        else { return effectiveSize(for: session) }
        return drag.previewSize
    }

    private func displayedSpan(for session: RemiSessionSummary) -> Int {
        let count = columnLayout.columnCount
        guard RemiBoardCardPresentation(columnCount: count).isMultiColumn else { return 1 }
        if let drag = cardResizeDrags[RemiBoardOrder.key(for: session)] {
            return min(max(drag.previewSpan, 1), count)
        }
        return min(max(board.span(for: RemiBoardOrder.key(for: session)), 1), count)
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { timeline in
            content(now: timeline.date)
        }
        .navigationTitle("Board")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { densityMenu }
            ToolbarItem(placement: .topBarTrailing) {
                if canCreateSession {
                    Button("New session", systemImage: "plus", action: onNewSession)
                } else {
                    Button("Add machine", systemImage: "desktopcomputer.and.arrow.down", action: onPresentPairing)
                }
            }
            ToolbarItem(placement: .topBarTrailing) { overflowMenu }
        }
        .onChange(of: density) { _, size in
            // The composers are gone in Compact; do not leave the keyboard waiting for one.
            if !size.showsComposer { focus = nil }
        }
        .onChange(of: composerKeys) { _, keys in
            if let focusedKey = focus, !keys.contains(focusedKey) { focus = nil }
        }
        .onChange(of: columnLayout.columnCount) { _, _ in cardResizeDrags = [:] }
        .onAppear(perform: loadBoard)
        .onChange(of: sessions.map(RemiBoardOrder.key(for:))) { pruneBoard() }
        .onChange(of: loadedMachines, initial: true) { _, ids in
            let now = Date()
            loadedAt = Dictionary(uniqueKeysWithValues: ids.map { ($0, loadedAt[$0] ?? now) })
            pruneBoard()
        }
        .task(id: GraceWindow(loadedAt: loadedAt, tick: graceTick)) {
            // Prune again when a grace period ends: nothing else changes at that moment.
            let now = Date()
            let ends = loadedAt.values
                .map { $0.addingTimeInterval(RemiLastThreads.defaultGrace) }
                .filter { $0 > now }
            guard let earliest = ends.min() else { return }
            guard (try? await Task.sleep(for: .seconds(earliest.timeIntervalSince(now)))) != nil
            else { return }
            graceTick += 1
            pruneBoard()
        }
    }

    /// Forgets pins, sizes and spans of sessions a settled machine no longer lists, plus stale resize
    /// drags, drafts, and interactions. Finished sessions still count as live so their pins remain.
    /// Saves only when persisted Board state was removed.
    private func pruneBoard() {
        let live = Set(sessions.map(RemiBoardOrder.key(for:)))
        let now = Date()
        let settled = Set(loadedMachines.filter {
            RemiLastThreads.isSettled(connectedAt: loadedAt[$0], now: now)
        })
        if board.prune(live: live, connectedMachines: settled) { saveBoard() }
        cardResizeDrags = cardResizeDrags.filter { live.contains($0.key) }
        drafts = RemiBoardOrder.keeping(drafts, live: live, settledMachines: settled)
        interactions = RemiBoardOrder.keeping(interactions, live: live, settledMachines: settled)
    }

    // MARK: list

    private func content(now: Date) -> some View {
        let ordered = arranged(now: now)
        let order = ordered.map(RemiBoardOrder.key(for:))
        // The cursor goes only to live tiles whose displayed size has a working composer.
        let liveOrder = ordered
            .filter { $0.isLive && displayedSize(for: $0).showsComposer }
            .map(RemiBoardOrder.key(for:))
        return ScrollViewReader { reader in
            boardScroll(ordered: ordered, order: order, liveOrder: liveOrder, reader: reader)
        }
        .onChange(of: order, initial: true) { _, keys in shownOrder = keys }
    }

    private func boardScroll(
        ordered: [RemiSessionSummary], order: [String], liveOrder: [String], reader: ScrollViewProxy
    ) -> some View {
        return ScrollView {
            if !RemiBoardCardPresentation(columnCount: columnLayout.columnCount).isMultiColumn {
                singleColumnStack(ordered: ordered, order: order, liveOrder: liveOrder, reader: reader)
            } else {
                multipleColumnStack(
                    ordered: ordered,
                    order: order,
                    liveOrder: liveOrder,
                    reader: reader,
                    columnLayout: columnLayout
                )
            }
        }
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.size.width
        } action: { width in
            let resolved = RemiBoardColumns.resolve(
                paneWidth: width,
                previousColumnCount: columnLayout.columnCount
            )
            if resolved != columnLayout { columnLayout = resolved }
        }
        .scrollDismissesKeyboard(.interactively)
    }

    /// Shared feedback, machine, filter and empty-state rows for both stack variants.
    @ViewBuilder
    private func boardHeader(isEmpty: Bool) -> some View {
        if let errorMessage {
            RemiFeedbackBanner(message: errorMessage, tone: .error, onDismiss: onDismissError)
        }
        if let noticeMessage {
            RemiFeedbackBanner(message: noticeMessage, tone: .information, onDismiss: onDismissNotice)
        }
        PhoneMachineProblemRows(machines: machines, onManage: onManageMachines)
        // With no machine there is nothing to filter; the first screen is the way to add one.
        if !machines.isEmpty { chips }
        if isEmpty { emptyState }
    }

    /// The pre-columns stack, kept unchanged for one column by `handoff/ipad-board.md`.
    private func singleColumnStack(
        ordered: [RemiSessionSummary], order: [String], liveOrder: [String], reader: ScrollViewProxy
    ) -> some View {
        LazyVStack(spacing: RemiTheme.Spacing.s) {
            boardHeader(isEmpty: ordered.isEmpty)
            if !ordered.isEmpty {
                ForEach(ordered) { session in
                    tile(session, order: order, liveOrder: liveOrder, reader: reader)
                        .id(RemiBoardOrder.key(for: session))
                }
            }
        }
        .padding(RemiTheme.Spacing.m)
        .remiReadableScrollColumn()
        .animation(RemiTheme.Motion.standard, value: order)
    }

    /// Uses a full-pane header and a centered card group without the readable-column cap. Its one
    /// flat tile tree keeps a card's identity when placement moves it between columns.
    private func multipleColumnStack(
        ordered: [RemiSessionSummary],
        order: [String],
        liveOrder: [String],
        reader: ScrollViewProxy,
        columnLayout: RemiBoardColumns
    ) -> some View {
        let heights = ordered.map { displayedSize(for: $0).phoneCardHeight }
        let placements = RemiBoardColumns.placements(
            itemCount: ordered.count,
            columnCount: columnLayout.columnCount,
            heights: heights,
            spans: ordered.map { displayedSpan(for: $0) }
        )
        return LazyVStack(spacing: RemiTheme.Spacing.s) {
            boardHeader(isEmpty: ordered.isEmpty)
            if !ordered.isEmpty {
                RemiBoardColumnsLayout(
                    placements: placements,
                    columnCount: columnLayout.columnCount,
                    columnWidth: columnLayout.cardWidth,
                    spacing: RemiBoardColumns.spacing
                ) {
                    ForEach(ordered) { session in
                        tile(session, order: order, liveOrder: liveOrder, reader: reader)
                            .id(RemiBoardOrder.key(for: session))
                    }
                }
                .frame(width: columnLayout.groupWidth, alignment: .top)
                .frame(maxWidth: .infinity)
            }
        }
        .padding(.vertical, RemiTheme.Spacing.m)
        .padding(.horizontal, RemiBoardColumns.margin)
        .animation(RemiTheme.Motion.standard, value: order)
    }

    /// Moves the cursor to the next live tile: scrolls it into view first, because a lazy stack
    /// has not built a tile that is off screen, then focuses it once it exists.
    private func focusNext(after key: String, in liveOrder: [String], reader: ScrollViewProxy) {
        guard let next = RemiBoardOrder.next(after: key, in: liveOrder) else { return }
        reader.scrollTo(next, anchor: .center)
        // A second send inside the wait replaces the first, so the earlier one cannot overwrite it.
        focusTask?.cancel()
        focusTask = Task {
            guard (try? await Task.sleep(for: .milliseconds(60))) != nil else { return }
            focus = next
        }
    }

    private var filtered: [RemiSessionSummary] {
        RemiBoardOrder.visible(
            sessions, machineID: machineFilter, onlyNeedsYou: onlyNeedsYou, showFinished: showFinished
        )
    }

    /// The tiles on screen that have a working composer. A draft in a compact row must not freeze
    /// the order, while a draft in any visible composer still does.
    private var composerKeys: Set<String> {
        Set(filtered.filter { $0.isLive && displayedSize(for: $0).showsComposer }.map(RemiBoardOrder.key(for:)))
    }

    private func arranged(now: Date) -> [RemiSessionSummary] {
        let keys = composerKeys
        let writing = RemiBoardOrder.isWriting(
            hasFocus: focus.map { keys.contains($0) } ?? false, drafts: drafts, composerKeys: keys
        )
        let held = writing ? RemiBoardOrder.held(from: shownOrder) : [:]
        return RemiBoardOrder.arrange(filtered, state: board, interactions: interactions, held: held, now: now)
    }

    private func tile(
        _ session: RemiSessionSummary, order: [String], liveOrder: [String], reader: ScrollViewProxy
    ) -> some View {
        let key = RemiBoardOrder.key(for: session)
        let size = displayedSize(for: session)
        let waiting = questions.first {
            $0.machineID == session.machineID && $0.sessionID == session.id && $0.state == .pending
        }
        let entries = transcript(session)
        let presentation = RemiBoardCardPresentation(columnCount: columnLayout.columnCount)
        return RemiBoardTile(
            session: session,
            tileKey: key,
            size: size,
            isPinned: board.isPinned(key),
            entries: entries,
            draft: Binding(get: { drafts[key] ?? "" }, set: { drafts[key] = $0 }),
            focus: $focus,
            onOpen: { onOpen(session) },
            onSend: { text in
                let sent = await onSend(session, text)
                if sent {
                    interactions[key] = Date()
                    // Straight on to the next card, so a run of commands is type, send, type.
                    focusNext(after: key, in: liveOrder, reader: reader)
                }
                return sent
            },
            onSetSize: { selectedSize in
                board.setSize(selectedSize, for: key)
                if selectedSize == .row && focus == key { focus = nil }
                saveBoard()
            },
            onTogglePin: {
                if board.isPinned(key) {
                    board.unpin(key)
                } else {
                    board.pin(key, atSlot: order.firstIndex(of: key) ?? 0)
                }
                saveBoard()
            },
            question: waiting.map { card in
                RemiQuestionCard(
                    model: card,
                    onAnswer: { onAnswer(card.machineID, card.sessionID, card.questionID, $0) },
                    onSubmit: { onSubmit(card.machineID, card.sessionID, card.questionID, $0) },
                    onCancel: { onCancel(card.machineID, card.sessionID, card.questionID) }
                )
            },
            extras: RemiBoardTileExtras(
                sizeChoices: presentation.sizeChoices,
                height: size.phoneCardHeight,
                preview: { AnyView(RemiBoardPreview(session: session, entries: entries)) },
                growsToContent: presentation.growsToContent,
                cornerResize: cornerResize(for: session, key: key, presentation: presentation)
            )
        )
    }

    private func cornerResize(
        for session: RemiSessionSummary,
        key: String,
        presentation: RemiBoardCardPresentation
    ) -> RemiBoardCornerResize? {
        guard presentation.isMultiColumn else { return nil }
        return RemiBoardCornerResize(
            widthTitle: RemiBoardCardResize.widthTitle(for: displayedSpan(for: session)),
            onDragChanged: { translation, topCorner in
                updateCardResizePreview(
                    for: key,
                    startingAt: effectiveSize(for: session),
                    startingSpan: displayedSpan(for: session),
                    translation: translation,
                    topCorner: topCorner
                )
            },
            onDragEnded: { translation, topCorner in
                finishCardResize(
                    for: key,
                    translation: translation,
                    topCorner: topCorner
                )
            },
            onDragCancelled: { topCorner in cancelCardResize(for: key, topCorner: topCorner) },
            onStep: { spanDirection, sizeDirection in
                stepCardResize(
                    for: session,
                    key: key,
                    spanDirection: spanDirection,
                    sizeDirection: sizeDirection
                )
            }
        )
    }

    private func updateCardResizePreview(
        for key: String,
        startingAt fallbackSize: RemiTileSize,
        startingSpan fallbackSpan: Int,
        translation: CGSize,
        topCorner: Bool
    ) -> Bool {
        let activeDrag = cardResizeDrags[key]
        if let activeDrag, activeDrag.topCorner != topCorner { return false }
        var drag = activeDrag ?? CardResizeDrag(
            startSize: fallbackSize,
            previewSize: fallbackSize,
            startSpan: fallbackSpan,
            previewSpan: fallbackSpan,
            columnWidth: columnLayout.cardWidth,
            columnCount: columnLayout.columnCount,
            topCorner: topCorner
        )
        guard drag.topCorner == topCorner else { return false }
        let next = RemiBoardCardResize.adjustment(
            startingAt: drag.startSize,
            span: drag.startSpan,
            translation: translation,
            topCorner: topCorner,
            columnWidth: drag.columnWidth,
            spacing: RemiBoardColumns.spacing,
            columnCount: drag.columnCount
        )
        guard next.size != drag.previewSize || next.span != drag.previewSpan else {
            if activeDrag == nil { cardResizeDrags[key] = drag }
            return true
        }
        drag.previewSize = next.size
        drag.previewSpan = next.span
        withAnimation(reduceMotion ? nil : RemiTheme.Motion.standard) {
            cardResizeDrags[key] = drag
        }
        return true
    }

    private func finishCardResize(
        for key: String,
        translation: CGSize,
        topCorner: Bool
    ) {
        guard let drag = cardResizeDrags[key], drag.topCorner == topCorner else { return }
        let final = RemiBoardCardResize.adjustment(
            startingAt: drag.startSize,
            span: drag.startSpan,
            translation: translation,
            topCorner: topCorner,
            columnWidth: drag.columnWidth,
            spacing: RemiBoardColumns.spacing,
            columnCount: drag.columnCount
        )
        let sizeChanged = final.size != drag.startSize
        let spanChanged = final.span != drag.startSpan
        withAnimation(reduceMotion ? nil : RemiTheme.Motion.standard) {
            cardResizeDrags[key] = nil
            if sizeChanged { board.setSize(final.size, for: key) }
            if spanChanged { board.setSpan(final.span, for: key) }
            if final.size == .row && focus == key { focus = nil }
        }
        if sizeChanged || spanChanged { saveBoard() }
    }

    private func cancelCardResize(for key: String, topCorner: Bool) {
        guard let drag = cardResizeDrags[key], drag.topCorner == topCorner else { return }
        withAnimation(reduceMotion ? nil : RemiTheme.Motion.standard) {
            cardResizeDrags[key] = nil
        }
    }

    private func stepCardResize(
        for session: RemiSessionSummary,
        key: String,
        spanDirection: Int,
        sizeDirection: Int
    ) {
        guard cardResizeDrags[key] == nil else { return }
        let currentSize = displayedSize(for: session)
        let nextSize = RemiBoardCardResize.step(from: currentSize, direction: sizeDirection)
        let currentSpan = displayedSpan(for: session)
        let nextSpan = RemiBoardCardResize.step(
            span: currentSpan,
            direction: spanDirection,
            columnCount: columnLayout.columnCount
        )
        let sizeChanged = nextSize != currentSize
        let spanChanged = nextSpan != currentSpan
        guard sizeChanged || spanChanged else { return }
        withAnimation(reduceMotion ? nil : RemiTheme.Motion.standard) {
            if sizeChanged { board.setSize(nextSize, for: key) }
            if spanChanged { board.setSpan(nextSpan, for: key) }
            if nextSize == .row && focus == key { focus = nil }
        }
        saveBoard()
    }

    // MARK: chrome

    private var densityMenu: some View {
        Menu {
            Picker("Card size", selection: Binding(get: { density }, set: { size in
                board.clearSizes()
                saveBoard()
                densityStorage = size.rawValue
            })) {
                ForEach(RemiTileSize.phoneDensities, id: \.self) { size in
                    Text(size.densityTitle).tag(size)
                }
            }
            if RemiBoardCardPresentation(columnCount: columnLayout.columnCount).isMultiColumn,
               board.hasExplicitSizes || board.hasExplicitSpans
            {
                Button("Reset card sizes and widths", systemImage: "arrow.counterclockwise") {
                    board.clearSizes()
                    board.clearSpans()
                    saveBoard()
                }
                .help(
                    "The toolbar size sets every card. Reset removes per-card sizes and widths."
                )
            }
        } label: {
            Label("Card size", systemImage: "rectangle.grid.1x2")
        }
    }

    private var overflowMenu: some View {
        Menu {
            if canCreateSession {
                Button("Add machine", systemImage: "desktopcomputer.and.arrow.down", action: onPresentPairing)
            }
            Button("Preferences", systemImage: "gearshape", action: onPresentPreferences)
        } label: {
            Label("More", systemImage: "ellipsis.circle")
        }
    }

    private var liveSessions: [RemiSessionSummary] { sessions.filter(\.isLive) }
    private var finishedCount: Int { sessions.count { !$0.isLive } }
    private var needsYouCount: Int { sessions.count { $0.status == .needsYou } }

    private var chips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: RemiTheme.Spacing.xs) {
                chip("All", count: liveSessions.count, selected: machineFilter == nil && !onlyNeedsYou) {
                    machineFilter = nil
                    onlyNeedsYou = false
                }
                chip("Needs you", count: needsYouCount, selected: onlyNeedsYou, highlight: needsYouCount > 0) {
                    onlyNeedsYou.toggle()
                }
                ForEach(machines) { machine in
                    chip(
                        machine.name,
                        count: liveSessions.count { $0.machineID == machine.id },
                        selected: machineFilter == machine.id
                    ) {
                        machineFilter = machineFilter == machine.id ? nil : machine.id
                    }
                }
                if finishedCount > 0 {
                    chip("Finished", count: finishedCount, selected: showFinished) { showFinished.toggle() }
                }
            }
        }
        .scrollBounceBehavior(.basedOnSize)
    }

    private func chip(
        _ title: String, count: Int, selected: Bool, highlight: Bool = false, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: RemiTheme.Spacing.xxs) {
                Text(title).lineLimit(1)
                Text("\(count)").foregroundStyle(.secondary).monospacedDigit()
            }
            .font(.subheadline.weight(selected ? .semibold : .regular))
            .padding(.horizontal, RemiTheme.Spacing.s)
            .frame(minHeight: RemiTheme.Size.minimumTapTarget)
            .background(
                selected ? AnyShapeStyle(RemiTheme.Color.attention.opacity(0.35))
                    : highlight ? AnyShapeStyle(RemiTheme.Color.attention.opacity(0.18))
                    : AnyShapeStyle(RemiTheme.Color.surface),
                in: Capsule()
            )
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    @ViewBuilder private var emptyState: some View {
        if machines.isEmpty {
            FirstRunScreen(onAddMachine: onPresentPairing)
        } else if !canCreateSession && !onlyNeedsYou {
            ContentUnavailableView {
                Label("No machine is connected", systemImage: "desktopcomputer.trianglebadge.exclamationmark")
            } description: {
                Text("Sessions appear here once a machine connects. You can also add another machine.")
            } actions: {
                Button("Add a machine", systemImage: "desktopcomputer.and.arrow.down", action: onPresentPairing)
                    .buttonStyle(.glassProminent)
                    .controlSize(.large)
            }
            .padding(.top, RemiTheme.Spacing.xl)
        } else {
            noSessionsState
        }
    }

    private var noSessionsState: some View {
        ContentUnavailableView(
            onlyNeedsYou ? "Nothing needs you" : "No active sessions",
            systemImage: onlyNeedsYou ? "checkmark.circle" : "rectangle.3.group",
            description: Text(
                onlyNeedsYou ? "Every session is working or idle."
                    : "Start a session with the plus button, and it appears here."
            )
        )
        .padding(.top, RemiTheme.Spacing.xl)
    }

    // MARK: persistence

    private func loadBoard() {
        guard !boardLoaded else { return }
        boardLoaded = true
        let storedBoard = RemiBoardState(storage: boardStorage)
        board = storedBoard == RemiBoardState() ? (initialBoard ?? storedBoard) : storedBoard
    }

    private func saveBoard() { boardStorage = board.storageValue }
}

/// The state a grace-period task is keyed on, so it restarts when a machine enters or leaves the
/// loaded set, or a grace period ends.
private struct GraceWindow: Hashable {
    let loadedAt: [String: Date]
    let tick: Int
}

@MainActor private func boardPreviewScreen(mixedSizes: Bool = false) -> some View {
    let templates = RemiPreviewData.sessions.filter(\.isLive)
    let sessions = (0..<8).map { index in
        let template = templates[index % templates.count]
        return RemiSessionSummary(
            id: "board-preview-\(index + 1)",
            machineID: template.machineID,
            machineIdentityID: template.machineIdentityID,
            machineName: template.machineName,
            name: "\(template.name) \(index + 1)",
            harness: template.harness,
            project: template.project,
            projectPath: template.projectPath,
            lastActivity: template.lastActivity,
            status: template.status,
            lastMessage: template.lastMessage,
            openQuestionCount: template.openQuestionCount,
            isLive: true,
            canTerminate: template.canTerminate
        )
    }
    var previewBoard = RemiBoardState()
    if mixedSizes {
        previewBoard.setSize(.large, for: RemiBoardOrder.key(for: sessions[0]))
        previewBoard.setSize(.row, for: RemiBoardOrder.key(for: sessions[1]))
        previewBoard.setSize(.regular, for: RemiBoardOrder.key(for: sessions[2]))
    }
    return PhoneBoardScreen(
        sessions: sessions,
        machines: RemiPreviewData.machines,
        loadedMachines: [],
        questions: [],
        errorMessage: nil,
        noticeMessage: nil,
        transcript: { _ in
            [
                .user(id: "u", text: "Run the suite and fix whatever fails."),
                .agent(id: "a", text: "All tests pass. Opening the pull request next."),
            ]
        },
        onAnswer: { _, _, _, _ in },
        onSubmit: { _, _, _, _ in },
        onCancel: { _, _, _ in },
        onOpen: { _ in },
        onSend: { _, _ in true },
        canCreateSession: true,
        onNewSession: {},
        onPresentPairing: {},
        onPresentPreferences: {},
        onManageMachines: {},
        onDismissError: {},
        onDismissNotice: {},
        initialBoard: mixedSizes ? previewBoard : nil
    )
}

#Preview("Board") {
    NavigationStack {
        boardPreviewScreen()
    }
}

#Preview("Board, 466 pt pane") {
    NavigationStack {
        boardPreviewScreen()
    }
    .frame(width: 466)
}

#Preview("Board, 744 pt pane") {
    NavigationStack {
        boardPreviewScreen()
    }
    .frame(width: 744)
}

#Preview("Board, 1032 pt pane") {
    NavigationStack {
        boardPreviewScreen()
    }
    .frame(width: 1_032)
}

#Preview("Board, 1032 pt pane, mixed sizes") {
    NavigationStack {
        boardPreviewScreen(mixedSizes: true)
    }
    .frame(width: 1_032)
}

#Preview("Board, 1376 pt pane") {
    NavigationStack {
        boardPreviewScreen()
    }
    .frame(width: 1_376)
}
