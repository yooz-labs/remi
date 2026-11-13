import Foundation

/// The complete QR survives every UI boundary; it is never reduced to its first host.
public enum AddMachineRequest: Sendable, Equatable {
    case endpoint(MachineEndpoint)
    case pairing(PairingPayload, label: String)

    public static func pairing(_ payload: PairingPayload, proposedLabel: String, fallback: String) -> Self {
        .pairing(payload, label: PairingPayload.isValidLabel(proposedLabel) ? proposedLabel : fallback)
    }
}
