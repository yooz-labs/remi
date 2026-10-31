import RemiKit
import SwiftUI

/// Reviews only app-local historical alert candidates. Every destructive action is scoped
/// to a single freshly revalidated selection; secure push and sessions are separate.
struct PhoneLocalNoticeReviewSheet: View {
    let owner: NativeLocalNotificationOwner
    @Environment(\.dismiss) private var dismiss
    @State private var alerts: [NativeLocalNotificationOwner.EarlierAlert] = []
    @State private var debts: [NativeLocalNotificationOwner.UnassignedDebt] = []
    @State private var selectedAlert: AlertSelection?
    @State private var selectedDebt: DebtSelection?
    @State private var loading = false
    @State private var message: String?

    private struct AlertSelection {
        let alert: NativeLocalNotificationOwner.EarlierAlert
        let confirmation: NativeLocalNotificationOwner.AlertConfirmation
        var message: String {
            let details = [alert.title, alert.body].filter { !$0.isEmpty }.joined(separator: "\n\n")
            return details.isEmpty ? "Remove this alert from Notification Center?" : details
        }
    }
    private struct DebtSelection {
        let debt: NativeLocalNotificationOwner.UnassignedDebt
        let confirmation: NativeLocalNotificationOwner.DebtConfirmation
    }

    var body: some View {
        NavigationStack {
            List {
                if let message {
                    Section { Label(message, systemImage: "exclamationmark.triangle").foregroundStyle(.secondary) }
                }
                if loading { Section { ProgressView("Checking earlier alerts") } }
                if !alerts.isEmpty {
                    Section {
                        ForEach(alerts) { alert in
                            Button {
                                guard let confirmation = owner.prepareAlertConfirmation(alert.id) else {
                                    message = "That alert changed. Refresh and try again."; return
                                }
                                selectedAlert = AlertSelection(alert: alert, confirmation: confirmation)
                            } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(alert.title.isEmpty ? "Earlier alert" : alert.title)
                                        .font(.headline).foregroundStyle(Color.primary)
                                    if !alert.body.isEmpty { Text(alert.body).font(.subheadline).foregroundStyle(Color.secondary) }
                                    if let date = alert.deliveredAt {
                                        Text(date, format: .dateTime.month().day().hour().minute())
                                            .font(.caption).foregroundStyle(Color.secondary)
                                    }
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .disabled(loading)
                        }
                    } header: { Text("Earlier alerts") }
                    footer: { Text("Choose an alert to review its removal. Remi cannot associate it with a current machine.") }
                }
                if !debts.isEmpty {
                    Section {
                        ForEach(debts) { debt in
                            Button {
                                guard let confirmation = owner.prepareDebtConfirmation(debt.id) else {
                                    message = "That history changed. Refresh and try again."; return
                                }
                                selectedDebt = DebtSelection(debt: debt, confirmation: confirmation)
                            } label: {
                                Label("Unassigned alert · \(debt.identifierSuffix)", systemImage: "questionmark.circle")
                            }
                            .disabled(loading)
                        }
                    } header: { Text("Unassigned alert history") }
                    footer: { Text("These records cannot be matched to a current machine.") }
                }
                if !loading && alerts.isEmpty && debts.isEmpty && message == nil {
                    Section {
                        ContentUnavailableView("Nothing available to review", systemImage: "bell.slash",
                                               description: Text("Older or unverified alerts may still appear in Notification Center."))
                    }
                }
            }
            .navigationTitle("Earlier alerts")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Button("Refresh", systemImage: "arrow.clockwise") { Task { await refresh() } }
                        .disabled(loading)
                }
            }
            .task { await refresh() }
            .confirmationDialog("Remove this earlier alert?", isPresented: alertDialog, titleVisibility: .visible,
                                presenting: selectedAlert) { selection in
                Button("Remove alert", role: .destructive) { Task { await remove(selection) } }
                Button("Cancel", role: .cancel) { }
            } message: { selection in
                Text(selection.message)
            }
            .confirmationDialog("Stop tracking this alert?", isPresented: debtDialog, titleVisibility: .visible,
                                presenting: selectedDebt) { selection in
                Button("Stop tracking", role: .destructive) { Task { await abandon(selection) } }
                Button("Cancel", role: .cancel) { }
            } message: { selection in
                Text("Alert \(selection.debt.identifierSuffix) may still appear later. This does not remove a visible alert or change any machine.")
            }
        }
    }

    private var alertDialog: Binding<Bool> {
        Binding(get: { selectedAlert != nil }, set: { if !$0 { selectedAlert = nil } })
    }
    private var debtDialog: Binding<Bool> {
        Binding(get: { selectedDebt != nil }, set: { if !$0 { selectedDebt = nil } })
    }

    @MainActor private func refresh() async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let found = try await owner.reviewEarlierAlerts()
            let unassigned = try owner.reviewUnassignedDebt()
            alerts = found; debts = unassigned; message = nil
        } catch {
            alerts = []; debts = []; message = "Couldn’t check earlier alerts. Try again."
        }
    }

    @MainActor private func remove(_ selection: AlertSelection) async {
        guard !loading else { return }
        loading = true
        let outcome = await owner.confirmAlert(selection.confirmation)
        loading = false
        switch outcome {
        case .completed: await refresh()
        case .changed: message = "That alert changed. Refresh and try again."
        case .unavailable: message = "Couldn’t remove the alert. Try again."
        }
    }

    @MainActor private func abandon(_ selection: DebtSelection) async {
        guard !loading else { return }
        loading = true
        let outcome = await owner.confirmAbandoningDebt(selection.confirmation)
        loading = false
        switch outcome {
        case .completed: await refresh()
        case .changed: message = "That history changed. Refresh and try again."
        case .unavailable: message = "Couldn’t update the alert history. Try again."
        }
    }
}
