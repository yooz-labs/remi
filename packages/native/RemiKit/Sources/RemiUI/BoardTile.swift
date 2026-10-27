import SwiftUI

/// One session on the command center board: what it is, what it last said, whether it needs
/// the person, and a line to answer it from in place.
public struct RemiBoardTile<Question: View>: View {
    private let session: RemiSessionSummary
    private let tileKey: String
    private let size: RemiTileSize
    private let isPinned: Bool
    private let pendingMessageCount: Int
    @Binding private var draft: String
    private let focus: FocusState<String?>.Binding
    private let onOpen: () -> Void
    private let onSend: (String) async -> Bool
    private let onSetSize: (RemiTileSize) -> Void
    private let onTogglePin: () -> Void
    /// The session's waiting question, answered on the tile. Nil shows the plain notice.
    private let question: Question?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var sendFailed = false

    public init(
        session: RemiSessionSummary,
        tileKey: String,
        size: RemiTileSize,
        isPinned: Bool,
        pendingMessageCount: Int = 0,
        draft: Binding<String>,
        focus: FocusState<String?>.Binding,
        onOpen: @escaping () -> Void,
        onSend: @escaping (String) async -> Bool,
        onSetSize: @escaping (RemiTileSize) -> Void,
        onTogglePin: @escaping () -> Void,
        question: Question? = nil
    ) {
        self.session = session
        self.tileKey = tileKey
        self.size = size
        self.isPinned = isPinned
        self.pendingMessageCount = pendingMessageCount
        _draft = draft
        self.focus = focus
        self.onOpen = onOpen
        self.onSend = onSend
        self.onSetSize = onSetSize
        self.onTogglePin = onTogglePin
        self.question = question
    }

    private var needsYou: Bool { session.status == .needsYou }
    private var canSend: Bool { session.isLive && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    public var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.xs) {
            header
            messageBody
            Spacer(minLength: 0)
            footer
            quickComposer
        }
        .padding(RemiTheme.Spacing.s)
        .frame(maxWidth: .infinity, minHeight: size.estimatedHeight, alignment: .topLeading)
        .background(tileBackground, in: .rect(cornerRadius: RemiTheme.Radius.control))
        .overlay { border }
        .contextMenu { menu }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityLabel)
    }

    // MARK: parts

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

    @ViewBuilder private var messageBody: some View {
        if needsYou, let question {
            question
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
        if question != nil, needsYou {
            EmptyView()
        } else if let message = session.lastMessage, !message.isEmpty {
            Text(message)
                .font(.callout)
                .foregroundStyle(size == .compact ? .secondary : .primary)
                .lineLimit(size.messageLines)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(.rect)
                .onTapGesture(perform: onOpen)
        } else if !needsYou {
            Text(session.isLive ? "Nothing said yet." : "This session has finished.")
                .font(.callout)
                .foregroundStyle(.tertiary)
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
        draft: Binding<String>,
        focus: FocusState<String?>.Binding,
        onOpen: @escaping () -> Void,
        onSend: @escaping (String) async -> Bool,
        onSetSize: @escaping (RemiTileSize) -> Void,
        onTogglePin: @escaping () -> Void
    ) {
        self.init(
            session: session, tileKey: tileKey, size: size, isPinned: isPinned,
            pendingMessageCount: pendingMessageCount, draft: draft, focus: focus,
            onOpen: onOpen, onSend: onSend, onSetSize: onSetSize, onTogglePin: onTogglePin,
            question: nil
        )
    }
}
