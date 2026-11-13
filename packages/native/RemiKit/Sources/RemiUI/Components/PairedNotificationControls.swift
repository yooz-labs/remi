import RemiKit
import SwiftUI

/// The same host state and consent controls in Mac and iPhone machine menus.
public struct PairedNotificationControls: View {
    let state: PairedNotificationState?
    let busy: Bool
    let connected: Bool
    let enable: () -> Void
    let revoke: () -> Void
    public init(state: PairedNotificationState?, busy: Bool, connected: Bool,
                enable: @escaping () -> Void, revoke: @escaping () -> Void) {
        self.state = state; self.busy = busy; self.connected = connected
        self.enable = enable; self.revoke = revoke
    }
    public var body: some View {
        if let state { Text(state.title).foregroundStyle(.secondary) }
        if state != .registered {
            Button(state == .renewalRequired ? "Continue notifications" : "Enable notifications", systemImage: "bell.badge", action: enable)
                .disabled(busy || !connected || state == .registering)
        }
        if state != .disabled {
            Button("Revoke notifications", systemImage: "bell.slash", action: revoke).disabled(busy)
        }
    }
}
