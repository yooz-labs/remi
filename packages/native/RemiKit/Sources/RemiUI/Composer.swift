import SwiftUI

public extension EnvironmentValues {
    /// Bumped to ask the composer to take keyboard focus (a hardware-keyboard shortcut).
    /// A composer that cannot take text right now, because a prompt is waiting or a
    /// message is sending, ignores the request.
    @Entry var remiComposerFocusRequest = 0
}

/// The message field and its action button.
///
/// `LeadingAccessory` is the seam for future attach controls (images, files). It is empty
/// today, and nothing is drawn for it until a feature backs it. A future accessory should be
/// a control as tall as the field (see `RemiTheme.Size.minimumTapTarget`) so the row stays aligned.
public struct RemiComposer<LeadingAccessory: View>: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    /// Height of the field and diameter of the action button; grows with Dynamic Type so the
    /// glyph never outgrows its circle.
    @ScaledMetric(relativeTo: .body) private var controlSize: CGFloat = RemiTheme.Size.minimumTapTarget
    @Environment(\.remiComposerFocusRequest) private var focusRequest
    @FocusState private var isFocused: Bool
    @Binding private var text: String
    private let promptWaiting: Bool
    private let isSending: Bool
    private let onSend: () -> Void
    private let onInterrupt: (() -> Void)?
    private let leadingAccessory: LeadingAccessory

    public init(
        text: Binding<String>,
        promptWaiting: Bool,
        isSending: Bool = false,
        onSend: @escaping () -> Void,
        onInterrupt: (() -> Void)?,
        @ViewBuilder leadingAccessory: () -> LeadingAccessory
    ) {
        _text = text
        self.promptWaiting = promptWaiting
        self.isSending = isSending
        self.onSend = onSend
        self.onInterrupt = onInterrupt
        self.leadingAccessory = leadingAccessory()
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.xs) {
            if promptWaiting {
                Label("Answer the waiting prompt before sending another message.", systemImage: "questionmark.bubble")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            GlassEffectContainer(spacing: RemiTheme.Spacing.xs) {
                // Field and button share one height, so a single line is centered on the button
                // and a growing field keeps the button on its last line.
                HStack(alignment: .bottom, spacing: RemiTheme.Spacing.xs) {
                    leadingAccessory

                    TextField("Message", text: $text, axis: .vertical)
                        .lineLimit(1...(dynamicTypeSize.isAccessibilitySize ? 3 : 5))
                        .textFieldStyle(.plain)
                        .focused($isFocused)
                        .padding(.horizontal, RemiTheme.Spacing.m)
                        .padding(.vertical, RemiTheme.Spacing.xs)
                        .frame(minHeight: controlSize)
                        .contentShape(.rect)
                        .modifier(ComposerInputSurface(
                            cornerRadius: controlSize / 2,
                            reduceTransparency: reduceTransparency
                        ))
                        .disabled(promptWaiting || isSending)
                        #if os(iOS)
                        // A way to put the keyboard away without sending or clearing the draft.
                        .toolbar {
                            ToolbarItemGroup(placement: .keyboard) {
                                Spacer()
                                Button("Hide keyboard", systemImage: "keyboard.chevron.compact.down") {
                                    isFocused = false
                                }
                                .labelStyle(.iconOnly)
                            }
                        }
                        #endif

                    if !promptWaiting || onInterrupt != nil {
                        actionButton
                    }
                }
            }
        }
        .onChange(of: focusRequest) { _, _ in
            if !promptWaiting && !isSending { isFocused = true }
        }
    }

    private var canSend: Bool {
        !isSending && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var actionButton: some View {
        let isActive = promptWaiting || canSend
        return Button(action: promptWaiting ? interrupt : onSend) {
            Group {
                if isSending && !promptWaiting {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: promptWaiting ? "escape" : "arrow.up")
                        .font(.body.weight(.semibold))
                }
            }
            .foregroundStyle(promptWaiting || !isActive ? Color.primary : RemiTheme.Color.attentionInk)
            .frame(width: controlSize, height: controlSize)
            .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .modifier(ComposerButtonSurface(
            tint: promptWaiting || !isActive ? nil : RemiTheme.Color.attention,
            reduceTransparency: reduceTransparency
        ))
        .opacity(isActive || isSending ? 1 : 0.6)
        .disabled(!promptWaiting && !canSend)
        .animation(RemiTheme.Motion.quick, value: isActive)
        .accessibilityLabel(promptWaiting ? "Interrupt agent" : "Send message")
        .accessibilityValue(isSending ? "Sending" : "")
        .accessibilityHint(isActive || isSending ? "" : "Type a message first")
    }

    private func interrupt() {
        onInterrupt?()
    }
}

public extension RemiComposer where LeadingAccessory == EmptyView {
    init(
        text: Binding<String>,
        promptWaiting: Bool,
        isSending: Bool = false,
        onSend: @escaping () -> Void,
        onInterrupt: (() -> Void)?
    ) {
        self.init(
            text: text,
            promptWaiting: promptWaiting,
            isSending: isSending,
            onSend: onSend,
            onInterrupt: onInterrupt,
            leadingAccessory: { EmptyView() }
        )
    }
}

private struct ComposerButtonSurface: ViewModifier {
    let tint: Color?
    let reduceTransparency: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if reduceTransparency {
            content
                .background(tint ?? Color.primary.opacity(0.14), in: .circle)
                .overlay {
                    Circle()
                        .stroke(RemiTheme.Color.hairline, lineWidth: 1)
                        .allowsHitTesting(false)
                }
        } else {
            content.glassEffect(.regular.tint(tint).interactive(), in: .circle)
        }
    }
}

private struct ComposerInputSurface: ViewModifier {
    let cornerRadius: CGFloat
    let reduceTransparency: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        // A capsule at one line; the corner radius caps at the line height as the field grows.
        let shape = RoundedRectangle(cornerRadius: cornerRadius)
        if reduceTransparency {
            content.background(.background, in: shape)
                .overlay {
                    shape
                        .stroke(RemiTheme.Color.hairline, lineWidth: 1)
                        .allowsHitTesting(false)
                }
        } else {
            content.glassEffect(.regular, in: shape)
        }
    }
}
