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
    let questions: [RemiQuestionCardModel]
    let errorMessage: String?
    let noticeMessage: String?
    let transcript: (RemiSessionSummary) -> [RemiTranscriptEntry]
    let onAnswer: (String, String, String, String) -> Void
    let onSubmit: (String, String, String, [RemiQuestionStepSelection]) -> Void
    let onCancel: (String, String, String) -> Void
    let onOpen: (RemiSessionSummary) -> Void
    let onSend: (RemiSessionSummary, String) async -> Bool
    let onNewSession: () -> Void
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
    @FocusState private var focus: String?

    private var density: RemiTileSize { RemiTileSize.phoneDensity(stored: densityStorage) }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { timeline in
            content(now: timeline.date)
        }
        .navigationTitle("Board")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { densityMenu }
            ToolbarItem(placement: .topBarTrailing) {
                Button("New session", systemImage: "plus", action: onNewSession)
            }
        }
        .onAppear(perform: loadBoard)
        .onChange(of: sessions.map(RemiBoardOrder.key(for:))) { _, keys in
            if board.prune(live: Set(keys), connectedMachines: []) { saveBoard() }
        }
    }

    // MARK: list

    private func content(now: Date) -> some View {
        let ordered = arranged(now: now)
        let order = ordered.map(RemiBoardOrder.key(for:))
        return ScrollView {
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
                    ForEach(ordered) { session in tile(session, order: order) }
                }
            }
            .padding(RemiTheme.Spacing.m)
            .remiReadableScrollColumn()
            .animation(RemiTheme.Motion.standard, value: order)
        }
        .scrollDismissesKeyboard(.interactively)
        .onChange(of: order, initial: true) { _, keys in shownOrder = keys }
    }

    private func arranged(now: Date) -> [RemiSessionSummary] {
        let writing = focus != nil || drafts.values.contains { !$0.isEmpty }
        let held: [String: Int] = writing
            ? Dictionary(uniqueKeysWithValues: shownOrder.enumerated().map { ($1, $0) })
            : [:]
        let visible = RemiBoardOrder.visible(
            sessions, machineID: machineFilter, onlyNeedsYou: onlyNeedsYou, showFinished: showFinished
        )
        return RemiBoardOrder.arrange(visible, state: board, interactions: interactions, held: held, now: now)
    }

    private func tile(_ session: RemiSessionSummary, order: [String]) -> some View {
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
                    focus = RemiBoardOrder.next(after: key, in: order)
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
            .frame(minHeight: RemiTheme.Size.minimumTapTarget - 8)
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

#Preview("Board") {
    NavigationStack {
        PhoneBoardScreen(
            sessions: RemiPreviewData.sessions,
            machines: RemiPreviewData.machines,
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
            onNewSession: {},
            onManageMachines: {},
            onDismissError: {},
            onDismissNotice: {}
        )
    }
}
