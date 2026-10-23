import Foundation
import Testing
@testable import RemiKit

/// Loads a shared vector corpus (`packages/shared/tests/fixtures/<family>/vectors.json`): the
/// real files the TypeScript codecs are tested with, so a Swift codec cannot drift from them.
struct WireVectors {
    struct Positive {
        let name: String
        let raw: String
        let expected: WireJSON
    }

    struct Negative {
        let name: String
        let input: Data
    }

    let positive: [Positive]
    let negative: [Negative]

    static func load(_ family: String) throws -> WireVectors {
        let url = FixtureConformanceTests.fixtures
            .deletingLastPathComponent().appendingPathComponent("\(family)/vectors.json")
        let root = try #require(try WireJSON.parse(Data(contentsOf: url), maxBytes: 8_000_000, maxNodes: .max).objectValue)
        guard case .array(let positive)? = root.value(for: "positive"),
            case .array(let negative)? = root.value(for: "negative")
        else { throw WireFrameError.invalid("vectors") }

        func text(_ object: WireObject, _ key: String) throws -> String {
            guard case .string(let value)? = object.value(for: key) else { throw WireFrameError.invalid(key) }
            return value
        }
        /// Corpus entries that are not plain text: raw bytes, or UTF-16 code units that may be a lone surrogate.
        func input(_ object: WireObject) throws -> Data {
            if case .string(let raw)? = object.value(for: "raw") { return Data(raw.utf8) }
            if case .array(let bytes)? = object.value(for: "bytes") {
                return Data(try bytes.map { item -> UInt8 in
                    guard case .number(let n) = item else { throw WireFrameError.invalid("bytes") }
                    guard let byte = UInt8(exactly: n) else { throw WireFrameError.invalid("bytes") }
                    return byte
                })
            }
            guard case .array(let units)? = object.value(for: "units") else { throw WireFrameError.invalid("input") }
            // A lone surrogate cannot live in a Swift String; its three-byte form is invalid UTF-8.
            var data = Data()
            for item in units {
                guard case .number(let n) = item else { throw WireFrameError.invalid("units") }
                guard let unit = UInt32(exactly: n), unit <= 0xFFFF else { throw WireFrameError.invalid("units") }
                if unit < 0x80 {
                    data.append(UInt8(unit))
                } else if unit < 0x800 {
                    data.append(contentsOf: [UInt8(0xC0 | unit >> 6), UInt8(0x80 | unit & 0x3F)])
                } else {
                    data.append(contentsOf: [
                        UInt8(0xE0 | unit >> 12), UInt8(0x80 | (unit >> 6) & 0x3F), UInt8(0x80 | unit & 0x3F),
                    ])
                }
            }
            return data
        }
        return WireVectors(
            positive: try positive.map {
                let o = try #require($0.objectValue)
                return Positive(
                    name: try text(o, "name"), raw: try text(o, "raw"), expected: try #require(o.value(for: "expected")))
            },
            negative: try negative.map {
                let o = try #require($0.objectValue)
                return Negative(name: try text(o, "name"), input: try input(o))
            })
    }

    /// Member order differs between a frame and the corpus' `expected` object, so compare sorted.
    static func sorted(_ json: WireJSON) -> WireJSON {
        switch json {
        case .object(let object):
            return .object(
                WireObject(
                    members: object.members.sorted { $0.key.utf8.lexicographicallyPrecedes($1.key.utf8) }
                        .map { .init(key: $0.key, value: sorted($0.value)) }))
        case .array(let items): return .array(items.map(sorted))
        default: return json
        }
    }
}

extension WireVectors {
    /// Name fragments of refusals that are about the JSON text, not the frame's shape.
    static let textLevelNames = [
        "duplicate", "surrogate", "utf8", "utf-8", "oversize", "over-frame", "trailing", "partial", "bom",
        "depth", "malformed:", "\\ud", "\\udf", "control-in-raw-json",
    ]

    static func isTextLevel(_ name: String) -> Bool { textLevelNames.contains { name.contains($0) } }

    /// Every negative vector is refused; one that is well-formed JSON must be refused as a bad
    /// shape (`.invalid`), never as `.malformedJSON` or `.oversize`, unless its name says the
    /// text itself is the problem. Returns the names refused at text level, for the caller to pin.
    func refusalKinds(_ decode: (Data) throws -> Void) -> [String] {
        var textLevel: [String] = []
        for vector in negative {
            do {
                try decode(vector.input)
                Issue.record("\(vector.name) was accepted")
            } catch WireFrameError.invalid {
                continue
            } catch {
                textLevel.append(vector.name)
            }
        }
        return textLevel
    }
}

/// The body must be refused for its shape (`WireFrameError.invalid`), not as bad JSON text or
/// an oversize frame, so a test of a field rule cannot pass on an unrelated parse failure.
func expectShapeRefusal(
    _ comment: Comment? = nil, sourceLocation: SourceLocation = #_sourceLocation, _ body: () throws -> Void
) {
    do {
        try body()
        Issue.record("accepted" as Comment, sourceLocation: sourceLocation)
    } catch WireFrameError.invalid {
        return
    } catch {
        Issue.record("refused as \(error), not as a shape error \(comment.map { "(\($0))" } ?? "")", sourceLocation: sourceLocation)
    }
}
