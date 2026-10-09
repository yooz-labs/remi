import Foundation
import RemiPush
import Security
import Testing
@testable import RemiKit

#if os(macOS)
/// Exact owned CA evaluation only. This adapter is compiled into tests, not apps.
private final class OwnedRelayCA: NSObject, URLSessionDelegate, @unchecked Sendable {
    let certificate: SecCertificate
    init(path: String) throws {
        let pem = try String(contentsOfFile: path, encoding: .utf8)
        let text = pem.replacingOccurrences(of: "-----BEGIN CERTIFICATE-----", with: "")
            .replacingOccurrences(of: "-----END CERTIFICATE-----", with: "")
            .components(separatedBy: .whitespacesAndNewlines).joined()
        let bytes = try #require(Data(base64Encoded: text))
        certificate = try #require(SecCertificateCreateWithData(nil, bytes as CFData))
    }
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              challenge.protectionSpace.host == "127.0.0.1", let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        guard SecTrustSetAnchorCertificates(trust, [certificate] as CFArray) == errSecSuccess,
              SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess,
              SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, "127.0.0.1" as CFString)) == errSecSuccess,
              SecTrustEvaluateWithError(trust, nil) else { completionHandler(.cancelAuthenticationChallenge, nil); return }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
}

@MainActor private final class SecureFixtureIPC {
    let process: Process
    let input: Pipe
    let output: Pipe
    let launchDirectory: URL
    var buffer = Data()
    init(reference: String) throws {
        // Opt-in callers select installed runtimes. The helper requires proxy Bun
        // 1.4.2 and validates its source CLI runtime plus exact owned TLS health.
        let options = ProcessInfo.processInfo.environment
        let proxyRuntime = options["REMI_NATIVE_SECURE_BUN"] ?? "/opt/homebrew/bin/bun"
        let cliRuntime = options["REMI_NATIVE_SECURE_CLI_BUN"] ?? proxyRuntime
        try #require(FileManager.default.isExecutableFile(atPath: proxyRuntime), "REMI_NATIVE_SECURE_BUN must name executable Bun 1.4.2")
        try #require(FileManager.default.isExecutableFile(atPath: cliRuntime), "REMI_NATIVE_SECURE_CLI_BUN must name an executable supported source Bun")
        launchDirectory = FileManager.default.temporaryDirectory.appendingPathComponent("remi-swift-secure-launch-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: launchDirectory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        process = Process(); input = Pipe(); output = Pipe()
        process.executableURL = URL(fileURLWithPath: proxyRuntime)
        process.arguments = [URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Integration/secure-push-fixture.ts").path, reference]
        process.currentDirectoryURL = launchDirectory
        process.environment = ["PATH": "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin", "TMPDIR": "/private/tmp",
            "REVIEW_CLI_BUN": cliRuntime]
        process.standardInput = input; process.standardOutput = output
        // No owner log; helper diagnostics live only in this private test directory.
        let log = launchDirectory.deletingLastPathComponent().appendingPathComponent(launchDirectory.lastPathComponent + ".log")
        FileManager.default.createFile(atPath: log.path, contents: nil, attributes: [.posixPermissions: 0o600])
        process.standardError = try FileHandle(forWritingTo: log)
        try process.run()
        guard fcntl(output.fileHandleForReading.fileDescriptor, F_SETFL, O_NONBLOCK) != -1 else { throw CocoaError(.fileReadUnknown) }
    }
    func send(_ message: [String: String]) throws {
        try input.fileHandleForWriting.write(contentsOf: JSONSerialization.data(withJSONObject: message) + Data([10]))
    }
    func next() async throws -> Data {
        let deadline = ContinuousClock.now.advanced(by: .seconds(35))
        while ContinuousClock.now < deadline {
            if let end = buffer.firstIndex(of: 10) {
                let line = Data(buffer[..<end]); buffer.removeSubrange(...end); return line
            }
            var bytes = [UInt8](repeating: 0, count: 4096)
            let count = Darwin.read(output.fileHandleForReading.fileDescriptor, &bytes, bytes.count)
            if count > 0 { buffer.append(contentsOf: bytes.prefix(count)); guard buffer.count <= 16384 else { throw CocoaError(.fileReadUnknown) } }
            else if count == 0 || (errno != EAGAIN && errno != EINTR) { throw CocoaError(.fileReadUnknown) }
            else { try await Task.sleep(for: .milliseconds(20)) }
        }
        throw CocoaError(.fileReadUnknown)
    }
    func message() async throws -> [String: Any] {
        try #require(JSONSerialization.jsonObject(with: await next()) as? [String: Any])
    }
    func armLoss(id: String) async throws {
        try send(["kind": "lose_result", "requestId": id])
        let response = try await message()
        #expect(response["kind"] as? String == "lost-result-armed")
    }
    func armClientResultStall() async throws {
        try send(["kind": "stall_client_result"])
        let response = try await message()
        try #require(response["kind"] as? String == "client-result-stall-armed", "Owned client stall control must acknowledge before sending")
    }
    func stop() async throws {
        if process.isRunning { try? send(["kind": "stop"]) }
        let deadline = ContinuousClock.now.advanced(by: .seconds(12))
        while process.isRunning, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(25)) }
        if process.isRunning { process.terminate() }
        let termination = ContinuousClock.now.advanced(by: .seconds(12))
        while process.isRunning, ContinuousClock.now < termination { try await Task.sleep(for: .milliseconds(25)) }
        #expect(!process.isRunning)
        #expect(process.terminationStatus == 0)
        try input.fileHandleForWriting.close(); try output.fileHandleForReading.close()
        try FileManager.default.removeItem(at: launchDirectory)
    }
}

