import Foundation
import WebKit
import LocalAuthentication
import Vision
import ImageIO
#if os(macOS)
import AppKit
#else
import UIKit
import PhotosUI
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
    private let accessGroup: String?
    private let authority: NativeIdentityAuthorityBarrier
    private let unlockLifetime = NativeUnlockLifetime()
    private let foreground: @MainActor () -> Bool
    private let authorization: @MainActor () async -> Bool
    private weak var webView: WKWebView?
    private var unlockedRevision: String?
    private var inactiveObserver: NSObjectProtocol?
    private var replacedObserver: NSObjectProtocol?
    private let qrPicker = NativeQRImagePicker()
    private let selectedQRImage: (@MainActor (WKWebView) async throws -> Data?)?
    private var qrGeneration: UInt64 = 0
    private var qrRequestId: String?
    private var qrTask: Task<Void, Never>?
    private var documentObserver: NSKeyValueObservation?

    init(authority: NativeIdentityAuthorityBarrier, accessGroup: String?, scheme: String, service: String, account: String,
         foreground: @escaping @MainActor () -> Bool = { NativeForegroundUnlock.isActive() },
         authorization: @escaping @MainActor () async -> Bool = NativeForegroundUnlock.authenticate,
         selectedQRImage: (@MainActor (WKWebView) async throws -> Data?)? = nil) {
        self.scheme = scheme
        self.service = service
        self.account = account
        self.authority = authority
        self.accessGroup = accessGroup
        self.foreground = foreground
        self.authorization = authorization
        self.selectedQRImage = selectedQRImage
        super.init()
        inactiveObserver = NotificationCenter.default.addObserver(forName: NativeForegroundUnlock.inactiveNotification,
            object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.unlockedRevision = nil
                    self?.cancelQR()
                    // Public-only lifecycle notice lets the web owner discard derived relay keys.
                    self?.webView?.evaluateJavaScript("window.dispatchEvent(new Event('remi:native-identity-locked'))")
                }
            }
        replacedObserver = NotificationCenter.default.addObserver(forName: .nativeIdentityReplaced,
            object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.unlockedRevision = nil; self?.cancelQR() }
            }
    }

    deinit {
        if let inactiveObserver { NotificationCenter.default.removeObserver(inactiveObserver) }
        if let replacedObserver { NotificationCenter.default.removeObserver(replacedObserver) }
    }

    nonisolated static func isBundledDocument(_ url: URL?, scheme: String) -> Bool {
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
        if webView !== message.webView {
            cancelQR()
            webView = message.webView
            documentObserver = message.webView?.observe(\.isLoading, options: [.new]) { [weak self] web, _ in
                if web.isLoading { MainActor.assumeIsolated { self?.cancelQR() } }
            }
        }
        if let request = message.body as? [String: Any],
           ["scanQR", "cancelQR"].contains(request["op"] as? String ?? "") {
            guard Set(request.keys) == ["op", "id"], let id = request["id"] as? String,
                  !id.isEmpty, id.utf8.count <= 64,
                  id.utf8.allSatisfy({ $0 >= 33 && $0 <= 126 }) else {
                replyHandler(nil, "QR selection refused"); return
            }
            if request["op"] as? String == "cancelQR" {
                if qrRequestId == id { cancelQR() }
                replyHandler(["cancelled": true], nil); return
            }
            guard foreground(), qrRequestId == nil, let web = message.webView else {
                replyHandler(nil, "QR selection unavailable"); return
            }
            qrRequestId = id
            let generation = qrGeneration
            qrTask = Task { @MainActor in
                defer { if qrGeneration == generation { qrRequestId = nil; qrTask = nil } }
                do {
                    let data: Data?
                    if let selectedQRImage { data = try await selectedQRImage(web) }
                    else { data = try await qrPicker.select(in: web) }
                    guard !Task.isCancelled, qrGeneration == generation, foreground(),
                          !web.isLoading, Self.isBundledDocument(web.url, scheme: scheme) else {
                        throw NativeIdentityError.changed
                    }
                    guard let data else { replyHandler(["cancelled": true], nil); return }
                    let token = try await Task.detached(priority: .userInitiated) {
                        try NativePairingQRDecoder.decode(data)
                    }.value
                    guard !Task.isCancelled, qrGeneration == generation, foreground(),
                          !web.isLoading, Self.isBundledDocument(web.url, scheme: scheme) else {
                        throw NativeIdentityError.changed
                    }
                    replyHandler(["token": token], nil)
                } catch { replyHandler(nil, "QR selection or decoding refused. Paste the pairing token.") }
            }
            return
        }
        if let request = message.body as? [String: Any], request["op"] as? String == "unlock" {
            Task { @MainActor in
                do {
                    guard JSONSerialization.isValidJSONObject(request),
                          try JSONSerialization.data(withJSONObject: request).count <= 8192,
                          Set(request.keys) == ["op", "revision", "publicKey"],
                          let identity = try ClientIdentityStore.load(authority: authority, accessGroup: accessGroup, service: service, account: account),
                          request["revision"] as? String == identity.revision,
                          try bytes(request["publicKey"], count: 32...32) == identity.publicKeyRaw,
                          await unlockLifetime.authenticate(revision: identity.revision, currentRevision: {
                              try? ClientIdentityStore.load(authority: self.authority, accessGroup: self.accessGroup, service: self.service, account: self.account)?.revision
                          }, authorization: authorization, foreground: foreground),
                          Self.isBundledDocument(message.webView?.url, scheme: scheme),
                          try ClientIdentityStore.load(authority: authority, accessGroup: accessGroup, service: service, account: account)?.revision == identity.revision
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

    private func cancelQR() {
        qrGeneration &+= 1
        qrTask?.cancel(); qrTask = nil; qrRequestId = nil
        qrPicker.cancel()
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
         "locked": identity.requiresAppUnlock && (unlockedRevision != identity.revision || !foreground())]
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
            guard let identity = try ClientIdentityStore.load(authority: authority, accessGroup: accessGroup, service: service, account: account) else {
                return ["exists": false]
            }
            return publicRecord(identity)
        case "create":
            guard Set(request.keys) == ["op"] else { throw NativeIdentityError.malformed }
            return publicRecord(try ClientIdentityStore.loadOrCreate(authority: authority, accessGroup: accessGroup, service: service, account: account))
        case "import":
            guard Set(request.keys) == ["op", "pkcs8", "publicKey", "revision", "requiresAppUnlock"] else {
                throw NativeIdentityError.malformed
            }
            guard let protected = request["requiresAppUnlock"] as? NSNumber,
                  CFGetTypeID(protected) == CFBooleanGetTypeID() else { throw NativeIdentityError.malformed }
            let previous = try ClientIdentityStore.load(authority: authority, accessGroup: accessGroup, service: service, account: account)
            let revision = request["revision"] as? String
            guard request["revision"] is NSNull || revision != nil else { throw NativeIdentityError.malformed }
            let imported = try ClientIdentityStore.importIdentity(authority: authority, accessGroup: accessGroup,
                pkcs8: bytes(request["pkcs8"], count: 48...48),
                publicKey: bytes(request["publicKey"], count: 32...32), replacing: revision,
                requiresAppUnlock: protected.boolValue,
                service: service, account: account)
            // Decryption in JS does not grant a native foreground signing lifetime.
            // Import always remains locked until an explicit OS-authenticated unlock;
            // a decrypt/export continuation may have crossed inactive -> active (#1199).
            if imported.requiresAppUnlock { unlockedRevision = nil }
            var response = publicRecord(imported)
            let replaced = previous != nil && previous?.revision != imported.revision
            response["requiresRestart"] = scheme == "remi-app" && replaced
            if replaced {
                NotificationCenter.default.post(name: .nativeIdentityReplaced, object: nil)
                response["locked"] = imported.requiresAppUnlock
            }
            return response
        case "protect":
            guard Set(request.keys) == ["op", "revision", "publicKey"],
                  let revision = request["revision"] as? String else { throw NativeIdentityError.malformed }
            let protected = try ClientIdentityStore.requireAppUnlock(authority: authority, accessGroup: accessGroup, revision: revision,
                publicKey: bytes(request["publicKey"], count: 32...32), service: service, account: account)
            var response = publicRecord(protected)
            response["requiresRestart"] = scheme == "remi-app" && protected.revision != revision
            if protected.revision != revision { NotificationCenter.default.post(name: .nativeIdentityReplaced, object: nil) }
            return response
        case "sign":
            guard Set(request.keys) == ["op", "revision", "publicKey", "message"],
                  let revision = request["revision"] as? String,
                  let identity = try ClientIdentityStore.load(authority: authority, accessGroup: accessGroup, service: service, account: account),
                  identity.revision == revision,
                  try bytes(request["publicKey"], count: 32...32) == identity.publicKeyRaw
            else { throw NativeIdentityError.changed }
            guard !identity.requiresAppUnlock || (unlockedRevision == identity.revision && foreground()) else {
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
        let authenticated = (try? await context.evaluatePolicy(.deviceOwnerAuthentication,
            localizedReason: "Unlock Remi's signing identity for this app session")) == true
        return authenticated && isActive()
    }
}

/// Coordinates the OS authentication await; no key or signing operation is exposed here.
@MainActor
final class NativeUnlockLifetime {
    private var generation: UInt64 = 0
    private var observers: [NSObjectProtocol] = []
    init() {
        for name in [NativeForegroundUnlock.inactiveNotification, .nativeIdentityReplaced] {
            observers.append(NotificationCenter.default.addObserver(forName:name,object:nil,queue:.main) { [weak self] _ in
                MainActor.assumeIsolated { self?.generation &+= 1 }
            })
        }
    }
    deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) } }
    func authenticate(revision: String, currentRevision: () -> String?,
                      authorization: @MainActor () async -> Bool = NativeForegroundUnlock.authenticate,
                      foreground: @MainActor () -> Bool = { NativeForegroundUnlock.isActive() }) async -> Bool {
        guard foreground() else { return false }
        let attempt = generation
        let authorized = await authorization()
        return authorized && foreground() && generation == attempt && currentRevision() == revision
    }
}

