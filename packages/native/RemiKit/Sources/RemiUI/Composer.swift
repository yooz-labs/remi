import SwiftUI

public struct RemiComposer: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Binding private var text: String
    private let promptWaiting: Bool
    private let onSend: () -> Void
    private let onInterrupt: () -> Void

    public init(text: Binding<String>, promptWaiting: Bool, onSend: @escaping () -> Void, onInterrupt: @escaping () -> Void) {
        _text = text
        self.promptWaiting = promptWaiting
        self.onSend = onSend
        self.onInterrupt = onInterrupt
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.xs) {
            if promptWaiting {
                Label("Answer the waiting prompt before sending another message.", systemImage: "questionmark.bubble")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            GlassEffectContainer(spacing: RemiTheme.Spacing.xs) {
                HStack(alignment: .bottom, spacing: RemiTheme.Spacing.xs) {
                    TextField("Message", text: $text, axis: .vertical)
                        .lineLimit(1...5)
                        .textFieldStyle(.plain)
                        .padding(.horizontal, RemiTheme.Spacing.s)
                        .frame(minHeight: RemiTheme.Size.minimumTapTarget)
                        .modifier(ComposerInputSurface(reduceTransparency: reduceTransparency))
                        .disabled(promptWaiting)

                    Button(action: promptWaiting ? onInterrupt : onSend) {
                        Image(systemName: promptWaiting ? "escape" : "arrow.up")
                            .font(.headline)
                            .frame(width: RemiTheme.Size.minimumTapTarget, height: RemiTheme.Size.minimumTapTarget)
                    }
                    .buttonStyle(.glassProminent)
                    .buttonBorderShape(.circle)
                    .tint(promptWaiting ? .secondary : RemiTheme.Color.attention)
                    .foregroundStyle(promptWaiting ? Color.primary : RemiTheme.Color.attentionInk)
                    .disabled(!promptWaiting && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityLabel(promptWaiting ? "Interrupt agent" : "Send message")
                }
            }
        }
    }
}

private struct ComposerInputSurface: ViewModifier {
    let reduceTransparency: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if reduceTransparency {
            content.background(.background, in: .rect(cornerRadius: RemiTheme.Radius.control))
                .overlay {
                    RoundedRectangle(cornerRadius: RemiTheme.Radius.control)
                        .stroke(RemiTheme.Color.hairline, lineWidth: 1)
                        .allowsHitTesting(false)
                }
        } else {
            content.glassEffect(.regular, in: .rect(cornerRadius: RemiTheme.Radius.control))
        }
    }
}
