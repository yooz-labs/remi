import RemiKit
import RemiUI
import SwiftUI

/// The Mac landing view: every session on every machine as a tile, ordered by how much it
/// needs the person, with a line on each to answer from in place.
///
/// The board never moves while you are writing: with a composer focused or a draft waiting,
/// every tile keeps its place, and the order refreshes when you stop.
struct MacCommandCenter: View {
    let sessions: [RemiSessionSummary]
    let machines: [RemiMachineSummary]
    let questions: [RemiQuestionCardModel]
    /// The latest conversation entries of a session, for its tile.
    let transcript: (RemiSessionSummary) -> [RemiTranscriptEntry]
    let onAnswer: (_ machineID: String, _ sessionID: String, _ questionID: String, _ value: String) -> Void
    let onSubmit: (_ machineID: String, _ sessionID: String, _ questionID: String, [RemiQuestionStepSelection]) -> Void
    let onCancel: (_ machineID: String, _ sessionID: String, _ questionID: String) -> Void
    let onOpen: (RemiSessionSummary) -> Void
    let onSend: (RemiSessionSummary, String) async -> Bool

    @AppStorage("remi.mac.board") private var boardStorage = ""
    @State private var board = RemiBoardState()
    @State private var boardLoaded = false
    @State private var interactions: [String: Date] = [:]
    @State private var drafts: [String: String] = [:]
    @State private var shownOrder: [String] = []
    @State private var machineFilter: String?
    @State private var onlyNeedsYou = false
    @State private var showFinished = false
    @FocusState private var focus: String?

    private let spacing = RemiTheme.Spacing.s
    private let margin = RemiTheme.Spacing.m

    var body: some View {
        VStack(spacing: 0) {
            filterBar
            if filtered.isEmpty {
                emptyState
            } else {
                TimelineView(.periodic(from: .now, by: 30)) { timeline in
                    boardScroll(now: timeline.date)
                }
            }
        }
        .onAppear(perform: loadBoard)
        .onChange(of: sessions.map(RemiBoardOrder.key(for:))) { pruneBoard() }
        .onChange(of: connectedMachines) { pruneBoard() }
    }

    private var connectedMachines: Set<String> {
        Set(machines.filter { $0.reachability == .connected }.map(\.id))
    }

    /// Forgets pins and sizes of sessions a connected machine no longer lists. Every session
    /// counts as live here, finished ones too, so showing them again finds their pins.
    private func pruneBoard() {
        let live = Set(sessions.map(RemiBoardOrder.key(for:)))
        if board.prune(live: live, connectedMachines: connectedMachines) { saveBoard() }
        // A draft or a recent interaction of a session that is gone would linger for good.
        drafts = drafts.filter { live.contains($0.key) }
        interactions = interactions.filter { live.contains($0.key) }
    }

    // MARK: filtering

    private var filtered: [RemiSessionSummary] {
        RemiBoardOrder.visible(sessions, machineID: machineFilter, onlyNeedsYou: onlyNeedsYou, showFinished: showFinished)
    }

    private var liveSessions: [RemiSessionSummary] { sessions.filter(\.isLive) }
    private var finishedCount: Int { sessions.count { !$0.isLive } }
    private var needsYouCount: Int { sessions.count { $0.status == .needsYou } }

    /// Plain chips when they fit, a scrolling row when many machines do not. A scroll view at the
    /// top of the window sits under the toolbar's edge blur, which washed the chips out.
    private var filterBar: some View {
        ViewThatFits(in: .horizontal) {
            chips
            ScrollView(.horizontal, showsIndicators: false) { chips }
        }
        .padding(.horizontal, margin)
        .padding(.vertical, RemiTheme.Spacing.xs)
    }

    private var chips: some View {
        HStack(spacing: RemiTheme.Spacing.xs) {
            chip("All", count: liveSessions.count, selected: machineFilter == nil && !onlyNeedsYou) {
                machineFilter = nil
                onlyNeedsYou = false
            }
            chip("Needs you", count: needsYouCount, selected: onlyNeedsYou, highlight: needsYouCount > 0) {
                onlyNeedsYou.toggle()
            }
            Divider().frame(height: 16)
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
                Divider().frame(height: 16)
                chip("Finished", count: finishedCount, selected: showFinished) { showFinished.toggle() }
            }
        }
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
            .padding(.vertical, RemiTheme.Spacing.xxs + 1)
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

