import AppKit
import RemiKit
import SwiftUI

struct MacPreferencesView: View {
    @Environment(\.scenePhase) private var scenePhase
    let store: MachineStore
    private let refreshNotificationPermission: Bool

    @State private var copiedValue: CopiedValue?
    @State private var notificationPermission = MacNotificationPermission.shared
    @State private var relayNotifications = NativeRelayNotifications.shared
    @State private var selectedMachineID: String?
    @State private var machineToForget: MachineState?
    @State private var machineToRename: MachineState?
    @State private var proposedName = ""
    @AppStorage(QuestionNotificationSummarizer.preferenceKey) private var summariesEnabled = true

    init(
        store: MachineStore,
        notificationPermission: MacNotificationPermission = .shared,
        refreshNotificationPermission: Bool = true
    ) {
        self.store = store
        self.refreshNotificationPermission = refreshNotificationPermission
        _notificationPermission = State(initialValue: notificationPermission)
    }

    var body: some View {
        TabView {
            generalSettings
                .tabItem { Label("General", systemImage: "gearshape") }

            machineSettings
                .tabItem { Label("Machines", systemImage: "desktopcomputer") }

            identitySettings
                .tabItem { Label("Identity", systemImage: "key.horizontal") }
        }
        .frame(width: 760, height: 560)
        .task {
            selectAvailableMachine()
            guard refreshNotificationPermission else { return }
            await notificationPermission.refresh()
        }
        .onChange(of: store.machines.map(\.id)) { _, _ in selectAvailableMachine() }
        .onChange(of: scenePhase) { _, phase in
            guard refreshNotificationPermission, phase == .active else { return }
            Task { await notificationPermission.refresh() }
        }
        .alert("Rename machine", isPresented: renamePresentation) {
            TextField("Machine name", text: $proposedName)
            Button("Cancel", role: .cancel) { machineToRename = nil }
            Button("Save") { renameMachine() }
                .disabled(trimmedProposedName.isEmpty || trimmedProposedName.count > 80)
        } message: {
            Text("Choose a short name that makes this machine easy to recognize. The name is stored only on this Mac.")
        }
        .confirmationDialog(
            "Forget \(machineToForget?.displayName ?? "machine")?",
            isPresented: forgetPresentation,
            titleVisibility: .visible
        ) {
            Button("Forget machine", role: .destructive) { forgetMachine() }
            Button("Cancel", role: .cancel) { machineToForget = nil }
        } message: {
            Text("Remi will remove this endpoint and cached conversations from this Mac. Sessions on the machine keep running.")
        }
    }

