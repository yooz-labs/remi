import Foundation

/// Constructible fail-closed token/registration scaffold. No OS registration is
/// requested at startup, and no JavaScript token or environment selects metadata.
final class NativePushTokenOwner {
    struct Snapshot: Equatable { let token: Data; let revision: UUID }
    static let shared = NativePushTokenOwner()
    func recordFromOS(_ token: Data) {}
    func clearFromOS() {}
    func snapshot() -> Snapshot? { nil }
}

@MainActor
final class NativePushRegistration {
    struct Prepared {
        let token: String
        let environment: String
        let pushPublicKey: String
        let keyVersion: Int
        let generation: Int64
        let authority: NativePushState.Authority
        let trust: NativePushState.MachineTrust
        let tokenRevision: UUID
    }
    private let state: NativePushState
    private let keys: NativePushKeyStore
    private let tokens: NativePushTokenOwner
    private let environment: @MainActor () -> NativeAPNsEnvironment
    init(state: NativePushState, keys: NativePushKeyStore, tokens: NativePushTokenOwner,
         environment: @escaping @MainActor () -> NativeAPNsEnvironment = { NativeAPNsEnvironment() }) {
        self.state = state; self.keys = keys; self.tokens = tokens; self.environment = environment
    }
    func prepare(rid: Data, authority: NativePushState.Authority,
                 stillCurrent: @escaping @MainActor () -> Bool) async throws -> Prepared {
        throw NativePushStateError.unavailable
    }
    func recheck(_ prepared: Prepared, stillCurrent: @MainActor () -> Bool) throws {
        throw NativePushStateError.unavailable
    }
}
