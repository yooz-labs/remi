import Foundation
import RemiPush

public struct RelayPushResponse: Sendable, Equatable, Decodable {
    public let type: String
    public let id: String
    public let timestamp: String
    public let requestId: String
    public let success: Bool
    public let keyVersion: Int?
    public let error: String?
    static func decode(_ bytes: Data) throws -> Self {
        let value = try JSONDecoder().decode(Self.self, from: bytes)
        let fields = try RemiPushJSON.object(bytes, maximum: 16384)
        guard !value.id.isEmpty, !value.requestId.isEmpty,
              ["secure_push_register_response", "secure_push_unregister_response"].contains(value.type) else {
            throw RelayFailure.malformed
        }
        var keys: Set<String> = ["type", "id", "timestamp", "requestId", "success"]
        if value.success {
            if value.type == "secure_push_register_response" {
                keys.insert("keyVersion")
                guard let version = value.keyVersion, version >= 1, version <= 9_007_199_254_740_991 else { throw RelayFailure.malformed }
            }
        } else {
            keys.insert("error")
            guard let error = value.error, ["UNSUPPORTED", "NOT_AUTHORIZED", "NOT_ENROLLED", "INVALID_SUBSCRIPTION",
                "STALE_KEY_VERSION", "CAPACITY", "STORE_ERROR"].contains(error) else { throw RelayFailure.malformed }
        }
        guard Set(fields.keys) == keys else { throw RelayFailure.malformed }
        return value
    }
}

struct RelayPushRequest: Encodable, Sendable {
    let type: String
    let id: String
    let timestamp: String
    let token: String?
    let environment: String?
    let pushPublicKey: String?
    let keyVersion: Int?
}
enum RelayRPCExpected: Sendable {
    case push(type: String, keyVersion: Int?)
    case answer(session: String, question: String)
}
enum RelayRPCResult: Sendable { case push(RelayPushResponse), answer(AnswerResultMessage) }
struct RelayRPCWaiter {
    let expected: RelayRPCExpected
    let continuation: CheckedContinuation<RelayRPCResult, any Error>
    let timeout: Task<Void, Never>
}
