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
    public let createdAt: Date
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

    /// The daemon can rewrite a message (a slash command expanded, an attachment marker added)
    /// so the transcript never matches it; such an entry stops showing after this many seconds.
    public static let lifetime: TimeInterval = 300

    public private(set) var items: [OutgoingMessage] = []

    public init() {}

    public mutating func add(id: String, content: String, now: Date = Date()) {
        dropExpired(now: now)
        items.append(OutgoingMessage(id: id, content: content, delivery: .sending, createdAt: now))
        if items.count > Self.limit { items.removeFirst(items.count - Self.limit) }
    }

    /// The entries younger than `lifetime`, oldest first.
    public func visible(now: Date = Date()) -> [OutgoingMessage] {
        items.filter { now.timeIntervalSince($0.createdAt) < Self.lifetime }
    }

    private mutating func dropExpired(now: Date) {
        items = visible(now: now)
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
    public mutating func confirm(transcriptContent: String, now: Date = Date()) -> Bool {
        dropExpired(now: now)
        let text = transcriptContent.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let index = items.firstIndex(where: {
            $0.content.trimmingCharacters(in: .whitespacesAndNewlines) == text
        }) else { return false }
        items.remove(at: index)
        return true
    }
}
