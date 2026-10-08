import RemiKit
import SwiftUI
import UIKit

struct PairingScreen: View {
    private let serveCommand = "remi serve"
    private let keysCommand = "remi keys"
    private let authorizeCommand = "remi authorize <fingerprint> --label phone"
    let onAddMachine: (MachineEndpoint) -> Void
    let publicIdentity: PublicClientIdentity?
    let machineStates: [MachineState]

    @State private var host = "127.0.0.1"
    @State private var port = 18765
    @State private var added = false
    @State private var showingScanner = false

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

            Section("On the machine") {
                PairingStep(number: 1, title: "Start Remi", detail: "Run the hub from a terminal.", command: serveCommand)
                PairingStep(number: 2, title: "Use a direct address", detail: "The simulator can use 127.0.0.1. A phone needs daemon.bind configured for its LAN, VPN, or Tailscale address.")
            }

            Section("Connection") {
                Button {
                    showingScanner = true
                } label: {
                    Label("Scan pairing code", systemImage: "qrcode.viewfinder")
                }
                .buttonStyle(.glassProminent)

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
            }

            Section("Approve this phone") {
                PairingStep(number: 3, title: "Find the pending key", detail: "After the phone first reaches the machine, list pending keys.", command: keysCommand)
                PairingStep(number: 4, title: "Compare and authorize", detail: "Compare the fingerprint shown on both devices, then authorize the exact fingerprint.", command: authorizeCommand)
            }

            Section {
                Label("Direct WebSocket connections are not encrypted by Remi. Use a trusted network, VPN, or SSH tunnel.", systemImage: "lock.open")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Add a machine")
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
