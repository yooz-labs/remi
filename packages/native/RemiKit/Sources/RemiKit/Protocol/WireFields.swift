import Foundation

/// Field guards shared by the strict codecs, mirroring `packages/shared/src/image-wire.ts`.
/// Shape validity grants no authority: every guard here is syntax only.
enum WireGuards {
    static let bindingBytes = 200

    static func isLowercaseHex(_ scalar: Unicode.Scalar) -> Bool {
        (0x30...0x39).contains(scalar.value) || (0x61...0x66).contains(scalar.value)
    }

    /// Lowercase canonical UUID (any version), 8-4-4-4-12.
    static func isUUID(_ text: String) -> Bool {
        let scalars = Array(text.unicodeScalars)
        guard scalars.count == 36 else { return false }
        for (index, scalar) in scalars.enumerated() {
            if [8, 13, 18, 23].contains(index) {
                if scalar != "-" { return false }
            } else if !isLowercaseHex(scalar) {
                return false
            }
        }
        return true
    }

    /// Lowercase canonical UUID version 4 with an RFC 4122 variant.
    static func isUUID4(_ text: String) -> Bool {
        guard isUUID(text) else { return false }
        let scalars = Array(text.unicodeScalars)
        return scalars[14] == "4" && ["8", "9", "a", "b"].contains(scalars[19])
    }

    /// A real UTC instant in the exact 24-character `YYYY-MM-DDTHH:mm:ss.sssZ` spelling.
    static func isTimestamp(_ text: String) -> Bool {
        let bytes = Array(text.utf8)
        guard bytes.count == 24 else { return false }
        let separators: [Int: UInt8] = [4: 0x2D, 7: 0x2D, 10: 0x54, 13: 0x3A, 16: 0x3A, 19: 0x2E, 23: 0x5A]
        for index in 0..<24 {
            if let separator = separators[index] {
                if bytes[index] != separator { return false }
            } else if !(0x30...0x39).contains(bytes[index]) {
                return false
            }
        }
        func number(_ range: Range<Int>) -> Int { range.reduce(0) { $0 * 10 + Int(bytes[$1] - 0x30) } }
        let year = number(0..<4)
        let month = number(5..<7)
        let day = number(8..<10)
        guard (1...12).contains(month), number(11..<13) < 24, number(14..<16) < 60, number(17..<19) < 60 else {
            return false
        }
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
        let days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
        return (1...days).contains(day)
    }

    private static let base64URLAlphabet = Set(
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".unicodeScalars)

    /// Canonical unpadded base64url: the alphabet only, no stray trailing bits, or nil.
    static func decodeBase64URL(_ text: String) -> Data? {
        let scalars = text.unicodeScalars
        guard scalars.allSatisfy({ base64URLAlphabet.contains($0) }), scalars.count % 4 != 1 else { return nil }
        var standard = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        standard += String(repeating: "=", count: (4 - standard.utf8.count % 4) % 4)
        guard let data = Data(base64Encoded: standard), encodeBase64URL(data) == text else { return nil }
        return data
    }

    static func encodeBase64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Nonempty scalar text of at most 200 UTF-8 bytes with no C0/C1 control.
    static func isHarnessSessionId(_ text: String) -> Bool {
        !text.isEmpty && text.utf8.count <= bindingBytes
            && !text.unicodeScalars.contains { $0.value <= 0x1F || (0x7F...0x9F).contains($0.value) }
    }

    /// Byte comparison, never Swift's canonical equivalence (U+212A equals "K" there).
    static func same(_ left: String, _ right: String) -> Bool { left.utf8.elementsEqual(right.utf8) }
}

/// The harness a session is attached to (ADR 0045, 0047). Image operations accept `claude` only.
public enum AttachedHarness: String, Sendable, Equatable, CaseIterable {
    case claude
    case codex
}

/// `{harness, harnessSessionId}`: the live binding a request names. The id is opaque, not a UUID.
public struct AttachedBinding: Sendable, Equatable {
    public let harness: AttachedHarness
    public let harnessSessionId: String

    public init(harness: AttachedHarness, harnessSessionId: String) {
        self.harness = harness
        self.harnessSessionId = harnessSessionId
    }

    var json: WireJSON {
        .object(WireObject(members: [
            .init(key: "harness", value: .string(harness.rawValue)),
            .init(key: "harnessSessionId", value: .string(harnessSessionId)),
        ]))
    }
}

/// The part every frame shares: `id`, `timestamp` and `sessionId` (`type` is the case).
public struct WireHeader: Sendable, Equatable {
    public let id: String
    public let timestamp: String
    public let sessionId: String

