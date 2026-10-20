import CryptoKit
import Foundation
import RemiPush
import Testing
@testable import RemiPush

struct PushDisplayTextTests {
    @Test func scalarPolicyMatchesActualSharedReferenceCorpusAndIsIdempotent() throws {
        let tests = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        struct Corpus: Decodable { let source: String; let sha256: String; let cases: [[String: String]] }
        let corpus = try JSONDecoder().decode(Corpus.self, from: Data(contentsOf:
            tests.appendingPathComponent("Fixtures/display-text.json")))
        let root = tests.deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let source = root.appendingPathComponent(corpus.source)
        let digest = SHA256.hash(data: try Data(contentsOf: source)).map { String(format: "%02x", $0) }.joined()
        #expect(digest == corpus.sha256, "Regenerate from actual shared source after a policy change")
        let cases = corpus.cases
        #expect(cases.count > 200)
        for sample in cases {
            let text = try #require(sample["text"])
            let expected = try #require(sample["expected"])
            let escaped = PushDisplayText.escape(text)
            #expect(escaped == expected)
            #expect(PushDisplayText.escape(escaped) == escaped)
        }
    }

    @Test func originalPayloadPreservesBOMAndStrictTokenRefusals() throws {
        let oracle = try NativePushOracle.load("push-vectors.json")
        let vector = try #require((oracle["cases"] as? [[String: Any]])?.first)
        let original = try #require(vector["payloadUtf8"] as? String)
        for title in ["\u{feff}", "left\u{feff}right", "\\uFEFF", "left\\uFEFFright"] {
            let bytes = Data(original.replacingOccurrences(of: "Synthetic permission", with: title).utf8)
            guard case .question(let question) = try NativePushCodec.decodePayload(bytes) else {
                Issue.record("Expected actual question payload"); return
            }
            let expected = title.contains("left") ? "left\\uFEFFright" : "\\uFEFF"
            #expect(PushDisplayText.escape(question.title) == expected)
            #expect(question.title.unicodeScalars.contains { $0.value == 0xfeff })
            #expect(bytes == Data(original.replacingOccurrences(of: "Synthetic permission", with: title).utf8))
        }
        for token in ["\\q", "\\uD800", "\\uDC00", "\\uZZZZ", "raw\ncontrol"] {
            #expect(throws: NativePushCodecError.self) {
                try NativePushCodec.decodePayload(Data(original.replacingOccurrences(of: "Synthetic permission", with: token).utf8))
            }
        }
        #expect(throws: NativePushCodecError.self) {
            try NativePushCodec.decodePayload(Data(original.replacingOccurrences(of: "\"title\":", with: "\"title\":\"duplicate\",\"title\":").utf8))
        }
        #expect(throws: NativePushCodecError.self) { try NativePushCodec.decodePayload(Data(repeating: 32, count: 2049)) }
        // Exact title boundary still measures UTF8, independently of display escaping.
        _ = try NativePushCodec.decodePayload(Data(original.replacingOccurrences(of: "Synthetic permission", with: String(repeating: "a", count: 128)).utf8))
        #expect(throws: NativePushCodecError.self) {
            try NativePushCodec.decodePayload(Data(original.replacingOccurrences(of: "Synthetic permission", with: String(repeating: "a", count: 129)).utf8))
        }
    }

    @Test func ledgerProtectionAndPermissionsAreExplicit() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("remi-x2-files-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        try NativePushFileProtection.directory(directory)
        #expect(try FileManager.default.attributesOfItem(atPath: directory.path)[.posixPermissions] as? Int == 0o700)
        let file = directory.appendingPathComponent("ledger-wal")
        try Data().write(to: file)
        try NativePushFileProtection.file(file)
        #expect(try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? Int == 0o600)
        #if os(iOS)
        #expect(NativePushFileProtection.attributesFor(mode: 0o600)[.protectionKey] as? FileProtectionType == .completeUntilFirstUserAuthentication)
        #endif
        let link = directory.appendingPathComponent("symlink")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: file)
        #expect(throws: (any Error).self) { try NativePushFileProtection.file(link) }
    }
}
