import RemiKit
import SwiftUI
import VisionKit

struct PairingScannerSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onConnect: (MachineEndpoint) -> Void

    @State private var payload: PairingPayload?
    @State private var error: PairingPayloadError?
    @State private var pastedCode = ""

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if let payload {
                    PairingConfirmation(payload: payload) {
                        onConnect(payload.endpoint)
                        dismiss()
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
                    Button("Cancel") { dismiss() }
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
        case .invalidEndpoint: "The machine address or port is invalid."
        case .invalidFingerprint: "The daemon fingerprint is invalid."
        case .invalidNonce: "The one-time pairing value is invalid."
        case .invalidLifetime: "The pairing code lifetime is invalid."
        case .expired: "This pairing code has expired. Run `remi pair` again."
        case .invalidURL, .none: "This is not a valid Remi pairing code."
        }
    }

    private func validate(_ value: String) {
        do {
            payload = try PairingPayload(scannedValue: value)
            error = nil
        } catch let parsingError as PairingPayloadError {
            error = parsingError
        } catch {
            self.error = .invalidURL
        }
    }
}

private struct PairingConfirmation: View {
    let payload: PairingPayload
    let onConnect: () -> Void

    var body: some View {
        List {
            Section("Machine") {
                LabeledContent("Address", value: payload.endpoint.id)
                LabeledContent("Daemon fingerprint", value: payload.daemonFingerprint)
                    .textSelection(.enabled)
                LabeledContent("Expires", value: payload.expiresAt.formatted(date: .omitted, time: .standard))
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
