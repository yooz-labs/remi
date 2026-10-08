import Foundation

public enum PairingPayloadError: String, Error, Sendable, Equatable, Codable {
    case notAPairingLink = "NOT_A_PAIRING_LINK"
    case malformed = "MALFORMED"
    case unsupportedVersion = "UNSUPPORTED_VERSION"
    case notCanonical = "NOT_CANONICAL"
    case expired = "EXPIRED"
    case protocolMismatch = "PROTOCOL_MISMATCH"
}

/// The strict, canonical version 1 pairing link from ADR 0037.
public struct PairingPayload: Sendable, Equatable {
    public static let currentVersion = 1
    public static let protocolVersion = 1
    private static let prefix = "remi://pair#"
    private static let maximumLinkLength = 1_024
    private static let maximumFutureLifetime: Int64 = 1_020
    private static let clockSkew: Int64 = 120

    public let endpoint: MachineEndpoint
    public let machineName: String
    public let daemonFingerprint: String
    public let daemonPublicKey: String
    public let expiresAt: Date
    public let nonce: String

    public static func isValidLabel(_ value: String) -> Bool {
        isPlainText(value)
    }

    public init(scannedValue: String, now: Date = Date()) throws {
        guard scannedValue.hasPrefix(Self.prefix) else {
            throw PairingPayloadError.notAPairingLink
        }
        guard scannedValue.utf8.count <= Self.maximumLinkLength else {
            throw PairingPayloadError.malformed
        }
        let encoded = String(scannedValue.dropFirst(Self.prefix.count))
        guard let jsonData = Self.decodeBase64URL(encoded) else {
            throw PairingPayloadError.malformed
        }
        guard Self.encodeBase64URL(jsonData) == encoded else {
            throw PairingPayloadError.notCanonical
        }
        guard String(data: jsonData, encoding: .utf8) != nil,
              jsonData.range(of: Data([0xef, 0xbb, 0xbf])) == nil,
              let object = try? JSONSerialization.jsonObject(with: jsonData),
              let dictionary = object as? [String: Any]
        else { throw PairingPayloadError.malformed }

        guard dictionary.keys.contains("v") else { throw PairingPayloadError.malformed }
        guard let version = dictionary["v"] as? NSNumber,
              CFGetTypeID(version) != CFBooleanGetTypeID(),
              version.intValue == Self.currentVersion
        else { throw PairingPayloadError.unsupportedVersion }

        let fields: Set<String> = ["v", "name", "host", "port", "key", "nonce", "exp", "proto"]
        guard Set(dictionary.keys) == fields,
              let name = dictionary["name"] as? String, Self.isPlainText(name),
              let host = dictionary["host"] as? String, Self.isHost(host),
              let portNumber = dictionary["port"] as? NSNumber,
              Self.isInteger(portNumber), (1...65_535).contains(portNumber.intValue),
              let key = dictionary["key"] as? String,
              let keyData = Data(base64Encoded: key), keyData.count == 32,
              keyData.base64EncodedString() == key,
              let nonce = dictionary["nonce"] as? String,
              let nonceData = Self.decodeBase64URL(nonce), nonceData.count == 16,
              Self.encodeBase64URL(nonceData) == nonce,
              let expiryNumber = dictionary["exp"] as? NSNumber,
              Self.isInteger(expiryNumber), expiryNumber.int64Value >= 0,
              let protocolNumber = dictionary["proto"] as? NSNumber,
              Self.isInteger(protocolNumber), protocolNumber.intValue >= 1
        else { throw PairingPayloadError.malformed }

        let canonical = #"{"v":\#(version.intValue),"name":"\#(name)","host":"\#(host)","port":\#(portNumber.intValue),"key":"\#(key)","nonce":"\#(nonce)","exp":\#(expiryNumber.int64Value),"proto":\#(protocolNumber.intValue)}"#
        guard jsonData == Data(canonical.utf8) else { throw PairingPayloadError.notCanonical }

        let nowSeconds = Int64(now.timeIntervalSince1970.rounded(.down))
        let expiry = expiryNumber.int64Value
        guard expiry + Self.clockSkew > nowSeconds else { throw PairingPayloadError.expired }
        guard expiry <= nowSeconds + Self.maximumFutureLifetime else {
            throw PairingPayloadError.malformed
        }
        guard protocolNumber.intValue == Self.protocolVersion else {
            throw PairingPayloadError.protocolMismatch
        }

        daemonFingerprint = ClientIdentity.fingerprint(ofPublicKeyRaw: keyData)
        daemonPublicKey = key
        machineName = name
        expiresAt = Date(timeIntervalSince1970: TimeInterval(expiry))
        self.nonce = nonce
        endpoint = MachineEndpoint(
            host: host,
            port: portNumber.intValue,
            expectedFingerprint: daemonFingerprint,
            expectedPublicKey: key,
            pairingNonce: nonce
        )
        guard endpoint.webSocketURL != nil else { throw PairingPayloadError.malformed }
    }

