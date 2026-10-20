import Foundation
import Testing
@testable import RemiPush

struct NativeAppGroupTests {
    @Test func sharedContainerUsesThePlatformGroup() throws {
        let (bundle, directory) = try makeBundle(accessGroup: "9DQ459HAZB.live.yooz.remi.secure-push")
        defer { try? FileManager.default.removeItem(at: directory) }
        #if os(macOS)
        #expect(try RemiPushStore.configuredApplicationGroup(bundle: bundle) == "9DQ459HAZB.live.yooz.remi")
        #else
        #expect(try RemiPushStore.configuredApplicationGroup(bundle: bundle) == "group.live.yooz.remi")
        #endif
    }

    @Test(arguments: [nil, "", ".live.yooz.remi.secure-push", "bad-prefix.live.yooz.remi.secure-push"])
    func invalidDeclaredSharingIsRefused(accessGroup: String?) throws {
        let (bundle, directory) = try makeBundle(accessGroup: accessGroup)
        defer { try? FileManager.default.removeItem(at: directory) }
        #expect(throws: (any Error).self) { try RemiPushStore.configuredApplicationGroup(bundle: bundle) }
    }

    #if os(macOS)
    @Test func appIdentifierPrefixDoesNotChooseTheSigningTeamGroup() throws {
        let (bundle, directory) = try makeBundle(accessGroup: "OLDTEAM001.live.yooz.remi.secure-push")
        defer { try? FileManager.default.removeItem(at: directory) }
        #expect(try RemiPushStore.configuredApplicationGroup(bundle: bundle) == "9DQ459HAZB.live.yooz.remi")
    }

    @Test(arguments: [nil, "group.live.yooz.remi", "9dq459hazb.live.yooz.remi", "9DQ459HAZB.live.yooz.other", "SHORT.live.yooz.remi"])
    func invalidMacGroupIsRefused(applicationGroup: String?) throws {
        let (bundle, directory) = try makeBundle(accessGroup: "9DQ459HAZB.live.yooz.remi.secure-push", applicationGroup: applicationGroup)
        defer { try? FileManager.default.removeItem(at: directory) }
        #expect(throws: (any Error).self) { try RemiPushStore.configuredApplicationGroup(bundle: bundle) }
    }
    #endif

    private func makeBundle(accessGroup: String?, applicationGroup: String? = "9DQ459HAZB.live.yooz.remi") throws -> (Bundle, URL) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("remi-x2-app-group-\(UUID().uuidString).bundle")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        var info: [String: Any] = ["CFBundleIdentifier": "live.yooz.remi.tests.app-group"]
        if let accessGroup { info["RemiPushAccessGroup"] = accessGroup }
        if let applicationGroup { info["RemiPushAppGroup"] = applicationGroup }
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
            .write(to: directory.appendingPathComponent("Info.plist"))
        return (try #require(Bundle(url: directory)), directory)
    }
}
