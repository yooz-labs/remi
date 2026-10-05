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
            switch hubClient.phase {
            case .scanning:
                scanningView
            case let .rejected(port, reason):
                rejectedView(port: port, reason: reason)
            default:
                // RemiApp only shows this view while hubClient.hubURL is
                // nil, which happens only in .scanning, .rejected or
                // .unreachable — .connected always has a hub URL. So
                // anything reaching here is .unreachable.
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

    /// #873: first connect needs local approval. Other authentication failures
    /// keep their distinct reason and never claim a pending request exists.
    private func rejectedView(port: Int, reason: String) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(hubClient.approvalErrorCode == "UNKNOWN_KEY" ? "Approve this app on the daemon machine" : "Hub authentication failed")
                        .font(.title2)
                        .bold()
                    Text(
                        "Found a Remi hub on port \(port), but it rejected this app's identity: \(reason)."
                    )
                    .foregroundStyle(.secondary)
                }

                if let code = hubClient.approvalErrorCode {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Device fingerprint: \(hubClient.publicFingerprint)")
                            .font(.system(.body, design: .monospaced))
                            .textSelection(.enabled)
                        if code == "UNKNOWN_KEY" {
                            Text("On the daemon machine, run remi keys and compare the pending fingerprint with this app. After comparing, run the command below, then Check Again. Requests expire after 10 minutes; retries do not extend that window.")
                                .foregroundStyle(.secondary)
                            CommandRow(title: "Authorize locally", command: hubClient.authorizeCommand)
                        }
                        CommandRow(title: "Public identity JSON", command: hubClient.publicIdentityJSON)
                    }
                }

                VStack(alignment: .leading, spacing: 8) {
                    Button("Check Again") { hubClient.rescanNow() }
                    Text("This window checks automatically and closes once the connection succeeds.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(32)
            .frame(maxWidth: 560, alignment: .leading)
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
    /// Bumped on every click; a pending reset Task only applies if it's
    /// still the latest one when it wakes (#777 review, finding 5), so
    /// rapid re-clicks extend the "Copied" window instead of an earlier
    /// click's reset firing right after a later click.
    @State private var copyGeneration = 0

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
                    copyGeneration += 1
                    let generation = copyGeneration
                    // Fire-and-forget label reset instead of a Timer: no
                    // invalidation to worry about, and a view teardown
                    // mid-flight just drops the Task.
                    Task {
                        try? await Task.sleep(nanoseconds: 1_500_000_000)
                        if generation == copyGeneration {
                            copied = false
                        }
                    }
                }
            }
        }
    }
}
