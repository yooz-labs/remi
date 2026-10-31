import CryptoKit
import Darwin
import Foundation
import Security
import Testing
@testable import RemiKit
@testable import RemiPush

#if os(macOS) && DEBUG
private actor OwnedImageSendGate {
    var entered = false
    var released = false
    func hold() async throws {
        entered = true
        while !released { try await Task.sleep(for: .milliseconds(5)) }
    }
    func release() { released = true }
}

@MainActor @Suite(.serialized) struct ImageBeginSourceTLSTests {
    private enum Failure: Error { case deadline }

    @Test(arguments: [("fixture.png", "insert"), ("fixture.jpg", "insert"), ("fixture.png", "cancel"),
                      ("fixture.png", "stale"), ("fixture.png", "disconnect"), ("fixture.png", "timeout")])
    func ownedSourceStagesAndExplicitlyInsertsImageWithoutEnter(_ scenario: (String, String)) async throws {
        let (filename, mode) = scenario
        let tests = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let script = tests.appendingPathComponent("Integration/image-staging-source-fixture.ts")
        let repository = tests.deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let bytes = try Data(contentsOf: repository.appendingPathComponent("scripts/tunnel-decoder-proof/\(filename)"))
        let identity = ClientIdentity()
        let process = Process()
        let own = try OwnedRecoveryFixture.configure(process, script: script,
            arguments: [identity.publicIdentity.publicKey], bunExecutable: ProcessInfo.processInfo.environment["REMI_DELIVERY_BUN"])
        let input = Pipe(), output = Pipe()
        guard fcntl(input.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1) == 0 else { throw POSIXError(.EIO) }
        let log = own.appendingPathComponent("image-staging-source.log")
        FileManager.default.createFile(atPath: log.path, contents: nil)
        let errors = try FileHandle(forWritingTo: log)
        process.standardInput = input; process.standardOutput = output; process.standardError = errors
        try process.run()
        let watchdog = Task {
            try? await Task.sleep(for: .seconds(60))
            if !Task.isCancelled, process.isRunning { process.terminate() }
        }
        defer { watchdog.cancel() }
        var connection: RemiConnection?
        var testSession: URLSession?
        func stop() async {
            await connection?.stop()
            testSession?.invalidateAndCancel()
            if process.isRunning { try? input.fileHandleForWriting.write(contentsOf: Data("stop\n".utf8)) }
            try? input.fileHandleForWriting.close()
            let deadline = ContinuousClock.now.advanced(by: .seconds(8))
            while process.isRunning, ContinuousClock.now < deadline { try? await Task.sleep(for: .milliseconds(20)) }
            if process.isRunning { process.terminate() }
            let end = ContinuousClock.now.advanced(by: .seconds(3))
            while process.isRunning, ContinuousClock.now < end { try? await Task.sleep(for: .milliseconds(20)) }
            #expect(!process.isRunning)
            try? errors.close()
        }
        do {
            let ready = try #require(JSONSerialization.jsonObject(with: await Self.readLine(output.fileHandleForReading)) as? [String: Any])
            let port = try #require(ready["port"] as? Int)
            let sessionID = try #require(ready["sessionId"] as? String)
            let bindingID = try #require(ready["bindingId"] as? String)
            let publicKey = try #require(ready["publicKey"] as? String)
            let machineKey = try #require(Data(base64Encoded: publicKey))
            let ca = try OwnedRelayCA(path: #require(ready["certPath"] as? String))
            let session = URLSession(configuration: .ephemeral, delegate: ca, delegateQueue: nil)
            testSession = session
            let client = RemiConnection(configuration: .init(url: try #require(URL(string: "wss://127.0.0.1:\(port)/ws")),
                clientVersion: "owned", clientId: "owned", expectedServerPublicKey: publicKey), identity: identity,
                stateHandler: { _ in }, eventHandler: { _ in })
            connection = client
            try await client.useOwnedTestSession(session)
            try await client.enableOwnedImageFixture()
            await client.start()
            let header = WireHeader(id: UUID().uuidString.lowercased(), timestamp: "2026-10-31T00:00:00.000Z", sessionId: sessionID)
            let binding = AttachedBinding(harness: .claude, harnessSessionId: bindingID)
            let begin = ImageUploadBegin(header: header, binding: binding, mediaType: filename.hasSuffix(".png") ? .png : .jpeg,
                byteLength: bytes.count, digest: WireGuards.encodeBase64URL(Data(SHA256.hash(data: bytes))))
            try await until { await client.imageBeginAuthority(for: begin, machineKey: machineKey) != nil }
            try await withPreparedInstallation(payload: bytes, begin: begin, machineKey: machineKey) { installation, record in
                let transfer = try ImageTransferOwner(installation: installation, connection: client, recordID: record,
                                                       begin: begin, machineKey: machineKey, now: 0)
                await transfer.begin()
                let deadline = ContinuousClock.now.advanced(by: .seconds(20))
                while ContinuousClock.now < deadline {
                    await transfer.refresh()
                    switch transfer.state {
                    case .awaitingChunk: await transfer.sendNextChunk()
                    case .readyForComplete: await transfer.complete()
                    case .staged: break
                    case .refused, .uncertain, .notInvokedCleanupPending: throw Failure.deadline
                    default: break
                    }
                    if case .staged = transfer.state { break }
                    try await Task.sleep(for: .milliseconds(10))
                }
                guard case .staged(let stagedExpiry) = transfer.state else { throw Failure.deadline }
                let observed = try await stats(input: input, output: output)
                #expect(observed["begins"] as? Int == 1)
                #expect(observed["chunks"] as? Int == (bytes.count + ImageStagingLimits.chunkBytes - 1) / ImageStagingLimits.chunkBytes)
                #expect(observed["completes"] as? Int == 1)
                #expect(observed["staged"] as? Int == 1)
                #expect(installation.journal.snapshot.localSnapshotID == nil)
                if mode == "cancel" {
                    let cancelGate = OwnedImageSendGate()
                    try await client.ownedSetImageBeforeSend { try await cancelGate.hold() }
                    let inserting = Task { await transfer.addToDraft() }
                    do { try await until { await cancelGate.entered } }
                    catch { await cancelGate.release(); await inserting.value; throw error }
                    transfer.cancel()
                    #expect(transfer.state == .insertionUncertain(expiry: stagedExpiry))
                    await cancelGate.release()
                    await inserting.value
                    try await client.ownedSetImageBeforeSend(nil)
                    await transfer.addToDraft()
                    let cancelled = try await stats(input: input, output: output)
                    #expect(cancelled["insertions"] as? Int == 0)
                    #expect(cancelled["outputBytes"] as? Int == 0)
                    #expect(installation.journal.snapshot.records.first?.exposure == .insertionUncertain(expiry: stagedExpiry))
                    return
                }
                if mode == "stale" {
                    try input.fileHandleForWriting.write(contentsOf: Data("rotate-binding\n".utf8))
                    let rotated = try #require(JSONSerialization.jsonObject(with: await Self.readLine(output.fileHandleForReading)) as? [String: Any])
                    #expect(rotated["rotated"] as? Bool == true)
                    await transfer.addToDraft()
                    try await until {
                        await transfer.refresh()
                        if case .insertionRefused = transfer.state { return true }
                        return false
                    }
                    #expect(transfer.state == .insertionRefused(.bindingChanged, expiry: stagedExpiry))
                    await transfer.addToDraft()
                    let refused = try await stats(input: input, output: output)
                    #expect(refused["insertions"] as? Int == 1)
                    #expect(refused["outputBytes"] as? Int == 0)
                    #expect(installation.journal.snapshot.records.first?.exposure == .insertionRefusedAwaitingOrigin(expiry: stagedExpiry))
                    return
                }
                if mode == "disconnect" {
                    await client.stop()
                    await transfer.addToDraft()
                    #expect(transfer.state == .insertionUncertain(expiry: stagedExpiry))
                    await transfer.addToDraft()
                    let disconnected = try await stats(input: input, output: output)
                    #expect(disconnected["insertions"] as? Int == 0)
                    #expect(disconnected["outputBytes"] as? Int == 0)
                    #expect(installation.journal.snapshot.records.first?.exposure == .insertionUncertain(expiry: stagedExpiry))
                    return
                }
                if mode == "timeout" {
                    try input.fileHandleForWriting.write(contentsOf: Data("drop-insertion-result\n".utf8))
                    let armed = try #require(JSONSerialization.jsonObject(with: await Self.readLine(output.fileHandleForReading)) as? [String: Any])
                    #expect(armed["dropArmed"] as? Bool == true)
                    await transfer.addToDraft()
                    let timeout = ContinuousClock.now.advanced(by: .seconds(20))
                    while ContinuousClock.now < timeout {
                        await transfer.refresh()
                        if case .insertionUncertain = transfer.state { break }
                        try await Task.sleep(for: .milliseconds(50))
                    }
                    #expect(transfer.state == .insertionUncertain(expiry: stagedExpiry))
                    await transfer.addToDraft()
                    let lost = try await stats(input: input, output: output)
                    #expect(lost["insertions"] as? Int == 1)
                    #expect(lost["referenceOnly"] as? Bool == true)
                    #expect(lost["containsNewline"] as? Bool == false)
                    #expect(lost["droppedInsertionResults"] as? Int == 1)
                    #expect(installation.journal.snapshot.records.first?.exposure == .insertionUncertain(expiry: stagedExpiry))
                    #expect(installation.journal.snapshot.localSnapshotID == nil)
                    return
                }
                let insertionReturn = OwnedImageSendGate()
                try await client.ownedSetImageAfterSend { try await insertionReturn.hold() }
                let inserting = Task { await transfer.addToDraft() }
                do {
                    try await until { await insertionReturn.entered }
                    let captured = await client.imageBeginAuthority(for: begin, machineKey: machineKey)
                    let authority = try #require(captured)
                    try await until {
                        await client.imageInsertionProgress(authority: authority) ==
                            .inserted(expiry: stagedExpiry, artifactExpired: false)
                    }
                } catch {
                    await insertionReturn.release()
                    await inserting.value
                    throw error
                }
                await insertionReturn.release()
                await inserting.value
                try await client.ownedSetImageAfterSend(nil)
                let insertionDeadline = ContinuousClock.now.advanced(by: .seconds(15))
                while ContinuousClock.now < insertionDeadline {
                    await transfer.refresh()
                    if case .inserted = transfer.state { break }
                    if case .insertionUncertain = transfer.state { throw Failure.deadline }
                    try await Task.sleep(for: .milliseconds(10))
                }
                guard case .inserted(let expiry) = transfer.state else { throw Failure.deadline }
                try await until { try await stats(input: input, output: output)["referenceOnly"] as? Bool == true }
                let inserted = try await stats(input: input, output: output)
                #expect(inserted["insertions"] as? Int == 1)
                #expect(inserted["referenceOnly"] as? Bool == true)
                #expect(inserted["containsNewline"] as? Bool == false)
                let outputBytes = try #require(inserted["outputBytes"] as? Int)
                await transfer.addToDraft() // An explicit second tap must not replay the effect.
                let repeated = try await stats(input: input, output: output)
                #expect(repeated["insertions"] as? Int == 1)
                #expect(repeated["outputBytes"] as? Int == outputBytes)
                #expect(installation.journal.snapshot.records.first?.exposure == .insertionConfirmed(expiry: expiry))
            }
            await stop()
        } catch {
            print("Owned staging fixture failed; inspect \(log.path)")
            await stop()
            throw error
        }
    }

    @Test func ownedWSSBeginHonorsCancellationAndSocketReplacement() async throws {
        let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Integration/delivery-source-fixture.ts")
        let identity = ClientIdentity()
        let process = Process()
        let own = try OwnedRecoveryFixture.configure(process, script: script,
            arguments: ["image-tls", identity.publicIdentity.publicKey],
            bunExecutable: ProcessInfo.processInfo.environment["REMI_DELIVERY_BUN"])
        let input = Pipe(), output = Pipe()
        guard fcntl(input.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1) == 0 else { throw POSIXError(.EIO) }
        let log = own.appendingPathComponent("image-tls-source.log")
        FileManager.default.createFile(atPath: log.path, contents: nil)
        let errors = try FileHandle(forWritingTo: log)
        process.standardInput = input; process.standardOutput = output; process.standardError = errors
        try process.run()
        let watchdog = Task {
            try? await Task.sleep(for: .seconds(45))
            if !Task.isCancelled, process.isRunning { process.terminate() }
        }
        defer { watchdog.cancel() }
        var connection: RemiConnection?
        var testSession: URLSession?
        func stop() async {
            await connection?.stop()
            testSession?.invalidateAndCancel()
            if process.isRunning { try? input.fileHandleForWriting.write(contentsOf: Data("stop\n".utf8)) }
            try? input.fileHandleForWriting.close()
            let deadline = ContinuousClock.now.advanced(by: .seconds(5))
            while process.isRunning, ContinuousClock.now < deadline { try? await Task.sleep(for: .milliseconds(20)) }
            if process.isRunning { process.terminate() }
            let end = ContinuousClock.now.advanced(by: .seconds(3))
            while process.isRunning, ContinuousClock.now < end { try? await Task.sleep(for: .milliseconds(20)) }
            #expect(!process.isRunning)
            try? errors.close()
        }
        do {
            let ready = try #require(JSONSerialization.jsonObject(with: await Self.readLine(output.fileHandleForReading)) as? [String: Any])
            let port = try #require(ready["port"] as? Int)
            let sessionID = try #require(ready["sessionId"] as? String)
            let bindingID = try #require(ready["imageBinding"] as? String)
            let publicKey = try #require(ready["publicKey"] as? String)
            let machineKey = try #require(Data(base64Encoded: publicKey))
            let ca = try OwnedRelayCA(path: #require(ready["certPath"] as? String))
            let session = URLSession(configuration: .ephemeral, delegate: ca, delegateQueue: nil)
            testSession = session
            let client = RemiConnection(configuration: .init(url: try #require(URL(string: "wss://127.0.0.1:\(port)/ws")),
                clientVersion: "owned", clientId: "owned", expectedServerPublicKey: publicKey), identity: identity,
                stateHandler: { _ in }, eventHandler: { _ in })
            connection = client
            try await client.useOwnedTestSession(session)
            try await client.enableOwnedImageFixture()
            await client.start()
            let header = WireHeader(id: UUID().uuidString.lowercased(), timestamp: "2026-10-31T00:00:00.000Z", sessionId: sessionID)
            let binding = AttachedBinding(harness: .claude, harnessSessionId: bindingID)
            let payload = Data([1, 2, 3])
            let digest = Data(SHA256.hash(data: payload))
            let begin = ImageUploadBegin(header: header, binding: binding, mediaType: .png, byteLength: payload.count,
                                         digest: WireGuards.encodeBase64URL(digest))
            try await until { await client.imageBeginAuthority(for: begin, machineKey: machineKey) != nil }
            let initial = await client.imageBeginAuthority(for: begin, machineKey: machineKey)
            let authority = try #require(initial)
            let wrongBinding = AttachedBinding(harness: .claude, harnessSessionId: "different-owned-binding")
            let wrong = ImageUploadBegin(header: header, binding: wrongBinding, mediaType: .png, byteLength: payload.count,
                                         digest: WireGuards.encodeBase64URL(digest))
            #expect(await client.imageBeginAuthority(for: wrong, machineKey: machineKey) == nil)
            #expect(await client.imageBeginAuthority(for: begin, machineKey: Data(repeating: 7, count: 32)) == nil)

            let cancelGate = OwnedImageSendGate()
            try await client.ownedSetImageBeforeSend { try await cancelGate.hold() }
            let cancelledTicket = ImageEffectTicket()
            let cancelled = Task { await client.sendImageBegin(begin, authority: authority, ticket: cancelledTicket) }
            try await until { await cancelGate.entered }
            #expect(cancelledTicket.retire() == .noEffect)
            await cancelGate.release()
            #expect(await cancelled.value == .notInvoked)
            #expect(try await stats(input: input, output: output)["images"] as? Int == 0)

            let replaceGate = OwnedImageSendGate()
            try await client.ownedSetImageBeforeSend { try await replaceGate.hold() }
            let staleTicket = ImageEffectTicket()
            let stale = Task { await client.sendImageBegin(begin, authority: authority, ticket: staleTicket) }
            try await until { await replaceGate.entered }
            await client.stop()
            await client.start()
            try await until {
                guard let current = await client.imageBeginAuthority(for: begin, machineKey: machineKey) else { return false }
                return current != authority
            }
            await replaceGate.release()
            #expect(await stale.value == .notInvoked)
            #expect(try await stats(input: input, output: output)["images"] as? Int == 0)
            try await client.ownedSetImageBeforeSend(nil)

            // Real source server, real WSS and the composed storage owner; only a begin frame
            // is exercised. No image bytes or Claude insertion are asserted by this fixture.
            try await withPreparedInstallation(payload: payload, begin: begin, machineKey: machineKey) { installation, record in
                let transfer = try ImageTransferOwner(installation: installation, connection: client, recordID: record,
                                                       begin: begin, machineKey: machineKey, now: 0)
                let returnGate = OwnedImageSendGate()
                try await client.ownedSetImageAfterSend { try await returnGate.hold() }
                let sending = Task { await transfer.begin() }
                try await until { await returnGate.entered }
                let current = await client.imageBeginAuthority(for: begin, machineKey: machineKey)
                let currentAuthority = try #require(current)
                try await until {
                    await client.imageBeginProgress(authority: currentAuthority) == .refused(.unavailable, remoteCleanupUnconfirmed: true)
                }
                await returnGate.release()
                await sending.value
                #expect(transfer.state == .refused(.unavailable, remoteCleanupUnconfirmed: true))
                await transfer.begin() // Refusal is never automatically replayed.
                try await until { try await stats(input: input, output: output)["images"] as? Int == 1 }
                #expect(try await stats(input: input, output: output)["images"] as? Int == 1)
                #expect(installation.journal.snapshot.records.first?.exposure == .partialPossible)
                try installation.snapshots.abandon(id: record, confirmed: true)
            }
            await stop()
        } catch {
            await stop()
            throw error
        }
    }

    private func stats(input: Pipe, output: Pipe) async throws -> [String: Any] {
        try input.fileHandleForWriting.write(contentsOf: Data("stats\n".utf8))
        return try #require(JSONSerialization.jsonObject(with: await Self.readLine(output.fileHandleForReading)) as? [String: Any])
    }

    private nonisolated static func readLine(_ handle: FileHandle) async throws -> Data {
        try await Task.detached {
            var data = Data()
            while data.count < 4096, let part = try handle.read(upToCount: 1), let byte = part.first {
                if byte == 10 { return data }
                data.append(byte)
            }
            throw Failure.deadline
        }.value
    }

    private func until(_ condition: () async throws -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while ContinuousClock.now < deadline {
            if try await condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw Failure.deadline
    }

    private func withPreparedInstallation(payload: Data, begin: ImageUploadBegin, machineKey: Data,
                                          _ body: @MainActor (ImageInstallationOwner, UUID) async throws -> Void) async throws {
        let parent = FileManager.default.temporaryDirectory.appendingPathComponent("remi-image-tls-\(UUID().uuidString)")
        let root = parent.appendingPathComponent("images")
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: parent) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let parentFD = open(parent.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        let rootFD = open(root.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard parentFD >= 0, rootFD >= 0 else { throw POSIXError(.EIO) }
        defer { close(parentFD); close(rootFD) }
        let service = "live.yooz.remi.tests.image-tls.\(UUID().uuidString)", account = UUID().uuidString
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: service, kSecAttrAccount as String: account]
        defer {
            let status = SecItemDelete(query as CFDictionary)
            #expect(status == errSecSuccess || status == errSecItemNotFound)
        }
        let system = NativeKeychainOperations.system
        func redirected(_ input: CFDictionary) -> CFDictionary {
            var values = input as! [String: Any]
            values.removeValue(forKey: kSecAttrAccessGroup as String)
            values.removeValue(forKey: kSecUseDataProtectionKeychain as String)
            return values as CFDictionary
        }
        let operations = NativeKeychainOperations(copyMatching: { system.copyMatching(redirected($0), $1) },
            add: { system.add(redirected($0), $1) }, update: { system.update(redirected($0), $1) })
        let lease = try ImageDirectoryLease(parent: parentFD, rootName: "images", directory: rootFD)
        let keys = ImageInstallationKeyStore(lease: lease, accessGroup: "owned", service: service,
                                             account: account, operations: operations)
        let installation = try ImageInstallationOwner.open(lease: lease, keys: keys)
        let selected = parent.appendingPathComponent("synthetic")
        try payload.write(to: selected)
        let source = open(selected.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        guard source >= 0 else { throw POSIXError(.EIO) }
        defer { close(source) }
        let id = try installation.journal.reserveCopy()
        let copy = try installation.snapshots.capture(id: id, source: source)
        let loaded = try keys.load()
        let key = try #require(loaded)
        let fingerprint = try ImageRecoveryFingerprint.make(secret: key.secret, machineKey: machineKey,
            sessionID: begin.header.sessionId, binding: begin.binding, imageDigest: copy.digest)
        try installation.journal.finishCopy(id, fingerprint: fingerprint)
        try await body(installation, id)
    }
}
#endif
