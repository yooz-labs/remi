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
