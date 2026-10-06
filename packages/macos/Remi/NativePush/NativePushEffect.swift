import Foundation

/// Native effect boundary (#1200).
/// The codec alone never authorizes publication, deletion or a native action.
/// Consumers independently reopen the original carrier and recheck this boundary
/// after waits, immediately before publishing/removing content or handling actions.
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
    static func actionTitle(_ option: NativePushCodec.Option) -> String {
        var title = option.label
        if let description = option.description { title += " — " + description }
        if option.standingGrant == .addRules { title += " · This session" }
        return title
    }
    private static func eligibleActions(_ push: NativePushCodec.VerifiedPush) -> [NativePushCodec.Option] {
        guard !push.trust.authority.requiresAppUnlock, case .question(let question) = push.payload else { return [] }
        let options = question.options
        func yes(_ option: NativePushCodec.Option) -> Bool { option.isYes && !option.isNo && option.standingGrant == nil }
        func no(_ option: NativePushCodec.Option) -> Bool { option.isNo && !option.isYes && option.standingGrant == nil }
        switch question.category {
        case .yesNo:
            guard options.count == 2, yes(options[0]), no(options[1]) else { return [] }
        case .yesNoAlways:
            guard options.count == 3, yes(options[0]), no(options[2]), options[1].isYes,
                  !options[1].isNo, options[1].standingGrant == .addRules,
                  let scope = options[1].description, !scope.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
        case .none, .multiple: return [] // R5 MULTI has no proven structured-origin contract.
        }
        guard options.allSatisfy({ option in
            let title = actionTitle(option)
            let descriptionComplete = option.description.map { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } ?? true
            return !option.label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
                descriptionComplete &&
                title.count <= 24 && !title.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
        }) else { return [] }
        return options // All or none: never truncate, omit a choice or alter its index.
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
        let prepared = Prepared(push: push, outcome: outcome, actions: Self.eligibleActions(push))
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
    /// Actions independently reopen the original capsule; no NSE verified flag,
    /// outer qid/options/category, or previously decoded result grants authority.
    func action(userInfo: [AnyHashable: Any], identifier: String) throws -> Action {
        let push = try NativePushCodec.open(userInfo: userInfo, state: state, keys: keys, now: now())
        let actions = Self.eligibleActions(push)
        guard identifier.hasPrefix("OPT_"), let index = Int(identifier.dropFirst(4)),
              identifier == "OPT_\(index)", actions.indices.contains(index),
              case .question(let question) = push.payload else { throw NativePushCodecError.unavailable }
        try requireCurrent(push)
        try state.reverifyLatestContent(push.record, trust: push.trust, now: now(), generation: push.authorityGeneration)
        return Action(push: push, question: question, option: actions[index])
    }
}
