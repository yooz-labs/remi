import SwiftUI

public enum RemiSessionInteractionState: Equatable, Sendable {
    case liveMain(promptWaiting: Bool)
    case liveSubagent
    case finished
}

public struct RemiSessionInteractionBar: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Binding private var draft: String
    private let state: RemiSessionInteractionState
    private let onSend: (String) -> Void
    private let onInterrupt: () -> Void

    public init(
        draft: Binding<String>,
        state: RemiSessionInteractionState,
        onSend: @escaping (String) -> Void,
        onInterrupt: @escaping () -> Void
    ) {
        _draft = draft
        self.state = state
        self.onSend = onSend
        self.onInterrupt = onInterrupt
    }

    public var body: some View {
        Group {
            switch state {
            case .liveMain(let promptWaiting):
                RemiComposer(
                    text: $draft,
                    promptWaiting: promptWaiting,
                    onSend: sendDraft,
                    onInterrupt: onInterrupt
                )
            case .liveSubagent:
                readOnlyLabel(
                    "Subagent conversations are read-only",
                    systemImage: "eye"
                )
            case .finished:
                readOnlyLabel(
                    "Finished conversation · Read only",
                    systemImage: "checkmark.circle"
                )
            }
        }
        .padding(.horizontal, RemiTheme.Spacing.m)
        .padding(.vertical, RemiTheme.Spacing.s)
        .frame(maxWidth: .infinity)
        .background(reduceTransparency ? AnyShapeStyle(.background) : AnyShapeStyle(.bar))
    }

    private func readOnlyLabel(_ title: LocalizedStringKey, systemImage: String) -> some View {
        Label(title, systemImage: systemImage)
            .font(.subheadline.weight(.medium))
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, minHeight: RemiTheme.Size.minimumTapTarget)
    }

    private func sendDraft() {
        let content = draft
        draft = ""
        onSend(content)
    }
}

public extension View {
    func remiSessionInteractionBar(
        draft: Binding<String>,
        state: RemiSessionInteractionState,
        onSend: @escaping (String) -> Void,
        onInterrupt: @escaping () -> Void
    ) -> some View {
        scrollEdgeEffectStyle(.soft, for: .bottom)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                RemiSessionInteractionBar(
                    draft: draft,
                    state: state,
                    onSend: onSend,
                    onInterrupt: onInterrupt
                )
            }
    }
}
