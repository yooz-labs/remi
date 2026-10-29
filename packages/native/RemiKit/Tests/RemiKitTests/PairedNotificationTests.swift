import Foundation
import RemiPush
import SQLite3
import Testing
@testable import RemiKit

struct PairedNotificationTests {
    @MainActor @Test func preferencesSurviveCoordinatorRestart() throws {
        let context = try OwnedIdentityContext(); defer { try? context.cleanup() }
        _ = try context.store.loadOrCreate()
        let suite = "live.yooz.remi.tests.notifications.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(false, forKey: NativeNotificationPreferences.questionsKey)
        defaults.set(true, forKey: NativeNotificationPreferences.turnCompleteKey)
        let first = try NativeRelayNotifications(ownedPushStore: context.push, ownedIdentityStore: context.store,
            defaultsSuite: suite, ownedForegroundEndpoints: [])
        first.activate()
        #expect(first.store?.notificationPreferences == .init(questions: false, turnComplete: true))
        defaults.set(true, forKey: NativeNotificationPreferences.questionsKey)
        defaults.set(false, forKey: NativeNotificationPreferences.turnCompleteKey)
        first.notificationPreferencesDidChange()
        #expect(first.store?.notificationPreferences == .init())
        first.background()
        let restored = try NativeRelayNotifications(ownedPushStore: context.push, ownedIdentityStore: context.store,
            defaultsSuite: suite, ownedForegroundEndpoints: [])
        restored.activate()
        #expect(restored.store?.notificationPreferences == .init())
        restored.background()
    }

