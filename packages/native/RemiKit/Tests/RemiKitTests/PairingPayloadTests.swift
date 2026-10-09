import Foundation
import Testing
@testable import RemiKit

struct PairingPayloadTests {
    private struct Vectors: Decodable {
        struct Valid: Decodable { let name: String; let link: String; let fingerprint: String }
        struct Invalid: Decodable { let name: String; let link: String; let error: String }
        let now: Int64
        let protocolVersion: Int
        let valid: [Valid]
        let invalid: [Invalid]
    }

    private static let vectorsURL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .appendingPathComponent("shared/tests/fixtures/pairing/vectors.json")

    private static func vectors() throws -> Vectors {
        try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: vectorsURL))
    }

    @Test func everySharedValidVectorDecodesAndPinsTheWholeKey() throws {
        let vectors = try Self.vectors()
        #expect(vectors.protocolVersion == PairingPayload.protocolVersion)
        for vector in vectors.valid {
            let payload: PairingPayload
            do {
                payload = try PairingPayload(
                    scannedValue: vector.link,
                    now: Date(timeIntervalSince1970: TimeInterval(vectors.now))
                )
            } catch {
                Issue.record("\(vector.name): \(error)")
                continue
            }
            #expect(payload.daemonFingerprint == vector.fingerprint, Comment(rawValue: vector.name))
            #expect(payload.endpoint.expectedPublicKey == payload.daemonPublicKey)
            #expect(payload.endpoint.webSocketURL?.query == nil)
        }
    }

    @Test func everySharedInvalidVectorReturnsItsExactError() throws {
        let vectors = try Self.vectors()
        for vector in vectors.invalid {
            let expected = try #require(PairingPayloadError(rawValue: vector.error))
            #expect(throws: expected, Comment(rawValue: vector.name)) {
                try PairingPayload(
                    scannedValue: vector.link,
                    now: Date(timeIntervalSince1970: TimeInterval(vectors.now))
                )
            }
        }
    }

    @Test func persistenceDropsEveryEphemeralPairingValue() throws {
        let payload = try PairingPayload(
            scannedValue: try Self.vectors().valid[0].link,
            now: Date(timeIntervalSince1970: TimeInterval(try Self.vectors().now))
        )
        let restored = try JSONDecoder().decode(
            MachineEndpoint.self,
            from: JSONEncoder().encode(payload.endpoint)
        )
        #expect(restored.expectedFingerprint == payload.daemonFingerprint)
        #expect(restored.expectedPublicKey == nil)
        #expect(restored.pairingNonce == nil)
    }
}
