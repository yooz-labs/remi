import SwiftUI

/// The user chooses whether to request access or open System Settings.
struct MacNotificationPermissionBanner: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let denied: Bool
    let onEnable: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            : AnyLayout(HStackLayout(alignment: .center, spacing: 12))
        layout {
            Label {
                VStack(alignment: .leading, spacing: 3) {
                    Text(denied ? "Notifications are off" : "Enable notifications")
                        .font(.headline)
                    Text(denied
                        ? "Allow Remi in System Settings to see question and enabled turn-complete alerts."
                        : "Allow Remi to show question and enabled turn-complete alerts.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                .fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: denied ? "bell.slash" : "bell.badge")
                    .accessibilityHidden(true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 8) {
                Button(denied ? "Open Notification Settings" : "Enable Notifications", action: onEnable)
                    .buttonStyle(.borderedProminent)
                Button("Not now", action: onDismiss)
            }
        }
        .padding(12)
        .background(Color.accentColor.opacity(0.08))
    }
}
