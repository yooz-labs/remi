import Foundation

/// The six-field machine object carried by authenticated daemons (#1234, ADR 0039).
public struct MachineDescriptor: Codable, Sendable, Equatable {
    public let id: String
    public let name: String
    public let platform: String
    public let remiVersion: String
    public let harnesses: [String]
    public let capabilities: [String]

    public init(
        id: String,
        name: String,
        platform: String,
        remiVersion: String,
        harnesses: [String],
        capabilities: [String]
    ) {
        self.id = id
        self.name = name
        self.platform = platform
        self.remiVersion = remiVersion
        self.harnesses = harnesses
        self.capabilities = capabilities
    }
}

enum MachineIdentityVerificationError: Error, Equatable {
    case authorityUnavailable
    case invalidAuthority
    case descriptorMismatch
    case sessionMismatch
}

/// Verifies the wire identity against the authority that authenticated the transport.
///
/// The ID is deliberately the relay room ID: the first 16 bytes of SHA-256 of the raw
/// Ed25519 machine key, rendered as lowercase hex. Keeping this calculation in one place
/// prevents direct and relay transports from growing separate identities.
enum MachineIdentityVerifier {
    static func machineID(forDirectServerPublicKey encodedKey: String) throws -> String {
        guard let publicKey = Data(base64Encoded: encodedKey),
              publicKey.base64EncodedString() == encodedKey else {
            throw MachineIdentityVerificationError.invalidAuthority
        }
        return try machineID(forPublicKey: publicKey)
    }

    static func machineID(forRelayPin pin: RelayMachinePin) throws -> String {
        try machineID(forPublicKey: RelayCrypto.unb64(pin.machinePublicKey))
    }

    static func machineID(forPublicKey publicKey: Data) throws -> String {
        guard publicKey.count == 32, !ClientIdentity.isSmallOrderPublicKey(publicKey) else {
            throw MachineIdentityVerificationError.invalidAuthority
        }
        return RelayCrypto.hex(RelayCrypto.room(publicKey))
    }

    static func verify(
        descriptor: MachineDescriptor?,
        sessions: [DiscoverableSession] = [],
        authorityPublicKey: Data?
    ) throws {
        guard descriptor != nil || sessions.contains(where: { $0.machineId != nil }) else { return }
        guard let authorityPublicKey else {
            throw MachineIdentityVerificationError.authorityUnavailable
        }
        let expectedID = try machineID(forPublicKey: authorityPublicKey)

        if let descriptor {
            guard isValidDescriptor(descriptor), descriptor.id == expectedID else {
                throw MachineIdentityVerificationError.descriptorMismatch
            }
        }
        for session in sessions {
            if let machineID = session.machineId, machineID != expectedID {
                throw MachineIdentityVerificationError.sessionMismatch
            }
        }
    }

    private static func isValidDescriptor(_ descriptor: MachineDescriptor) -> Bool {
        guard descriptor.id.count == 32,
              descriptor.id.unicodeScalars.allSatisfy({
                  (48...57).contains($0.value) || (97...102).contains($0.value)
              }),
              !descriptor.name.isEmpty,
              descriptor.name.unicodeScalars.count <= 64,
              descriptor.name.unicodeScalars.allSatisfy({ scalar in
                  CharacterSet.alphanumerics.contains(scalar)
                      || Set(" ._'-").contains(Character(scalar))
              })
        else { return false }
        return true
    }
}
