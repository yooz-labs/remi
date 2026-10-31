import Foundation
import Testing
@testable import RemiKit

private enum OwnedEncodingFailure: Error { case synthetic }

@Suite(.serialized) @MainActor struct LocalNoticeProfilePersistenceTests {
    @Test func failedFlushKeepsExactForgetPendingUntilSamePlanRetries() throws {
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
        let plan = try store.prepareLocalForgetProfiles([second], defaults: defaults, domainName: name)
        #expect(throws: LocalNoticeProfilePersistenceError.unavailable) {
            try store.commitLocalForgetProfiles(plan, defaults: defaults, flush: { _ in false })
        }
        #expect(try ledger.pendingForgetOwners() == [owner])
        try store.commitLocalForgetProfiles(plan, defaults: defaults, flush: { $0.synchronize() })
        let persisted = try #require(defaults.persistentDomain(forName: name)?[key] as? Data)
        #expect(try JSONDecoder().decode([MachineRouteProfile].self, from: persisted) == [second])
        #expect(defaults.string(forKey: "synthetic-unrelated") == "keep")
        try ledger.finishForget(owner)
        #expect(try ledger.pendingForgetOwners().isEmpty)
    }

    @Test func readbackMismatchAndConcurrentProfileChangeAreNeverOverwrittenOnRetry() throws {
        let name = "live.yooz.remi.tests.local-profile." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("remi-profile-forget-\(UUID())")
        defer { defaults.removePersistentDomain(forName: name); try? FileManager.default.removeItem(at: directory) }
        let key = "synthetic-machine-profiles", store = MachineConfigurationStore(key: key)
        let first = MachineRouteProfile(machineID: nil, routes: [MachineEndpoint(host: "192.0.2.10", port: 1234)])
        let other = MachineRouteProfile(machineID: nil, routes: [MachineEndpoint(host: "192.0.2.30", port: 1234)])
        defaults.set(try JSONEncoder().encode([first]), forKey: key)
        let ledger = try LocalNoticeLedger(directory: directory)
        defer { ledger.close() }
        let owner = Data(repeating: 56, count: 32)
        try ledger.createOwner(owner); try ledger.invalidateOwner(owner)
        let plan = try store.prepareLocalForgetProfiles([], defaults: defaults, domainName: name)
        let concurrent = try JSONEncoder().encode([other])
        #expect(throws: LocalNoticeProfilePersistenceError.readbackMismatch) {
            try store.commitLocalForgetProfiles(plan, defaults: defaults, flush: { current in
                current.set(concurrent, forKey: key); return true
            })
        }
        #expect(throws: LocalNoticeProfilePersistenceError.changed) {
            try store.commitLocalForgetProfiles(plan, defaults: defaults, flush: { $0.synchronize() })
        }
        #expect(defaults.data(forKey: key) == concurrent)
        #expect(try ledger.pendingForgetOwners() == [owner])
    }

    @Test func unreadableSavedConfigurationIsNotOverwrittenByForget() throws {
        let name = "live.yooz.remi.tests.local-profile." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let key = "synthetic-machine-profiles", store = MachineConfigurationStore(key: key)
        let corrupt = Data("not-json".utf8)
        defaults.set(corrupt, forKey: key)
        #expect(throws: LocalNoticeProfilePersistenceError.corruptExisting) {
            try store.prepareLocalForgetProfiles([], defaults: defaults, domainName: name)
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
            try store.prepareLocalForgetProfiles([], defaults: defaults, domainName: name,
                encode: { _ in throw OwnedEncodingFailure.synthetic })
        }
        #expect(defaults.data(forKey: key) == previous)
    }
}
