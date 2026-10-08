import RemiKit
import SwiftUI
import UIKit
import VisionKit

struct PairingScannerSheet: View {
    @Environment(\.dismiss) private var dismiss
    let phoneFingerprint: String?
    let onConnect: (MachineEndpoint) -> Void

    @State private var payload: PairingPayload?
    @State private var error: PairingPayloadError?
    @State private var pastedCode = ""
    @State private var requestedApproval = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if let payload {
                    if requestedApproval {
                        PairingApprovalWait(
                            payload: payload,
                            phoneFingerprint: phoneFingerprint
                        )
                    } else {
                        PairingConfirmation(payload: payload, phoneFingerprint: phoneFingerprint) {
                        let label = UIDevice.current.name
                        onConnect(MachineEndpoint(
                            host: payload.endpoint.host,
                            port: payload.endpoint.port,
                            expectedFingerprint: payload.endpoint.expectedFingerprint,
                            expectedPublicKey: payload.endpoint.expectedPublicKey,
                            pairingNonce: payload.endpoint.pairingNonce,
                            pairingLabel: PairingPayload.isValidLabel(label) ? label : nil
                        ))
                            requestedApproval = true
                        }
                    }
                } else if DataScannerViewController.isSupported && DataScannerViewController.isAvailable {
                    PairingCodeScanner(onCode: validate)
                        .overlay(alignment: .bottom) {
                            scannerInstructions
                        }
                } else {
                    scannerUnavailable
                }
            }
            .navigationTitle("Scan pairing code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(requestedApproval ? "Done" : "Cancel") { dismiss() }
                }
            }
            .alert("Pairing code not accepted", isPresented: errorBinding) {
                Button("Try again") { error = nil }
            } message: {
                Text(errorMessage)
            }
        }
    }

    private var scannerInstructions: some View {
        Text("Point the camera at the code shown by `remi pair`. Scanning does not approve this phone; confirm it in the terminal.")
            .font(.footnote)
            .multilineTextAlignment(.center)
            .padding()
            .background(.regularMaterial, in: .rect(cornerRadius: 14))
            .padding()
    }

    private var scannerUnavailable: some View {
        VStack(spacing: 24) {
            Image(systemName: "qrcode.viewfinder")
                .font(.largeTitle)
                .foregroundStyle(.secondary)

            VStack(spacing: 8) {
                Text("Camera scanner unavailable")
                    .font(.title2.weight(.semibold))
                Text("Paste the full pairing code from the terminal, or use manual host and port entry.")
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            VStack(spacing: 12) {
                TextField("remi://pair…", text: $pastedCode)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 16)
                    .frame(minHeight: 50)
                    .background(.quaternary, in: .rect(cornerRadius: 12))

                Button {
                    validate(pastedCode)
                } label: {
                    Text("Validate code")
                        .frame(maxWidth: .infinity, minHeight: 50)
                }
                    .buttonStyle(.glassProminent)
                    .disabled(pastedCode.isEmpty)
            }
        }
        .padding(24)
        .frame(maxWidth: 360)
        .background(.thinMaterial, in: .rect(cornerRadius: 24))
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var errorBinding: Binding<Bool> {
        Binding(get: { error != nil }, set: { if !$0 { error = nil } })
    }

    private var errorMessage: LocalizedStringKey {
        switch error {
        case .unsupportedVersion: "This pairing code uses an unsupported version."
        case .protocolMismatch: "This machine uses an incompatible Remi protocol version."
        case .notCanonical: "This pairing code was altered or is not in canonical form."
        case .malformed: "This pairing code contains invalid data. Run `remi pair` again."
        case .expired: "This pairing code has expired. Run `remi pair` again."
        case .notAPairingLink, .none: "This is not a valid Remi pairing code."
        }
    }

    private func validate(_ value: String) {
        do {
            payload = try PairingPayload(scannedValue: value)
            error = nil
        } catch let parsingError as PairingPayloadError {
            error = parsingError
        } catch {
            self.error = .malformed
        }
    }
}

private struct PairingApprovalWait: View {
    let payload: PairingPayload
    let phoneFingerprint: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                HStack(spacing: 16) {
                    ProgressView()
                        .controlSize(.large)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Waiting for terminal approval")
                            .font(.title2.weight(.semibold))
                        Text(payload.machineName)
                            .foregroundStyle(.secondary)
                    }
                }

                VStack(alignment: .leading, spacing: 16) {
                    fingerprintRow("Machine", payload.daemonFingerprint)
                    Divider()
                    fingerprintRow("This phone", phoneFingerprint ?? "Unavailable")
                }
                .padding(20)
                .background(.thinMaterial, in: .rect(cornerRadius: 20))

                Label(
                    "At the machine, compare both fingerprints and enter the first four characters of this phone’s fingerprint.",
                    systemImage: "checkmark.shield"
                )
                .foregroundStyle(.secondary)

                Text("Remi retries with a fresh challenge while the terminal is waiting. You can close this screen; the connection continues in the background.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: 560, alignment: .leading)
            .padding(24)
        }
    }

    private func fingerprintRow(_ title: LocalizedStringKey, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(.body, design: .monospaced, weight: .semibold))
                .textSelection(.enabled)
        }
    }
}

private struct PairingConfirmation: View {
    let payload: PairingPayload
    let phoneFingerprint: String?
    let onConnect: () -> Void

    var body: some View {
        List {
            Section("Machine") {
                LabeledContent("Name", value: payload.machineName)
                LabeledContent("Address", value: payload.endpoint.id)
                LabeledContent("Daemon fingerprint", value: payload.daemonFingerprint)
                    .textSelection(.enabled)
                LabeledContent("Expires", value: payload.expiresAt.formatted(date: .omitted, time: .standard))
            }
            Section("Compare at the terminal") {
                LabeledContent("Machine", value: payload.daemonFingerprint)
                    .textSelection(.enabled)
                LabeledContent("This phone", value: phoneFingerprint ?? "Unavailable")
                    .textSelection(.enabled)
                Text("The terminal will ask for the first four characters of this phone’s fingerprint. Approve only when both displays match.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Section {
                Label(
                    "The fingerprint will be pinned before this app signs the authentication challenge.",
                    systemImage: "checkmark.shield"
                )
                Label(
                    "The QR code does not authorize this phone. Approve its fingerprint in the terminal.",
                    systemImage: "person.badge.key"
                )
                Label(
                    "Direct WebSocket traffic is not encrypted by Remi.",
                    systemImage: "lock.open"
                )
            }
            Section {
                Button("Connect and request approval", action: onConnect)
                    .buttonStyle(.glassProminent)
            }
        }
    }
}

private struct PairingCodeScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onCode: onCode)
    }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isPinchToZoomEnabled: true,
            isGuidanceEnabled: true,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        try? scanner.startScanning()
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        if !scanner.isScanning { try? scanner.startScanning() }
    }

    static func dismantleUIViewController(
        _ scanner: DataScannerViewController,
        coordinator: Coordinator
    ) {
        scanner.stopScanning()
    }

    @MainActor
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        private let onCode: (String) -> Void
        private var delivered = false

        init(onCode: @escaping (String) -> Void) {
            self.onCode = onCode
        }

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            didAdd addedItems: [RecognizedItem],
            allItems: [RecognizedItem]
        ) {
            guard !delivered else { return }
            for item in addedItems {
                guard case .barcode(let barcode) = item,
                      let value = barcode.payloadStringValue
                else { continue }
                delivered = true
                dataScanner.stopScanning()
                onCode(value)
                return
            }
        }
    }
}
