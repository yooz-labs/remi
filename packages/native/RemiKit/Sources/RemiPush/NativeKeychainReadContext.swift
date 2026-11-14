import Foundation
import LocalAuthentication

/// Builds the query of every native Keychain read (#1768): the caller's query
/// plus one shared `LAContext` as `kSecUseAuthenticationContext`,
/// `kSecReturnData` and `kSecMatchLimitOne`. `NativePushKeyStore` and
/// `NativeIdentityRecordStore` read only through `readQuery(_:)`; never create
/// an `LAContext` per read.
///
/// The context is created once per process with `interactionNotAllowed` set,
/// and Remi never evaluates, invalidates or releases it. With a new context per
/// read, concurrent reads went past the limit of `coreauthd` on allocated
/// contexts: the daemon invalidated contexts the process still held, some runs
/// did not return within 90 s, and two local `EXC_BAD_ACCESS` crashes in
/// `-[LAClient _setPermanentError:]` came from processes with such
/// invalidations. With this one context, no daemon invalidations were observed
/// (see #1768).
///
/// What the flag covers: `LAContext.h` gives it the effect of
/// `kSecUseNoAuthenticationUI`, which `SecItem.h` limits on macOS to items in
/// the data-protection Keychain. It therefore covers every read on iOS and, on
/// macOS, the reads that set `kSecUseDataProtectionKeychain` to true (those with
/// an access group). It does not cover macOS file-Keychain reads, such as the
/// legacy migration reads that set `kSecUseDataProtectionKeychain` to false:
/// `SecItem.h` says legacy keychain items still activate UI if needed. The macOS
/// WebView copies under `packages/macos` pass no context at all.
///
/// If the system invalidates this context, the flag stops applying for the rest
/// of the process, not for a single read as with the per-read contexts before.
/// The context must therefore never be relied on for an item with
/// `kSecAttrAccessControl`. No such item exists today, and whoever adds one must
/// revisit this helper first; `NativeKeychainReadGuardTests` fails until then.
/// That reads still return their item after an invalidation was measured only in
/// the unsigned package tests, where the item came from the file Keychain, and
/// not on the production data-protection Keychain.
///
/// Apple does not document whether one `LAContext` may be shared across
/// threads. Sharing it here rests on the experiment in #1768 (810 runs of
/// concurrent reads, with no failed read, crash or hang) and on sampled stacks,
/// in which LocalAuthentication runs each context's calls on that context's own
/// serial queue.
package enum NativeKeychainReadContext {
    /// `base` with the shared context, `kSecReturnData` and `kSecMatchLimitOne` added.
    package static func readQuery(_ base: [String: Any]) -> [String: Any] {
        var query = base
        query[kSecUseAuthenticationContext as String] = context
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        return query
    }

    /// The shared context, for tests that check its identity (`@testable import RemiPush`).
    static var sharedContextForTesting: LAContext { context }

    /// The static is `nonisolated(unsafe)` because `LAContext` is not `Sendable`;
    /// the lazy initializer writes it once, and it is only read afterwards.
    nonisolated(unsafe) private static let context: LAContext = {
        let context = LAContext()
        context.interactionNotAllowed = true
        return context
    }()
}
