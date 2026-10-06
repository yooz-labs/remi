import CryptoKit
import Foundation
import Security
import WebKit
import XCTest

final class NativePushRegistrationIngressTests: XCTestCase {
    private var directory: URL!
    private var service = ""
    private var state: NativePushState!
    private var keys: NativePushKeyStore!
    private var identity: ClientIdentity!
    private var rid = Data()
    private var keyQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service + ".push", kSecAttrAccount as String: "owned"]
    }
    override func setUpWithError() throws {
        service = "live.yooz.remi.tests.registration-wk-" + UUID().uuidString
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("remi1200-registration-wk-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        try "<html><body>Private registration fixture</body></html>".write(to: directory.appendingPathComponent("index.html"), atomically: true, encoding: .utf8)
        state = try NativePushState(file: directory.appendingPathComponent("public.sqlite"))
        keys = NativePushKeyStore(service: service + ".push", account: "owned", accessGroup: nil)
        identity = try ClientIdentityStore.loadOrCreate(authority: state, accessGroup: nil, service: service, account: "owned-dpk")
        let machine = Curve25519.Signing.PrivateKey().publicKey.rawRepresentation
        rid = Data(SHA256.hash(data: machine).prefix(16))
        try state.installMachineTrust(.init(rid: rid, machinePublicKey: machine, endpoint: "https://relay.example.invalid",
            authority: XCTUnwrap(state.currentAuthority()), relayUrl: "wss://relay.example.invalid"), generation: state.authorityGeneration())
    }
    override func tearDownWithError() throws {
        ClientIdentityStore.resetForTesting(service: service, account: "owned-dpk")
        SecItemDelete(keyQuery as CFDictionary)
        identity = nil; keys = nil; state = nil
        if let directory { try FileManager.default.removeItem(at: directory) }
    }
    @MainActor private func web(tokens: NativePushTokenOwner,
        authorization: @escaping @MainActor () async throws -> Bool = { true },
        register: @escaping @MainActor () -> Void = {}) async throws -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.setURLSchemeHandler(DistSchemeHandler(webRoot: directory), forURLScheme: "remi-app")
        config.userContentController.addScriptMessageHandler(NativeIdentityBridge(authority: state, accessGroup: nil,
            scheme: "remi-app", service: service, account: "owned-dpk", pushState: { self.state }, pushKeys: { self.keys },
            pushTokens: tokens, pushEnvironment: { NativeAPNsEnvironment(query: { production, complete in
                complete(production ? .match : .mismatch); return {}
            }) }, notificationAuthorization: authorization, remoteRegistration: register, foreground: { true }),
            contentWorld: .page, name: NativeIdentityBridge.handlerName)
        let web = WKWebView(frame: .zero, configuration: config)
        web.load(URLRequest(url: try XCTUnwrap(URL(string: "remi-app://localhost/index.html"))))
        for _ in 0..<250 where web.isLoading { try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertFalse(web.isLoading)
        return web
    }
    @MainActor private func call(_ web: WKWebView, op: String, extra: [String: Any] = [:]) async throws -> [String: Any] {
        var request: [String: Any] = ["op": op, "publicKey": identity.publicKeyRaw.base64EncodedString(), "revision": identity.revision]
        for (key, value) in extra { request[key] = value }
        let result = try await web.callAsyncJavaScript(
            "try { return await window.webkit.messageHandlers.remiIdentity.postMessage(request) } catch { return {refused:true} }",
            arguments: ["request": request], in: nil, contentWorld: .page)
        return try XCTUnwrap(result as? [String: Any])
    }
    @MainActor func testActualBundledIngressReturnsOnlyNativeSecureMetadata() async throws {
        let tokens = NativePushTokenOwner(); tokens.recordFromOS(Data([0, 15, 255]))
        let web = try await web(tokens: tokens)
        let result = try await call(web, op: "preparePushRegistration", extra: ["rid": rid.base64EncodedString()])
        XCTAssertEqual(result["token"] as? String, "000fff", "Actual guarded WK caller must prepare from its native OS token")
        XCTAssertEqual(result["environment"] as? String, "production")
        XCTAssertEqual(Set(result.keys), Set(["token", "environment", "pushPublicKey", "keyVersion", "ticket"]))
        XCTAssertNotNil(try keys.load(), "The actual native recipient must be durable before metadata returns")
    }
    @MainActor func testExplicitNativeEnableOwnsOSPermissionAndRegistration() async throws {
        var permissionRequests = 0; var registrations = 0
        let web = try await web(tokens: NativePushTokenOwner(), authorization: { permissionRequests += 1; return true }, register: { registrations += 1 })
        XCTAssertEqual(permissionRequests, 0, "Constructing/loading the bridge cannot request permission")
        XCTAssertEqual(registrations, 0)
        let result = try await call(web, op: "enableSecurePush")
        XCTAssertEqual(result["requested"] as? Bool, true, "Explicit guarded native UI request must own OS registration")
        XCTAssertEqual(permissionRequests, 1)
        XCTAssertEqual(registrations, 1)
    }
    @MainActor func testActualNativeIngressCannotAcceptJavaScriptTokenOrEnvironment() async throws {
        let web = try await web(tokens: NativePushTokenOwner())
        let result = try await call(web, op: "preparePushRegistration", extra: ["rid": rid.base64EncodedString(), "token": "abcd", "environment": "production"])
        XCTAssertEqual(result["refused"] as? Bool, true)
        XCTAssertNil(try keys.load())
    }
    @MainActor func testActualIframeCannotPrepareOrRequestOSPermission() async throws {
        var permissions = 0; var registrations = 0
        let tokens = NativePushTokenOwner(); tokens.recordFromOS(Data([1]))
        let web = try await web(tokens: tokens, authorization: { permissions += 1; return true }, register: { registrations += 1 })
        let result = try await web.callAsyncJavaScript("""
            return await new Promise(resolve => {
              window.addEventListener('message', event => resolve(event.data), {once:true});
              const iframe = document.createElement('iframe');
              iframe.srcdoc = `<script>(async()=>{try {await window.webkit.messageHandlers.remiIdentity.postMessage(${JSON.stringify(request)});parent.postMessage(false,'*')}catch{parent.postMessage(true,'*')}})()</script>`;
              document.body.append(iframe);
            });
            """, arguments: ["request": ["op": "enableSecurePush", "publicKey": identity.publicKeyRaw.base64EncodedString(), "revision": identity.revision]],
            in: nil, contentWorld: .page)
        XCTAssertEqual(result as? Bool, true, "Actual WK frame provenance must refuse the iframe")
        XCTAssertEqual(permissions, 0); XCTAssertEqual(registrations, 0)
        XCTAssertNil(try keys.load())
        let allowed = try await call(web, op: "enableSecurePush")
        XCTAssertEqual(allowed["requested"] as? Bool, true, "The matching actual main frame remains supported")
    }
}
