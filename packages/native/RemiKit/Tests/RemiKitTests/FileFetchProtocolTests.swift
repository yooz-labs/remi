import Foundation
import Testing
@testable import RemiKit

/// ADR 0045 structural codec against the golden fixtures and `fixtures/file-download/vectors.json`.
struct FileFetchProtocolTests {
    static let goldens = [
        "file_fetch_begin", "file_fetch_accepted", "file_fetch_read", "file_fetch_chunk", "file_fetch_complete",
        "file_fetch_result", "file_fetch_cancel", "file_fetch_cancel_result", "file_fetch_refused",
    ]

    @Test func goldenFixturesDecodeAndRoundTrip() throws {
        for name in Self.goldens {
            let data = try FixtureConformanceTests.fixture(name)
            let message = try FileFetchMessage.decode(data)
            #expect(wireType(message.json) == name)
            let expected = try WireJSON.parse(data)
            #expect(WireVectors.sorted(message.json) == WireVectors.sorted(expected), "\(name)")
            #expect(try FileFetchMessage.decode(message.encodedFrame()) == message, "\(name)")
        }
    }

    @Test func everyPositiveVectorDecodesAndReencodesByteForByte() throws {
        let vectors = try WireVectors.load("file-download")
        #expect(vectors.positive.count == 21)
        for vector in vectors.positive {
            let message = try FileFetchMessage.decode(vector.raw)
            #expect(WireVectors.sorted(message.json) == WireVectors.sorted(vector.expected), "\(vector.name)")
            #expect(try message.encodedFrame() == vector.raw, "\(vector.name)")
        }
    }

    @Test func everyNegativeVectorIsRefused() throws {
        let vectors = try WireVectors.load("file-download")
        #expect(vectors.negative.count == 64)
        let textLevel = vectors.refusalKinds { _ = try FileFetchMessage.decode($0) }
        #expect(textLevel.allSatisfy(WireVectors.isTextLevel), "\(textLevel.filter { !WireVectors.isTextLevel($0) })")
    }

    @Test func goldenValuesAreTyped() throws {
        guard case .accepted(let accepted) = try FileFetchMessage.decode(FixtureConformanceTests.fixture("file_fetch_accepted"))
        else {
            Issue.record("not accepted")
            return
        }
        #expect(accepted.byteLength == 10_485_760)
        #expect(accepted.fileName == ".env")  // inert display data: structure only, no policy here
        guard case .chunk(let chunk) = try FileFetchMessage.decode(FixtureConformanceTests.fixture("file_fetch_chunk"))
        else {
            Issue.record("not a chunk")
            return
        }
        #expect(chunk.seq == 319 && chunk.bytes == Data([0]))
        guard case .begin(let begin) = try FileFetchMessage.decode(FixtureConformanceTests.fixture("file_fetch_begin"))
        else {
            Issue.record("not a begin")
            return
        }
        #expect(begin.binding.harness == .codex)
        #expect(begin.relativePath == "docs/%2e%2e/report%2Ffinal.txt")  // no decoding or normalization
    }

    // MARK: Limits

    private static let header =
        #""id":"00112233-4455-4677-8899-aabbccddeeff","timestamp":"2026-10-14T03:00:00.000Z","sessionId":"00112233-4455-7677-8899-aabbccddeeff""#

    private static func begin(path: String) -> String {
        #"{"type":"file_fetch_begin",\#(header),"binding":{"harness":"claude","harnessSessionId":"s"},"relativePath":\#(WireJSON.string(path).serialized())}"#
    }

    @Test func pathBoundsAreExact() throws {
        _ = try FileFetchMessage.decode(Self.begin(path: Array(repeating: "x", count: 64).joined(separator: "/")))
        _ = try FileFetchMessage.decode(Self.begin(path: String(repeating: "a", count: 255)))
        _ = try FileFetchMessage.decode(Self.begin(path: String(repeating: "a", count: 63) + "/" + String(repeating: "b", count: 255)))
        for path in [
            Array(repeating: "x", count: 65).joined(separator: "/"), String(repeating: "a", count: 256), "", "a//b", "/a",
            "a/", "a\\b", "a:b", "a\u{0}b", "a\u{85}b", "a\u{202E}b", "a\u{2066}b", "a\u{061C}b",
            String(repeating: "界", count: 86),  // 258 bytes
        ] {
            expectShapeRefusal("\(path.unicodeScalars.count)") {
                try FileFetchMessage.decode(Self.begin(path: path))
            }
        }
        // 4,096 bytes total is allowed, 4,097 is not, whatever the component split.
        let component = String(repeating: "a", count: 63)
        let long = Array(repeating: component, count: 64).joined(separator: "/")  // 4,095 bytes
        _ = try FileFetchMessage.decode(Self.begin(path: long))
        let exact = long + "x"  // exactly 4,096 bytes
        #expect(exact.utf8.count == 4_096)
        _ = try FileFetchMessage.decode(Self.begin(path: exact))
        #expect(throws: WireFrameError.invalid("relativePath")) { try FileFetchMessage.decode(Self.begin(path: exact + "x")) }
        #expect(throws: WireFrameError.invalid("relativePath")) { try FileFetchMessage.decode(Self.begin(path: long + "xx")) }
    }

