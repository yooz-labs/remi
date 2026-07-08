//
//  HubProtocol.swift
//  Remi
//
//  Minimal Codable surface of the remi WebSocket protocol (#649): just the
//  frames the menu-bar shell needs. The app is a query-mode client — it never
//  attaches, sends input, or answers questions; the embedded web UI has the
//  full protocol stack.
//
//  Wire facts (packages/shared/src/protocol.ts):
//  - timestamps are ISO8601 strings with fractional seconds
//  - ids are lowercase UUID strings
//  - a hub answers hello with hello_ack{sessionId: null}; a session daemon
//    answers with a non-null sessionId
//

import Foundation

enum HubProtocol {
    static let protocolVersion = "1.0.0"

    static func isoTimestamp(_ date: Date = Date()) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    static func newId() -> String {
        UUID().uuidString.lowercased()
    }
}

/// Outgoing `hello`, always query-mode: utility clients never auto-attach and
/// (#650) are excluded from the hub's client census, so the app's own monitor
/// connection can never flip the icon to "local client attached".
struct HelloFrame: Encodable {
    let type = "hello"
    let id: String
    let timestamp: String
    let clientVersion: String
    let clientId: String
    let mode = "query"

    init(clientVersion: String, clientId: String) {
        self.id = HubProtocol.newId()
        self.timestamp = HubProtocol.isoTimestamp()
        self.clientVersion = clientVersion
        self.clientId = clientId
    }
}

/// Outgoing `ping` (protocol-level liveness; see protocol.ts ping/pong).
struct PingFrame: Encodable {
    let type = "ping"
    let id: String
    let timestamp: String

    init() {
        self.id = HubProtocol.newId()
        self.timestamp = HubProtocol.isoTimestamp()
    }
}

/// Incoming frame envelope: decode the `type` first, then the payload we
/// care about. Unknown types are ignored (mirror of the TS isValidMessage
/// forward-compat rule).
struct IncomingFrameType: Decodable {
    let type: String
}

/// Incoming `hello_ack`. `sessionId` null means the peer is a session-less
/// hub (#542); non-null means a legacy single-session daemon answered.
struct HelloAckFrame: Decodable {
    let type: String
    let sessionId: String?
    let serverVersion: String
    /// The daemon's remi binary version (#539); absent pre-#539.
    let daemonVersion: String?
}

/// Incoming `hub_status` census (#650): the icon-state data source.
struct HubStatusFrame: Decodable {
    let type: String
    let localClients: Int
    let remoteClients: Int
    let sessions: Int
    let hubVersion: String
}

/// Incoming `pong`.
struct PongFrame: Decodable {
    let type: String
}
