import RemiKit
import SwiftUI

/// A reachable recovery surface even after the machine or session has left the main list.
/// Dismissal changes only local memory; this view has no send or retry action (#1710).
public struct RemiOutgoingHistoryView: View {
    @Environment(\.dismiss) private var dismiss
    private let groups: [OutgoingMessageGroup]
    private let onDismiss: (MachineSessionKey, String) -> Void

    public init(groups: [OutgoingMessageGroup], onDismiss: @escaping (MachineSessionKey, String) -> Void) {
        self.groups = groups
        self.onDismiss = onDismiss
    }

    public var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: RemiTheme.Spacing.l) {
                    Text("Kept in memory for this app session, including ended sessions and removed machines. Copy text before dismissing. Nothing is resent.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Text("Limits: 50 per session, 512 messages across 64 sessions. At capacity, dismiss an outcome before sending more.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if groups.isEmpty {
                        ContentUnavailableView("No retained outcomes", systemImage: "tray")
                    }
                    ForEach(groups) { group in
                        VStack(alignment: .leading, spacing: RemiTheme.Spacing.s) {
                            Text(RemiDisplayText.escape(group.machineName)).font(.headline)
                            Text(RemiDisplayText.escape(group.sessionName)).font(.subheadline)
                            Text("Machine: \(RemiDisplayText.escape(group.key.machineID))\nSession: \(RemiDisplayText.escape(group.key.sessionID))")
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                            ForEach(group.messages) { message in
                                RemiTranscriptEntryView(entry: .pending(id: message.id,
                                    text: RemiDisplayText.escape(message.content),
                                    state: RemiOutgoingState(delivery: message.delivery)),
                                    onDismissOutgoing: { onDismiss(group.key, $0) })
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
