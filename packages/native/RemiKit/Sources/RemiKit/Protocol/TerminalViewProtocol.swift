import Foundation

/// Limits of ADR 0047, mirroring `TERMINAL_VIEW_LIMITS` in `packages/shared/src/terminal-view.ts`.
public enum TerminalViewLimits {
    public static let frameBytes = WireJSON.maxFrameBytes
    public static let textBytes = 32_768
    public static let cellBytes = 64
    public static let minimumColumns = 2
    public static let columns = 240
    public static let rows = 60
    public static let bindingBytes = WireGuards.bindingBytes
}

/// What a refused request was asking for.
public enum TerminalViewOperation: String, Sendable, Equatable, CaseIterable {
    case open = "session_terminal_open"
    case read = "session_terminal_read"
    case close = "session_terminal_close"
}

public enum TerminalViewRefusalCode: String, Sendable, Equatable, CaseIterable {
    case malformed
    case unavailable
    case busy
    case expired
    case bindingChanged = "binding_changed"
    case unsupportedScreen = "unsupported_screen"
}

/// Client to daemon: start a read-only view of the attached session's terminal.
public struct SessionTerminalOpen: Sendable, Equatable {
    public let header: WireHeader
    public let binding: AttachedBinding

    public init(header: WireHeader, binding: AttachedBinding) {
        self.header = header
        self.binding = binding
    }
}

/// Daemon to client: the view exists. Syntax grants no ownership or lease.
public struct SessionTerminalOpened: Sendable, Equatable {
    public let header: WireHeader
    public let requestId: String
    /// 16 random bytes, canonical unpadded base64url (22 characters).
    public let viewId: String
    public let expiresAt: String

    public init(header: WireHeader, requestId: String, viewId: String, expiresAt: String) {
        self.header = header
        self.requestId = requestId
        self.viewId = viewId
        self.expiresAt = expiresAt
    }
}

/// Client to daemon: `afterRevision` is nil for a first read.
public struct SessionTerminalRead: Sendable, Equatable {
    public let header: WireHeader
    public let viewId: String
    public let afterRevision: Int?

    public init(header: WireHeader, viewId: String, afterRevision: Int?) {
        self.header = header
        self.viewId = viewId
        self.afterRevision = afterRevision
    }
}

/// Zero-based cursor position inside the snapshot's geometry.
public struct TerminalCursor: Sendable, Equatable {
    public let row: Int
    public let column: Int

    public init(row: Int, column: Int) {
        self.row = row
        self.column = column
    }
}

/// A complete replacement screen: exactly `rows` lines of inert text.
public struct SessionTerminalSnapshot: Sendable, Equatable {
    public let header: WireHeader
    public let requestId: String
    public let viewId: String
    public let revision: Int
    public let columns: Int
    public let rows: Int
    public let lines: [String]
    /// Nil when the cursor is hidden.
    public let cursor: TerminalCursor?

    public init(
        header: WireHeader, requestId: String, viewId: String, revision: Int, columns: Int, rows: Int,
        lines: [String], cursor: TerminalCursor?
    ) {
        self.header = header
        self.requestId = requestId
        self.viewId = viewId
        self.revision = revision
        self.columns = columns
        self.rows = rows
        self.lines = lines
        self.cursor = cursor
    }
}

public struct SessionTerminalUnchanged: Sendable, Equatable {
    public let header: WireHeader
    public let requestId: String
    public let viewId: String
    public let revision: Int

    public init(header: WireHeader, requestId: String, viewId: String, revision: Int) {
        self.header = header
        self.requestId = requestId
        self.viewId = viewId
        self.revision = revision
    }
}

public struct SessionTerminalClose: Sendable, Equatable {
    public let header: WireHeader
    public let viewId: String

    public init(header: WireHeader, viewId: String) {
        self.header = header
        self.viewId = viewId
    }
}

public struct SessionTerminalClosed: Sendable, Equatable {
    public let header: WireHeader
    public let requestId: String
    public let viewId: String

    public init(header: WireHeader, requestId: String, viewId: String) {
        self.header = header
        self.requestId = requestId
        self.viewId = viewId
    }
}

/// A short correlated refusal; it carries no path, content or diagnostic.
public struct SessionTerminalRefused: Sendable, Equatable {
    public let header: WireHeader
    public let requestId: String
    public let operation: TerminalViewOperation
    public let code: TerminalViewRefusalCode

