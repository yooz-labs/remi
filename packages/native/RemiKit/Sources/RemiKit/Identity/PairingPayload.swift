import Foundation

public enum PairingPayloadError: String, Error, Sendable, Equatable, Codable {
    case notAPairingLink = "NOT_A_PAIRING_LINK"
    case malformed = "MALFORMED"
    case unsupportedVersion = "UNSUPPORTED_VERSION"
    case notCanonical = "NOT_CANONICAL"
    case expired = "EXPIRED"
    case protocolMismatch = "PROTOCOL_MISMATCH"
}

/// The strict, canonical version 1 or 2 pairing link from ADR 0037.
public struct PairingPayload: Sendable, Equatable {
    /// Version 1 remains the CLI default until a compatible native app is distributed.
    public static let currentVersion = 1
    public static let protocolVersion = 1
    private static let prefix = "remi://pair#"
    private static let maximumV1LinkLength = 1_024
    private static let maximumV2LinkLength = 2_048
    private static let maximumV2JSONBytes = 1_527
    private static let maximumCandidateHosts = 4
    private static let maximumFutureLifetime: Int64 = 1_020
    private static let clockSkew: Int64 = 120

    public let version: Int
    public let endpoint: MachineEndpoint
    public let machineName: String
    public let daemonFingerprint: String
    public let daemonPublicKey: String
    public let expiresAt: Date
    public let nonce: String
    private let candidateHosts: [String]

    /// Ordered endpoint hints for an initial pairing attempt.
    ///
    /// The QR's canonical host order is retained by the decoder. Scheduling groups all Local
    /// candidates before Tailscale candidates while preserving order within each group. Every
    /// endpoint carries the same full-key pin, nonce, port and caller-supplied label.
    public func candidateEndpoints(pairingLabel: String) -> [MachineEndpoint] {
        candidateHosts.map { host in
            MachineEndpoint(
                host: host,
                port: endpoint.port,
                expectedFingerprint: daemonFingerprint,
                expectedPublicKey: daemonPublicKey,
                pairingNonce: nonce,
                pairingLabel: pairingLabel
            )
        }
    }

    public static func isValidLabel(_ value: String) -> Bool {
        isPlainText(value)
    }

