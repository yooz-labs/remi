import Foundation

/// Native effect boundary (#1200).
/// The codec alone never authorizes publication or deletion.
/// Consumers independently reopen the original carrier and recheck this boundary
/// after waits, immediately before publishing or removing content. No native
/// answer action exists before R6: a verified card opens the app.
final class NativePushEffect {
    struct Prepared {
        let push: NativePushCodec.VerifiedPush
        let outcome: NativePushState.ContentOutcome
        fileprivate init(push: NativePushCodec.VerifiedPush, outcome: NativePushState.ContentOutcome) {
            self.push = push; self.outcome = outcome
        }
    }
    private let state: NativePushState
    private let keys: NativePushKeyStore
    private let now: () -> Int64
    init(state: NativePushState, keys: NativePushKeyStore,
         now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970) }) {
        self.state = state; self.keys = keys; self.now = now
    }
    /// Read the actual recipient BEFORE final SQLite checks. Keychain and the
    /// ledger are separate systems; external changes remain observed-read limits.
    private func requireCurrent(_ push: NativePushCodec.VerifiedPush) throws {
        guard let recipient = try keys.load(), recipient.publicKey == push.recipientPublicKey,
              recipient.keyVersion == push.keyVersion,
              try state.authorityGeneration() == push.authorityGeneration,
              try state.currentAuthority() == push.trust.authority,
              try state.machineTrust(rid: push.record.rid) == push.trust else { throw NativePushCodecError.changed }
    }
    /// Independently opens ORIGINAL carrier bytes and commits replay/lifecycle
    /// before any consumer can publish content or remove a delivered card.
    func prepare(userInfo: [AnyHashable: Any]) throws -> Prepared {
        let push = try NativePushCodec.open(userInfo: userInfo, state: state, keys: keys, now: now())
        try requireCurrent(push)
        let outcome = try state.recordVerifiedContent(push.record, trust: push.trust, now: now(), generation: push.authorityGeneration)
        let prepared = Prepared(push: push, outcome: outcome)
        try recheck(prepared)
        return prepared
    }
    /// Called after EVERY asynchronous wait and immediately before an effect.
    /// Includes captured generation/public P256/keyVersion, not record alone.
    func recheck(_ prepared: Prepared) throws {
        try requireCurrent(prepared.push)
        if case .dismiss = prepared.push.payload {
            try state.reverifyLatestDismiss(prepared.push.record, trust: prepared.push.trust, now: now(), generation: prepared.push.authorityGeneration)
        } else {
            try state.reverifyLatestContent(prepared.push.record, trust: prepared.push.trust, now: now(), generation: prepared.push.authorityGeneration)
        }
    }
}
