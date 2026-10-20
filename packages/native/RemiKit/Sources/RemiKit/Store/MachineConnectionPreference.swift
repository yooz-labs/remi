import Darwin
import Foundation

/// User policy limits the routes a profile may attempt; it conveys no trust.
public enum MachineConnectionPreference: String, Codable, CaseIterable, Sendable, Identifiable {
    case automatic, localOnly, tailscaleOnly, relayOnly

    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .automatic: "Automatic"
        case .localOnly: "Local only"
        case .tailscaleOnly: "Tailscale only"
        case .relayOnly: "Relay only"
        }
    }

    public var guidance: String {
        switch self {
        case .automatic: "Try Local, Tailscale, then an enrolled Relay."
        case .localOnly: "Use Local only. Other layers will not be tried."
        case .tailscaleOnly: "Use Tailscale only. Keep Tailscale connected on both devices."
        case .relayOnly: "Use Relay only. This device must already be paired over Relay."
        }
    }

    public func permits(_ endpoint: MachineEndpoint) -> Bool {
        switch self {
        case .automatic: true
        case .localOnly: endpoint.connectionLayer == .local
        case .tailscaleOnly: endpoint.connectionLayer == .tailscale
        case .relayOnly: endpoint.connectionLayer == .relay
        }
    }

    public func orderedRoutes(_ routes: [MachineEndpoint]) -> [MachineEndpoint] {
        routes.enumerated().filter { permits($0.element) }.sorted {
            if $0.element.connectionLayer != $1.element.connectionLayer {
                return $0.element.connectionLayer.rawValue < $1.element.connectionLayer.rawValue
            }
            return $0.offset < $1.offset
        }.map(\.element)
    }
}

public enum MachineConnectionLayer: Int, Sendable, Comparable {
    case local, tailscale, relay
    public static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
    public var title: String {
        switch self {
        case .local: "Local"
        case .tailscale: "Tailscale"
        case .relay: "Relay"
        }
    }
}

extension MachineEndpoint {
    /// Routing classification is only a scheduling hint. Every route still
    /// needs its authenticated machine key; the address never grants access.
    public var connectionLayer: MachineConnectionLayer {
        if relayPin != nil { return .relay }
        let address = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
        if address == "ts.net" || address.hasSuffix(".ts.net") { return .tailscale }
        var ipv4 = in_addr(), ipv6 = in6_addr()
        let bytes: Data
        if inet_pton(AF_INET, address, &ipv4) == 1 {
            bytes = withUnsafeBytes(of: ipv4) { Data($0) }
        } else if inet_pton(AF_INET6, address, &ipv6) == 1 {
            let groups = withUnsafeBytes(of: ipv6) { Data($0) }
            if groups.prefix(6) == Data([0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0]) { return .tailscale }
            guard groups.prefix(12) == Data(repeating: 0, count: 10) + Data([255, 255]) else { return .local }
            bytes = Data(groups.suffix(4))
        } else { return .local }
        return bytes.count == 4 && bytes[0] == 100 && (64...127).contains(bytes[1]) ? .tailscale : .local
    }
}
