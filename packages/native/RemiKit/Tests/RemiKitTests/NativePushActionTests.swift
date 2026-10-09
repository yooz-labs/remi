import CryptoKit
import Foundation
import Security
import Testing
import UserNotifications
@testable import RemiPush
@testable import RemiKit

struct NativePushActionTests {
    func inputs(category: String = "REMI_YN", change: String? = nil) throws -> (OwnedPushContext, Data) {
        let oracle = try NativePushOracle.load("push-vectors.json")
        let vector = try #require((oracle["cases"] as? [[String: Any]])?.first)
        let context = try OwnedPushContext(vector: vector, oracle: oracle)
        do {
            let payloadHex = try #require(vector["payloadHex"] as? String)
            let payloadBytes = try RelayOracle.hex(payloadHex)
            var payload = try #require(try JSONSerialization.jsonObject(with: payloadBytes) as? [String: Any])
            payload["category"] = category
            if change == "unicode" { payload["title"] = "\u{00e9}" }
            var yes: [String: Any] = ["value": "yes", "label": "Yes", "isYes": true, "isNo": false, "description": NSNull(), "standingGrant": NSNull()]
            var no: [String: Any] = ["value": "no", "label": "No", "isYes": false, "isNo": true, "description": NSNull(), "standingGrant": NSNull()]
            var standing: [String: Any] = ["value": "always", "label": "Allow", "isYes": true, "isNo": false, "description": "x", "standingGrant": "addRules"]
            if change == "long" { yes["label"] = String(repeating: "Y", count: 25) }
            if change == "control" { no["description"] = "\u{202e}" }
            if change == "empty" { yes["description"] = " " }
            if change == "duplicate" { no["value"] = "yes" }
            if change == "setMode" { standing["standingGrant"] = "setMode" }
            payload["options"] = category == "REMI_YNA" ? [yes, standing, no] : [yes, no]
            let carrier = try OwnedPushContext.resealed(vector, oracle: oracle,
                payload: JSONSerialization.data(withJSONObject: payload), now: UInt64(Date().timeIntervalSince1970))
            return (context, carrier)
        } catch { try? context.cleanup(); throw error }
    }
    static func content(_ notification: VerifiedPushNotification, set: VerifiedPushActionSet) throws -> UNMutableNotificationContent {
        let content = UNMutableNotificationContent()
        content.title = notification.title; content.body = notification.body
        content.categoryIdentifier = set.categoryIdentifier
        content.userInfo = ["remiPush": try JSONSerialization.jsonObject(with: notification.originalCarrier)]
        return content
    }

