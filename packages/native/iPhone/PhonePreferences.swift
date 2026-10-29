import SwiftUI
import RemiKit
import RemiPush
import RemiUI
import UIKit

enum PhonePreferenceKey {
    static let questionNotifications = NativeNotificationPreferences.questionsKey
    static let notificationSounds = RemiPushPresentation.soundsPreferenceKey
    static let haptics = "remi.phone.haptics"
}

struct PhonePreferencesSheet: View {
    let publicIdentity: PublicClientIdentity?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage(PhonePreferenceKey.questionNotifications) private var notificationsEnabled = true
    @AppStorage(NativeNotificationPreferences.turnCompleteKey) private var turnCompleteEnabled = false
    @AppStorage(PhonePreferenceKey.notificationSounds) private var soundsEnabled = true
    @AppStorage(PhonePreferenceKey.haptics) private var hapticsEnabled = true
    @AppStorage(QuestionNotificationSummarizer.preferenceKey) private var summariesEnabled = true
    @State private var authorizationState = NotificationAuthorizationState.unknown
    @State private var copiedIdentity = false

    init(publicIdentity: PublicClientIdentity? = nil) {
        self.publicIdentity = publicIdentity
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("Question notifications", isOn: $notificationsEnabled)
                    Toggle("Turn-complete notifications", isOn: $turnCompleteEnabled)
                    Toggle("Notification sounds", isOn: $soundsEnabled)
                        .disabled(!anyNotificationsEnabled)
                        .onChange(of: soundsEnabled) { _, enabled in
                            RemiPushPresentation.shareSoundsPreference(
                                enabled, with: UserDefaults(suiteName: RemiPushPresentation.sharedDefaultsSuite))
                        }
                    Toggle("Concise question summaries", isOn: $summariesEnabled)
                        .disabled(!notificationsEnabled)

                    VStack(alignment: .leading, spacing: 6) {
                        ViewThatFits(in: .horizontal) {
                            HStack(spacing: 12) {
                                Text("iOS permission")
                                Spacer(minLength: 16)
                                authorizationLabel
                            }

                            VStack(alignment: .leading, spacing: 6) {
                                Text("iOS permission")
                                authorizationLabel
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }

                        Text(authorizationState.detail)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .frame(minHeight: 44)

                    if anyNotificationsEnabled && authorizationState == .notDetermined {
                        Button("Enable notifications", systemImage: "bell.badge") {
                            Task { authorizationState = await PhoneNotificationCoordinator.requestAuthorization() }
                        }
                    } else if anyNotificationsEnabled && authorizationState == .denied {
                        Button("Open Notification Settings", systemImage: "gear") {
                            Task { await PhoneNotificationCoordinator.openSystemSettings() }
                        }
                    }
                } header: {
                    Label("Notifications", systemImage: "bell.badge")
                } footer: {
                    Text(notificationFooter)
                }

                if let publicIdentity {
                    Section {
                        LabeledContent("Fingerprint", value: publicIdentity.fingerprint)
                            .fontDesign(.monospaced)
                            .textSelection(.enabled)
                        Button(copiedIdentity ? "Public identity copied" : "Copy public identity", systemImage: copiedIdentity ? "checkmark" : "doc.on.doc") {
                            UIPasteboard.general.string = publicIdentity.exportJSON
                            copiedIdentity = true
                        }
                        ShareLink(
                            item: publicIdentity.exportJSON,
                            subject: Text("Remi public identity"),
                            message: Text("Authorize this device with `remi authorize <file> --label device-name`.")
                        ) {
                            Label("Share public identity", systemImage: "square.and.arrow.up")
                        }
                        PhoneIdentityAccessNotice()
                    } header: {
                        Label("Device identity", systemImage: "key.horizontal")
                    } footer: {
                        Text("This contains no private key. Installing it on a machine authorizes this device to connect there.")
                    }
                }

                Section {
                    Toggle("Haptic feedback", isOn: $hapticsEnabled)
                } header: {
                    Label("Feedback", systemImage: "iphone.radiowaves.left.and.right")
                } footer: {
                    Text("Use subtle feedback for new questions and answers.")
                }
            }
            .navigationTitle("Preferences")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .onChange(of: notificationsEnabled) { _, enabled in
                NativeRelayNotifications.shared.notificationPreferencesDidChange()
                guard enabled else { return }
                Task { authorizationState = await PhoneNotificationCoordinator.requestAuthorization() }
            }
            .onChange(of: turnCompleteEnabled) { _, enabled in
                NativeRelayNotifications.shared.notificationPreferencesDidChange()
                guard enabled else { return }
                Task { authorizationState = await PhoneNotificationCoordinator.requestAuthorization() }
            }
            .onChange(of: scenePhase) { _, phase in
                guard phase == .active else { return }
                Task { await refreshAuthorizationState() }
            }
            .task { await refreshAuthorizationState() }
        }
    }

    private var anyNotificationsEnabled: Bool { notificationsEnabled || turnCompleteEnabled }

    private var notificationFooter: LocalizedStringResource {
        if !anyNotificationsEnabled {
            return "Question and turn-complete alerts are off. Host-configured subagent alerts may still arrive."
        }
        if authorizationState == .denied {
            return "Notifications are blocked by iOS. Open Settings to allow alerts when a connected session needs you."
        }
        return "Turn-complete alerts require the host setting and minimum duration (60 seconds by default). Error and denial alerts are off; host-configured subagent alerts may still arrive. Changes apply when connected machines update their notification registration."
    }

    private var authorizationLabel: some View {
        HStack(spacing: 6) {
            Image(systemName: authorizationState.systemImage)
                .accessibilityHidden(true)
            Text(authorizationState.title)
        }
            .foregroundStyle(authorizationState.isAllowed ? .green : .secondary)
    }

    private func refreshAuthorizationState() async {
        authorizationState = await PhoneNotificationCoordinator.authorizationState()
    }
}

private struct PhoneIdentityAccessNotice: View {
    var body: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: RemiTheme.Spacing.s) {
                accessRow("View sessions, transcripts, and questions", systemImage: "rectangle.stack")
                accessRow("Answer prompts and send chat messages", systemImage: "bubble.left.and.bubble.right")
                accessRow("Create, resume, and stop sessions", systemImage: "playpause")

                Text("Authorization applies only to Remi on that machine. The shared public identity contains no private key.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .padding(.top, RemiTheme.Spacing.xs)
        } label: {
            Label("What machine access allows", systemImage: "info.circle")
        }
    }

    private func accessRow(_ title: LocalizedStringResource, systemImage: String) -> some View {
        Label {
            Text(title)
        } icon: {
            Image(systemName: systemImage)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
        }
        .font(.subheadline)
    }
}
