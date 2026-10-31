import Foundation
import Testing
@testable import RemiKit

@Suite(.serialized) @MainActor struct LocalNoticeForgetCoordinatorTests {
    private func fixture() throws -> (URL, String, UserDefaults, MachineStore, MachineConfigurationStore, LocalNoticeLedger, LocalNoticeLifecycle) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("remi-local-forget-\(UUID())")
        let name = "live.yooz.remi.tests.local-forget." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        let first = MachineEndpoint(host: "192.0.2.10", port: 1234)
        let second = MachineEndpoint(host: "192.0.2.20", port: 1234)
        let store = MachineStore(endpoints: [first, second], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        let profiles = MachineConfigurationStore(key: "synthetic-profiles")
        defaults.set(try JSONEncoder().encode(store.persistableProfiles), forKey: "synthetic-profiles")
        let ledger = try LocalNoticeLedger(directory: directory)
        let keys = try LocalNoticeKeys(root: Data(repeating: 61, count: 32))
        let boundary = LocalNoticeBoundary(authorized: { true }, identifierAvailable: { _ in true }, add: { _ in }, remove: { _ in })
        return (directory, name, defaults, store, profiles, ledger, LocalNoticeLifecycle(ledger: ledger, keys: keys, boundary: boundary))
    }

    @Test func exactProfileRemovalPersistsBeforeThePendingIntentCompletes() throws {
        let (dir, name, defaults, store, profiles, ledger, lifecycle) = try fixture()
        defer { ledger.close(); defaults.removePersistentDomain(forName: name); try? FileManager.default.removeItem(at: dir) }
        let first = try #require(store.machines.first), second = try #require(store.machines.last)
        let coordinator = LocalNoticeForgetCoordinator(store: store, lifecycle: lifecycle, profiles: profiles,
            defaults: defaults, domainName: name, flush: { $0.synchronize() })
        #expect(coordinator.begin(owner: first.pairingLifetime) == .completed)
        #expect(store.machines.map(\.id) == [second.id])
        let data = try #require(defaults.persistentDomain(forName: name)?["synthetic-profiles"] as? Data)
        let saved = try JSONDecoder().decode([MachineRouteProfile].self, from: data)
        #expect(saved == store.persistableProfiles); #expect(saved.count == 1)
        #expect(try ledger.pendingForgetOwners().isEmpty)
        #expect(try ledger.counts().owners == 0)
    }

    @Test func failedWriteKeepsIntentAndCanRetryWithoutDeletingOtherProfile() throws {
        let (dir, name, defaults, store, profiles, ledger, lifecycle) = try fixture()
        defer { ledger.close(); defaults.removePersistentDomain(forName: name); try? FileManager.default.removeItem(at: dir) }
        let first = try #require(store.machines.first), second = try #require(store.machines.last)
        var flushWorks = false, before = 0, after = 0
        let coordinator = LocalNoticeForgetCoordinator(store: store, lifecycle: lifecycle, profiles: profiles,
            defaults: defaults, domainName: name, flush: { _ in flushWorks },
            willRemove: { _ in before += 1 }, didRemove: { _ in after += 1 })
        #expect(coordinator.begin(owner: first.pairingLifetime) == .pending)
        #expect(store.machines.map(\.id) == [second.id]); #expect(try ledger.pendingForgetOwners().count == 1)
        flushWorks = true
        #expect(coordinator.retry(owner: first.pairingLifetime) == .completed)
        #expect(store.machines.map(\.id) == [second.id]); #expect(try ledger.pendingForgetOwners().isEmpty)
        #expect(before == 1 && after == 1)
    }

