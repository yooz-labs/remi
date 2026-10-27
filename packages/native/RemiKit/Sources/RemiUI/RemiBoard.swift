import CoreGraphics
import Foundation

/// How much of a session a board tile shows.
public enum RemiTileSize: String, Codable, CaseIterable, Sendable {
    case compact, regular, large

    /// Lines of the latest message the tile shows.
    public var messageLines: Int {
        switch self {
        case .compact: 2
        case .regular: 6
        case .large: 16
        }
    }
}

/// What the person arranged on the command center board: tiles they pinned to a slot, and
/// the size each tile has. Everything else is ordered automatically (``RemiBoardOrder``).
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

    /// Forgets tiles for sessions that no longer exist.
    public mutating func prune(keeping live: Set<String>) {
        pinnedSlots = pinnedSlots.filter { live.contains($0.key) }
        sizes = sizes.filter { live.contains($0.key) }
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

    /// The board's order. Pinned tiles keep their slots, and so do `held` tiles (one whose
    /// composer is in use keeps the slot it has now, so it never jumps under the cursor).
    /// The rest are ordered by how much they need the person: a question first, then a tile
    /// the person typed into recently, then working, idle and offline; newer activity first
    /// within each, then by name.
    public static func arrange(
        _ sessions: [RemiSessionSummary],
        state: RemiBoardState,
        interactions: [String: Date],
        held: [String: Int],
        now: Date
    ) -> [RemiSessionSummary] {
        let count = sessions.count
        guard count > 0 else { return [] }
        let byKey = Dictionary(sessions.map { (key(for: $0), $0) }, uniquingKeysWith: { first, _ in first })

        var wanted: [(key: String, slot: Int)] = []
        for (key, slot) in held where byKey[key] != nil { wanted.append((key, slot)) }
        for key in state.pinnedKeys where byKey[key] != nil && held[key] == nil {
            wanted.append((key, state.slot(of: key) ?? 0))
        }
        wanted.sort { ($0.slot, $0.key) < ($1.slot, $1.key) }

        var slots = [RemiSessionSummary?](repeating: nil, count: count)
        var placed = Set<String>()
        for item in wanted {
            guard let session = byKey[item.key] else { continue }
            var index = min(item.slot, count - 1)
            if slots[index] != nil {
                // Take the next free slot forward, else the nearest one behind.
                index = (index..<count).first { slots[$0] == nil } ?? (0..<index).last { slots[$0] == nil } ?? index
            }
            guard slots[index] == nil else { continue }
            slots[index] = session
            placed.insert(item.key)
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
        let activity = date(session.lastActivity)?.timeIntervalSince1970 ?? 0
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

    private static func date(_ value: String?) -> Date? {
        guard let value else { return nil }
        let plain = ISO8601DateFormatter()
        if let parsed = plain.date(from: value) { return parsed }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value)
    }
}
