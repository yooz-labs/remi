import Foundation
import Testing
@testable import RemiKit

struct NativeNotificationPreferencesTests {
    @Test func defaultsAndRestoredPerDeviceChoicesMatchExistingWire() throws {
        let suite = "live.yooz.remi.tests.notification-preferences.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        #expect(NativeNotificationPreferences.read(from: defaults) == .init())
        defaults.set(false, forKey: NativeNotificationPreferences.questionsKey)
        defaults.set(true, forKey: NativeNotificationPreferences.turnCompleteKey)
        let restored = NativeNotificationPreferences.read(from: defaults)
        #expect(restored == .init(questions: false, turnComplete: true))
        let request = RelayPushRequest(type: "secure_push_register_request", id: "owned", timestamp: "owned",
            token: "owned", environment: "sandbox", pushPublicKey: "owned", keyVersion: 1,
            pushPrefs: restored)
        let object = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
        let prefs = try #require(object["pushPrefs"] as? [String: Bool])
        #expect(prefs == ["questions": false, "turnComplete": true, "harnessDenied": false, "turnFailed": false])
        let unregister = RelayPushRequest(type: "secure_push_unregister_request", id: "owned", timestamp: "owned",
            token: nil, environment: nil, pushPublicKey: nil, keyVersion: nil)
        let encodedUnregister = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(unregister)) as? [String: Any])
        #expect(encodedUnregister["pushPrefs"] == nil)
    }
}
