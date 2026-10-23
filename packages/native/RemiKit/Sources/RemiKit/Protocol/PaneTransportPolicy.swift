import Foundation

/// Which routes may carry the terminal-view and file-download families (#1639).
///
/// ADR 0045 and ADR 0047 allow these frames on two paths only: a direct secure WebSocket
/// (WSS) with the existing authenticated authority, and the encrypted semantic child of the
/// relay (phase B4). This app connects directly over plain `ws://` and has no semantic relay
/// child, so no route qualifies today: `current` is the single place that changes when a
/// transport lands. Tests inject another policy through the store's internal seam; the public
/// send path always uses `current`.
public struct PaneTransportPolicy: Sendable, Equatable {
    /// The app can open a signed, authenticated WSS connection to a daemon.
    public let directSecureTransport: Bool
    /// The app can open a relay child that carries these families end to end encrypted.
    public let relaySemanticChild: Bool

    init(directSecureTransport: Bool, relaySemanticChild: Bool) {
        self.directSecureTransport = directSecureTransport
        self.relaySemanticChild = relaySemanticChild
    }

    public static let current = PaneTransportPolicy(directSecureTransport: false, relaySemanticChild: false)

    /// Why a route cannot carry the families, or nil when it can.
    func reason(viaRelay: Bool) -> String? {
        if viaRelay {
            return relaySemanticChild
                ? nil : "Terminal views and file downloads do not yet work over the relay in this version of the app."
        }
        return directSecureTransport
            ? nil : "Terminal views and file downloads need a secure connection this version of the app cannot make yet."
    }

    func reason(for endpoint: MachineEndpoint) -> String? { reason(viaRelay: endpoint.relayPin != nil) }

    public static func blockReason(for endpoint: MachineEndpoint) -> String? { current.reason(for: endpoint) }
}

/// A pane frame was refused before sending because its route cannot carry the family.
public struct PaneTransportBlocked: Error, Sendable, Equatable {
    public let reason: String
}
