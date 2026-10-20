import RemiKit
import RemiUI
import SwiftUI
import UIKit

struct PairingScreen: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private let startCommand = "remi start"
    private let pairCommand = "remi pair"
    private let keysCommand = "remi keys"
    private let authorizeCommand = "remi authorize <fingerprint> --label phone"
    let onAddMachine: (AddMachineRequest) -> UUID?
    let pairingAttempts: [PairingAttemptState]
    let onCancelPairing: (UUID) -> Void
    let publicIdentity: PublicClientIdentity?
    let machineStates: [MachineState]

    @State private var draft = AddMachineDraft()
    @State private var showingScanner = false
    @State private var added = false
    @State private var attemptID: UUID?

    @MainActor init(
        publicIdentity: PublicClientIdentity? = nil,
        machineStates: [MachineState] = [],
        draft: AddMachineDraft? = nil,
        pairingAttempts: [PairingAttemptState] = [],
        onCancelPairing: @escaping (UUID) -> Void = { _ in },
        onAddMachine: @escaping (AddMachineRequest) -> UUID? = { _ in nil }
    ) {
        self.publicIdentity = publicIdentity
        self.machineStates = machineStates
        self.onAddMachine = onAddMachine
        self.pairingAttempts = pairingAttempts
        self.onCancelPairing = onCancelPairing
        _draft = State(initialValue: draft ?? AddMachineDraft())
    }

    var body: some View {
        List {
            Section {
                PairingIntroduction()
            }

            Section {
                PairingStep(number: 1, title: "Start Remi", detail: "Start the hub after configuring daemon.bind to an address this phone can reach.", command: startCommand, copyLabel: "Copy remi start command", copiedLabel: "remi start command copied")
                PairingStep(number: 2, title: "Create a pairing code", detail: "Keep the terminal open while Remi waits for fingerprint approval.", command: pairCommand, copyLabel: "Copy remi pair command", copiedLabel: "remi pair command copied")

                Button {
                    showingScanner = true
                } label: {
                    Label("Scan pairing code", systemImage: "qrcode.viewfinder")
                        .frame(maxWidth: .infinity, minHeight: RemiTheme.Size.minimumTapTarget)
                }
                .buttonStyle(.glassProminent)
            } header: {
                Text("Recommended")
            } footer: {
                Text("The code pins the machine identity but does not approve this phone. Confirm the phone fingerprint in the terminal.")
            }

            Section {
                Picker("Connection method", selection: $draft.mode) {
                    Label("Direct", systemImage: "point.3.connected.trianglepath.dotted")
                        .tag(AddMachineDraft.ConnectionMode.direct)
                    Label("Pairing code", systemImage: "qrcode")
                        .tag(AddMachineDraft.ConnectionMode.pairingCode)
                    Label("Relay", systemImage: "network")
                        .tag(AddMachineDraft.ConnectionMode.relay)
                }
                .pickerStyle(.segmented)
                .labelsHidden()

                if draft.mode == .direct {
                    TextField("Host or IP address", text: $draft.host)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.go)
                        .onSubmit(addMachine)
                    TextField("Port", value: $draft.port, format: .number)
                        .keyboardType(.numberPad)
                } else if draft.mode == .pairingCode {
                    TextField("remi://pair#…", text: $draft.pairingCode)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onSubmit(addMachine)
                    if let payload = try? PairingPayload(scannedValue: draft.pairingCode.trimmingCharacters(in: .whitespacesAndNewlines)) {
                        LabeledContent("Machine fingerprint", value: payload.daemonFingerprint)
                            .fontDesign(.monospaced)
                        LabeledContent("This phone", value: publicIdentity?.fingerprint ?? "Unavailable")
                            .fontDesign(.monospaced)
                        Text("Compare these fingerprints in the terminal before approving this phone.")
                    }
                } else {
                    SecureField("Relay pairing token", text: $draft.relayToken)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.go)
                        .onSubmit(addMachine)
                }

                if let issue = draft.submissionIssue ?? draft.validationIssue {
                    Label(validationMessage(issue), systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                }

                if let attemptID, let attempt = pairingAttempts.first(where: { $0.id == attemptID }) {
                    Text(attempt.message)
                    if !attempt.phase.isTerminal { Button("Cancel pairing") { onCancelPairing(attemptID) } }
                    else { Button("Try again") { added = false } }
                }
                LabeledContent("Connection", value: draft.connectionSummary)

                Button(added ? "Request submitted" : draft.mode == .relay ? "Pair over the relay" : "Add machine") {
                    addMachine()
                }
                .buttonStyle(.glassProminent)
                .disabled(added || !draft.canSubmit)
                .accessibilityHint("Adds the machine using the connection summary")
            } header: {
                Text("Other connection methods")
            } footer: {
                if draft.mode == .direct {
                    Text("Use 127.0.0.1 in the simulator. A physical phone needs an address reachable through the machine’s configured LAN, VPN, or Tailscale bind. Direct traffic is not encrypted by Remi.")
                } else if draft.mode == .relay {
                    Text("Run remi pair --relay on the machine and paste its token. Compare the fingerprint in the terminal before approving.")
                } else {
                    Text("Paste the complete code from remi pair. Confirm this phone's fingerprint in the terminal.")
                }
            }

            if draft.mode == .direct {
                Section("Authorize a manual connection") {
                    PairingStep(number: 3, title: "Find the pending key", detail: "After the phone first reaches the machine, list pending keys.", command: keysCommand, copyLabel: "Copy remi keys command", copiedLabel: "remi keys command copied")
                    PairingStep(number: 4, title: "Compare and authorize", detail: "Compare the fingerprint shown on both devices, then authorize the exact fingerprint.", command: authorizeCommand, copyLabel: "Copy authorization command", copiedLabel: "Authorization command copied")
                }
            } else if draft.mode == .relay {
                Section("Terminal confirmation") {
                    ForEach(machineStates.filter { $0.endpoint.relayPin != nil }) { machine in
                        if case .waitingForRelayConfirmation(let fingerprint) = machine.status {
                            LabeledContent("Machine fingerprint", value: fingerprint)
                                .fontDesign(.monospaced)
                                .textSelection(.enabled)
                        }
                    }
                    Text("Relay pairing is not complete until the fingerprint is confirmed in the machine’s terminal.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }

            Section("Machine authorization") {
                PairingAccessNotice()
            }
        }
        .navigationTitle("Add a machine")
        .navigationBarTitleDisplayMode(dynamicTypeSize.isAccessibilitySize ? .inline : .automatic)
        .onChange(of: draft.mode) { _, _ in added = false }
        .onChange(of: draft.host) { _, _ in added = false }
        .onChange(of: draft.port) { _, _ in added = false }
        .onChange(of: draft.pairingCode) { _, _ in added = false }
        .onDisappear { if let attemptID { onCancelPairing(attemptID) } }
        .onChange(of: draft.relayToken) { _, _ in added = false }
        .sheet(isPresented: $showingScanner) {
            PairingScannerSheet(
                phoneFingerprint: publicIdentity?.fingerprint,
                pairingAttempts: pairingAttempts,
                onCancelPairing: onCancelPairing,
                onConnect: onAddMachine
            )
        }
    }

    private func addMachine() {
        guard let request = draft.makeRequest(proposedLabel: UIDevice.current.name, fallbackLabel: "iPhone") else { return }
        attemptID = onAddMachine(request)
        added = true
    }

    private func validationMessage(_ issue: AddMachineDraft.ValidationIssue) -> LocalizedStringResource {
        switch issue {
        case .pairingCodeRequiresForm: "Select Pairing code to paste a complete remi:// link."
        case .missingPairingCode: "Paste the pairing code from remi pair."
        case .invalidPairingCode(let error): "Pairing code not accepted (\(error.rawValue)). Run remi pair again."
        case .missingHost: "Enter a host or IP address."
        case .invalidPort: "Enter a port from 1 through 65535."
        case .missingRelayToken: "Paste the relay pairing token from the machine."
        case .invalidRelayToken: "The relay token is invalid or expired. Create a new token on the machine."
        }
    }
}

private struct PairingAccessNotice: View {
    var body: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: RemiTheme.Spacing.s) {
                Text("After approval, this phone can view sessions and transcripts, answer prompts, send chat, and start, resume, or stop sessions exposed by the machine.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                Label("Direct connections are not encrypted by Remi. Use a trusted network, VPN, or SSH tunnel.", systemImage: "lock.open")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .padding(.top, RemiTheme.Spacing.xs)
        } label: {
            Label("View, answer, and manage exposed sessions", systemImage: "checkmark.shield")
        }
        .padding(.vertical, RemiTheme.Spacing.xs)
    }
}

