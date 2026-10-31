import CryptoKit
import Foundation
import Testing
@testable import RemiKit

/// All intentional blocking happens on owned threads, never on Swift's
/// cooperative executor. State can be read while cancellation is in flight.
private final class FenceThreadProbe: @unchecked Sendable {
    private let lock = NSLock()
    let release = DispatchSemaphore(value: 0)
    private var entered = false
    private var retiring = false
    private var retired = false
    private var finished = false
    private var response: AuthResponseMessage?

    func markEntered() { lock.lock(); entered = true; lock.unlock() }
    func markRetiring() { lock.lock(); retiring = true; lock.unlock() }
    func markRetired() { lock.lock(); retired = true; lock.unlock() }
    func finish(_ value: AuthResponseMessage?) {
        lock.lock(); response = value; finished = true; lock.unlock()
    }
    func snapshot() -> (entered: Bool, retiring: Bool, retired: Bool, finished: Bool, response: AuthResponseMessage?) {
        lock.lock(); defer { lock.unlock() }
        return (entered, retiring, retired, finished, response)
    }
}

struct DirectChildSigningFenceTests {
    /// Dispatch's timer does not block a cooperative thread and still resumes
    /// when the calling task is cancelled, so cleanup can observe both threads.
    private func delay(milliseconds: Int) async {
        await withCheckedContinuation { continuation in
            DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(milliseconds)) {
                continuation.resume()
            }
        }
    }

    private func waitUntil(_ condition: () -> Bool, seconds: Int = 3) async -> Bool {
        let deadline = ContinuousClock.now.advanced(by: .seconds(seconds))
        while !condition() && ContinuousClock.now < deadline { await delay(milliseconds: 5) }
        return condition()
    }

    private struct WorkerResult {
        let entered: Bool
        let retireStarted: Bool
        let retiredWhileHeld: Bool?
        let stopped: Bool
    }

    private func runWorkers(fence: DirectChildSigningFence, client: ClientIdentity,
                            server: ClientIdentity, challenge: AuthChallengeMessage,
                            probe: FenceThreadProbe, mutant: Bool) async -> WorkerResult {
        let signer = Thread {
            do {
                let result = try fence.withSigning {
                    probe.markEntered()
                    guard probe.release.wait(timeout: .now() + 3) == .success else { throw RelayFailure.closed }
                    return try AuthenticationHandshake.response(to: challenge, identity: client, expectedServerPublicKey: server.publicKeyBase64)
                }
                probe.finish(result.0)
            } catch { probe.finish(nil) }
        }
        signer.name = "remi-owned-fence-signer"
        let retire = Thread {
            probe.markRetiring()
            if !mutant { fence.retire() }
            probe.markRetired()
        }
        retire.name = "remi-owned-fence-retire"
        return await withTaskCancellationHandler {
            signer.start()
            let entered = await waitUntil { probe.snapshot().entered }
            var retireStarted = false
            var retireLaunched = false
            var retiredWhileHeld: Bool?
            if entered && !Task.isCancelled {
                retireLaunched = true
                retire.start()
                retireStarted = await waitUntil { probe.snapshot().retiring }
                if retireStarted && !Task.isCancelled {
                    await delay(milliseconds: 50)
                    retiredWhileHeld = probe.snapshot().retired
                }
            }
            probe.release.signal()
            let stopped = await waitUntil({ signer.isFinished && (!retireLaunched || retire.isFinished) }, seconds: 4)
            return WorkerResult(entered: entered, retireStarted: retireStarted,
                                retiredWhileHeld: retiredWhileHeld, stopped: stopped)
        } onCancel: {
            probe.release.signal()
        }
    }

    private func challenge(for server: ClientIdentity) throws -> AuthChallengeMessage {
        let challengeJSON: [String: Any] = [
            "type": "auth_challenge", "id": "owned", "timestamp": "owned",
            "challenge": Data(repeating: 37, count: 32).base64EncodedString(),
            "serverPublicKey": server.publicKeyBase64, "serverFingerprint": server.fingerprint,
        ]
        return try JSONDecoder().decode(AuthChallengeMessage.self, from: JSONSerialization.data(withJSONObject: challengeJSON))
    }

    @Test func retirementAndSigningHaveOneSynchronousBoundary() async throws {
        // The mutant removes only retire() and must fail the real-fence oracle.
        for mutant in [false, true] {
            let fence = DirectChildSigningFence(), client = ClientIdentity(), server = ClientIdentity()
            let frame = try challenge(for: server), probe = FenceThreadProbe()
            let result = await runWorkers(fence: fence, client: client, server: server, challenge: frame, probe: probe, mutant: mutant)
            #expect(result.entered && result.retireStarted && result.stopped, "Both owned threads must start and terminate")
            #expect(result.retiredWhileHeld == mutant, "Removing retire must violate the held-signature oracle")
            let response = try #require(probe.snapshot().response)
            let signature = try #require(Data(base64Encoded: response.signature))
            let clientKey = try Curve25519.Signing.PublicKey(rawRepresentation: client.publicKeyRaw)
            #expect(clientKey.isValidSignature(signature, for: Data(repeating: 37, count: 32)))
            var signedAfterRetirement = false
            do {
                _ = try fence.withSigning {
                    try AuthenticationHandshake.response(to: frame, identity: client, expectedServerPublicKey: server.publicKeyBase64)
                }
                signedAfterRetirement = true
            } catch { /* The real fence must refuse; the mutant must not. */ }
            #expect(signedAfterRetirement == mutant, "Removing retire must violate the post-retirement oracle")
        }
    }

    @Test func cancellationReleasesAndObservesBothOwnedThreads() async throws {
        let fence = DirectChildSigningFence(), client = ClientIdentity(), server = ClientIdentity()
        let frame = try challenge(for: server), probe = FenceThreadProbe()
        let task = Task {
            await runWorkers(fence: fence, client: client, server: server, challenge: frame, probe: probe, mutant: false)
        }
        let reached = await waitUntil { probe.snapshot().retiring }
        if !reached { task.cancel() }
        #expect(reached, "The cancellation test must reach a revoker blocked behind the signer")
        task.cancel()
        let result = await task.value
        #expect(result.stopped, "Cancellation must release and observe every owned thread")
        #expect(probe.snapshot().finished && probe.snapshot().retired)
    }

    @Test func priorParentSocketCannotAuthorizeAChildAfterReconnect() throws {
        let parent = DirectParentHelloFence()
        let old = parent.observeHello(nil)
        #expect(try parent.withAdmission(old) { true })
        let fresh = parent.reset()
        #expect(!parent.isCurrent(old) && parent.isCurrent(fresh))
        #expect(throws: (any Error).self) { try parent.withAdmission(old) { true } }
        #expect(throws: (any Error).self) { try parent.withAdmission(fresh) { true } }
        let admitted = parent.observeHello(Data(repeating: 11, count: 32))
        #expect(admitted == fresh)
        #expect(try parent.withAdmission(fresh) { true })
    }
}
