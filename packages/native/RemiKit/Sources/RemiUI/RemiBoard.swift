import CoreGraphics
import Foundation

/// A tile's position and size on the Mac command center's freeform canvas.
///
/// Frames are stored only after a person moves or resizes a tile. Automatic placements are
/// derived from the current session order, so older board values remain readable and new
/// sessions still get a useful default layout.
public struct RemiBoardFrame: Codable, Equatable, Sendable {
    public static let minimumWidth: CGFloat = 340
    public static let minimumHeight: CGFloat = 260
    public static let maximumWidth: CGFloat = 1_200
    public static let maximumHeight: CGFloat = 1_000
    /// A stored coordinate beyond this point is treated as damaged rather than expanding the canvas.
    public static let maximumCoordinate: CGFloat = 100_000

    public var x: CGFloat
    public var y: CGFloat
    public var width: CGFloat
    public var height: CGFloat

    public init(x: CGFloat, y: CGFloat, width: CGFloat, height: CGFloat) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    public var maxX: CGFloat { x + width }
    public var maxY: CGFloat { y + height }

    /// Whether this frame is safe to display or persist.
    public var isValid: Bool {
        x.isFinite && y.isFinite && width.isFinite && height.isFinite
            && x >= 0 && y >= 0 && x <= Self.maximumCoordinate && y <= Self.maximumCoordinate
            && width >= Self.minimumWidth && width <= Self.maximumWidth
            && height >= Self.minimumHeight && height <= Self.maximumHeight
            && maxX.isFinite && maxY.isFinite
            && maxX <= Self.maximumCoordinate && maxY <= Self.maximumCoordinate
    }

    /// A proposed move. The caller validates the result so a drag can show an invalid preview.
    public func moved(by translation: CGSize) -> Self {
        Self(x: x + translation.width, y: y + translation.height, width: width, height: height)
    }

    /// Keep the whole card on the canvas while allowing direct movement over other cards.
    public func constrainedMove(by translation: CGSize) -> Self {
        guard translation.width.isFinite, translation.height.isFinite else { return self }
        return Self(
            x: min(max(x + translation.width, 0), Self.maximumCoordinate - width),
            y: min(max(y + translation.height, 0), Self.maximumCoordinate - height),
            width: width, height: height
        )
    }

    /// Settle onto nearby card edges, or the board grid when no edge is close.
    public func snappedMove(otherFrames: [Self], gap: CGFloat = 12, grid: CGFloat = 24, margin: CGFloat = 16) -> Self {
        guard isValid, grid.isFinite, grid > 0, margin.isFinite, gap.isFinite else { return self }
        let valid = otherFrames.filter(\.isValid)
        let xs = valid.filter { y <= $0.maxY + gap + 10 && maxY + gap + 10 >= $0.y }
            .flatMap { [$0.x, $0.maxX + gap, $0.x - gap - width, $0.maxX - width] }
        let ys = valid.filter { x <= $0.maxX + gap + 10 && maxX + gap + 10 >= $0.x }
            .flatMap { [$0.y, $0.maxY + gap, $0.y - gap - height, $0.maxY - height] }
        func snap(_ value: CGFloat, candidates: [CGFloat], maximum: CGFloat) -> CGFloat {
            let nearby = candidates.filter { $0 >= 0 && $0 <= maximum && abs($0 - value) <= 10 }
            if let closest = nearby.min(by: { (abs($0 - value), $0) < (abs($1 - value), $1) }) { return closest }
            return min(max(((value - margin) / grid).rounded() * grid + margin, 0), maximum)
        }
        return Self(x: snap(x, candidates: xs, maximum: Self.maximumCoordinate - width),
                    y: snap(y, candidates: ys, maximum: Self.maximumCoordinate - height),
                    width: width, height: height)
    }

    /// A proposed resize, keeping the top-left corner fixed and clamping both dimensions.
    public func resized(by translation: CGSize) -> Self {
        guard translation.width.isFinite, translation.height.isFinite else { return self }
        return Self(
            x: x,
            y: y,
            width: min(max(width + translation.width, Self.minimumWidth), min(Self.maximumWidth, Self.maximumCoordinate - x)),
            height: min(max(height + translation.height, Self.minimumHeight), min(Self.maximumHeight, Self.maximumCoordinate - y))
        )
    }

    /// A top-right resize keeps the lower-left corner in place, like a window.
    public func resizedFromTopRight(by translation: CGSize) -> Self {
        guard translation.width.isFinite, translation.height.isFinite else { return self }
        let newWidth = min(max(width + translation.width, Self.minimumWidth),
                           min(Self.maximumWidth, Self.maximumCoordinate - x))
        let newHeight = min(max(height - translation.height, Self.minimumHeight),
                            min(Self.maximumHeight, maxY))
        return Self(x: x, y: maxY - newHeight, width: newWidth, height: newHeight)
    }

