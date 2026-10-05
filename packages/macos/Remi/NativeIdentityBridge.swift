import Foundation
import WebKit
import LocalAuthentication
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Dedicated WebKit ingress retains actual frame provenance. Capacitor's generic
/// CAPPluginCall drops WKScriptMessage.frameInfo and cannot enforce this boundary.
/// Private keys remain inside ClientIdentityStore; responses are public-only (#1199).
@MainActor
final class NativeIdentityBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let handlerName = "remiIdentity"
    let scheme: String
    private let service: String
    private let account: String
    private let unlockLifetime = NativeUnlockLifetime()
    private var unlockedRevision: String?
    private var inactiveObserver: NSObjectProtocol?

    init(scheme: String, service: String, account: String) {
        self.scheme = scheme
        self.service = service
        self.account = account
        super.init()
        inactiveObserver = NotificationCenter.default.addObserver(forName: NativeForegroundUnlock.inactiveNotification,
            object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.unlockedRevision = nil }
            }
    }

    deinit { if let inactiveObserver { NotificationCenter.default.removeObserver(inactiveObserver) } }

    static func isBundledDocument(_ url: URL?, scheme: String) -> Bool {
        guard let url, url.scheme == scheme, url.host == "localhost", url.port == nil,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil
        else { return false }
        return ["", "/", "/index.html"].contains(url.path)
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        // Use WebKit's frameInfo, never a claimed origin/frame flag from JavaScript.
        let frame = message.frameInfo
        guard frame.isMainFrame,
              frame.securityOrigin.protocol == scheme, frame.securityOrigin.host == "localhost",
              frame.securityOrigin.port == 0,
              Self.isBundledDocument(frame.request.url, scheme: scheme),
              Self.isBundledDocument(message.webView?.url, scheme: scheme)
        else { replyHandler(nil, "Native identity request refused"); return }
        if let request = message.body as? [String: Any], request["op"] as? String == "unlock" {
            Task { @MainActor in
                do {
                    guard JSONSerialization.isValidJSONObject(request),
                          try JSONSerialization.data(withJSONObject: request).count <= 8192,
                          Set(request.keys) == ["op", "revision", "publicKey"],
                          let identity = try ClientIdentityStore.load(service: service, account: account),
                          request["revision"] as? String == identity.revision,
                          try bytes(request["publicKey"], count: 32...32) == identity.publicKeyRaw,
                          await unlockLifetime.authenticate(revision: identity.revision, currentRevision: {
                              try? ClientIdentityStore.load(service: self.service, account: self.account)?.revision
                          }),
                          Self.isBundledDocument(message.webView?.url, scheme: scheme),
                          try ClientIdentityStore.load(service: service, account: account)?.revision == identity.revision
                    else { throw NativeIdentityError.changed }
                    unlockedRevision = identity.revision
                    replyHandler(publicRecord(identity), nil)
                } catch { replyHandler(nil, "Native identity unlock refused") }
            }
            return
        }
        do { replyHandler(try handle(message.body), nil) }
        catch { replyHandler(nil, "Native identity request refused"); }
    }

    private func bytes(_ value: Any?, count: ClosedRange<Int>) throws -> Data {
        guard let value = value as? String, let bytes = Data(base64Encoded: value),
              bytes.base64EncodedString() == value, count.contains(bytes.count)
        else { throw NativeIdentityError.malformed }
        return bytes
    }

    private func publicRecord(_ identity: ClientIdentity) -> [String: Any] {
        ["exists": true, "publicKey": identity.publicKeyRaw.base64EncodedString(),
         "fingerprint": identity.fingerprint, "revision": identity.revision,
         "requiresAppUnlock": identity.requiresAppUnlock,
         "locked": identity.requiresAppUnlock && unlockedRevision != identity.revision]
    }

    private func handle(_ body: Any) throws -> [String: Any] {
        guard let request = body as? [String: Any],
              JSONSerialization.isValidJSONObject(request),
              try JSONSerialization.data(withJSONObject: request).count <= 8192,
              let op = request["op"] as? String
        else { throw NativeIdentityError.malformed }
        switch op {
        case "public":
            guard Set(request.keys) == ["op"] else { throw NativeIdentityError.malformed }
            guard let identity = try ClientIdentityStore.load(service: service, account: account) else {
                return ["exists": false]
            }
            return publicRecord(identity)
        case "create":
            guard Set(request.keys) == ["op"] else { throw NativeIdentityError.malformed }
            return publicRecord(try ClientIdentityStore.loadOrCreate(service: service, account: account))
        case "import":
            guard Set(request.keys) == ["op", "pkcs8", "publicKey", "revision", "requiresAppUnlock"] else {
                throw NativeIdentityError.malformed
            }
            guard let protected = request["requiresAppUnlock"] as? NSNumber,
                  CFGetTypeID(protected) == CFBooleanGetTypeID() else { throw NativeIdentityError.malformed }
            let previous = try ClientIdentityStore.load(service: service, account: account)
            let revision = request["revision"] as? String
            guard request["revision"] is NSNull || revision != nil else { throw NativeIdentityError.malformed }
            let imported = try ClientIdentityStore.importIdentity(
                pkcs8: bytes(request["pkcs8"], count: 48...48),
                publicKey: bytes(request["publicKey"], count: 32...32), replacing: revision,
                requiresAppUnlock: protected.boolValue,
                service: service, account: account)
            // Only an explicit foreground import has decrypted the legacy identity.
            // The durable policy still denies all background answers.
            if imported.requiresAppUnlock { unlockedRevision = imported.revision }
            var response = publicRecord(imported)
            let replaced = previous != nil && previous?.revision != imported.revision
            response["requiresRestart"] = scheme == "remi-app" && replaced
            if replaced { NotificationCenter.default.post(name: .nativeIdentityReplaced, object: nil) }
            return response
        case "protect":
            guard Set(request.keys) == ["op", "revision", "publicKey"],
                  let revision = request["revision"] as? String else { throw NativeIdentityError.malformed }
            let protected = try ClientIdentityStore.requireAppUnlock(revision: revision,
                publicKey: bytes(request["publicKey"], count: 32...32), service: service, account: account)
            var response = publicRecord(protected)
            response["requiresRestart"] = scheme == "remi-app" && protected.revision != revision
            if protected.revision != revision { NotificationCenter.default.post(name: .nativeIdentityReplaced, object: nil) }
            return response
        case "sign":
            guard Set(request.keys) == ["op", "revision", "publicKey", "message"],
                  let revision = request["revision"] as? String,
                  let identity = try ClientIdentityStore.load(service: service, account: account),
                  identity.revision == revision,
                  try bytes(request["publicKey"], count: 32...32) == identity.publicKeyRaw
            else { throw NativeIdentityError.changed }
            guard !identity.requiresAppUnlock || unlockedRevision == identity.revision else {
                throw NativeIdentityError.changed
            }
            let signature = try identity.sign(bytes(request["message"], count: 1...4096))
            var response = publicRecord(identity)
            response["signature"] = signature.base64EncodedString()
            return response
        default: throw NativeIdentityError.malformed
        }
    }
}

