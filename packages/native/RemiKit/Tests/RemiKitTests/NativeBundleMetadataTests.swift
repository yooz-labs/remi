import CoreFoundation
import Foundation
import Testing

struct NativeBundleMetadataTests {
    private static let native = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()

    @Test(arguments: ["PhonePushService", "MacPushService"])
    func extensionDeclaresItsExecutable(_ target: String) throws {
        let url = Self.native.appendingPathComponent("\(target)/Info.plist")
        let plist = try #require(
            PropertyListSerialization.propertyList(from: Data(contentsOf: url), format: nil)
                as? [String: Any]
        )
        // Both targets supply their own plist instead of generating one.
        // A signed iPhone install rejected the missing executable (#1242).
        #expect(plist["CFBundleExecutable"] as? String == "$(EXECUTABLE_NAME)")
    }

    @Test(arguments: ["Mac", "iPhone"])
    func localDiscoveryDeclaresBonjourWithoutServerEntitlement(_ target: String) throws {
        let plist = try #require(PropertyListSerialization.propertyList(
            from: Data(contentsOf: Self.native.appendingPathComponent("\(target)/Info.plist")), format: nil) as? [String: Any])
        #expect(plist["NSBonjourServices"] as? [String] == ["_remi._tcp"])
        if target == "Mac" { #expect(!(plist["NSLocalNetworkUsageDescription"] as? String ?? "").isEmpty) }
        let entitlements = try #require(PropertyListSerialization.propertyList(
            from: Data(contentsOf: Self.native.appendingPathComponent("\(target)/Remi.entitlements")), format: nil) as? [String: Any])
        #expect(entitlements["com.apple.security.network.server"] == nil)
        #expect(entitlements["com.apple.developer.networking.multicast"] == nil)
    }

    /// A question is delivered as Time Sensitive (RemiPushPresentation); without the entitlement
    /// the system quietly delivers it as an ordinary alert, which Focus can silence.
    @Test(arguments: ["Mac", "iPhone"])
    func appsDeclareTimeSensitiveNotifications(_ target: String) throws {
        let entitlements = try #require(PropertyListSerialization.propertyList(
            from: Data(contentsOf: Self.native.appendingPathComponent("\(target)/Remi.entitlements")), format: nil) as? [String: Any])
        #expect(entitlements["com.apple.developer.usernotifications.time-sensitive"] as? Bool == true)
    }

    @Test(arguments: ["Mac", "iPhone"])
    func privateAddressPolicyDoesNotDisablePublicTransportSecurity(_ target: String) throws {
        let plist = try #require(PropertyListSerialization.propertyList(
            from: Data(contentsOf: Self.native.appendingPathComponent("\(target)/Info.plist")), format: nil) as? [String: Any])
        let ats = try #require(plist["NSAppTransportSecurity"] as? [String: Any])
        #expect(Set(ats.keys) == ["NSExceptionDomains"])
        let exceptions = try #require(ats["NSExceptionDomains"] as? [String: [String: Any]])
        #expect(Set(exceptions.keys) == [
            "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "172.16.0.0/12",
            "192.168.0.0/16", "::1", "fc00::/7",
        ])
        for policy in exceptions.values {
            #expect(Set(policy.keys) == ["NSExceptionAllowsInsecureHTTPLoads"])
            #expect(policy["NSExceptionAllowsInsecureHTTPLoads"] as? Bool == true)
        }
    }

    @Test(arguments: ["Mac", "iPhone"])
    func exportDeclarationRecordsTheOwnerConfirmedExemption(_ target: String) throws {
        let plist = try #require(PropertyListSerialization.propertyList(
            from: Data(contentsOf: Self.native.appendingPathComponent("\(target)/Info.plist")), format: nil) as? [String: Any])
        let value = try #require(plist["ITSAppUsesNonExemptEncryption"] as? NSNumber)
        #expect(CFGetTypeID(value) == CFBooleanGetTypeID())
        #expect(value.boolValue == false)
    }
}
