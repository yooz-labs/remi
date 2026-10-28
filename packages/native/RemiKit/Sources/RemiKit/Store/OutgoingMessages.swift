import Foundation

/// A message the person sent that the conversation does not show yet.
public struct OutgoingMessage: Identifiable, Sendable, Equatable {
    public enum Delivery: Sendable, Equatable {
        /// Not yet handed to the connection.
        case sending
        /// Handed to the connection; the transcript has not shown it yet.
        /// This does not mean the agent has read it.
        case sent
    }

    public let id: String
    public let content: String
    public var delivery: Delivery
}

/// The messages one session is still waiting to see in its transcript, oldest first.
///
/// An entry leaves when the transcript shows a new user entry with the same text, when its
/// send fails, or after `lifetime`. A failed send removes the bubble because the composer
/// keeps the draft; if the connection failed after the daemon received the message, the text
/// can still arrive and show in the transcript.
public struct OutgoingMessages: Sendable, Equatable {
    /// A stuck connection cannot grow the queue without bound; the oldest entries drop first.
    public static let limit = 50

    public private(set) var items: [OutgoingMessage] = []

    public init() {}

    public mutating func add(id: String, content: String) {
        items.append(OutgoingMessage(id: id, content: content, delivery: .sending))
        if items.count > Self.limit { items.removeFirst(items.count - Self.limit) }
    }

    public mutating func markSent(id: String) {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        items[index].delivery = .sent
    }

    public mutating func remove(id: String) {
        items.removeAll { $0.id == id }
    }

    /// Removes the oldest entry whose text matches a new transcript user entry.
    @discardableResult
    public mutating func confirm(transcriptContent: String) -> Bool {
        let text = transcriptContent.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let index = items.firstIndex(where: {
            $0.content.trimmingCharacters(in: .whitespacesAndNewlines) == text
        }) else { return false }
        items.remove(at: index)
        return true
    }
}