    @Test func rePairBeforeRetryCannotBeOverwrittenByTheOldPlan() throws {
        let (dir, name, defaults, store, profiles, ledger, lifecycle) = try fixture()
        defer { ledger.close(); defaults.removePersistentDomain(forName: name); try? FileManager.default.removeItem(at: dir) }
        let first = try #require(store.machines.first)
        var flushWorks = false
        let coordinator = LocalNoticeForgetCoordinator(store: store, lifecycle: lifecycle, profiles: profiles,
            defaults: defaults, domainName: name, flush: { _ in flushWorks })
        #expect(coordinator.begin(owner: first.pairingLifetime) == .pending)
        store.addMachine(first.endpoint)
        let newOwner = try #require(store.machines.first { $0.endpoint == first.endpoint }?.pairingLifetime)
        #expect(newOwner != first.pairingLifetime)
        flushWorks = true
        #expect(coordinator.retry(owner: first.pairingLifetime) == .pending)
        #expect(store.machines.contains { $0.pairingLifetime == newOwner })
        #expect(try ledger.pendingForgetOwners().count == 1)
    }

    @Test func corruptSavedProfilesRefuseBeforeAnyProfileOrOwnerMutation() throws {
        let (dir, name, defaults, store, profiles, ledger, lifecycle) = try fixture()
        defer { ledger.close(); defaults.removePersistentDomain(forName: name); try? FileManager.default.removeItem(at: dir) }
        let first = try #require(store.machines.first), previous = store.machines.map(\.id)
        let corrupt = Data("synthetic-corrupt".utf8)
        defaults.set(corrupt, forKey: "synthetic-profiles")
        let coordinator = LocalNoticeForgetCoordinator(store: store, lifecycle: lifecycle, profiles: profiles,
            defaults: defaults, domainName: name, flush: { $0.synchronize() })
        #expect(coordinator.begin(owner: first.pairingLifetime) == .unavailable)
        #expect(store.machines.map(\.id) == previous)
        #expect(defaults.data(forKey: "synthetic-profiles") == corrupt)
        #expect(try ledger.counts().owners == 0)
    }

    @Test func reentrantRePairDuringReadbackKeepsForgetPending() throws {
        let (dir, name, defaults, store, profiles, ledger, lifecycle) = try fixture()
        defer { ledger.close(); defaults.removePersistentDomain(forName: name); try? FileManager.default.removeItem(at: dir) }
        let first = try #require(store.machines.first)
        let coordinator = LocalNoticeForgetCoordinator(store: store, lifecycle: lifecycle, profiles: profiles,
            defaults: defaults, domainName: name, flush: { current in
                store.addMachine(first.endpoint)
                return current.synchronize()
            })
        #expect(coordinator.begin(owner: first.pairingLifetime) == .pending)
        let replacement = try #require(store.machines.first { $0.endpoint == first.endpoint })
        #expect(replacement.pairingLifetime != first.pairingLifetime)
        #expect(try ledger.pendingForgetOwners().count == 1)
    }

    @Test func unseenSavedProfileIsNotOverwrittenByForget() throws {
        let (dir, name, defaults, store, profiles, ledger, lifecycle) = try fixture()
        defer { ledger.close(); defaults.removePersistentDomain(forName: name); try? FileManager.default.removeItem(at: dir) }
        let first = try #require(store.machines.first), previous = store.machines.map(\.id)
        let unseen = MachineRouteProfile(machineID: nil, routes: [MachineEndpoint(host: "192.0.2.30", port: 1234)])
        let saved = try JSONEncoder().encode(store.persistableProfiles + [unseen])
        defaults.set(saved, forKey: "synthetic-profiles")
        let coordinator = LocalNoticeForgetCoordinator(store: store, lifecycle: lifecycle, profiles: profiles,
            defaults: defaults, domainName: name, flush: { $0.synchronize() })
        #expect(coordinator.begin(owner: first.pairingLifetime) == .unavailable)
        #expect(store.machines.map(\.id) == previous)
        #expect(defaults.data(forKey: "synthetic-profiles") == saved)
        #expect(try ledger.counts().owners == 0)
    }

