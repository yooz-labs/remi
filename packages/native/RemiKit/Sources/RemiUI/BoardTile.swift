import SwiftUI

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

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var sendFailed = false
    /// The question's natural height, so its area is as tall as it needs up to a cap.
    @State private var questionHeight: CGFloat = 0

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
        onSetSize: @escaping (RemiTileSize) -> Void,
        onTogglePin: @escaping () -> Void,
        dragPayload: String? = nil,
        question: Question? = nil
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
    }

    private var needsYou: Bool { session.status == .needsYou }
    private var canSend: Bool { session.isLive && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    public var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.xs) {
            draggable(header)
            conversation
            waitingQuestion
            footer
            quickComposer
        }
        .padding(RemiTheme.Spacing.s)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .frame(height: size.estimatedHeight)
        .background(tileBackground, in: .rect(cornerRadius: RemiTheme.Radius.control))
        .overlay { border }
        .contextMenu { menu }
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
        }
    }

    /// The latest of the conversation, newest at the bottom, fading out at the top.
    @ViewBuilder private var conversation: some View {
        let shown = RemiBoardOrder.feed(entries, size: size)
        if shown.isEmpty {
            Text(emptyConversationText)
                .font(.callout)
                .foregroundStyle(.secondary)
                .lineLimit(size.messageLines)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .contentShape(.rect)
                .onTapGesture(perform: onOpen)
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: RemiTheme.Spacing.xs) {
                    ForEach(shown) { entry in FeedLine(entry: entry) }
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

    private var emptyConversationText: String {
        if let message = session.lastMessage, !message.isEmpty { return message }
        return session.isLive ? "Waiting for the conversation…" : "This session has finished."
    }

    /// A question waiting on the person, answered on the tile. It takes the room it needs up to
    /// a cap and scrolls beyond that, so a long question cannot push the conversation away.
    @ViewBuilder private var waitingQuestion: some View {
        if needsYou, let question {
            ScrollView {
                question
                    .frame(maxWidth: .infinity)
                    .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { questionHeight = $0 }
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(height: min(max(questionHeight, 1), size == .compact ? 180 : 260))
            if session.openQuestionCount > 1 {
                Text("\(session.openQuestionCount - 1) more waiting. Open the conversation to see them.")
                    .font(RemiTheme.Typography.metadata)
                    .foregroundStyle(.secondary)
            }
        } else if needsYou {
            Label(
                session.openQuestionCount > 1 ? "\(session.openQuestionCount) questions waiting" : "Waiting for you",
                systemImage: "questionmark.bubble.fill"
            )
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(RemiTheme.Color.attentionInk)
            .padding(.horizontal, RemiTheme.Spacing.xs)
            .padding(.vertical, RemiTheme.Spacing.xxs)
            .background(RemiTheme.Color.attention, in: Capsule())
        }
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
            }
            .buttonStyle(.plain)
            .foregroundStyle(canSend ? AnyShapeStyle(RemiTheme.Color.activityDot) : AnyShapeStyle(.tertiary))
            .disabled(!canSend)
            .accessibilityLabel("Send")
        }
        .padding(.horizontal, RemiTheme.Spacing.xs)
        .padding(.vertical, RemiTheme.Spacing.xs)
        .background(.background.opacity(0.7), in: .rect(cornerRadius: RemiTheme.Radius.compact))
    }

    @ViewBuilder private var menu: some View {
        Button("Open conversation", systemImage: "arrow.up.forward.app", action: onOpen)
        Divider()
        Picker("Size", selection: Binding(get: { size }, set: onSetSize)) {
            Text("Compact").tag(RemiTileSize.compact)
            Text("Regular").tag(RemiTileSize.regular)
            Text("Large").tag(RemiTileSize.large)
        }
        Button(
            isPinned ? "Unpin from its place" : "Pin to its place",
            systemImage: isPinned ? "pin.slash" : "pin",
            action: onTogglePin
        )
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
        var parts = [session.name, session.machineName]
        if needsYou { parts.append("needs you") }
        return parts.joined(separator: ", ")
    }

    private func send() {
        guard canSend else { return }
        let text = draft
        Task {
            if await onSend(text) {
                sendFailed = false
                draft = ""
            } else {
                sendFailed = true
            }
        }
    }
}

/// A border that slowly swells and fades, for a tile that needs the person.
private struct BreathingBorder: View {
    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
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
        onSetSize: @escaping (RemiTileSize) -> Void,
        onTogglePin: @escaping () -> Void,
        dragPayload: String? = nil
    ) {
        self.init(
            session: session, tileKey: tileKey, size: size, isPinned: isPinned,
            pendingMessageCount: pendingMessageCount, entries: entries, draft: draft, focus: focus,
            onOpen: onOpen, onSend: onSend, onSetSize: onSetSize, onTogglePin: onTogglePin,
            dragPayload: dragPayload, question: nil
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