/// Local QR image decoding. Header dimensions are checked before decompression/Vision.
/// The actual shared token decoder still validates canonical bytes, expiry and machine key.
enum NativePairingQRDecoder {
    static let maximumImageBytes = 8 * 1024 * 1024
    static let maximumPixels = 8 * 1024 * 1024
    static func readSelectedFile(_ url: URL) throws -> Data {
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size > 0, size <= maximumImageBytes else { throw NativeIdentityError.malformed }
        let data = try Data(contentsOf: url, options: .mappedIfSafe)
        guard data.count <= maximumImageBytes else { throw NativeIdentityError.malformed }
        return data
    }
    static func decode(_ data: Data) throws -> String {
        guard !data.isEmpty, data.count <= maximumImageBytes,
              let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              CGImageSourceGetCount(source) == 1,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width <= 4096, height <= 4096,
              width <= maximumPixels / height,
              let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
        else { throw NativeIdentityError.malformed }
        let request = VNDetectBarcodesRequest()
        request.symbologies = [.qr]
        // macOS 14's GPU-allowed path can miss this valid QR; the public CPU
        // path decodes it. Keep the default revision and the image bounds above.
        request.usesCPUOnly = true
        try VNImageRequestHandler(cgImage: image).perform([request])
        let tokens = (request.results ?? []).compactMap { $0.payloadStringValue }.filter {
            $0.hasPrefix("remi-pair2:") && $0.utf8.count <= 4096 &&
            $0.utf8.allSatisfy { $0 >= 33 && $0 <= 126 }
        }
        guard tokens.count == 1, let token = tokens.first else { throw NativeIdentityError.malformed }
        return token
    }
}

