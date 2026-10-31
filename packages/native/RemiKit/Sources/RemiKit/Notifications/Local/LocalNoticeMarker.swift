import CryptoKit
import Foundation

/// Opaque, app-local identifiers. These values are never authorization to answer a question.
struct LocalNoticeMarker: Codable, Sendable, Equatable {
    let version: Int
    let requestID: String
    let ownerIndex: Data
    let sequence: Int64
    let questionIndex: Data
    let authentication: Data

    var systemIdentifier: String { "remi.local.v1." + requestID }

    /// The only local payload is opaque metadata; an old destination decoder cannot route it.
    func userInfo() throws -> [AnyHashable: Any] {
        let bytes = try JSONEncoder().encode(self)
        guard bytes.count <= 1_024, let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else {
            throw LocalNoticeError.invalid
        }
        return ["remiLocal": object]
    }

    /// Strict shape before decode. The caller must independently exclude remote/remiPush requests.
    static func parse(userInfo: [AnyHashable: Any]) throws -> LocalNoticeMarker {
        guard userInfo.count == 1, let object = userInfo["remiLocal"] as? [String: Any],
              Set(object.keys) == Set(["version", "requestID", "ownerIndex", "sequence", "questionIndex", "authentication"]),
              JSONSerialization.isValidJSONObject(object) else { throw LocalNoticeError.invalid }
        let bytes = try JSONSerialization.data(withJSONObject: object)
        guard bytes.count <= 1_024 else { throw LocalNoticeError.invalid }
        do { return try JSONDecoder().decode(Self.self, from: bytes) }
        catch { throw LocalNoticeError.invalid }
    }
}

enum LocalNoticeError: Error, Equatable {
    case invalid, unavailable, corrupt, capacity, busy, changed
}

/// Distinct HKDF domains avoid making an owner index useful as a marker key (#1720).
struct LocalNoticeKeys: Sendable {
    private let ownerKey: SymmetricKey
    private let questionKey: SymmetricKey
    private let markerKey: SymmetricKey

    init(root: Data) throws {
        guard root.count == 32 else { throw LocalNoticeError.invalid }
        let key = SymmetricKey(data: root)
        func derive(_ label: String) -> SymmetricKey {
            HKDF<SHA256>.deriveKey(inputKeyMaterial: key, salt: Data("remi.local.notice.v1".utf8),
                info: Data(label.utf8), outputByteCount: 32)
        }
        ownerKey = derive("owner"); questionKey = derive("question"); markerKey = derive("marker")
    }

    private func tuple(_ parts: [Data]) throws -> Data {
        var out = Data()
        for part in parts {
            guard part.count <= 512 else { throw LocalNoticeError.invalid }
            var length = UInt32(part.count).bigEndian
            withUnsafeBytes(of: &length) { out.append(contentsOf: $0) }
            out.append(part)
        }
        return out
    }

    func ownerIndex(runtimeOwner: UUID) throws -> Data {
        let value = try tuple([Data("owner-v1".utf8), Data(runtimeOwner.uuidString.lowercased().utf8)])
        return Data(HMAC<SHA256>.authenticationCode(for: value, using: ownerKey))
    }

    func questionIndex(owner: Data, sessionID: String, questionID: String) throws -> Data {
        guard owner.count == 32, !sessionID.isEmpty, !questionID.isEmpty else { throw LocalNoticeError.invalid }
        let value = try tuple([Data("question-v1".utf8), owner, Data(sessionID.utf8), Data(questionID.utf8)])
        return Data(HMAC<SHA256>.authenticationCode(for: value, using: questionKey))
    }

    private func markerData(requestID: String, owner: Data, sequence: Int64, question: Data) throws -> Data {
        guard let parsed = UUID(uuidString: requestID), parsed.uuidString.lowercased() == requestID,
              owner.count == 32, question.count == 32, sequence > 0 else { throw LocalNoticeError.invalid }
        var number = UInt64(sequence).bigEndian
        let bytes = withUnsafeBytes(of: &number) { Data($0) }
        return try tuple([Data("marker-v1".utf8), Data(requestID.utf8), owner, bytes, question])
    }

    func marker(requestID: String, owner: Data, sequence: Int64, question: Data) throws -> LocalNoticeMarker {
        let data = try markerData(requestID: requestID, owner: owner, sequence: sequence, question: question)
        return LocalNoticeMarker(version: 1, requestID: requestID, ownerIndex: owner, sequence: sequence,
            questionIndex: question, authentication: Data(HMAC<SHA256>.authenticationCode(for: data, using: markerKey)))
    }

    func verifies(_ marker: LocalNoticeMarker, systemIdentifier: String) -> Bool {
        guard marker.version == 1, marker.authentication.count == 32,
              marker.systemIdentifier == systemIdentifier,
              let data = try? markerData(requestID: marker.requestID, owner: marker.ownerIndex,
                  sequence: marker.sequence, question: marker.questionIndex) else { return false }
        return HMAC<SHA256>.isValidAuthenticationCode(marker.authentication, authenticating: data, using: markerKey)
    }
}
