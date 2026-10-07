import SwiftUI

enum PhonePreferenceKey {
    static let questionNotifications = "remi.phone.question-notifications"
    static let notificationSounds = "remi.phone.notification-sounds"
    static let haptics = "remi.phone.haptics"
}

struct PhonePreferencesSheet: View {
    @Environment(\.dismiss) private var dismiss
    @AppStorage(PhonePreferenceKey.questionNotifications) private var notificationsEnabled = true
    @AppStorage(PhonePreferenceKey.notificationSounds) private var soundsEnabled = true
    @AppStorage(PhonePreferenceKey.haptics) private var hapticsEnabled = true

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("Question notifications", isOn: $notificationsEnabled)
                    Toggle("Notification sounds", isOn: $soundsEnabled)
                        .disabled(!notificationsEnabled)
                } header: {
                    Text("Notifications")
                } footer: {
                    Text("Show a local alert when a connected session needs an answer. System notification settings still apply.")
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
                Task { await PhoneNotificationCoordinator.requestAuthorization() }
            }
        }
    }
}
