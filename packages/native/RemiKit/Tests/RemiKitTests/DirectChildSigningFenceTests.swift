import CryptoKit
import Foundation
import Testing
@testable import RemiKit

/// All intentional blocking happens on owned threads, never on Swift's
/// cooperative executor. State can be read while cancellation is in flight.
private final class FenceThreadProbe: @unchecked Sendable {
    private let lock = NSLock()
    let release = DispatchSemaphore(value: 0)
    let enteredGate = DispatchSemaphore(value: 0)
    let retiringGate = DispatchSemaphore(value: 0)
    let retiredGate = DispatchSemaphore(value: 0)
    let cancellationReady = DispatchSemaphore(value: 0)
    private var entered = false
    private var retiring = false
    private var retired = false
    private var finished = false
    private var readyForCancellation = false
    private var cancelled = false
    private var coordinator: Thread?
    private var response: AuthResponseMessage?

    func markEntered() { lock.lock(); entered = true; lock.unlock(); enteredGate.signal() }
    func markRetiring() { lock.lock(); retiring = true; lock.unlock(); retiringGate.signal() }
    func markRetired() { lock.lock(); retired = true; lock.unlock(); retiredGate.signal() }
    func markCancellationReady() {
        lock.lock(); readyForCancellation = true; lock.unlock(); cancellationReady.signal()
    }
    func mayCancel() -> Bool { lock.lock(); defer { lock.unlock() }; return readyForCancellation }
    func cancelAndRelease() {
        lock.lock(); cancelled = true; lock.unlock(); release.signal()
    }
    func isCancelled() -> Bool { lock.lock(); defer { lock.unlock() }; return cancelled }
    func setCoordinator(_ thread: Thread) { lock.lock(); coordinator = thread; lock.unlock() }
    func coordinatorFinished() -> Bool { lock.lock(); defer { lock.unlock() }; return coordinator?.isFinished == true }
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

    private struct WorkerResult: Sendable {
        let entered: Bool
        let retireStarted: Bool
        let retiredWhileHeld: Bool?
        let stopped: Bool
    }

