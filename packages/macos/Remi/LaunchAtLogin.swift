//
//  LaunchAtLogin.swift
//  Remi
//
//  "Open Remi at Login" via SMAppService.mainApp (#651) — sandbox-safe,
//  macOS 13+. This registers the APP as a login item; the HUB's autostart
//  is a separate concern (the LaunchAgent `remi --install` writes), and the
//  menu copy deliberately keeps the two apart.
//

import ServiceManagement
import SwiftUI

/// No unit tests on purpose: register()/unregister() mutate the REAL login
/// items of whoever runs the suite (including CI runners), and the status
/// getter is a one-line system read. Do not bolt tests onto this type.
@MainActor
final class LaunchAtLogin: ObservableObject {
    /// Registered but awaiting user approval in System Settings > Login
    /// Items (#749 review): a normal post-register() state — register()
    /// does NOT throw for it — that must render as its own menu state, not
    /// as a toggle that silently snaps back off.
    var needsApproval: Bool {
        SMAppService.mainApp.status == .requiresApproval
    }

    /// Two-way binding surface for the menu toggle. Reads the live
    /// SMAppService status; writes register/unregister and re-reads, so a
    /// user denial in System Settings snaps the toggle back to reality
    /// instead of lying.
    var isEnabled: Bool {
        get { SMAppService.mainApp.status == .enabled }
        set {
            do {
                if newValue {
                    try SMAppService.mainApp.register()
                } else {
                    try SMAppService.mainApp.unregister()
                }
            } catch {
                // Surface, don't swallow: the common cause is the user
                // managing the item from System Settings > Login Items.
                NSLog("[LaunchAtLogin] toggle failed: %@", error.localizedDescription)
            }
            objectWillChange.send()
        }
    }

    /// Route the user to the exact System Settings pane that resolves
    /// `.requiresApproval` (per Apple's login-items guidance).
    func openSystemSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }
}
