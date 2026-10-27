import Foundation
import Testing
@testable import RemiKit

/// ADR 0047 against the real golden frames and the shared vector corpus
/// (`packages/shared/tests/fixtures/terminal-view/vectors.json`). The corpus states no
/// refusal reason, so each refusal vector is checked to be refused with a payload-free error.
struct TerminalViewProtocolTests {
    static func vectors() throws -> WireVectors { try WireVectors.load("terminal-view") }

    @Test func corpusIsTheExpectedSize() throws {
        let v = try Self.vectors()
        #expect(v.positive.count == 11)
        #expect(v.negative.count == 37)
    }

    @Test func everyPositiveVectorDecodesToItsExpectedFrame() throws {
        for vector in try Self.vectors().positive {
            let message = try TerminalViewMessage.decode(vector.raw)
            #expect(WireVectors.sorted(message.json) == WireVectors.sorted(vector.expected), "\(vector.name)")
            // The encoder reproduces the vector byte for byte, as the TypeScript test requires.
            #expect(try message.encodedFrame() == vector.raw, "\(vector.name)")
            #expect(try TerminalViewMessage.decode(Data(vector.raw.utf8)) == message, "\(vector.name)")
        }
    }

    @Test func everyRefusalVectorIsRefused() throws {
        let textLevel = try Self.vectors().refusalKinds { _ = try TerminalViewMessage.decode($0) }
        #expect(
            textLevel == [
                "duplicate-root-id", "escaped-duplicate-type", "duplicate-cursor-field", "lone-surrogate-row",
                "malformed-utf8",
            ])
        // Every other refusal, the geometry, text and encoding rules, is a shape refusal.
    }

    @Test func goldenFixturesDecode() throws {
        for name in [
            "session_terminal_open", "session_terminal_opened", "session_terminal_read",
            "session_terminal_snapshot", "session_terminal_unchanged", "session_terminal_close",
            "session_terminal_closed", "session_terminal_refused",
        ] {
            let message = try TerminalViewMessage.decode(FixtureConformanceTests.fixture(name))
            #expect(wireType(message.json) == name)
        }
    }

    @Test func terminalResizeIsNotATerminalViewFrame() throws {
        // The legacy raw-PTY resize stays outside this family (ADR 0047: no input or resize).
        expectShapeRefusal {
            try TerminalViewMessage.decode(FixtureConformanceTests.fixture("terminal_resize"))
        }
    }

    @Test func decodedFieldsAreTyped() throws {
        let vector = try #require(try Self.vectors().positive.first { $0.name == "snapshot-wide-combining" })
        guard case .snapshot(let snapshot) = try TerminalViewMessage.decode(vector.raw) else {
            Issue.record("not a snapshot")
            return
        }
        #expect(snapshot.columns == 20 && snapshot.rows == 4)
        #expect(snapshot.lines == ["owned", "界é", "", ""])
        #expect(snapshot.cursor == TerminalCursor(row: 1, column: 3))
        #expect(snapshot.viewId == "AAECAwQFBgcICQoLDA0ODw")
        let read = try #require(try Self.vectors().positive.first { $0.name == "read-maximum-safe-revision" })
        guard case .read(let message) = try TerminalViewMessage.decode(read.raw) else { return }
        #expect(message.afterRevision == 9_007_199_254_740_991)
    }

    // MARK: Limits the corpus does not pin

    private static let header =
        #""type":"session_terminal_snapshot","id":"00000000-0000-4000-8000-000000000001","timestamp":"2026-10-22T00:00:00.000Z","sessionId":"00000000-0000-4000-8000-000000000003","requestId":"00000000-0000-4000-8000-000000000002","viewId":"AAECAwQFBgcICQoLDA0ODw""#

    private static func snapshot(columns: Int, rows: Int, lines: [String], cursor: String = "null") -> String {
        let quoted = lines.map { WireJSON.string($0).serialized() }.joined(separator: ",")
        return "{\(header),\"revision\":0,\"columns\":\(columns),\"rows\":\(rows),\"lines\":[\(quoted)],\"cursor\":\(cursor)}"
    }

    @Test func geometryBoundsAreInclusive() throws {
        _ = try TerminalViewMessage.decode(Self.snapshot(columns: 2, rows: 1, lines: [""]))
        _ = try TerminalViewMessage.decode(Self.snapshot(columns: 240, rows: 60, lines: Array(repeating: "", count: 60)))
        expectShapeRefusal {
            try TerminalViewMessage.decode(Self.snapshot(columns: 240, rows: 61, lines: Array(repeating: "", count: 61)))
        }
    }

    @Test func perRowStorageCeilingIsColumnsTimes64Bytes() throws {
        let full = String(repeating: "a", count: 128)
        _ = try TerminalViewMessage.decode(Self.snapshot(columns: 2, rows: 1, lines: [full]))
        expectShapeRefusal {
            try TerminalViewMessage.decode(Self.snapshot(columns: 2, rows: 1, lines: [full + "a"]))
        }
        // Multibyte text counts as UTF-8 bytes: 43 three-byte scalars exceed 128 bytes.
        expectShapeRefusal {
            try TerminalViewMessage.decode(
                Self.snapshot(columns: 2, rows: 1, lines: [String(repeating: "界", count: 43)]))
        }
    }

    @Test func aggregateTextIsAtMost32768Bytes() throws {
        let row = String(repeating: "a", count: 240 * 64 / 2)  // 7,680 bytes, under 15,360
        let four = Array(repeating: row, count: 4)  // 30,720
        _ = try TerminalViewMessage.decode(Self.snapshot(columns: 240, rows: 4, lines: four))
        let big = String(repeating: "a", count: 8_192)
        _ = try TerminalViewMessage.decode(Self.snapshot(columns: 240, rows: 4, lines: Array(repeating: big, count: 4)))
        expectShapeRefusal {
            try TerminalViewMessage.decode(
                Self.snapshot(columns: 240, rows: 5, lines: Array(repeating: big, count: 4) + ["a"]))
        }
    }

    @Test func cursorMustBeInsideTheGeometry() throws {
        _ = try TerminalViewMessage.decode(
            Self.snapshot(columns: 3, rows: 2, lines: ["", ""], cursor: #"{"row":1,"column":2}"#))
        for cursor in [#"{"row":2,"column":0}"#, #"{"row":0,"column":3}"#, #"{"row":-1,"column":0}"#, #"{"row":0}"#] {
            expectShapeRefusal("\(cursor)") {
                try TerminalViewMessage.decode(Self.snapshot(columns: 3, rows: 2, lines: ["", ""], cursor: cursor))
            }
        }
    }

    @Test func screenTextRefusesControlsBidiAndJoiner() {
        for scalar in ["\u{1B}", "\u{7F}", "\u{9F}", "\u{061C}", "\u{200E}", "\u{200F}", "\u{200D}", "\u{2028}", "\u{2029}", "\u{202A}", "\u{202E}", "\u{2066}", "\u{2069}"] {
            expectShapeRefusal("\(scalar.unicodeScalars.first!.value)") {
                try TerminalViewMessage.decode(Self.snapshot(columns: 20, rows: 1, lines: ["a\(scalar)b"]))
            }
        }
        // Wide, combining, emoji (without a joiner) and a no-break space are preserved.
        #expect(throws: Never.self) {
            try TerminalViewMessage.decode(Self.snapshot(columns: 20, rows: 1, lines: ["界e\u{301}\u{1F600}\u{A0}"]))
        }
    }

    @Test func bindingLimits() throws {
        func open(_ binding: String) -> String {
            #"{"type":"session_terminal_open","id":"00000000-0000-4000-8000-000000000001","timestamp":"2026-10-22T00:00:00.000Z","sessionId":"00000000-0000-4000-8000-000000000003","binding":\#(binding)}"#
        }
        let edge = String(repeating: "x", count: 200)
        _ = try TerminalViewMessage.decode(open(#"{"harness":"codex","harnessSessionId":"\#(edge)"}"#))
        for binding in [
            #"{"harness":"codex","harnessSessionId":"\#(edge)x"}"#,
            #"{"harness":"codex","harnessSessionId":""}"#,
            #"{"harness":"codex","harnessSessionId":"a\u0007"}"#,
            #"{"harness":"gemini","harnessSessionId":"a"}"#,
            #"{"harness":"codex"}"#,
            #"{"harness":"codex","harnessSessionId":"a","extra":1}"#,
        ] {
            expectShapeRefusal("\(binding)") { try TerminalViewMessage.decode(open(binding)) }
        }
        // A duplicate member is a text-level refusal, before any shape rule.
        #expect(throws: WireFrameError.malformedJSON) {
            try TerminalViewMessage.decode(open(#"{"harness":"codex","harnessSessionId":"a","harness":"claude"}"#))
        }
        // 67 three-byte scalars are 201 bytes.
        let wide = String(repeating: "界", count: 67)
        expectShapeRefusal {
            try TerminalViewMessage.decode(open(#"{"harness":"codex","harnessSessionId":"\#(wide)"}"#))
        }
    }

    @Test func refusalOperationsAndCodesAreClosed() throws {
        func refused(_ operation: String, _ code: String) -> String {
            #"{"type":"session_terminal_refused","id":"00000000-0000-4000-8000-000000000001","timestamp":"2026-10-22T00:00:00.000Z","sessionId":"00000000-0000-4000-8000-000000000003","requestId":"00000000-0000-4000-8000-000000000002","operation":"\#(operation)","code":"\#(code)"}"#
        }
        for operation in TerminalViewOperation.allCases {
            for code in TerminalViewRefusalCode.allCases {
                _ = try TerminalViewMessage.decode(refused(operation.rawValue, code.rawValue))
            }
        }
        #expect(TerminalViewRefusalCode.allCases.count == 6 && TerminalViewOperation.allCases.count == 3)
        expectShapeRefusal { try TerminalViewMessage.decode(refused("session_terminal_open", "Busy")) }
        expectShapeRefusal { try TerminalViewMessage.decode(refused("session_terminal_opened", "busy")) }
    }

    @Test func frameOverSixtyFourKiBIsRefusedAsOversize() {
        let padded = String(repeating: " ", count: 65_536) + "{}"
        #expect(throws: WireFrameError.oversize) { try TerminalViewMessage.decode(padded) }
    }

    @Test func aNonCanonicalOrUppercaseIdIsRefused() throws {
        let frame = #"{"type":"session_terminal_close","id":"00000000-0000-4000-8000-000000000001","timestamp":"2026-10-22T00:00:00.000Z","sessionId":"00000000-0000-4000-8000-000000000003","viewId":"AAECAwQFBgcICQoLDA0ODw"}"#
        _ = try TerminalViewMessage.decode(frame)
        for (old, new) in [
            ("00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-00000000000A"),
            ("2026-10-22T00:00:00.000Z", "2026-02-30T00:00:00.000Z"),
            ("2026-10-22T00:00:00.000Z", "2026-10-22T24:00:00.000Z"),
            ("2026-10-22T00:00:00.000Z", "2026-10-22T00:00:00Z"),
            ("AAECAwQFBgcICQoLDA0ODw", "AAECAwQFBgcICQoLDA0O"),
        ] {
            expectShapeRefusal("\(new)") {
                try TerminalViewMessage.decode(frame.replacingOccurrences(of: old, with: new))
            }
        }
    }

    @Test func encodingARawInvalidValueIsRefused() {
        let header = WireHeader(
            id: "00000000-0000-4000-8000-000000000001", timestamp: "2026-10-22T00:00:00.000Z",
            sessionId: "00000000-0000-4000-8000-000000000003")
        let bad = SessionTerminalSnapshot(
            header: header, requestId: header.id, viewId: "AAECAwQFBgcICQoLDA0ODw", revision: 0, columns: 5, rows: 2,
            lines: ["only one"], cursor: nil)
        expectShapeRefusal { try TerminalViewMessage.snapshot(bad).encodedFrame() }
    }
}