    private var generalSettings: some View {
        PreferencesPage(
            title: "General",
            subtitle: "Control how Remi gets your attention."
        ) {
            PreferencesCard(title: "Notifications", systemImage: "bell.badge") {
                if notificationPermission.access == .notDetermined {
                    MacNotificationAccessNotice(
                        systemImage: "bell.badge",
                        tint: .secondary,
                        title: "Allow question alerts",
                        detail: "macOS permission lets Remi show a banner and play a sound when a connected session needs you.",
                        actionTitle: "Enable Notifications",
                        action: { Task { await notificationPermission.request() } }
                    )
                    Divider()
                } else if notificationPermission.access == .denied {
                    MacNotificationAccessNotice(
                        systemImage: "bell.slash.fill",
                        tint: .orange,
                        title: "Notifications are off",
                        detail: "Waiting questions still appear in Remi and the menu bar, but macOS cannot show banners or play sounds.",
                        actionTitle: "Open System Settings",
                        action: openNotificationSettings
                    )
                    Divider()
                }

                Toggle("Concise question summaries", isOn: $summariesEnabled)
                    .font(.headline)
                Text("Longer questions can be summarized on device when Apple Intelligence is available. The original conversation is never changed.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var machineSettings: some View {
        HSplitView {
            VStack(spacing: 0) {
                if store.machines.isEmpty {
                    ContentUnavailableView(
                        "No saved machines",
                        systemImage: "desktopcomputer",
                        description: Text("Add a machine from the main Remi window.")
                    )
                } else {
                    List(store.machines, selection: $selectedMachineID) { machine in
                        MachinePreferencesRow(machine: machine)
                            .tag(machine.id)
                            .contextMenu { machineMenu(machine) }
                    }
                    .listStyle(.sidebar)
                }
            }
            .frame(minWidth: 210, idealWidth: 230, maxWidth: 280)

            Group {
                if let machine = selectedMachine {
                    machineDetail(machine)
                } else {
                    ContentUnavailableView("Select a machine", systemImage: "desktopcomputer")
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func machineDetail(_ machine: MachineState) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if let message = store.latestOperationError ?? store.latestError?.message {
                    PreferencesFeedback(
                        message: message,
                        systemImage: "exclamationmark.circle.fill",
                        tint: .red,
                        onDismiss: store.clearLatestError
                    )
                } else if let message = relayNotifications.notice ?? store.relayNotificationNotice {
                    PreferencesFeedback(message: message, systemImage: "info.circle.fill", tint: .blue) {
                        relayNotifications.clearNotice()
                        store.clearRelayNotificationNotice()
                    }
                }

                HStack(alignment: .center, spacing: 12) {
                    Image(systemName: machine.endpoint.relayPin == nil ? "desktopcomputer" : "network")
                        .font(.title2)
                        .foregroundStyle(statusTint(machine.status))
                        .frame(width: 36, height: 36)
                        .background(statusTint(machine.status).opacity(0.12), in: .circle)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(machine.displayName)
                            .font(.title2.weight(.semibold))
                            .lineLimit(1)
                        Text(statusLabel(machine.status))
                            .font(.callout)
                            .foregroundStyle(statusTint(machine.status))
                    }
                    Spacer()
                    Menu("Actions", systemImage: "ellipsis.circle") { machineMenu(machine) }
                        .menuStyle(.borderlessButton)
                        .fixedSize()
                }

                PreferencesCard(title: "Connection", systemImage: "point.3.connected.trianglepath.dotted") {
                    LabeledContent("Transport", value: transportLabel(machine.endpoint))
                    LabeledContent("Endpoint") {
                        Text(machine.endpoint.displayAddress)
                            .font(.system(.body, design: .monospaced))
                            .textSelection(.enabled)
                    }
                    LabeledContent("Active sessions", value: machine.activeSessions.count.formatted())
                    if machine.endpoint.relayPin != nil {
                        LabeledContent(
                            "Relay alerts",
                            value: relayNotifications.hasRelayNotificationIntent(for: machine.endpoint)
                                ? "Enabled" : "Not enabled"
                        )
                    }
                    if let fingerprint = fingerprint(machine.status) {
                        LabeledContent("Fingerprint") {
                            Text(fingerprint)
                                .font(.system(.body, design: .monospaced))
                                .textSelection(.enabled)
                        }
                    }
                }

                recoveryCard(machine)

                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) { machineActions(machine) }
                    VStack(alignment: .leading, spacing: 10) { machineActions(machine) }
                }
            }
            .padding(24)
            .frame(maxWidth: 540, alignment: .leading)
        }
    }

    @ViewBuilder private func recoveryCard(_ machine: MachineState) -> some View {
        switch machine.status {
        case .waitingForApproval(let fingerprint):
            PreferencesCard(title: "Authorization required", systemImage: "person.badge.key") {
                Text("Approve this Mac on the machine, then retry. Compare the fingerprint before granting access.")
                    .foregroundStyle(.secondary)
                Text(store.publicIdentity.authorizeCommand(label: Host.current().localizedName ?? "Mac"))
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(10)
                    .background(.background, in: .rect(cornerRadius: 8))
                HStack {
                    Button("Copy command", systemImage: "doc.on.doc") {
                        copy(store.publicIdentity.authorizeCommand(label: Host.current().localizedName ?? "Mac"), value: .command)
                    }
                    Button("Copy fingerprint", systemImage: "number") { copy(fingerprint, value: .fingerprint) }
                    Button("Retry", systemImage: "arrow.clockwise") { store.retryApproval(for: machine.endpoint) }
                }
            }
        case .waitingForRelayConfirmation:
            PreferencesCard(title: "Confirm relay pairing", systemImage: "person.badge.key") {
                Text("Compare the fingerprint in the machine’s terminal and complete approval there. Create a fresh pairing token if it expires.")
                    .foregroundStyle(.secondary)
            }
        case .unavailable(let reason):
            PreferencesCard(title: "Connection unavailable", systemImage: "exclamationmark.triangle") {
                Text(reason ?? recoveryGuidance(machine.endpoint))
                    .foregroundStyle(.secondary)
                if machine.endpoint.relayPin == nil {
                    Button("Retry connection", systemImage: "arrow.clockwise") { store.retryConnection(for: machine.endpoint) }
                }
            }
        case .disconnected:
            PreferencesCard(title: "Machine offline", systemImage: "wifi.slash") {
                Text(recoveryGuidance(machine.endpoint)).foregroundStyle(.secondary)
                if machine.endpoint.relayPin == nil {
                    Button("Retry connection", systemImage: "arrow.clockwise") { store.retryConnection(for: machine.endpoint) }
                }
            }
        case .connecting, .connected:
            EmptyView()
        }
    }

    @ViewBuilder private func machineActions(_ machine: MachineState) -> some View {
        Button("Rename", systemImage: "pencil") { beginRename(machine) }
        Button(copiedValue == .endpoint ? "Endpoint copied" : "Copy endpoint", systemImage: copiedValue == .endpoint ? "checkmark" : "doc.on.doc") {
            copy(machine.endpoint.displayAddress, value: .endpoint)
        }
        Button("Copy diagnostics", systemImage: "stethoscope") {
            copy(diagnostics(for: machine), value: .diagnostics)
        }
        if machine.endpoint.relayPin != nil,
           !relayNotifications.hasRelayNotificationIntent(for: machine.endpoint) {
            Button("Enable relay alerts", systemImage: "bell.badge") { relayNotifications.enable(on: machine.endpoint) }
                .disabled(relayNotifications.enabling || !store.persistableEndpoints.contains(machine.endpoint))
        }
    }

    @ViewBuilder private func machineMenu(_ machine: MachineState) -> some View {
        Button("Rename", systemImage: "pencil") { beginRename(machine) }
        Button("Copy endpoint", systemImage: "doc.on.doc") { copy(machine.endpoint.displayAddress, value: .endpoint) }
        Button("Copy diagnostics", systemImage: "stethoscope") { copy(diagnostics(for: machine), value: .diagnostics) }
        if machine.endpoint.relayPin != nil,
           !relayNotifications.hasRelayNotificationIntent(for: machine.endpoint) {
            Button("Enable relay alerts", systemImage: "bell.badge") { relayNotifications.enable(on: machine.endpoint) }
                .disabled(relayNotifications.enabling || !store.persistableEndpoints.contains(machine.endpoint))
        }
        Divider()
        Button("Forget machine", systemImage: "trash", role: .destructive) { machineToForget = machine }
    }

    private var identitySettings: some View {
        PreferencesPage(
            title: "Device identity",
            subtitle: "Use this Mac’s identity to authorize it on each machine running Remi."
        ) {
            PreferencesCard(title: "System access", systemImage: "checkmark.shield") {
                Text("An authorized client can view exposed sessions and conversations, send chat, answer approval prompts, create sessions, and stop sessions. The machine’s daemon decides which sessions and capabilities are available.")
                    .foregroundStyle(.secondary)
                Divider()
                Label("The private key remains in this Mac’s Keychain. Copy and Share include only the public key.", systemImage: "lock.fill")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }

            PreferencesCard(title: "Public identity", systemImage: "key") {
                LabeledContent("Fingerprint") {
                    Text(store.publicIdentity.fingerprint)
                        .font(.system(.callout, design: .monospaced))
                        .textSelection(.enabled)
                }
                Text("For a pending direct connection, run this on the machine:")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Text(store.publicIdentity.authorizeCommand(label: Host.current().localizedName ?? "Mac"))
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.background, in: .rect(cornerRadius: 8))
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) { identityActions }
                    VStack(alignment: .leading, spacing: 10) { identityActions }
                }
            }
        }
    }

    private var identityActions: some View {
        Group {
            Button(copiedValue == .command ? "Command copied" : "Copy command", systemImage: copiedValue == .command ? "checkmark" : "doc.on.doc") {
                copy(store.publicIdentity.authorizeCommand(label: Host.current().localizedName ?? "Mac"), value: .command)
            }
            Button(copiedValue == .identity ? "Identity copied" : "Copy public identity", systemImage: copiedValue == .identity ? "checkmark" : "key") {
                copy(store.publicIdentity.exportJSON, value: .identity)
            }
            ShareLink(item: store.publicIdentity.exportJSON, subject: Text("Remi public identity"), message: Text("Install this public identity on a Remi machine to pre-authorize this Mac.")) {
                Label("Share identity", systemImage: "square.and.arrow.up")
            }
        }
    }

    private var selectedMachine: MachineState? {
        store.machines.first { $0.id == selectedMachineID }
    }

    private var renamePresentation: Binding<Bool> {
        Binding(get: { machineToRename != nil }, set: { if !$0 { machineToRename = nil } })
    }

    private var forgetPresentation: Binding<Bool> {
        Binding(get: { machineToForget != nil }, set: { if !$0 { machineToForget = nil } })
    }

    private var trimmedProposedName: String {
        proposedName.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func selectAvailableMachine() {
        if !store.machines.contains(where: { $0.id == selectedMachineID }) {
            selectedMachineID = store.machines.first?.id
        }
    }

    private func beginRename(_ machine: MachineState) {
        proposedName = machine.displayName
        machineToRename = machine
    }

    private func renameMachine() {
        guard let machine = machineToRename else { return }
        store.renameMachine(machine.endpoint, to: proposedName)
        persistDisplayNames()
        machineToRename = nil
    }

    private func forgetMachine() {
        guard let machine = machineToForget else { return }
        relayNotifications.machineWillChange(machine.endpoint)
        if store.removeMachine(machine.endpoint) {
            relayNotifications.didForget(machine.endpoint)
            MachineConfigurationStore.shared.save(store.persistableEndpoints)
            persistDisplayNames()
        }
        relayNotifications.reconcileEndpoints()
        machineToForget = nil
        selectAvailableMachine()
    }

    private func persistDisplayNames() {
        let names = store.machines.reduce(into: [String: String]()) { result, machine in
            result[machine.id] = machine.displayName
        }
        MachineConfigurationStore.shared.saveDisplayNames(names)
    }

    private func openNotificationSettings() {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") else { return }
        if !NSWorkspace.shared.open(url), let settingsURL = URL(string: "x-apple.systempreferences:") {
            NSWorkspace.shared.open(settingsURL)
        }
    }

    private func statusLabel(_ status: MachineConnectionStatus) -> String {
        switch status {
        case .connected: "Connected"
        case .connecting: "Connecting"
        case .waitingForApproval: "Authorization required"
        case .waitingForRelayConfirmation: "Pairing confirmation required"
        case .disconnected: "Offline"
        case .unavailable: "Unavailable"
        }
    }

    private func statusTint(_ status: MachineConnectionStatus) -> Color {
        switch status {
        case .connected: .green
        case .connecting: .blue
        case .waitingForApproval, .waitingForRelayConfirmation: .orange
        case .disconnected, .unavailable: .secondary
        }
    }

    private func transportLabel(_ endpoint: MachineEndpoint) -> String {
        if endpoint.relayPin != nil { return "Encrypted relay" }
        if ["127.0.0.1", "::1", "localhost"].contains(endpoint.host.lowercased()) { return "Local tunnel" }
        return "Direct WebSocket"
    }

    private func fingerprint(_ status: MachineConnectionStatus) -> String? {
        switch status {
        case .waitingForApproval(let value), .waitingForRelayConfirmation(let value): value
        default: nil
        }
    }

    private func recoveryGuidance(_ endpoint: MachineEndpoint) -> String {
        endpoint.relayPin == nil
            ? "Check that Remi is running on the machine and that this endpoint is reachable. Direct connections are not encrypted by Remi; use a trusted network, VPN, or SSH tunnel."
            : "Remi will reconnect through the encrypted relay when the machine is available. Pair again if its relay authorization changed."
    }

    private func diagnostics(for machine: MachineState) -> String {
        [
            "Machine: \(machine.displayName)",
            "Endpoint: \(machine.endpoint.displayAddress)",
            "Transport: \(transportLabel(machine.endpoint))",
            "Status: \(statusLabel(machine.status))",
            "Active sessions: \(machine.activeSessions.count)",
            "Client fingerprint: \(store.publicIdentity.fingerprint)"
        ].joined(separator: "\n")
    }

    private func copy(_ string: String, value: CopiedValue) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(string, forType: .string)
        copiedValue = value
    }
}

