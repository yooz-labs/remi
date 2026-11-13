import CryptoKit
import Foundation
import Testing
@testable import RemiKit

/// Opt-in #1727 characterization; the corpus is produced only from owned synthetic input.
/// This checks the actual native decoder, not a socket, an ingress limit, or process RSS.
struct SyntheticTranscriptCorpusQualificationTests {
    private struct Manifest: Decodable {
        let version: Int
        let syntheticOnly: Bool
        let records: [Record]
    }

    private struct Record: Decodable {
        let name: String
        let source: String
        let sample: String
        let variant: String
        let bytes: Int
        let sha256: String
        let role: String
        let contentSha256: String
    }

    private func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["CALLBACK_1727_SYNTHETIC_CORPUS"] != nil))
    func sourceCorpusDecodesAndVariantsAgree() throws {
        let envPath = try #require(ProcessInfo.processInfo.environment["CALLBACK_1727_SYNTHETIC_CORPUS"])
        let root = URL(fileURLWithPath: "/Volumes/S1/yooz/remi/artifacts/callback-order-1727-20261031")
            .resolvingSymlinksInPath().standardizedFileURL
        let folder = URL(fileURLWithPath: envPath).resolvingSymlinksInPath().standardizedFileURL
        #expect(folder.deletingLastPathComponent() == root)
        guard folder.deletingLastPathComponent() == root else { return }
        let manifest = try JSONDecoder().decode(Manifest.self,
            from: Data(contentsOf: folder.appendingPathComponent("manifest.json")))
        #expect(manifest.version == 1 && manifest.syntheticOnly)
        #expect(manifest.records.count == 72)
        let sources = Set(["claude-user", "claude-assistant", "codex-user", "codex-assistant"])
        let samples = Set(["short", "ascii-1k", "ascii-32k", "ascii-128k", "unicode-escapes", "many-bullets"])
        let variants = Set(["normal", "reversed", "escapedTypeKey"])
        var seen = Set<String>()
        var normal: [String: TranscriptContentMessage] = [:]
        var decoded: [(String, TranscriptContentMessage)] = []
        var largest = 0
        for record in manifest.records {
            #expect(sources.contains(record.source) && samples.contains(record.sample) && variants.contains(record.variant))
            let key = "\(record.source)/\(record.sample)"
            #expect(seen.insert("\(key)/\(record.variant)").inserted)
            let expectedName = "\(record.source)-\(record.sample)-\(record.variant).json"
            #expect(record.name.hasSuffix(expectedName))
            guard !record.name.contains("/"), !record.name.contains("..") else {
                Issue.record("Invalid owned fixture name")
                continue
            }
            let data = try Data(contentsOf: folder.appendingPathComponent(record.name))
            #expect(data.count == record.bytes)
            #expect(digest(data) == record.sha256)
            let envelope = try JSONDecoder().decode(Envelope.self, from: data)
            let message = try JSONDecoder().decode(TranscriptContentMessage.self, from: data)
            #expect(envelope.type == "transcript_content" && message.type == envelope.type)
            #expect(message.role == record.role)
            #expect(digest(Data(message.content.utf8)) == record.contentSha256)
            if record.variant == "normal" { normal[key] = message }
            else { decoded.append((key, message)) }
            largest = max(largest, data.count)
        }
        #expect(seen.count == 72 && normal.count == 24 && decoded.count == 48)
        #expect(largest > 65_536) // This family-specific limit is not a transcript limit.
        for (key, message) in decoded { #expect(normal[key] == message) }
        print("#1727 synthetic transcript decode: records=\(manifest.records.count) maxBytes=\(largest)")
    }
}
