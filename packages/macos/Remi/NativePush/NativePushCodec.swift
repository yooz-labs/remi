import CryptoKit
import Foundation

enum NativePushCodecError: Error { case malformed, oversize, decrypt, badSignature, expired, unavailable, changed }

/// The original signed capsule is the sole input to verification. This decoder
/// never creates keys, installs trust, records lifecycle state or grants actions.
enum NativePushCodec {
    enum Kind: String { case question, turnComplete = "turn_complete", subagentAlert = "subagent_alert", harnessDenied = "harness_denied", turnFailed = "turn_failed", dismiss }
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
    struct Carrier: Equatable {
        let rid: String; let collapseId: String; let keyVersion: Int64; let kind: Kind; let sealed: String
        var userInfo: [String: Any] {
            ["v": 2, "rid": rid, "collapseId": collapseId, "keyVersion": keyVersion, "kind": kind.rawValue, "sealed": sealed]
        }
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
    static func parseCarrier(_ bytes: Data) throws -> Carrier { throw NativePushCodecError.malformed }
    static func open(userInfo: [AnyHashable: Any], state: NativePushState, keys: NativePushKeyStore, now: Int64) throws -> VerifiedPush {
        // Constructible fail-closed boundary for the first real codec pins (#1200).
        throw NativePushCodecError.unavailable
    }
}
