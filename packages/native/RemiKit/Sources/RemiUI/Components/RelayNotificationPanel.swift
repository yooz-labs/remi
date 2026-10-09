import RemiKit
import RemiPush
import SwiftUI

/// Choices come only from the independently reopened signed capsule. No static
/// notification action categories are installed in this milestone (#1242).
public struct RelayNotificationPanel: View {
    private let store: MachineStore
    private let onClose: () -> Void

    public init(store: MachineStore, onClose: @escaping () -> Void) {
        self.store = store
        self.onClose = onClose
    }

    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: RemiTheme.Spacing.m) {
                    if let card = store.verifiedRelayNotification {
                        Text(card.title).font(.title2.bold())
                        Text(card.body).textSelection(.enabled)
                        ForEach(store.relayNotificationChoices, id: \.value) { option in
                            Button {
                                Task { await store.answerRelayNotification(choice: option.value) }
                            } label: {
                                VStack(alignment: .leading, spacing: RemiTheme.Spacing.xs) {
                                    Text(PushDisplayText.escape(option.label))
                                    if let description = option.description {
                                        Text(PushDisplayText.escape(description)).font(.caption)
                                    }
                                    if option.standingGrant != nil {
                                        Text("For this session").font(.caption)
                                    }
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.vertical, RemiTheme.Spacing.xs)
                            }
                            .buttonStyle(.bordered)
                            .disabled(store.relayNotificationBusy)
                        }
                        if card.kind == .question, store.relayNotificationChoices.isEmpty {
                            Text("Open this session to review the question.")
                                .foregroundStyle(.secondary)
                        }
                    } else {
                        ContentUnavailableView("Notification unavailable", systemImage: "bell.slash",
                            description: Text("This notification could not be verified or is no longer current."))
                    }
                    if store.relayNotificationBusy { ProgressView("Sending answer") }
                    if let notice = store.relayNotificationNotice {
                        Text(notice).foregroundStyle(.secondary)
                    }
                }
                .padding(RemiTheme.Spacing.l)
            }
            .navigationTitle("Relay notification")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done", action: onClose)
                }
            }
        }
    }
}
