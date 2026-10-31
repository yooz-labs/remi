import CryptoKit
import Foundation
import Testing
@testable import RemiKit

struct DirectChildSigningFenceTests {
    private func wait(_ semaphore: DispatchSemaphore, seconds: Double) -> DispatchTimeoutResult {
        semaphore.wait(timeout: .now() + seconds)
    }

    @Test func retirementAndSigningHaveOneSynchronousBoundary() async throws {
        let fence = DirectChildSigningFence(), client = ClientIdentity(), server = ClientIdentity()
        let challengeBytes = Data(repeating: 37, count: 32)
        let challengeJSON: [String: Any] = [
            "type": "auth_challenge", "id": "owned", "timestamp": "owned",
            "challenge": challengeBytes.base64EncodedString(), "serverPublicKey": server.publicKeyBase64,
            "serverFingerprint": server.fingerprint,
        ]
        let challenge = try JSONDecoder().decode(AuthChallengeMessage.self, from: JSONSerialization.data(withJSONObject: challengeJSON))
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        let retiring = DispatchSemaphore(value: 0), retired = DispatchSemaphore(value: 0)
        let signing = Task.detached {
            try fence.withSigning {
                entered.signal()
                guard release.wait(timeout: .now() + 3) == .success else { throw RelayFailure.closed }
                return try AuthenticationHandshake.response(to: challenge, identity: client, expectedServerPublicKey: server.publicKeyBase64)
            }
        }
        guard wait(entered, seconds: 3) == .success else {
            release.signal(); _ = try? await signing.value
            Issue.record("Owned signer did not enter the synchronous boundary")
            return
        }
        let retirement = Task.detached { retiring.signal(); fence.retire(); retired.signal() }
        guard wait(retiring, seconds: 3) == .success else {
            release.signal(); _ = try? await signing.value
            Issue.record("Owned retirement did not start")
            return
        }
        try await Task.sleep(for: .milliseconds(50))
        #expect(wait(retired, seconds: 0) == .timedOut, "Retirement must wait for a signer that has already entered")
        release.signal()
        let (response, _) = try await signing.value
        await retirement.value
        #expect(wait(retired, seconds: 0) == .success)
        let signature = try #require(Data(base64Encoded: response.signature))
        let clientKey = try Curve25519.Signing.PublicKey(rawRepresentation: client.publicKeyRaw)
        #expect(clientKey.isValidSignature(signature, for: challengeBytes))
        #expect(throws: (any Error).self) {
            try fence.withSigning {
                try AuthenticationHandshake.response(to: challenge, identity: client, expectedServerPublicKey: server.publicKeyBase64)
            }
        }
    }
}
