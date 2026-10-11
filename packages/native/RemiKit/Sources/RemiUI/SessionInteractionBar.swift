import SwiftUI

public enum RemiSessionInteractionState: Equatable, Sendable {
    case liveMain(promptWaiting: Bool)
    case liveSubagent
    case finished
}

public extension RemiSessionInteractionState {
    static func resolve(
        sessionIsLive: Bool,
        selectedViewID: String,
        hasWaitingQuestions: Bool
    ) -> Self {
        guard sessionIsLive else { return .finished }
        guard selectedViewID.isEmpty else { return .liveSubagent }
        return .liveMain(promptWaiting: hasWaitingQuestions)
    }
}

enum RemiComposerSubmission {
    static func content(from draft: String) -> String? {
        let content = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        return content.isEmpty ? nil : content
    }
}

public struct RemiSessionInteractionBar: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Binding private var draft: String
    private let state: RemiSessionInteractionState
    private let onSend: (String) async -> Bool
    private let onInterrupt: (() -> Void)?
    @State private var isSending = false
    @State private var sendFailed = false

    public init(
        draft: Binding<String>,
        state: RemiSessionInteractionState,
        onSend: @escaping (String) async -> Bool,
        onInterrupt: (() -> Void)?
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
                    isSending: isSending,
                    onSend: sendDraft,
                    onInterrupt: onInterrupt
                )
                if sendFailed {
                    Label("Message wasn’t sent. Your draft is still here.", systemImage: "exclamationmark.circle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
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
        guard let content = RemiComposerSubmission.content(from: draft) else { return }
        guard !isSending else { return }
        isSending = true
        sendFailed = false
        Task {
            let sent = await onSend(content)
            if sent {
                draft = ""
            } else {
                sendFailed = true
            }
            isSending = false
        }
    }
}

public extension View {
    func remiSessionInteractionBar(
        draft: Binding<String>,
        state: RemiSessionInteractionState,
        onSend: @escaping (String) async -> Bool,
        onInterrupt: (() -> Void)?
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
