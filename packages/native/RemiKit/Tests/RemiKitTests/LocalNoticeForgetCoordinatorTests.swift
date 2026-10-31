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
    }

    @Test func failedWriteKeepsIntentAndCanRetryWithoutDeletingOtherProfile() throws {
        let (dir, name, defaults, store, profiles, ledger, lifecycle) = try fixture()
        defer { ledger.close(); defaults.removePersistentDomain(forName: name); try? FileManager.default.removeItem(at: dir) }
        let first = try #require(store.machines.first), second = try #require(store.machines.last)
        var flushWorks = false
        let coordinator = LocalNoticeForgetCoordinator(store: store, lifecycle: lifecycle, profiles: profiles,
            defaults: defaults, domainName: name, flush: { _ in flushWorks })
        #expect(coordinator.begin(owner: first.pairingLifetime) == .pending)
        #expect(store.machines.map(\.id) == [second.id]); #expect(try ledger.pendingForgetOwners().count == 1)
        flushWorks = true
        #expect(coordinator.retry(owner: first.pairingLifetime) == .completed)
        #expect(store.machines.map(\.id) == [second.id]); #expect(try ledger.pendingForgetOwners().isEmpty)
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
}
