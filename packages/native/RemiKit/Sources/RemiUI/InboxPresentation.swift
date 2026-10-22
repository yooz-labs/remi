import Foundation

/// What the iPhone Inbox shows, decided from plain values so the rule is testable.
public enum RemiInboxPresentation {
    public enum State: Equatable, Sendable {
        /// No machine is saved yet.
        case firstRun
        /// At least one card waits for the person. `notes` are the cards that are no longer
        /// waiting (resolved elsewhere, answered, stale), shown below.
        case waiting(cards: [RemiQuestionCardModel], notes: [RemiQuestionCardModel])
        /// Machines exist and nothing waits. `notes` may still show. With no connected
        /// machine, nothing can be said about what needs the person.
        case quiet(activeSessionCount: Int, hasConnectedMachine: Bool, notes: [RemiQuestionCardModel])
    }

    /// Where the "Open conversation" link goes. It only navigates; it never answers.
    public struct OpenTarget: Equatable, Sendable {
        public let machineID: String
        public let sessionID: String
        /// The card's agent id; nil for the main conversation.
        public let conversationID: String?

        public init(machineID: String, sessionID: String, conversationID: String?) {
            self.machineID = machineID
            self.sessionID = sessionID
            self.conversationID = conversationID
        }
    }

    /// A card waits when it is pending or sending. Every other state is a note. Input order
    /// is kept in both lists.
    public static func state(
        machineCount: Int,
        connectedMachineCount: Int,
        questions: [RemiQuestionCardModel],
        activeSessionCount: Int
    ) -> State {
        guard machineCount > 0 else { return .firstRun }
        let cards = questions.filter(\.isWaiting)
        let notes = questions.filter { !$0.isWaiting }
        if cards.isEmpty {
            return .quiet(
                activeSessionCount: activeSessionCount,
                hasConnectedMachine: connectedMachineCount > 0,
                notes: notes
            )
        }
        return .waiting(cards: cards, notes: notes)
    }

    public struct QuietCopy: Equatable, Sendable {
        public let title: String
        public let detail: String
        /// A reassuring mark is only honest when a machine is connected to vouch for it.
        public let symbolName: String
    }

    /// The words of the quiet state. Without a connected machine it must not claim that
    /// nothing needs the person, and it says nothing about sessions. While some machines are
    /// connected and others are not, the detail says it cannot tell for the others.
    public static func quietCopy(
        activeSessionCount: Int,
        hasConnectedMachine: Bool,
        unconnectedMachineCount: Int = 0
    ) -> QuietCopy {
        guard hasConnectedMachine else {
            return QuietCopy(
                title: "No machine is connected",
                detail: "Remi cannot tell whether anything needs you. Check the machines above.",
                symbolName: "desktopcomputer.trianglebadge.exclamationmark"
            )
        }
        let caveat = unconnectedMachineCount > 0
            ? " \(unconnectedMachineCount)\u{00A0}\(unconnectedMachineCount == 1 ? "machine" : "machines") not connected: Remi cannot tell for them."
            : ""
        switch activeSessionCount {
        case 0:
            return QuietCopy(
                title: "Nothing needs you",
                detail: "No active sessions. Open the menu to see recent sessions." + caveat,
                symbolName: "checkmark.circle"
            )
        case 1:
            return QuietCopy(
                title: "Nothing needs you",
                detail: "1 active session. Open the menu to pick a session." + caveat,
                symbolName: "checkmark.circle"
            )
        default:
            return QuietCopy(
                title: "Nothing needs you",
                detail: "\(activeSessionCount) active sessions. Open the menu to pick a session." + caveat,
                symbolName: "checkmark.circle"
            )
        }
    }

    /// Whether the expanded card list stays expanded after the card count changes: only
    /// while more than the collapsed two remain, so answering the third card does not
    /// collapse the list.
    public static func keepsExpanded(wasExpanded: Bool, cardCount: Int) -> Bool {
        wasExpanded && cardCount > 2
    }

    /// The target for `card`, or nil when its session is not in `sessions` for the card's
    /// machine (the session is gone, so no link is shown).
    public static func openTarget(
        for card: RemiQuestionCardModel,
        sessions: [RemiSessionSummary]
    ) -> OpenTarget? {
        guard sessions.contains(where: { $0.machineID == card.machineID && $0.id == card.sessionID })
        else { return nil }
        return OpenTarget(
            machineID: card.machineID,
            sessionID: card.sessionID,
            conversationID: card.agentID
        )
    }
}

private extension RemiQuestionCardModel {
    var isWaiting: Bool {
        switch state {
        case .pending, .sending: true
        case .answered, .resolvedElsewhere, .stale: false
        }
    }
}