    public init(id: String, timestamp: String, sessionId: String) {
        self.id = id
        self.timestamp = timestamp
        self.sessionId = sessionId
    }
}

/// Reads one object's fields with the family's exact-shape rules: the key set must match
/// exactly (no missing, unknown or duplicate member) and each accessor validates its encoding.
struct WireFields {
    let object: WireObject

    init(_ value: WireJSON, keys: [String]) throws {
        guard let object = value.objectValue, object.hasExactly(keys) else {
            throw WireFrameError.invalid("shape")
        }
        self.object = object
    }

    private func member(_ key: String) throws -> WireJSON {
        guard let value = object.value(for: key) else { throw WireFrameError.invalid(key) }
        return value
    }

    func raw(_ key: String) throws -> WireJSON { try member(key) }

    func string(_ key: String) throws -> String {
        guard case .string(let value) = try member(key) else { throw WireFrameError.invalid(key) }
        return value
    }

    func uuid4(_ key: String) throws -> String {
        let value = try string(key)
        guard WireGuards.isUUID4(value) else { throw WireFrameError.invalid(key) }
        return value
    }

    func uuid(_ key: String) throws -> String {
        let value = try string(key)
        guard WireGuards.isUUID(value) else { throw WireFrameError.invalid(key) }
        return value
    }

    func timestamp(_ key: String) throws -> String {
        let value = try string(key)
        guard WireGuards.isTimestamp(value) else { throw WireFrameError.invalid(key) }
        return value
    }

    /// Canonical unpadded base64url whose decoded size is within `bytes`.
    func encoded(_ key: String, bytes: ClosedRange<Int>) throws -> String {
        let value = try string(key)
        guard value.utf8.count <= (bytes.upperBound * 4 + 2) / 3,
            let data = WireGuards.decodeBase64URL(value), bytes.contains(data.count)
        else { throw WireFrameError.invalid(key) }
        return value
    }

    func integer(_ key: String, in range: ClosedRange<Int>) throws -> Int {
        try Self.integer(try member(key), key: key, in: range)
    }

    static func integer(_ value: WireJSON, key: String, in range: ClosedRange<Int>) throws -> Int {
        // The JavaScript rule: a number whose value is a safe integer, so 2.0 and 2e0 count.
        guard case .number(let number) = value, number.isFinite, number == number.rounded(),
            abs(number) <= 9_007_199_254_740_991, range.contains(Int(number))
        else { throw WireFrameError.invalid(key) }
        return Int(number)
    }

    func oneOf<T: RawRepresentable>(_ key: String, _ type: T.Type) throws -> T where T.RawValue == String, T: CaseIterable {
        let value = try string(key)
        guard let match = T.allCases.first(where: { WireGuards.same($0.rawValue, value) }) else {
            throw WireFrameError.invalid(key)
        }
        return match
    }

    func binding(_ key: String, claudeOnly: Bool = false) throws -> AttachedBinding {
        let fields = try WireFields(try member(key), keys: ["harness", "harnessSessionId"])
        let harness = try fields.oneOf("harness", AttachedHarness.self)
        let sessionId = try fields.string("harnessSessionId")
        guard WireGuards.isHarnessSessionId(sessionId), !claudeOnly || harness == .claude else {
            throw WireFrameError.invalid(key)
        }
        return AttachedBinding(harness: harness, harnessSessionId: sessionId)
    }

    /// `type` (already matched by the caller) plus `id`, `timestamp`, `sessionId`.
    func header() throws -> WireHeader {
        WireHeader(id: try uuid4("id"), timestamp: try timestamp("timestamp"), sessionId: try uuid("sessionId"))
    }
}

/// Builds an object from `type`, the header and the family's own members, in a fixed order.
func wireObject(type: String, header: WireHeader, requestId: String? = nil, _ rest: [(String, WireJSON)]) -> WireJSON {
    var members: [WireObject.Member] = [
        .init(key: "type", value: .string(type)),
        .init(key: "id", value: .string(header.id)),
        .init(key: "timestamp", value: .string(header.timestamp)),
        .init(key: "sessionId", value: .string(header.sessionId)),
    ]
    if let requestId { members.append(.init(key: "requestId", value: .string(requestId))) }
    members += rest.map { .init(key: $0.0, value: $0.1) }
    return .object(WireObject(members: members))
}

/// The frame keys every family message carries before its own fields.
func wireKeys(response: Bool, _ rest: [String]) -> [String] {
    ["type", "id", "timestamp", "sessionId"] + (response ? ["requestId"] : []) + rest
}

func wireType(_ value: WireJSON) -> String? {
    guard let object = value.objectValue, case .string(let type)? = object.value(for: "type") else { return nil }
    return type
}
