import Foundation

/// What the iPhone Inbox shows, decided from plain values so the rule is testable.
public enum RemiInboxPresentation {
    public enum State: Equatable, Sendable {
        /// No machine is saved yet.
        case firstRun
        /// At least one card waits for the person. `notes` are the cards that are no longer
        /// waiting (resolved elsewhere, answered, stale), shown below.
        case waiting(cards: [RemiQuestionCardModel], notes: [RemiQuestionCardModel])
        /// Machines exist and nothing waits. `notes` may still show.
        case quiet(activeSessionCount: Int, notes: [RemiQuestionCardModel])
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
        questions: [RemiQuestionCardModel],
        activeSessionCount: Int
    ) -> State {
        guard machineCount > 0 else { return .firstRun }
        let cards = questions.filter(\.isWaiting)
        let notes = questions.filter { !$0.isWaiting }
        if cards.isEmpty {
            return .quiet(activeSessionCount: activeSessionCount, notes: notes)
        }
        return .waiting(cards: cards, notes: notes)
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
