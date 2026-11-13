import Foundation

/// The concrete connection and authenticated socket used for one message intent (#1710).
public struct OutgoingOrigin: Sendable, Equatable {
    public let endpoint: MachineEndpoint
    public let connection: UUID
    public let socket: UUID
}

/// A profile namespace never survives Forget as the current namespace. The authority is set
/// only from an authenticated Hello, not a saved pin, descriptor, name or address (#1710).
public struct OutgoingProfileScope: Hashable, Sendable {
    public let id: UUID
    let profileLifetime: UUID
    let authenticatedAuthority: Data?

    init(profileLifetime: UUID, authenticatedAuthority: Data?) {
        id = UUID()
        self.profileLifetime = profileLifetime
        self.authenticatedAuthority = authenticatedAuthority
    }
}

public struct OutgoingGroupID: Hashable, Sendable {
    public let profile: OutgoingProfileScope
    public let sessionID: String
}

/// Context retained only in memory so an ended or removed session's input remains recoverable.
public struct OutgoingMessageGroup: Identifiable, Sendable {
    public let id: OutgoingGroupID
    /// Captured display context only. Address reuse does not authorize lookup or dismissal.
    public let key: MachineSessionKey
    public let machineName: String
    public let sessionName: String
    public let messages: [OutgoingMessage]
    public let isCurrentProfile: Bool
    public let remainingSessionCapacity: Int
}

/// An explicit message intent. Transport handoff never proves agent acceptance.
public struct OutgoingMessage: Identifiable, Sendable, Equatable {
    public enum Delivery: Sendable, Equatable {
        case sending
        case handedOff
        case refused
        case uncertain
    }

    public let id: String
    public let content: String
    public var delivery: Delivery
    public let createdAt: Date
    public let origin: OutgoingOrigin
    public let groupID: OutgoingGroupID?

    /// An opaque UI identity, including the immutable group. Never parsed as routing authority.
    public var presentationID: String {
        guard let groupID else { return "pending-\(id)" }
        return "pending:\(groupID.profile.id):\(groupID.sessionID.utf8.count):\(groupID.sessionID):\(id)"
    }
}

/// Bounded, memory-only intent history for one machine/session. Only explicit dismissal removes
/// an invoked intent: text matches, ACKs, age and reconnects prove no per-message outcome.
public struct OutgoingMessages: Sendable, Equatable {
    public static let limit = 50
    public private(set) var items: [OutgoingMessage] = []
    public init() {}
    init(retainedItems: [OutgoingMessage]) { items = retainedItems }

    @discardableResult
    public mutating func add(id: String, content: String, origin: OutgoingOrigin, groupID: OutgoingGroupID? = nil, now: Date = Date()) -> Bool {
        guard items.count < Self.limit, !items.contains(where: { $0.id == id }) else { return false }
        items.append(OutgoingMessage(id: id, content: content, delivery: .sending, createdAt: now, origin: origin, groupID: groupID))
        return true
    }

    public mutating func markHandedOff(id: String, origin: OutgoingOrigin) {
        guard let index = index(id: id, origin: origin), items[index].delivery == .sending else { return }
        items[index].delivery = .handedOff
    }

    public mutating func markUncertain(id: String, origin: OutgoingOrigin) {
        guard let index = index(id: id, origin: origin), items[index].delivery != .refused else { return }
        items[index].delivery = .uncertain
    }

    /// Only current authenticated source errors with the exact session and message ID can
    /// prove refusal. The producer guards in input-events.ts run before submitInput or before
    /// its first write. Its second guard sets inputMayBePartial after the first possible write.
    /// INPUT_NOT_DELIVERED also has older raw-write producers, so it stays uncertain.
    public mutating func receive(_ error: ErrorMessage, sessionID: String, origin: OutgoingOrigin) {
        guard case .string(let session)? = error.details?["sessionId"], session == sessionID else { return }
        // Session-only errors may belong to another concurrent operation. They cannot
        // change any message outcome; the app still surfaces the ordinary session error.
        guard case .string(let id)? = error.details?["messageId"] else { return }
        guard let index = index(id: id, origin: origin) else { return }
        let partial = error.details?["inputMayBePartial"]
        let noPartial = partial == nil || partial == .bool(false)
        let refusesBeforeInput = ["PROMPT_WAITING", "SESSION_NOT_FOUND", "STALE_BINDING"].contains(error.code)
        if noPartial && refusesBeforeInput {
            items[index].delivery = .refused
        } else {
            markUncertain(id: id, origin: origin)
        }
    }

    public mutating func connectionLost(endpoint: MachineEndpoint, connection: UUID) {
        for item in items where item.origin.endpoint == endpoint && item.origin.connection == connection {
            markUncertain(id: item.id, origin: item.origin)
        }
    }

    public mutating func dismiss(id: String) { items.removeAll { $0.id == id } }

    private func index(id: String, origin: OutgoingOrigin) -> Int? {
        items.firstIndex { $0.id == id && $0.origin == origin }
    }
}
