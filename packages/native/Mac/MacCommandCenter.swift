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
        .onChange(of: sessions.map(RemiBoardOrder.key(for:))) { _, keys in
            board.prune(keeping: Set(keys))
            saveBoard()
        }
    }

    // MARK: filtering

    private var filtered: [RemiSessionSummary] {
        sessions.filter { session in
            (machineFilter == nil || session.machineID == machineFilter)
                && (!onlyNeedsYou || session.status == .needsYou)
        }
    }

    private var needsYouCount: Int { sessions.count { $0.status == .needsYou } }

    private var filterBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: RemiTheme.Spacing.xs) {
                chip("All", count: sessions.count, selected: machineFilter == nil && !onlyNeedsYou) {
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
                        count: sessions.count { $0.machineID == machine.id },
                        selected: machineFilter == machine.id
                    ) {
                        machineFilter = machineFilter == machine.id ? nil : machine.id
                    }
                }
            }
            .padding(.horizontal, margin)
            .padding(.vertical, RemiTheme.Spacing.xs)
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
        let writing = focus != nil || drafts.values.contains { !$0.isEmpty }
        let held: [String: Int] = writing
            ? Dictionary(uniqueKeysWithValues: shownOrder.enumerated().map { ($1, $0) })
            : [:]
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
        return RemiBoardTile(
            session: session,
            tileKey: key,
            size: board.size(for: key),
            isPinned: board.isPinned(key),
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
            }
        )
        .draggable(key)
        .dropDestination(for: String.self) { dropped, _ in
            guard let moved = dropped.first, moved != key else { return false }
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
        onOpen: { _ in },
        onSend: { _, _ in true }
    )
    .frame(width: 1_100, height: 760)
}
