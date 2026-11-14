import Foundation
import LocalAuthentication

/// The authentication context that every native Keychain read passes as
/// `kSecUseAuthenticationContext` (#1768): one context for the process, created
/// on first use with `interactionNotAllowed` set, never evaluated, never
/// invalidated by Remi and never released.
///
/// A new `LAContext` per read made LocalAuthentication allocate, and later
/// delete, a context in its daemon for every read. Under concurrent reads the
/// process went past the daemon's limit on allocated contexts and the daemon
/// invalidated contexts the process still held ("Invalidated due to exceeded
/// number of allocated contexts"). In local runs that pattern came with reads
/// that never returned from LocalAuthentication, and two `EXC_BAD_ACCESS`
/// crashes in `-[LAClient _setPermanentError:]` came from processes that had
/// such invalidations. One reused context allocates nothing per read. The
/// counts are in the pull request for #1768.
///
/// The context only marks a read as non-interactive. No policy is ever
/// evaluated on it, so it never holds an authentication that a later read could
/// reuse, and no item read through it carries access control (they are written
/// with `kSecAttrAccessible` alone). If the system invalidates it, reads of
/// those items still return their item or their status; the per-read contexts
/// it replaces were invalidated the same way under concurrent reads.
///
/// `nonisolated(unsafe)`: the context is created once (a lazy static) and is
/// afterwards only handed to Security as a query value; LocalAuthentication
/// runs each context's calls on that context's own serial queue.
package enum NativeKeychainReadContext {
    nonisolated(unsafe) package static let noninteractive: LAContext = {
        let context = LAContext()
        context.interactionNotAllowed = true
        return context
    }()
}
