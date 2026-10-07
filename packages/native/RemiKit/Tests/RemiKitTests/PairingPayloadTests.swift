import Foundation
import Testing
@testable import RemiKit

struct PairingPayloadTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private let nonce = "abcdefghijklmnopqrstuvwxyzABCDE_1234567890"

    @Test func validCodePinsEndpointAndKeepsNonceEphemeral() throws {
        let value = "remi://pair?v=1&host=100.64.0.8&port=18765&fingerprint=0123456789abcdef&iat=1800000000&exp=1800000300&nonce=\(nonce)"
        let payload = try PairingPayload(scannedValue: value, now: now)
        #expect(payload.endpoint.expectedFingerprint == "0123456789abcdef")
        #expect(payload.endpoint.webSocketURL?.absoluteString.contains("pairing_nonce=") == true)

        let persisted = try JSONEncoder().encode(payload.endpoint)
        let restored = try JSONDecoder().decode(MachineEndpoint.self, from: persisted)
        #expect(restored.expectedFingerprint == payload.daemonFingerprint)
        #expect(restored.pairingNonce == nil)
    }

    @Test func expiredCodeFailsClosed() {
        let value = "remi://pair?v=1&host=127.0.0.1&port=18765&fingerprint=0123456789abcdef&iat=1799999400&exp=1799999700&nonce=\(nonce)"
        #expect(throws: PairingPayloadError.expired) {
            try PairingPayload(scannedValue: value, now: now)
        }
    }

    @Test func rejectsLongLivedAndMalformedCodes() {
        let longLived = "remi://pair?v=1&host=127.0.0.1&port=18765&fingerprint=0123456789abcdef&iat=1800000000&exp=1800000600&nonce=\(nonce)"
        #expect(throws: PairingPayloadError.invalidLifetime) {
            try PairingPayload(scannedValue: longLived, now: now)
        }
        #expect(throws: PairingPayloadError.invalidURL) {
            try PairingPayload(scannedValue: "https://example.com", now: now)
        }
        let duplicate = "remi://pair?v=1&v=1&host=127.0.0.1&port=18765&fingerprint=0123456789abcdef&iat=1800000000&exp=1800000300&nonce=\(nonce)"
        #expect(throws: PairingPayloadError.invalidURL) {
            try PairingPayload(scannedValue: duplicate, now: now)
        }
    }
}