/// Scheduling observation only: the real facade opens the original signed
/// terminal carrier exactly at the third durable signature boundary.
private final class OwnedFinalSignatureDismissal: @unchecked Sendable {
    private let lock = NSLock()
    private var carrier: Data?
    private var signatures = 0
    private var verified = false
    func retain(_ bytes: Data) { lock.lock(); carrier = bytes; lock.unlock() }
    func count() -> Int { lock.lock(); defer { lock.unlock() }; return signatures }
    func didVerify() -> Bool { lock.lock(); defer { lock.unlock() }; return verified }
    func observe(push: RemiPushStore, original: VerifiedPushNotification) throws {
        lock.lock(); signatures += 1; let third = signatures == 3; let bytes = carrier; lock.unlock()
        guard third else { return }
        guard let bytes else { throw CocoaError(.fileReadUnknown) }
        let terminal = try push.open(carrier: bytes)
        guard terminal.kind == .dismiss, terminal.collapseID == original.collapseID,
              terminal.revision > original.revision else { throw CocoaError(.fileReadUnknown) }
        lock.lock(); verified = true; lock.unlock()
    }
}

@MainActor
struct NativeSecureSourceIntegrationTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["REMI_NATIVE_SECURE_SOURCE_ROOT"] != nil))
    func shippingNativePairRegisterOpenAndSignedNoReachActualHeldHook() async throws {
        let reference = try #require(ProcessInfo.processInfo.environment["REMI_NATIVE_SECURE_SOURCE_ROOT"])
        let fixture = try SecureFixtureIPC(reference: reference)
        let context = try OwnedIdentityContext(); defer { try? context.cleanup() }
        var store: MachineStore?
        do {
            let offer = try await fixture.message()
            #expect(offer["kind"] as? String == "offer")
            #expect(offer["sourceHead"] as? String == "1e96c688f89409043e17177c1914d8eec247de7e")
            let identity = try context.store.loadOrCreate()
            let endpoint = try MachineEndpoint.pairingOverRelay(#require(offer["token"] as? String))
            let ca = try OwnedRelayCA(path: #require(offer["caCertificatePath"] as? String))
            let session = URLSession(configuration: .ephemeral, delegate: ca, delegateQueue: nil)
            defer { session.invalidateAndCancel() }
            let client = MachineStore(endpoints: [], identity: identity, clientVersion: "owned-native-secure",
                clientId: "owned-device", pushStore: context.push)
            store = client; client.useOwnedTestSession(session)
            client.addMachine(endpoint)
            let compared = try await fixture.message()
            let fingerprint = try #require(compared["fingerprint"] as? String)
            try await until("actual Swift comparison") { client.machines.first?.status == .waitingForRelayConfirmation(fingerprint: fingerprint) }
            #expect(try context.push.completedMachines().isEmpty)
            try fixture.send(["kind": "confirm", "fingerprint": fingerprint, "devicePublicKey": identity.publicKeyBase64])
            try await until("authenticated pairing and native durable trust") {
                client.machines.first?.status == .connected && (try? context.push.completedMachines().count) == 1
            }
            let saved = try #require(client.persistableEndpoints.first)
            // This is an owned OS-boundary token, accepted only by the owned receiver.
            client.updateRelayPushToken(Data(repeating: 0x17, count: 32), environment: "sandbox")
            await client.enableRelayNotifications(on: saved)
            try await until("real secure registration response") { client.relayNotificationNotice == "Relay notifications enabled." }
            client.createSession(on: saved, directory: try #require(offer["directory"] as? String), harness: "claude")
            try await until("actual child") { client.machines.first?.activeSessions.count == 1 }
            try fixture.send(["kind": "question"])
            let carrier = try await question(fixture, push: context.push)
            client.openRelayNotification(carrier: carrier)
            let opened = try #require(client.verifiedRelayNotification)
            #expect(opened.kind == .question)
            #expect(opened.machine.authority == identity.pushAuthority)
            let negative = client.relayNotificationChoices.first { $0.isNo }
            let no = try #require(negative)
            // Real lifecycle race: dictionary is already gone while the broker
            // still retains foreground retirement. The one-shot awaits it.
            client.stop()
            await client.answerRelayNotification(choice: no.value)
            #expect(client.relayNotificationNotice == "Answer delivered.")
            try await denyEffect(fixture, push: context.push)
            #expect(client.connectionGenerations.isEmpty, "A stopped Store never restarts foreground after settlement")

            client.start()
            try await until("foreground after lifecycle stop") { client.machines.first?.status == .connected }
            try fixture.send(["kind": "question"])
            let lostCarrier = try await question(fixture, push: context.push)
            client.openRelayNotification(carrier: lostCarrier)
            let lostNo = try #require(client.relayNotificationChoices.first { $0.isNo })
            client.ownedBeforeNativeSend = { proof in try await fixture.armLoss(id: proof.id) }
            await client.answerRelayNotification(choice: lostNo.value)
            #expect(client.lastRelayAnswerOutcome == "uncertain")
            #expect(client.relayNotificationNotice == "Delivery is uncertain. Check the current session before answering again.")
            try await denyEffect(fixture, push: context.push)
            try fixture.send(["kind": "receipts"])
            let firstReceipt = try await receipts(fixture, push: context.push)
            #expect(firstReceipt["nativeForwards"] as? Int == 1)
            #expect(firstReceipt["lostResults"] as? Int == 1)
            #expect(firstReceipt["gatewayFailures"] as? Int == 0)
            try await Task.sleep(for: .seconds(1))
            try fixture.send(["kind": "receipts"])
            let settledReceipt = try await receipts(fixture, push: context.push)
            #expect(settledReceipt["nativeForwards"] as? Int == 1, "No automatic second ID, nonce, proof, or resend")
            #expect(settledReceipt["lostResults"] as? Int == 1)
            client.ownedBeforeNativeSend = nil

            // Distinct fault: the real hook applies No, while the owned TLS
            // proxy discards all hub-to-Swift bytes after actual READY. This
            // measures the client's own monotonic waiter and total cleanup.
            client.stop()
            try fixture.send(["kind": "question"])
            let timeoutCarrier = try await question(fixture, push: context.push)
            client.openRelayNotification(carrier: timeoutCarrier)
            let timeoutNo = try #require(client.relayNotificationChoices.first { $0.isNo })
            client.ownedBeforeNativeSend = { _ in try await fixture.armClientResultStall() }
            let timeoutBegan = ContinuousClock.now
            await client.answerRelayNotification(choice: timeoutNo.value)
            let elapsed = timeoutBegan.duration(to: .now)
            #expect(elapsed >= .seconds(23), "No correlated client receipt arrived before its own deadline")
            #expect(elapsed < .seconds(25), "Handshake, result wait and socket retirement stay under the total bound")
            #expect(client.lastRelayAnswerOutcome == "uncertain")
            #expect(!client.relayNotificationBusy && client.connectionGenerations.isEmpty)
            try await denyEffect(fixture, push: context.push)
            try fixture.send(["kind": "receipts"])
            let timeoutReceipt = try await receipts(fixture, push: context.push)
            #expect((timeoutReceipt["discardedClientBytes"] as? Int ?? 0) > 0)
            #expect(timeoutReceipt["activeClients"] as? Int == 0, "The actual one-shot socket has retired")
            #expect(timeoutReceipt["clientConnections"] as? Int == timeoutReceipt["clientConnectionsAtStall"] as? Int)
            try await Task.sleep(for: .seconds(1))
            try fixture.send(["kind": "receipts"])
            let timeoutSettled = try await receipts(fixture, push: context.push)
            #expect(timeoutSettled["clientConnections"] as? Int == timeoutReceipt["clientConnections"] as? Int, "No one-shot reconnect or late automatic resend")
            client.ownedBeforeNativeSend = nil
            client.start()
            try await until("foreground restored after uncertainty") { client.machines.first?.status == .connected }
            try fixture.send(["kind": "question"])
            let finalCarrier = try await question(fixture, push: context.push)
            client.openRelayNotification(carrier: finalCarrier)
            let finalOriginal = try #require(client.verifiedRelayNotification)
            let finalGuard = OwnedFinalSignatureDismissal(), finalPush = context.push
            client.ownedBeforeNativeH2 = {
                finalGuard.retain(try await Self.retainDismissAtH2(fixture, original: finalOriginal))
            }
            client.ownedBeforeNativeSignature = { try finalGuard.observe(push: finalPush, original: finalOriginal) }
            await client.answerRelayNotification(choice: no.value)
            #expect(finalGuard.count() == 3, "Worker admission, H2 and final production proof use the same restricted signer")
            #expect(finalGuard.didVerify(), "Actual signed same-collapse higher revision becomes terminal at final signing")
            #expect(client.lastRelayAnswerOutcome == "refused")
            #expect(throws: (any Error).self) { try finalPush.open(carrier: finalCarrier) }
            client.ownedBeforeNativeH2 = nil; client.ownedBeforeNativeSignature = nil

            try await until("foreground after final signing refusal") { client.machines.first?.status == .connected }
            try fixture.send(["kind": "question"])
            let staleCarrier = try await question(fixture, push: context.push)
            client.openRelayNotification(carrier: staleCarrier)
            let stale = try #require(client.verifiedRelayNotification)
            let pushStore = context.push
            client.ownedBeforeNativeH2 = {
                try await Self.cancelAtH2(fixture, push: pushStore, original: stale)
            }
            await client.answerRelayNotification(choice: no.value)
            #expect(client.lastRelayAnswerOutcome == "refused")
            client.ownedBeforeNativeH2 = nil
            #expect(throws: (any Error).self) { try context.push.open(carrier: staleCarrier) }
            #expect(try context.push.completedMachines().count == 1, "Terminal question state does not erase machine trust")

            // An ordinary READY from a persisted public hint never recreates
            // absent capsule authority. Only another explicit Enable can commit it.
            client.stop()
            try context.push.forgetMachine(room: stale.machine.room)
            #expect(!client.restoreRelayNotificationIntent(on: saved))
            client.start()
            try await until("hint-only ordinary READY") { client.machines.first?.status == .connected }
            #expect(try context.push.completedMachines().isEmpty)
            await client.enableRelayNotifications(on: saved)
            try await until("explicit Enable recreates current authenticated trust") {
                client.relayNotificationNotice == "Relay notifications enabled." && (try? context.push.completedMachines().count) == 1
            }

            try await until("foreground before revoke") { client.machines.first?.status == .connected }
            try fixture.send(["kind": "question"])
            let revokedCarrier = try await question(fixture, push: context.push)
            client.openRelayNotification(carrier: revokedCarrier)
            let revokedNo = try #require(client.relayNotificationChoices.first { $0.isNo })
            try fixture.send(["kind": "revoke", "fingerprint": fingerprint])
            let revoked = try await fixture.message()
            try #require(Self.revocationSucceeded(revoked), "Revocation control must succeed before interpreting sender refusal")
            await client.answerRelayNotification(choice: revokedNo.value)
            #expect(client.lastRelayAnswerOutcome == "refused")
            client.stop()
            try await fixture.stop()
        } catch {
            Issue.record("Secure interop status: \(String(describing: store?.machines.first?.status)); notice: \(store?.relayNotificationNotice ?? "none")")
            store?.stop(); try await fixture.stop(); throw error
        }
    }
    static func revocationSucceeded(_ response: [String: Any]) -> Bool {
        response["kind"] as? String == "revoked" && response["success"] as? Bool == true && response["edgeAcknowledged"] as? Bool == true
    }
    private static func cancelAtH2(_ fixture: SecureFixtureIPC, push: RemiPushStore,
                                   original: VerifiedPushNotification) async throws {
        try fixture.send(["kind": "question_cancel"])
        var aborted = false, dismissed = false
        while !aborted || !dismissed {
            let event = try await fixture.message()
            if event["kind"] as? String == "hook-aborted" { aborted = true }
            if event["kind"] as? String == "push" {
                let bytes = try JSONSerialization.data(withJSONObject: #require(event["carrier"]))
                let terminal = try push.open(carrier: bytes)
                if terminal.kind == .dismiss, terminal.collapseID == original.collapseID {
                    #expect(terminal.revision > original.revision); dismissed = true
                }
            }
        }
    }
    private static func retainDismissAtH2(_ fixture: SecureFixtureIPC,
                                          original: VerifiedPushNotification) async throws -> Data {
        try fixture.send(["kind": "question_cancel"])
        var aborted = false, carrier: Data?
        while !aborted || carrier == nil {
            let event = try await fixture.message()
            if event["kind"] as? String == "hook-aborted" { aborted = true }
            if event["kind"] as? String == "push", let raw = event["carrier"] as? [String: Any],
               raw["collapseId"] as? String == original.collapseID {
                // No authority is taken from this outer match. The signature,
                // kind, tuple and higher revision are verified by the real core
                // when the retained bytes enter the final signature boundary.
                carrier = try JSONSerialization.data(withJSONObject: raw)
            }
            try #require(event["kind"] as? String != "effect", "The actual aborted hook cannot produce an answer effect")
        }
        return try #require(carrier)
    }
    @Test func failedControlCannotCountAsSourceRevocationAcceptance() {
        #expect(!Self.revocationSucceeded(["kind": "revoked", "success": false, "edgeAcknowledged": false, "error": "NOT_FOUND"]))
        #expect(!Self.revocationSucceeded(["kind": "revoked", "success": true, "edgeAcknowledged": false]))
        #expect(Self.revocationSucceeded(["kind": "revoked", "success": true, "edgeAcknowledged": true]))
    }
    private func question(_ fixture: SecureFixtureIPC, push: RemiPushStore) async throws -> Data {
        while true {
            let event = try await fixture.message()
            #expect(event["kind"] as? String == "push")
            let carrier = try JSONSerialization.data(withJSONObject: #require(event["carrier"]))
            let opened = try push.open(carrier: carrier)
            if opened.kind == .question { return carrier }
        }
    }
    private func receipts(_ fixture: SecureFixtureIPC, push: RemiPushStore) async throws -> [String: Any] {
        while true {
            let event = try await fixture.message()
            if event["kind"] as? String == "receipts" { return event }
            #expect(event["kind"] as? String == "push")
            _ = try push.open(carrier: JSONSerialization.data(withJSONObject: #require(event["carrier"])))
        }
    }
    private func denyEffect(_ fixture: SecureFixtureIPC, push: RemiPushStore) async throws {
        var event = try await fixture.message()
        while event["kind"] as? String == "push" {
            _ = try push.open(carrier: JSONSerialization.data(withJSONObject: #require(event["carrier"])))
            event = try await fixture.message()
        }
        #expect(event["kind"] as? String == "effect")
        let hook = try #require((event["body"] as? [String: Any])?["hookSpecificOutput"] as? [String: Any])
        #expect((hook["decision"] as? [String: Any])?["behavior"] as? String == "deny")
    }
    private func until(_ label: String, condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(25))
        while ContinuousClock.now < deadline {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(25))
        }
        Issue.record("Timed out: \(label)"); throw CocoaError(.fileReadUnknown)
    }
}
#endif
