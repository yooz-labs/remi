import RemiKit
import SwiftUI

/// The production history projection keeps display escaping separate from clipboard recovery.
struct RemiOutgoingHistoryRow: Sendable {
    let entry: RemiTranscriptEntry
    let copyText: String

    init(message: OutgoingMessage) {
        entry = .pending(id: message.id, text: RemiDisplayText.escape(message.content),
            state: RemiOutgoingState(delivery: message.delivery))
        copyText = message.content
    }
}

/// A reachable recovery surface even after the machine or session has left the main list.
/// Dismissal changes only local memory; this view has no send or retry action (#1710).
public struct RemiOutgoingHistoryView: View {
    @Environment(\.dismiss) private var dismiss
    private let groups: [OutgoingMessageGroup]
    private let onDismiss: (OutgoingGroupID, String) -> Void

    public init(groups: [OutgoingMessageGroup], onDismiss: @escaping (OutgoingGroupID, String) -> Void) {
        self.groups = groups
        self.onDismiss = onDismiss
    }

    private var isNearCapacity: Bool {
        groups.count >= MachineStore.outgoingSessionLimit - 4
            || groups.reduce(0, { $0 + $1.messages.count }) >= MachineStore.outgoingRowLimit - 32
            || groups.contains { $0.remainingSessionCapacity <= 5 }
    }

    public var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: RemiTheme.Spacing.l) {
                    Text("Available while Remi is running; copy before closing. Ended sessions and removed profiles stay here during that time. Nothing is resent.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    if isNearCapacity {
                        Text("Message outcomes is nearly full. Copy messages you need, then dismiss outcomes to make room.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if groups.isEmpty {
                        ContentUnavailableView("No retained outcomes", systemImage: "tray")
                    }
                    ForEach(groups) { group in
                        VStack(alignment: .leading, spacing: RemiTheme.Spacing.s) {
                            Text(RemiDisplayText.escape(group.machineName)).font(.headline)
                            Text(RemiDisplayText.escape(group.sessionName)).font(.subheadline)
                            Text(group.isCurrentProfile ? "Current profile" : "Earlier profile")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Text("Machine: \(RemiDisplayText.escape(group.key.machineID))\nSession: \(RemiDisplayText.escape(group.key.sessionID))")
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                            ForEach(group.messages) { message in
                                let row = RemiOutgoingHistoryRow(message: message)
                                RemiTranscriptEntryView(entry: row.entry, copyText: row.copyText,
                                    onDismissOutgoing: { onDismiss(group.id, $0) })
                            }
                        }
                        Divider()
                    }
                }
                .padding(RemiTheme.Spacing.m)
            }
            .navigationTitle("Message outcomes")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
