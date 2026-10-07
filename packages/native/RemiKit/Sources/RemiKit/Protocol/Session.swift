import Foundation

/// A session a machine can show (`DiscoverableSession` in `packages/shared/src/types.ts`).
public struct DiscoverableSession: Codable, Sendable, Equatable, Identifiable {
    public var id: String { sessionId }

    public let sessionId: String
    /// Absent for a session found from a transcript on disk (`source: "transcript"`).
    public let name: String?
    public let projectPath: String
    public let status: String
    public let source: String
    public let lastMessage: String?
    public let harness: String?
    public let canAttach: Bool?
    public let wsPort: Int?
}

/// `{ "type": "session_list_response", ... }`: the sessions a machine has.
public struct SessionListResponse: Decodable, Sendable, Equatable {
    public let type: String
    public let sessions: [DiscoverableSession]
    /// The ports of the machine's session daemons (#542); a machine object replaces this (#1234).
    public let daemonPorts: [Int]?
}
