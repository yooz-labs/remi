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
}
