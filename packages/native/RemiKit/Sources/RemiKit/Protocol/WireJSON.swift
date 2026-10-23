import Foundation

/// A parsed JSON value that kept what `JSONDecoder` throws away: every object member in
/// order, so a duplicate member is a refusal rather than "last one wins".
///
/// The strict frame codecs (terminal view, file fetch, image upload and insertion) parse the
/// original received bytes with `WireJSON.parse`, mirroring `parseStrictJson` and
/// `imageWireValue` in `packages/shared/src`: at most 65,536 bytes, valid UTF-8, no duplicate
/// member at any depth (compared by decoded scalars, never by Swift's canonical equivalence),
/// no escaped lone surrogate, nesting depth at most 8 and at most 512 values.
public indirect enum WireJSON: Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([WireJSON])
    case object(WireObject)

    /// The most bytes of one frame (ADR 0041, 0045, 0047).
    public static let maxFrameBytes = 65_536
    static let maxDepth = 8
    public static let maxNodes = 512

    /// Parses `data` as one JSON value, or throws a payload-free `WireFrameError`.
    ///
    /// `maxBytes` and `maxNodes` exist for reading large trusted files (the shared vector corpora)
    /// with the same grammar; a frame uses the defaults.
    public static func parse(_ data: Data, maxBytes: Int = maxFrameBytes, maxNodes: Int = maxNodes) throws -> WireJSON {
        guard data.count <= maxBytes else { throw WireFrameError.oversize }
        let bytes = [UInt8](data)
        // Invalid UTF-8 is refused before anything is read from it.
        guard String(validating: bytes, as: UTF8.self) != nil else { throw WireFrameError.malformedJSON }
        var parser = Parser(bytes: bytes, maxNodes: maxNodes)
        return try parser.parseDocument()
    }

    public static func parse(_ text: String, maxBytes: Int = maxFrameBytes) throws -> WireJSON {
        try parse(Data(text.utf8), maxBytes: maxBytes)
    }

    /// Compact JSON text. Integral numbers within the safe range print without a fraction.
    public func serialized() -> String {
        var output = ""
        write(into: &output)
        return output
    }

    var objectValue: WireObject? {
        if case .object(let object) = self { return object }
        return nil
    }

    private func write(into output: inout String) {
        switch self {
        case .null: output += "null"
        case .bool(let value): output += value ? "true" : "false"
        case .number(let value):
            if value == value.rounded(), abs(value) <= 9_007_199_254_740_991 {
                output += String(Int64(value))
            } else {
                output += String(value)
            }
        case .string(let value): Self.writeString(value, into: &output)
        case .array(let items):
            output += "["
            for (index, item) in items.enumerated() {
                if index > 0 { output += "," }
                item.write(into: &output)
            }
            output += "]"
        case .object(let object):
            output += "{"
            for (index, member) in object.members.enumerated() {
                if index > 0 { output += "," }
                Self.writeString(member.key, into: &output)
                output += ":"
                member.value.write(into: &output)
            }
            output += "}"
        }
    }

    private static func writeString(_ value: String, into output: inout String) {
        output += "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": output += "\\\""
            case "\\": output += "\\\\"
            case "\n": output += "\\n"
            case "\r": output += "\\r"
            case "\t": output += "\\t"
            default:
                if scalar.value < 0x20 {
                    output += String(format: "\\u%04x", scalar.value)
                } else {
                    output.unicodeScalars.append(scalar)
                }
            }
        }
        output += "\""
    }

    private struct Parser {
        let bytes: [UInt8]
        var at = 0
        var nodes = 0
        let maxNodes: Int

        init(bytes: [UInt8], maxNodes: Int) {
            self.bytes = bytes
            self.maxNodes = maxNodes
        }

        mutating func parseDocument() throws -> WireJSON {
            let value = try parseValue(depth: 0)
            skipWhitespace()
            guard at == bytes.count else { throw WireFrameError.malformedJSON }
            return value
        }

        mutating func skipWhitespace() {
            while at < bytes.count, [0x20, 0x09, 0x0A, 0x0D].contains(bytes[at]) { at += 1 }
        }

        mutating func parseValue(depth: Int) throws -> WireJSON {
            nodes += 1
            guard depth <= WireJSON.maxDepth, nodes <= maxNodes else { throw WireFrameError.malformedJSON }
            skipWhitespace()
            guard at < bytes.count else { throw WireFrameError.malformedJSON }
            switch bytes[at] {
            case UInt8(ascii: "\""): return .string(try parseString())
            case UInt8(ascii: "{"): return try parseObject(depth: depth)
            case UInt8(ascii: "["): return try parseArray(depth: depth)
            case UInt8(ascii: "t"): try expect("true"); return .bool(true)
            case UInt8(ascii: "f"): try expect("false"); return .bool(false)
            case UInt8(ascii: "n"): try expect("null"); return .null
            default: return try parseNumber()
            }
        }

        mutating func expect(_ literal: StaticString) throws {
            let count = literal.utf8CodeUnitCount
            guard at + count <= bytes.count else { throw WireFrameError.malformedJSON }
            let matches = literal.withUTF8Buffer { buffer in
                (0..<count).allSatisfy { bytes[at + $0] == buffer[$0] }
            }
            guard matches else { throw WireFrameError.malformedJSON }
            at += count
        }

        mutating func parseObject(depth: Int) throws -> WireJSON {
            at += 1
            skipWhitespace()
            var members: [WireObject.Member] = []
            var seen = Set<[UInt8]>()
            if at < bytes.count, bytes[at] == UInt8(ascii: "}") {
                at += 1
                return .object(WireObject(members: members))
            }
            while true {
                skipWhitespace()
                guard at < bytes.count, bytes[at] == UInt8(ascii: "\"") else { throw WireFrameError.malformedJSON }
                let key = try parseString()
                guard seen.insert(Array(key.utf8)).inserted else { throw WireFrameError.malformedJSON }
                skipWhitespace()
                guard at < bytes.count, bytes[at] == UInt8(ascii: ":") else { throw WireFrameError.malformedJSON }
                at += 1
                members.append(.init(key: key, value: try parseValue(depth: depth + 1)))
                skipWhitespace()
                guard at < bytes.count else { throw WireFrameError.malformedJSON }
                let end = bytes[at]
                at += 1
                if end == UInt8(ascii: "}") { return .object(WireObject(members: members)) }
                guard end == UInt8(ascii: ",") else { throw WireFrameError.malformedJSON }
            }
        }

        mutating func parseArray(depth: Int) throws -> WireJSON {
            at += 1
            skipWhitespace()
            var items: [WireJSON] = []
            if at < bytes.count, bytes[at] == UInt8(ascii: "]") {
                at += 1
                return .array(items)
            }
            while true {
                items.append(try parseValue(depth: depth + 1))
                skipWhitespace()
                guard at < bytes.count else { throw WireFrameError.malformedJSON }
                let end = bytes[at]
                at += 1
                if end == UInt8(ascii: "]") { return .array(items) }
                guard end == UInt8(ascii: ",") else { throw WireFrameError.malformedJSON }
            }
        }

        mutating func parseNumber() throws -> WireJSON {
            let start = at
            if at < bytes.count, bytes[at] == UInt8(ascii: "-") { at += 1 }
            guard at < bytes.count else { throw WireFrameError.malformedJSON }
            if bytes[at] == UInt8(ascii: "0") {
                at += 1
            } else if isDigit(bytes[at]) {
                while at < bytes.count, isDigit(bytes[at]) { at += 1 }
            } else {
                throw WireFrameError.malformedJSON
            }
            if at < bytes.count, bytes[at] == UInt8(ascii: ".") {
                at += 1
                guard at < bytes.count, isDigit(bytes[at]) else { throw WireFrameError.malformedJSON }
                while at < bytes.count, isDigit(bytes[at]) { at += 1 }
            }
            if at < bytes.count, bytes[at] == UInt8(ascii: "e") || bytes[at] == UInt8(ascii: "E") {
                at += 1
                if at < bytes.count, bytes[at] == UInt8(ascii: "+") || bytes[at] == UInt8(ascii: "-") { at += 1 }
                guard at < bytes.count, isDigit(bytes[at]) else { throw WireFrameError.malformedJSON }
                while at < bytes.count, isDigit(bytes[at]) { at += 1 }
            }
            let text = String(decoding: bytes[start..<at], as: UTF8.self)
            guard let value = Double(text) else { throw WireFrameError.malformedJSON }
            return .number(value)
        }

        func isDigit(_ byte: UInt8) -> Bool { byte >= 0x30 && byte <= 0x39 }

        mutating func parseString() throws -> String {
            at += 1
            var output: [UInt8] = []
            while at < bytes.count {
                let byte = bytes[at]
                at += 1
                switch byte {
                case UInt8(ascii: "\""):
                    return String(decoding: output, as: UTF8.self)
                case 0x00..<0x20:
                    throw WireFrameError.malformedJSON
                case UInt8(ascii: "\\"):
                    guard at < bytes.count else { throw WireFrameError.malformedJSON }
                    let escape = bytes[at]
                    at += 1
                    switch escape {
                    case UInt8(ascii: "\""): output.append(0x22)
                    case UInt8(ascii: "\\"): output.append(0x5C)
                    case UInt8(ascii: "/"): output.append(0x2F)
                    case UInt8(ascii: "b"): output.append(0x08)
                    case UInt8(ascii: "f"): output.append(0x0C)
                    case UInt8(ascii: "n"): output.append(0x0A)
                    case UInt8(ascii: "r"): output.append(0x0D)
                    case UInt8(ascii: "t"): output.append(0x09)
                    case UInt8(ascii: "u"):
                        let scalar = try parseUnicodeEscape()
                        output.append(contentsOf: Array(String(Character(scalar)).utf8))
                    default: throw WireFrameError.malformedJSON
                    }
                default:
                    output.append(byte)
                }
            }
            throw WireFrameError.malformedJSON
        }

        mutating func hex4() throws -> UInt32 {
            guard at + 4 <= bytes.count else { throw WireFrameError.malformedJSON }
            var value: UInt32 = 0
            for _ in 0..<4 {
                let byte = bytes[at]
                at += 1
                let digit: UInt32
                switch byte {
                case 0x30...0x39: digit = UInt32(byte - 0x30)
                case 0x41...0x46: digit = UInt32(byte - 0x41 + 10)
                case 0x61...0x66: digit = UInt32(byte - 0x61 + 10)
                default: throw WireFrameError.malformedJSON
                }
                value = value << 4 | digit
            }
            return value
        }

        /// After `\u`: one scalar, joining a surrogate pair; an escaped lone surrogate is refused.
        mutating func parseUnicodeEscape() throws -> Unicode.Scalar {
            let first = try hex4()
            if (0xD800...0xDBFF).contains(first) {
                guard at + 1 < bytes.count, bytes[at] == UInt8(ascii: "\\"), bytes[at + 1] == UInt8(ascii: "u") else {
                    throw WireFrameError.malformedJSON
                }
                at += 2
                let second = try hex4()
                guard (0xDC00...0xDFFF).contains(second),
                    let scalar = Unicode.Scalar(0x10000 + ((first - 0xD800) << 10) + (second - 0xDC00))
                else { throw WireFrameError.malformedJSON }
                return scalar
            }
            guard let scalar = Unicode.Scalar(first) else { throw WireFrameError.malformedJSON }
            return scalar
        }
    }
}

/// A JSON object whose members keep their order and whose keys compare by UTF-8 bytes.
public struct WireObject: Sendable, Equatable {
    public struct Member: Sendable, Equatable {
        public let key: String
        public let value: WireJSON
    }

    public let members: [Member]

    func value(for key: String) -> WireJSON? {
        members.first { $0.key.utf8.elementsEqual(key.utf8) }?.value
    }

    /// True when the object has exactly `keys`: no missing member and no unknown one.
    func hasExactly(_ keys: [String]) -> Bool {
        members.count == keys.count && keys.allSatisfy { value(for: $0) != nil }
    }
}

/// Why a frame was refused. It never carries a received value, so it is safe to log.
public enum WireFrameError: Error, Equatable, Sendable {
    /// More than 65,536 bytes.
    case oversize
    /// Not UTF-8, not JSON, a duplicate member, an escaped lone surrogate, or too deep or large.
    case malformedJSON
    /// Well-formed JSON that is not one of the family's shapes. Names the field, never its value.
    case invalid(String)
}