    @Test(arguments: ["REMI_YN", "REMI_YNA"])
    func signedFullTitlesNoFirstAndStandingUnlock(category: String) throws {
        let (context, carrier) = try inputs(category: category); defer { try? context.cleanup() }
        let opened = try context.store.open(carrier: carrier)
        let set = try #require(try context.store.actionSet(for: opened))
        #expect(set.actions.count == (category == "REMI_YNA" ? 3 : 2))
        #expect(set.actions.first?.value == "no")
        #expect(set.actions.first?.title == "No" && set.actions.first?.authenticationRequired == false)
        #expect(Set(set.actions.map(\.identifier)).count == set.actions.count)
        #expect(set.actions.allSatisfy { $0.identifier.hasPrefix(set.categoryIdentifier + ".a.") })
        if category == "REMI_YNA" {
            let standing = try #require(set.actions.first { $0.value == "always" })
            #expect(standing.title == "Allow \u{2014} x · This session" && standing.authenticationRequired)
        }
        let native = set.category
        #expect(native.options == [.customDismissAction])
        #expect(native.actions.allSatisfy { !$0.options.contains(.foreground) && !$0.options.contains(.destructive) })
        #expect(native.actions.map { $0.options.contains(.authenticationRequired) } == set.actions.map(\.authenticationRequired))
        let repeated = try context.store.open(carrier: opened.originalCarrier)
        #expect(try context.store.actionSet(for: repeated) == set)
        let content = try Self.content(opened, set: set)
        let action = try context.store.verifyAction(content: content, identifier: try #require(set.actions.first).identifier)
        #expect(action.action.value == "no")
        try context.store.recheckAction(action)
        #expect(context.store.allowsPresentation(content))
        content.categoryIdentifier = ""
        #expect(context.store.allowsPresentation(content), "A verified no-action fallback remains readable")
        content.body += " forged"
        #expect(!context.store.allowsPresentation(content))
    }

    @Test(arguments: ["long", "control", "empty", "duplicate", "setMode", "multi"])
    func unsupportedSignedShapesHaveNoCategory(change: String) throws {
        let category = change == "setMode" ? "REMI_YNA" : change == "multi" ? "REMI_MULTI" : "REMI_YN"
        let (context, carrier) = try inputs(category: category, change: change); defer { try? context.cleanup() }
        let opened = try context.store.open(carrier: carrier)
        #expect(try context.store.actionSet(for: opened) == nil)
        #expect(opened.nativeAnswerChoices.isEmpty)
    }

    @Test(arguments: ["title", "body", "subtitle", "category", "action", "carrier", "unsafe-display", "canonical-title"])
    func actualOSContentMustMatchOriginalSignedDisplay(change: String) throws {
        let (context, carrier) = try inputs(change: change == "canonical-title" ? "unicode" : nil); defer { try? context.cleanup() }
        let opened = try context.store.open(carrier: carrier)
        let set = try #require(try context.store.actionSet(for: opened))
        let content = try Self.content(opened, set: set)
        var identifier = try #require(set.actions.first).identifier
        switch change {
        case "title": content.title += " altered"
        case "body": content.body += " altered"
        case "subtitle": content.subtitle = "outer grant"
        case "category": content.categoryIdentifier = "REMI_YNA"
        case "action": identifier += ".altered"
        case "carrier": content.userInfo = [:]
        case "canonical-title": content.title = "e\u{0301}"
            #expect(content.title == opened.title && Data(content.title.utf8) != Data(opened.title.utf8))
        default: content.title += "\u{202e}"
        }
        #expect(throws: (any Error).self) { try context.store.verifyAction(content: content, identifier: identifier) }
        if change != "action" { #expect(!context.store.allowsPresentation(content)) }
    }

    @Test func opaqueContextIsBoundToFacadeAndDurableTrust() throws {
        let (context, carrier) = try inputs(); defer { try? context.cleanup() }
        let opened = try context.store.open(carrier: carrier)
        let set = try #require(try context.store.actionSet(for: opened))
        let action = try context.store.verifyAction(content: Self.content(opened, set: set), identifier: try #require(set.actions.first).identifier)
        let separate = try RemiPushStore.ownedTestStore(file: context.directory.appendingPathComponent("public.sqlite"),
            service: context.service, account: context.account)
        #expect(throws: (any Error).self) { try separate.recheckAction(action) }
        try context.store.forgetMachine(room: context.room)
        #expect(throws: (any Error).self) { try context.store.recheckAction(action) }
    }

    @Test func protectedAuthorityOffersNoBackgroundAction() throws {
        let (context, carrier) = try inputs(); defer { try? context.cleanup() }
        let machine = try #require(try context.store.machine(room: context.room))
        let protected = PushDeviceAuthority(publicKey: context.authority.publicKey,
            revision: context.authority.revision, requiresAppUnlock: true)
        let lease = try context.store.acquireIdentityMutation(); defer { lease.release() }
        let generation = try lease.invalidate(); try lease.install(protected, generation: generation)
        try context.store.commitMachine(room: machine.room, machinePublicKey: machine.machinePublicKey,
            origin: machine.origin, relayURL: machine.relayURL, authority: protected, generation: generation)
        let opened = try context.store.open(carrier: carrier)
        #expect(try context.store.actionSet(for: opened) == nil)
    }

    @Test func secureMarkersConsumeMissingMalformedCapsulesWithoutLegacyRouting() throws {
        let content = UNMutableNotificationContent()
        #expect(!RemiPushStore.isSecureNotification(content: content))
        content.categoryIdentifier = NativePushActionPolicy.prefix + "invalid"
        #expect(RemiPushStore.isSecureNotification(content: content))
        content.categoryIdentifier = ""
        #expect(RemiPushStore.isSecureNotification(content: content, identifier: NativePushActionPolicy.prefix + "invalid"))
        content.userInfo = ["remiPush": "invalid"]
        #expect(RemiPushStore.isSecureNotification(content: content))
        let (context, _) = try inputs(); defer { try? context.cleanup() }
        #expect(throws: (any Error).self) { try context.store.verifyAction(content: content, identifier: "invalid") }
    }

    @Test func categoryMergePrunesExpiryCapsCountAndPreservesObservedOthers() throws {
        let now: Int64 = 1_700_000_000
        func category(_ expiry: Int64, index: Int) -> UNNotificationCategory {
            UNNotificationCategory(identifier: NativePushActionPolicy.prefix + String(expiry) + "." + String(format: "%064x", index),
                actions: [], intentIdentifiers: [])
        }
        let foreign = UNNotificationCategory(identifier: "other-app-feature", actions: [], intentIdentifiers: [])
        let expired = category(now, index: 1), incoming = category(now + 300, index: 2)
        let observed = Set((3..<140).map { category(now + Int64($0), index: $0) }).union([expired, foreign])
        let merged = try NativePushActionPolicy.merge(observed, adding: [incoming], now: now)
        #expect(merged.contains(foreign) && merged.contains(incoming) && !merged.contains(expired))
        #expect(merged.filter { NativePushActionPolicy.expiry($0.identifier) != nil }.count == 128)
        #expect(throws: (any Error).self) { try NativePushActionPolicy.merge(observed, adding: Set((200..<329).map { category(now + 300, index: $0) }), now: now) }
        #expect(throws: (any Error).self) {
            try NativePushActionPolicy.merge(Set((0..<513).map {
                UNNotificationCategory(identifier: "other-\($0)", actions: [], intentIdentifiers: [])
            }), adding: [], now: now)
        }
    }

    @Test @MainActor func unverifiedCooperativeCallCannotPublishSecureIDs() async throws {
        let (context, _) = try inputs(); defer { try? context.cleanup() }
        let category = UNNotificationCategory(identifier: NativePushActionPolicy.prefix + "forged", actions: [], intentIdentifiers: [])
        #expect(!NativePushActionPolicy.acceptsUnverifiedCategories([category]))
        let foreign = UNNotificationCategory(identifier: "other-feature", actions: [], intentIdentifiers: [])
        #expect(NativePushActionPolicy.acceptsUnverifiedCategories([foreign]))
        let accepted = await withCheckedContinuation { continuation in
            context.store.mergeNotificationCategories([foreign]) { continuation.resume(returning: $0) }
        }
        #expect(!accepted, "The owned facade refuses before the OS boundary, independent of secure-ID validation")
    }

    @Test(arguments: ["missing", "raw", "corrupt", "protected"])
    @MainActor func actualColdCoordinatorNeverCreatesMigratesOrUnlocks(kind: String) async throws {
        let (context, carrier) = try inputs(); defer { try? context.cleanup() }
        let oracle = try NativePushOracle.load("push-vectors.json")
        let seedHex = try #require(oracle["deviceSeedHex"] as? String)
        let seed = try RelayOracle.hex(seedHex)
        let original = ClientIdentity(privateKey: try Curve25519.Signing.PrivateKey(rawRepresentation: seed), revision: context.authority.revision)
        let service = "live.yooz.remi.tests.cold.\(UUID().uuidString)", account = UUID().uuidString
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: account]
        defer { SecItemDelete(query as CFDictionary) }
        let bytes: Data?
        if kind == "raw" { bytes = seed }
        else if kind == "corrupt" { bytes = Data("{\"version\":2}".utf8) }
        else if kind == "protected" {
            struct Record: Encodable { let version: Int; let pkcs8: Data; let publicKey: Data; let revision: String; let requiresAppUnlock: Bool }
            bytes = try JSONEncoder().encode(Record(version: 2, pkcs8: Ed25519PKCS8.encode(original.privateKey),
                publicKey: original.publicKeyRaw, revision: original.revision, requiresAppUnlock: true))
        } else { bytes = nil }
        if let bytes {
            var item = query; item[kSecValueData as String] = bytes
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            try #require(SecItemAdd(item as CFDictionary, nil) == errSecSuccess)
        }
        let identityStore = ClientIdentityStore(service: service, account: account, pushStore: context.store)
        let suite = "live.yooz.remi.tests.notifications.\(UUID().uuidString)"
        defer { UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite) }
        let generation = try context.store.generation(), authority = try context.store.authority()
        let coordinator = try NativeRelayNotifications(ownedPushStore: context.store, ownedIdentityStore: identityStore, defaultsSuite: suite)
        coordinator.activate() // Owned mode must not bootstrap the OS or identity.
        let opened = try context.store.open(carrier: carrier)
        let set = try #require(try context.store.actionSet(for: opened))
        let outcome = await coordinator.receiveAction(content: try Self.content(opened, set: set), identifier: try #require(set.actions.first).identifier)
        #expect(outcome == .refused && coordinator.lastBackgroundActionOutcome == .refused)
        #expect(coordinator.store == nil && !coordinator.presentsRelayNotification)
        #expect(try context.store.generation() == generation && context.store.authority() == authority)
        var read = query; read[kSecReturnData as String] = true
        var actual: CFTypeRef?
        let status = SecItemCopyMatching(read as CFDictionary, &actual)
        if let bytes { #expect(status == errSecSuccess && actual as? Data == bytes) }
        else { #expect(status == errSecItemNotFound) }
    }
}
