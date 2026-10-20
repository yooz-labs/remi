import Foundation
import UserNotifications
#if os(macOS)
import AppKit
#else
import UIKit
#endif

extension Notification.Name {
    static let nativePushTokenChanged = Notification.Name("remi.native-push-token-changed")
}

/// A user initiated OS prompt owns one bounded continuation. Cancellation does
/// not pretend to dismiss the system prompt; its eventual callback has no reply
/// authority after the thirty-second lifetime ends.
@MainActor
final class NativePushPermission {
    typealias Request = (@escaping (Bool) -> Void) -> Void
    private let osRequest: Request
    private var continuation: CheckedContinuation<Bool, Never>?
    private var timeout: Task<Void, Never>?
    init(osRequest: @escaping Request = { completion in
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { allowed, error in
            completion(allowed && error == nil)
        }
    }) { self.osRequest = osRequest }
    static func request() async -> Bool {
        await NativePushPermission().resolve()
    }
    func resolve() async -> Bool {
        let result = await withTaskCancellationHandler(operation: {
            await withCheckedContinuation { continuation in
                guard !Task.isCancelled else { continuation.resume(returning: false); return }
                self.continuation = continuation
                timeout = Task { @MainActor [weak self] in
                    do { try await Task.sleep(nanoseconds: 30_000_000_000) } catch { return }
                    self?.finish(false)
                }
                osRequest { [weak self] accepted in
                    Task { @MainActor [weak self] in self?.finish(accepted) }
                }
            }
        }, onCancel: { [weak self] in Task { @MainActor [weak self] in self?.finish(false) } })
        return !Task.isCancelled && result
    }
    private func finish(_ result: Bool) {
        guard let continuation else { return }
        self.continuation = nil
        timeout?.cancel(); timeout = nil
        continuation.resume(returning: result)
    }
    static func register() {
        #if os(macOS)
        NSApplication.shared.registerForRemoteNotifications()
        #else
        UIApplication.shared.registerForRemoteNotifications()
        #endif
    }
}

/// #1200: only actual OS delegate callbacks publish a bounded token snapshot.
/// Every callback changes its epoch, including a repeated token or failure.
final class NativePushTokenOwner {
    struct Snapshot: Equatable { let token: Data; let revision: UUID }
    static let shared = NativePushTokenOwner()
    private let lock = NSLock()
    private var captured: Snapshot?
    func recordFromOS(_ token: Data) {
        lock.lock(); defer { lock.unlock() }
        captured = (1...256).contains(token.count) ? Snapshot(token: token, revision: UUID()) : nil
    }
    func clearFromOS() {
        lock.lock(); defer { lock.unlock() }
        captured = nil
    }
    func snapshot() -> Snapshot? {
        lock.lock(); defer { lock.unlock() }
        return captured
    }
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
        guard stillCurrent(), !Task.isCancelled, let token = tokens.snapshot(),
              try state.currentAuthority() == authority,
              let trust = try state.machineTrust(rid: rid), trust.authority == authority,
              trust.relayUrl != nil else { throw NativePushStateError.unavailable }
        let generation = try state.authorityGeneration()
        // Capture any existing recipient before the OS wait. Read errors cannot
        // become creation and a replacement during that wait cannot be selected.
        let existing = try keys.load()
        let result = await environment().resolve(stillCurrent: {
            stillCurrent() && self.tokens.snapshot() == token && !Task.isCancelled
        })
        let name: String
        switch result {
        case .production: name = "production"
        case .sandbox: name = "sandbox"
        case .unavailable: throw NativePushStateError.unavailable
        }
        guard stillCurrent(), !Task.isCancelled, tokens.snapshot() == token,
              try state.authorityGeneration() == generation,
              try state.currentAuthority() == authority,
              try state.machineTrust(rid: rid) == trust else { throw NativePushStateError.changed }
        let key: NativePushKeyStore.Key
        if let existing {
            guard let current = try keys.load(), current.publicKey == existing.publicKey,
                  current.keyVersion == existing.keyVersion else { throw NativePushStateError.changed }
            key = current
        } else {
            key = try keys.loadOrCreate()
        }
        let prepared = Prepared(token: token.token.map { String(format: "%02x", $0) }.joined(),
            environment: name, pushPublicKey: Self.publicEncoding(key.publicKey), keyVersion: key.keyVersion,
            generation: generation, authority: authority, trust: trust, tokenRevision: token.revision)
        // Keychain calls may observe a competing authority change. The final
        // check reads the existing key before checking the current public ledger.
        try recheck(prepared, stillCurrent: stillCurrent)
        return prepared
    }
    func recheck(_ prepared: Prepared, stillCurrent: @MainActor () -> Bool) throws {
        guard let key = try keys.load(), Self.publicEncoding(key.publicKey) == prepared.pushPublicKey,
              key.keyVersion == prepared.keyVersion,
              stillCurrent(), !Task.isCancelled,
              tokens.snapshot()?.revision == prepared.tokenRevision,
              try state.authorityGeneration() == prepared.generation,
              try state.currentAuthority() == prepared.authority,
              try state.machineTrust(rid: prepared.trust.rid) == prepared.trust else {
            throw NativePushStateError.changed
        }
    }
    private static func publicEncoding(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
