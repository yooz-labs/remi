import RemiKit
import RemiUI
import SwiftUI
import UIKit

struct MachinesSection: View {
    let machines: [RemiMachineSummary]
    let states: [MachineState]
    let publicIdentity: PublicClientIdentity?
    let onRemove: (String) -> Void
    let onRetryApproval: (MachineEndpoint) -> Void
    let onRetryConnection: (MachineEndpoint) -> Void
    let onSetConnectionPreference: (MachineEndpoint, MachineConnectionPreference) -> Void
    let onPairAgain: () -> Void
    let onEnableRelayNotifications: (MachineEndpoint) -> Void
    let enablingRelayNotifications: Bool
    let showsTitle: Bool
    @State private var pendingRemoval: RemiMachineSummary?

    var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.xs) {
            if showsTitle {
                Text("Machines").font(.title2.weight(.bold))
            }
            ForEach(machines) { machine in
                let state = states.first { $0.id == machine.id }
                PhoneMachineManagementRow(
                    machine: machine,
                    state: state,
                    enablingRelayNotifications: enablingRelayNotifications,
                    onEnableRelayNotifications: onEnableRelayNotifications,
                    onRetryConnection: onRetryConnection,
                    onSetConnectionPreference: onSetConnectionPreference,
                    onRemove: { pendingRemoval = machine }
                )
                if let state = states.first(where: { $0.id == machine.id }),
                   case .waitingForApproval(let fingerprint) = state.status {
                    ApprovalHelp(
                        machineName: machine.name,
                        fingerprint: fingerprint,
                        command: publicIdentity?.authorizeCommand(label: UIDevice.current.name),
                        onRetry: { onRetryApproval(state.endpoint) }
                    )
                }
                if let state = states.first(where: { $0.id == machine.id }),
                   case .waitingForRelayConfirmation(let fingerprint) = state.status {
                    RelayConfirmationHelp(machineName: machine.name, fingerprint: fingerprint)
                }
                if let state = states.first(where: { $0.id == machine.id }) {
                    PhoneMachineRecoveryHelp(
                        machineName: machine.name,
                        state: RemiMachineRecoveryState.resolve(
                            status: state.status,
                            isRelay: state.endpoint.relayPin != nil
                        ),
                        onRetry: { onRetryConnection(state.endpoint) },
                        onPairAgain: onPairAgain
                    )
                }
                if machine.id != machines.last?.id { Divider() }
            }
        }
        .alert(
            "Remove machine?",
            isPresented: Binding(
                get: { pendingRemoval != nil },
                set: { if !$0 { pendingRemoval = nil } }
            ),
            presenting: pendingRemoval
        ) { machine in
            Button("Remove", role: .destructive) {
                onRemove(machine.id)
                pendingRemoval = nil
            }
            Button("Cancel", role: .cancel) { pendingRemoval = nil }
        } message: { machine in
            Text("Remi will forget \(machine.name) and its cached conversations on this device. Sessions on the machine keep running.")
        }
    }
}

struct PhoneMachineRecoveryHelp: View {
    let machineName: String
    let state: RemiMachineRecoveryState
    let onRetry: () -> Void
    let onPairAgain: () -> Void

    var body: some View {
        switch state {
        case .retryableOffline:
            recoveryCard(
                title: "Machine offline",
                detail: "Remi is not connected to \(machineName).",
                actionTitle: "Retry connection",
                systemImage: "arrow.clockwise",
                action: onRetry
            )
        case .retryableUnavailable(let reason):
            recoveryCard(
                title: "Machine unavailable",
                detail: reason ?? "Remi could not connect to \(machineName).",
                actionTitle: "Retry connection",
                systemImage: "arrow.clockwise",
                action: onRetry
            )
        case .relayOffline:
            recoveryCard(
                title: "Relay machine offline",
                detail: "Remi will reconnect through the relay when \(machineName) becomes available."
            )
        case .relayNeedsFreshPairing(let reason):
            recoveryCard(
                title: "Relay pairing unavailable",
                detail: relayPairingDetail(reason),
                actionTitle: "Pair again",
                systemImage: "arrow.trianglehead.2.clockwise.rotate.90",
                action: onPairAgain
            )
        case .none, .waitingForDirectApproval, .waitingForRelayConfirmation:
            EmptyView()
        }
    }

    private func recoveryCard(
        title: LocalizedStringKey,
        detail: String,
        actionTitle: LocalizedStringKey? = nil,
        systemImage: String = "network.slash",
        action: (() -> Void)? = nil
    ) -> some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.s) {
            Label(title, systemImage: "desktopcomputer.trianglebadge.exclamationmark")
                .font(.headline)
            Text(detail)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            if let actionTitle, let action {
                Button(actionTitle, systemImage: systemImage, action: action)
                    .frame(minHeight: RemiTheme.Size.minimumTapTarget)
                    .contentShape(.rect)
            }
        }
        .padding(RemiTheme.Spacing.m)
        .background(.quaternary.opacity(0.45), in: .rect(cornerRadius: RemiTheme.Radius.control))
    }

    private func relayPairingDetail(_ reason: String?) -> String {
        let instruction = "Create a fresh relay pairing token on \(machineName)."
        guard let reason, !reason.isEmpty else { return instruction }
        return "\(reason) \(instruction)"
    }
}

