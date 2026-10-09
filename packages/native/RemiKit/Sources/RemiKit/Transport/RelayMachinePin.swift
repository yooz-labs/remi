import CryptoKit
import Foundation

/// Public machine authority, persisted only after an authenticated READY by MachineStore.
public struct RelayMachinePin: Codable, Sendable, Hashable {
    public let relayURL: String
    public let machinePublicKey: String

    init(relayURL: String, machinePublicKey: String) throws {
        let machine = try RelayCrypto.unb64(machinePublicKey)
        guard machine.count == 32, !ClientIdentity.isSmallOrderPublicKey(machine),
              Self.validRoute(relayURL) else { throw RelayFailure.malformed }
        self.relayURL = relayURL
        self.machinePublicKey = machinePublicKey
    }

    private enum CodingKeys: String, CodingKey { case relayURL, machinePublicKey }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(relayURL: values.decode(String.self, forKey: .relayURL),
            machinePublicKey: values.decode(String.self, forKey: .machinePublicKey))
    }

    static func validRoute(_ text: String) -> Bool {
        guard text.utf8.count <= 512,
              text.range(of: #"^(wss://[a-z0-9.-]+|ws://(localhost|127\.0\.0\.1))(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$"#,
                         options: .regularExpression) != nil,
              let url = URLComponents(string: text), let host = url.host, !host.isEmpty,
              url.port == nil || (1...65535).contains(url.port ?? 0)
        else { return false }
        return true
    }

    var clientURL: URL? {
        guard let machine = try? RelayCrypto.unb64(machinePublicKey) else { return nil }
        let base = relayURL.hasSuffix("/") ? String(relayURL.dropLast()) : relayURL
        return URL(string: base + "/v2/client/" + RelayCrypto.hex(RelayCrypto.room(machine)))
    }
}

struct RelayPairingToken {
    let pin: RelayMachinePin
    let secret: Data
    let expiresAt: UInt64

    init(_ text: String, now: UInt64) throws {
        guard text.hasPrefix("remi-pair2:"), text.utf8.count <= 4096 else { throw RelayFailure.token }
        guard let bytes = try? RelayCrypto.unb64(String(text.dropFirst("remi-pair2:".count))) else { throw RelayFailure.token }
        guard bytes.count >= 75, bytes[0] == 2, bytes[1] <= 1 else { throw RelayFailure.token }
        let routeStart = bytes[1] == 1 ? 139 : 74
        guard bytes.count > routeStart, let route = String(data: bytes.dropFirst(routeStart), encoding: .utf8)
        else { throw RelayFailure.token }
        expiresAt = RelayCrypto.number(bytes.dropFirst(2).prefix(8))
        guard expiresAt <= 9_007_199_254_740_991,
              let pin = try? RelayMachinePin(relayURL: route, machinePublicKey: RelayCrypto.b64(bytes.dropFirst(10).prefix(32)))
        else { throw RelayFailure.token }
        guard expiresAt > now else { throw RelayFailure.expired }
        guard expiresAt - now <= 660 else { throw RelayFailure.token }
        if bytes[1] == 1 {
            guard (try? P256.KeyAgreement.PublicKey(x963Representation: bytes.dropFirst(74).prefix(65))) != nil else { throw RelayFailure.token }
        }
        self.pin = pin
        secret = bytes.dropFirst(42).prefix(32)
    }
}
