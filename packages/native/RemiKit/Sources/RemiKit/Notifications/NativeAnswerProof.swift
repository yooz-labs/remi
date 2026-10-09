import CryptoKit
import Foundation
import RemiPush

/// Internal tuple oracle includes optional protocol fields. Production make()
/// emits only the required signed choice; the current daemon refuses optionals.
struct NativeAnswerProof: Codable, Sendable {
    struct Selection: Codable, Sendable { let questionIndex: Int; let optionIndices: [Int]; let text: String? }
    let type: String
    let v: Int
    let id: String
    let timestamp: String
    let rid: String
    let machinePublicKey: String
    let devicePublicKey: String
    let sessionId: String
    let runtimeInstance: String
    let questionId: String
    let collapseId: String
    let revision: UInt64
    let contentDigest: String
    let nonce: String
    let issuedAt: UInt64
    let expiresAt: UInt64
    let answer: String
    let claudeSessionId: String?
    let selections: [Selection]?
    let cancel: Bool?
    let message: String?
    var signature: String?

    static func timestamp(_ seconds: UInt64) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date(timeIntervalSince1970: Double(seconds)))
    }
    static func make(_ notification: VerifiedPushNotification, choice: String,
                     identity: ClientIdentity, now: UInt64) throws -> Self {
        guard notification.kind == .question, notification.machine.authority == identity.pushAuthority,
              let session = notification.sessionID, let question = notification.questionID,
              let runtime = notification.runtimeInstance, let selected = choices(notification).first(where: { Data($0.value.utf8) == Data(choice.utf8) }),
              notification.expiresAt > Int64(now) else { throw RelayFailure.expired }
        var proof = Self(type: "native_answer", v: 2, id: UUID().uuidString.lowercased(), timestamp: timestamp(now),
            rid: RelayCrypto.hex(notification.machine.room), machinePublicKey: RelayCrypto.b64(notification.machine.machinePublicKey),
            devicePublicKey: RelayCrypto.b64(identity.publicKeyRaw), sessionId: session, runtimeInstance: runtime,
            questionId: question, collapseId: notification.collapseID, revision: UInt64(notification.revision),
            contentDigest: RelayCrypto.b64(notification.contentDigest), nonce: RelayCrypto.b64(try RelayCrypto.random(32)),
            issuedAt: now, expiresAt: min(now + 30, UInt64(notification.expiresAt)), answer: selected.value,
            claudeSessionId: nil, selections: nil, cancel: nil, message: nil, signature: nil)
        proof.signature = RelayCrypto.b64(try identity.signature(for: proof.signingInput()))
        guard try JSONEncoder().encode(proof).count <= 16384 else { throw RelayFailure.oversize }
        return proof
    }
    /// The source's entire signed YN/YNA semantic shape, including descriptions.
    /// Unsupported forms keep the card readable and require the normal app path.
    static func choices(_ notification: VerifiedPushNotification) -> [VerifiedPushOption] {
        let options = notification.options
        func yes(_ option: VerifiedPushOption) -> Bool { option.isYes && !option.isNo && option.standingGrant == nil }
        func no(_ option: VerifiedPushOption) -> Bool { option.isNo && !option.isYes && option.standingGrant == nil }
        if notification.category == "REMI_YN" {
            guard options.count == 2, yes(options[0]), no(options[1]) else { return [] }
        } else if notification.category == "REMI_YNA" {
            guard options.count == 3, yes(options[0]), no(options[2]), options[1].isYes, !options[1].isNo,
                  options[1].standingGrant == "addRules", options[1].description?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false else { return [] }
        } else { return [] }
        for option in options {
            let label = option.label + (option.description.map { " \u{2014} " + $0 } ?? "") +
                (option.standingGrant == "addRules" ? " · This session" : "")
            guard !option.label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  option.description == nil || option.description?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false,
                  label.count <= 24, label.unicodeScalars.allSatisfy({
                      $0.properties.generalCategory != .control && $0.properties.generalCategory != .format
                  }) else { return [] }
        }
        return options
    }
    func body() throws -> Data {
        func binary(_ text: String, size: Int) throws -> Data {
            let bytes = try RelayCrypto.unb64(text)
            guard bytes.count == size else { throw RelayFailure.malformed }; return bytes
        }
        func optional(_ text: String?) -> Data { text.map { Data([1]) + Data($0.utf8) } ?? Data([0]) }
        func u16(_ value: Int) throws -> Data {
            guard (0...65535).contains(value) else { throw RelayFailure.malformed }
            return Data([UInt8(value >> 8), UInt8(value & 255)])
        }
        guard type == "native_answer", v == 2, issuedAt <= 8_640_000_000_000,
              expiresAt > issuedAt, expiresAt - issuedAt <= 30, timestamp == Self.timestamp(issuedAt),
              (1...9_007_199_254_740_991).contains(revision),
              rid.count == 32, rid.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { throw RelayFailure.malformed }
        for text in [id, sessionId, questionId] { guard !text.isEmpty, text.utf8.count <= 128 else { throw RelayFailure.malformed } }
        guard answer.utf8.count <= 128, claudeSessionId?.utf8.count ?? 0 <= 128,
              message?.utf8.count ?? 0 <= 2048 else { throw RelayFailure.oversize }
        guard !answer.isEmpty || selections != nil || cancel == true,
              !(cancel == true && selections != nil), (selections == nil && cancel != true) || answer.isEmpty else { throw RelayFailure.malformed }
        _ = try binary(collapseId, size: 16)
        let machine = try binary(machinePublicKey, size: 32), device = try binary(devicePublicKey, size: 32)
        guard !ClientIdentity.isSmallOrderPublicKey(machine), !ClientIdentity.isSmallOrderPublicKey(device),
              claudeSessionId == nil || claudeSessionId?.isEmpty == false else { throw RelayFailure.malformed }
        let selected: Data
        if let selections {
            guard (1...4).contains(selections.count) else { throw RelayFailure.malformed }
            var parts = [try u16(selections.count)], previous = -1
            for selection in selections {
                guard selection.questionIndex > previous, selection.optionIndices.count <= 4 else { throw RelayFailure.malformed }
                previous = selection.questionIndex
                var indices = [try u16(selection.optionIndices.count)], last = -1
                for index in selection.optionIndices { guard index > last else { throw RelayFailure.malformed }; last = index; indices.append(try u16(index)) }
                guard selection.text == nil ? !selection.optionIndices.isEmpty : selection.optionIndices.isEmpty && selection.text?.isEmpty == false,
                      selection.text?.utf8.count ?? 0 <= 2048 else { throw RelayFailure.malformed }
                parts.append(try RelayCrypto.tuple(try u16(selection.questionIndex), RelayCrypto.tuple(indices), optional(selection.text)))
            }
            selected = Data([1]) + (try RelayCrypto.tuple(parts))
        } else { selected = Data([0]) }
        var room = Data()
        for offset in stride(from: 0, to: 32, by: 2) {
            let start = rid.index(rid.startIndex, offsetBy: offset), end = rid.index(start, offsetBy: 2)
            guard let byte = UInt8(rid[start..<end], radix: 16) else { throw RelayFailure.malformed }; room.append(byte)
        }
        let bytes = try RelayCrypto.tuple(room, machine, device, Data(id.utf8), Data(sessionId.utf8),
            binary(runtimeInstance, size: 32), Data(questionId.utf8), Data(collapseId.utf8), RelayCrypto.be64(revision),
            binary(contentDigest, size: 32), binary(nonce, size: 32), RelayCrypto.be64(issuedAt), RelayCrypto.be64(expiresAt),
            Data(answer.utf8), optional(claudeSessionId), selected, cancel.map { Data([1, $0 ? 1 : 0]) } ?? Data([0]), optional(message))
        guard bytes.count <= 8192 else { throw RelayFailure.oversize }; return bytes
    }
    func signingInput() throws -> Data {
        try RelayCrypto.tuple(Data("remi-relay-v2 native answer".utf8), Data(SHA256.hash(data: body())))
    }
}