    private func runWorkers(fence: DirectChildSigningFence, client: ClientIdentity,
                            server: ClientIdentity, challenge: AuthChallengeMessage,
                            probe: FenceThreadProbe, mutant: Bool,
                            ownedDelayAfterEntryMilliseconds: Int = 0,
                            waitForCancellation: Bool = false) async -> WorkerResult {
        // This task only starts the owned coordinator and awaits its completion.
        // The coordinator, not a Swift cooperative task, releases the held signer.
        let work = Task {
            await withCheckedContinuation { continuation in
                let coordinator = Thread {
                    // These Thread values stay local to the coordinator that starts
                    // and observes them; only their Sendable inputs cross into it.
                    let signer = Thread {
                        do {
                            let result = try fence.withSigning {
                                probe.markEntered()
                                probe.release.wait()
                                return try AuthenticationHandshake.response(to: challenge, identity: client,
                                    expectedServerPublicKey: server.publicKeyBase64)
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
                    defer { probe.release.signal() }
                    signer.start()
                    let entered = probe.enteredGate.wait(timeout: .now() + 3) == .success
                    var retireStarted = false
                    var retireLaunched = false
                    var retiredWhileHeld: Bool?
                    if entered && !probe.isCancelled() {
                        retireLaunched = true
                        retire.start()
                        retireStarted = probe.retiringGate.wait(timeout: .now() + 3) == .success
                        if retireStarted && !probe.isCancelled() {
                            // The mutant must actually complete while held; the real
                            // revoker must remain held through the observation.
                            let observation: DispatchTime = mutant
                                ? .now() + .seconds(3) : .now() + .milliseconds(50)
                            retiredWhileHeld = probe.retiredGate.wait(timeout: observation) == .success
                            if waitForCancellation {
                                probe.markCancellationReady()
                                // Only the independent cancellation thread signals release.
                                // Bounded failure cleanup still releases the signer below.
                                let deadline = DispatchTime.now().uptimeNanoseconds + 3_000_000_000
                                while !probe.isCancelled() && DispatchTime.now().uptimeNanoseconds < deadline {
                                    Thread.sleep(forTimeInterval: 0.005)
                                }
                            }
                        }
                    }
                    // Wake a cancellation helper even when setup failed.
                    if waitForCancellation && !probe.mayCancel() { probe.cancellationReady.signal() }
                    probe.release.signal()
                    let deadline = DispatchTime.now().uptimeNanoseconds + 4_000_000_000
                    var signStopped = signer.isFinished
                    var retireStopped = !retireLaunched
                    if retireLaunched { retireStopped = retire.isFinished }
                    while (!signStopped || !retireStopped) && DispatchTime.now().uptimeNanoseconds < deadline {
                        Thread.sleep(forTimeInterval: 0.005)
                        signStopped = signer.isFinished
                        if retireLaunched { retireStopped = retire.isFinished }
                    }
                    let stopped = signStopped && retireStopped
                    continuation.resume(returning: WorkerResult(
                        entered: entered, retireStarted: retireStarted,
                        retiredWhileHeld: retiredWhileHeld, stopped: stopped))
                }
                coordinator.name = "remi-owned-fence-coordinator"
                probe.setCoordinator(coordinator)
                coordinator.start()
            }
        }
        return await withTaskCancellationHandler {
            if ownedDelayAfterEntryMilliseconds > 0 {
                // Delays the async observer, never the coordinator that owns release.
                _ = await waitUntil { probe.snapshot().entered }
                await delay(milliseconds: ownedDelayAfterEntryMilliseconds)
            }
            let result = await work.value
            let coordinatorStopped = await waitUntil({ probe.coordinatorFinished() }, seconds: 4)
            return WorkerResult(entered: result.entered, retireStarted: result.retireStarted,
                                retiredWhileHeld: result.retiredWhileHeld,
                                stopped: result.stopped && coordinatorStopped)
        } onCancel: {
            probe.cancelAndRelease()
            work.cancel()
        }
    }

    @Test func testControlDelayCannotCauseSignerToEscapeBeforeRetirement() async throws {
        let fence = DirectChildSigningFence(), client = ClientIdentity(), server = ClientIdentity()
        let frame = try challenge(for: server), probe = FenceThreadProbe()
        let result = await runWorkers(fence: fence, client: client, server: server, challenge: frame,
                                      probe: probe, mutant: false, ownedDelayAfterEntryMilliseconds: 3500)
        #expect(result.entered && result.retireStarted && result.stopped)
        #expect(result.retiredWhileHeld == false)
        let response = try #require(probe.snapshot().response)
        let signature = try #require(Data(base64Encoded: response.signature))
        let key = try Curve25519.Signing.PublicKey(rawRepresentation: client.publicKeyRaw)
        #expect(key.isValidSignature(signature, for: Data(repeating: 37, count: 32)))
        #expect(throws: (any Error).self) {
            try fence.withSigning {
                try AuthenticationHandshake.response(to: frame, identity: client,
                    expectedServerPublicKey: server.publicKeyBase64)
            }
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
            await runWorkers(fence: fence, client: client, server: server, challenge: frame,
                             probe: probe, mutant: false, waitForCancellation: true)
        }
        let canceller = Thread {
            if probe.cancellationReady.wait(timeout: .now() + 10) == .success && probe.mayCancel() {
                task.cancel()
            } else {
                probe.cancelAndRelease()
            }
        }
        canceller.name = "remi-owned-fence-canceller"
        canceller.start()
        let result = await task.value
        let cancellerStopped = await waitUntil({ canceller.isFinished }, seconds: 4)
        #expect(probe.mayCancel() && result.retiredWhileHeld == false,
                "Cancellation must reach a revoker blocked behind the signer")
        #expect(cancellerStopped, "The owned cancellation thread must finish")
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
