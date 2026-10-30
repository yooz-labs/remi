import SwiftUI

/// Optional direct-manipulation controls for a tile on the Mac command center.
/// The phone does not set these, so its card layout and gestures remain unchanged.
public struct RemiBoardTilePlacement {
    public var size: CGSize
    public var onMoveDrag: (_ translation: CGSize, _ ended: Bool) -> Void
    public var onResizeDrag: (_ translation: CGSize, _ ended: Bool) -> Void
    public var onMoveBy: (CGSize) -> Void
    public var onResizeBy: (CGSize) -> Void

    public init(
        size: CGSize,
        onMoveDrag: @escaping (_ translation: CGSize, _ ended: Bool) -> Void,
        onResizeDrag: @escaping (_ translation: CGSize, _ ended: Bool) -> Void,
        onMoveBy: @escaping (CGSize) -> Void,
        onResizeBy: @escaping (CGSize) -> Void
    ) {
        self.size = size
        self.onMoveDrag = onMoveDrag
        self.onResizeDrag = onResizeDrag
        self.onMoveBy = onMoveBy
        self.onResizeBy = onResizeBy
    }
}

/// Options a screen can set on a tile without the tile knowing the screen.
public struct RemiBoardTileExtras {
    /// The sizes the tile's menu offers; empty when the screen sets one density for every tile.
    public var sizeChoices: [RemiTileSize]
    /// What a long press previews, on platforms that have one.
    public var preview: (() -> AnyView)?
    /// A height for tiles that show the conversation, in place of the size's own
    /// ``RemiTileSize/estimatedHeight``. The size's heights (420 and 640) are made for the Mac's
    /// wide columns; a phone's one narrow column wraps text more and wants shorter cards (240
    /// and 440), so the phone screen sets its own. The tile scales it with the text size like
    /// its own heights, and a waiting question still grows the tile past it.
    public var height: CGFloat?
    /// Set only by the Mac board for continuous sizing and direct-manipulation affordances.
    public var placement: RemiBoardTilePlacement?

    public init(
        sizeChoices: [RemiTileSize] = [.compact, .regular, .large],
        height: CGFloat? = nil,
        preview: (() -> AnyView)? = nil,
        placement: RemiBoardTilePlacement? = nil
    ) {
        self.sizeChoices = sizeChoices
        self.height = height
        self.preview = preview
        self.placement = placement
    }
}

/// One session on the command center board: what it is, what it last said, whether it needs
/// the person, and a line to answer it from in place.
public struct RemiBoardTile<Question: View>: View {
    private let session: RemiSessionSummary
    private let tileKey: String
    private let size: RemiTileSize
    private let isPinned: Bool
    private let pendingMessageCount: Int
    /// The session's conversation so far; the tile shows the latest entries.
    private let entries: [RemiTranscriptEntry]
    @Binding private var draft: String
    private let focus: FocusState<String?>.Binding
    private let onOpen: () -> Void
    private let onSend: (String) async -> Bool
    private let onSetSize: (RemiTileSize) -> Void
    private let onTogglePin: () -> Void
    /// What dragging the tile's header carries (``RemiBoardOrder/payload(for:)``); nil makes the
    /// tile not draggable. Only the header drags, so selecting and dragging text in the
    /// conversation and the composer keep working.
    private let dragPayload: String?
    /// The session's waiting question, answered on the tile. Nil shows the plain notice.
    private let question: Question?
    private let extras: RemiBoardTileExtras

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var sendFailed = false
    /// A send is in flight: a second Return before it returns must not send the text again.
    @State private var sending = false
    /// Grows the tile's fixed heights with the reader's text size, so large type is not clipped.
    @ScaledMetric(relativeTo: .body) private var heightScale: CGFloat = 1
    /// The question's natural height, so its area is as tall as it needs up to a cap.
    @State private var questionHeight: CGFloat = 0
    @State private var moveHovered = false
    @State private var resizeHovered = false
    @FocusState private var focusedPlacementControl: PlacementControl?

    private enum PlacementControl: Hashable {
        case move
        case resize
    }

