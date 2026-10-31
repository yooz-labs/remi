import Foundation
import Testing
@testable import RemiKit

private enum OwnedEncodingFailure: Error { case synthetic }

@Suite(.serialized) @MainActor struct LocalNoticeProfilePersistenceTests {
    @Test func failedFlushOrMismatchedReadbackKeepsExactForgetPendingUntilRetry() throws {
        let name = "live.yooz.remi.tests.local-profile." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("remi-profile-forget-\(UUID())")
        defer { defaults.removePersistentDomain(forName: name); try? FileManager.default.removeItem(at: directory) }
        let key = "synthetic-machine-profiles", store = MachineConfigurationStore(key: key)
        let first = MachineRouteProfile(machineID: nil, routes: [MachineEndpoint(host: "192.0.2.10", port: 1234)], displayName: "First")
        let second = MachineRouteProfile(machineID: nil, routes: [MachineEndpoint(host: "192.0.2.20", port: 1234)], displayName: "Second")
        defaults.set(try JSONEncoder().encode([first, second]), forKey: key)
        defaults.set("keep", forKey: "synthetic-unrelated")
        let ledger = try LocalNoticeLedger(directory: directory)
        defer { ledger.close() }
        let owner = Data(repeating: 55, count: 32)
        try ledger.createOwner(owner); try ledger.invalidateOwner(owner)

        #expect(throws: LocalNoticeProfilePersistenceError.unavailable) {
            try store.saveProfilesForLocalForget([second], defaults: defaults, domainName: name, flush: { _ in false })
        }
        #expect(try ledger.pendingForgetOwners() == [owner])
        #expect(throws: LocalNoticeProfilePersistenceError.readbackMismatch) {
            try store.saveProfilesForLocalForget([second], defaults: defaults, domainName: name, flush: { current in
                current.set(Data("synthetic-corrupt".utf8), forKey: key); return true
            })
        }
        #expect(try ledger.pendingForgetOwners() == [owner])
        try store.saveProfilesForLocalForget([second], defaults: defaults, domainName: name, flush: { $0.synchronize() })
        let persisted = try #require(defaults.persistentDomain(forName: name)?[key] as? Data)
        #expect(try JSONDecoder().decode([MachineRouteProfile].self, from: persisted) == [second])
        #expect(defaults.string(forKey: "synthetic-unrelated") == "keep")
        try ledger.finishForget(owner)
        #expect(try ledger.pendingForgetOwners().isEmpty)
    }

    @Test func unreadableSavedConfigurationIsNotOverwrittenByForget() throws {
        let name = "live.yooz.remi.tests.local-profile." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let key = "synthetic-machine-profiles", store = MachineConfigurationStore(key: key)
        let corrupt = Data("not-json".utf8)
        defaults.set(corrupt, forKey: key)
        #expect(throws: LocalNoticeProfilePersistenceError.corruptExisting) {
            try store.saveProfilesForLocalForget([], defaults: defaults, domainName: name, flush: { $0.synchronize() })
        }
        #expect(defaults.data(forKey: key) == corrupt)
    }

    @Test func encodingFailureDoesNotTouchSavedProfiles() throws {
        let name = "live.yooz.remi.tests.local-profile." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let key = "synthetic-machine-profiles", store = MachineConfigurationStore(key: key)
        let previous = try JSONEncoder().encode([MachineRouteProfile(machineID: nil,
            routes: [MachineEndpoint(host: "192.0.2.10", port: 1234)])])
        defaults.set(previous, forKey: key)
        #expect(throws: LocalNoticeProfilePersistenceError.encodingFailed) {
            try store.saveProfilesForLocalForget([], defaults: defaults, domainName: name,
                flush: { $0.synchronize() }, encode: { _ in throw OwnedEncodingFailure.synthetic })
        }
        #expect(defaults.data(forKey: key) == previous)
    }
}
