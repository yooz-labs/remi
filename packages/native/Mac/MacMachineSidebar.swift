import RemiKit
import RemiUI
import SwiftUI

/// Machines that need the person, as the iPhone lists them: up to two lines, then one summary.
/// Choosing a line selects the machine it names, where the recovery steps are.
struct MacMachineProblemRows: View {
    let machines: [RemiMachineSummary]
    let onSelect: (String) -> Void

    var body: some View {
        ForEach(RemiMachineStripPresentation.problemRows(in: machines)) { row in
            Button {
                if let id = RemiMachineStripPresentation.machineID(for: row, in: machines) {
                    onSelect(id)
                }
            } label: {
                Label {
                    Text(verbatim: row.message)
                        .multilineTextAlignment(.leading)
                } icon: {
                    Image(systemName: icon(row)).accessibilityHidden(true)
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(row.accessibilityLabel)
            .accessibilityHint("Shows the machine")
        }
    }

    private func icon(_ row: RemiMachineStripPresentation.ProblemRow) -> String {
        guard case .machine(let problem, _) = row else { return "exclamationmark.triangle" }
        switch problem {
        case .unreachable: return "desktopcomputer.trianglebadge.exclamationmark"
        case .waitingForApproval: return "person.badge.clock"
        }
    }
}

/// A machine row with its recovery note and an accessibility label from the shared
/// presentation, using the unique label when machines share a name.
struct MacMachineSidebarRow: View {
    let machine: RemiMachineSummary
    let label: String
    let recovery: RemiMachineRecoveryState

    var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.xxxs) {
            RemiMachineRow(machine: machine)
            if let title = recovery.title {
                Label {
                    Text(verbatim: title)
                } icon: {
                    Image(systemName: "exclamationmark.circle").accessibilityHidden(true)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .help(recovery.detail(machineName: label) ?? "")
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
    }

    private var accessibilityLabel: String {
        var text = RemiMachineStripPresentation.accessibilityLabel(for: machine, label: label)
        if let title = recovery.title {
            text += ", \(title)"
            if let detail = recovery.detail(machineName: label) { text += ". \(detail)" }
        }
        return text
    }
}
