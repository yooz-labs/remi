//
//  ClientIdentityTests.swift
//  RemiTests
//
//  #872: the macOS app's Ed25519 identity. Covers what's testable without a
//  daemon — Keychain persistence, the fingerprint derivation, and Ed25519
//  signing/verification — against REAL vectors generated from
//  packages/shared/src/crypto.ts (the source of truth this must match on
//  the wire), not invented ones.
//
//  Vectors captured via `bun run` against crypto.ts's generateKeyPair(),
//  fingerprint(), and sign():
//    publicKeyBase64:  hTsqoOoMHpkLCHTMC3fmWZ0dPf944WBgvCA/zIkd1Lc=
//    fingerprint:      f851bb1f053baacf
//    challengeBase64:  hbGyBAveiwqpVe4KOI9Ph3WjQ5rEBAjNBAY8JzZ0HSA=
//    signatureBase64:  8OJYmBhAA/4694uebtoQssikFbMYHIhdmlxTAYZQTkon9EGlv1VQhKqsyDbwWahp3dcIf1EVWX2sfrZ3q/5mAw==
//

import CryptoKit
import CoreImage
import AppKit
import Security
import WebKit
import XCTest


final class ClientIdentityTests: XCTestCase {
    // Distinct service/account per test run so this suite never touches (or
    // collides with) the real app's Keychain item.
    private var service = ""
    private var account = ""
    private var authority: NativePushState!
    private var authorityDirectory: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        let unique = UUID().uuidString
        service = "live.yooz.remi.tests.\(unique)"
        account = "ed25519-private-key"
        authorityDirectory = FileManager.default.temporaryDirectory.appendingPathComponent("remi1200-identity-" + unique)
        try FileManager.default.createDirectory(at: authorityDirectory, withIntermediateDirectories: false)
        authority = try NativePushState(file: authorityDirectory.appendingPathComponent("push.sqlite"))
    }

    override func tearDownWithError() throws {
        ClientIdentityStore.resetForTesting(service: service, account: account)
        authority = nil
        try FileManager.default.removeItem(at: authorityDirectory)
        try super.tearDownWithError()
    }

    func testApprovalExportContainsOnlyPublicIdentity() throws {
        let identity = ClientIdentity(privateKey: .init())
        let json = try XCTUnwrap(identity.publicIdentityJSON.data(using: .utf8))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: json) as? [String: String])
        XCTAssertEqual(Set(object.keys), Set(["publicKey", "fingerprint"]))
        XCTAssertEqual(object["publicKey"], identity.publicKeyRaw.base64EncodedString())
        XCTAssertEqual(object["fingerprint"], identity.fingerprint)
        XCTAssertEqual(identity.authorizeCommand, "remi authorize \(identity.fingerprint)")
    }

    func testServerKeyValidatorMatchesActualSharedHelperFixtures() throws {
        struct Case: Decodable {
            let publicKey: String
            let fingerprint: String
            let smallOrder: Bool
        }
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("fixtures/ed25519-server-keys.json")
        let cases = try JSONDecoder().decode([Case].self, from: Data(contentsOf: file))
        XCTAssertEqual(cases.filter { $0.smallOrder }.count, 14)
        XCTAssertEqual(cases.filter { !$0.smallOrder }.count, 2)
        for item in cases {
            let raw = try XCTUnwrap(Data(base64Encoded: item.publicKey))
            XCTAssertEqual(ClientIdentity.isSmallOrderPublicKey(raw), item.smallOrder)
            XCTAssertEqual(ClientIdentity.fingerprint(ofPublicKeyRaw: raw), item.fingerprint)
        }
    }

    // MARK: - Keychain persistence

    func testLoadOrCreatePersistsAcrossInstantiations() throws {
        let first = try ClientIdentityStore.loadOrCreate(authority: authority, accessGroup: nil, service: service, account: account)
        let second = try ClientIdentityStore.loadOrCreate(authority: authority, accessGroup: nil, service: service, account: account)
        XCTAssertEqual(
            first.publicKeyRaw, second.publicKeyRaw,
            "a fresh loadOrCreate() call must return the SAME key as before, not regenerate one")
        XCTAssertEqual(first.fingerprint, second.fingerprint)
    }

    func testResetForTestingForcesAFreshKey() throws {
        let first = try ClientIdentityStore.loadOrCreate(authority: authority, accessGroup: nil, service: service, account: account)
        ClientIdentityStore.resetForTesting(service: service, account: account)
        let second = try ClientIdentityStore.loadOrCreate(authority: authority, accessGroup: nil, service: service, account: account)
        XCTAssertNotEqual(
            first.publicKeyRaw, second.publicKeyRaw,
            "with the Keychain item deleted, loadOrCreate() must generate a new key")
    }

    func testDistinctServiceAccountPairsGetIndependentKeys() throws {
        let a = try ClientIdentityStore.loadOrCreate(authority: authority, accessGroup: nil, service: service, account: account)
        let otherAccount = "\(account)-other"
        let b = try ClientIdentityStore.loadOrCreate(authority: authority, accessGroup: nil, service: service, account: otherAccount)
        defer { ClientIdentityStore.resetForTesting(service: service, account: otherAccount) }
        XCTAssertNotEqual(a.publicKeyRaw, b.publicKeyRaw)
    }

    // MARK: - Fingerprint (known vector from packages/shared/src/crypto.ts)

    func testFingerprintMatchesTypeScriptVector() throws {
        let publicKeyRaw = try XCTUnwrap(
            Data(base64Encoded: "hTsqoOoMHpkLCHTMC3fmWZ0dPf944WBgvCA/zIkd1Lc="))
        XCTAssertEqual(publicKeyRaw.count, 32, "Ed25519 public keys are 32 raw bytes")
        XCTAssertEqual(
            ClientIdentity.fingerprint(ofPublicKeyRaw: publicKeyRaw), "f851bb1f053baacf")
    }

    func testFingerprintIsSixteenHexCharacters() throws {
        let identity = try ClientIdentityStore.loadOrCreate(authority: authority, accessGroup: nil, service: service, account: account)
        XCTAssertEqual(identity.fingerprint.count, 16)
        XCTAssertTrue(identity.fingerprint.allSatisfy(\.isHexDigit))
        // crypto.ts toHex() is lowercase; the daemon compares strings, so
        // case must match exactly or a correct key would look unauthorized.
        XCTAssertEqual(identity.fingerprint, identity.fingerprint.lowercased())
    }

    /// R4: the native store must durably hold a validated PKCS8/public record,
    /// not return a newly generated signer while leaving only a bare seed behind.
    func testKeychainPersistsPKCS8AndPublicRecord() throws {
        let identity = try ClientIdentityStore.loadOrCreate(authority: authority, accessGroup: nil, service: service, account: account)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        XCTAssertEqual(SecItemCopyMatching(query as CFDictionary, &result), errSecSuccess)
        let data = try XCTUnwrap(result as? Data)
        let record = try XCTUnwrap(
            (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
            "The real native Keychain entry must be a versioned PKCS8/public record")
        XCTAssertEqual(record["version"] as? Int, 2)
        let pkcs8 = try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(record["pkcs8"] as? String)))
        XCTAssertEqual(pkcs8.count, 48)
        XCTAssertEqual(record["publicKey"] as? String, identity.publicKeyRaw.base64EncodedString())
    }

    func testCorruptKeychainRefusesWithoutRotationOrDeletion() throws {
        let corrupt = Data("not-an-identity".utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        var create = query
        create[kSecValueData as String] = corrupt
        XCTAssertEqual(SecItemAdd(create as CFDictionary, nil), errSecSuccess)
        do {
            _ = try ClientIdentityStore.loadOrCreate(authority: authority, accessGroup: nil, service: service, account: account)
            XCTFail("Corruption must fail visibly instead of generating a different signer")
        } catch {}
        var read = query
        read[kSecReturnData as String] = true
        var result: AnyObject?
        XCTAssertEqual(SecItemCopyMatching(read as CFDictionary, &result), errSecSuccess)
        XCTAssertEqual(result as? Data, corrupt, "A failed load must preserve the existing entry")
    }

    func testDirectAnswerSignerWorksAfterLegacyPreferencesSeedIsRemoved() throws {
        let suite = "remi1199-direct-answer-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let identity = try ClientIdentityStore.loadOrCreate(authority: authority, accessGroup: nil, service: service, account: account)
        let message = "session|question|yes"
        let auth = try XCTUnwrap(RemiNativeStore.sign(message: message, accessGroup: nil, identity: identity, defaults: defaults),
                                 "The shipping direct-answer signer must use the durable native identity before seed cleanup")
        let signature = try XCTUnwrap(Data(base64Encoded: auth.signature))
        XCTAssertTrue(identity.publicKey.isValidSignature(signature, for: Data(message.utf8)))
        XCTAssertEqual(auth.publicKey, identity.publicKeyRaw.base64EncodedString())
        XCTAssertEqual(auth.fingerprint, identity.fingerprint)
    }

    func testNativeCodecMatchesActualSharedEnginePKCS8Fixtures() throws {
        struct Fixture: Decodable { let pkcs8: String; let publicKey: String; let message: String; let signature: String }
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("fixtures/native-identity-pkcs8.json")
        let fixtures = try JSONDecoder().decode([Fixture].self, from: Data(contentsOf: file))
        XCTAssertEqual(fixtures.count, 2)
        for item in fixtures {
            let pkcs8 = try XCTUnwrap(Data(base64Encoded: item.pkcs8))
            let publicKey = try XCTUnwrap(Data(base64Encoded: item.publicKey))
            let key = try Ed25519PKCS8.decode(pkcs8, publicKey: publicKey)
            XCTAssertEqual(Ed25519PKCS8.encode(key), pkcs8)
            let message = try XCTUnwrap(Data(base64Encoded: item.message))
            let signature = try XCTUnwrap(Data(base64Encoded: item.signature))
            XCTAssertTrue(key.publicKey.isValidSignature(signature, for: message))
            XCTAssertThrowsError(try Ed25519PKCS8.decode(Data(pkcs8.dropLast()), publicKey: publicKey))
            XCTAssertThrowsError(try Ed25519PKCS8.decode(pkcs8, publicKey: Data(publicKey.dropLast())))
            XCTAssertThrowsError(try Ed25519PKCS8.decode(pkcs8 + Data([0]), publicKey: publicKey))
            var malformed = pkcs8; malformed[0] ^= 1
            XCTAssertThrowsError(try Ed25519PKCS8.decode(malformed, publicKey: publicKey))
            let different = ClientIdentity(privateKey: .init())
            XCTAssertThrowsError(try Ed25519PKCS8.decode(pkcs8, publicKey: different.publicKeyRaw))
        }
    }

    func testNativeImportConflictPreservesBothUntilExplicitRevisionChoice() throws {
        let original = try ClientIdentityStore.loadOrCreate(authority: authority, accessGroup: nil, service: service, account: account)
        let incoming = ClientIdentity(privateKey: .init())
        let pkcs8 = Ed25519PKCS8.encode(incoming.privateKey)
        XCTAssertThrowsError(try ClientIdentityStore.importIdentity(authority: authority, accessGroup: nil, pkcs8: pkcs8, publicKey: incoming.publicKeyRaw,
                                                                  service: service, account: account))
        XCTAssertEqual(try ClientIdentityStore.load(authority: authority, accessGroup: nil, service: service, account: account)?.publicKeyRaw, original.publicKeyRaw)
        XCTAssertThrowsError(try ClientIdentityStore.importIdentity(authority: authority, accessGroup: nil, pkcs8: pkcs8, publicKey: original.publicKeyRaw,
                                                                  replacing: original.revision, service: service, account: account))
        XCTAssertEqual(try ClientIdentityStore.load(authority: authority, accessGroup: nil, service: service, account: account)?.revision, original.revision)
        let chosen = try ClientIdentityStore.importIdentity(authority: authority, accessGroup: nil, pkcs8: pkcs8, publicKey: incoming.publicKeyRaw,
                                                            replacing: original.revision, service: service, account: account)
        XCTAssertEqual(chosen.publicKeyRaw, incoming.publicKeyRaw)
        XCTAssertNotEqual(chosen.revision, original.revision)
        XCTAssertEqual(try ClientIdentityStore.load(authority: authority, accessGroup: nil, service: service, account: account)?.revision, chosen.revision)
    }

    @MainActor
    func testNativeBridgeUsesRealFrameProvenanceAndPublicOnlyReplies() async throws {
        let identity = try ClientIdentityStore.loadOrCreate(authority: authority, accessGroup: nil, service: service, account: account)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("remi1199-wk-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let document = root.appendingPathComponent("index.html")
        try "<html><body>Native signer boundary</body></html>".write(to: document, atomically: true, encoding: .utf8)
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.setURLSchemeHandler(DistSchemeHandler(webRoot: root), forURLScheme: "remi-app")
        config.userContentController.addScriptMessageHandler(
            NativeIdentityBridge(authority: authority, accessGroup: nil, scheme: "remi-app", service: service, account: account),
            contentWorld: .page, name: NativeIdentityBridge.handlerName)
        let web = WKWebView(frame: .zero, configuration: config)
        web.load(URLRequest(url: try XCTUnwrap(URL(string: "remi-app://localhost/index.html"))))
        for _ in 0..<250 where web.isLoading { try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertFalse(web.isLoading)
        let publicReply = try await web.callAsyncJavaScript(
            "return await window.webkit.messageHandlers.remiIdentity.postMessage({op:'public'})",
            arguments: [:], in: nil, contentWorld: .page)
        let record = try XCTUnwrap(publicReply as? [String: Any])
        XCTAssertEqual(Set(record.keys), Set(["exists", "publicKey", "fingerprint", "revision", "requiresAppUnlock", "locked"]))
        XCTAssertEqual(record["publicKey"] as? String, identity.publicKeyRaw.base64EncodedString())
        let message = Data("real WK native signing".utf8)
        let signing = "return await window.webkit.messageHandlers.remiIdentity.postMessage({op:'sign',revision:revision,publicKey:publicKey,message:message})"
        let signed = try await web.callAsyncJavaScript(signing, arguments: ["revision":identity.revision,
            "publicKey":identity.publicKeyRaw.base64EncodedString(), "message":message.base64EncodedString()], in: nil, contentWorld: .page)
        let reply = try XCTUnwrap(signed as? [String: Any])
        XCTAssertEqual(Set(reply.keys), Set(["exists", "publicKey", "fingerprint", "revision", "requiresAppUnlock", "locked", "signature"]))
        let signature = try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(reply["signature"] as? String)))
        XCTAssertTrue(identity.publicKey.isValidSignature(signature, for: message))
        let stale = try await web.callAsyncJavaScript(
            "try { await window.webkit.messageHandlers.remiIdentity.postMessage({op:'sign',revision:'stale',publicKey:publicKey,message:message}); return true } catch { return false }",
            arguments: ["publicKey":identity.publicKeyRaw.base64EncodedString(),"message":message.base64EncodedString()], in:nil,contentWorld:.page)
        XCTAssertEqual(stale as? Bool, false)
        let oversized = try await web.callAsyncJavaScript(
            "try { await window.webkit.messageHandlers.remiIdentity.postMessage({op:'sign',revision:revision,publicKey:publicKey,message:btoa('x'.repeat(9000))}); return true } catch { return false }",
            arguments: ["publicKey":identity.publicKeyRaw.base64EncodedString(),"revision":identity.revision], in:nil,contentWorld:.page)
        XCTAssertEqual(oversized as? Bool, false)
        let iframe = try await web.callAsyncJavaScript("""
            return await new Promise(resolve => {
              const frame = document.createElement('iframe');
              window.addEventListener('message', event => { if (event.source === frame.contentWindow) resolve(event.data) });
              frame.srcdoc = `<script>window.webkit.messageHandlers.remiIdentity.postMessage({op:'public'}).then(() => parent.postMessage(true,'*'), () => parent.postMessage(false,'*'))</script>`;
              document.body.appendChild(frame);
            });
            """, arguments: [:], in:nil,contentWorld:.page)
        XCTAssertEqual(iframe as? Bool, false, "A real child frame must not reach the native signer")
        web.loadFileURL(document, allowingReadAccessTo: root)
        for _ in 0..<250 where web.isLoading { try await Task.sleep(nanoseconds: 20_000_000) }
        let external = try await web.callAsyncJavaScript(
            "try { await window.webkit.messageHandlers.remiIdentity.postMessage({op:'public'}); return true } catch { return false }",
            arguments:[:], in:nil,contentWorld:.page)
        XCTAssertEqual(external as? Bool, false, "An external main document must not reach the native signer")
    }

    private func generatedPairingQRImage(text: String? = nil) throws -> (String, Data) {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("shared/tests/fixtures/relay-v2/vectors.json")
        let vectors = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        let pairing = try XCTUnwrap(vectors["pairingToken"] as? [String: Any])
        let item = try XCTUnwrap(pairing["noSealKey"] as? [String: Any])
        let token = try text ?? XCTUnwrap(item["text"] as? String)
        let generator = try XCTUnwrap(CIFilter(name: "CIQRCodeGenerator"))
        generator.setValue(Data(token.utf8), forKey: "inputMessage")
        generator.setValue("M", forKey: "inputCorrectionLevel")
        let modules = try XCTUnwrap(generator.outputImage)
        // Add an opaque white four-module quiet zone before integer scaling,
        // matching remi pair's margin instead of relying on the generator border.
        let background = CIImage(color: .white).cropped(to: modules.extent.insetBy(dx: -4, dy: -4))
        let image = modules.composited(over: background).transformed(by: CGAffineTransform(scaleX: 8, y: 8))
        let cgImage = try XCTUnwrap(CIContext().createCGImage(image, from: image.extent))
        let data = try XCTUnwrap(NSBitmapImageRep(cgImage: cgImage).representation(using: .png, properties: [:]))
        return (token, data)
    }

    func testGeneratedPairingQRHasFourModuleQuietZone() throws {
        let (_, image) = try generatedPairingQRImage()
        let bitmap = try XCTUnwrap(NSBitmapImageRep(data: image))
        // The fixture uses eight pixels per module. Check the actual PNG, not
        // generator settings: QR requires four clear white modules on every side.
        let quietZone = 4 * 8
        XCTAssertGreaterThan(bitmap.pixelsWide, quietZone * 2)
        XCTAssertGreaterThan(bitmap.pixelsHigh, quietZone * 2)
        var opaqueWhiteBorder = true
        for y in 0..<bitmap.pixelsHigh {
            for x in 0..<bitmap.pixelsWide where x < quietZone || y < quietZone ||
                x >= bitmap.pixelsWide - quietZone || y >= bitmap.pixelsHigh - quietZone {
                let pixel = try XCTUnwrap(bitmap.colorAt(x: x, y: y))
                opaqueWhiteBorder = opaqueWhiteBorder && pixel.alphaComponent == 1 &&
                    pixel.redComponent == 1 && pixel.greenComponent == 1 && pixel.blueComponent == 1
            }
        }
        XCTAssertTrue(opaqueWhiteBorder, "QR fixture must have four opaque white modules on every side")
    }

    @MainActor
    func testNativePairingQRHasGuardedBundledIngress() async throws {
        let (token, fixtureImage) = try generatedPairingQRImage()
        var image = fixtureImage
        XCTAssertEqual(try NativePairingQRDecoder.decode(image), token, "Actual Vision must decode the actual shared token bytes")
        XCTAssertThrowsError(try NativePairingQRDecoder.decode(Data(repeating: 0, count: NativePairingQRDecoder.maximumImageBytes + 1)))
        XCTAssertThrowsError(try NativePairingQRDecoder.decode(image + Data(repeating: 0, count: NativePairingQRDecoder.maximumImageBytes)), "Even a valid QR with oversized trailing bytes must refuse before decode")
        XCTAssertThrowsError(try NativePairingQRDecoder.decode(Data("not an image".utf8)))
        let huge = CIImage(color: CIColor.white).cropped(to: CGRect(x: 0, y: 0, width: 5000, height: 2))
        let hugeCG = try XCTUnwrap(CIContext().createCGImage(huge, from: huge.extent))
        let hugeData = try XCTUnwrap(NSBitmapImageRep(cgImage: hugeCG).representation(using: .png, properties: [:]))
        XCTAssertThrowsError(try NativePairingQRDecoder.decode(hugeData), "Dimensions must be bounded before Vision")
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("remi1199-qr-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let document = root.appendingPathComponent("index.html")
        try "<html><body>QR selection boundary</body></html>".write(to: document, atomically: true, encoding: .utf8)
        let config = WKWebViewConfiguration(); config.websiteDataStore = .nonPersistent()
        config.setURLSchemeHandler(DistSchemeHandler(webRoot: root), forURLScheme: "remi-app")
        var selectionCount = 0
        var heldSelection: CheckedContinuation<Data?, Never>?
        var hold = false
        let bridge = NativeIdentityBridge(authority: authority, accessGroup: nil, scheme: "remi-app", service: service, account: account,
            foreground: { true }, selectedQRImage: { _ in
                selectionCount += 1
                if hold { return await withCheckedContinuation { heldSelection = $0 } }
                return image
            })
        config.userContentController.addScriptMessageHandler(bridge,
            contentWorld: .page, name: NativeIdentityBridge.handlerName)
        let web = WKWebView(frame: .zero, configuration: config)
        web.load(URLRequest(url: try XCTUnwrap(URL(string: "remi-app://localhost/index.html"))))
        for _ in 0..<250 where web.isLoading { try await Task.sleep(nanoseconds: 20_000_000) }
        let decoded = try await web.callAsyncJavaScript(
            "return await window.webkit.messageHandlers.remiIdentity.postMessage({op:'scanQR',id:'qr-owned'})",
            arguments: [:], in: nil, contentWorld: .page)
        XCTAssertEqual((decoded as? [String: String])?["token"], token, "Bundled main-frame must return exact locally decoded token")
        let bundlePath = try XCTUnwrap(ProcessInfo.processInfo.environment["REMI_TEST_NATIVE_PROVIDER_BUNDLE"])
        let bundleLoaded = try await web.evaluateJavaScript("(function(){" + String(contentsOfFile: bundlePath, encoding: .utf8) + "})(); true")
        XCTAssertEqual(bundleLoaded as? Bool, true, "Actual provider bundle evaluation must complete before use")
        let freshReply = try await web.callAsyncJavaScript(
            "return await window.nativeProviderTest.freshQRToken()", arguments: [:], in: nil, contentWorld: .page)
        let freshToken = try XCTUnwrap(freshReply as? String)
        image = try generatedPairingQRImage(text: freshToken).1
        let providerToken = try await web.callAsyncJavaScript(
            "return await window.nativeProviderTest.readNativePairingQR(new AbortController().signal)",
            arguments: [:], in: nil, contentWorld: .page)
        XCTAssertEqual(providerToken as? String, freshToken, "Actual native ingress and shared WebCrypto token decoder must preserve the selected token")
        let iframe = try await web.callAsyncJavaScript("""
            return await new Promise(resolve => {
              const frame = document.createElement('iframe');
              window.addEventListener('message', event => { if (event.source === frame.contentWindow) resolve(event.data) });
              frame.srcdoc = `<script>window.webkit.messageHandlers.remiIdentity.postMessage({op:'scanQR',id:'iframe'}).then(() => parent.postMessage(true,'*'), () => parent.postMessage(false,'*'))</script>`;
              document.body.appendChild(frame);
            });
            """, arguments: [:], in: nil, contentWorld: .page)
        XCTAssertEqual(iframe as? Bool, false, "A real iframe must not start native image selection")
        XCTAssertEqual(selectionCount, 2)
        hold = true
        let late = Task { @MainActor in
            try await web.callAsyncJavaScript(
                "try { await window.webkit.messageHandlers.remiIdentity.postMessage({op:'scanQR',id:'late'}); return true } catch { return false }",
                arguments: [:], in: nil, contentWorld: .page)
        }
        for _ in 0..<250 where heldSelection == nil { try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertNotNil(heldSelection)
        NotificationCenter.default.post(name: NativeForegroundUnlock.inactiveNotification, object: nil)
        heldSelection?.resume(returning: image); heldSelection = nil
        let lateResult = try await late.value
        XCTAssertEqual(lateResult as? Bool, false, "Inactivity must suppress a selected-image continuation")
        let canceled = Task { @MainActor in
            try await web.callAsyncJavaScript("""
                window.qrAbort = new AbortController();
                try { await window.nativeProviderTest.readNativePairingQR(window.qrAbort.signal); return true }
                catch { return false }
                """, arguments: [:], in: nil, contentWorld: .page)
        }
        for _ in 0..<250 where heldSelection == nil { try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertNotNil(heldSelection)
        let aborted = try await web.evaluateJavaScript("window.qrAbort.abort(); true")
        XCTAssertEqual(aborted as? Bool, true, "Actual AbortController evaluation must complete before awaiting cancellation")
        let canceledResult = try await canceled.value
        XCTAssertEqual(canceledResult as? Bool, false, "Actual TS cancellation must end the native QR request")
        heldSelection?.resume(returning: image); heldSelection = nil
        web.loadFileURL(document, allowingReadAccessTo: root)
        for _ in 0..<250 where web.isLoading { try await Task.sleep(nanoseconds: 20_000_000) }
        let external = try await web.callAsyncJavaScript(
            "try { await window.webkit.messageHandlers.remiIdentity.postMessage({op:'scanQR',id:'external'}); return true } catch { return false }",
            arguments: [:], in: nil, contentWorld: .page)
        XCTAssertEqual(external as? Bool, false, "An external main document must not start native image selection")
        XCTAssertEqual(selectionCount, 4)
    }

    // This boundary schedules OS foreground loss only after the actual production
    // file lock is acquired. It forwards all durable authority operations unchanged.
    private final class MutationForegroundBoundary: NativeIdentityAuthorityBarrier {
        let state: NativePushState
        var active = true
        init(_ state: NativePushState) { self.state = state }
        func acquireIdentityMutation() throws -> NativeIdentityMutationLease {
            let lease = try state.acquireIdentityMutation()
            active = false
            return lease
        }
        func reconcileObservedIdentity(publicKey: Data?, revision: String?, requiresAppUnlock: Bool?) throws {
            try state.reconcileObservedIdentity(publicKey: publicKey, revision: revision, requiresAppUnlock: requiresAppUnlock)
        }
    }

    @MainActor
    func testActualBundledBridgeRefusesForegroundLossAfterWriterLock() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("remi1200-mutation-wk-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: root) }
        try "<html><body>Identity mutation</body></html>".write(to: root.appendingPathComponent("index.html"), atomically: true, encoding: .utf8)
        let boundary = MutationForegroundBoundary(authority)
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.setURLSchemeHandler(DistSchemeHandler(webRoot: root), forURLScheme: "remi-app")
        config.userContentController.addScriptMessageHandler(
            NativeIdentityBridge(authority: boundary, accessGroup: nil, scheme: "remi-app", service: service, account: account,
                foreground: { boundary.active }), contentWorld: .page, name: NativeIdentityBridge.handlerName)
        let web = WKWebView(frame: .zero, configuration: config)
        web.load(URLRequest(url: try XCTUnwrap(URL(string: "remi-app://localhost/index.html"))))
        for _ in 0..<250 where web.isLoading { try await Task.sleep(nanoseconds: 20_000_000) }
        let incoming = ClientIdentity(privateKey: .init())
        let imported = try await web.callAsyncJavaScript(
            "try { await window.webkit.messageHandlers.remiIdentity.postMessage({op:'import',pkcs8:pkcs8,publicKey:publicKey,revision:null,requiresAppUnlock:false}); return true } catch { return false }",
            arguments: ["pkcs8": Ed25519PKCS8.encode(incoming.privateKey).base64EncodedString(), "publicKey": incoming.publicKeyRaw.base64EncodedString()],
            in: nil, contentWorld: .page)
        XCTAssertEqual(imported as? Bool, false, "Actual bundled import must recheck foreground AFTER acquiring the writer lock")
        XCTAssertNil(try ClientIdentityStore.load(authority: authority, accessGroup: nil, service: service, account: account),
                     "Cancelled import cannot leave a private key or public authority behind")
        XCTAssertNil(try authority.currentAuthority())
        guard imported as? Bool == false else { return }
        let prior = try ClientIdentityStore.loadOrCreate(authority: authority, accessGroup: nil, service: service, account: account)
        boundary.active = true
        let protected = try await web.callAsyncJavaScript(
            "try { await window.webkit.messageHandlers.remiIdentity.postMessage({op:'protect',revision:revision,publicKey:publicKey}); return true } catch { return false }",
            arguments: ["revision": prior.revision, "publicKey": prior.publicKeyRaw.base64EncodedString()], in: nil, contentWorld: .page)
        XCTAssertEqual(protected as? Bool, false, "Protection mutation must recheck foreground AFTER acquiring the writer lock")
        let unchanged = try XCTUnwrap(ClientIdentityStore.load(authority: authority, accessGroup: nil, service: service, account: account))
        XCTAssertEqual(unchanged.revision, prior.revision)
        XCTAssertFalse(unchanged.requiresAppUnlock)
        XCTAssertEqual(try authority.currentAuthority()?.revision, prior.revision)
    }

    @MainActor
    func testProtectedImportArrivingAfterInactiveCannotUnlockBridge() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("remi1199-protected-wk-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try "<html><body>Protected import</body></html>".write(to: root.appendingPathComponent("index.html"), atomically: true, encoding: .utf8)
        var active = false
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.setURLSchemeHandler(DistSchemeHandler(webRoot: root), forURLScheme: "remi-app")
        config.userContentController.addScriptMessageHandler(
            NativeIdentityBridge(authority: authority, accessGroup: nil, scheme: "remi-app", service: service, account: account, foreground: { active }, authorization: { true }),
            contentWorld: .page, name: NativeIdentityBridge.handlerName)
        let web = WKWebView(frame: .zero, configuration: config)
        web.load(URLRequest(url: try XCTUnwrap(URL(string: "remi-app://localhost/index.html"))))
        for _ in 0..<250 where web.isLoading { try await Task.sleep(nanoseconds: 20_000_000) }
        let legacy = ClientIdentity(privateKey: .init())
        XCTAssertFalse(NativeForegroundUnlock.isActive(), "Unhosted test process must not activate the user app")
        NotificationCenter.default.post(name: NativeForegroundUnlock.inactiveNotification, object: nil)
        active = true // OS foreground boundary: resuming does not revive the original decrypt interaction.
        let imported = try await web.callAsyncJavaScript(
            "try { return await window.webkit.messageHandlers.remiIdentity.postMessage({op:'import',pkcs8:pkcs8,publicKey:publicKey,revision:null,requiresAppUnlock:true}) } catch { return {refused:true} }",
            arguments: ["pkcs8":Ed25519PKCS8.encode(legacy.privateKey).base64EncodedString(),"publicKey":legacy.publicKeyRaw.base64EncodedString()],
            in:nil, contentWorld:.page)
        let reply = try XCTUnwrap(imported as? [String:Any])
        XCTAssertNil(reply["refused"], "Explicit import may persist the protected native record")
        XCTAssertEqual(reply["locked"] as? Bool, true, "A decrypted legacy import arriving after resign-active cannot restore foreground signing")
        XCTAssertTrue(try XCTUnwrap(ClientIdentityStore.load(authority: authority, accessGroup: nil, service:service,account:account)).requiresAppUnlock)
    }

    @MainActor
    func testProtectedLegacyImportSignsForegroundThroughRealBridgeOnly() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("remi1199-protected-wk-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try "<html><body>Protected import</body></html>".write(to: root.appendingPathComponent("index.html"), atomically: true, encoding: .utf8)
        var active = true
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.setURLSchemeHandler(DistSchemeHandler(webRoot: root), forURLScheme: "remi-app")
        config.userContentController.addScriptMessageHandler(
            NativeIdentityBridge(authority: authority, accessGroup: nil, scheme: "remi-app", service: service, account: account, foreground: { active }, authorization: { true }),
            contentWorld: .page, name: NativeIdentityBridge.handlerName)
        let web = WKWebView(frame: .zero, configuration: config)
        web.load(URLRequest(url: try XCTUnwrap(URL(string: "remi-app://localhost/index.html"))))
        for _ in 0..<250 where web.isLoading { try await Task.sleep(nanoseconds: 20_000_000) }
        let legacy = ClientIdentity(privateKey: .init())
        let imported = try await web.callAsyncJavaScript(
            "try { return await window.webkit.messageHandlers.remiIdentity.postMessage({op:'import',pkcs8:pkcs8,publicKey:publicKey,revision:null,requiresAppUnlock:true}) } catch { return {refused:true} }",
            arguments: ["pkcs8":Ed25519PKCS8.encode(legacy.privateKey).base64EncodedString(),"publicKey":legacy.publicKeyRaw.base64EncodedString()],
            in:nil, contentWorld:.page)
        let reply = try XCTUnwrap(imported as? [String:Any])
        XCTAssertNil(reply["refused"], "Explicit protected legacy import must reach durable native storage")
        guard reply["refused"] == nil else { return }
        XCTAssertEqual(reply["requiresAppUnlock"] as? Bool, true)
        XCTAssertEqual(reply["locked"] as? Bool, true, "Import cannot implicitly unlock even in an active foreground")
        let unlocked = try await web.callAsyncJavaScript(
            "return await window.webkit.messageHandlers.remiIdentity.postMessage({op:'unlock',revision:revision,publicKey:publicKey})",
            arguments:["revision":reply["revision"]!,"publicKey":legacy.publicKeyRaw.base64EncodedString()],in:nil,contentWorld:.page)
        XCTAssertEqual((unlocked as? [String:Any])?["locked"] as? Bool,false)
        let durable = try XCTUnwrap(ClientIdentityStore.load(authority: authority, accessGroup: nil, service:service,account:account))
        let message = Data("protected bridge signing".utf8)
        let signed = try await web.callAsyncJavaScript(
            "return await window.webkit.messageHandlers.remiIdentity.postMessage({op:'sign',revision:revision,publicKey:publicKey,message:message})",
            arguments:["revision":durable.revision,"publicKey":durable.publicKeyRaw.base64EncodedString(),"message":message.base64EncodedString()],
            in:nil,contentWorld:.page)
        let signature = try XCTUnwrap(Data(base64Encoded:try XCTUnwrap((signed as? [String:Any])?["signature"] as? String)))
        XCTAssertTrue(legacy.publicKey.isValidSignature(signature,for:message))
        active = false // Sign must check OS state even if no inactive callback has arrived yet.
        let inactiveSign = try await web.callAsyncJavaScript(
            "try { await window.webkit.messageHandlers.remiIdentity.postMessage({op:'sign',revision:revision,publicKey:publicKey,message:message}); return true } catch { return false }",
            arguments:["revision":durable.revision,"publicKey":durable.publicKeyRaw.base64EncodedString(),"message":message.base64EncodedString()],in:nil,contentWorld:.page)
        XCTAssertEqual(inactiveSign as? Bool,false,"Protected signer must check current foreground state at ingress")
        active = true
        _ = try await web.callAsyncJavaScript(
            "window.nativeLockEvents = 0; window.addEventListener('remi:native-identity-locked', () => { ++window.nativeLockEvents; });",
            arguments:[:],in:nil,contentWorld:.page)
        NotificationCenter.default.post(name: NativeForegroundUnlock.inactiveNotification, object: nil)
        let lockEvents = try await web.callAsyncJavaScript("return window.nativeLockEvents",arguments:[:],in:nil,contentWorld:.page)
        XCTAssertEqual(lockEvents as? Int,1,"Actual native inactivity must notify the web channel owner without exposing identity bytes")
        let suite = "remi1199-protected-bridge-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName:suite))
        defer { defaults.removePersistentDomain(forName:suite) }
        XCTAssertNil(RemiNativeStore.sign(message:"session|question|yes",accessGroup:nil,identity:durable,defaults:defaults))
        // Reconstructing the actual bridge loses the foreground unlock, never the durable policy.
        config.userContentController.removeScriptMessageHandler(forName:NativeIdentityBridge.handlerName,contentWorld:.page)
        config.userContentController.addScriptMessageHandler(
            NativeIdentityBridge(authority: authority, accessGroup: nil, scheme:"remi-app",service:service,account:account),contentWorld:.page,name:NativeIdentityBridge.handlerName)
        let cold = try await web.callAsyncJavaScript(
            "try { await window.webkit.messageHandlers.remiIdentity.postMessage({op:'sign',revision:revision,publicKey:publicKey,message:message}); return true } catch { return false }",
            arguments:["revision":durable.revision,"publicKey":durable.publicKeyRaw.base64EncodedString(),"message":message.base64EncodedString()],in:nil,contentWorld:.page)
        XCTAssertEqual(cold as? Bool,false,"A cold bridge must require explicit foreground authentication")
    }

    func testProtectedNativeIdentityRefusesBackgroundButCanSignInForeground() throws {
        _ = try ClientIdentityStore.loadOrCreate(authority: authority, accessGroup: nil, service: service, account: account)
        let query: [String: Any] = [kSecClass as String:kSecClassGenericPassword,
            kSecAttrService as String:service,kSecAttrAccount as String:account]
        var read = query; read[kSecReturnData as String] = true
        var result: AnyObject?
        XCTAssertEqual(SecItemCopyMatching(read as CFDictionary, &result), errSecSuccess)
        var record = try XCTUnwrap(try JSONSerialization.jsonObject(with: try XCTUnwrap(result as? Data)) as? [String:Any])
        record["requiresAppUnlock"] = true
        XCTAssertEqual(SecItemUpdate(query as CFDictionary,
            [kSecValueData as String:try JSONSerialization.data(withJSONObject:record)] as CFDictionary),errSecSuccess)
        let protected = try XCTUnwrap(ClientIdentityStore.load(authority: authority, accessGroup: nil, service:service,account:account))
        XCTAssertTrue(protected.requiresAppUnlock)
        let message = Data("protected foreground signing".utf8)
        XCTAssertTrue(protected.publicKey.isValidSignature(try protected.sign(message),for:message))
        let suite = "remi1199-protected-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName:suite))
        defer { defaults.removePersistentDomain(forName:suite) }
        XCTAssertNil(RemiNativeStore.sign(message:"session|question|yes",accessGroup:nil,identity:protected,defaults:defaults),
                     "An imported app-unlock policy must not silently enable background answers")
    }

    func testProtectedImportPersistsPolicyAndCannotSilentlyRemoveIt() throws {
        let incoming = ClientIdentity(privateKey: .init())
        let protected = try ClientIdentityStore.importIdentity(authority: authority, accessGroup: nil,
            pkcs8: Ed25519PKCS8.encode(incoming.privateKey), publicKey: incoming.publicKeyRaw,
            requiresAppUnlock: true, service: service, account: account)
        XCTAssertTrue(try XCTUnwrap(ClientIdentityStore.load(authority: authority, accessGroup: nil, service: service, account: account)).requiresAppUnlock)
        let replacement = ClientIdentity(privateKey: .init())
        let imported = try ClientIdentityStore.importIdentity(authority: authority, accessGroup: nil,
            pkcs8: Ed25519PKCS8.encode(replacement.privateKey), publicKey: replacement.publicKeyRaw,
            replacing: protected.revision, requiresAppUnlock: false, service: service, account: account)
        XCTAssertTrue(imported.requiresAppUnlock, "Replacement cannot implicitly enable background signing")
        XCTAssertNotEqual(imported.revision, protected.revision)
    }

    @MainActor
    func testNativeReplacementInvalidatesCapturedHubIdentity() {
        let identity = ClientIdentity(privateKey: .init())
        let hub = HubClient(scanPorts: [], identity: identity)
        XCTAssertEqual(hub.publicFingerprint, identity.fingerprint)
        NotificationCenter.default.post(name: .nativeIdentityReplaced, object: nil)
        XCTAssertEqual(hub.publicFingerprint, "", "A captured monitor signer must stop when the WebView replaces its key")
        guard case .identityUnavailable = hub.phase else {
            return XCTFail("Native replacement must require restart before the monitor uses a new identity")
        }
    }

    @MainActor
    func testForegroundUnlockCompletionCannotSurviveInactiveOrReplacement() async throws {
        let identity = try ClientIdentityStore.loadOrCreate(authority: authority, accessGroup: nil, service:service,account:account)
        let lifetime = NativeUnlockLifetime()
        let baseline = await lifetime.authenticate(revision:identity.revision, currentRevision:{identity.revision},
                                                   authorization:{true},foreground:{true})
        XCTAssertTrue(baseline, "A current foreground OS-auth completion remains usable")
        for notification in [NativeForegroundUnlock.inactiveNotification, .nativeIdentityReplaced] {
            let waiting = expectation(description:"OS-auth boundary suspended")
            var completion: CheckedContinuation<Bool,Never>?
            let task = Task { @MainActor in
                await lifetime.authenticate(revision:identity.revision,currentRevision:{identity.revision},
                    authorization:{ await withCheckedContinuation { completion = $0; waiting.fulfill() } },foreground:{true})
            }
            await fulfillment(of:[waiting],timeout:2)
            NotificationCenter.default.post(name:notification,object:nil)
            completion?.resume(returning:true)
            let accepted = await task.value
            XCTAssertFalse(accepted, "An inactive/replacement event must cancel the actual OS-auth continuation even if foreground resumes")
        }
        var active = true
        let accepted = await lifetime.authenticate(revision:identity.revision,currentRevision:{identity.revision},
            authorization:{active = false; return true},foreground:{active})
        XCTAssertFalse(accepted,"Foreground must be checked after the OS authentication await")
    }

    @MainActor
    func testActualBundledPairingTrustCommitsOnlyCurrentNativeAttempt() async throws {
        let identity = try ClientIdentityStore.loadOrCreate(authority: authority, accessGroup: nil, service: service, account: account)
        let root = authorityDirectory.appendingPathComponent("pairing-web")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        try "<html><body>Completed pairing trust</body></html>".write(to: root.appendingPathComponent("index.html"), atomically: true, encoding: .utf8)
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.setURLSchemeHandler(DistSchemeHandler(webRoot: root), forURLScheme: "remi-app")
        config.userContentController.addScriptMessageHandler(
            NativeIdentityBridge(authority: authority, accessGroup: nil, scheme: "remi-app", service: service, account: account,
                pushState: { self.authority }, foreground: { true }), contentWorld: .page, name: NativeIdentityBridge.handlerName)
        let web = WKWebView(frame: .zero, configuration: config)
        web.load(URLRequest(url: try XCTUnwrap(URL(string: "remi-app://localhost/index.html"))))
        for _ in 0..<250 where web.isLoading { try await Task.sleep(nanoseconds: 20_000_000) }
        let began = try await web.callAsyncJavaScript("""
            try {
              window.pairAttempt = await window.webkit.messageHandlers.remiIdentity.postMessage({op:'beginPushPairing',publicKey,revision});
              return typeof window.pairAttempt.attempt === 'string';
            } catch { return false; }
            """, arguments: ["publicKey": identity.publicKeyRaw.base64EncodedString(), "revision": identity.revision], in: nil, contentWorld: .page)
        XCTAssertEqual(began as? Bool, true, "Actual bundled ingress must issue a bounded native pairing attempt")
        guard began as? Bool == true else { return }
        XCTAssertNil(try authority.machineTrust(rid: Data(repeating: 0, count: 16)), "Beginning cannot install completed trust")
        let machine = Curve25519.Signing.PrivateKey().publicKey.rawRepresentation
        let rid = Data(SHA256.hash(data: machine).prefix(16))
        let committed = try await web.callAsyncJavaScript("""
            window.completedRequest = {op:'commitPushPairing',attempt:window.pairAttempt.attempt,publicKey,revision,
              machinePublicKey,rid,endpoint:'https://relay.example.invalid',relayUrl:'wss://relay.example.invalid/prefix'};
            try { const result = await window.webkit.messageHandlers.remiIdentity.postMessage(window.completedRequest); return result.saved === true; }
            catch { return false; }
            """, arguments: ["publicKey": identity.publicKeyRaw.base64EncodedString(), "revision": identity.revision,
                              "machinePublicKey": machine.base64EncodedString(), "rid": rid.base64EncodedString()], in: nil, contentWorld: .page)
        XCTAssertEqual(committed as? Bool, true, "Current native attempt must durably commit exact public READY trust")
        XCTAssertEqual(try NativePushState(file: authorityDirectory.appendingPathComponent("push.sqlite")).machineTrust(rid: rid)?.machinePublicKey, machine)
        let reused = try await web.callAsyncJavaScript("""
            try { await window.webkit.messageHandlers.remiIdentity.postMessage(window.completedRequest); return true; }
            catch { return false; }
            """, arguments: [:], in: nil, contentWorld: .page)
        XCTAssertEqual(reused as? Bool, false, "Completed native attempt cannot be reused")
        let restored = try await web.callAsyncJavaScript("""
            const result = await window.webkit.messageHandlers.remiIdentity.postMessage({op:'listPushMachines',publicKey,revision});
            return result.machines.map(machine => machine.relayUrl);
            """, arguments: ["publicKey": identity.publicKeyRaw.base64EncodedString(), "revision": identity.revision], in: nil, contentWorld: .page)
        XCTAssertEqual(restored as? [String], ["wss://relay.example.invalid/prefix"], "Native restore must retain the verified relay path")
        let cancelled = try await web.callAsyncJavaScript("""
            const next = await window.webkit.messageHandlers.remiIdentity.postMessage({op:'beginPushPairing',publicKey,revision});
            await window.webkit.messageHandlers.remiIdentity.postMessage({op:'cancelPushPairing',attempt:next.attempt});
            try { await window.webkit.messageHandlers.remiIdentity.postMessage({...window.completedRequest,attempt:next.attempt}); return true; }
            catch { return false; }
            """, arguments: ["publicKey": identity.publicKeyRaw.base64EncodedString(), "revision": identity.revision], in: nil, contentWorld: .page)
        XCTAssertEqual(cancelled as? Bool, false, "Cancelled native attempt cannot install later READY trust")
        let pending = try await web.callAsyncJavaScript("""
            const next = await window.webkit.messageHandlers.remiIdentity.postMessage({op:'beginPushPairing',publicKey,revision});
            window.completedRequest.attempt = next.attempt; return true;
            """, arguments: ["publicKey": identity.publicKeyRaw.base64EncodedString(), "revision": identity.revision], in: nil, contentWorld: .page)
        XCTAssertEqual(pending as? Bool, true)
        _ = try ClientIdentityStore.requireAppUnlock(authority: authority, accessGroup: nil, revision: identity.revision,
            publicKey: identity.publicKeyRaw, service: service, account: account)
        let stale = try await web.callAsyncJavaScript("""
            try { await window.webkit.messageHandlers.remiIdentity.postMessage(window.completedRequest); return true; }
            catch { return false; }
            """, arguments: [:], in: nil, contentWorld: .page)
        XCTAssertEqual(stale as? Bool, false, "A private identity policy revision must invalidate the captured native pairing attempt")
        XCTAssertNil(try authority.machineTrust(rid: rid), "Stale READY cannot restore trust after identity mutation")
    }

    @MainActor
    private func providerWebView() async throws -> (WKWebView, URL) {
        let bundle = try XCTUnwrap(ProcessInfo.processInfo.environment["REMI_TEST_NATIVE_PROVIDER_BUNDLE"],
            "Build web/tests/browser/build-native-provider-harness.ts into private state and set REMI_TEST_NATIVE_PROVIDER_BUNDLE")
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("remi1199-provider-wk-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        try Data(contentsOf:URL(fileURLWithPath:bundle)).write(to:root.appendingPathComponent("provider.js"))
        try "<html><body>Real native provider<script src='/provider.js'></script></body></html>".write(
            to:root.appendingPathComponent("index.html"),atomically:true,encoding:.utf8)
        let config = WKWebViewConfiguration(); config.websiteDataStore = .nonPersistent()
        config.setURLSchemeHandler(DistSchemeHandler(webRoot:root),forURLScheme:"remi-app")
        config.userContentController.addScriptMessageHandler(
            NativeIdentityBridge(authority: authority, accessGroup: nil, scheme:"remi-app",service:service,account:account,pushState:{ self.authority },foreground:{ true },authorization:{ true }),contentWorld:.page,name:NativeIdentityBridge.handlerName)
        let web = WKWebView(frame:.zero,configuration:config)
        web.load(URLRequest(url:try XCTUnwrap(URL(string:"remi-app://localhost/index.html"))))
        for _ in 0..<250 where web.isLoading { try await Task.sleep(nanoseconds:20_000_000) }
        XCTAssertFalse(web.isLoading)
        return (web,root)
    }

    @MainActor
    func testActualWebProviderPersistsAndForgetsOnlyNativeCompletedTrust() async throws {
        let native = try ClientIdentityStore.loadOrCreate(authority: authority, accessGroup: nil, service: service, account: account)
        let machine = Curve25519.Signing.PrivateKey().publicKey.rawRepresentation
        let rid = Data(SHA256.hash(data: machine).prefix(16))
        let machineB64u = machine.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let (web, root) = try await providerWebView()
        defer { try? FileManager.default.removeItem(at: root) }
        let saved = try await web.callAsyncJavaScript("""
            const api = window.nativeProviderTest;
            const state = await api.inspectNativeIdentity();
            if (state.kind !== 'ready') throw new Error('native signer unavailable');
            window.nativeSigner = state.identity;
            localStorage.setItem('remi-relay-pins', 'owned browser marker');
            const before = await api.loadNativeRelayPins(state.identity);
            const attempt = await api.beginNativePairingTrust(state.identity);
            window.publicPin = {machinePublicKey,relayUrl:'wss://relay.example.invalid/prefix'};
            await api.commitNativePairingTrust(attempt, window.publicPin);
            const restored = await api.loadNativeRelayPins(state.identity);
            let reused = false;
            try { await api.commitNativePairingTrust(attempt, window.publicPin); reused = true; } catch {}
            const cancelled = await api.beginNativePairingTrust(state.identity);
            await api.cancelNativePairingTrust(cancelled);
            let acceptedCancelled = false;
            try { await api.commitNativePairingTrust(cancelled, window.publicPin); acceptedCancelled = true; } catch {}
            return {before:before.length,restored,reused,acceptedCancelled,
              browser:localStorage.getItem('remi-relay-pins'),keys:Object.keys(state.identity).sort()};
            """, arguments: ["machinePublicKey": machineB64u], in: nil, contentWorld: .page)
        let result = try XCTUnwrap(saved as? [String: Any])
        XCTAssertEqual(result["before"] as? Int, 0, "Native restore must not import a browser pin")
        let restored = try XCTUnwrap(result["restored"] as? [[String: String]])
        XCTAssertEqual(restored, [["machinePublicKey": machineB64u, "relayUrl": "wss://relay.example.invalid/prefix"]])
        XCTAssertEqual(result["reused"] as? Bool, false)
        XCTAssertEqual(result["acceptedCancelled"] as? Bool, false)
        XCTAssertEqual(result["browser"] as? String, "owned browser marker", "Native save must not write browser persistence")
        XCTAssertEqual(result["keys"] as? [String], ["fingerprint", "kind", "publicKeyRaw", "requiresAppUnlock", "revision", "sign"])
        let reopened = try NativePushState(file: authorityDirectory.appendingPathComponent("push.sqlite"))
        XCTAssertEqual(try reopened.machineTrust(rid: rid)?.authority.publicKey, native.publicKeyRaw)
        let pendingReconnect = try await web.callAsyncJavaScript("""
            window.pendingReconnect = await window.nativeProviderTest.beginNativePairingTrust(window.nativeSigner);
            return true;
            """, arguments: [:], in: nil, contentWorld: .page)
        XCTAssertEqual(pendingReconnect as? Bool, true)
        let forgotten = try await web.callAsyncJavaScript("""
            await window.nativeProviderTest.forgetNativeRelayPin(window.nativeSigner, window.publicPin.machinePublicKey);
            return (await window.nativeProviderTest.loadNativeRelayPins(window.nativeSigner)).length;
            """, arguments: [:], in: nil, contentWorld: .page)
        XCTAssertEqual(forgotten as? Int, 0, "Actual native forget must remove the durable completed trust")
        XCTAssertNil(try reopened.machineTrust(rid: rid))
        let resurrected = try await web.callAsyncJavaScript("""
            try {
              await window.nativeProviderTest.commitNativePairingTrust(window.pendingReconnect, window.publicPin);
              return true;
            } catch { return false; }
            """, arguments: [:], in: nil, contentWorld: .page)
        XCTAssertEqual(resurrected as? Bool, false, "Forgetting a machine must invalidate a previously pending READY continuation")
        XCTAssertNil(try reopened.machineTrust(rid: rid), "Pending reconnect must not resurrect forgotten durable native trust")
        XCTAssertEqual(try reopened.currentAuthority()?.publicKey, native.publicKeyRaw, "Forgetting a machine must retain the current public identity")
    }

    @MainActor
    func testActualWebProviderKeepsTwoOutstandingMachineAttempts() async throws {
        _ = try ClientIdentityStore.loadOrCreate(authority: authority, accessGroup: nil, service: service, account: account)
        let machineA = Curve25519.Signing.PrivateKey().publicKey.rawRepresentation
        let machineB = Curve25519.Signing.PrivateKey().publicKey.rawRepresentation
        let (web, root) = try await providerWebView()
        defer { try? FileManager.default.removeItem(at: root) }
        let completed = try await web.callAsyncJavaScript("""
            const api = window.nativeProviderTest;
            const state = await api.inspectNativeIdentity();
            const first = await api.beginNativePairingTrust(state.identity);
            const second = await api.beginNativePairingTrust(state.identity);
            const results = [];
            for (const [attempt, machinePublicKey] of [[first,machineA],[second,machineB]]) {
              try {
                await api.commitNativePairingTrust(attempt, {machinePublicKey,relayUrl:'wss://relay.example.invalid/prefix'});
                results.push(true);
              } catch { results.push(false); }
            }
            return results;
            """, arguments: ["machineA": machineA.base64EncodedString().replacingOccurrences(of:"+",with:"-").replacingOccurrences(of:"/",with:"_").replacingOccurrences(of:"=",with:""),
                              "machineB": machineB.base64EncodedString().replacingOccurrences(of:"+",with:"-").replacingOccurrences(of:"/",with:"_").replacingOccurrences(of:"=",with:"")], in: nil, contentWorld: .page)
        XCTAssertEqual(completed as? [Bool], [true,true], "Starting another native machine reconnect must not replace an outstanding verified READY attempt")
        XCTAssertEqual(try authority.completedMachineTrusts().count, 2, "Both independently verified completed routes must persist")
    }

    @MainActor
    func testActualWebProviderConflictChoiceKeepsNativeAndClearsOnlyVerifiedLegacy() async throws {
        let native = try ClientIdentityStore.loadOrCreate(authority: authority, accessGroup: nil, service:service,account:account)
        let (web,root) = try await providerWebView()
        defer { try? FileManager.default.removeItem(at:root) }
        let before = try await web.callAsyncJavaScript("""
            await window.nativeProviderTest.storeLegacy();
            window.migration = await window.nativeProviderTest.inspectNativeIdentity();
            return {kind:window.migration.kind,native:window.migration.native.publicKey,
              legacy:window.migration.legacy.publicKey,legacyStored:localStorage.getItem('remi-identity') !== null};
            """,arguments:[:],in:nil,contentWorld:.page)
        let pending = try XCTUnwrap(before as? [String:Any])
        XCTAssertEqual(pending["kind"] as? String,"migration")
        XCTAssertEqual(pending["native"] as? String,native.publicKeyRaw.base64EncodedString())
        XCTAssertNotEqual(pending["legacy"] as? String,pending["native"] as? String)
        XCTAssertEqual(pending["legacyStored"] as? Bool,true,"Conflict inspection must not delete either identity")
        XCTAssertEqual(try ClientIdentityStore.load(authority: authority, accessGroup: nil, service:service,account:account)?.revision,native.revision)
        let selected = try await web.callAsyncJavaScript("""
            const state = await window.nativeProviderTest.chooseNativeIdentity(window.migration,'native');
            const identity = state.identity;
            const message = new TextEncoder().encode('actual provider native signing');
            const signature = await identity.sign(message);
            return {kind:state.kind,publicKey:identity.publicKeyRaw,keys:Object.keys(identity).sort(),
              legacyStored:localStorage.getItem('remi-identity') !== null,signature};
            """,arguments:[:],in:nil,contentWorld:.page)
        let result = try XCTUnwrap(selected as? [String:Any])
        XCTAssertEqual(result["kind"] as? String,"ready")
        XCTAssertEqual(result["publicKey"] as? String,native.publicKeyRaw.base64EncodedString())
        XCTAssertEqual(result["legacyStored"] as? Bool,false)
        XCTAssertEqual(result["keys"] as? [String],["fingerprint","kind","publicKeyRaw","requiresAppUnlock","revision","sign"])
        let signature = try XCTUnwrap(Data(base64Encoded:try XCTUnwrap(result["signature"] as? String)))
        XCTAssertTrue(native.publicKey.isValidSignature(signature,for:Data("actual provider native signing".utf8)))
    }

    @MainActor
    func testActualWebProviderProtectedImportPreservesLegacyOnWrongPassphrase() async throws {
        let (web,root) = try await providerWebView()
        defer { try? FileManager.default.removeItem(at:root) }
        let before = try await web.callAsyncJavaScript("""
            const legacy = await window.nativeProviderTest.storeLegacy('r4-isolated-passphrase');
            window.migration = await window.nativeProviderTest.inspectNativeIdentity();
            let rejected = false;
            try { await window.nativeProviderTest.chooseNativeIdentity(window.migration,'legacy','wrong') } catch { rejected = true }
            return {kind:window.migration.kind,native:window.migration.native,publicKey:legacy.publicKey,
              rejected,legacyStored:localStorage.getItem('remi-identity') !== null};
            """,arguments:[:],in:nil,contentWorld:.page)
        let pending = try XCTUnwrap(before as? [String:Any])
        XCTAssertEqual(pending["kind"] as? String,"migration")
        XCTAssertTrue(pending["native"] is NSNull)
        XCTAssertEqual(pending["rejected"] as? Bool,true)
        XCTAssertEqual(pending["legacyStored"] as? Bool,true)
        XCTAssertNil(try ClientIdentityStore.load(authority: authority, accessGroup: nil, service:service,account:account),"A rejected protected import cannot create a volatile replacement")
        let after = try await web.callAsyncJavaScript("""
            const migrated = await window.nativeProviderTest.chooseNativeIdentity(window.migration,'legacy','r4-isolated-passphrase');
            if (migrated.kind !== 'locked') throw new Error('protected import implicitly unlocked');
            const state = await window.nativeProviderTest.unlockNativeIdentity(migrated.native);
            const signature = await state.identity.sign(new TextEncoder().encode('protected actual provider'));
            return {kind:state.kind,publicKey:state.identity.publicKeyRaw,protected:state.identity.requiresAppUnlock,
              legacyStored:localStorage.getItem('remi-identity') !== null,signature};
            """,arguments:[:],in:nil,contentWorld:.page)
        let result = try XCTUnwrap(after as? [String:Any])
        XCTAssertEqual(result["kind"] as? String,"ready")
        XCTAssertEqual(result["publicKey"] as? String,pending["publicKey"] as? String)
        XCTAssertEqual(result["protected"] as? Bool,true)
        XCTAssertEqual(result["legacyStored"] as? Bool,false)
        let durable = try XCTUnwrap(ClientIdentityStore.load(authority: authority, accessGroup: nil, service:service,account:account))
        let signature = try XCTUnwrap(Data(base64Encoded:try XCTUnwrap(result["signature"] as? String)))
        XCTAssertTrue(durable.publicKey.isValidSignature(signature,for:Data("protected actual provider".utf8)))
        XCTAssertTrue(durable.requiresAppUnlock)
        let suite = "remi1199-provider-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName:suite))
        defer { defaults.removePersistentDomain(forName:suite) }
        XCTAssertNil(RemiNativeStore.sign(message:"session|question|yes",accessGroup:nil,identity:durable,defaults:defaults))
    }

    func testActualStoreReadAndUpdateFailuresPreserveAuthorizedIdentity() throws {
        let identity = try ClientIdentityStore.loadOrCreate(authority: authority, accessGroup: nil, service:service,account:account)
        let query: [String:Any] = [kSecClass as String:kSecClassGenericPassword,
            kSecAttrService as String:service,kSecAttrAccount as String:account]
        var read = query; read[kSecReturnData as String] = true
        var result:AnyObject?
        XCTAssertEqual(SecItemCopyMatching(read as CFDictionary,&result),errSecSuccess)
        let original = try XCTUnwrap(result as? Data)
        var readFailure = NativeKeychainOperations.system
        var writes = 0
        readFailure.copyMatching = { query,result in
            XCTAssertEqual(SecItemCopyMatching(query,result),errSecSuccess)
            return errSecInteractionNotAllowed
        }
        readFailure.add = { query,result in writes += 1; return SecItemAdd(query,result) }
        readFailure.update = { query,attributes in writes += 1; return SecItemUpdate(query,attributes) }
        XCTAssertThrowsError(try ClientIdentityStore.loadOrCreate(authority: authority, accessGroup: nil, service:service,account:account,operations:readFailure))
        XCTAssertEqual(writes,0,"An OS read error must never enter create/update")
        var writeFailure = NativeKeychainOperations.system
        writeFailure.update = { _,_ in errSecAuthFailed }
        let incoming = ClientIdentity(privateKey:.init())
        XCTAssertThrowsError(try ClientIdentityStore.importIdentity(authority: authority, accessGroup: nil, pkcs8:Ed25519PKCS8.encode(incoming.privateKey),
            publicKey:incoming.publicKeyRaw,replacing:identity.revision,service:service,account:account,operations:writeFailure))
        result = nil
        XCTAssertEqual(SecItemCopyMatching(read as CFDictionary,&result),errSecSuccess)
        XCTAssertEqual(result as? Data,original,"A failed atomic update must preserve the prior authorized record byte-for-byte")
        XCTAssertEqual(try ClientIdentityStore.load(authority: authority, accessGroup: nil, service:service,account:account)?.revision,identity.revision)
    }

    // MARK: - Signing / verification

    func testSignedChallengeVerifiesAgainstOwnPublicKey() throws {
        let identity = try ClientIdentityStore.loadOrCreate(authority: authority, accessGroup: nil, service: service, account: account)
        let challenge = Data("auth-challenge-fixture".utf8)
        let signature = try identity.sign(challenge)
        XCTAssertTrue(identity.publicKey.isValidSignature(signature, for: challenge))
    }

    func testSignedChallengeFailsAgainstADifferentKey() throws {
        let identity = try ClientIdentityStore.loadOrCreate(authority: authority, accessGroup: nil, service: service, account: account)
        let impostor = ClientIdentity(privateKey: .init())
        let challenge = Data("auth-challenge-fixture".utf8)
        let signature = try identity.sign(challenge)
        XCTAssertFalse(impostor.publicKey.isValidSignature(signature, for: challenge))
    }

    /// Cross-language wire compatibility: a signature produced by the
    /// TypeScript `sign()` (packages/shared/src/crypto.ts) over a real
    /// base64 challenge, verified here with CryptoKit exactly the way
    /// HubClient verifies a daemon's `auth_result.serverSignature`. If the
    /// byte layout ever drifted (e.g. PKCS8 vs raw), this is what would
    /// catch it — a same-process round trip (sign then verify with the same
    /// library) cannot.
    func testVerifiesASignatureProducedByTheTypeScriptImplementation() throws {
        let publicKeyRaw = try XCTUnwrap(
            Data(base64Encoded: "hTsqoOoMHpkLCHTMC3fmWZ0dPf944WBgvCA/zIkd1Lc="))
        let challengeData = try XCTUnwrap(
            Data(base64Encoded: "hbGyBAveiwqpVe4KOI9Ph3WjQ5rEBAjNBAY8JzZ0HSA="))
        let signatureData = try XCTUnwrap(
            Data(
                base64Encoded:
                    "8OJYmBhAA/4694uebtoQssikFbMYHIhdmlxTAYZQTkon9EGlv1VQhKqsyDbwWahp3dcIf1EVWX2sfrZ3q/5mAw=="
            ))
        let publicKey = try Curve25519.Signing.PublicKey(rawRepresentation: publicKeyRaw)
        XCTAssertTrue(publicKey.isValidSignature(signatureData, for: challengeData))
    }
}
