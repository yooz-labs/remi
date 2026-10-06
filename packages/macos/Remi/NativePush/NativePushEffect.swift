import Foundation

/// Constructible fail-closed scaffold for the native effect boundary (#1200).
/// The codec alone never authorizes publication, deletion or a native action.
/// This scaffold is intentionally not wired into shipping consumers yet.
final class NativePushEffect {
    struct Prepared {
        let push: NativePushCodec.VerifiedPush
        let outcome: NativePushState.ContentOutcome
        let actions: [NativePushCodec.Option]
        fileprivate init(push: NativePushCodec.VerifiedPush, outcome: NativePushState.ContentOutcome,
                         actions: [NativePushCodec.Option]) {
            self.push = push; self.outcome = outcome; self.actions = actions
        }
    }
    struct Action {
        let push: NativePushCodec.VerifiedPush
        let question: NativePushCodec.Question
        let option: NativePushCodec.Option
    }
    private let state: NativePushState
    private let keys: NativePushKeyStore
    private let now: () -> Int64
    init(state: NativePushState, keys: NativePushKeyStore,
         now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970) }) {
        self.state = state; self.keys = keys; self.now = now
    }
    /// Independently opens ORIGINAL carrier bytes and commits replay/lifecycle
    /// before any consumer can publish content or remove a delivered card.
    func prepare(userInfo: [AnyHashable: Any]) throws -> Prepared {
        throw NativePushCodecError.unavailable
    }
    /// Called after EVERY asynchronous wait and immediately before an effect.
    /// Includes captured generation/public P256/keyVersion, not record alone.
    func recheck(_ prepared: Prepared) throws {
        throw NativePushCodecError.unavailable
    }
    /// Actions independently reopen the original capsule; no NSE verified flag,
    /// outer qid/options/category, or previously decoded result grants authority.
    func action(userInfo: [AnyHashable: Any], identifier: String) throws -> Action {
        throw NativePushCodecError.unavailable
    }
}
