import CryptoKit
import CoreFoundation
import Foundation

enum NativePushCodecError: Error { case malformed, oversize, decrypt, badSignature, expired, unavailable, changed }

/// The original signed capsule is the sole input to verification. This decoder
/// never creates keys, installs trust, records lifecycle state or grants actions.
enum NativePushCodec {
    enum Kind: String {
        case question, turnComplete = "turn_complete", subagentAlert = "subagent_alert", harnessDenied = "harness_denied", turnFailed = "turn_failed", dismiss
        var byte: Int {
            switch self { case .question: return 1; case .turnComplete: return 2; case .subagentAlert: return 3
            case .harnessDenied: return 4; case .turnFailed: return 5; case .dismiss: return 6 }
        }
        static func from(_ bytes: Data) throws -> Kind {
            guard bytes.count == 1, let kind = [question, turnComplete, subagentAlert, harnessDenied, turnFailed, dismiss].first(where: { $0.byte == Int(bytes[0]) }) else { throw NativePushCodecError.malformed }
            return kind
        }
    }
    enum Category: String { case none, yesNo = "REMI_YN", yesNoAlways = "REMI_YNA", multiple = "REMI_MULTI" }
    enum StandingGrant: String { case addRules, setMode, session }
    struct Option: Equatable {
        let value: String; let label: String; let isYes: Bool; let isNo: Bool
        let description: String?; let standingGrant: StandingGrant?
    }
    struct Question: Equatable {
        let sessionId: String; let runtimeInstance: String; let questionId: String
        let title: String; let body: String; let category: Category; let options: [Option]
    }
    struct Information: Equatable { let sessionId: String?; let title: String; let body: String }
    enum Payload: Equatable { case question(Question), informational(Information), dismiss }
    /// The only cleartext APNs relays (#1200): the room and the collapse id (both are AAD and the
    /// room selects the pinned machine), plus the sealed bytes. The event kind and the key version
    /// are read from the signed content after decryption, never from the outer capsule.
    struct Carrier: Equatable {
        let rid: String; let collapseId: String; let sealed: String
        var userInfo: [String: Any] { ["v": 2, "rid": rid, "collapseId": collapseId, "sealed": sealed] }
    }
    struct VerifiedPush {
        let originalCarrier: Carrier
        let originalBody: Data
        let payloadBytes: Data
        let record: NativePushState.ContentRecord
        let payload: Payload
        let trust: NativePushState.MachineTrust
        let authorityGeneration: Int64
        let recipientPublicKey: Data
        let keyVersion: Int
        fileprivate init(originalCarrier: Carrier, originalBody: Data, payloadBytes: Data,
                         record: NativePushState.ContentRecord, payload: Payload,
                         trust: NativePushState.MachineTrust, authorityGeneration: Int64,
                         recipientPublicKey: Data, keyVersion: Int) {
            self.originalCarrier = originalCarrier; self.originalBody = originalBody; self.payloadBytes = payloadBytes
            self.record = record; self.payload = payload; self.trust = trust; self.authorityGeneration = authorityGeneration
            self.recipientPublicKey = recipientPublicKey; self.keyVersion = keyVersion
        }
    }
    private static let safeInteger: Int64 = 9_007_199_254_740_991
    static func parseCarrier(_ bytes: Data) throws -> Carrier {
        try carrier(StrictJSON.parse(bytes, maximum: 4096))
    }
    static func open(userInfo: [AnyHashable: Any], state: NativePushState, keys: NativePushKeyStore, now: Int64) throws -> VerifiedPush {
        // APS/category/routing/verified hints are never part of authority.
        let c = try carrier(userInfo["remiPush"] as Any)
        guard now >= 0, now <= safeInteger else { throw NativePushCodecError.malformed }
        let rid = try hex(c.rid, count: 16)
        let trust: NativePushState.MachineTrust
        let recipient: NativePushKeyStore.Key
        let generation: Int64
        do {
            guard let currentTrust = try state.machineTrust(rid: rid), currentTrust.relayUrl != nil,
                  let currentKey = try keys.load() else { throw NativePushCodecError.unavailable }
            trust = currentTrust; recipient = currentKey; generation = try state.authorityGeneration()
            guard generation > 0, try state.currentAuthority() == trust.authority else { throw NativePushCodecError.changed }
        } catch let error as NativePushCodecError { throw error }
        catch { throw NativePushCodecError.unavailable }
        guard recipient.keyVersion >= 1 else { throw NativePushCodecError.malformed }
        let sealed = try binary(c.sealed, count: nil)
        let aad = rid + Data(c.collapseId.utf8)
        let inner: Data
        do {
            let ephemeral = try P256.KeyAgreement.PublicKey(x963Representation: Data(sealed.prefix(65)))
            let shared = try recipient.privateKey.sharedSecretFromKeyAgreement(with: ephemeral)
            let key = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data(sealed.prefix(65)),
                sharedInfo: lps([Data("remi-relay-v2 seal".utf8), recipient.publicKey]), outputByteCount: 32)
            let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: sealed.subdata(in: 65..<77)),
                ciphertext: sealed.subdata(in: 77..<(sealed.count - 16)), tag: Data(sealed.suffix(16)))
            inner = try AES.GCM.open(box, using: key, authenticating: aad)
        } catch { throw NativePushCodecError.decrypt }
        guard inner.count <= 2048 else { throw NativePushCodecError.oversize }
        let signed = try parts(inner, count: 2)
        let body = signed[0], signature = signed[1]
        guard signature.count == 64 else { throw NativePushCodecError.malformed }
        let fields = try parts(body, count: 12)
        let machine = fields[0], device = fields[2], publicR = fields[3]
        try ed25519(machine); try ed25519(device)
        guard publicR.count == 65, publicR.first == 4, (try? P256.KeyAgreement.PublicKey(x963Representation: publicR)) != nil,
              machine == trust.machinePublicKey, fields[1] == rid,
              Data(SHA256.hash(data: machine).prefix(16)) == rid,
              device == trust.authority.publicKey, publicR == recipient.publicKey,
              // Decryption already needed the recipient key; the signed tuple must name its version.
              try number(fields[4], minimum: 1) == Int64(recipient.keyVersion),
              String(data: fields[5], encoding: .utf8) == c.collapseId,
              fields[8].count == 32 else { throw NativePushCodecError.malformed }
        let kind = try Kind.from(fields[7])
        let revision = try number(fields[6], minimum: 1)
        let issued = try number(fields[9]), expiry = try number(fields[10])
        guard issued <= now + 60, expiry > now else { throw NativePushCodecError.expired }
        let digest = Data(SHA256.hash(data: body))
        let signer = try Curve25519.Signing.PublicKey(rawRepresentation: machine)
        guard signer.isValidSignature(signature, for: lps([Data("remi-relay-v2 push content".utf8), digest])) else { throw NativePushCodecError.badSignature }
        // Verify ORIGINAL body bytes first, then parse the exact original payload.
        let parsed = try payload(StrictJSON.parse(fields[11], maximum: 2048))
        let ttl: Int64
        switch parsed {
        case .dismiss:
            guard kind == .dismiss else { throw NativePushCodecError.malformed }; ttl = 3600
        case .informational:
            guard kind != .dismiss else { throw NativePushCodecError.malformed }; ttl = 300
        case .question:
            guard kind == .question else { throw NativePushCodecError.malformed }; ttl = 3600
        }
        guard expiry > issued, expiry - issued <= ttl else { throw NativePushCodecError.malformed }
        // Crypto is synchronous, but another process can mutate either durable
        // authority while it runs. Consumers also recheck at their final effect.
        do {
            // The OS read itself can block while another process invalidates
            // authority. Perform it BEFORE the final public-ledger checks.
            guard let latestKey = try keys.load(), latestKey.keyVersion == recipient.keyVersion,
                  latestKey.publicKey == recipient.publicKey,
                  try state.currentAuthority() == trust.authority, try state.machineTrust(rid: rid) == trust,
                  try state.authorityGeneration() == generation else { throw NativePushCodecError.changed }
        } catch let error as NativePushCodecError { throw error }
        catch { throw NativePushCodecError.unavailable }
        return VerifiedPush(originalCarrier: c, originalBody: body, payloadBytes: fields[11],
            record: .init(rid: rid, collapseId: c.collapseId, revision: revision, kind: kind.byte,
                          nonce: fields[8], digest: digest, issuedAt: issued, expiresAt: expiry),
            payload: parsed, trust: trust, authorityGeneration: generation, recipientPublicKey: recipient.publicKey, keyVersion: recipient.keyVersion)
    }
    private static func carrier(_ value: Any) throws -> Carrier {
        let o = try object(value, keys: ["v", "rid", "collapseId", "sealed"])
        guard try integer(o["v"], minimum: 2) == 2 else { throw NativePushCodecError.malformed }
        let rid = try string(o["rid"], minimum: 32, maximum: 32)
        _ = try hex(rid, count: 16)
        let collapse = try string(o["collapseId"], minimum: 22, maximum: 22)
        _ = try binary(collapse, count: 16)
        let sealed = try string(o["sealed"], minimum: 1, maximum: 2855)
        let bytes = try binary(sealed, count: nil)
        guard (94...2141).contains(bytes.count), bytes.first == 4 else { throw NativePushCodecError.malformed }
        return Carrier(rid: rid, collapseId: collapse, sealed: sealed)
    }
    private static func payload(_ value: Any) throws -> Payload {
        guard let o = value as? [String: Any], let type = o["type"] as? String else { throw NativePushCodecError.malformed }
        if type == "dismiss" {
            _ = try object(o, keys: ["type", "actionable"])
            guard try boolean(o["actionable"]) == false else { throw NativePushCodecError.malformed }
            return .dismiss
        }
        if type == "informational" {
            _ = try object(o, keys: ["type", "actionable", "sessionId", "title", "body"])
            guard try boolean(o["actionable"]) == false else { throw NativePushCodecError.malformed }
            let session = o["sessionId"] is NSNull ? nil : try string(o["sessionId"], minimum: 1, maximum: 128)
            return .informational(.init(sessionId: session, title: try string(o["title"], maximum: 128), body: try string(o["body"], maximum: 512)))
        }
        guard type == "question" else { throw NativePushCodecError.malformed }
        _ = try object(o, keys: ["type", "actionable", "sessionId", "runtimeInstance", "questionId", "title", "body", "category", "options"])
        guard try boolean(o["actionable"]), let options = o["options"] as? [Any], (2...4).contains(options.count),
              let category = Category(rawValue: try string(o["category"], minimum: 1, maximum: 16)) else { throw NativePushCodecError.malformed }
        let runtime = try string(o["runtimeInstance"], minimum: 43, maximum: 43)
        _ = try binary(runtime, count: 32)
        return .question(.init(sessionId: try string(o["sessionId"], minimum: 1, maximum: 128), runtimeInstance: runtime,
            questionId: try string(o["questionId"], minimum: 1, maximum: 128), title: try string(o["title"], maximum: 128),
            body: try string(o["body"], maximum: 512), category: category, options: try options.map { value in
                let p = try object(value, keys: ["value", "label", "isYes", "isNo", "description", "standingGrant"])
                let grant: StandingGrant?
                if p["standingGrant"] is NSNull { grant = nil }
                else {
                    guard let parsed = StandingGrant(rawValue: try string(p["standingGrant"], minimum: 1, maximum: 16)) else { throw NativePushCodecError.malformed }
                    grant = parsed
                }
                return Option(value: try string(p["value"], minimum: 1, maximum: 128), label: try string(p["label"], minimum: 1, maximum: 128),
                    isYes: try boolean(p["isYes"]), isNo: try boolean(p["isNo"]),
                    description: p["description"] is NSNull ? nil : try string(p["description"], maximum: 2048), standingGrant: grant)
            }))
    }
    private static func object(_ value: Any, keys: Set<String>) throws -> [String: Any] {
        guard let o = value as? [String: Any], Set(o.keys) == keys else { throw NativePushCodecError.malformed }
        return o
    }
    private static func string(_ value: Any?, minimum: Int = 0, maximum: Int) throws -> String {
        guard let s = value as? String, (minimum...maximum).contains(s.utf8.count) else { throw NativePushCodecError.malformed }
        return s
    }
    private static func boolean(_ value: Any?) throws -> Bool {
        guard let n = value as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { throw NativePushCodecError.malformed }
        return n.boolValue
    }
    private static func integer(_ value: Any?, minimum: Int64 = 0) throws -> Int64 {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite,
              n.doubleValue >= Double(minimum), n.doubleValue <= Double(safeInteger),
              n.doubleValue.rounded(.towardZero) == n.doubleValue else { throw NativePushCodecError.malformed }
        return n.int64Value
    }
    private static func binary(_ text: String, count: Int?) throws -> Data {
        guard text.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95 }),
              let data = Data(base64Encoded: text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + String(repeating: "=", count: (4 - text.utf8.count % 4) % 4)),
              data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") == text,
              count == nil || data.count == count else { throw NativePushCodecError.malformed }
        return data
    }
    private static func hex(_ text: String, count: Int) throws -> Data {
        let bytes = Array(text.utf8)
        guard bytes.count == count * 2, bytes.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { throw NativePushCodecError.malformed }
        func nibble(_ b: UInt8) -> UInt8 { b <= 57 ? b - 48 : b - 87 }
        return Data(stride(from: 0, to: bytes.count, by: 2).map { nibble(bytes[$0]) << 4 | nibble(bytes[$0 + 1]) })
    }
    private static func ed25519(_ bytes: Data) throws {
        guard bytes.count == 32, !NativeEd25519PublicKey.isSmallOrder(bytes),
              (try? Curve25519.Signing.PublicKey(rawRepresentation: bytes)) != nil else { throw NativePushCodecError.malformed }
    }
    private static func number(_ bytes: Data, minimum: Int64 = 0) throws -> Int64 {
        guard bytes.count == 8 else { throw NativePushCodecError.malformed }
        let n = bytes.reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
        guard n >= UInt64(minimum), n <= UInt64(safeInteger) else { throw NativePushCodecError.malformed }
        return Int64(n)
    }
    private static func parts(_ bytes: Data, count: Int) throws -> [Data] {
        var at = 0; var out: [Data] = []
        while at < bytes.count {
            guard at + 2 <= bytes.count, out.count < count else { throw NativePushCodecError.malformed }
            let length = Int(bytes[at]) * 256 + Int(bytes[at + 1]); at += 2
            guard length <= bytes.count - at else { throw NativePushCodecError.malformed }
            out.append(bytes.subdata(in: at..<(at + length))); at += length
        }
        guard out.count == count else { throw NativePushCodecError.malformed }; return out
    }
    private static func lps(_ parts: [Data]) -> Data {
        parts.reduce(into: Data()) { out, p in out.append(contentsOf: [UInt8(p.count >> 8), UInt8(p.count & 255)]); out.append(p) }
    }
    /// Duplicate decoded member names are rejected before Foundation can discard
    /// them. Signed bytes are preserved; whitespace/order/escaped names may vary.
    private struct StrictJSON {
        let bytes: [UInt8]
        var at = 0; var nodes = 0
        static func parse(_ data: Data, maximum: Int) throws -> Any {
            guard data.count <= maximum else { throw NativePushCodecError.oversize }
            guard !data.isEmpty, String(data: data, encoding: .utf8) != nil else { throw NativePushCodecError.malformed }
            var parser = StrictJSON(bytes: Array(data)); let value = try parser.value(0)
            parser.space(); guard parser.at == parser.bytes.count else { throw NativePushCodecError.malformed }; return value
        }
        mutating func space() { while at < bytes.count && [9, 10, 13, 32].contains(bytes[at]) { at += 1 } }
        mutating func string() throws -> String {
            guard at < bytes.count, bytes[at] == 34 else { throw NativePushCodecError.malformed }
            let start = at; at += 1
            while at < bytes.count {
                let c = bytes[at]; at += 1
                if c == 92 { at += 1 }
                else if c == 34 {
                    let object: Any
                    do { object = try JSONSerialization.jsonObject(with: Data(bytes[start..<at]), options: .fragmentsAllowed) }
                    catch { throw NativePushCodecError.malformed }
                    guard let s = object as? String else { throw NativePushCodecError.malformed }; return s
                }
            }
            throw NativePushCodecError.malformed
        }
        mutating func value(_ depth: Int) throws -> Any {
            nodes += 1; space()
            guard depth <= 8, nodes <= 512, at < bytes.count else { throw NativePushCodecError.malformed }
            if bytes[at] == 34 { return try string() }
            if bytes[at] == 123 {
                at += 1; space(); var object: [String: Any] = [:]
                if at < bytes.count, bytes[at] == 125 { at += 1; return object }
                while true {
                    let key = try string(); guard object[key] == nil else { throw NativePushCodecError.malformed }
                    space(); guard at < bytes.count, bytes[at] == 58 else { throw NativePushCodecError.malformed }; at += 1
                    object[key] = try value(depth + 1); space()
                    guard at < bytes.count else { throw NativePushCodecError.malformed }
                    let end = bytes[at]; at += 1
                    if end == 125 { return object }; guard end == 44 else { throw NativePushCodecError.malformed }; space()
                }
            }
            if bytes[at] == 91 {
                at += 1; space(); var array: [Any] = []
                if at < bytes.count, bytes[at] == 93 { at += 1; return array }
                while true {
                    array.append(try value(depth + 1)); space(); guard at < bytes.count else { throw NativePushCodecError.malformed }
                    let end = bytes[at]; at += 1
                    if end == 93 { return array }; guard end == 44 else { throw NativePushCodecError.malformed }
                }
            }
            let start = at
            while at < bytes.count && ![9, 10, 13, 32, 44, 93, 125].contains(bytes[at]) { at += 1 }
            guard at > start else { throw NativePushCodecError.malformed }
            do { return try JSONSerialization.jsonObject(with: Data(bytes[start..<at]), options: .fragmentsAllowed) }
            catch { throw NativePushCodecError.malformed }
        }
    }
}
