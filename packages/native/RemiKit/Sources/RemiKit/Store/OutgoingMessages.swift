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
        /// Claude Code reported that it submitted exactly this text (#1818): the only positive
        /// proof of agent acceptance. The row stays, drawn as an ordinary sent message, until the
        /// transcript shows that message (`removeAccepted`), so it never vanishes before it can be
        /// seen elsewhere.
        case accepted
        case refused
        case uncertain
    }

    public let id: String
    public let content: String
    public var delivery: Delivery
    public let createdAt: Date
    public let origin: OutgoingOrigin
    public let groupID: OutgoingGroupID?
    /// The connection this message went out on listed `chat_acceptance`, so the daemon will
    /// report Claude's acceptance if it can match the text (#1818). Only changes the wording
    /// while the message is handed off and unconfirmed; it never proves anything itself.
    public let awaitsAcceptance: Bool
    /// How many user transcript entries of this session had arrived when the message was tracked,
    /// before it was sent. Only an entry that arrives after that can be this message's own (#1818).
    public let arrivalAtSend: Int

    /// An opaque UI identity, including the immutable group. Never parsed as routing authority.
    public var presentationID: String {
        guard let groupID else { return "pending-\(id)" }
        return "pending:\(groupID.profile.id):\(groupID.sessionID.utf8.count):\(groupID.sessionID):\(id)"
    }
}

/// Bounded, memory-only intent history for one machine/session. Text matches, ACKs, age and
/// reconnects prove no per-message outcome, so an unsettled or refused intent leaves only by
/// explicit dismissal. An intent Claude reported accepting (#1818) is the exception: delivery is
/// already proven, so it also leaves once the transcript shows the message (`removeAccepted`), and
/// it is the first thing evicted when the bounds below would otherwise refuse a new send.
public struct OutgoingMessages: Sendable, Equatable {
    public static let limit = 50
    public private(set) var items: [OutgoingMessage] = []
    public init() {}
    init(retainedItems: [OutgoingMessage]) { items = retainedItems }

    @discardableResult
    public mutating func add(id: String, content: String, origin: OutgoingOrigin, groupID: OutgoingGroupID? = nil,
                             awaitsAcceptance: Bool = false, arrivalAtSend: Int = 0, now: Date = Date()) -> Bool {
        guard items.count < Self.limit, !items.contains(where: { $0.id == id }) else { return false }
        items.append(OutgoingMessage(id: id, content: content, delivery: .sending, createdAt: now, origin: origin,
                                     groupID: groupID, awaitsAcceptance: awaitsAcceptance, arrivalAtSend: arrivalAtSend))
        return true
    }

    func message(id: String, origin: OutgoingOrigin) -> OutgoingMessage? {
        index(id: id, origin: origin).map { items[$0] }
    }

    public mutating func markHandedOff(id: String, origin: OutgoingOrigin) {
        guard let index = index(id: id, origin: origin), items[index].delivery == .sending else { return }
        items[index].delivery = .handedOff
    }

    public mutating func markUncertain(id: String, origin: OutgoingOrigin) {
        guard let index = index(id: id, origin: origin),
              items[index].delivery != .refused, items[index].delivery != .accepted else { return }
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

    /// Claude Code's report that it submitted this message (#1818). Only a result from the exact
    /// session, message ID and authenticated origin that sent the message counts, the rules of
    /// `receive(_ error:)`. It is positive proof, so it also settles a message the local deadline
    /// marked uncertain, but it never undoes a refusal: the daemon never records a refused
    /// message, so a result for one is not from this daemon. The message stays, as `.accepted`, until
    /// the transcript shows it. Returns whether it settled one. A result for a message already
    /// dismissed or never sent finds nothing and changes nothing.
    @discardableResult
    public mutating func receive(_ result: UserInputResultMessage, sessionID: String, origin: OutgoingOrigin) -> Bool {
        guard result.sessionId == sessionID, result.outcome == UserInputResultMessage.accepted,
              let index = index(id: result.messageId, origin: origin),
              items[index].delivery != .refused else { return false }
        items[index].delivery = .accepted
        return true
    }

    /// Drops accepted messages the caller decided the transcript shows. Display reconciliation only:
    /// the caller's text match decides nothing about delivery, which the hook already proved.
    @discardableResult
    public mutating func removeAccepted(where isShown: (OutgoingMessage) -> Bool) -> Bool {
        let before = items.count
        items.removeAll { $0.delivery == .accepted && isShown($0) }
        return items.count != before
    }

    /// The accepted messages, oldest first.
    var acceptedMessages: [OutgoingMessage] { items.filter { $0.delivery == .accepted } }

    /// The one message a user transcript entry shows: only an accepted message, only by id.
    mutating func removeAccepted(ids: Set<String>) {
        items.removeAll { $0.delivery == .accepted && ids.contains($0.id) }
    }

    /// The oldest accepted message's creation time, for eviction when a bound would refuse a send.
    var oldestAcceptedAt: Date? { items.filter { $0.delivery == .accepted }.map(\.createdAt).min() }

    mutating func evictOldestAccepted() {
        guard let oldest = oldestAcceptedAt,
              let index = items.firstIndex(where: { $0.delivery == .accepted && $0.createdAt == oldest }) else { return }
        items.remove(at: index)
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