    /// Snap only the moving edges; the opposite corner remains fixed.
    public func snappedResize(topRight: Bool, otherFrames: [Self], gap: CGFloat = 12,
                              grid: CGFloat = 24, margin: CGFloat = 16) -> Self {
        guard isValid, grid.isFinite, grid > 0, margin.isFinite, gap.isFinite else { return self }
        let valid = otherFrames.filter(\.isValid)
        let xs = valid.flatMap { [$0.x, $0.maxX, $0.x - gap, $0.maxX + gap] }
        let ys = valid.flatMap { [$0.y, $0.maxY, $0.y - gap, $0.maxY + gap] }
        func snap(_ value: CGFloat, candidates: [CGFloat], minimum: CGFloat, maximum: CGFloat) -> CGFloat {
            let nearby = candidates.filter { $0 >= minimum && $0 <= maximum && abs($0 - value) <= 10 }
            if let closest = nearby.min(by: { (abs($0 - value), $0) < (abs($1 - value), $1) }) { return closest }
            return min(max(((value - margin) / grid).rounded() * grid + margin, minimum), maximum)
        }
        let right = snap(maxX, candidates: xs, minimum: x + Self.minimumWidth,
                         maximum: min(x + Self.maximumWidth, Self.maximumCoordinate))
        let presets = [RemiTileSize.compact, .regular, .large].map(\.estimatedHeight)
        let nearbyPreset = presets.filter { abs($0 - height) <= 10 }.min { abs($0 - height) < abs($1 - height) }
        if topRight {
            if let preset = nearbyPreset, preset <= maxY {
                return Self(x: x, y: maxY - preset, width: right - x, height: preset)
            }
            let top = snap(y, candidates: ys, minimum: max(0, maxY - Self.maximumHeight),
                           maximum: maxY - Self.minimumHeight)
            return Self(x: x, y: top, width: right - x, height: maxY - top)
        }
        if let preset = nearbyPreset, y + preset <= Self.maximumCoordinate {
            return Self(x: x, y: y, width: right - x, height: preset)
        }
        let bottom = snap(maxY, candidates: ys, minimum: y + Self.minimumHeight,
                          maximum: min(y + Self.maximumHeight, Self.maximumCoordinate))
        return Self(x: x, y: y, width: right - x, height: bottom - y)
    }

    /// Cards may touch, but any positive-area intersection is a collision.
    public func intersects(_ other: Self) -> Bool {
        x < other.maxX && maxX > other.x && y < other.maxY && maxY > other.y
    }
}

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
        let size = RemiTileSize(storedDensity: stored)
        return phoneDensities.contains(size) ? size : .regular
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

/// What the person arranged on a board: legacy pinned slots and sizes, plus explicit Mac frames.
/// Automatic positions are computed by ``RemiBoardOrder`` and are not written to storage.
///
/// Mac stores a pin's slot in the full board order, even when a filter hides other tiles.
public struct RemiBoardState: Codable, Equatable, Sendable {
    private var pinnedSlots: [String: Int] = [:]
    private var sizes: [String: RemiTileSize] = [:]
    private var frames: [String: RemiBoardFrame] = [:]

    private enum CodingKeys: String, CodingKey {
        case pinnedSlots
        case sizes
        case frames
    }

