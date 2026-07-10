//
//  HubSetupView.swift
//  Remi
//
//  Onboarding panel shown in the main window while no hub is attached
//  (#773). The app is sandboxed and cannot start the hub itself; this walks
//  the user through the terminal commands that do, then gets out of the way
//  once HubClient finds one.
//

import SwiftUI

struct HubSetupView: View {
    @ObservedObject var hubClient: HubClient

    var body: some View {
        Group {
            if case .scanning = hubClient.phase {
                scanningView
            } else {
                // RemiApp only shows this view while hubClient.hubURL is
                // nil, which happens only in .scanning or .unreachable —
                // .connected always has a hub URL. So anything reaching
                // here that isn't .scanning is .unreachable.
                unreachableView
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var scanningView: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Looking for a Remi hub…")
                .foregroundStyle(.secondary)
        }
    }

    private var unreachableView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("No Remi hub is running on this Mac")
                        .font(.title2)
                        .bold()
                    Text(
                        "Remi attaches to the hub daemon (remi serve), which does the actual work of running your Claude Code sessions. Set it up once from Terminal, then this window attaches automatically."
                    )
                    .foregroundStyle(.secondary)
                }

                VStack(alignment: .leading, spacing: 16) {
                    CommandRow(
                        title: "1. Install remi",
                        caption: "Skip this if you already have it installed.",
                        command: HubSetupCommands.install)
                    CommandRow(
                        title: "2. Start the hub",
                        caption: "Runs the hub for this Terminal session.",
                        command: HubSetupCommands.startHub)
                    CommandRow(
                        title: "3. Start the hub automatically at login",
                        caption:
                            "Installs a LaunchAgent that keeps the hub running and restarts it if it crashes; this is the hub's login item, separate from opening this app at login.",
                        command: HubSetupCommands.autostart)
                }

                VStack(alignment: .leading, spacing: 8) {
                    Button("Check Again") { hubClient.rescanNow() }
                    Text(
                        "This window checks automatically and closes on its own once a hub is found."
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
            }
            .padding(32)
            .frame(maxWidth: 560, alignment: .leading)
        }
    }
}

/// A command the user copies into Terminal: title, one-line explanation, the
/// command in monospaced text, and a Copy button. Shared between
/// HubSetupView's onboarding steps and SettingsView's hub section (#773).
struct CommandRow: View {
    let title: String
    var caption: String? = nil
    let command: String

    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.headline)
            if let caption {
                Text(caption)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: 8) {
                Text(command)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(.vertical, 4)
                    .padding(.horizontal, 8)
                    .background(Color.secondary.opacity(0.1))
                    .clipShape(RoundedRectangle(cornerRadius: 4))
                Button(copied ? "Copied" : "Copy") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(command, forType: .string)
                    copied = true
                    // Fire-and-forget label reset instead of a Timer: no
                    // invalidation to worry about, and a view teardown
                    // mid-flight just drops the Task.
                    Task {
                        try? await Task.sleep(nanoseconds: 1_500_000_000)
                        copied = false
                    }
                }
            }
        }
    }
}