/// User-driven platform picker. No image bytes enter from JavaScript and no upload exists.
@MainActor
final class NativeQRImagePicker: NSObject {
    #if os(macOS)
    private var panel: NSOpenPanel?
    func select(in web: WKWebView) async throws -> Data? {
        guard let window = web.window else { throw NativeIdentityError.changed }
        let panel = NSOpenPanel(); self.panel = panel
        panel.allowedContentTypes = [.png, .jpeg, .heic]
        panel.allowsMultipleSelection = false; panel.canChooseDirectories = false
        panel.message = "Choose a QR image from remi pair. The image stays on this device."
        let response = await panel.beginSheetModal(for: window)
        self.panel = nil
        guard response == .OK, let url = panel.url else { return nil }
        return try NativePairingQRDecoder.readSelectedFile(url)
    }
    func cancel() { panel?.cancel(nil); panel = nil }
    #else
    private var picker: PHPickerViewController?
    private var continuation: CheckedContinuation<Data?, Error>?
    func select(in web: WKWebView) async throws -> Data? {
        var responder: UIResponder? = web
        while responder != nil && !(responder is UIViewController) { responder = responder?.next }
        guard let controller = responder as? UIViewController, controller.presentedViewController == nil else {
            throw NativeIdentityError.changed
        }
        var configuration = PHPickerConfiguration(); configuration.filter = .images; configuration.selectionLimit = 1
        let picker = PHPickerViewController(configuration: configuration); picker.delegate = self
        self.picker = picker
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            controller.present(picker, animated: true)
        }
    }
    func cancel() {
        picker?.dismiss(animated: true); picker = nil
        continuation?.resume(returning: nil); continuation = nil
    }
    fileprivate func selected(_ results: [PHPickerResult]) {
        picker?.dismiss(animated: true); picker = nil
        guard let result = results.first else { cancel(); return }
        let continuation = self.continuation; self.continuation = nil
        result.itemProvider.loadFileRepresentation(forTypeIdentifier: "public.image") { url, error in
            do {
                if let error { throw error }
                guard let url else { throw NativeIdentityError.malformed }
                continuation?.resume(returning: try NativePairingQRDecoder.readSelectedFile(url))
            } catch { continuation?.resume(throwing: error) }
        }
    }
    #endif
}
#if os(iOS)
extension NativeQRImagePicker: PHPickerViewControllerDelegate {
    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        selected(results)
    }
}
#endif
