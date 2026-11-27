import SwiftUI
#if os(macOS)
import AppKit
#endif

struct RemiComposerAction {
    enum Role { case send, hideKeyboard, jumpToLatest }
    let role: Role
    let label: String
    let isEnabled: Bool

    static func resolve(draft: String, keyboardUp: Bool, atLatest: Bool) -> Self {
        if RemiComposerSubmission.content(from: draft) != nil {
            return Self(role: .send, label: "Send message", isEnabled: true)
        }
        if keyboardUp { return Self(role: .hideKeyboard, label: "Hide keyboard", isEnabled: true) }
        return Self(role: .jumpToLatest, label: "Jump to latest", isEnabled: !atLatest)
    }
}

public extension EnvironmentValues {
    /// Bumped to ask the composer to take keyboard focus (a hardware-keyboard shortcut).
    /// A composer that cannot take text right now, because a prompt is waiting or a
    /// message is sending, ignores the request.
    @Entry var remiComposerFocusRequest = 0

    /// Bumped to ask the composer to put its keyboard away, keeping its draft. A tap on the
    /// transcript sends it. Only the composer reacts, so a tap that lands on another text field
    /// never takes that field's focus away.
    @Entry var remiComposerDismissRequest = 0
}

/// The message field and its action button.
///
/// `LeadingAccessory` is the seam for controls beside the field. The shared session bar uses
/// it to explain that image attachments are currently unavailable. Accessories should be as
/// tall as the field (see `RemiTheme.Size.minimumTapTarget`) so the row stays aligned.
public struct RemiComposer<LeadingAccessory: View>: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    /// Height of the field and diameter of the action button; grows with Dynamic Type so the
    /// glyph never outgrows its circle.
    @ScaledMetric(relativeTo: .body) private var controlSize: CGFloat = RemiTheme.Size.minimumTapTarget
    @Environment(\.remiComposerFocusRequest) private var focusRequest
    @Environment(\.remiComposerDismissRequest) private var dismissRequest
    @FocusState private var isFocused: Bool
    @Binding private var text: String
    private let promptWaiting: Bool
    private let isSending: Bool
    private let onSend: () -> Void
    private let onInterrupt: (() -> Void)?
    private let atLatest: Bool
    private let onJumpToLatest: (() -> Void)?
    private let leadingAccessory: LeadingAccessory

    public init(
        text: Binding<String>,
        promptWaiting: Bool,
        isSending: Bool = false,
        atLatest: Bool = true,
        onJumpToLatest: (() -> Void)? = nil,
        onSend: @escaping () -> Void,
        onInterrupt: (() -> Void)?,
        @ViewBuilder leadingAccessory: () -> LeadingAccessory
    ) {
        _text = text
        self.promptWaiting = promptWaiting
        self.isSending = isSending
        self.atLatest = atLatest
        self.onJumpToLatest = onJumpToLatest
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
                        #if os(macOS)
                        // Return sends and Shift+Return is a new line, as in a chat app.
                        .onKeyPress(.return, phases: [.down, .repeat]) { press in
                            let action = RemiComposerReturnKey.action(
                                modifiers: press.modifiers, canSend: canSend, isComposing: isComposingText)
                            switch action {
                            case .send:
                                // Holding Return sends once: a repeat is taken and does nothing.
                                if press.phase == .down { onSend() }
                                return .handled
                            case .ignore: return .handled
                            case .passThrough: return .ignored
                            }
                        }
                        // The same rule if the field takes Return for itself and submits. Submit
                        // carries no modifiers, so it reads the keys held at that moment.
                        .onSubmit {
                            if RemiComposerReturnKey.action(
                                modifiers: Self.heldModifiers, canSend: canSend, isComposing: isComposingText
                            ) == .send { onSend() }
                        }
                        // After a send the field is disabled for a moment; it takes the keyboard back,
                        // so the next message can be typed without a click.
                        .onChange(of: isSending) { was, now in
                            if was && !now && !promptWaiting { isFocused = true }
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
        .onChange(of: dismissRequest) { _, _ in isFocused = false }
    }

    #if os(macOS)
    /// Whether the field is holding text an input method has not committed yet. Any text input
    /// responder is asked, not only an `NSTextView`, since the field editor's class is the
    /// system's to change.
    private var isComposingText: Bool {
        let responder = (NSApp.keyWindow ?? NSApp.mainWindow)?.firstResponder
        return (responder as? NSTextInputClient)?.hasMarkedText() ?? false
    }

    /// The modifier keys held now, for a handler (`onSubmit`) that is not given them.
    private static var heldModifiers: EventModifiers {
        let flags = NSEvent.modifierFlags
        var modifiers: EventModifiers = []
        if flags.contains(.shift) { modifiers.insert(.shift) }
        if flags.contains(.option) { modifiers.insert(.option) }
        if flags.contains(.command) { modifiers.insert(.command) }
        if flags.contains(.control) { modifiers.insert(.control) }
        return modifiers
    }
    #endif

    private var canSend: Bool {
        !isSending && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var composerAction: RemiComposerAction {
        #if os(iOS)
        let keyboardUp = isFocused
        #else
        let keyboardUp = false
        #endif
        return .resolve(draft: text, keyboardUp: keyboardUp, atLatest: atLatest || onJumpToLatest == nil)
    }

    private var actionButton: some View {
        let selection = composerAction
        let isActive = promptWaiting || (selection.isEnabled && !isSending)
        return Button {
            if promptWaiting { interrupt(); return }
            switch selection.role {
            case .send: onSend()
            case .hideKeyboard: isFocused = false
            case .jumpToLatest: onJumpToLatest?()
            }
        } label: {
            Group {
                if isSending && !promptWaiting {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: promptWaiting ? "escape" : selection.role == .hideKeyboard ? "keyboard.chevron.compact.down" : selection.role == .jumpToLatest ? "arrow.down" : "arrow.up")
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
        .disabled(!isActive)
        .animation(RemiTheme.Motion.quick, value: isActive)
        .animation(RemiTheme.Motion.quick, value: selection.role)
        .accessibilityLabel(promptWaiting ? "Interrupt agent" : selection.label)
        .accessibilityValue(isSending ? "Sending" : "")
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
