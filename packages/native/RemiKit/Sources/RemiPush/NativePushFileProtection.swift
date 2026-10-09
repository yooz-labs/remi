import Foundation

/// After first device unlock, extensions can read the ledger while locked.
/// This is availability, not permission to sign: current private Dpk policy
/// and verified capsule authority remain mandatory at each answer effect.
enum NativePushFileProtection {
    static func directory(_ url: URL) throws {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard attributes[.type] as? FileAttributeType == .typeDirectory else {
            throw RemiPushError.unavailable
        }
        try FileManager.default.setAttributes(attributesFor(mode: 0o700), ofItemAtPath: url.path)
    }
    static func file(_ url: URL) throws {
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular else {
            throw RemiPushError.unavailable
        }
        try FileManager.default.setAttributes(attributesFor(mode: 0o600), ofItemAtPath: url.path)
    }
    static func attributesFor(mode: Int) -> [FileAttributeKey: Any] {
        var attributes: [FileAttributeKey: Any] = [.posixPermissions: mode]
        #if os(iOS)
        // The directory policy is inherited by newly created WAL/SHM/lock files;
        // existing ledger companions are explicitly repaired to the same policy.
        attributes[.protectionKey] = FileProtectionType.completeUntilFirstUserAuthentication
        #endif
        return attributes
    }
}
