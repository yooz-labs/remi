import Foundation
import Testing
@testable import RemiKit

@Suite(.serialized) @MainActor struct LocalNoticeSentinelTests {
    @Test func freshSentinelIsEstablishedWithoutTouchingOtherPreferences() throws {
        let name = "live.yooz.remi.tests.local-sentinel." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set("keep", forKey: "synthetic-unrelated")
        let sentinel = LocalNoticeSentinel(defaults: defaults, domainName: name)
        defaults.register(defaults: [LocalNoticeSentinel.storageKey: "local-notice-journal-v1"])
        #expect(sentinel.read() == .absent)
        try sentinel.establish()
        #expect(sentinel.read() == .present)
        #expect(defaults.string(forKey: "synthetic-unrelated") == "keep")
        try sentinel.establish()
        #expect(sentinel.read() == .present)
    }

    @Test func unknownSentinelIsNotOverwrittenAsFresh() throws {
        let name = "live.yooz.remi.tests.local-sentinel." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set("synthetic-future-schema", forKey: LocalNoticeSentinel.storageKey)
        let sentinel = LocalNoticeSentinel(defaults: defaults, domainName: name)
        #expect(sentinel.read() == .invalid)
        #expect(throws: LocalNoticeBootstrap.Failure.recoveryRequired) { try sentinel.establish() }
        #expect(defaults.string(forKey: LocalNoticeSentinel.storageKey) == "synthetic-future-schema")
    }

    @Test func failedFlushCannotBeTreatedAsEstablishedOnRetry() throws {
        let name = "live.yooz.remi.tests.local-sentinel." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        var succeeds = false, flushes = 0
        let sentinel = LocalNoticeSentinel(defaults: defaults, domainName: name, flush: { _ in flushes += 1; return succeeds })
        #expect(throws: LocalNoticeBootstrap.Failure.unavailable) { try sentinel.establish() }
        #expect(throws: LocalNoticeBootstrap.Failure.unavailable) { try sentinel.establish() }
        succeeds = true
        try sentinel.establish()
        #expect(flushes == 3); #expect(sentinel.read() == .present)
    }
}
