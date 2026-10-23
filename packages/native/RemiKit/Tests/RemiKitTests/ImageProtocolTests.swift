import Foundation
import Testing
@testable import RemiKit

/// ADR 0041 and 0042 structural codecs against the golden fixtures and the shared corpora
/// (`fixtures/image-staging/vectors.json`, `fixtures/image-insertion/vectors.json`).
struct ImageProtocolTests {
    static let uploadGoldens = [
        "image_upload_begin", "image_upload_accepted", "image_upload_chunk", "image_upload_chunk_ack",
        "image_upload_complete", "image_upload_result", "image_upload_cancel", "image_upload_cancel_result",
        "image_upload_refused",
    ]

    @Test func uploadGoldensDecodeAndRoundTrip() throws {
        for name in Self.uploadGoldens {
            let data = try FixtureConformanceTests.fixture(name)
            let message = try ImageUploadMessage.decode(data)
            #expect(wireType(message.json) == name)
            #expect(WireVectors.sorted(message.json) == WireVectors.sorted(try WireJSON.parse(data)), "\(name)")
            #expect(try ImageUploadMessage.decode(message.encodedFrame()) == message, "\(name)")
        }
    }

    @Test func insertionGoldensDecodeAndRoundTrip() throws {
        for name in ["image_insert_request", "image_insert_result"] {
            let data = try FixtureConformanceTests.fixture(name)
            let message = try ImageInsertionMessage.decode(data)
            #expect(WireVectors.sorted(message.json) == WireVectors.sorted(try WireJSON.parse(data)), "\(name)")
            #expect(try ImageInsertionMessage.decode(message.encodedFrame()) == message, "\(name)")
        }
    }

    @Test func stagingPositiveVectors() throws {
        let vectors = try WireVectors.load("image-staging")
        #expect(vectors.positive.count == 33)
        for vector in vectors.positive {
            let message = try ImageUploadMessage.decode(vector.raw)
            #expect(WireVectors.sorted(message.json) == WireVectors.sorted(vector.expected), "\(vector.name)")
            #expect(try ImageUploadMessage.decode(message.encodedFrame()) == message, "\(vector.name)")
        }
    }

    @Test func stagingNegativeVectors() throws {
        let vectors = try WireVectors.load("image-staging")
        #expect(vectors.negative.count == 470)
        for vector in vectors.negative {
            #expect(throws: WireFrameError.self, "\(vector.name)") { try ImageUploadMessage.decode(vector.input) }
        }
    }

    @Test func insertionPositiveVectors() throws {
        let vectors = try WireVectors.load("image-insertion")
        #expect(vectors.positive.count == 14)
        for vector in vectors.positive {
            let message = try ImageInsertionMessage.decode(vector.raw)
            #expect(WireVectors.sorted(message.json) == WireVectors.sorted(vector.expected), "\(vector.name)")
            #expect(try ImageInsertionMessage.decode(message.encodedFrame()) == message, "\(vector.name)")
        }
    }

    @Test func insertionNegativeVectors() throws {
        let vectors = try WireVectors.load("image-insertion")
        #expect(vectors.negative.count == 282)
        for vector in vectors.negative {
            #expect(throws: WireFrameError.self, "\(vector.name)") { try ImageInsertionMessage.decode(vector.input) }
        }
    }

    @Test func insertionOutcomeCodePairsAreFixed() throws {
        let head =
            #"{"type":"image_insert_result","id":"00112233-4455-4677-8899-aabbccddeeff","timestamp":"2026-10-13T12:00:00.000Z","sessionId":"00112233-4455-7677-8899-aabbccddeeff","requestId":"11112233-4455-4677-8899-aabbccddeeff""#
        func result(_ outcome: String, _ code: String) -> String { head + #","outcome":"\#(outcome)","code":"\#(code)"}"# }
        guard case .result(let ok) = try ImageInsertionMessage.decode(result("inserted", "none")),
            case .result(let unknown) = try ImageInsertionMessage.decode(result("uncertain", "delivery_unknown"))
        else {
            Issue.record("not results")
            return
        }
        #expect(ok.outcome == .inserted && unknown.outcome == .uncertain)
        for code in ImageInsertionRefusalCode.allCases {
            guard case .result(let refused) = try ImageInsertionMessage.decode(result("refused", code.rawValue)) else { continue }
            #expect(refused.outcome == .refused(code))
        }
        for (outcome, code) in [("inserted", "busy"), ("refused", "none"), ("refused", "delivery_unknown"), ("uncertain", "none"), ("inserted", "delivery_unknown")] {
            #expect(throws: WireFrameError.self, "\(outcome) \(code)") { try ImageInsertionMessage.decode(result(outcome, code)) }
        }
    }

    @Test func stagingAcceptsTheClaudeHarnessOnly() throws {
        let begin = try String(decoding: FixtureConformanceTests.fixture("image_upload_begin"), as: UTF8.self)
        guard begin.contains("\"claude\"") else {
            Issue.record("fixture no longer names claude")
            return
        }
        #expect(throws: WireFrameError.self) {
            try ImageUploadMessage.decode(begin.replacingOccurrences(of: "\"claude\"", with: "\"codex\""))
        }
    }

    @Test func resultArtifactMustDifferFromTransfer() throws {
        let result = try String(decoding: FixtureConformanceTests.fixture("image_upload_result"), as: UTF8.self)
        guard case .result(let parsed) = try ImageUploadMessage.decode(result) else {
            Issue.record("not a result")
            return
        }
        let same = result.replacingOccurrences(of: parsed.artifactId, with: parsed.transferId)
        #expect(throws: WireFrameError.self) { try ImageUploadMessage.decode(same) }
    }
}