    public init(header: WireHeader, requestId: String, operation: TerminalViewOperation, code: TerminalViewRefusalCode) {
        self.header = header
        self.requestId = requestId
        self.operation = operation
        self.code = code
    }
}

/// The eight `session_terminal_*` messages (ADR 0047). Structural validity only: a valid frame
/// grants no authority, lease or revision freshness, and no daemon advertises `terminal_view` yet.
public enum TerminalViewMessage: Sendable, Equatable {
    case open(SessionTerminalOpen)
    case opened(SessionTerminalOpened)
    case read(SessionTerminalRead)
    case snapshot(SessionTerminalSnapshot)
    case unchanged(SessionTerminalUnchanged)
    case close(SessionTerminalClose)
    case closed(SessionTerminalClosed)
    case refused(SessionTerminalRefused)

    /// Strict decode of the original received bytes. Throws a payload-free `WireFrameError`.
    public static func decode(_ data: Data) throws -> TerminalViewMessage {
        try decode(json: try WireJSON.parse(data))
    }

    public static func decode(_ text: String) throws -> TerminalViewMessage {
        try decode(Data(text.utf8))
    }

    public static func decode(json: WireJSON) throws -> TerminalViewMessage {
        guard let type = wireType(json) else { throw WireFrameError.invalid("type") }
        func fields(_ response: Bool, _ rest: [String]) throws -> WireFields {
            try WireFields(json, keys: wireKeys(response: response, rest))
        }
        switch type {
        case "session_terminal_open":
            let f = try fields(false, ["binding"])
            return .open(SessionTerminalOpen(header: try f.header(), binding: try f.binding("binding")))
        case "session_terminal_opened":
            let f = try fields(true, ["viewId", "expiresAt"])
            return .opened(
                SessionTerminalOpened(
                    header: try f.header(), requestId: try f.uuid4("requestId"),
                    viewId: try f.encoded("viewId", bytes: 16...16), expiresAt: try f.timestamp("expiresAt")))
        case "session_terminal_read":
            let f = try fields(false, ["viewId", "afterRevision"])
            let after = try f.raw("afterRevision")
            return .read(
                SessionTerminalRead(
                    header: try f.header(), viewId: try f.encoded("viewId", bytes: 16...16),
                    afterRevision: after == .null
                        ? nil : try WireFields.integer(after, key: "afterRevision", in: 0...Self.maxSafeInteger)))
        case "session_terminal_close":
            let f = try fields(false, ["viewId"])
            return .close(SessionTerminalClose(header: try f.header(), viewId: try f.encoded("viewId", bytes: 16...16)))
        case "session_terminal_closed":
            let f = try fields(true, ["viewId"])
            return .closed(
                SessionTerminalClosed(
                    header: try f.header(), requestId: try f.uuid4("requestId"),
                    viewId: try f.encoded("viewId", bytes: 16...16)))
        case "session_terminal_unchanged":
            let f = try fields(true, ["viewId", "revision"])
            return .unchanged(
                SessionTerminalUnchanged(
                    header: try f.header(), requestId: try f.uuid4("requestId"),
                    viewId: try f.encoded("viewId", bytes: 16...16),
                    revision: try f.integer("revision", in: 0...Self.maxSafeInteger)))
        case "session_terminal_refused":
            let f = try fields(true, ["operation", "code"])
            return .refused(
                SessionTerminalRefused(
                    header: try f.header(), requestId: try f.uuid4("requestId"),
                    operation: try f.oneOf("operation", TerminalViewOperation.self),
                    code: try f.oneOf("code", TerminalViewRefusalCode.self)))
        case "session_terminal_snapshot":
            return .snapshot(try decodeSnapshot(json))
        default:
            throw WireFrameError.invalid("type")
        }
    }

    static let maxSafeInteger = 9_007_199_254_740_991