    public init(
        session: RemiSessionSummary,
        tileKey: String,
        size: RemiTileSize,
        isPinned: Bool,
        pendingMessageCount: Int = 0,
        entries: [RemiTranscriptEntry] = [],
        draft: Binding<String>,
        focus: FocusState<String?>.Binding,
        onOpen: @escaping () -> Void,
        onSend: @escaping (String) async -> Bool,
        onSetSize: @escaping (RemiTileSize) -> Void = { _ in },
        onTogglePin: @escaping () -> Void,
        dragPayload: String? = nil,
        question: Question? = nil,
        extras: RemiBoardTileExtras = RemiBoardTileExtras()
    ) {
        self.session = session
        self.tileKey = tileKey
        self.size = size
        self.isPinned = isPinned
        self.pendingMessageCount = pendingMessageCount
        self.entries = entries
        _draft = draft
        self.focus = focus
        self.onOpen = onOpen
        self.onSend = onSend
        self.onSetSize = onSetSize
        self.onTogglePin = onTogglePin
        self.dragPayload = dragPayload
        self.question = question
        self.extras = extras
    }

    private var needsYou: Bool { session.status == .needsYou }
    private var canSend: Bool {
        session.isLive && !sending && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Nil for a compact row, which is as tall as its line.
    private var tileHeight: CGFloat? {
        if let placement = extras.placement { return placement.size.height }
        return size.showsFeed ? (extras.height ?? size.estimatedHeight) * heightScale : nil
    }
    /// A waiting tile with its question on it grows to the question's content instead of
    /// holding the size's height, which a long question could overflow.
    private var growsToContent: Bool { needsYou && question != nil }

    public var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.xs) {
            if extras.placement == nil {
                draggable(header)
            } else {
                header
            }
            if size.showsFeed {
                conversation
                waitingQuestion
                footer
            } else {
                rowSummary
            }
            if size.showsComposer { quickComposer }
        }
        .padding(RemiTheme.Spacing.s)
        .modifier(BoardTileSizing(
            placement: extras.placement,
            height: tileHeight,
            growsToContent: growsToContent
        ))
        .background(tileBackground, in: .rect(cornerRadius: RemiTheme.Radius.control))
        .overlay { border }
        .overlay(alignment: .topTrailing) { resizeHandle }
        .modifier(TileMenu(menu: menu, preview: extras.preview))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityLabel)
    }

    // MARK: parts

    @ViewBuilder private func draggable<Content: View>(_ content: Content) -> some View {
        if let dragPayload {
            content.draggable(dragPayload)
        } else {
            content
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: RemiTheme.Spacing.xs) {
            Circle()
                .fill(dotColor)
                .frame(width: RemiTheme.Size.statusDot, height: RemiTheme.Size.statusDot)
                .accessibilityHidden(true)
            Button(action: onOpen) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(session.name)
                        .font(.headline)
                        .lineLimit(1)
                    Text(subtitle)
                        .font(RemiTheme.Typography.metadata)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens the whole conversation")
            if isPinned {
                Image(systemName: "pin.fill")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Pinned")
            }
            if let activity = RemiBoardOrder.activityDate(session.lastActivity) {
                Text(activity, style: .relative)
                    .font(RemiTheme.Typography.metadata)
                    .foregroundStyle(.tertiary)
                    .monospacedDigit()
                    .lineLimit(1)
            }
            if extras.placement != nil { movementGrip }
        }
    }

    /// The latest of the conversation, newest at the bottom, fading out at the top.
    @ViewBuilder private var conversation: some View {
        let shown = RemiBoardOrder.feed(entries, size: size)
        if shown.isEmpty {
            Button(action: onOpen) {
                Text(emptyConversationText)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(size.messageLines)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens the whole conversation")
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: RemiTheme.Spacing.xs) {
                    ForEach(shown) { entry in FeedLine(entry: entry.escapedForDisplay) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .defaultScrollAnchor(.bottom)
            .scrollIndicators(.hidden)
            .frame(maxHeight: .infinity)
            .mask(
                LinearGradient(
                    stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.12)],
                    startPoint: .top, endPoint: .bottom
                )
            )
        }
    }

    /// The one line a compact row shows: the question notice, else the latest thing said.
    @ViewBuilder private var rowSummary: some View {
        if needsYou {
            waitingNotice
        } else {
            Button(action: onOpen) {
                Text(latestLine)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens the whole conversation")
        }
    }

    /// The latest entry as one escaped line; a not-yet-confirmed message reads like a sent one.
    private var latestLine: String {
        switch entries.last?.escapedForDisplay {
        case .user(_, let text), .pending(_, let text, _), .agent(_, let text), .error(_, let text): text
        case .tool(_, let name, let summary): "\(name) \(summary)"
        case nil: RemiDisplayText.escape(emptyConversationText)
        }
    }

    private var emptyConversationText: String {
        if let message = session.lastMessage, !message.isEmpty { return message }
        return session.isLive ? "Waiting for the conversation…" : "This session has finished."
    }

    /// A question waiting on the person, answered on the tile. It takes the room it needs up to
    /// a cap and scrolls beyond that, so a long question cannot push the conversation away.
    @ViewBuilder private var waitingQuestion: some View {
        if needsYou, let question {
            if extras.placement != nil {
                ScrollView {
                    question.frame(maxWidth: .infinity)
                }
                .scrollBounceBehavior(.basedOnSize)
                .frame(minHeight: 1, maxHeight: .infinity)
                .layoutPriority(1)
            } else {
                ScrollView {
                    question
                        .frame(maxWidth: .infinity)
                        .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { questionHeight = $0 }
                }
                .scrollBounceBehavior(.basedOnSize)
                .frame(height: min(max(questionHeight, 1), (size == .compact ? 180 : 260) * heightScale))
            }
            if session.openQuestionCount > 1 {
                Text("\(session.openQuestionCount - 1) more waiting. Open the conversation to see them.")
                    .font(RemiTheme.Typography.metadata)
                    .foregroundStyle(.secondary)
            }
        } else if needsYou {
            waitingNotice
        }
    }

    /// The plain notice, a button that opens the conversation to answer there.
    private var waitingNotice: some View {
        Button(action: onOpen) {
            Label(
                session.openQuestionCount > 1 ? "\(session.openQuestionCount) questions waiting" : "Waiting for you",
                systemImage: "questionmark.bubble.fill"
            )
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(RemiTheme.Color.attentionInk)
            .padding(.horizontal, RemiTheme.Spacing.xs)
            .padding(.vertical, RemiTheme.Spacing.xxs)
            .background(RemiTheme.Color.attention, in: Capsule())
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .accessibilityHint("Opens the whole conversation")
    }

    @ViewBuilder private var footer: some View {
        if sendFailed {
            Label("Not sent. Your text is still here.", systemImage: "exclamationmark.triangle.fill")
                .font(RemiTheme.Typography.metadata)
                .foregroundStyle(.secondary)
        } else if pendingMessageCount > 0 {
            Label(
                pendingMessageCount == 1 ? "1 message not shown yet" : "\(pendingMessageCount) messages not shown yet",
                systemImage: "paperplane"
            )
            .font(RemiTheme.Typography.metadata)
            .foregroundStyle(.secondary)
        }
    }

    private var quickComposer: some View {
        HStack(alignment: .bottom, spacing: RemiTheme.Spacing.xs) {
            TextField(session.isLive ? "Message" : "Finished", text: $draft, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...4)
                .focused(focus, equals: tileKey)
                .disabled(!session.isLive)
                .onSubmit(send)
                .submitLabel(.send)
            Button(action: send) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.title3)
                    #if os(iOS)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(.rect)
                    #endif
            }
            .buttonStyle(.plain)
            .foregroundStyle(canSend ? AnyShapeStyle(RemiTheme.Color.activityDot) : AnyShapeStyle(.tertiary))
            .disabled(!canSend)
            .accessibilityLabel("Send")
        }
        .padding(.horizontal, RemiTheme.Spacing.xs)
        .padding(.vertical, RemiTheme.Spacing.xs)
        .background(.background.opacity(0.7), in: .rect(cornerRadius: RemiTheme.Radius.compact))
        .layoutPriority(extras.placement == nil ? 0 : 2)
    }

    @ViewBuilder private var menu: some View {
        Button("Open conversation", systemImage: "arrow.up.forward.app", action: onOpen)
        Divider()
        if !extras.sizeChoices.isEmpty {
            Picker("Size", selection: Binding(get: { size }, set: onSetSize)) {
                ForEach(extras.sizeChoices, id: \.self) { choice in
                    Text(choice.densityTitle).tag(choice)
                }
            }
        }
        Button(
            isPinned ? "Unpin from its place" : "Pin to its place",
            systemImage: isPinned ? "pin.slash" : "pin",
            action: onTogglePin
        )
        if let placement = extras.placement {
            Divider()
            Button("Move left", systemImage: "arrow.left") { placement.onMoveBy(CGSize(width: -24, height: 0)) }
            Button("Move right", systemImage: "arrow.right") { placement.onMoveBy(CGSize(width: 24, height: 0)) }
            Button("Move up", systemImage: "arrow.up") { placement.onMoveBy(CGSize(width: 0, height: -24)) }
            Button("Move down", systemImage: "arrow.down") { placement.onMoveBy(CGSize(width: 0, height: 24)) }
            Divider()
            Button("Widen", systemImage: "arrow.right.to.line") { placement.onResizeBy(CGSize(width: 24, height: 0)) }
            Button("Narrow", systemImage: "arrow.left.to.line") { placement.onResizeBy(CGSize(width: -24, height: 0)) }
            Button("Make taller", systemImage: "arrow.down.to.line") { placement.onResizeBy(CGSize(width: 0, height: 24)) }
            Button("Make shorter", systemImage: "arrow.up.to.line") { placement.onResizeBy(CGSize(width: 0, height: -24)) }
        }
    }

    @ViewBuilder private var movementGrip: some View {
        if let placement = extras.placement {
            Button { placement.onMoveBy(CGSize(width: 24, height: 0)) } label: {
                Image(systemName: "circle.grid.3x3.fill")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 28, height: 28)
                    .background(
                        moveHovered || focusedPlacementControl == .move
                            ? RemiTheme.Color.attention.opacity(0.2)
                            : RemiTheme.Color.surface.opacity(0.78),
                        in: Circle()
                    )
                    .overlay { Circle().stroke(RemiTheme.Color.hairline, lineWidth: 1) }
            }
            .buttonStyle(.plain)
            .focused($focusedPlacementControl, equals: .move)
            .onHover { moveHovered = $0 }
            .accessibilityLabel("Move tile")
            .accessibilityHint("Drag to move. Use the arrow keys to move by 24 points.")
            .accessibilityAction(named: "Move left") { placement.onMoveBy(CGSize(width: -24, height: 0)) }
            .accessibilityAction(named: "Move right") { placement.onMoveBy(CGSize(width: 24, height: 0)) }
            .accessibilityAction(named: "Move up") { placement.onMoveBy(CGSize(width: 0, height: -24)) }
            .accessibilityAction(named: "Move down") { placement.onMoveBy(CGSize(width: 0, height: 24)) }
            .onKeyPress(.leftArrow) { placement.onMoveBy(CGSize(width: -24, height: 0)); return .handled }
            .onKeyPress(.rightArrow) { placement.onMoveBy(CGSize(width: 24, height: 0)); return .handled }
            .onKeyPress(.upArrow) { placement.onMoveBy(CGSize(width: 0, height: -24)); return .handled }
            .onKeyPress(.downArrow) { placement.onMoveBy(CGSize(width: 0, height: 24)); return .handled }
            .gesture(DragGesture(minimumDistance: 3).onChanged { placement.onMoveDrag($0.translation, false) }
                .onEnded { placement.onMoveDrag($0.translation, true) })
        }
    }

    @ViewBuilder private var resizeHandle: some View {
        if let placement = extras.placement {
            Button { placement.onResizeBy(CGSize(width: 24, height: 24)) } label: {
                Image(systemName: "arrow.up.left.and.arrow.down.right")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(resizeHovered || focusedPlacementControl == .resize
                        ? RemiTheme.Color.attentionInk : .secondary)
                    .frame(width: 26, height: 26)
                    .background(
                        resizeHovered || focusedPlacementControl == .resize
                            ? RemiTheme.Color.attention.opacity(0.85)
                            : RemiTheme.Color.surface,
                        in: Circle()
                    )
                    .overlay { Circle().stroke(RemiTheme.Color.hairline, lineWidth: 1) }
            }
            .buttonStyle(.plain)
            .focused($focusedPlacementControl, equals: .resize)
            .onHover { resizeHovered = $0 }
            .offset(x: 7, y: -7)
            .accessibilityLabel("Resize tile")
            .accessibilityHint("Drag right to widen and down to make taller. Use the arrow keys to resize by 24 points.")
            .accessibilityAction(named: "Narrow") { placement.onResizeBy(CGSize(width: -24, height: 0)) }
            .accessibilityAction(named: "Widen") { placement.onResizeBy(CGSize(width: 24, height: 0)) }
            .accessibilityAction(named: "Make shorter") { placement.onResizeBy(CGSize(width: 0, height: -24)) }
            .accessibilityAction(named: "Make taller") { placement.onResizeBy(CGSize(width: 0, height: 24)) }
            .onKeyPress(.leftArrow) { placement.onResizeBy(CGSize(width: -24, height: 0)); return .handled }
            .onKeyPress(.rightArrow) { placement.onResizeBy(CGSize(width: 24, height: 0)); return .handled }
            .onKeyPress(.upArrow) { placement.onResizeBy(CGSize(width: 0, height: -24)); return .handled }
            .onKeyPress(.downArrow) { placement.onResizeBy(CGSize(width: 0, height: 24)); return .handled }
            .gesture(DragGesture(minimumDistance: 3).onChanged { placement.onResizeDrag($0.translation, false) }
                .onEnded { placement.onResizeDrag($0.translation, true) })
        }
    }

    // MARK: look

    private var subtitle: String {
        [session.machineName, session.project, session.harness == "claude" ? nil : session.harness]
            .compactMap { $0 }
            .joined(separator: " · ")
    }

    private var dotColor: Color {
        switch session.status {
        case .needsYou: RemiTheme.Color.attention
        case .working: RemiTheme.Color.activityDot
        case .connecting: .orange
        case .idle: .secondary
        case .offline: .secondary.opacity(0.4)
        }
    }

    private var tileBackground: some ShapeStyle {
        needsYou ? AnyShapeStyle(RemiTheme.Color.attentionWash) : AnyShapeStyle(RemiTheme.Color.surface)
    }

    /// A tile that needs the person breathes in the attention color; with Reduce Motion it is
    /// a steady colored border instead.
    @ViewBuilder private var border: some View {
        let shape = RoundedRectangle(cornerRadius: RemiTheme.Radius.control)
        if needsYou {
            if reduceMotion {
                shape.stroke(RemiTheme.Color.attention, lineWidth: 2.5).allowsHitTesting(false)
            } else {
                BreathingBorder().allowsHitTesting(false)
            }
        } else {
            shape.stroke(RemiTheme.Color.hairline, lineWidth: 1).allowsHitTesting(false)
        }
    }

    private var accessibilityLabel: String {
        var parts = [session.name, session.machineName, session.project]
        if needsYou {
            parts.append(
                session.openQuestionCount > 1 ? "needs you, \(session.openQuestionCount) questions" : "needs you"
            )
        }
        if !size.showsFeed, !needsYou {
            parts.append(latestLine)
        }
        return parts.joined(separator: ", ")
    }

    private func send() {
        guard canSend else { return }
        let text = draft
        sending = true
        Task {
            let sent = await onSend(text)
            sending = false
            sendFailed = !sent
            // Text typed while the send was in flight is not the sent text; keep it.
            if sent, draft == text { draft = "" }
        }
    }
}

