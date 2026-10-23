import Foundation
import Testing
@testable import RemiKit

/// The strict parser behind every frame codec: what `JSONDecoder` would accept and the
/// strict codecs must not (ADR 0047 "Runtime boundary").
struct WireJSONTests {
    @Test func parsesAndSerializesRoundTrip() throws {
        let text = #"{"a":[1,2.5,"x\n",null,true],"b":{"c":"é"}}"#
        let value = try WireJSON.parse(text)
        #expect(try WireJSON.parse(value.serialized()) == value)
    }

    @Test func refusesDuplicateMembersAtEveryDepth() {
        for text in [#"{"a":1,"a":2}"#, #"{"x":{"a":1,"a":2}}"#, #"{"a":1,"a":2}"#, #"[{"k":1,"k":1}]"#] {
            #expect(throws: WireFrameError.malformedJSON, "\(text)") { try WireJSON.parse(text) }
        }
    }

    @Test func comparesKeysByScalarsNotCanonicalEquivalence() throws {
        // "e" + U+0301 and U+00E9 are different members, not duplicates.
        let value = try WireJSON.parse("{\"e\u{301}\":1,\"\u{e9}\":2}")
        #expect(value.objectValue?.members.count == 2)
    }

    @Test func refusesEscapedLoneSurrogates() {
        for text in [#"["\ud800"]"#, #"["\udc00"]"#, #"["\ud800x"]"#, #"["\ud800A"]"#] {
            #expect(throws: WireFrameError.malformedJSON, "\(text)") { try WireJSON.parse(text) }
        }
        #expect((try? WireJSON.parse(#"["😀"]"#)) == .array([.string("\u{1F600}")]))
    }

    @Test func refusesInvalidUTF8AndOversizeAndNesting() {
        #expect(throws: WireFrameError.malformedJSON) { try WireJSON.parse(Data([0x22, 0xC3, 0x28, 0x22])) }
        #expect(throws: WireFrameError.oversize) {
            try WireJSON.parse("\"" + String(repeating: "a", count: 65_536) + "\"")
        }
        let deep = String(repeating: "[", count: 10) + String(repeating: "]", count: 10)
        #expect(throws: WireFrameError.malformedJSON) { try WireJSON.parse(deep) }
        let ok = String(repeating: "[", count: 9) + String(repeating: "]", count: 9)
        #expect((try? WireJSON.parse(ok)) != nil)
        let wide = "[" + Array(repeating: "0", count: 600).joined(separator: ",") + "]"
        #expect(throws: WireFrameError.malformedJSON) { try WireJSON.parse(wide) }
    }

    @Test func valueCountBoundaryIs512Not513() throws {
        // The array itself is one value, so 511 elements make 512 and 512 elements make 513.
        let fits = "[" + Array(repeating: "0", count: 511).joined(separator: ",") + "]"
        let over = "[" + Array(repeating: "0", count: 512).joined(separator: ",") + "]"
        _ = try WireJSON.parse(fits)
        #expect(throws: WireFrameError.malformedJSON) { try WireJSON.parse(over) }
    }

    @Test func depthBoundaryIs8Levels() throws {
        // Depth counts from 0: nine nested arrays reach depth 8, ten reach 9.
        _ = try WireJSON.parse(String(repeating: "[", count: 9) + String(repeating: "]", count: 9))
        #expect(throws: WireFrameError.malformedJSON) {
            try WireJSON.parse(String(repeating: "[", count: 10) + String(repeating: "]", count: 10))
        }
    }

    @Test func largerLimitsAreOnlyOnTheInternalPath() throws {
        let wide = "[" + Array(repeating: "0", count: 600).joined(separator: ",") + "]"
        #expect(throws: WireFrameError.malformedJSON) { try WireJSON.parse(wide) }
        _ = try WireJSON.parse(Data(wide.utf8), maxBytes: 100_000, maxNodes: 1_000)
    }

    @Test func refusesGrammarJSONRefuses() {
        for text in ["", "{", "[1,]", #"{"a":1,}"#, "01", "1.", ".5", "+1", "NaN", "'a'", "\"a\nb\"", "{} x", "truee"] {
            #expect(throws: WireFrameError.self, "\(text)") { try WireJSON.parse(text) }
        }
    }

    @Test func frameLimitIsExactlyAtTheBoundary() {
        let body = String(repeating: "a", count: 65_536 - 2)
        #expect((try? WireJSON.parse("\"\(body)\"")) != nil)
    }
}
