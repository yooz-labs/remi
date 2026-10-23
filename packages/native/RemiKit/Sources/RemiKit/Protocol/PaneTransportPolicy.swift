import Foundation

/// Which routes may carry the terminal-view and file-download families (#1639).
///
/// ADR 0045 and ADR 0047 allow these frames on two paths only: a direct secure WebSocket
/// (WSS) with the existing authenticated authority, and the encrypted semantic child of the
/// relay (phase B4). This app connects directly over plain `ws://` and has no semantic relay
/// child, so no route qualifies today. Both switches below are the single place that changes
/// when a transport lands; until then a capability a hub advertises is still not offered.
public enum PaneTransportPolicy {
    /// The app can open a signed, authenticated WSS connection to a daemon.
    public static let directSecureTransport = false
    /// The app can open a relay child that carries these families end to end encrypted.
    public static let relaySemanticChild = false

    /// Why this route cannot carry the families, or nil when it can.
    public static func blockReason(for endpoint: MachineEndpoint) -> String? {
        if endpoint.relayPin != nil {
            return relaySemanticChild
                ? nil : "Terminal views and file downloads do not yet work over the relay in this version of the app."
        }
        return directSecureTransport
            ? nil : "Terminal views and file downloads need a secure connection this version of the app cannot make yet."
    }
}
