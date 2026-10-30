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
    /// Machines that are connected, have loaded their session list and have had time for the
    /// per-session daemons to be listed too. Only these may have layout state pruned: a machine
    /// that just reconnected lists no sessions yet, and that is not the sessions being gone.
    let settledMachines: Set<String>
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
    @State private var gesturePreview: BoardGesturePreview?
    @FocusState private var focus: String?
    @State private var focusTask: Task<Void, Never>?

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
        .onChange(of: settledMachines) { pruneBoard() }
    }

    /// Forgets layout state of sessions a settled machine no longer lists. Every session counts
    /// as live here, finished ones too, so showing them again finds their saved layout.
    private func pruneBoard() {
        let live = Set(sessions.map(RemiBoardOrder.key(for:)))
        if board.prune(live: live, connectedMachines: settledMachines) { saveBoard() }
        // A draft or a recent interaction of a session that is gone would linger for good.
        drafts = RemiBoardOrder.keeping(drafts, live: live, settledMachines: settledMachines)
        interactions = RemiBoardOrder.keeping(interactions, live: live, settledMachines: settledMachines)
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
            Button("Reset layout", systemImage: "arrow.uturn.backward") {
                board.resetLayout()
                gesturePreview = nil
                saveBoard()
            }
            .buttonStyle(.borderless)
            .help("Return all cards to the automatic layout")
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

    private func boardOrder(now: Date) -> (all: [RemiSessionSummary], visible: [RemiSessionSummary], held: [String: Int]) {
        // Only tiles on screen with a composer count: a draft left on a hidden or finished
        // tile must not freeze the board.
        let composerKeys = Set(filtered.filter(\.isLive).map(RemiBoardOrder.key(for:)))
        let writing = RemiBoardOrder.isWriting(hasFocus: focus.map { composerKeys.contains($0) } ?? false, drafts: drafts, composerKeys: composerKeys)
        let held = writing ? RemiBoardOrder.held(from: shownOrder) : [:]
        let all = RemiBoardOrder.arrange(sessions, state: board, interactions: interactions, held: held, now: now)
        let visibleKeys = Set(filtered.map(RemiBoardOrder.key(for:)))
        return (all, all.filter { visibleKeys.contains(RemiBoardOrder.key(for: $0)) }, held)
    }

    /// A tile and its stable machine/session key. The canvas keeps each tile's local state with
    /// that identity as ordering changes, instead of attaching it to a screen position.
    private struct BoardItem: Identifiable {
        let key: String
        let session: RemiSessionSummary
        let frame: RemiBoardFrame
        var id: String { key }
    }

    private enum BoardGestureKind: Equatable { case move, resize }

    private struct BoardGesturePreview: Equatable {
        let key: String
        let kind: BoardGestureKind
        let start: RemiBoardFrame
        let proposed: RemiBoardFrame
        let lastValid: RemiBoardFrame
        let isValid: Bool
    }

    private func boardScroll(now: Date) -> some View {
        GeometryReader { proxy in
            boardViewport(size: proxy.size, now: now)
        }
    }

    private func boardViewport(size: CGSize, now: Date) -> some View {
        let ordering = boardOrder(now: now)
        let allKeys = ordering.all.map(RemiBoardOrder.key(for:))
        let orderedKeys = ordering.visible.map(RemiBoardOrder.key(for:))
        // The cursor goes only to a tile with a working composer.
        let liveKeys = ordering.visible.filter(\.isLive).map(RemiBoardOrder.key(for:))
        let frames = RemiBoardOrder.layout(
            sessions,
            state: board,
            interactions: interactions,
            held: ordering.held,
            now: now,
            viewportWidth: size.width,
            spacing: spacing,
            margin: margin
        )
        let items = ordering.visible.compactMap { session -> BoardItem? in
            let key = RemiBoardOrder.key(for: session)
            guard let frame = frames[key] else { return nil }
            return BoardItem(key: key, session: session, frame: frame)
        }
        var canvasFrames = Dictionary(uniqueKeysWithValues: items.map { ($0.key, $0.frame) })
        if let preview = gesturePreview {
            let frame = preview.proposed
            if frame.x.isFinite && frame.y.isFinite && frame.width.isFinite && frame.height.isFinite {
                canvasFrames["__gesture-preview__"] = RemiBoardFrame(
                    x: min(max(frame.x, 0), RemiBoardFrame.maximumCoordinate),
                    y: min(max(frame.y, 0), RemiBoardFrame.maximumCoordinate),
                    width: min(max(frame.width, RemiBoardFrame.minimumWidth), RemiBoardFrame.maximumWidth),
                    height: min(max(frame.height, RemiBoardFrame.minimumHeight), RemiBoardFrame.maximumHeight)
                )
            }
        }
        let canvasSize = RemiBoardOrder.canvasSize(visibleFrames: canvasFrames, viewport: size, margin: margin)

        return ScrollViewReader { reader in
            ScrollView([.horizontal, .vertical]) {
                boardCanvas(
                    items: items,
                    frames: frames,
                    canvasSize: canvasSize,
                    // Pin slots are stored against the same full order that lays out the canvas,
                    // so pinning from a filtered view cannot reposition a tile when the filter clears.
                    order: allKeys,
                    liveOrder: liveKeys,
                    reader: reader
                )
            }
            .scrollIndicators(.visible)
        }
        .onChange(of: allKeys, initial: true) { _, keys in shownOrder = keys }
    }

    private func boardCanvas(
        items: [BoardItem],
        frames: [String: RemiBoardFrame],
        canvasSize: CGSize,
        order: [String],
        liveOrder: [String],
        reader: ScrollViewProxy
    ) -> some View {
        ZStack(alignment: .topLeading) {
            ForEach(items) { item in
                tile(
                    item.session,
                    frame: item.frame,
                    frames: frames,
                    order: order,
                    liveOrder: liveOrder,
                    reader: reader
                )
                .id(item.key)
                .offset(x: item.frame.x, y: item.frame.y)
            }
            if let gesturePreview {
                gestureOutline(gesturePreview)
            }
        }
        .frame(width: canvasSize.width, height: canvasSize.height, alignment: .topLeading)
    }

    private func gestureOutline(_ preview: BoardGesturePreview) -> some View {
        RoundedRectangle(cornerRadius: RemiTheme.Radius.control)
            .fill((preview.isValid ? RemiTheme.Color.activityDot : Color.red).opacity(0.08))
            .overlay {
                RoundedRectangle(cornerRadius: RemiTheme.Radius.control)
                    .stroke(
                        preview.isValid ? RemiTheme.Color.activityDot : Color.red,
                        style: StrokeStyle(lineWidth: 2, dash: [6, 4])
                    )
            }
            .frame(width: preview.proposed.width, height: preview.proposed.height)
            .offset(
                x: min(max(preview.proposed.x, 0), RemiBoardFrame.maximumCoordinate),
                y: min(max(preview.proposed.y, 0), RemiBoardFrame.maximumCoordinate)
            )
            .accessibilityHidden(true)
            .allowsHitTesting(false)
    }

    /// Moves the cursor to the next live tile, scrolling it into view before moving focus.
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

    private func tile(
        _ session: RemiSessionSummary,
        frame: RemiBoardFrame,
        frames: [String: RemiBoardFrame],
        order: [String],
        liveOrder: [String],
        reader: ScrollViewProxy
    ) -> some View {
        let key = RemiBoardOrder.key(for: session)
        let waiting = questions.first {
            $0.machineID == session.machineID && $0.sessionID == session.id && $0.state == .pending
        }
        let placement = RemiBoardTilePlacement(
            size: CGSize(width: frame.width, height: frame.height),
            onMoveDrag: { translation, ended in
                updateGesture(key: key, kind: .move, translation: translation, ended: ended, frames: frames)
            },
            onResizeDrag: { translation, ended in
                updateGesture(key: key, kind: .resize, translation: translation, ended: ended, frames: frames)
            },
            onMoveBy: { nudge(key: key, kind: .move, by: $0, frames: frames) },
            onResizeBy: { nudge(key: key, kind: .resize, by: $0, frames: frames) }
        )
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
                    focusNext(after: key, in: liveOrder, reader: reader)
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
            question: waiting.map { card in
                RemiQuestionCard(
                    model: card,
                    onAnswer: { onAnswer(card.machineID, card.sessionID, card.questionID, $0) },
                    onSubmit: { onSubmit(card.machineID, card.sessionID, card.questionID, $0) },
                    onCancel: { onCancel(card.machineID, card.sessionID, card.questionID) }
                )
            },
            extras: RemiBoardTileExtras(placement: placement)
        )
    }

    private func nudge(
        key: String,
        kind: BoardGestureKind,
        by delta: CGSize,
        frames: [String: RemiBoardFrame]
    ) {
        guard let start = frames[key] else { return }
        let proposal = kind == .move ? start.moved(by: delta) : start.resized(by: delta)
        guard RemiBoardOrder.canPlace(proposal, for: key, in: frames), board.setFrame(proposal, for: key) else { return }
        saveBoard()
    }

    private func updateGesture(
        key: String,
        kind: BoardGestureKind,
        translation: CGSize,
        ended: Bool,
        frames: [String: RemiBoardFrame]
    ) {
        let active = gesturePreview.flatMap { $0.key == key && $0.kind == kind ? $0 : nil }
        guard let start = active?.start ?? frames[key] else { return }
        let proposed = kind == .move ? start.moved(by: translation) : start.resized(by: translation)
        let isValid = RemiBoardOrder.canPlace(proposed, for: key, in: frames)
        let lastValid = isValid ? proposed : (active?.lastValid ?? start)

        if ended {
            if lastValid != start, board.setFrame(lastValid, for: key) { saveBoard() }
            gesturePreview = nil
        } else {
            gesturePreview = BoardGesturePreview(
                key: key,
                kind: kind,
                start: start,
                proposed: proposed,
                lastValid: lastValid,
                isValid: isValid
            )
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

private struct MacBoardPreviewScene: View {
    var width: CGFloat = 1_100
    var height: CGFloat = 760
    var colorScheme: ColorScheme = .light
    var dynamicTypeSize: DynamicTypeSize = .large

    var body: some View {
        MacCommandCenter(
            sessions: RemiPreviewData.sessions,
            machines: RemiPreviewData.machines,
            settledMachines: [],
            questions: [RemiQuestionCardModel(
                id: "board-preview-question",
                kind: .permission,
                text: "Allow the test runner to update the native UI snapshots?",
                detail: "The command will update the checked in preview snapshots for the Mac Board.",
                machineID: "studio",
                machineName: "Studio",
                sessionID: "1",
                sessionName: "Native iOS",
                options: [
                    RemiQuestionOption(id: "yes", label: "Yes", role: .allow, isRecommended: true),
                    RemiQuestionOption(id: "no", label: "No", role: .deny),
                ]
            )],
            transcript: { _ in
                [
                    .user(id: "u", text: "Run the suite and report any failures."),
                    .agent(id: "a", text: "The focused suite is green. I am checking the native views next."),
                    .tool(id: "t", name: "Bash", summary: "swift test --filter RemiBoardTests"),
                ]
            },
            onAnswer: { _, _, _, _ in },
            onSubmit: { _, _, _, _ in },
            onCancel: { _, _, _ in },
            onOpen: { _ in },
            onSend: { _, _ in true }
        )
        .frame(width: width, height: height)
        .preferredColorScheme(colorScheme)
        .environment(\.dynamicTypeSize, dynamicTypeSize)
    }
}

#Preview("Board · Standard · Light") { MacBoardPreviewScene() }
#Preview("Board · Narrow · Light") { MacBoardPreviewScene(width: 760) }
#Preview("Board · Standard · Dark") { MacBoardPreviewScene(colorScheme: .dark) }
#Preview("Board · Accessibility") { MacBoardPreviewScene(dynamicTypeSize: .accessibility5) }