    public init() {}

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        pinnedSlots = Self.decodeValues(Int.self, in: container, forKey: .pinnedSlots)
            .mapValues { max(0, $0) }
        sizes = Self.decodeValues(RemiTileSize.self, in: container, forKey: .sizes)
        // Decode each frame independently. One bad tile must not discard valid frames, pins or
        // preset sizes from the rest of the stored board.
        frames = Self.decodeValues(RemiBoardFrame.self, in: container, forKey: .frames)
            .filter { $0.value.isValid }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(pinnedSlots, forKey: .pinnedSlots)
        try container.encode(sizes, forKey: .sizes)
        if !frames.isEmpty { try container.encode(frames, forKey: .frames) }
    }

    private struct DynamicCodingKey: CodingKey {
        let stringValue: String
        let intValue: Int? = nil

        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }

    private static func decodeValues<Value: Decodable>(
        _ type: Value.Type,
        in container: KeyedDecodingContainer<CodingKeys>,
        forKey key: CodingKeys
    ) -> [String: Value] {
        guard let values = try? container.nestedContainer(keyedBy: DynamicCodingKey.self, forKey: key) else {
            return [:]
        }
        var decoded: [String: Value] = [:]
        for valueKey in values.allKeys {
            if let value = try? values.decode(type, forKey: valueKey) {
                decoded[valueKey.stringValue] = value
            }
        }
        return decoded
    }

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

    public var savedFrames: [String: RemiBoardFrame] { frames }
    public func frame(for key: String) -> RemiBoardFrame? { frames[key] }

    /// Stores a frame only when it is finite, in bounds, and within the supported dimensions.
    @discardableResult
    public mutating func setFrame(_ frame: RemiBoardFrame, for key: String) -> Bool {
        guard frame.isValid, !key.isEmpty else { return false }
        frames[key] = frame
        return true
    }

    public mutating func clearFrame(for key: String) { frames[key] = nil }

    /// Clears manual frames and legacy pins/sizes to restore the automatic layout.
    public mutating func resetLayout() {
        pinnedSlots.removeAll()
        sizes.removeAll()
        frames.removeAll()
    }

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
        let before = (pinnedSlots.count, sizes.count, frames.count)
        pinnedSlots = pinnedSlots.filter { !gone($0.key) }
        sizes = sizes.filter { !gone($0.key) }
        frames = frames.filter { !gone($0.key) }
        return before != (pinnedSlots.count, sizes.count, frames.count)
    }
}

/// Columns, automatic order and focus order for the command center board.
public enum RemiBoardOrder {
    public static let maximumColumns = 6
    public static let defaultTileWidth = RemiBoardFrame.minimumWidth
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

    /// The entries of a per-tile dictionary (drafts, interactions) that should stay. A tile's entry
    /// goes only when its session is gone from a machine that has settled: while a machine
    /// reconnects its sessions may not be listed yet, and an unsent draft must not be lost for that.
    public static func keeping<Value>(
        _ entries: [String: Value], live: Set<String>, settledMachines: Set<String>
    ) -> [String: Value] {
        entries.filter { live.contains($0.key) || !settledMachines.contains(machineID(ofKey: $0.key)) }
    }

    /// The board's order. Pinned tiles keep their slots, and so do `held` tiles (one whose
    /// composer is in use keeps the slot it has now, so it never jumps under the cursor).
    /// The rest are ordered by how much they need the person: a question first, then a tile
    /// the person typed into recently, then working, idle and offline; newer activity first
    /// within each, then by name. A pinned or held slot is an index into `sessions` as passed;
    /// one past the end takes a place from the end, in its relative order. Mac passes the full
    /// session list and filters the resulting order for display.
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

    /// Places sessions on a two-dimensional canvas. Saved frames, including hidden sessions and
    /// sessions missing from an unsettled machine, reserve their space before automatic tiles are
    /// placed. Legacy pins still determine the initial automatic order and preset sizes determine
    /// their initial heights.
    public static func layout(
        _ sessions: [RemiSessionSummary],
        state: RemiBoardState,
        interactions: [String: Date],
        held: [String: Int] = [:],
        now: Date,
        viewportWidth: CGFloat,
        spacing: CGFloat = 12,
        margin: CGFloat = 16
    ) -> [String: RemiBoardFrame] {
        let ordered = arrange(sessions, state: state, interactions: interactions, held: held, now: now)
        let orderedKeys = ordered.map(key(for:))
        let orderRank = Dictionary(uniqueKeysWithValues: orderedKeys.enumerated().map { ($1, $0) })
        let savedKeys = state.savedFrames.keys.sorted {
            (orderRank[$0] ?? .max, $0) < (orderRank[$1] ?? .max, $1)
        }

        var result: [String: RemiBoardFrame] = [:]
        var occupied: [RemiBoardFrame] = []
        for savedKey in savedKeys {
            guard let frame = state.frame(for: savedKey), frame.isValid,
                  let placed = nearestAvailable(frame, occupied: occupied, spacing: spacing) else { continue }
            result[savedKey] = placed
            occupied.append(placed)
        }

        let availableWidth = max(0, viewportWidth - 2 * margin)
        let columnCount = Self.columnCount(
            width: availableWidth,
            minimumTile: defaultTileWidth,
            spacing: spacing
        )
        var columnBottoms = [CGFloat](repeating: margin, count: columnCount)

        for session in ordered {
            let tileKey = key(for: session)
            guard result[tileKey] == nil else { continue }
            let width = defaultTileWidth
            let height = max(RemiBoardFrame.minimumHeight, state.size(for: tileKey).estimatedHeight)
            var candidates: [(frame: RemiBoardFrame, column: Int)] = []
            for column in columnBottoms.indices {
                let x = margin + CGFloat(column) * (width + spacing)
                var y = columnBottoms[column]
                var frame = RemiBoardFrame(x: x, y: y, width: width, height: height)
                while frame.isValid {
                    let collisions = occupied.filter { frame.intersects($0) }
                    guard !collisions.isEmpty else { break }
                    y = collisions.map(\.maxY).max()! + spacing
                    frame = RemiBoardFrame(x: x, y: y, width: width, height: height)
                }
                if frame.isValid { candidates.append((frame, column)) }
            }
            guard let placement = candidates.min(by: {
                ($0.frame.y, $0.frame.x) < ($1.frame.y, $1.frame.x)
            }) else { continue }
            result[tileKey] = placement.frame
            occupied.append(placement.frame)
            columnBottoms[placement.column] = placement.frame.maxY + spacing
        }
        return result
    }

