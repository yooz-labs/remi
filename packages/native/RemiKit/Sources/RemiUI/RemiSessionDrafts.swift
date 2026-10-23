import Foundation

/// Unsent composer text per session, small enough for scene storage. A draft belongs to one
/// session on one machine (`RemiSessionKey`), so switching sessions does not lose or mix text.
///
/// The set is bounded: the most recently edited drafts stay, each is cut to a limit, and an
/// empty draft is removed. Scene storage is not a place for large or lasting data.
public struct RemiSessionDrafts: Equatable, Sendable {
    public static let maximumDrafts = 16
    public static let maximumCharacters = 4_000

    private struct Entry: Codable, Equatable, Sendable {
        let machineID: String
        let sessionID: String
        let text: String
    }

    /// Oldest edit first.
    private var entries: [Entry]

    public init() { entries = [] }

    /// Reads what `storageValue` wrote. An empty or unreadable string is no drafts.
    public init(storageValue: String) {
        guard let data = storageValue.data(using: .utf8),
              let decoded = try? JSONDecoder().decode([Entry].self, from: data)
        else {
            entries = []
            return
        }
        entries = Array(decoded.filter { !$0.text.isEmpty }.suffix(Self.maximumDrafts))
            .map { Entry(machineID: $0.machineID, sessionID: $0.sessionID, text: Self.limited($0.text)) }
    }

    public var storageValue: String {
        guard !entries.isEmpty,
              let data = try? JSONEncoder().encode(entries),
              let text = String(data: data, encoding: .utf8)
        else { return "" }
        return text
    }

    public func draft(for key: RemiSessionKey) -> String {
        entries.first { $0.machineID == key.machineID && $0.sessionID == key.sessionID }?.text ?? ""
    }

    /// These drafts with `text` stored for `key`. An empty `text` removes the draft; a changed
    /// one becomes the most recent. Unchanged text returns the drafts as they were.
    public func setting(_ text: String, for key: RemiSessionKey) -> Self {
        let text = Self.limited(text)
        guard draft(for: key) != text else { return self }
        var copy = self
        copy.entries.removeAll { $0.machineID == key.machineID && $0.sessionID == key.sessionID }
        if !text.isEmpty {
            copy.entries.append(Entry(machineID: key.machineID, sessionID: key.sessionID, text: text))
            copy.entries = Array(copy.entries.suffix(Self.maximumDrafts))
        }
        return copy
    }

    private static func limited(_ text: String) -> String {
        String(text.prefix(maximumCharacters))
    }
}
