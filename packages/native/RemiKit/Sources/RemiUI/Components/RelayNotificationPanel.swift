import RemiKit
import RemiPush
import SwiftUI

/// Choices come only from the independently reopened signed capsule. No static
/// notification action categories are installed in this milestone (#1242).
public struct RelayNotificationPanel: View {
    private let store: MachineStore
    private let onClose: () -> Void

    public init(store: MachineStore, onClose: @escaping () -> Void) {
        self.store = store
        self.onClose = onClose
    }

    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: RemiTheme.Spacing.m) {
                    if let card = store.verifiedRelayNotification {
                        RelayNotificationHeader(
                            kind: card.kind,
                            title: card.title,
                            messageBody: card.body,
                            origin: card.machine.origin
                        )

                        RelayNotificationActions(
                            options: store.relayNotificationChoices,
                            isBusy: store.relayNotificationBusy,
                            onChoose: { choice in
                                Task { await store.answerRelayNotification(choice: choice) }
                            }
                        )

                        if card.kind == .question, store.relayNotificationChoices.isEmpty {
                            Label("Open the session to review and answer this question.", systemImage: "arrow.up.forward.app")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                                .padding(RemiTheme.Spacing.m)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(RemiTheme.Color.surface, in: .rect(cornerRadius: RemiTheme.Radius.control))
                        }

                        RelayNotificationTrustFooter(requiresUnlock: card.machine.authority.requiresAppUnlock)
                    } else {
                        ContentUnavailableView("Notification unavailable", systemImage: "bell.slash",
                            description: Text("This notification could not be verified or is no longer current."))
                    }

                    RelayNotificationStatus(
                        isBusy: store.relayNotificationBusy,
                        notice: store.relayNotificationNotice
                    )
                }
                .padding(RemiTheme.Spacing.l)
                .frame(maxWidth: 620)
                .frame(maxWidth: .infinity)
            }
            .background(RemiTheme.Color.surface.opacity(0.72))
            .navigationTitle("Relay notification")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done", action: onClose)
                }
            }
        }
    }
}

private struct RelayNotificationHeader: View {
    let kind: VerifiedPushNotification.Kind
    let title: String
    let messageBody: String
    let origin: String

    var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.m) {
            HStack(alignment: .top, spacing: RemiTheme.Spacing.m) {
                Image(systemName: kind == .question ? "questionmark.bubble.fill" : "bell.fill")
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(RemiTheme.Color.attentionInk)
                    .frame(width: 44, height: 44)
                    .background(RemiTheme.Color.attention, in: Circle())

                VStack(alignment: .leading, spacing: RemiTheme.Spacing.xxs) {
                    Text(eyebrowText)
                        .font(RemiTheme.Typography.eyebrow)
                        .foregroundStyle(.secondary)
                    Text(title)
                        .font(.title2.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                    Label(origin, systemImage: "desktopcomputer")
                        .font(RemiTheme.Typography.metadata)
                        .foregroundStyle(.secondary)
                }
            }

            Text(messageBody)
                .font(.body)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(RemiTheme.Spacing.l)
        .background(.regularMaterial, in: .rect(cornerRadius: RemiTheme.Radius.card))
        .overlay {
            RoundedRectangle(cornerRadius: RemiTheme.Radius.card)
                .stroke(RemiTheme.Color.hairline, lineWidth: 1)
        }
    }

    private var eyebrowText: LocalizedStringResource {
        kind == .question ? "ACTION REQUIRED" : "NOTIFICATION"
    }
}

private struct RelayNotificationActions: View {
    let options: [VerifiedPushOption]
    let isBusy: Bool
    let onChoose: (String) -> Void

    var body: some View {
        if !options.isEmpty {
            VStack(alignment: .leading, spacing: RemiTheme.Spacing.s) {
                Text("Choose a response")
                    .font(.headline)

                ForEach(options, id: \.value) { option in
                    RelayNotificationActionButton(
                        option: option,
                        isBusy: isBusy,
                        onChoose: onChoose
                    )
                }
            }
        }
    }
}

private struct RelayNotificationActionButton: View {
    let option: VerifiedPushOption
    let isBusy: Bool
    let onChoose: (String) -> Void

    var body: some View {
        Button {
            onChoose(option.value)
        } label: {
            HStack(spacing: RemiTheme.Spacing.s) {
                Image(systemName: symbolName)
                    .font(.headline)
                    .frame(width: 24)

                VStack(alignment: .leading, spacing: RemiTheme.Spacing.xxs) {
                    Text(PushDisplayText.escape(option.label))
                        .font(.body.weight(.medium))
                    if let description = option.description {
                        Text(PushDisplayText.escape(description))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if option.standingGrant != nil {
                        Label("Applies for this session", systemImage: "clock.arrow.circlepath")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Spacer(minLength: RemiTheme.Spacing.s)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .multilineTextAlignment(.leading)
            .padding(RemiTheme.Spacing.m)
            .frame(maxWidth: .infinity, minHeight: RemiTheme.Size.minimumTapTarget, alignment: .leading)
            .background(backgroundStyle, in: .rect(cornerRadius: RemiTheme.Radius.control))
            .overlay {
                RoundedRectangle(cornerRadius: RemiTheme.Radius.control)
                    .stroke(RemiTheme.Color.hairline, lineWidth: 1)
            }
        }
        .buttonStyle(.plain)
        .disabled(isBusy)
    }

    private var symbolName: String {
        if option.isNo { return "xmark" }
        if option.standingGrant != nil { return "checkmark.shield" }
        return "checkmark"
    }

    private var backgroundStyle: Color {
        option.isYes ? RemiTheme.Color.attention.opacity(0.18) : RemiTheme.Color.surface
    }
}

private struct RelayNotificationTrustFooter: View {
    let requiresUnlock: Bool

    var body: some View {
        Label(trustText, systemImage: "checkmark.shield.fill")
        .font(.caption)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var trustText: LocalizedStringResource {
        requiresUnlock
            ? "Verified notification · Unlock required to answer"
            : "Verified notification"
    }
}

private struct RelayNotificationStatus: View {
    let isBusy: Bool
    let notice: String?

    var body: some View {
        if isBusy {
            HStack(spacing: RemiTheme.Spacing.s) {
                ProgressView().controlSize(.small)
                Text("Sending answer…")
            }
            .font(.callout)
            .foregroundStyle(.secondary)
        } else if let notice {
            Label(notice, systemImage: "info.circle.fill")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
    }
}