    @MainActor @Test func anEmptyForegroundSceneRequestsItsTokenWithoutWaitingForTheFirstHost() throws {
        let context = try OwnedIdentityContext(); defer { try? context.cleanup() }
        _ = try context.store.loadOrCreate()
        let suite = "live.yooz.remi.tests.notifications.\(UUID().uuidString)"
        defer { UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite) }
        let coordinator = try NativeRelayNotifications(ownedPushStore: context.push, ownedIdentityStore: context.store,
            defaultsSuite: suite, ownedForegroundEndpoints: [])
        coordinator.activate()
        #expect(coordinator.ownedPushRegistrationRequestCount == 1)
        coordinator.activate()
        #expect(coordinator.ownedPushRegistrationRequestCount == 1)
        coordinator.background()
    }

    @MainActor @Test func offlineRestoredProfilesRemoveNotificationAuthorityBeforeNetworkWork() async throws {
        let context = try OwnedIdentityContext(); defer { try? context.cleanup() }
        let identity = try context.store.loadOrCreate(), machine = ClientIdentity().publicKeyRaw
        let room = RelayCrypto.room(machine), generation = try context.push.generation()
        func install() throws {
            try context.push.commitNotificationMachine(room: room, machinePublicKey: machine, origin: "https://relay.example",
                relayURL: "wss://relay.example", authority: identity.pushAuthority, generation: generation)
        }
        try install()
        let endpoint = MachineEndpoint(host: "review.example", port: 18790, expectedPublicKey: machine.base64EncodedString())
        let profile = MachineRouteProfile(machineID: RelayCrypto.hex(room), routes: [endpoint],
            connectionPreference: .localOnly, machinePublicKey: RelayCrypto.b64(machine))
        let store = MachineStore(profiles: [profile], identity: identity, clientVersion: "owned-offline-revoke",
            clientId: UUID().uuidString.lowercased(), pushStore: context.push)
        #expect(store.machines[0].machineID != RelayCrypto.hex(room))
        #expect(await store.revokePairedNotifications(on: endpoint) == false)
        #expect(try context.push.notificationMachines().isEmpty)
        try install()
        #expect(store.removeMachine(endpoint))
        #expect(try context.push.notificationMachines().isEmpty)
    }

    @MainActor @Test func revokeIntentSurvivesCoordinatorRecreation() async throws {
        let context = try OwnedIdentityContext(); defer { try? context.cleanup() }
        _ = try context.store.loadOrCreate()
        let suite = "live.yooz.remi.tests.notifications.\(UUID().uuidString)"
        defer { UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite) }
        let endpoint = MachineEndpoint(host: "127.0.0.1", port: 18765)
        let first = try NativeRelayNotifications(ownedPushStore: context.push, ownedIdentityStore: context.store,
            defaultsSuite: suite, ownedForegroundEndpoints: [endpoint])
        first.revoke(on: endpoint)
        #expect(first.isDisabled(on: endpoint))
        let restored = try NativeRelayNotifications(ownedPushStore: context.push, ownedIdentityStore: context.store,
            defaultsSuite: suite, ownedForegroundEndpoints: [endpoint])
        #expect(restored.isDisabled(on: endpoint))
        await Task.yield()
    }

    @Test func versionFiveMigrationPreservesFullRelayTrust() throws {
        let context = try OwnedIdentityContext(); defer { try? context.cleanup() }
        let identity = try context.store.loadOrCreate(), machine = ClientIdentity().publicKeyRaw
        let room = RelayCrypto.room(machine), generation = try context.push.generation()
        try context.push.commitMachine(room: room, machinePublicKey: machine, origin: "https://relay.example",
            relayURL: "wss://relay.example", authority: identity.pushAuthority, generation: generation)
        let file = context.directory.appendingPathComponent("public.sqlite")
        var database: OpaquePointer?
        try #require(sqlite3_open(file.path, &database) == SQLITE_OK)
        defer { sqlite3_close(database) }
        try #require(sqlite3_exec(database, "ALTER TABLE machine_trust DROP COLUMN notification_relay_url; PRAGMA user_version=5", nil, nil, nil) == SQLITE_OK)
        let reopened = try RemiPushStore.ownedTestStore(file: file,
            service: "live.yooz.remi.tests.migration.\(UUID().uuidString)", account: UUID().uuidString)
        #expect(try reopened.authority() == identity.pushAuthority)
        #expect(try reopened.generation() == generation)
        #expect(try reopened.completedMachines().count == 1)
        #expect(try reopened.machine(room: room)?.notificationOnly == false)
    }

    @Test func notificationOnlyTrustCannotRestoreAForegroundRelayRoute() throws {
        let context = try OwnedIdentityContext(); defer { try? context.cleanup() }
        let identity = try context.store.loadOrCreate(), machine = ClientIdentity().publicKeyRaw
        let room = RelayCrypto.room(machine), generation = try context.push.generation()
        try context.push.commitNotificationMachine(room: room, machinePublicKey: machine, origin: "https://relay.example",
            relayURL: "wss://relay.example", authority: identity.pushAuthority, generation: generation)
        #expect(try context.push.machine(room: room)?.notificationOnly == true)
        #expect(try context.push.completedMachines().isEmpty)
        #expect(try context.push.notificationMachines().count == 1)
        try context.push.commitMachine(room: room, machinePublicKey: machine, origin: "https://relay.example",
            relayURL: "wss://relay.example", authority: identity.pushAuthority, generation: generation)
        try context.push.commitNotificationMachine(room: room, machinePublicKey: machine, origin: "https://relay.example",
            relayURL: "wss://relay.example", authority: identity.pushAuthority, generation: generation)
        #expect(try context.push.machine(room: room)?.notificationOnly == false)
        #expect(try context.push.completedMachines().count == 1)
        #expect(throws: (any Error).self) {
            try context.push.commitNotificationMachine(room: room, machinePublicKey: machine, origin: "https://other.example",
                relayURL: "wss://other.example", authority: identity.pushAuthority, generation: generation)
        }
    }

    @Test func currentGoldenHostResponsesAndRequestsMatchTheWire() throws {
        let response = try NotificationHostResponse.decode(FixtureConformanceTests.fixture("notification_host_response"))
        #expect(response.success && response.state == "registration_required")
        var golden = try #require(JSONSerialization.jsonObject(with: FixtureConformanceTests.fixture("notification_host_request")) as? [String: Any])
        let encoded = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(NotificationHostRequest(action: "enable"))) as? [String: Any])
        golden["id"] = encoded["id"]; golden["timestamp"] = encoded["timestamp"]
        #expect(NSDictionary(dictionary: golden).isEqual(to: encoded))
        var invalid = try #require(JSONSerialization.jsonObject(with: FixtureConformanceTests.fixture("notification_host_response")) as? [String: Any])
        invalid["token"] = "private"
        #expect(throws: (any Error).self) { try NotificationHostResponse.decode(JSONSerialization.data(withJSONObject: invalid)) }
        invalid.removeValue(forKey: "token"); invalid["relayUrl"] = "ws://relay.example"
        #expect(throws: (any Error).self) { try NotificationHostResponse.decode(JSONSerialization.data(withJSONObject: invalid)) }
    }
}