    private static func decodeSnapshot(_ json: WireJSON) throws -> SessionTerminalSnapshot {
        let f = try WireFields(
            json, keys: wireKeys(response: true, ["viewId", "revision", "columns", "rows", "lines", "cursor"]))
        let columns = try f.integer("columns", in: TerminalViewLimits.minimumColumns...TerminalViewLimits.columns)
        let rows = try f.integer("rows", in: 1...TerminalViewLimits.rows)
        guard case .array(let items) = try f.raw("lines"), items.count == rows else {
            throw WireFrameError.invalid("lines")
        }
        var lines: [String] = []
        var total = 0
        for item in items {
            guard case .string(let line) = item, !Self.containsUnsafeScreenText(line) else {
                throw WireFrameError.invalid("lines")
            }
            // A cell-storage upper bound, not a font or display-width calculation.
            let bytes = line.utf8.count
            total += bytes
            guard bytes <= columns * TerminalViewLimits.cellBytes, total <= TerminalViewLimits.textBytes else {
                throw WireFrameError.invalid("lines")
            }
            lines.append(line)
        }
        var cursor: TerminalCursor?
        let rawCursor = try f.raw("cursor")
        if rawCursor != .null {
            let c = try WireFields(rawCursor, keys: ["row", "column"])
            cursor = TerminalCursor(
                row: try c.integer("row", in: 0...(rows - 1)), column: try c.integer("column", in: 0...(columns - 1)))
        }
        return SessionTerminalSnapshot(
            header: try f.header(), requestId: try f.uuid4("requestId"),
            viewId: try f.encoded("viewId", bytes: 16...16),
            revision: try f.integer("revision", in: 0...maxSafeInteger), columns: columns, rows: rows, lines: lines,
            cursor: cursor)
    }

    /// Screen text is inert: no C0/C1/escape controls, row separators, bidi display controls or
    /// zero-width joiner.
    static func containsUnsafeScreenText(_ line: String) -> Bool {
        line.unicodeScalars.contains { scalar in
            switch scalar.value {
            case 0x00...0x1F, 0x7F...0x9F, 0x061C, 0x200D, 0x200E...0x200F, 0x2028...0x202E, 0x2066...0x2069:
                true
            default: false
            }
        }
    }

    public var json: WireJSON {
        func view(_ id: String) -> WireJSON { .string(id) }
        switch self {
        case .open(let m):
            return wireObject(type: "session_terminal_open", header: m.header, [("binding", m.binding.json)])
        case .opened(let m):
            return wireObject(
                type: "session_terminal_opened", header: m.header, requestId: m.requestId,
                [("viewId", view(m.viewId)), ("expiresAt", .string(m.expiresAt))])
        case .read(let m):
            return wireObject(
                type: "session_terminal_read", header: m.header,
                [("viewId", view(m.viewId)), ("afterRevision", m.afterRevision.map { .number(Double($0)) } ?? .null)])
        case .snapshot(let m):
            return wireObject(
                type: "session_terminal_snapshot", header: m.header, requestId: m.requestId,
                [
                    ("viewId", view(m.viewId)), ("revision", .number(Double(m.revision))),
                    ("columns", .number(Double(m.columns))), ("rows", .number(Double(m.rows))),
                    ("lines", .array(m.lines.map { .string($0) })),
                    (
                        "cursor",
                        m.cursor.map {
                            .object(
                                WireObject(members: [
                                    .init(key: "row", value: .number(Double($0.row))),
                                    .init(key: "column", value: .number(Double($0.column))),
                                ]))
                        } ?? .null
                    ),
                ])
        case .unchanged(let m):
            return wireObject(
                type: "session_terminal_unchanged", header: m.header, requestId: m.requestId,
                [("viewId", view(m.viewId)), ("revision", .number(Double(m.revision)))])
        case .close(let m):
            return wireObject(type: "session_terminal_close", header: m.header, [("viewId", view(m.viewId))])
        case .closed(let m):
            return wireObject(
                type: "session_terminal_closed", header: m.header, requestId: m.requestId, [("viewId", view(m.viewId))])
        case .refused(let m):
            return wireObject(
                type: "session_terminal_refused", header: m.header, requestId: m.requestId,
                [("operation", .string(m.operation.rawValue)), ("code", .string(m.code.rawValue))])
        }
    }

    /// The frame text, or `WireFrameError.invalid("frame")` when this value would not survive the strict decoder.
    ///
    /// The round-trip check uses `==`, which compares `String` by canonical equivalence, so it
    /// proves shape, not scalar identity: never use `==` on these models to compare identifiers
    /// (use `WireGuards.same`, which compares UTF-8 bytes).
    public func encodedFrame() throws -> String {
        let text = json.serialized()
        guard let decoded = try? Self.decode(text), decoded == self else { throw WireFrameError.invalid("frame") }
        return text
    }
}
