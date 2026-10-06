import Foundation
import Security

/// Only the OS boundary is injectable. The production store, codec, migration,
/// durable verification and refusal branches are always constructed unchanged.
struct NativeKeychainOperations {
    var copyMatching: (CFDictionary, UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus
    var add: (CFDictionary, UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus
    var update: (CFDictionary, CFDictionary) -> OSStatus
    static var system: Self { .init(copyMatching:SecItemCopyMatching,add:SecItemAdd,update:SecItemUpdate) }
}
