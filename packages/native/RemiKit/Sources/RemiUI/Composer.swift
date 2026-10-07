import SwiftUI

public struct RemiComposer: View {
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

            HStack(alignment: .bottom, spacing: RemiTheme.Spacing.xs) {
                TextField("Message the agent", text: $text, axis: .vertical)
                    .lineLimit(1...5)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, RemiTheme.Spacing.s)
                    .frame(minHeight: RemiTheme.Size.minimumTapTarget)
                    .glassEffect(.regular, in: .rect(cornerRadius: RemiTheme.Radius.control))
                    .disabled(promptWaiting)

                Button(action: promptWaiting ? onInterrupt : onSend) {
                    Image(systemName: promptWaiting ? "escape" : "arrow.up")
                        .font(.headline)
                        .frame(width: RemiTheme.Size.minimumTapTarget, height: RemiTheme.Size.minimumTapTarget)
                }
                .buttonStyle(.glassProminent)
                .tint(promptWaiting ? .secondary : RemiTheme.Color.attention)
                .foregroundStyle(promptWaiting ? Color.primary : RemiTheme.Color.attentionInk)
                .disabled(!promptWaiting && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel(promptWaiting ? "Interrupt agent" : "Send message")
            }
        }
    }
}