/// The tile's long-press menu, with a preview where the platform has one.
private struct TileMenu<Items: View>: ViewModifier {
    let menu: Items
    let preview: (() -> AnyView)?

    func body(content: Content) -> some View {
        #if os(iOS)
        if let preview {
            content.contextMenu { menu } preview: { preview() }
        } else {
            content.contextMenu { menu }
        }
        #else
        content.contextMenu { menu }
        #endif
    }
}

/// A border that slowly swells and fades, for a tile that needs the person.
private struct BreathingBorder: View {
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        // 20 frames a second is smooth enough for a slow swell, and the clock stops while the
        // window is not the active scene.
        TimelineView(.animation(minimumInterval: 1.0 / 20.0, paused: scenePhase != .active)) { timeline in
            let phase = timeline.date.timeIntervalSinceReferenceDate
            let wave = (sin(phase * 2 * .pi / 2.8) + 1) / 2
            RoundedRectangle(cornerRadius: RemiTheme.Radius.control)
                .stroke(RemiTheme.Color.attention.opacity(0.45 + 0.55 * wave), lineWidth: 2 + 1.5 * wave)
                .shadow(color: RemiTheme.Color.attention.opacity(0.5 * wave), radius: 6 * wave)
        }
    }
}

public extension RemiBoardTile where Question == EmptyView {
    init(
        session: RemiSessionSummary,
        tileKey: String,
        size: RemiTileSize,
        isPinned: Bool,
        pendingMessageCount: Int = 0,
        entries: [RemiTranscriptEntry] = [],
        draft: Binding<String>,
        focus: FocusState<String?>.Binding,
        onOpen: @escaping () -> Void,
        onSend: @escaping (String) async -> Bool,
        onSetSize: @escaping (RemiTileSize) -> Void = { _ in },
        onTogglePin: @escaping () -> Void,
        dragPayload: String? = nil,
        extras: RemiBoardTileExtras = RemiBoardTileExtras()
    ) {
        self.init(
            session: session, tileKey: tileKey, size: size, isPinned: isPinned,
            pendingMessageCount: pendingMessageCount, entries: entries, draft: draft, focus: focus,
            onOpen: onOpen, onSend: onSend, onSetSize: onSetSize, onTogglePin: onTogglePin,
            dragPayload: dragPayload, question: nil, extras: extras
        )
    }
}