    private var emptyState: some View {
        ContentUnavailableView(
            onlyNeedsYou ? "Nothing needs you" : "No sessions",
            systemImage: onlyNeedsYou ? "checkmark.circle" : "rectangle.3.group",
            description: Text(
                onlyNeedsYou ? "Every session is working or idle."
                    : "Start a session with New session, and it appears here."
            )
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: board

    private func arranged(now: Date) -> [RemiSessionSummary] {
        // Only tiles on screen with a composer count: a draft left on a hidden or finished
        // tile must not freeze the board.
        let composerKeys = Set(filtered.filter(\.isLive).map(RemiBoardOrder.key(for:)))
        let writing = RemiBoardOrder.isWriting(hasFocus: focus != nil, drafts: drafts, composerKeys: composerKeys)
        let held = writing ? RemiBoardOrder.held(from: shownOrder) : [:]
        return RemiBoardOrder.arrange(filtered, state: board, interactions: interactions, held: held, now: now)
    }

    private func boardScroll(now: Date) -> some View {
        let ordered = arranged(now: now)
        return GeometryReader { proxy in
            let count = RemiBoardOrder.columnCount(width: proxy.size.width - 2 * margin, spacing: spacing)
            let packed = RemiBoardOrder.columns(
                heights: ordered.map { board.size(for: RemiBoardOrder.key(for: $0)).estimatedHeight },
                count: count,
                spacing: spacing
            )
            ScrollView {
                HStack(alignment: .top, spacing: spacing) {
                    ForEach(packed.indices, id: \.self) { column in
                        LazyVStack(spacing: spacing) {
                            ForEach(packed[column], id: \.self) { index in
                                tile(ordered[index], order: ordered.map(RemiBoardOrder.key(for:)))
                            }
                        }
                    }
                }
                .padding(margin)
                .animation(RemiTheme.Motion.standard, value: ordered.map(RemiBoardOrder.key(for:)))
            }
            .onChange(of: ordered.map(RemiBoardOrder.key(for:)), initial: true) { _, keys in shownOrder = keys }
        }
    }

    private func tile(_ session: RemiSessionSummary, order: [String]) -> some View {
        let key = RemiBoardOrder.key(for: session)
        let waiting = questions.first {
            $0.machineID == session.machineID && $0.sessionID == session.id && $0.state == .pending
        }
        return RemiBoardTile(
            session: session,
            tileKey: key,
            size: board.size(for: key),
            isPinned: board.isPinned(key),
            entries: transcript(session),
            draft: Binding(get: { drafts[key] ?? "" }, set: { drafts[key] = $0 }),
            focus: $focus,
            onOpen: { onOpen(session) },
            onSend: { text in
                let sent = await onSend(session, text)
                if sent {
                    interactions[key] = Date()
                    // Straight on to the next tile, so a run of commands is type, Return, type.
                    focus = RemiBoardOrder.next(after: key, in: order)
                }
                return sent
            },
            onSetSize: { size in
                board.setSize(size, for: key)
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
            dragPayload: RemiBoardOrder.payload(for: key),
            question: waiting.map { card in
                RemiQuestionCard(
                    model: card,
                    onAnswer: { onAnswer(card.machineID, card.sessionID, card.questionID, $0) },
                    onSubmit: { onSubmit(card.machineID, card.sessionID, card.questionID, $0) },
                    onCancel: { onCancel(card.machineID, card.sessionID, card.questionID) }
                )
            }
        )
        .dropDestination(for: String.self) { dropped, _ in
            // Only a tile's own payload moves anything, and only a tile still on the board.
            guard let payload = dropped.first, let moved = RemiBoardOrder.key(fromPayload: payload),
                  moved != key, order.contains(moved)
            else { return false }
            board.move(moved, onto: key, in: order)
            saveBoard()
            return true
        }
    }

    // MARK: persistence

    private func loadBoard() {
        guard !boardLoaded else { return }
        boardLoaded = true
        board = RemiBoardState(storage: boardStorage)
    }

    private func saveBoard() { boardStorage = board.storageValue }
}

#Preview("Board") {
    MacCommandCenter(
        sessions: RemiPreviewData.sessions,
        machines: RemiPreviewData.machines,
        questions: [],
        transcript: { _ in [.agent(id: "a", text: "Running the tests."), .tool(id: "t", name: "Bash", summary: "swift test")] },
        onAnswer: { _, _, _, _ in },
        onSubmit: { _, _, _, _ in },
        onCancel: { _, _, _ in },
        onOpen: { _ in },
        onSend: { _, _ in true }
    )
    .frame(width: 1_100, height: 760)
}
