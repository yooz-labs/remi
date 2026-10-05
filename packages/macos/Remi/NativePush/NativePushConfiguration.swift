import Foundation

/// Production authority resolves only the configured shared container. A missing
/// entitlement/container refuses mutation; it never falls back to app-local or
/// temporary storage. Tests pass a separately constructed private SQLite state.
enum NativePushConfiguration {
    static let sharedContainerIdentifier = "group.live.yooz.remi"
    static let identityAuthority: NativeIdentityAuthorityBarrier = ConfiguredNativePushAuthority()

    static func identityAccessGroup() throws -> String { try configuredGroup("RemiIdentityAccessGroup") }
    static func pushAccessGroup() throws -> String { try configuredGroup("RemiPushAccessGroup") }
    private static func configuredGroup(_ name: String) throws -> String {
        guard let group = Bundle.main.object(forInfoDictionaryKey: name) as? String,
              !group.isEmpty, group.utf8.count <= 256,
              group.utf8.allSatisfy({ ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 90) ||
                                     ($0 >= 97 && $0 <= 122) || $0 == 46 || $0 == 45 }) else {
            throw NativePushStateError.unavailable
        }
        return group
    }

    static func sharedState() throws -> NativePushState {
        guard let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: sharedContainerIdentifier) else {
            throw NativePushStateError.unavailable
        }
        return try NativePushState(file: container.appendingPathComponent("secure-push.sqlite"))
    }
}

private struct ConfiguredNativePushAuthority: NativeIdentityAuthorityBarrier {
    func acquireIdentityMutation() throws -> NativeIdentityMutationLease {
        try NativePushConfiguration.sharedState().acquireIdentityMutation()
    }
}
