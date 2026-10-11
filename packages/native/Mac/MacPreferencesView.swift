import AppKit
import RemiKit
import SwiftUI

struct MacPreferencesView: View {
    @Environment(\.scenePhase) private var scenePhase
    let publicIdentity: PublicClientIdentity
    private let refreshNotificationPermission: Bool

    @State private var copiedValue: CopiedValue?
    @State private var notificationPermission = MacNotificationPermission.shared
    @AppStorage(QuestionNotificationSummarizer.preferenceKey) private var summariesEnabled = true

    init(
        publicIdentity: PublicClientIdentity,
        notificationPermission: MacNotificationPermission = .shared,
        refreshNotificationPermission: Bool = true
    ) {
        self.publicIdentity = publicIdentity
        self.refreshNotificationPermission = refreshNotificationPermission
        _notificationPermission = State(initialValue: notificationPermission)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                header
                notificationCard
                accessCard
                identityCard
            }
            .padding(32)
            .frame(maxWidth: 680, alignment: .leading)
        }
        .frame(width: 680, height: 560)
        .navigationTitle("Remi Settings")
        .task {
            guard refreshNotificationPermission else { return }
            await notificationPermission.refresh()
        }
        .onChange(of: scenePhase) { _, phase in
            guard refreshNotificationPermission, phase == .active else { return }
            Task { await notificationPermission.refresh() }
        }
    }

    private var notificationCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            if notificationPermission.access == .notDetermined {
                MacNotificationAccessNotice(
                    systemImage: "bell.badge",
                    tint: .secondary,
                    title: "Allow question alerts",
                    detail: "macOS permission lets Remi show a banner and play a sound when a connected session needs you.",
                    actionTitle: "Enable Notifications",
                    action: { Task { await notificationPermission.request() } }
                )
                .padding(.bottom, 8)

                Divider()
            } else if notificationPermission.access == .denied {
                MacNotificationAccessNotice(
                    systemImage: "bell.slash.fill",
                    tint: .orange,
                    title: "Notifications are off",
                    detail: "Remi can still show waiting questions in the app and menu bar, but macOS will not show banners or play notification sounds.",
                    actionTitle: "Open System Settings",
                    action: openNotificationSettings
                )
                .padding(.bottom, 8)

                Divider()
            }

            Toggle("Concise question summaries", isOn: $summariesEnabled)
                .font(.headline)
            Text("For longer questions, Remi uses Apple Intelligence on device when available. The original question remains unchanged in the conversation.")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .padding(20)
        .background(.quaternary.opacity(0.45), in: .rect(cornerRadius: 14))
    }

    private func openNotificationSettings() {
        guard let url = URL(
            string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension"
        ) else { return }
        if !NSWorkspace.shared.open(url),
           let settingsURL = URL(string: "x-apple.systempreferences:") {
            NSWorkspace.shared.open(settingsURL)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Device authorization", systemImage: "key.horizontal")
                .font(.title2.weight(.semibold))
            Text("Use this Mac’s identity to approve it on each machine running Remi.")
                .font(.body)
                .foregroundStyle(.secondary)
        }
    }

    private var accessCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("What authorization allows", systemImage: "checkmark.shield")
                .font(.headline)

            Text("An authorized Remi client can view sessions exposed by that machine, read their conversations, send chat, answer approval prompts, create sessions, and stop sessions. The host daemon still controls which sessions and capabilities are available.")
                .foregroundStyle(.secondary)

            Divider()

            Label("The exported identity contains only the public key. The private key remains in this Mac’s Keychain and is not included when you copy or share.", systemImage: "lock.fill")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .padding(20)
        .background(.quaternary.opacity(0.45), in: .rect(cornerRadius: 14))
    }

    private var identityCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .firstTextBaseline) {
                Text("Public identity")
                    .font(.headline)
                Spacer()
                Text(publicIdentity.fingerprint)
                    .font(.system(.callout, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }

            Text("For a pending connection, run this on the machine you are connecting to:")
                .font(.callout)
                .foregroundStyle(.secondary)

            Text(authorizeCommand)
                .font(.system(.callout, design: .monospaced))
                .textSelection(.enabled)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.background, in: .rect(cornerRadius: 10))

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) {
                    actionButtons
                }
                VStack(alignment: .leading, spacing: 10) {
                    actionButtons
                }
            }
        }
        .padding(20)
        .background(.quaternary.opacity(0.45), in: .rect(cornerRadius: 14))
    }

    private var actionButtons: some View {
        Group {
            Button(copiedValue == .command ? "Command copied" : "Copy command", systemImage: copiedValue == .command ? "checkmark" : "doc.on.doc") {
                copy(authorizeCommand, value: .command)
            }

            Button(copiedValue == .identity ? "Identity copied" : "Copy public identity", systemImage: copiedValue == .identity ? "checkmark" : "key") {
                copy(publicIdentity.exportJSON, value: .identity)
            }

            ShareLink(
                item: publicIdentity.exportJSON,
                subject: Text("Remi public identity"),
                message: Text("Install this public identity on a Remi machine to pre-authorize this Mac.")
            ) {
                Label("Share identity", systemImage: "square.and.arrow.up")
            }
        }
    }

    private var authorizeCommand: String {
        publicIdentity.authorizeCommand(label: Host.current().localizedName ?? "Mac")
    }

    private func copy(_ string: String, value: CopiedValue) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(string, forType: .string)
        copiedValue = value
    }
}

private struct MacNotificationAccessNotice: View {
    let systemImage: String
    let tint: Color
    let title: LocalizedStringKey
    let detail: LocalizedStringKey
    let actionTitle: LocalizedStringKey
    let action: () -> Void

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .top, spacing: 12) {
                message
                Spacer(minLength: 12)
                Button(actionTitle, action: action)
            }

            VStack(alignment: .leading, spacing: 12) {
                message
                Button(actionTitle, action: action)
            }
        }
    }

    private var message: some View {
        Label {
            VStack(alignment: .leading, spacing: 5) {
                Text(title)
                    .font(.headline)
                Text(detail)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        } icon: {
            Image(systemName: systemImage)
                .font(.title3)
                .foregroundStyle(tint)
                .accessibilityHidden(true)
        }
    }
}

private enum CopiedValue {
    case command
    case identity
}

#Preview("Settings · Notifications Not Requested") {
    MacPreferencesView(
        publicIdentity: PublicClientIdentity(
            publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            fingerprint: "6323efd4d1c6c63f"
        ),
        notificationPermission: MacNotificationPermission(access: .notDetermined),
        refreshNotificationPermission: false
    )
}

#Preview("Settings · Notifications Denied") {
    MacPreferencesView(
        publicIdentity: PublicClientIdentity(
            publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            fingerprint: "6323efd4d1c6c63f"
        ),
        notificationPermission: MacNotificationPermission(access: .denied),
        refreshNotificationPermission: false
    )
}

#Preview("Settings · Accessibility") {
    MacPreferencesView(
        publicIdentity: PublicClientIdentity(
            publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            fingerprint: "6323efd4d1c6c63f"
        ),
        notificationPermission: MacNotificationPermission(access: .allowed),
        refreshNotificationPermission: false
    )
    .environment(\.dynamicTypeSize, .accessibility5)
}
