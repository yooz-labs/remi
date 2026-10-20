import Foundation
import Observation

@MainActor
@Observable
public final class AddMachineDraft {
    public enum ConnectionMode: String, CaseIterable, Sendable {
        case direct
        case relay
        case pairingCode
    }

    public enum ValidationIssue: Sendable, Equatable {
        case pairingCodeRequiresForm
        case missingHost
        case invalidPort
        case missingRelayToken
        case invalidRelayToken
        case missingPairingCode
        case invalidPairingCode(PairingPayloadError)
    }

    public var mode: ConnectionMode = .direct {
        didSet {
            guard oldValue != mode else { return }
            submissionIssue = nil
        }
    }

    public var host: String = "127.0.0.1" {
        didSet { clearDirectIssue() }
    }

    public var port = 18765 {
        didSet { clearDirectIssue() }
    }

    public var relayToken = "" {
        didSet {
            if submissionIssue == .invalidRelayToken { submissionIssue = nil }
        }
    }

    public var pairingCode = "" {
        didSet { if mode == .pairingCode { submissionIssue = nil } }
    }

    public private(set) var submissionIssue: ValidationIssue?

    private let relayEndpoint: (String) throws -> MachineEndpoint

    public init(
        relayEndpoint: @escaping (String) throws -> MachineEndpoint = MachineEndpoint.pairingOverRelay
    ) {
        self.relayEndpoint = relayEndpoint
    }

    public var canSubmit: Bool {
        validationIssue == nil
    }

    public var validationIssue: ValidationIssue? {
        switch mode {
        case .direct:
            if normalizedHost.hasPrefix("remi://") { return .pairingCodeRequiresForm }
            if normalizedHost.isEmpty { return .missingHost }
            if !(1...65535).contains(port) { return .invalidPort }
            return nil
        case .relay:
            return normalizedRelayToken.isEmpty ? .missingRelayToken : nil
        case .pairingCode:
            return pairingCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .missingPairingCode : nil
        }
    }

    public var connectionSummary: String {
        switch mode {
        case .direct:
            guard validationIssue == nil else { return "Enter a valid host and port" }
            return "Direct to \(normalizedHost):\(port)"
        case .relay:
            return normalizedRelayToken.isEmpty
                ? "Paste a relay pairing token"
                : "Relay pairing with terminal confirmation"
        case .pairingCode:
            return "Pairing code with terminal fingerprint approval"
        }
    }

    public func makeRequest(proposedLabel: String, fallbackLabel: String, now: Date = Date()) -> AddMachineRequest? {
        if mode == .pairingCode {
            guard validationIssue == nil else { submissionIssue = validationIssue; return nil }
            do {
                let payload = try PairingPayload(scannedValue: pairingCode.trimmingCharacters(in: .whitespacesAndNewlines), now: now)
                submissionIssue = nil
                return .pairing(payload, proposedLabel: proposedLabel, fallback: fallbackLabel)
            } catch {
                submissionIssue = .invalidPairingCode(error as? PairingPayloadError ?? .malformed)
                return nil
            }
        }
        return makeEndpoint().map(AddMachineRequest.endpoint)
    }

    public func makeEndpoint() -> MachineEndpoint? {
        guard let issue = validationIssue else {
            switch mode {
            case .direct:
                submissionIssue = nil
                return MachineEndpoint(host: normalizedHost, port: port)
            case .pairingCode:
                // Code callers must retain the complete payload through makeRequest.
                return nil
            case .relay:
                do {
                    let endpoint = try relayEndpoint(normalizedRelayToken)
                    submissionIssue = nil
                    return endpoint
                } catch {
                    submissionIssue = .invalidRelayToken
                    return nil
                }
            }
        }
        submissionIssue = issue
        return nil
    }

    private var normalizedHost: String {
        host.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var normalizedRelayToken: String {
        relayToken.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func clearDirectIssue() {
        if submissionIssue == .missingHost || submissionIssue == .invalidPort || submissionIssue == .pairingCodeRequiresForm {
            submissionIssue = nil
        }
    }
}