    private static func isInteger(_ number: NSNumber) -> Bool {
        CFGetTypeID(number) != CFBooleanGetTypeID()
            && number.doubleValue.isFinite
            && number.doubleValue.rounded() == number.doubleValue
    }

    private static func decodeBase64URL(_ value: String) -> Data? {
        guard value.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }),
              value.count % 4 != 1
        else { return nil }
        let standard = value.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
            + String(repeating: "=", count: (4 - value.count % 4) % 4)
        return Data(base64Encoded: standard)
    }

    private static func encodeBase64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func isPlainText(_ text: String) -> Bool {
        guard (1...64).contains(text.unicodeScalars.count),
              !text.contains("\""), !text.contains("\\")
        else { return false }
        return text.unicodeScalars.allSatisfy { scalar in
            let value = scalar.value
            return !((value <= 0x1f)
                || (0x7f...0x9f).contains(value)
                || value == 0xad || value == 0x061c || value == 0x180e
                || (0x200b...0x200f).contains(value)
                || (0x2028...0x202e).contains(value)
                || (0x2060...0x206f).contains(value)
                || value == 0xfeff
                || (0xe0000...0xe007f).contains(value))
        }
    }

    private static func isHost(_ host: String) -> Bool {
        guard !host.isEmpty, host.utf8.count <= 253 else { return false }
        if host.contains(":") { return isIPv6(host) }
        let parts = host.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        if parts.count == 4, parts.allSatisfy({ part in
            guard let value = Int(part), String(value) == part || part == "0" else { return false }
            return (0...255).contains(value)
        }) { return true }
        let labels = host.hasSuffix(".") ? Array(parts.dropLast()) : parts
        guard let last = labels.last, !last.allSatisfy(\.isNumber) else { return false }
        return labels.allSatisfy { label in
            guard (1...63).contains(label.count),
                  label.first.map({ $0.isLetter || $0.isNumber }) == true,
                  label.last.map({ $0.isLetter || $0.isNumber }) == true
            else { return false }
            return label.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }
        }
    }

    private static func isIPv6(_ host: String) -> Bool {
        guard !host.contains("%"), !host.contains(".") else { return false }
        let halves = host.components(separatedBy: "::")
        guard halves.count <= 2 else { return false }
        func groups(_ value: String) -> [Substring]? {
            if value.isEmpty { return [] }
            let result = value.split(separator: ":", omittingEmptySubsequences: false)
            return result.allSatisfy {
                (1...4).contains($0.count) && $0.allSatisfy(\.isHexDigit)
            } ? result : nil
        }
        guard let head = groups(halves[0]) else { return false }
        if halves.count == 1 { return head.count == 8 }
        guard let tail = groups(halves[1]) else { return false }
        return head.count + tail.count <= 7
    }
}