    public init(scannedValue: String, now: Date = Date()) throws {
        guard scannedValue.hasPrefix(Self.prefix) else {
            throw PairingPayloadError.notAPairingLink
        }
        guard scannedValue.utf8.count <= Self.maximumV2LinkLength else {
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
        guard let versionNumber = dictionary["v"] as? NSNumber,
              CFGetTypeID(versionNumber) != CFBooleanGetTypeID(),
              Self.isInteger(versionNumber)
        else { throw PairingPayloadError.unsupportedVersion }
        let payloadVersion = versionNumber.intValue
        guard payloadVersion == 1 || payloadVersion == 2 else {
            throw PairingPayloadError.unsupportedVersion
        }
        if payloadVersion == 1 {
            guard scannedValue.utf8.count <= Self.maximumV1LinkLength else {
                throw PairingPayloadError.malformed
            }
        } else {
            guard jsonData.count <= Self.maximumV2JSONBytes else {
                throw PairingPayloadError.malformed
            }
        }

        let fields: Set<String> = payloadVersion == 1
            ? ["v", "name", "host", "port", "key", "nonce", "exp", "proto"]
            : ["v", "name", "hosts", "port", "key", "nonce", "exp", "proto"]
        guard Set(dictionary.keys) == fields,
              let name = dictionary["name"] as? String, Self.isPlainText(name),
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

        let hosts: [String]
        if payloadVersion == 1 {
            guard let host = dictionary["host"] as? String, Self.isHost(host) else {
                throw PairingPayloadError.malformed
            }
            hosts = [host]
        } else {
            guard let proposedHosts = dictionary["hosts"] as? [String],
                  (1...Self.maximumCandidateHosts).contains(proposedHosts.count),
                  proposedHosts.allSatisfy(Self.isCandidateHost),
                  Set(proposedHosts.compactMap(Self.normalizedHostKey)).count == proposedHosts.count
            else { throw PairingPayloadError.malformed }
            hosts = proposedHosts
        }

        let canonical: String
        if payloadVersion == 1 {
            let host = hosts[0]
            canonical = #"{"v":\#(payloadVersion),"name":"\#(name)","host":"\#(host)","port":\#(portNumber.intValue),"key":"\#(key)","nonce":"\#(nonce)","exp":\#(expiryNumber.int64Value),"proto":\#(protocolNumber.intValue)}"#
        } else {
            let hostsJSON = hosts.map { "\"\($0)\"" }.joined(separator: ",")
            canonical = #"{"v":\#(payloadVersion),"name":"\#(name)","hosts":[\#(hostsJSON)],"port":\#(portNumber.intValue),"key":"\#(key)","nonce":"\#(nonce)","exp":\#(expiryNumber.int64Value),"proto":\#(protocolNumber.intValue)}"#
        }
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

        let scheduledHosts = payloadVersion == 1 ? hosts : Self.orderedCandidateHosts(hosts)
        version = payloadVersion
        candidateHosts = scheduledHosts
        daemonFingerprint = ClientIdentity.fingerprint(ofPublicKeyRaw: keyData)
        daemonPublicKey = key
        machineName = name
        expiresAt = Date(timeIntervalSince1970: TimeInterval(expiry))
        self.nonce = nonce
        endpoint = MachineEndpoint(
            host: scheduledHosts[0],
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

    private static func ipv4Octets(_ host: String) -> [Int]? {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        let octets = parts.compactMap { part -> Int? in
            let spelling = String(part)
            guard let value = Int(part), (0...255).contains(value),
                  String(value) == spelling || spelling == "0"
            else { return nil }
            return value
        }
        return octets.count == 4 ? octets : nil
    }

    private static func mappedIPv4(_ groups: [Int]) -> [Int]? {
        guard groups.count == 8,
              groups.prefix(5).allSatisfy({ $0 == 0 }),
              groups[5] == 0xffff
        else { return nil }
        return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]
    }

    private static func isUnsafeIPv4(_ octets: [Int]) -> Bool {
        guard octets.count == 4 else { return true }
        return octets[0] == 127
            || (octets[0] == 0 && octets[1] == 0 && octets[2] == 0 && octets[3] == 0)
            || (octets[0] == 169 && octets[1] == 254)
    }

    private static func isCandidateHost(_ host: String) -> Bool {
        guard isHost(host) else { return false }
        if let octets = ipv4Octets(host) { return !isUnsafeIPv4(octets) }
        if host.contains(":") {
            guard let groups = ipv6Groups(host) else { return false }
            if let mapped = mappedIPv4(groups) { return !isUnsafeIPv4(mapped) }
            let unspecified = groups.allSatisfy { $0 == 0 }
            let loopback = groups.prefix(7).allSatisfy { $0 == 0 } && groups[7] == 1
            let linkLocal = (groups[0] & 0xffc0) == 0xfe80
            return !unspecified && !loopback && !linkLocal
        }
        let normalized = host.lowercased().hasSuffix(".") ? String(host.dropLast()).lowercased() : host.lowercased()
        return normalized != "localhost" && !normalized.hasSuffix(".localhost")
    }

    private static func normalizedHostKey(_ host: String) -> String? {
        if let octets = ipv4Octets(host) {
            return "ipv4:\(octets.map { String($0) }.joined(separator: "."))"
        }
        if host.contains(":"), let groups = ipv6Groups(host) {
            if let mapped = mappedIPv4(groups) {
                return "ipv4:\(mapped.map { String($0) }.joined(separator: "."))"
            }
            return "ipv6:\(groups.map { String($0, radix: 16) }.joined(separator: ":"))"
        }
        guard isHost(host) else { return nil }
        let name = host.hasSuffix(".") ? String(host.dropLast()) : host
        return "dns:\(name.lowercased())"
    }

    /// Only two scheduling layers exist: Tailscale, then every other permitted direct candidate.
    private static func pairingLayer(_ host: String) -> Int {
        if let octets = ipv4Octets(host), octets[0] == 100, (64...127).contains(octets[1]) {
            return 1
        }
        if host.contains(":"), let groups = ipv6Groups(host) {
            if let mapped = mappedIPv4(groups) {
                return pairingLayer(mapped.map { String($0) }.joined(separator: "."))
            }
            if groups[0] == 0xfd7a && groups[1] == 0x115c && groups[2] == 0xa1e0 {
                return 1
            }
        }
        let normalized = host.lowercased().hasSuffix(".") ? String(host.dropLast()).lowercased() : host.lowercased()
        return normalized == "ts.net" || normalized.hasSuffix(".ts.net") ? 1 : 0
    }

    private static func orderedCandidateHosts(_ hosts: [String]) -> [String] {
        hosts.enumerated().sorted { left, right in
            let leftLayer = pairingLayer(left.element)
            let rightLayer = pairingLayer(right.element)
            if leftLayer != rightLayer { return leftLayer < rightLayer }
            return left.offset < right.offset
        }.map(\.element)
    }

    private static func isIPv6(_ host: String) -> Bool {
        ipv6Groups(host) != nil
    }

    private static func ipv6Groups(_ host: String) -> [Int]? {
        guard !host.contains("%"), !host.contains(".") else { return nil }
        let halves = host.components(separatedBy: "::")
        guard halves.count <= 2 else { return nil }
        func groups(_ value: String) -> [String]? {
            if value.isEmpty { return [] }
            let result = value.split(separator: ":", omittingEmptySubsequences: false)
            return result.allSatisfy {
                (1...4).contains($0.count) && $0.allSatisfy(\.isHexDigit)
            } ? result.map(String.init) : nil
        }
        guard let head = groups(halves[0]) else { return nil }
        if halves.count == 1 {
            guard head.count == 8 else { return nil }
            return head.compactMap { Int($0, radix: 16) }
        }
        guard let tail = groups(halves[1]), head.count + tail.count <= 7 else { return nil }
        return head.compactMap { Int($0, radix: 16) }
            + Array(repeating: 0, count: 8 - head.count - tail.count)
            + tail.compactMap { Int($0, radix: 16) }
    }
}