struct RelayConfirmationHelp: View {
    let machineName: String
    let fingerprint: String

    var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.s) {
            Label("Terminal confirmation needed", systemImage: "checkmark.shield")
                .font(.headline)

            Text("On \(machineName), compare this fingerprint before approving the relay connection.")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            Text(fingerprint)
                .font(.system(.body, design: .monospaced, weight: .semibold))
                .textSelection(.enabled)

            Text("The pairing token does not authorize this phone by itself.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(RemiTheme.Spacing.m)
        .background(.quaternary.opacity(0.45), in: .rect(cornerRadius: RemiTheme.Radius.control))
    }
}

struct PhoneMachineManagementRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let machine: RemiMachineSummary
    let state: MachineState?
    let enablingRelayNotifications: Bool
    let onEnableRelayNotifications: (MachineEndpoint) -> Void
    let onRetryConnection: (MachineEndpoint) -> Void
    let onSetConnectionPreference: (MachineEndpoint, MachineConnectionPreference) -> Void
    let onRemove: () -> Void

    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: RemiTheme.Spacing.s))
            : AnyLayout(HStackLayout(alignment: .center, spacing: RemiTheme.Spacing.s))

        layout {
            RemiMachineRow(machine: machine)
                .frame(maxWidth: .infinity, alignment: .leading)
                .layoutPriority(1)

            Menu {
                if let state {
                    Picker("Connection layer", selection: Binding(
                        get: { state.connectionPreference },
                        set: { onSetConnectionPreference(state.endpoint, $0) }
                    )) {
                        ForEach(MachineConnectionPreference.allCases) { preference in
                            Text(preference.title).tag(preference)
                        }
                    }
                    Divider()
                    Text("Active: \(state.activeConnectionLayer?.title ?? "Not connected")")
                    if let attempted = state.attemptedConnectionLayer { Text("Attempting: \(attempted.title)") }
                    if let progress = state.recoveryProgress { Text(progress.message) }
                }
                if let state, canRetryConnection(state) {
                    Button("Retry connection", systemImage: "arrow.clockwise") {
                        onRetryConnection(state.endpoint)
                    }
                }
                if let state, state.endpoint.relayPin != nil {
                    Button("Enable relay notifications", systemImage: "bell.badge") {
                        onEnableRelayNotifications(state.endpoint)
                    }
                    .disabled(enablingRelayNotifications || state.status != .connected)
                }
                Button("Remove machine", systemImage: "trash", role: .destructive) {
                    onRemove()
                }
            } label: {
                if dynamicTypeSize.isAccessibilitySize {
                    Label("Machine actions", systemImage: "ellipsis.circle")
                } else {
                    Label("Machine actions", systemImage: "ellipsis.circle")
                        .labelStyle(.iconOnly)
                        .font(.title3)
                        .frame(
                            width: RemiTheme.Size.minimumTapTarget,
                            height: RemiTheme.Size.minimumTapTarget
                        )
                        .contentShape(.rect)
                }
            }
        }
    }

    private func canRetryConnection(_ state: MachineState) -> Bool {
        state.sessionConnectionIssue != nil || state.recoveryProgress?.allowsRetry == true || RemiMachineRecoveryState.resolve(
            status: state.status,
            isRelay: state.endpoint.relayPin != nil
        ).allowsConnectionRetry
    }
}

struct ApprovalHelp: View {
    let machineName: String
    let fingerprint: String
    let command: String?
    let onRetry: () -> Void
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.s) {
            Label("Approval needed", systemImage: "person.badge.key")
                .font(.headline)
            Text("On \(machineName), compare this fingerprint and authorize this iPhone.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text(fingerprint)
                .font(.system(.body, design: .monospaced).weight(.semibold))
                .textSelection(.enabled)

            if let command {
                Text(command)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(RemiTheme.Spacing.s)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.background, in: .rect(cornerRadius: RemiTheme.Radius.control))

                Button(copied ? "Command copied" : "Copy authorization command", systemImage: copied ? "checkmark" : "doc.on.doc") {
                    UIPasteboard.general.string = command
                    copied = true
                }
                .frame(minHeight: RemiTheme.Size.minimumTapTarget)
                .contentShape(.rect)
            }
            Button("Retry connection", systemImage: "arrow.clockwise", action: onRetry)
                .buttonStyle(.glassProminent)
                .frame(minHeight: RemiTheme.Size.minimumTapTarget)
                .contentShape(.rect)
        }
        .padding(RemiTheme.Spacing.m)
        .background(.orange.opacity(0.08), in: .rect(cornerRadius: RemiTheme.Radius.control))
    }
}
