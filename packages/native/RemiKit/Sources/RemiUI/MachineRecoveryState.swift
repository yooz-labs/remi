import RemiKit

public enum RemiMachineRecoveryState: Equatable, Sendable {
    case none
    case waitingForDirectApproval(fingerprint: String)
    case waitingForRelayConfirmation(fingerprint: String)
    case retryableOffline
    case retryableUnavailable(reason: String?)
    case relayOffline
    case relayNeedsFreshPairing(reason: String?)

    public static func resolve(
        status: MachineConnectionStatus,
        isRelay: Bool
    ) -> Self {
        switch status {
        case .connecting, .connected:
            .none
        case .waitingForApproval(let fingerprint):
            .waitingForDirectApproval(fingerprint: fingerprint)
        case .waitingForRelayConfirmation(let fingerprint):
            .waitingForRelayConfirmation(fingerprint: fingerprint)
        case .disconnected:
            isRelay ? .relayOffline : .retryableOffline
        case .unavailable(let reason):
            isRelay
                ? .relayNeedsFreshPairing(reason: reason)
                : .retryableUnavailable(reason: reason)
        }
    }

    public var allowsConnectionRetry: Bool {
        switch self {
        case .retryableOffline, .retryableUnavailable: true
        default: false
        }
    }
}

extension RemiMachineRecoveryState {
    /// The short heading a machine row shows when the machine needs the person, in the words
    /// the iPhone uses. Nil while there is nothing to say (connecting or connected).
    public var title: String? {
        switch self {
        case .none: nil
        case .waitingForDirectApproval: "Approval needed"
        case .waitingForRelayConfirmation: "Terminal confirmation needed"
        case .retryableOffline: "Machine offline"
        case .retryableUnavailable: "Machine unavailable"
        case .relayOffline: "Relay machine offline"
        case .relayNeedsFreshPairing: "Relay pairing unavailable"
        }
    }

    /// One plain sentence under the heading. `machineName` is the label that tells machines
    /// apart. Nil when `title` is nil.
    public func detail(machineName: String) -> String? {
        switch self {
        case .none:
            nil
        case .waitingForDirectApproval:
            "Authorize this device on \(machineName), then retry."
        case .waitingForRelayConfirmation:
            "Compare the fingerprint in the terminal on \(machineName) to approve."
        case .retryableOffline:
            "Remi is not connected to \(machineName)."
        case .retryableUnavailable(let reason):
            reason ?? "Remi could not connect to \(machineName)."
        case .relayOffline:
            "Remi will reconnect through the relay when \(machineName) becomes available."
        case .relayNeedsFreshPairing(let reason):
            [reason, "Create a fresh relay pairing token on \(machineName)."]
                .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
        }
    }
}
