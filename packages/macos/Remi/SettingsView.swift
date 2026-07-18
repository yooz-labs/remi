//
//  SettingsView.swift
//  Remi
//
//  Settings scene (#773): the app-at-login toggle mirrors the menu, plus a
//  Hub section explaining the hub's own login item (remi --install) — the
//  sandboxed app cannot install that LaunchAgent itself.
//
//  The Hub section is state-aware on `hubClient.autostart` (#788), the
//  field the hub self-reports in `hub_status` since the app cannot read
//  ~/Library/LaunchAgents itself: "installed" confirms the LaunchAgent is
//  in place and drops the command row entirely; "none" warns that remote
//  access won't survive a logout/reboot and keeps the command row so the
//  user can fix it; nil (older hub, field absent) falls back to today's
//  neutral copy since the app genuinely doesn't know either way.
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
                hubAutostartContent
            }
        }
        .padding(20)
        .frame(width: 420)
    }

    @ViewBuilder
    private var hubAutostartContent: some View {
        switch hubClient.autostart {
        case "installed":
            Text("Hub starts at login (LaunchAgent installed)")
                .foregroundStyle(.secondary)
        case "none":
            Text("Hub runs only until you log out — remote access will be down after a reboot.")
                .foregroundStyle(.orange)
            autostartCommandRow
        default:
            // nil: either not connected yet, or a pre-#788 hub that never
            // sends the field — the app genuinely doesn't know, so it
            // keeps today's neutral copy rather than guessing.
            autostartCommandRow
        }
    }

    private var autostartCommandRow: some View {
        CommandRow(
            title: "Start hub at login",
            caption:
                "Remi is sandboxed and can't install this for you; run it once from Terminal. Installs a LaunchAgent that keeps the hub running and restarts it if it crashes.",
            command: HubSetupCommands.autostart)
    }
}