    /// Move only the cards touched by a proposed frame, keeping the rest in place.
    /// Every candidate is recomputed from the gesture's original frames, so dragging back
    /// restores neighbors instead of accumulating displacement on every pointer update.
    public static func reflow(moving key: String, to proposal: RemiBoardFrame,
                              in frames: [String: RemiBoardFrame], spacing: CGFloat = 12) -> [String: RemiBoardFrame]? {
        guard proposal.isValid, frames[key] != nil, spacing.isFinite, spacing >= 0,
              frames.values.allSatisfy(\.isValid) else { return nil }
        let otherKeys = frames.keys.filter { $0 != key }.sorted()
        let untouched = otherKeys.filter { !frames[$0]!.intersects(proposal) }
        let affected = otherKeys.filter { frames[$0]!.intersects(proposal) }
        var result = frames
        result[key] = proposal
        var occupied = [proposal] + untouched.compactMap { frames[$0] }
        for other in affected {
            guard let original = frames[other], let placed = nearestAvailable(original, occupied: occupied, spacing: spacing) else {
                return nil
            }
            result[other] = placed
            occupied.append(placed)
        }
        return result
    }

    /// Find the nearest open position along a horizontal or vertical axis. Each step jumps
    /// beyond at least one blocker and the bounded canvas provides a finite failure case.
    private static func nearestAvailable(_ original: RemiBoardFrame, occupied: [RemiBoardFrame],
                                         spacing: CGFloat) -> RemiBoardFrame? {
        guard original.isValid, spacing.isFinite, spacing >= 0 else { return nil }
        guard occupied.contains(where: { original.intersects($0) }) else { return original }
        var candidates: [RemiBoardFrame] = []
        for direction in 0..<4 {
            var candidate = original
            for _ in 0...occupied.count {
                let blockers = occupied.filter { candidate.intersects($0) }
                if blockers.isEmpty { candidates.append(candidate); break }
                switch direction {
                case 0: candidate.x = blockers.map(\.maxX).max()! + spacing
                case 1: candidate.x = blockers.map(\.x).min()! - spacing - candidate.width
                case 2: candidate.y = blockers.map(\.maxY).max()! + spacing
                default: candidate.y = blockers.map(\.y).min()! - spacing - candidate.height
                }
                if !candidate.isValid { break }
            }
        }
        // A free corner can exist even when all four straight paths hit a canvas edge.
        if let bottom = occupied.map(\.maxY).max(), let right = occupied.map(\.maxX).max() {
            let below = RemiBoardFrame(x: 0, y: bottom + spacing, width: original.width, height: original.height)
            let beside = RemiBoardFrame(x: right + spacing, y: 0, width: original.width, height: original.height)
            if below.isValid && !occupied.contains(where: { below.intersects($0) }) { candidates.append(below) }
            if beside.isValid && !occupied.contains(where: { beside.intersects($0) }) { candidates.append(beside) }
        }
        return candidates.min {
            let left = abs($0.x - original.x) + abs($0.y - original.y)
            let right = abs($1.x - original.x) + abs($1.y - original.y)
            return (left, $0.y, $0.x) < (right, $1.y, $1.x)
        }
    }

    /// The canvas fits every visible frame and at least the current viewport.
    public static func canvasSize(
        visibleFrames: [String: RemiBoardFrame],
        viewport: CGSize,
        margin: CGFloat = 16
    ) -> CGSize {
        let width = visibleFrames.values.map(\.maxX).max().map { $0 + margin } ?? viewport.width
        let height = visibleFrames.values.map(\.maxY).max().map { $0 + margin } ?? viewport.height
        return CGSize(width: max(viewport.width, width), height: max(viewport.height, height))
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