    @Test func unseenSavedProfileSettingsAreNotOverwrittenByForget() throws {
        let (dir, name, defaults, store, profiles, ledger, lifecycle) = try fixture()
        defer { ledger.close(); defaults.removePersistentDomain(forName: name); try? FileManager.default.removeItem(at: dir) }
        let first = try #require(store.machines.first), previous = store.machines.map(\.id)
        var externallyChanged = store.persistableProfiles
        externallyChanged[1].displayName = "Synthetic changed name"
        let saved = try JSONEncoder().encode(externallyChanged)
        defaults.set(saved, forKey: "synthetic-profiles")
        let coordinator = LocalNoticeForgetCoordinator(store: store, lifecycle: lifecycle, profiles: profiles,
            defaults: defaults, domainName: name, flush: { $0.synchronize() })
        #expect(coordinator.begin(owner: first.pairingLifetime) == .unavailable)
        #expect(store.machines.map(\.id) == previous)
        #expect(defaults.data(forKey: "synthetic-profiles") == saved)
        #expect(try ledger.counts().owners == 0)
    }

    @Test func legacyEndpointConfigurationCanStillForgetOneProfile() throws {
        let (dir, name, defaults, store, profiles, ledger, lifecycle) = try fixture()
        defer { ledger.close(); defaults.removePersistentDomain(forName: name); try? FileManager.default.removeItem(at: dir) }
        let first = try #require(store.machines.first), second = try #require(store.machines.last)
        defaults.set(try JSONEncoder().encode(store.persistableEndpoints), forKey: "synthetic-profiles")
        let coordinator = LocalNoticeForgetCoordinator(store: store, lifecycle: lifecycle, profiles: profiles,
            defaults: defaults, domainName: name, flush: { $0.synchronize() })
        #expect(coordinator.begin(owner: first.pairingLifetime) == .completed)
        #expect(store.machines.map(\.id) == [second.id]); #expect(try ledger.pendingForgetOwners().isEmpty)
    }

    @Test func savedPinnedProfileRemainsForgettableAfterStoreRestoresItsPin() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("remi-local-forget-\(UUID())")
        let name = "live.yooz.remi.tests.local-forget." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name); try? FileManager.default.removeItem(at: dir) }
        let publicKey = ClientIdentity().publicKeyRaw
        let saved = MachineRouteProfile(machineID: try MachineIdentityVerifier.machineID(forPublicKey: publicKey),
            routes: [MachineEndpoint(host: "192.0.2.40", port: 1234)], machinePublicKey: RelayCrypto.b64(publicKey))
        let otherKey = ClientIdentity().publicKeyRaw
        let other = MachineRouteProfile(machineID: try MachineIdentityVerifier.machineID(forPublicKey: otherKey),
            routes: [MachineEndpoint(host: "192.0.2.41", port: 1234)], machinePublicKey: RelayCrypto.b64(otherKey))
        defaults.set(try JSONEncoder().encode([saved, other]), forKey: "synthetic-profiles")
        let store = MachineStore(profiles: [saved, other], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        let ledger = try LocalNoticeLedger(directory: dir)
        defer { ledger.close() }
        let keys = try LocalNoticeKeys(root: Data(repeating: 62, count: 32))
        let boundary = LocalNoticeBoundary(authorized: { true }, identifierAvailable: { _ in true }, add: { _ in }, remove: { _ in })
        let lifecycle = LocalNoticeLifecycle(ledger: ledger, keys: keys, boundary: boundary)
        let coordinator = LocalNoticeForgetCoordinator(store: store, lifecycle: lifecycle,
            profiles: .init(key: "synthetic-profiles"), defaults: defaults, domainName: name, flush: { $0.synchronize() })
        let owner = try #require(store.machines.first?.pairingLifetime)
        #expect(coordinator.begin(owner: owner) == .completed)
        #expect(store.machines.count == 1); #expect(store.machines.first?.endpoint.host == "192.0.2.41")
        #expect(try ledger.pendingForgetOwners().isEmpty)
    }
}
