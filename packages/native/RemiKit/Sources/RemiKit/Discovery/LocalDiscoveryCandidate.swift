import Darwin
import Foundation

/// An immutable snapshot of saved authority and policy. Bonjour supplies none of
/// these values. The Store must recheck the revisions before adopting a probe.
struct LocalDiscoveryTarget: Sendable, Equatable {
    let profileID: String
    let lifetime: UUID
    let policyRevision: UInt64
    let machineID: String
    let publicKey: Data
    let fingerprint: String
    let preference: MachineConnectionPreference

    init?(profile: MachineRouteProfile, lifetime: UUID, policyRevision: UInt64) {
        guard profile.connectionPreference == .automatic || profile.connectionPreference == .localOnly,
              let identity = try? profile.verifiedSavedIdentity() else { return nil }
        profileID = profile.id
        self.lifetime = lifetime
        self.policyRevision = policyRevision
        machineID = identity.machineID
        publicKey = identity.key
        fingerprint = ClientIdentity.fingerprint(ofPublicKeyRaw: identity.key)
        preference = profile.connectionPreference
    }
}

/// Memory-only, untrusted routing information. Deliberately not Codable.
struct LocalDiscoveryCandidate: Sendable, Equatable, Identifiable {
    let target: LocalDiscoveryTarget
    let service: LocalDiscoveryService
    let host: String
    let port: Int
    var id: String { "\(target.profileID)|\(host)|\(port)" }
    var endpoint: MachineEndpoint {
        MachineEndpoint(host: host, port: port, expectedFingerprint: target.fingerprint,
            expectedPublicKey: target.publicKey.base64EncodedString())
    }
}

struct LocalDiscoveryService: Hashable, Sendable {
    let name: String
    let type: String
    let domain: String

    init?(name: String, type: String, domain: String) {
        // These are service tuple components, never hostnames or URL input.
        guard !name.isEmpty, name.utf8.count <= 63,
              type == "_remi._tcp." || type == "_remi._tcp",
              domain == "local." || domain == "local" else { return nil }
        self.name = name
        self.type = "_remi._tcp."
        self.domain = "local."
    }

    var sortKey: String { "\(domain)|\(type)|\(name)" }
}

enum LocalDiscoveryLimits {
    static let browseWindow: Duration = .seconds(8)
    static let resolutionTimeout: TimeInterval = 3
    static let services = 32
    static let resolvers = 2
    static let candidatesPerProfile = 4
}

/// NetService.addresses contains sockaddr bytes, not strings from TXT. Parse
/// with unaligned loads and exact lengths before reading any family fields.
enum LocalDiscoveryAddress {
    static func numericHost(_ data: Data, port: Int) -> String? {
        guard (1...65535).contains(port), data.count >= 2 else { return nil }
        let family = Int32(data[data.startIndex + 1])
        if family == AF_INET {
            guard data.count == MemoryLayout<sockaddr_in>.size,
                  data.first == UInt8(MemoryLayout<sockaddr_in>.size) else { return nil }
            var address = data.withUnsafeBytes { $0.loadUnaligned(as: sockaddr_in.self) }
            guard Int(UInt16(bigEndian: address.sin_port)) == port else { return nil }
            let bytes = withUnsafeBytes(of: address.sin_addr) { Array($0) }
            guard isUnicastV4(bytes) else { return nil }
            return numeric(AF_INET, &address.sin_addr)
        }
        if family == AF_INET6 {
            guard data.count == MemoryLayout<sockaddr_in6>.size,
                  data.first == UInt8(MemoryLayout<sockaddr_in6>.size) else { return nil }
            var address = data.withUnsafeBytes { $0.loadUnaligned(as: sockaddr_in6.self) }
            guard Int(UInt16(bigEndian: address.sin6_port)) == port,
                  address.sin6_scope_id == 0 else { return nil }
            let bytes = withUnsafeBytes(of: address.sin6_addr) { Array($0) }
            if bytes.prefix(10).allSatisfy({ $0 == 0 }), bytes[10] == 255, bytes[11] == 255 {
                let ipv4 = Array(bytes.suffix(4))
                guard isUnicastV4(ipv4) else { return nil }
                // One numeric route for IPv4 and its mapped representation.
                return ipv4.map(String.init).joined(separator: ".")
            }
            guard bytes[0] != 255,
                  !(bytes[0] == 254 && bytes[1] & 0xc0 == 0x80),
                  !bytes.prefix(12).allSatisfy({ $0 == 0 }) else { return nil }
            return numeric(AF_INET6, &address.sin6_addr)
        }
        return nil
    }

    private static func isUnicastV4(_ bytes: [UInt8]) -> Bool {
        bytes.count == 4 && bytes[0] != 0 && bytes[0] != 127 && bytes[0] < 224
            && !(bytes[0] == 169 && bytes[1] == 254)
    }

    private static func numeric<T>(_ family: Int32, _ address: inout T) -> String? {
        var result = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
        let converted = withUnsafeBytes(of: &address) {
            inet_ntop(family, $0.baseAddress, &result, socklen_t(result.count))
        }
        guard converted != nil else { return nil }
        return String(decoding: result.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
    }
}
