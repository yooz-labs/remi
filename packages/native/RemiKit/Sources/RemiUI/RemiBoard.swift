import CoreGraphics
import Foundation

/// How much of a session a board tile shows.
public enum RemiTileSize: String, Codable, CaseIterable, Sendable {
    /// One line under the title, no composer: the phone's compact density.
    case row
    case compact, regular, large

    /// The densities the phone offers, like a mail list's compact, medium and long.
    public static let phoneDensities: [RemiTileSize] = [.row, .regular, .large]

    public var densityTitle: String {
        switch self {
        case .row: "Compact"
        case .compact: "Small"
        case .regular: "Medium"
        case .large: "Long"
        }
    }

    /// The density saved earlier, or Medium when there is none or it cannot be read.
    public init(storedDensity: String) {
        self = Self(rawValue: storedDensity) ?? .regular
    }

    /// The phone's density for a saved value: Medium for anything the phone does not offer.
    public static func phoneDensity(stored: String) -> RemiTileSize {
        RemiTileSize(storedDensity: stored)
    }

    /// Whether the tile shows the conversation, as opposed to a single line.
    public var showsFeed: Bool { self != .row }

    /// Whether the tile has a field to type into.
    public var showsComposer: Bool { self != .row }

    /// About how tall the tile is, for packing columns before it is laid out.
    public var estimatedHeight: CGFloat {
        switch self {
        case .row: 96
        case .compact: 260
        case .regular: 420
        case .large: 640
        }
    }

    /// How many of the latest conversation entries the tile keeps ready to show.
    public var feedEntries: Int {
        switch self {
        case .row: 1
        case .compact: 4
        case .regular: 8
        case .large: 16
        }
    }

    /// Lines of the latest message the tile shows.
    public var messageLines: Int {
        switch self {
        case .row: 1
        case .compact: 2
        case .regular: 6
        case .large: 16
        }
    }
}

/// What the person arranged on the command center board: tiles they pinned to a slot, and
/// the size each tile has. Everything else is ordered automatically (``RemiBoardOrder``).
///
/// A slot is an index into the list as the board showed it, after any machine or "needs you"
/// filter. A pin made under a filter means a place in that filtered list, not in the full one.
public struct RemiBoardState: Codable, Equatable, Sendable {
    private var pinnedSlots: [String: Int] = [:]
    private var sizes: [String: RemiTileSize] = [:]

    public init() {}

    /// Reads the value written by `storageValue`; anything unreadable is an empty board.
    public init(storage: String) {
        guard let data = storage.data(using: .utf8),
              let decoded = try? JSONDecoder().decode(Self.self, from: data)
        else { return }
        self = decoded
        // A hand-edited or damaged value must not make a slot negative.
        pinnedSlots = pinnedSlots.mapValues { max(0, $0) }
    }

    public var storageValue: String {
        guard let data = try? JSONEncoder().encode(self) else { return "" }
        return String(decoding: data, as: UTF8.self)
    }

    public var pinnedKeys: Set<String> { Set(pinnedSlots.keys) }
    public func isPinned(_ key: String) -> Bool { pinnedSlots[key] != nil }
    public func slot(of key: String) -> Int? { pinnedSlots[key] }
    public mutating func pin(_ key: String, atSlot slot: Int) { pinnedSlots[key] = max(0, slot) }
    public mutating func unpin(_ key: String) { pinnedSlots[key] = nil }

    public func size(for key: String) -> RemiTileSize { sizes[key] ?? .regular }
    public mutating func setSize(_ size: RemiTileSize, for key: String) { sizes[key] = size }

    /// Drops a tile onto another's place: it takes that slot and is pinned there, and the
    /// pinned tiles at or after the slot shift one place on.
    public mutating func move(_ key: String, onto target: String, in order: [String]) {
        guard key != target, let slot = order.firstIndex(of: target) else { return }
        for (other, otherSlot) in pinnedSlots where other != key && otherSlot >= slot {
            pinnedSlots[other] = otherSlot + 1
        }
        pinnedSlots[key] = slot
    }

