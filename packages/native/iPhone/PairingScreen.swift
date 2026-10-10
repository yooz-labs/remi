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
    let onAddMachine: (MachineEndpoint) -> Void
    let publicIdentity: PublicClientIdentity?
    let machineStates: [MachineState]

    @State private var host = "127.0.0.1"
    @State private var port = 18765
    @State private var added = false
    @State private var showingScanner = false
    @State private var relayToken = ""
    @State private var relayError: String?

    init(
        publicIdentity: PublicClientIdentity? = nil,
        machineStates: [MachineState] = [],
        onAddMachine: @escaping (MachineEndpoint) -> Void = { _ in }
    ) {
        self.publicIdentity = publicIdentity
        self.machineStates = machineStates
        self.onAddMachine = onAddMachine
    }

    var body: some View {
        List {
            Section {
                PairingIntroduction()
            }

            Section {
                PairingStep(number: 1, title: "Start Remi", detail: "Start the hub after configuring daemon.bind to an address this phone can reach.", command: startCommand)
                PairingStep(number: 2, title: "Create a pairing code", detail: "Keep the terminal open while Remi waits for fingerprint approval.", command: pairCommand)

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
                TextField("Host or IP address", text: $host)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                TextField("Port", value: $port, format: .number)
                    .keyboardType(.numberPad)
                Button(added ? "Machine added" : "Add machine") {
                    onAddMachine(MachineEndpoint(
                        host: host.trimmingCharacters(in: .whitespacesAndNewlines),
                        port: port
                    ))
                    added = true
                }
                .disabled(host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !(1...65535).contains(port))
            } header: {
                Text("Manual direct connection")
            } footer: {
                Text("Use 127.0.0.1 in the simulator. A physical phone needs an address reachable through the machine’s configured LAN, VPN, or Tailscale bind.")
            }

            Section("Authorize a manual connection") {
                PairingStep(number: 3, title: "Find the pending key", detail: "After the phone first reaches the machine, list pending keys.", command: keysCommand)
                PairingStep(number: 4, title: "Compare and authorize", detail: "Compare the fingerprint shown on both devices, then authorize the exact fingerprint.", command: authorizeCommand)
            }

            Section("Relay pairing") {
                SecureField("Relay pairing token", text: $relayToken)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                Text("Run remi pair --relay on the machine and paste its token. Compare the fingerprint in the terminal before approving. The machine is saved after confirmation.")
                    .font(.footnote).foregroundStyle(.secondary)
                Button("Pair over the relay") {
                    do {
                        let endpoint = try MachineEndpoint.pairingOverRelay(relayToken)
                        relayToken = ""
                        relayError = nil
                        onAddMachine(endpoint)
                    } catch {
                        relayError = "The relay token is invalid or expired. Create a new token on the machine."
                    }
                }
                .disabled(relayToken.isEmpty)
                if let relayError { Text(relayError).foregroundStyle(.red) }
                ForEach(machineStates.filter { $0.endpoint.relayPin != nil }) { machine in
                    if case .waitingForRelayConfirmation(let fingerprint) = machine.status {
                        Text("Compare \(fingerprint) in the machine's terminal.")
                            .font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
                    }
                }
            }

            Section("System access") {
                PairingAccessNotice()
            }
        }
        .navigationTitle("Add a machine")
        .navigationBarTitleDisplayMode(dynamicTypeSize.isAccessibilitySize ? .inline : .automatic)
        .sheet(isPresented: $showingScanner) {
            PairingScannerSheet(
                phoneFingerprint: publicIdentity?.fingerprint,
                machineStates: machineStates
            ) { endpoint in
                onAddMachine(endpoint)
                added = true
            }
        }
    }
}

private struct PairingAccessNotice: View {
    var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.s) {
            Label("What this phone can do", systemImage: "checkmark.shield")
                .font(.headline)

            Text("After approval, this phone can view sessions and transcripts, answer prompts, send chat, and start, resume, or stop sessions exposed by the machine.")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            Label("Direct WebSocket connections are not encrypted by Remi. Use a trusted network, VPN, or SSH tunnel.", systemImage: "lock.open")
                .font(.footnote)
                .foregroundStyle(.secondary)
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

    init(number: Int, title: LocalizedStringKey, detail: LocalizedStringKey, command: String? = nil) {
        self.number = number
        self.title = title
        self.detail = detail
        self.command = command
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
                        .accessibilityLabel(copied ? "Command copied" : "Copy command")
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
