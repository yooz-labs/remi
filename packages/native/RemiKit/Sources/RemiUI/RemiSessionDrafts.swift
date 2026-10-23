import Foundation

/// Unsent composer text per session, small enough for scene storage. A draft belongs to one
/// session on one machine (`RemiSessionKey`), so switching sessions does not lose or mix text.
///
/// Drafts in memory are exact: nothing is cut while the app runs, so the text a person typed
/// is what a re-created view shows. The stored form (`storageValue`) is bounded, because scene
/// storage is not a place for large data: the most recently edited drafts are kept and each is
/// cut to `maximumCharacters`. A draft only loses text when it is stored and read back after
/// a relaunch. Drafts can hold anything the person typed, secrets included, and scene storage
/// is not encrypted.
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
    }

    /// The bounded form to persist.
    public var storageValue: String {
        let stored = entries.suffix(Self.maximumDrafts)
            .map { Entry(machineID: $0.machineID, sessionID: $0.sessionID, text: Self.limited($0.text)) }
        guard !stored.isEmpty,
              let data = try? JSONEncoder().encode(Array(stored)),
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
        guard draft(for: key) != text else { return self }
        var copy = self
        copy.entries.removeAll { $0.machineID == key.machineID && $0.sessionID == key.sessionID }
        if !text.isEmpty {
            copy.entries.append(Entry(machineID: key.machineID, sessionID: key.sessionID, text: text))
            copy.entries = Array(copy.entries.suffix(Self.maximumDrafts))
        }
        return copy
    }

    /// Drafts whose session is gone. A draft is dropped when its machine is no longer saved, or
    /// when its machine's session list is known (`loadedMachineIDs`) and the session is not in
    /// it. A machine whose list has not loaded yet keeps its drafts: absence proves nothing.
    public func pruned(
        savedMachineIDs: Set<String>,
        loadedMachineIDs: Set<String>,
        sessionKeys: Set<RemiSessionKey>
    ) -> Self {
        var copy = self
        copy.entries.removeAll { entry in
            guard savedMachineIDs.contains(entry.machineID) else { return true }
            guard loadedMachineIDs.contains(entry.machineID) else { return false }
            return !sessionKeys.contains(RemiSessionKey(machineID: entry.machineID, sessionID: entry.sessionID))
        }
        return copy
    }

    private static func limited(_ text: String) -> String {
        String(text.prefix(maximumCharacters))
    }
}