    /// Forgets tiles for sessions that no longer exist. An entry goes only when its machine is
    /// connected (so its list is current) and its key is not in `live`; a machine that is
    /// reconnecting lists nothing for a while, and that must not unpin its tiles.
    /// Returns whether anything was removed.
    @discardableResult
    public mutating func prune(live: Set<String>, connectedMachines: Set<String>) -> Bool {
        func gone(_ key: String) -> Bool {
            connectedMachines.contains(RemiBoardOrder.machineID(ofKey: key)) && !live.contains(key)
        }
        let before = (pinnedSlots.count, sizes.count)
        pinnedSlots = pinnedSlots.filter { !gone($0.key) }
        sizes = sizes.filter { !gone($0.key) }
        return before != (pinnedSlots.count, sizes.count)
    }
}

/// Columns, automatic order and focus order for the command center board.
public enum RemiBoardOrder {
    public static let maximumColumns = 6
    /// A tile typed into this recently rises, the way a session that just asked a question does.
    public static let interactionWindow: TimeInterval = 15 * 60

    /// How many tile columns fit a width: as many as keep each tile at least `minimumTile` wide.
    public static func columnCount(width: CGFloat, minimumTile: CGFloat = 340, spacing: CGFloat = 12) -> Int {
        guard width > 0 else { return 1 }
        let fit = Int((width + spacing) / (minimumTile + spacing))
        return min(max(fit, 1), maximumColumns)
    }

    /// A session's identity on the board; the same session id on two machines stays two tiles.
    public static func key(for session: RemiSessionSummary) -> String {
        "\(session.machineID)\u{1F}\(session.id)"
    }

