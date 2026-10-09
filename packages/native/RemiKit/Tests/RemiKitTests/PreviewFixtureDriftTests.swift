import Foundation
import Testing

struct PreviewFixtureDriftTests {
    private static let nativeRoot = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // RemiKitTests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // RemiKit
        .deletingLastPathComponent() // native

    private static let previewFixtures = nativeRoot
        .appendingPathComponent("RemiKit/Sources/RemiUI/Resources/PreviewFixtures")

    private static let goldenFixtures = nativeRoot
        .deletingLastPathComponent() // packages
        .appendingPathComponent("shared/tests/fixtures/protocol")

    @Test(arguments: ["question.json", "session_list_response.json"])
    func previewFixtureMatchesProtocolOracle(name: String) throws {
        let preview = try Data(contentsOf: Self.previewFixtures.appendingPathComponent(name))
        let golden = try Data(contentsOf: Self.goldenFixtures.appendingPathComponent(name))

        #expect(preview == golden, "\(name) drifted from the shared protocol fixture")
    }
}
