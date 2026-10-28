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
    struct FailureNoticeTaskID: Equatable {
        let failureCount: Int
        let voiceOverEnabled: Bool
        let switchControlEnabled: Bool

        var permitsDismissal: Bool { !voiceOverEnabled && !switchControlEnabled }
    }

    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled
    @Environment(\.accessibilitySwitchControlEnabled) private var switchControlEnabled
    @Binding private var draft: String
    private let state: RemiSessionInteractionState
    private let onSend: (String) async -> Bool
    private let onInterrupt: (() -> Void)?
    @State private var isSending = false
    @State private var sendFailed = false
    /// Counts failures, so a second one restarts the notice's timer.
    @State private var sendFailureCount = 0

    /// How long the "not sent" notice stays before it clears itself. The draft is untouched, and
    /// the notice can be dismissed sooner.
    public static let failureNoticeDuration: Duration = .seconds(12)

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
                // One stack, so the banner sits under the composer and the bar's padding, column and
                // material apply to the pair once.
                VStack(alignment: .leading, spacing: RemiTheme.Spacing.xs) {
                    RemiComposer(
                        text: $draft,
                        promptWaiting: promptWaiting,
                        isSending: isSending,
                        onSend: sendDraft,
                        onInterrupt: onInterrupt
                    )
                    if sendFailed {
                        RemiFeedbackBanner(
                            message: Self.failureMessage,
                            tone: .error,
                            onDismiss: { sendFailed = false }
                        )
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                    }
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
        .padding(.vertical, RemiTheme.Spacing.xs)
        // The bar's material spans the canvas; the controls stay in the readable column.
        .remiReadableColumn()
        // Only the live composer floats: its glass controls carry their own surface. Plain text
        // (read-only notes, the send-failure caption) keeps the bar material so it stays legible
        // over transcript content scrolling underneath.
        .background(floatsOverTranscript ? AnyShapeStyle(.clear) : barMaterial)
        .animation(RemiTheme.Motion.quick, value: sendFailed)
        // Said once when it appears, so VoiceOver does not depend on landing on the banner.
        .onChange(of: sendFailureCount) { _, _ in
            AccessibilityNotification.Announcement(Self.failureMessage).post()
        }
        // Clears itself; a new failure restarts the wait. A dismiss or a send clears the flag, so
        // the timer finds nothing left to do. Not while VoiceOver or Switch Control is on: those
        // users may need longer than any fixed time to reach it, and Dismiss is there.
        .task(id: failureNoticeTaskID) {
            guard sendFailed, failureNoticeTaskID.permitsDismissal else { return }
            try? await Task.sleep(for: Self.failureNoticeDuration)
            guard !Task.isCancelled else { return }
            sendFailed = false
        }
    }

    static let failureMessage = "Message wasn’t sent. Your draft is still here."

    private var failureNoticeTaskID: FailureNoticeTaskID {
        FailureNoticeTaskID(
            failureCount: sendFailureCount,
            voiceOverEnabled: voiceOverEnabled,
            switchControlEnabled: switchControlEnabled
        )
    }

    private var floatsOverTranscript: Bool {
        guard !reduceTransparency, !sendFailed else { return false }
        if case .liveMain = state { return true }
        return false
    }

    private var barMaterial: AnyShapeStyle {
        reduceTransparency ? AnyShapeStyle(.background) : AnyShapeStyle(.bar)
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
                sendFailureCount += 1
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