#if os(macOS)
@MainActor private final class NotificationFixture {
    let process = Process(), input = Pipe(), output = Pipe()
    let directory: URL
    var buffer = Data()
    init(root: String) throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("remi-notification-launch-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        process.executableURL = URL(fileURLWithPath: "/opt/homebrew/bin/bun")
        process.arguments = ["--no-env-file", URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Integration/notification-registration-fixture.ts").path, root]
        process.currentDirectoryURL = directory
        process.environment = ["PATH": "/opt/homebrew/bin:/usr/bin:/bin", "TMPDIR": "/private/tmp"]
        process.standardInput = input; process.standardOutput = output
        let log = directory.appendingPathComponent("stderr.log")
        FileManager.default.createFile(atPath: log.path, contents: nil, attributes: [.posixPermissions: 0o600])
        process.standardError = try FileHandle(forWritingTo: log)
        guard fcntl(input.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1) != -1 else { throw RemiPushError.unavailable }
        guard fcntl(output.fileHandleForReading.fileDescriptor, F_SETFL, O_NONBLOCK) != -1 else { throw RemiPushError.unavailable }
        try process.run()
    }
    func send(_ value: [String: String]) throws { try input.fileHandleForWriting.write(contentsOf: JSONSerialization.data(withJSONObject: value) + Data([10])) }
    func next() async throws -> [String: Any] {
        let until = ContinuousClock.now.advanced(by: .seconds(15))
        while .now < until {
            if let end = buffer.firstIndex(of: 10) {
                let line = Data(buffer[..<end]); buffer.removeSubrange(...end)
                return try #require(JSONSerialization.jsonObject(with: line) as? [String: Any])
            }
            var bytes = [UInt8](repeating: 0, count: 4096)
            let count = Darwin.read(output.fileHandleForReading.fileDescriptor, &bytes, bytes.count)
            if count > 0 { buffer.append(contentsOf: bytes.prefix(count)); guard buffer.count < 16384 else { throw RemiPushError.invalid } }
            else if count == 0 || (errno != EAGAIN && errno != EINTR) { throw RemiPushError.unavailable }
            try await Task.sleep(for: .milliseconds(20))
        }
        throw RemiPushError.unavailable
    }
    func stop() async throws {
        try? send(["kind": "stop"])
        let until = ContinuousClock.now.advanced(by: .seconds(10))
        while process.isRunning, .now < until { try? await Task.sleep(for: .milliseconds(20)) }
        if process.isRunning {
            process.terminate()
            let terminated = ContinuousClock.now.advanced(by: .seconds(3))
            while process.isRunning, .now < terminated { try? await Task.sleep(for: .milliseconds(20)) }
        }
        if process.isRunning {
            Darwin.kill(process.processIdentifier, SIGKILL)
            let killed = ContinuousClock.now.advanced(by: .seconds(3))
            while process.isRunning, .now < killed { try? await Task.sleep(for: .milliseconds(20)) }
        }
        #expect(!process.isRunning && process.terminationStatus == 0)
        guard !process.isRunning else { throw RemiPushError.unavailable }
        try FileManager.default.removeItem(at: directory)
    }
}

@MainActor struct PairedNotificationSourceTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["REMI_NOTIFICATION_SOURCE_ROOT"] != nil))
    func fullRelayUpdatesPreferencesWithoutReplacingForegroundRoute() async throws {
        let fixture = try NotificationFixture(root: #require(ProcessInfo.processInfo.environment["REMI_NOTIFICATION_SOURCE_ROOT"]))
        let context = try OwnedIdentityContext(); defer { try? context.cleanup() }
        let identity = try context.store.loadOrCreate()
        var store: MachineStore?
        do {
            let ready = try await fixture.next()
            let encodedKey = try #require(ready["machineKey"] as? String)
            let key = try #require(Data(base64Encoded: encodedKey))
            let relayURL = try #require(ready["relayUrl"] as? String)
            let port = try #require(URLComponents(string: relayURL)?.port)
            try fixture.send(["kind": "authorize", "publicKey": identity.publicKeyBase64, "full": "yes"])
            #expect(try await fixture.next()["kind"] as? String == "authorized")
            try fixture.send(["kind": "prepare_relay", "publicKey": identity.publicKeyBase64])
            #expect(try await fixture.next()["kind"] as? String == "relay-enrolled")
            let pin = try RelayMachinePin(relayURL: relayURL, machinePublicKey: RelayCrypto.b64(key))
            let endpoint = MachineEndpoint(host: "127.0.0.1", port: port, relayPin: pin)
            let room = RelayCrypto.room(key)
            let authority = identity.pushAuthority
            let generation = try context.push.generation()
            try context.push.commitMachine(room: room, machinePublicKey: key,
                origin: "https://127.0.0.1:\(port)", relayURL: relayURL, authority: authority, generation: generation)
            let profile = MachineRouteProfile(machineID: RelayCrypto.hex(room), routes: [endpoint],
                connectionPreference: .relayOnly, machinePublicKey: RelayCrypto.b64(key))
            let current = MachineStore(profiles: [profile], identity: identity, clientVersion: "owned-relay-preferences",
                clientId: UUID().uuidString.lowercased(), pushStore: context.push)
            store = current
            let session = URLSession(configuration: .ephemeral, delegate: try OwnedRelayCA(path: #require(ready["ca"] as? String)), delegateQueue: nil)
            defer { session.invalidateAndCancel() }
            current.useOwnedTestSession(session)
            #expect(current.restoreRelayNotificationIntent(on: endpoint))
            current.updateRelayPushToken(Data(repeating: 0xab, count: 32), environment: "sandbox")
            current.start()
            let until = ContinuousClock.now.advanced(by: .seconds(12))
            while current.machines[0].status != .connected || current.pairedNotificationState(for: endpoint) != .registered {
                guard .now < until else {
                    try fixture.send(["kind": "state", "expectedToken": String(repeating: "ab", count: 32)])
                    let diagnostic = try await fixture.next()
                    Issue.record("Owned relay log: \(diagnostic["relayLogs"] ?? "none")")
                    Issue.record("Owned application hello count: \(diagnostic["relayHelloCount"] ?? 0)")
                    Issue.record("Owned relay status: \(current.machines[0].status), registration: \(String(describing: current.pairedNotificationState(for: endpoint))), notice: \(current.relayNotificationNotice ?? "none")")
                    throw RemiPushError.unavailable
                }
                try await Task.sleep(for: .milliseconds(20))
            }
            let connections = current.connectionGenerations
            try fixture.send(["kind": "state", "expectedToken": String(repeating: "ab", count: 32)])
            let initial = try await fixture.next()
            #expect((initial["relayHelloCount"] as? Int ?? 0) >= 2)
            #expect(initial["pushPrefs"] as? [String: Bool] == ["questions": true, "turnComplete": false,
                "harnessDenied": false, "turnFailed": false])
            current.updateNotificationPreferences(.init(questions: false, turnComplete: true))
            let deadline = ContinuousClock.now.advanced(by: .seconds(10))
            var actual: [String: Bool]?
            while .now < deadline {
                try fixture.send(["kind": "state", "expectedToken": String(repeating: "ab", count: 32)])
                actual = try await fixture.next()["pushPrefs"] as? [String: Bool]
                if actual == ["questions": false, "turnComplete": true, "harnessDenied": false, "turnFailed": false] { break }
                try await Task.sleep(for: .milliseconds(20))
            }
            #expect(actual == ["questions": false, "turnComplete": true, "harnessDenied": false, "turnFailed": false])
            #expect(current.connectionGenerations == connections)
            #expect(current.machines[0].endpoint == endpoint && current.machines[0].connectionPreference == .relayOnly)
            current.stop(); try await fixture.stop()
        } catch { store?.stop(); try? await fixture.stop(); throw error }
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["REMI_NOTIFICATION_SOURCE_ROOT"] != nil), arguments: [false, true])
    func actualDirectBootstrapRegistersThroughEncryptedScopeAndRequiresContinue(fullEnrollment: Bool) async throws {
        let fixture = try NotificationFixture(root: #require(ProcessInfo.processInfo.environment["REMI_NOTIFICATION_SOURCE_ROOT"]))
        let context = try OwnedIdentityContext(); defer { try? context.cleanup() }
        let identity = try context.store.loadOrCreate()
        var store: MachineStore?
        do {
            let ready = try await fixture.next()
            let port = try #require(ready["directPort"] as? Int), key = try #require(ready["machineKey"] as? String)
            try fixture.send(["kind": "authorize", "publicKey": identity.publicKeyBase64, "full": fullEnrollment ? "yes" : "no"])
            #expect(try await fixture.next()["kind"] as? String == "authorized")
            let endpoint = MachineEndpoint(host: "127.0.0.1", port: port, expectedPublicKey: key)
            let current = MachineStore(endpoints: [endpoint], identity: identity,
                clientVersion: "owned-notification-test", clientId: UUID().uuidString.lowercased(), pushStore: context.push)
            store = current
            let session = URLSession(configuration: .ephemeral, delegate: try OwnedRelayCA(path: #require(ready["ca"] as? String)), delegateQueue: nil)
            defer { session.invalidateAndCancel() }
            current.useOwnedTestSession(session); current.start()
            let until = ContinuousClock.now.advanced(by: .seconds(10))
            while current.machines[0].status != .connected || !current.machines[0].capabilities.contains("notifications") {
                try #require(.now < until); try await Task.sleep(for: .milliseconds(20))
            }
            current.updateRelayPushToken(Data(repeating: 0xab, count: 32), environment: "sandbox")
            current.setConnectionPreference(.localOnly, for: endpoint)
            let reconnected = ContinuousClock.now.advanced(by: .seconds(10))
            while current.machines[0].status != .connected {
                try #require(.now < reconnected); try await Task.sleep(for: .milliseconds(20))
            }
            await current.registerPairedNotifications(on: endpoint)
            #expect(current.pairedNotificationState(for: endpoint) == .registered)
            #expect(current.machines[0].routes == [endpoint])
            #expect(current.machines[0].connectionPreference == .localOnly)
            #expect(try context.push.completedMachines().isEmpty)
            try fixture.send(["kind": "state", "expectedToken": String(repeating: "ab", count: 32)])
            let initial = try await fixture.next()
            #expect(initial["pushPrefs"] as? [String: Bool] == ["questions": true, "turnComplete": false,
                "harnessDenied": false, "turnFailed": false])
            current.updateNotificationPreferences(.init(questions: false, turnComplete: true))
            await current.registerPairedNotifications(on: endpoint)
            try fixture.send(["kind": "state", "expectedToken": String(repeating: "ab", count: 32)])
            let changed = try await fixture.next()
            #expect(changed["pushPrefs"] as? [String: Bool] == ["questions": false, "turnComplete": true,
                "harnessDenied": false, "turnFailed": false])
            #expect(current.machines[0].routes == [endpoint] && current.machines[0].connectionPreference == .localOnly)

            try fixture.send(["kind": "pause_enable"]); _ = try await fixture.next()
            let older = Task { await current.registerPairedNotifications(on: endpoint) }
            #expect(try await fixture.next()["kind"] as? String == "host-waiting")
            current.updateNotificationPreferences(.init())
            try fixture.send(["kind": "release_enable"]); _ = try await fixture.next()
            await older.value
            await current.registerPairedNotifications(on: endpoint)
            try fixture.send(["kind": "state", "expectedToken": String(repeating: "ab", count: 32)])
            let latest = try await fixture.next()
            #expect(latest["pushPrefs"] as? [String: Bool] == ["questions": true, "turnComplete": false,
                "harnessDenied": false, "turnFailed": false])
            current.updateRelayPushToken(Data(repeating: 0xcd, count: 32), environment: "sandbox")
            await current.registerPairedNotifications(on: endpoint)
            try fixture.send(["kind": "state", "expectedToken": String(repeating: "cd", count: 32)])
            #expect(try await fixture.next()["tokenMatches"] as? Bool == true)
            if fullEnrollment {
                try fixture.send(["kind": "expire_at_upgrade"]); _ = try await fixture.next()
                await current.registerPairedNotifications(on: endpoint)
                #expect(current.pairedNotificationState(for: endpoint) == .renewalRequired)
                try fixture.send(["kind": "state"])
                #expect(try await fixture.next()["expiredAtUpgrade"] as? Int == 1)
                await current.registerPairedNotifications(on: endpoint, continueAfterInactivity: true)
                #expect(current.pairedNotificationState(for: endpoint) == .registered)
            }
            try fixture.send(["kind": "expire"]); _ = try await fixture.next()
            await current.registerPairedNotifications(on: endpoint)
            #expect(current.pairedNotificationState(for: endpoint) == .renewalRequired)
            await current.registerPairedNotifications(on: endpoint, continueAfterInactivity: true)
            #expect(current.pairedNotificationState(for: endpoint) == .registered)
            #expect(await current.revokePairedNotifications(on: endpoint))
            #expect(try context.push.notificationMachines().isEmpty)
            try fixture.send(["kind": "state"])
            #expect(try await fixture.next()["count"] as? Int == 0)
            try fixture.send(["kind": "pause_enable"]); _ = try await fixture.next()
            let interrupted = Task { await current.registerPairedNotifications(on: endpoint) }
            #expect(try await fixture.next()["kind"] as? String == "host-waiting")
            current.suspendForegroundConnections()
            await interrupted.value
            #expect(current.pairedNotificationState(for: endpoint) != .registering)
            try fixture.send(["kind": "release_enable"]); _ = try await fixture.next()
            current.start()
            let resumed = ContinuousClock.now.advanced(by: .seconds(10))
            while current.machines[0].status != .connected {
                try #require(.now < resumed); try await Task.sleep(for: .milliseconds(20))
            }
            await current.registerPairedNotifications(on: endpoint)
            #expect(current.pairedNotificationState(for: endpoint) == .registered)
            try fixture.send(["kind": "pause_enable"]); _ = try await fixture.next()
            let lateRegistration = Task { await current.registerPairedNotifications(on: endpoint) }
            #expect(try await fixture.next()["kind"] as? String == "host-waiting")
            #expect(current.removeMachine(endpoint))
            try fixture.send(["kind": "release_enable"]); _ = try await fixture.next()
            await lateRegistration.value
            #expect(try context.push.notificationMachines().isEmpty)
            current.stop(); try await fixture.stop()
        } catch { store?.stop(); try? await fixture.stop(); throw error }
    }
}
#endif
