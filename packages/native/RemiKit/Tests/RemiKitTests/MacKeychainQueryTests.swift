import Foundation
import Security
import Testing
@testable import RemiKit
@testable import RemiPush

struct MacKeychainQueryTests {
    @Test func declaredGroupsSelectThePlatformKeychain() {
        let identity = NativeIdentityRecordStore.query(accessGroup: "9DQ459HAZB.live.yooz.remi.dev",
            service: "owned-query", account: "owned-account")
        let recipient = NativePushKeyStore(service: "owned-query", account: "owned-account",
            accessGroup: "9DQ459HAZB.live.yooz.remi.secure-push").query
        #if os(macOS)
        #expect(identity[kSecUseDataProtectionKeychain as String] as? Bool == true)
        #expect(recipient[kSecUseDataProtectionKeychain as String] as? Bool == true)
        #endif
        #expect(identity[kSecAttrAccessGroup as String] as? String == "9DQ459HAZB.live.yooz.remi.dev")
        #expect(recipient[kSecAttrAccessGroup as String] as? String == "9DQ459HAZB.live.yooz.remi.secure-push")
        #expect(identity[kSecAttrSynchronizable as String] == nil)
        #expect(recipient[kSecAttrSynchronizable as String] == nil)
    }

    @Test func ownedFileKeychainContextsKeepTheirOriginalQuery() {
        let identity = NativeIdentityRecordStore.query(accessGroup: nil, service: "owned-query", account: "owned-account")
        let recipient = NativePushKeyStore(service: "owned-query", account: "owned-account", accessGroup: nil).query
        #expect(identity[kSecUseDataProtectionKeychain as String] == nil)
        #expect(recipient[kSecUseDataProtectionKeychain as String] == nil)
        #expect(identity[kSecAttrAccessGroup as String] == nil)
        #expect(recipient[kSecAttrAccessGroup as String] == nil)
    }
}
