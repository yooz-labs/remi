import RemiKit
import RemiUI
import SwiftUI

/// The phone's landing view: every active session as a card, in the density the person chose
/// (compact, medium or long, like a mail list). A card can be typed into in place, a long press
/// previews the conversation, and the cards that need the person come first.
///
/// The list never reorders while you are writing: with a field focused or a draft waiting,
/// every card keeps its place, and the order refreshes when you stop.
struct PhoneBoardScreen: View {
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

    @AppStorage("remi.phone.board") private var boardStorage = ""
    @AppStorage("remi.phone.board.density") private var densityStorage = RemiTileSize.regular.rawValue
    @State private var board = RemiBoardState()
    @State private var boardLoaded = false
    @State private var interactions: [String: Date] = [:]
    @State private var drafts: [String: String] = [:]
    @State private var shownOrder: [String] = []
    @State private var machineFilter: String?
    @State private var onlyNeedsYou = false
    @State private var showFinished = false
    /// When each loaded machine entered `loadedMachines`, for the settling grace period.
    @State private var loadedAt: [String: Date] = [:]
    @State private var graceTick = 0
    @FocusState private var focus: String?
    @State private var focusTask: Task<Void, Never>?

    private var density: RemiTileSize { RemiTileSize.phoneDensity(stored: densityStorage) }

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

    /// Forgets pins and sizes of sessions a settled machine no longer lists, and drafts and
    /// interactions of sessions that are gone. Every session counts as live here, finished ones
    /// too, so showing them again finds their pins. Saves only when something was removed.
    private func pruneBoard() {
        let live = Set(sessions.map(RemiBoardOrder.key(for:)))
        let now = Date()
        let settled = Set(loadedMachines.filter {
            RemiLastThreads.isSettled(connectedAt: loadedAt[$0], now: now)
        })
        if board.prune(live: live, connectedMachines: settled) { saveBoard() }
        drafts = drafts.filter { live.contains($0.key) }
        interactions = interactions.filter { live.contains($0.key) }
    }

    // MARK: list

    private func content(now: Date) -> some View {
        let ordered = arranged(now: now)
        let order = ordered.map(RemiBoardOrder.key(for:))
        // The cursor goes only to a tile with a working composer, and in the compact density
        // there are none.
        let liveOrder = density.showsComposer ? ordered.filter(\.isLive).map(RemiBoardOrder.key(for:)) : []
        return ScrollViewReader { reader in
            boardScroll(ordered: ordered, order: order, liveOrder: liveOrder, reader: reader)
        }
        .onChange(of: order, initial: true) { _, keys in shownOrder = keys }
    }

    private func boardScroll(
        ordered: [RemiSessionSummary], order: [String], liveOrder: [String], reader: ScrollViewProxy
    ) -> some View {
        ScrollView {
            LazyVStack(spacing: RemiTheme.Spacing.s) {
                if let errorMessage {
                    RemiFeedbackBanner(message: errorMessage, tone: .error, onDismiss: onDismissError)
                }
                if let noticeMessage {
                    RemiFeedbackBanner(message: noticeMessage, tone: .information, onDismiss: onDismissNotice)
                }
                PhoneMachineProblemRows(machines: machines, onManage: onManageMachines)
                chips
                if ordered.isEmpty {
                    emptyState
                } else {
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
        .scrollDismissesKeyboard(.interactively)
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

    /// The tiles on screen that have a working composer: none in the compact density, which
    /// hides the composers. A draft left anywhere else must not freeze the order.
    private var composerKeys: Set<String> {
        density.showsComposer ? Set(filtered.filter(\.isLive).map(RemiBoardOrder.key(for:))) : []
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
        let waiting = questions.first {
            $0.machineID == session.machineID && $0.sessionID == session.id && $0.state == .pending
        }
        let entries = transcript(session)
        return RemiBoardTile(
            session: session,
            tileKey: key,
            size: density,
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
            extras: RemiBoardTileExtras(sizeChoices: [], height: density == .large ? 440 : 240) {
                AnyView(RemiBoardPreview(session: session, entries: entries))
            }
        )
    }

    // MARK: chrome

    private var densityMenu: some View {
        Menu {
            Picker("Card size", selection: Binding(get: { density }, set: { densityStorage = $0.rawValue })) {
                ForEach(RemiTileSize.phoneDensities, id: \.self) { size in
                    Text(size.densityTitle).tag(size)
                }
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
        board = RemiBoardState(storage: boardStorage)
    }

    private func saveBoard() { boardStorage = board.storageValue }
}

/// The state a grace-period task is keyed on, so it restarts when a machine enters or leaves the
/// loaded set, or a grace period ends.
private struct GraceWindow: Hashable {
    let loadedAt: [String: Date]
    let tick: Int
}

#Preview("Board") {
    NavigationStack {
        PhoneBoardScreen(
            sessions: RemiPreviewData.sessions,
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
            onDismissNotice: {}
        )
    }
}
