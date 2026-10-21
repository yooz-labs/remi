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
}
