import Foundation

/// The search behind the Mac "Jump to" palette: sessions by name, repository, machine and
/// harness, and waiting questions by their text. Only data the app already holds.
public enum RemiJumpSearch {
    public enum Result: Identifiable, Sendable, Equatable {
        case session(RemiSessionSummary)
        /// A waiting question, with the session it belongs to when that session is known.
        case question(RemiQuestionCardModel, session: RemiSessionSummary?)

        public var id: String {
            switch self {
            case .session(let session): "session|\(session.machineID)|\(session.id)"
            case .question(let card, _): "question|\(card.machineID)|\(card.sessionID)|\(card.questionID)"
            }
        }
    }

    /// The palette shows at most this many results.
    public static let limit = 30

    /// With no query, sessions that need the person come first, then working, then the rest.
    /// With one, every word must match somewhere; a name that starts with the query ranks
    /// first, then a name that contains it, then a match in another field, then questions.
    public static func results(
        query: String, sessions: [RemiSessionSummary], questions: [RemiQuestionCardModel]
    ) -> [Result] {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let words = text.split(whereSeparator: \.isWhitespace).map(String.init)

        var ranked: [(tier: Int, session: RemiSessionSummary?, result: Result)] = []
        for session in sessions {
            guard let tier = tier(of: session, text: text, words: words) else { continue }
            ranked.append((tier, session, .session(session)))
        }
        if !words.isEmpty {
            for card in questions where card.state == .pending {
                let haystack = card.text.lowercased()
                guard words.allSatisfy({ haystack.contains($0) }) else { continue }
                let owner = sessions.first { $0.machineID == card.machineID && $0.id == card.sessionID }
                ranked.append((10, owner, .question(card, session: owner)))
            }
        }
        ranked.sort { lhs, rhs in
            if lhs.tier != rhs.tier { return lhs.tier < rhs.tier }
            let left = urgency(lhs.session)
            let right = urgency(rhs.session)
            if left != right { return left < right }
            return label(lhs.result) < label(rhs.result)
        }
        return ranked.prefix(limit).map(\.result)
    }

    /// The highlighted row after an arrow key, wrapping at both ends.
    public static func moved(from index: Int, by offset: Int, count: Int) -> Int {
        guard count > 0 else { return 0 }
        return ((index + offset) % count + count) % count
    }

    private static func tier(of session: RemiSessionSummary, text: String, words: [String]) -> Int? {
        guard !words.isEmpty else { return 0 }
        let name = session.name.lowercased()
        let haystack = [session.name, session.project, session.machineName, session.harness]
            .joined(separator: " ").lowercased()
        guard words.allSatisfy({ haystack.contains($0) }) else { return nil }
        if name.hasPrefix(text) { return 1 }
        if words.allSatisfy({ name.contains($0) }) { return 2 }
        return 3
    }

    private static func urgency(_ session: RemiSessionSummary?) -> Int {
        switch session?.status {
        case .needsYou: 0
        case .working: 1
        case .connecting: 2
        case .idle: 3
        case .offline, nil: 4
        }
    }

    private static func label(_ result: Result) -> String {
        switch result {
        case .session(let session): session.name.lowercased()
        case .question(let card, _): card.sessionName.lowercased()
        }
    }
}
