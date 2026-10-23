import Foundation

/// Which menu bar commands apply right now, decided from plain values so the rules are
/// testable. A command that has nothing to act on is disabled, never a silent no-op.
public struct RemiMacCommandAvailability: Equatable, Sendable {
    /// What Reconnect does for the selected machine.
    public enum Reconnect: Equatable, Sendable {
        /// Open the connection again.
        case connection
        /// Check again whether the person authorized this device on the machine.
        case approval

        /// The action for a machine in this recovery state, or nil when reconnecting from here
        /// would not help: it is connected or connecting, waits for a terminal confirmation, or
        /// needs a fresh relay pairing (a retry would imply the expired pairing can recover).
        public static func resolve(recovery: RemiMachineRecoveryState) -> Self? {
            switch recovery {
            case .retryableOffline, .retryableUnavailable: .connection
            case .waitingForDirectApproval: .approval
            case .none, .waitingForRelayConfirmation, .relayOffline, .relayNeedsFreshPairing: nil
            }
        }
    }

    public let goToInbox: Bool
    public let nextNeedsYou: Bool
    public let previousSession: Bool
    public let nextSession: Bool
    public let previousMachine: Bool
    public let nextMachine: Bool
    public let reconnect: Bool

    /// - Parameters:
    ///   - machineCount: Saved machines.
    ///   - needsYouSessionCount: Sessions with a waiting card, across every machine.
    ///   - sessionListCount: Sessions in the list the person is looking at (zero while the
    ///     Inbox is shown).
    ///   - reconnect: What Reconnect would do for the selected machine.
    ///   - showsInbox: The Inbox is shown, so the selected machine is not on screen and
    ///     Reconnect would act on something the person cannot see.
    public init(
        machineCount: Int,
        needsYouSessionCount: Int,
        sessionListCount: Int,
        reconnect: Reconnect?,
        showsInbox: Bool = false
    ) {
        goToInbox = machineCount > 0
        nextNeedsYou = needsYouSessionCount > 0
        previousSession = sessionListCount > 0
        nextSession = sessionListCount > 0
        previousMachine = machineCount > 1
        nextMachine = machineCount > 1
        self.reconnect = reconnect != nil && !showsInbox
    }

    /// Find in Conversation needs something to search: an entry in the open conversation.
    public static func canFind(hasOpenConversation: Bool, entryCount: Int) -> Bool {
        hasOpenConversation && entryCount > 0
    }
}

/// The Next and Previous Needs You commands, across machines.
public enum RemiNeedsYouJump {
    /// The session `offset` steps from `current` among sessions that need the person, ordered
    /// by machine (in `machineOrder`) and then by their order in `sessions`. A `current` that
    /// is not in that list (a quiet session, the Inbox) starts from the edge: forward lands on
    /// the first, backward on the last. Nil when nothing needs the person.
    public static func target(
        from current: RemiSessionKey?,
        sessions: [RemiSessionSummary],
        machineOrder: [String],
        offset: Int
    ) -> RemiSessionKey? {
        let rank = Dictionary(machineOrder.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
        let waiting = sessions.enumerated()
            .filter { $0.element.status == .needsYou }
            .sorted { lhs, rhs in
                let left = rank[lhs.element.machineID] ?? .max
                let right = rank[rhs.element.machineID] ?? .max
                return left != right ? left < right : lhs.offset < rhs.offset
            }
            .map { $0.element.key }
        return RemiOrderedSelection.shifted(selection: current, orderedIDs: waiting, offset: offset)
    }
}
