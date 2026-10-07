import Foundation

public enum PairingPayloadError: Error, Sendable, Equatable {
    case invalidURL
    case unsupportedVersion
    case invalidEndpoint
    case invalidFingerprint
    case invalidNonce
    case invalidLifetime
    case expired
}

/// Version 1 terminal-generated direct-pairing code tracked by #1275.
/// The nonce is a short-lived rendezvous token, never an authorization grant.
public struct PairingPayload: Sendable, Equatable {
    public static let currentVersion = 1
    public static let maximumLifetime: TimeInterval = 5 * 60

    public let endpoint: MachineEndpoint
    public let daemonFingerprint: String
    public let issuedAt: Date
    public let expiresAt: Date
    public let nonce: String

    public init(scannedValue: String, now: Date = Date()) throws {
        guard let components = URLComponents(string: scannedValue),
              components.scheme == "remi",
              components.host == "pair"
        else { throw PairingPayloadError.invalidURL }

        var values: [String: String] = [:]
        for item in components.queryItems ?? [] {
            guard let value = item.value, values[item.name] == nil else {
                throw PairingPayloadError.invalidURL
            }
            values[item.name] = value
        }
        guard values["v"] == String(Self.currentVersion) else {
            throw PairingPayloadError.unsupportedVersion
        }
        guard let host = values["host"], !host.isEmpty,
              host.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
              let portValue = values["port"], let port = Int(portValue),
              (1...65535).contains(port)
        else { throw PairingPayloadError.invalidEndpoint }

        guard let fingerprint = values["fingerprint"],
              fingerprint.range(of: "^[0-9a-f]{16}$", options: .regularExpression) != nil
        else { throw PairingPayloadError.invalidFingerprint }

        guard let nonce = values["nonce"],
              nonce.range(of: "^[A-Za-z0-9_-]{22,86}$", options: .regularExpression) != nil
        else { throw PairingPayloadError.invalidNonce }

        guard let issuedValue = values["iat"], let issuedSeconds = TimeInterval(issuedValue),
              let expiryValue = values["exp"], let expirySeconds = TimeInterval(expiryValue)
        else { throw PairingPayloadError.invalidLifetime }
        let issuedAt = Date(timeIntervalSince1970: issuedSeconds)
        let expiresAt = Date(timeIntervalSince1970: expirySeconds)
        guard expiresAt > issuedAt,
              expiresAt.timeIntervalSince(issuedAt) <= Self.maximumLifetime,
              issuedAt.timeIntervalSince(now) <= 30
        else { throw PairingPayloadError.invalidLifetime }
        guard expiresAt > now else { throw PairingPayloadError.expired }

        let endpoint = MachineEndpoint(
            host: host,
            port: port,
            expectedFingerprint: fingerprint,
            pairingNonce: nonce
        )
        guard endpoint.webSocketURL != nil else { throw PairingPayloadError.invalidEndpoint }
        self.endpoint = endpoint
        daemonFingerprint = fingerprint
        self.issuedAt = issuedAt
        self.expiresAt = expiresAt
        self.nonce = nonce
    }
}