/// One line of the conversation on a tile: quieter than the full conversation view.
private struct FeedLine: View {
    let entry: RemiTranscriptEntry

    var body: some View {
        switch entry {
        case .user(_, let text):
            Text(text)
                .font(.callout)
                .lineLimit(3)
                .padding(.horizontal, RemiTheme.Spacing.xs)
                .padding(.vertical, RemiTheme.Spacing.xxs)
                .background(RemiTheme.Color.attentionWash, in: .rect(cornerRadius: RemiTheme.Radius.compact))
                .frame(maxWidth: .infinity, alignment: .trailing)
        case .pending(_, let text, _):
            Text(text)
                .font(.callout)
                .lineLimit(3)
                .padding(.horizontal, RemiTheme.Spacing.xs)
                .padding(.vertical, RemiTheme.Spacing.xxs)
                .overlay {
                    RoundedRectangle(cornerRadius: RemiTheme.Radius.compact)
                        .stroke(RemiTheme.Color.attention.opacity(0.7), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                }
                .frame(maxWidth: .infinity, alignment: .trailing)
                .accessibilityLabel("Your message, not confirmed yet")
        case .agent(_, let text):
            Text(text)
                .font(.callout)
                .lineLimit(6)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .tool(_, let name, let summary):
            HStack(spacing: RemiTheme.Spacing.xxs) {
                Image(systemName: "wrench.and.screwdriver").imageScale(.small)
                Text(name).fontWeight(.semibold)
                Text(summary).lineLimit(1).truncationMode(.middle)
            }
            .font(RemiTheme.Typography.code)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
        case .error(_, let text):
            Label(text, systemImage: "exclamationmark.triangle")
                .font(RemiTheme.Typography.metadata)
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// The tile's height: fixed, a minimum when the content (a question) may need more, or none
/// for a compact row.
private struct BoardTileSizing: ViewModifier {
    let placement: RemiBoardTilePlacement?
    let height: CGFloat?
    let growsToContent: Bool

    func body(content: Content) -> some View {
        if let placement {
            content.frame(width: placement.size.width, height: placement.size.height, alignment: .topLeading)
        } else {
            content
                .frame(maxWidth: .infinity, alignment: .topLeading)
                .modifier(TileHeight(height: height, growsToContent: growsToContent))
        }
    }
}

private struct TileHeight: ViewModifier {
    let height: CGFloat?
    let growsToContent: Bool

    func body(content: Content) -> some View {
        if let height {
            if growsToContent {
                content.frame(minHeight: height)
            } else {
                content.frame(height: height)
            }
        } else {
            content
        }
    }
}

/// What a long press on a tile previews: the session and the latest of its conversation.
public struct RemiBoardPreview: View {
    private let session: RemiSessionSummary
    private let entries: [RemiTranscriptEntry]

    public init(session: RemiSessionSummary, entries: [RemiTranscriptEntry]) {
        self.session = session
        self.entries = entries
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.xs) {
            VStack(alignment: .leading, spacing: 1) {
                Text(session.name).font(.headline).lineLimit(1)
                Text([session.machineName, session.project].joined(separator: " · "))
                    .font(RemiTheme.Typography.metadata)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Divider()
            if entries.isEmpty {
                Text(RemiDisplayText.escape(session.lastMessage ?? "Nothing said yet."))
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(entries.suffix(12)) { entry in FeedLine(entry: entry.escapedForDisplay) }
            }
        }
        .padding(RemiTheme.Spacing.m)
        .frame(maxWidth: 340, alignment: .topLeading)
    }
}
