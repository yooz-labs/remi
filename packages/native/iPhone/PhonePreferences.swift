import SwiftUI

enum PhonePreferenceKey {
    static let questionNotifications = "remi.phone.question-notifications"
    static let notificationSounds = "remi.phone.notification-sounds"
    static let haptics = "remi.phone.haptics"
}

struct PhonePreferencesSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage(PhonePreferenceKey.questionNotifications) private var notificationsEnabled = true
    @AppStorage(PhonePreferenceKey.notificationSounds) private var soundsEnabled = true
    @AppStorage(PhonePreferenceKey.haptics) private var hapticsEnabled = true
    @State private var authorizationState = NotificationAuthorizationState.unknown

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("Question notifications", isOn: $notificationsEnabled)
                    Toggle("Notification sounds", isOn: $soundsEnabled)
                        .disabled(!notificationsEnabled)

                    VStack(alignment: .leading, spacing: 6) {
                        ViewThatFits(in: .horizontal) {
                            HStack(spacing: 12) {
                                Text("System access")
                                Spacer(minLength: 16)
                                authorizationLabel
                            }

                            VStack(alignment: .leading, spacing: 6) {
                                Text("System access")
                                authorizationLabel
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }

                        Text(authorizationState.detail)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .frame(minHeight: 44)

                    if notificationsEnabled && authorizationState == .notDetermined {
                        Button("Enable notifications", systemImage: "bell.badge") {
                            Task { authorizationState = await PhoneNotificationCoordinator.requestAuthorization() }
                        }
                    } else if notificationsEnabled && authorizationState == .denied {
                        Button("Open Notification Settings", systemImage: "gear") {
                            Task { await PhoneNotificationCoordinator.openSystemSettings() }
                        }
                    }
                } header: {
                    Text("Notifications")
                } footer: {
                    Text(notificationFooter)
                }

                Section {
                    Toggle("Haptic feedback", isOn: $hapticsEnabled)
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

    private var notificationFooter: String {
        if !notificationsEnabled {
            return "Remi will not show local question alerts on this device."
        }
        if authorizationState == .denied {
            return "Notifications are blocked by iOS. Open Settings to allow alerts when a connected session needs you."
        }
        return "Show a local alert when a connected session needs an answer."
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
