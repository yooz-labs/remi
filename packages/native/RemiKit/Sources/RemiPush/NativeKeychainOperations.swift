import Foundation
import Security

/// Only the OS boundary is injectable. The production store, codec, migration,
/// durable verification and refusal branches are always constructed unchanged.
package struct NativeKeychainOperations {
    package var copyMatching: (CFDictionary, UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus
    package var add: (CFDictionary, UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus
    package var update: (CFDictionary, CFDictionary) -> OSStatus
    package static var system: Self { .init(copyMatching:SecItemCopyMatching,add:SecItemAdd,update:SecItemUpdate) }
}
