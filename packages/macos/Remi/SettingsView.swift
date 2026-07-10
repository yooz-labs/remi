//
//  SettingsView.swift
//  Remi
//
//  Settings scene (#773): the app-at-login toggle mirrors the menu, plus a
//  Hub section explaining the hub's own login item (remi --install) — the
//  sandboxed app cannot install that LaunchAgent itself.
//

import SwiftUI

struct SettingsView: View {
    @ObservedObject var hubClient: HubClient
    @ObservedObject var launchAtLogin: LaunchAtLogin

    var body: some View {
        Form {
            Section("Application") {
                // Same semantics as the menu toggle (#651): needsApproval
                // gets its own button rather than a toggle that would
                // silently snap back off.
                if launchAtLogin.needsApproval {
                    Button("Login Item Pending Approval — Open System Settings") {
                        launchAtLogin.openSystemSettings()
                    }
                } else {
                    Toggle("Open Remi at Login", isOn: $launchAtLogin.isEnabled)
                }
            }

            Section("Hub") {
                Text(hubClient.menuStatusLine)
                    .foregroundStyle(.secondary)
                CommandRow(
                    title: "Start hub at login",
                    caption:
                        "Remi is sandboxed and can't install this for you; run it once from Terminal. Installs a LaunchAgent that keeps the hub running and restarts it if it crashes.",
                    command: HubSetupCommands.autostart)
            }
        }
        .padding(20)
        .frame(width: 420)
    }
}