    /// The machine a ``key(for:)`` belongs to; a string that is not a key is returned whole.
    public static func machineID(ofKey key: String) -> String {
        key.split(separator: "\u{1F}", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? key
    }

    /// The board's order. Pinned tiles keep their slots, and so do `held` tiles (one whose
    /// composer is in use keeps the slot it has now, so it never jumps under the cursor).
    /// The rest are ordered by how much they need the person: a question first, then a tile
    /// the person typed into recently, then working, idle and offline; newer activity first
    /// within each, then by name. A pinned or held slot is an index into `sessions` as passed
    /// (already filtered); one past the end takes a place from the end, in its relative order.
    public static func arrange(
        _ sessions: [RemiSessionSummary],
        state: RemiBoardState,
        interactions: [String: Date],
        held: [String: Int],
        now: Date
    ) -> [RemiSessionSummary] {
        // The same key twice (a list that repeats a session) shows once, the first copy.
        var seen = Set<String>()
        let sessions = sessions.filter { seen.insert(key(for: $0)).inserted }
        let count = sessions.count
        guard count > 0 else { return [] }
        let byKey = Dictionary(uniqueKeysWithValues: sessions.map { (key(for: $0), $0) })

        var wanted: [(key: String, slot: Int)] = []
        for (key, slot) in held where byKey[key] != nil { wanted.append((key, max(0, slot))) }
        for key in state.pinnedKeys where byKey[key] != nil && held[key] == nil {
            wanted.append((key, max(0, state.slot(of: key) ?? 0)))
        }
        wanted.sort { ($0.slot, $0.key) < ($1.slot, $1.key) }

        var slots = [RemiSessionSummary?](repeating: nil, count: count)
        var placed = Set<String>()
        // Pass one: each tile takes its slot, or the next free one after it. A tile whose slot
        // is past the end, or with no free slot after it, waits for pass two.
        var overflow: [String] = []
        for item in wanted {
            guard let session = byKey[item.key] else { continue }
            if item.slot < count, let index = (item.slot..<count).first(where: { slots[$0] == nil }) {
                slots[index] = session
                placed.insert(item.key)
            } else {
                overflow.append(item.key)
            }
        }
        // Pass two: those tiles fill the last free places, the last of them in the last place,
        // so they keep the order they had.
        for key in overflow.reversed() {
            guard let session = byKey[key], let index = slots.indices.last(where: { slots[$0] == nil }) else { continue }
            slots[index] = session
            placed.insert(key)
        }

        var rest = sessions.filter { !placed.contains(key(for: $0)) }
        rest.sort { lhs, rhs in
            let left = rank(lhs, interactions: interactions, now: now)
            let right = rank(rhs, interactions: interactions, now: now)
            if left.tier != right.tier { return left.tier < right.tier }
            if left.recency != right.recency { return left.recency > right.recency }
            return (lhs.name, lhs.id, lhs.machineID) < (rhs.name, rhs.id, rhs.machineID)
        }
        var iterator = rest.makeIterator()
        for index in slots.indices where slots[index] == nil { slots[index] = iterator.next() }
        return slots.compactMap { $0 }
    }

    /// Whether the person is writing, so the board should hold still: a composer has focus, or
    /// a tile that is on screen with a composer has text waiting. A draft of a tile that is
    /// gone or hidden does not count.
    public static func isWriting(hasFocus: Bool, drafts: [String: String], composerKeys: Set<String>) -> Bool {
        hasFocus || drafts.contains { composerKeys.contains($0.key) && !$0.value.isEmpty }
    }

    /// The slot each shown tile holds while the person writes; a repeated key keeps its first.
    public static func held(from order: [String]) -> [String: Int] {
        Dictionary(order.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
    }

    private static let payloadPrefix = "remi-board-tile:"

    /// What a tile drags: its key behind a prefix, so a drop can tell a tile from any other
    /// text (selected text dragged out of a composer, say).
    public static func payload(for key: String) -> String { payloadPrefix + key }

    /// The key a drag payload carries, or nil for text that is not a tile payload.
    public static func key(fromPayload payload: String) -> String? {
        guard payload.hasPrefix(payloadPrefix) else { return nil }
        let key = String(payload.dropFirst(payloadPrefix.count))
        return key.isEmpty ? nil : key
    }

    /// The sessions the board shows. Finished sessions stay off it (they are one search or the
    /// machine's list away) unless `showFinished` asks for them.
    public static func visible(
        _ sessions: [RemiSessionSummary], machineID: String?, onlyNeedsYou: Bool, showFinished: Bool
    ) -> [RemiSessionSummary] {
        sessions.filter { session in
            (showFinished || session.isLive)
                && (machineID == nil || session.machineID == machineID)
                && (!onlyNeedsYou || session.status == .needsYou)
        }
    }

    /// The latest entries a tile of this size shows, oldest first.
    public static func feed(_ entries: [RemiTranscriptEntry], size: RemiTileSize) -> [RemiTranscriptEntry] {
        Array(entries.suffix(size.feedEntries))
    }

    /// Packs tiles into columns in reading order: each goes under the shortest column so far
    /// (the left one on a tie), so tiles of different sizes leave no gaps. Returns the
    /// indices of `heights` in each column.
    public static func columns(heights: [CGFloat], count: Int, spacing: CGFloat = 12) -> [[Int]] {
        var result = [[Int]](repeating: [], count: max(count, 1))
        var filled = [CGFloat](repeating: 0, count: result.count)
        for (index, height) in heights.enumerated() {
            let column = filled.indices.min { (filled[$0], $0) < (filled[$1], $1) } ?? 0
            result[column].append(index)
            filled[column] += height + spacing
        }
        return result
    }

    /// The tile to move the cursor to after sending from `key`, wrapping at the end.
    public static func next(after key: String, in order: [String]) -> String? {
        guard !order.isEmpty else { return nil }
        guard let index = order.firstIndex(of: key) else { return order.first }
        let next = order[(index + 1) % order.count]
        return next == key ? nil : next
    }

    private static func rank(
        _ session: RemiSessionSummary, interactions: [String: Date], now: Date
    ) -> (tier: Int, recency: TimeInterval) {
        let activity = activityDate(session.lastActivity)?.timeIntervalSince1970 ?? 0
        if session.status == .needsYou { return (0, activity) }
        if let typed = interactions[key(for: session)], now.timeIntervalSince(typed) < interactionWindow {
            return (1, typed.timeIntervalSince1970)
        }
        switch session.status {
        case .working: return (2, activity)
        case .connecting: return (3, activity)
        case .idle: return (4, activity)
        case .offline, .needsYou: return (5, activity)
        }
    }

    // `ISO8601DateFormatter` is documented thread-safe for date(from:) and is never mutated
    // after these initializers, so sharing the two instances across threads is sound. Building
    // one per call was costly inside sort comparators.
    private nonisolated(unsafe) static let plainFormatter = ISO8601DateFormatter()
    private nonisolated(unsafe) static let fractionalFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    /// A session's `lastActivity` as a date, or nil when it has none or cannot be read.
    public static func activityDate(_ value: String?) -> Date? {
        guard let value else { return nil }
        return plainFormatter.date(from: value) ?? fractionalFormatter.date(from: value)
    }
}
