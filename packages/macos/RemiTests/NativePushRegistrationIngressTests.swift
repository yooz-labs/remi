import CryptoKit
import AppKit
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
    private var machine = Data()
    private var keyQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service + ".push", kSecAttrAccount as String: "owned"]
    }
    override func setUpWithError() throws {
        service = "live.yooz.remi.tests.registration-wk-" + UUID().uuidString
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("remi1200-registration-wk-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        try """
            <html><body>Private registration fixture<script>
            if(window!==top) addEventListener('message',async event=>{
              try {await window.webkit.messageHandlers.remiIdentity.postMessage(event.data);parent.postMessage(false,'*')}
              catch {parent.postMessage(true,'*')}
            });
            </script></body></html>
            """.write(to: directory.appendingPathComponent("index.html"), atomically: true, encoding: .utf8)
        state = try NativePushState(file: directory.appendingPathComponent("public.sqlite"))
        keys = NativePushKeyStore(service: service + ".push", account: "owned", accessGroup: nil)
        identity = try ClientIdentityStore.loadOrCreate(authority: state, accessGroup: nil, service: service, account: "owned-dpk")
        machine = Curve25519.Signing.PrivateKey().publicKey.rawRepresentation
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
    @MainActor func testActualBundledWebProviderPreparesAndConsumesNativeRegistrationTicket() async throws {
        let tokens = NativePushTokenOwner(); tokens.recordFromOS(Data([0, 15, 255]))
        var registrations = 0
        let web = try await web(tokens: tokens, register: { registrations += 1 })
        let path = try XCTUnwrap(ProcessInfo.processInfo.environment["REMI_TEST_NATIVE_PROVIDER_BUNDLE"])
        let script = try String(contentsOfFile: path, encoding: .utf8)
        let evaluated = try await web.callAsyncJavaScript(script + ";return true;", arguments: [:], in: nil, contentWorld: .page)
        XCTAssertEqual(evaluated as? Bool, true)
        let result = try await web.callAsyncJavaScript("""
            try {
              const provider = window.nativeProviderTest;
              const current = await provider.inspectNativeIdentity();
              await provider.enableNativeSecurePush(current.identity);
              const prepared = await provider.prepareNativePushRegistration(current.identity, machine);
              await provider.validateNativePushRegistration(prepared);
              let reused = false;
              try { await provider.validateNativePushRegistration(prepared); reused = true } catch {}
              return {accepted:true,token:prepared.metadata.token,fields:Object.keys(prepared.metadata).sort().join(','),reused};
            } catch { return {accepted:false}; }
            """, arguments: ["machine": machine.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")], in: nil, contentWorld: .page)
        let reply = try XCTUnwrap(result as? [String: Any])
        XCTAssertEqual(reply["accepted"] as? Bool, true, "The actual bundled web provider must use the native OS registration owner")
        XCTAssertEqual(reply["token"] as? String, "000fff")
        XCTAssertEqual(reply["fields"] as? String, "environment,keyVersion,pushPublicKey,token")
        XCTAssertEqual(reply["reused"] as? Bool, false)
        XCTAssertEqual(registrations, 1)
    }
    @MainActor func testActualWebRegistrationCannotPublishAfterIdentityChangesDuringPublicKeyImport() async throws {
        let tokens = NativePushTokenOwner(); tokens.recordFromOS(Data([1]))
        let web = try await web(tokens: tokens)
        let path = try XCTUnwrap(ProcessInfo.processInfo.environment["REMI_TEST_NATIVE_PROVIDER_BUNDLE"])
        let script = try String(contentsOfFile: path, encoding: .utf8)
        let evaluated = try await web.callAsyncJavaScript(script + ";return true;", arguments: [:], in: nil, contentWorld: .page)
        XCTAssertEqual(evaluated as? Bool, true)
        let result = try await web.callAsyncJavaScript("""
            const provider = window.nativeProviderTest;
            const current = await provider.inspectNativeIdentity();
            const original = crypto.subtle.importKey.bind(crypto.subtle);
            let changed = false;
            crypto.subtle.importKey = async (...args) => {
              const key = await original(...args);
              if (args[2]?.name === 'ECDH' && !changed) {
                changed = true;
                await provider.storeLegacy();
              }
              return key;
            };
            try {
              await provider.prepareNativePushRegistration(current.identity, machine);
              return {accepted:true,changed};
            } catch {return {accepted:false,changed};}
            finally {crypto.subtle.importKey = original;}
            """, arguments: ["machine": machine.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")], in: nil, contentWorld: .page)
        let reply = try XCTUnwrap(result as? [String: Any])
        XCTAssertEqual(reply["changed"] as? Bool, true, "The real engine import completes before a real storage identity change")
        XCTAssertEqual(reply["accepted"] as? Bool, false, "The old web continuation cannot publish registration metadata")
        XCTAssertEqual(try ClientIdentityStore.load(authority: state, accessGroup: nil, service: service, account: "owned-dpk")?.publicKeyRaw, identity.publicKeyRaw)
    }
    @MainActor func testActualRenderedSettingsOffersExplicitNativeSecureNotificationEnable() async throws {
        var permissions = 0; var registrations = 0
        let web = try await web(tokens: NativePushTokenOwner(), authorization: { permissions += 1; return true }, register: {registrations += 1})
        let path = try XCTUnwrap(ProcessInfo.processInfo.environment["REMI_TEST_NATIVE_PROVIDER_BUNDLE"])
        let script = try String(contentsOfFile: path, encoding: .utf8)
        let evaluated = try await web.callAsyncJavaScript(script + ";return true;", arguments: [:], in: nil, contentWorld: .page)
        XCTAssertEqual(evaluated as? Bool, true)
        let result = try await web.callAsyncJavaScript("""
            await window.nativeProviderTest.renderNativeSettings();
            let button;
            for(let i=0;i<100;i++) {
              button = [...document.querySelectorAll('button')].find(item=>item.textContent==='Enable secure relay notifications');
              if(button)break;
              await new Promise(resolve=>setTimeout(resolve,10));
            }
            if(!button)return {found:false};
            button.click();
            for(let i=0;i<100;i++) {
              if(document.body.textContent.includes('Notifications requested.'))return {found:true,completed:true};
              await new Promise(resolve=>setTimeout(resolve,10));
            }
            return {found:true,completed:false};
            """, arguments: [:], in: nil, contentWorld: .page)
        let reply = try XCTUnwrap(result as? [String: Any])
        XCTAssertEqual(reply["found"] as? Bool, true, "Actual SettingsPanel must offer the explicit native permission action")
        XCTAssertEqual(reply["completed"] as? Bool, true)
        XCTAssertEqual(permissions,1);XCTAssertEqual(registrations,1)
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
    // #1200 D7: a corrupt P256 item can never be repaired by loadOrCreate, which
    // must not guess. The explicit enable action is the user's repair request.
    @MainActor func testExplicitEnableRepairsACorruptPushKeyAndNeverReplacesAValidOne() async throws {
        let web = try await web(tokens: NativePushTokenOwner())
        let original = try keys.loadOrCreate()
        let kept = try await call(web, op: "enableSecurePush")
        XCTAssertEqual(kept["requested"] as? Bool, true)
        XCTAssertEqual(try keys.load()?.publicKey, original.publicKey, "Enabling never replaces a valid key")
        XCTAssertEqual(SecItemUpdate(keyQuery as CFDictionary, [kSecValueData as String: Data("corrupt".utf8)] as CFDictionary), errSecSuccess)
        XCTAssertThrowsError(try keys.load(), "The fixture item is corrupt")
        let repaired = try await call(web, op: "enableSecurePush")
        XCTAssertEqual(repaired["requested"] as? Bool, true)
        let key = try XCTUnwrap(try keys.load(), "The explicit enable must repair a corrupt item")
        XCTAssertNotEqual(key.publicKey, original.publicKey)
        XCTAssertGreaterThan(key.keyVersion, original.keyVersion, "The replacement must be able to register past the old key")
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
              iframe.src = 'remi-app://localhost/index.html';
              iframe.onload = () => iframe.contentWindow.postMessage(request,'*');
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
    @MainActor func testActualNativeTicketRechecksTokenAndIsOneUse() async throws {
        let tokens = NativePushTokenOwner(); tokens.recordFromOS(Data([1]))
        let web = try await web(tokens: tokens)
        let first = try await call(web, op: "preparePushRegistration", extra: ["rid": rid.base64EncodedString()])
        let ticket = try XCTUnwrap(first["ticket"] as? String)
        let valid = try await call(web, op: "validatePushRegistration", extra: ["ticket": ticket])
        XCTAssertEqual(valid["current"] as? Bool, true)
        let again = try await call(web, op: "validatePushRegistration", extra: ["ticket": ticket])
        XCTAssertEqual(again["refused"] as? Bool, true, "Only one transmission can consume native registration authority")
        let second = try await call(web, op: "preparePushRegistration", extra: ["rid": rid.base64EncodedString()])
        tokens.recordFromOS(Data([2]))
        let changed = try await call(web, op: "validatePushRegistration", extra: ["ticket": XCTUnwrap(second["ticket"] as? String)])
        XCTAssertEqual(changed["refused"] as? Bool, true)
    }
    @MainActor func testActualForgetClosesOutstandingRegistrationTicket() async throws {
        let tokens = NativePushTokenOwner(); tokens.recordFromOS(Data([1]))
        let web = try await web(tokens: tokens)
        let result = try await call(web, op: "preparePushRegistration", extra: ["rid": rid.base64EncodedString()])
        let ticket = try XCTUnwrap(result["ticket"] as? String)
        let forgotten = try await call(web, op: "forgetPushMachine", extra: ["rid": rid.base64EncodedString()])
        XCTAssertEqual(forgotten["forgotten"] as? Bool, true)
        let stale = try await call(web, op: "validatePushRegistration", extra: ["ticket": ticket])
        XCTAssertEqual(stale["refused"] as? Bool, true)
        XCTAssertNil(try state.machineTrust(rid: rid))
    }
    @MainActor func testActualPermissionCompletionAfterForegroundLossCannotRegister() async throws {
        var held: CheckedContinuation<Bool, Never>?
        var registrations = 0
        var requests = 0
        let web = try await web(tokens: NativePushTokenOwner(), authorization: {
            requests += 1
            if requests > 1 { return true }
            return await withCheckedContinuation { held = $0 }
        }, register: { registrations += 1 })
        let pending = Task { try await self.call(web, op: "enableSecurePush") }
        for _ in 0..<100 where held == nil { try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertEqual(requests, 1, "The actual bundled request must reach the OS permission wait")
        NotificationCenter.default.post(name: NativeForegroundUnlock.inactiveNotification, object: nil)
        held?.resume(returning: true); held = nil
        let stale = try await pending.value
        XCTAssertEqual(stale["refused"] as? Bool, true)
        XCTAssertEqual(registrations, 0, "An inactive lifetime cannot be restored by successful OS permission completion")
        let fresh = try await call(web, op: "enableSecurePush")
        XCTAssertEqual(fresh["requested"] as? Bool, true, "A new explicit active request remains available")
        XCTAssertEqual(registrations, 1)
    }
    @MainActor func testActualNativeTicketCapacityDoesNotEvictLiveRequests() async throws {
        let tokens = NativePushTokenOwner(); tokens.recordFromOS(Data([1]))
        let web = try await web(tokens: tokens)
        var tickets: [String] = []
        for _ in 0..<32 {
            let reply = try await call(web, op: "preparePushRegistration", extra: ["rid": rid.base64EncodedString()])
            tickets.append(try XCTUnwrap(reply["ticket"] as? String))
        }
        XCTAssertEqual(Set(tickets).count, 32)
        let full = try await call(web, op: "preparePushRegistration", extra: ["rid": rid.base64EncodedString()])
        XCTAssertEqual(full["refused"] as? Bool, true)
        let original = try await call(web, op: "validatePushRegistration", extra: ["ticket": tickets[0]])
        XCTAssertEqual(original["current"] as? Bool, true, "Capacity refusal cannot evict the first live ticket")
        let resumed = try await call(web, op: "preparePushRegistration", extra: ["rid": rid.base64EncodedString()])
        XCTAssertNotNil(resumed["ticket"] as? String)
    }
    @MainActor func testActualMacOSDelegateCapturesOnlyOSTokenAndFailureClosesIt() throws {
        let tokens = NativePushTokenOwner()
        let delegate = AppDelegate(pushTokens: tokens)
        XCTAssertNil(tokens.snapshot())
        delegate.application(NSApplication.shared, didRegisterForRemoteNotificationsWithDeviceToken: Data([0, 15, 255]))
        XCTAssertEqual(tokens.snapshot()?.token, Data([0, 15, 255]), "The actual app OS delegate must own token capture")
        delegate.application(NSApplication.shared, didFailToRegisterForRemoteNotificationsWithError: NSError(domain: "owned-OS-boundary", code: 1))
        XCTAssertNil(tokens.snapshot(), "An actual OS registration failure closes token authority")
    }
}
