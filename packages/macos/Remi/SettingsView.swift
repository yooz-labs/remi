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
//  ~/Library/LaunchAgents itself: "installed" confirms the LaunchAgent FILE
//  is in place (presence-only — see the job-health caveat at its use site
//  and #791) and drops the command row entirely; "none" warns that remote
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
            // Wording asserts only what detectAutostartState actually
            // verifies: the plist FILE exists, not that the launchd job is
            // healthy (a stale baked binary path after a `brew upgrade`, or
            // an uninstall that failed to bootout, can leave the file
            // present but the job broken/unloaded). Tracked in #791 — once
            // that lands a job-health check, this copy can go back to
            // asserting "starts at login" once it's actually verified.
            VStack(alignment: .leading, spacing: 4) {
                Text("Hub LaunchAgent installed")
                    .foregroundStyle(.secondary)
                Text("Starts the hub automatically at login.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
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
