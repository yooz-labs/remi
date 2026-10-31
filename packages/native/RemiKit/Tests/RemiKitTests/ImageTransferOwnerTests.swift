import CryptoKit
import Darwin
import Foundation
import Security
import Testing
@testable import RemiKit
@testable import RemiPush

#if os(macOS)
private actor ImageBeginObservations {
    private var admitted = false
    func receive(_ event: RemiInboundEvent) { if case .hello = event { admitted = true } }
    func isAdmitted() -> Bool { admitted }
}

/// The peer and all files/Keychain items are isolated synthetic fixtures. This exercises the
/// actual composed owner and connection, not a production WSS qualification or real daemon.
@MainActor @Suite(.serialized) struct ImageTransferOwnerTests {
    @Test func unqualifiedDirectSocketCannotBeginOrChangeThePreparedRecord() async throws {
        let parent = FileManager.default.temporaryDirectory.appendingPathComponent("remi-image-begin-\(UUID().uuidString)")
        let root = parent.appendingPathComponent("images")
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: parent) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let parentFD = open(parent.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        let rootFD = open(root.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard parentFD >= 0, rootFD >= 0 else { throw POSIXError(.EIO) }
        defer { close(parentFD); close(rootFD) }
        let service = "live.yooz.remi.tests.image-begin.\(UUID().uuidString)"
        let account = UUID().uuidString
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
        let bytes = Data([1, 2, 3])
        try bytes.write(to: selected)
        let input = open(selected.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        guard input >= 0 else { throw POSIXError(.EIO) }
        defer { close(input) }
        let id = try installation.journal.reserveCopy()
        let copy = try installation.snapshots.capture(id: id, source: input)
        let peer = try OwnedAnswerPeer(mode: "image-ingress")
        peer.start()
        var connection: RemiConnection?
        do {
            let port = try await peer.waitForPort()
            let machineKey = try #require(Data(base64Encoded: peer.pinnedPublicKey))
            let binding = AttachedBinding(harness: .claude, harnessSessionId: "09a9e195-b1af-4bd5-b9bf-e64855b16d36")
            let loaded = try keys.load()
            let key = try #require(loaded)
            let fingerprint = try ImageRecoveryFingerprint.make(secret: key.secret, machineKey: machineKey,
                sessionID: peer.sessionID, binding: binding, imageDigest: copy.digest)
            try installation.journal.finishCopy(id, fingerprint: fingerprint)
            let observations = ImageBeginObservations()
            let client = RemiConnection(configuration: .init(url: try #require(URL(string: "ws://127.0.0.1:\(port)/ws")),
                clientVersion: "owned", clientId: "owned", expectedServerPublicKey: peer.pinnedPublicKey),
                identity: ClientIdentity(), stateHandler: { _ in }, eventHandler: { event in
                    Task { await observations.receive(event) }
                })
            connection = client
            await client.start()
            let deadline = ContinuousClock.now.advanced(by: .seconds(5))
            while ContinuousClock.now < deadline, !(await observations.isAdmitted()) {
                try await Task.sleep(for: .milliseconds(10))
            }
            #expect(await observations.isAdmitted())
            let header = WireHeader(id: UUID().uuidString.lowercased(), timestamp: "2026-10-31T00:00:00.000Z",
                                    sessionId: peer.sessionID)
            let begin = ImageUploadBegin(header: header, binding: binding, mediaType: .png, byteLength: copy.byteCount,
                                         digest: WireGuards.encodeBase64URL(copy.digest))
            let wrong = ImageUploadBegin(header: header, binding: binding, mediaType: .png, byteLength: copy.byteCount,
                                         digest: WireGuards.encodeBase64URL(Data(repeating: 9, count: 32)))
            #expect(throws: (any Error).self) {
                try ImageTransferOwner(installation: installation, connection: client, recordID: id,
                                       begin: wrong, machineKey: machineKey, now: 0)
            }
            let transfer = try ImageTransferOwner(installation: installation, connection: client, recordID: id,
                                                   begin: begin, machineKey: machineKey, now: 0)
            await transfer.begin()
            #expect(transfer.state == .unavailable)
            #expect(peer.snapshot().images == 0)
            #expect(installation.journal.snapshot.records.first?.exposure == .prepared)
            #expect(try Data(contentsOf: selected) == bytes)
            await client.stop()
        } catch {
            await connection?.stop(); #expect(await peer.stop()); throw error
        }
        #expect(await peer.stop())
        try installation.snapshots.abandon(id: id, confirmed: true)
    }
}
#endif