private struct PreferencesPage<Content: View>: View {
    let title: LocalizedStringKey
    let subtitle: LocalizedStringKey
    let content: Content

    init(
        title: LocalizedStringKey,
        subtitle: LocalizedStringKey,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        self.subtitle = subtitle
        self.content = content()
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(.title2.weight(.semibold))
                    Text(subtitle).foregroundStyle(.secondary)
                }
                content
            }
            .padding(28)
            .frame(maxWidth: 650, alignment: .leading)
        }
    }
}

private struct PreferencesCard<Content: View>: View {
    let title: LocalizedStringKey
    let systemImage: String
    let content: Content

    init(
        title: LocalizedStringKey,
        systemImage: String,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        self.systemImage = systemImage
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(title, systemImage: systemImage).font(.headline)
            content
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.42), in: .rect(cornerRadius: 12))
    }
}

private struct MachinePreferencesRow: View {
    let machine: MachineState

    var body: some View {
        HStack(spacing: 9) {
            Circle()
                .fill(statusTint)
                .frame(width: 7, height: 7)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(machine.displayName).lineLimit(1)
                Text(machine.endpoint.displayAddress)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(machine.displayName), \(statusText), \(machine.endpoint.displayAddress)")
    }

    private var statusTint: Color {
        switch machine.status {
        case .connected: .green
        case .connecting: .blue
        case .waitingForApproval, .waitingForRelayConfirmation: .orange
        case .disconnected, .unavailable: .secondary
        }
    }

    private var statusText: String {
        switch machine.status {
        case .connected: "connected"
        case .connecting: "connecting"
        case .waitingForApproval, .waitingForRelayConfirmation: "approval required"
        case .disconnected: "offline"
        case .unavailable: "unavailable"
        }
    }
}

private struct PreferencesFeedback: View {
    let message: String
    let systemImage: String
    let tint: Color
    let onDismiss: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: systemImage)
                .foregroundStyle(tint)
                .accessibilityHidden(true)
            Text(message)
                .font(.callout)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("Dismiss", systemImage: "xmark", action: onDismiss)
                .labelStyle(.iconOnly)
                .buttonStyle(.plain)
        }
        .padding(12)
        .background(tint.opacity(0.1), in: .rect(cornerRadius: 10))
    }
}

private struct MacNotificationAccessNotice: View {
    let systemImage: String
    let tint: Color
    let title: LocalizedStringKey
    let detail: LocalizedStringKey
    let actionTitle: LocalizedStringKey
    let action: () -> Void

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .top, spacing: 12) {
                message
                Spacer(minLength: 12)
                Button(actionTitle, action: action)
            }
            VStack(alignment: .leading, spacing: 12) {
                message
                Button(actionTitle, action: action)
            }
        }
    }

    private var message: some View {
        Label {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.headline)
                Text(detail).font(.callout).foregroundStyle(.secondary)
            }
        } icon: {
            Image(systemName: systemImage)
                .font(.title3)
                .foregroundStyle(tint)
                .accessibilityHidden(true)
        }
    }
}

private enum CopiedValue {
    case command
    case identity
    case endpoint
    case fingerprint
    case diagnostics
}
