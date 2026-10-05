import Foundation
import WebKit

/// Dedicated WebKit ingress retains actual frame provenance. Capacitor's generic
/// CAPPluginCall drops WKScriptMessage.frameInfo and cannot enforce this boundary.
/// Private keys remain inside ClientIdentityStore; responses are public-only (#1199).
@MainActor
final class NativeIdentityBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let handlerName = "remiIdentity"
    let scheme: String
    private let service: String
    private let account: String

    init(scheme: String, service: String, account: String) {
        self.scheme = scheme
        self.service = service
        self.account = account
    }

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
         "fingerprint": identity.fingerprint, "revision": identity.revision]
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
            guard Set(request.keys) == ["op", "pkcs8", "publicKey", "revision"] else {
                throw NativeIdentityError.malformed
            }
            let previous = try ClientIdentityStore.load(service: service, account: account)
            let revision = request["revision"] as? String
            guard request["revision"] is NSNull || revision != nil else { throw NativeIdentityError.malformed }
            let imported = try ClientIdentityStore.importIdentity(
                pkcs8: bytes(request["pkcs8"], count: 48...48),
                publicKey: bytes(request["publicKey"], count: 32...32), replacing: revision,
                service: service, account: account)
            var response = publicRecord(imported)
            let replaced = previous != nil && previous?.publicKeyRaw != imported.publicKeyRaw
            response["requiresRestart"] = scheme == "remi-app" && replaced
            if replaced { NotificationCenter.default.post(name: .nativeIdentityReplaced, object: nil) }
            return response
        case "sign":
            guard Set(request.keys) == ["op", "revision", "publicKey", "message"],
                  let revision = request["revision"] as? String,
                  let identity = try ClientIdentityStore.load(service: service, account: account),
                  identity.revision == revision,
                  try bytes(request["publicKey"], count: 32...32) == identity.publicKeyRaw
            else { throw NativeIdentityError.changed }
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