private struct PairingIntroduction: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: "desktopcomputer.and.macbook")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
                .accessibilityRepresentation { EmptyView() }
            Text("Keep the terminal nearby")
                .font(.headline)
            Text("A new phone is never trusted automatically. Remi waits for you to approve its key on the machine.")
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 8)
    }
}

private struct PairingStep: View {
    @State private var copied = false
    @ScaledMetric(relativeTo: .caption) private var numberBadgeSize: CGFloat = 28

    let number: Int
    let title: LocalizedStringKey
    let detail: LocalizedStringKey
    let command: String?
    let copyLabel: LocalizedStringKey
    let copiedLabel: LocalizedStringKey

    init(number: Int, title: LocalizedStringKey, detail: LocalizedStringKey, command: String? = nil, copyLabel: LocalizedStringKey = "Copy command", copiedLabel: LocalizedStringKey = "Command copied") {
        self.number = number
        self.title = title
        self.detail = detail
        self.command = command
        self.copyLabel = copyLabel
        self.copiedLabel = copiedLabel
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text(number, format: .number)
                .font(.caption.weight(.bold))
                .frame(width: numberBadgeSize, height: numberBadgeSize)
                .background(.secondary.opacity(0.14), in: Circle())

            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(.headline)
                Text(detail).font(.subheadline).foregroundStyle(.secondary)

                if let command {
                    HStack {
                        Text(command).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                        Spacer(minLength: 8)
                        Button {
                            UIPasteboard.general.string = command
                            copied = true
                        } label: {
                            Image(systemName: copied ? "checkmark" : "doc.on.doc")
                                .frame(width: 44, height: 44)
                                .contentShape(.rect)
                        }
                        .accessibilityLabel(copied ? copiedLabel : copyLabel)
                        .animation(.snappy, value: copied)
                    }
                    .padding(10)
                    .background(.secondary.opacity(0.1), in: .rect(cornerRadius: 10))
                }
            }
        }
        .padding(.vertical, 4)
    }
}