extension Notification.Name {
    static let nativeIdentityReplaced = Notification.Name("remi.native-identity-replaced")
}

/// An explicit foreground action, never called by the background answer relay.
/// Device authentication unlocks the current app session; it does not re-encrypt
/// the Keychain record with the legacy passphrase or enable background signing.
@MainActor
enum NativeForegroundUnlock {
    static var inactiveNotification: Notification.Name {
        #if os(macOS)
        return NSApplication.didResignActiveNotification
        #else
        return UIApplication.willResignActiveNotification
        #endif
    }
    static func isActive() -> Bool {
        #if os(macOS)
        return NSApplication.shared.isActive
        #else
        return UIApplication.shared.applicationState == .active
        #endif
    }
    static func authenticate() async -> Bool {
        guard isActive() else { return false }
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { return false }
        return (try? await context.evaluatePolicy(.deviceOwnerAuthentication,
            localizedReason: "Unlock Remi's signing identity for this app session")) == true
    }
}

/// Coordinates the OS authentication await; no key or signing operation is exposed here.
@MainActor
final class NativeUnlockLifetime {
    func authenticate(revision: String, currentRevision: () -> String?,
                      authorization: () async -> Bool = NativeForegroundUnlock.authenticate,
                      foreground: () -> Bool = NativeForegroundUnlock.isActive) async -> Bool {
        guard foreground() else { return false }
        return await authorization() && currentRevision() == revision
    }
}