    @Test func readBoundsAndShape() throws {
        func read(seq: String, received: String) -> String {
            #"{"type":"file_fetch_read",\#(Self.header),"transferId":"AAECAwQFBgcICQoLDA0ODw","seq":\#(seq),"receivedBytes":\#(received)}"#
        }
        _ = try FileFetchMessage.decode(read(seq: "319", received: "10485760"))
        for (seq, received) in [("320", "0"), ("-1", "0"), ("0", "10485761"), ("0.5", "0"), ("0", "\"0\""), ("null", "0")] {
            expectShapeRefusal("\(seq) \(received)") {
                try FileFetchMessage.decode(read(seq: seq, received: received))
            }
        }
    }

    @Test func chunkDataIsCanonicalAndBounded() throws {
        func chunk(_ data: String) -> String {
            #"{"type":"file_fetch_chunk",\#(Self.header),"requestId":"00112233-4455-4677-8899-aabbccddeeff","transferId":"AAECAwQFBgcICQoLDA0ODw","seq":0,"data":"\#(data)"}"#
        }
        let full = GuardsSupport.base64URL(Data(repeating: 7, count: 32_768))
        _ = try FileFetchMessage.decode(chunk(full))
        for data in [GuardsSupport.base64URL(Data(repeating: 7, count: 32_769)), "", "AA==", "AB", "A", "AA+/"] {
            expectShapeRefusal("\(data.prefix(8))") { try FileFetchMessage.decode(chunk(data)) }
        }
        // A maximum chunk frame stays within the 64 KiB frame limit.
        #expect(chunk(full).utf8.count < WireJSON.maxFrameBytes)
    }

    @Test func acceptedRequiresTheOneMediaTypeAndPositiveLength() throws {
        func accepted(length: String, media: String = "application/octet-stream") -> String {
            #"{"type":"file_fetch_accepted",\#(Self.header),"requestId":"00112233-4455-4677-8899-aabbccddeeff","transferId":"AAECAwQFBgcICQoLDA0ODw","fileName":"a.txt","byteLength":\#(length),"mediaType":"\#(media)","digest":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","expiresAt":"2026-10-14T03:05:00.000Z"}"#
        }
        _ = try FileFetchMessage.decode(accepted(length: "1"))
        for frame in [accepted(length: "0"), accepted(length: "10485761"), accepted(length: "1", media: "text/plain")] {
            expectShapeRefusal { try FileFetchMessage.decode(frame) }
        }
    }

    @Test func refusalOperationsAndCodesAreClosed() {
        #expect(FileFetchRefusalCode.allCases.count == 10)
        #expect(FileFetchOperation.allCases.map(\.rawValue) == ["file_fetch_begin", "file_fetch_read", "file_fetch_complete", "file_fetch_cancel"])
    }

    @Test func unknownMembersAndTypesAreRefused() throws {
        let golden = try String(decoding: FixtureConformanceTests.fixture("file_fetch_cancel"), as: UTF8.self)
        _ = try FileFetchMessage.decode(golden)
        let extra = golden.replacingOccurrences(of: "\"beginId\"", with: "\"x\":1,\"beginId\"")
        expectShapeRefusal { try FileFetchMessage.decode(extra) }
        let other = golden.replacingOccurrences(of: "file_fetch_cancel", with: "file_fetch_unknown")
        expectShapeRefusal { try FileFetchMessage.decode(other) }
    }
}

/// Test-only base64url for building frames at a boundary.
enum GuardsSupport {
    static func base64URL(_ data: Data) -> String { WireGuards.encodeBase64URL(data) }
}
