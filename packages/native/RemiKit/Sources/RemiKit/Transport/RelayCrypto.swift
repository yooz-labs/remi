import CryptoKit
import CoreFoundation
import Foundation
import Security

enum RelayFailure: Error, Sendable, Equatable {
    case malformed, version, type, mode, modeMismatch, signature, expired, state, decrypt, counter, counterLimit, ended, closed, oversize, io, token

    var wireCode: String {
        switch self {
        case .signature: "BAD_SIGNATURE"
        case .counterLimit: "COUNTER_LIMIT"
        case .modeMismatch: "MODE_MISMATCH"
        default: String(describing: self).uppercased()
        }
    }
}

/// ADR 0034 byte encodings. Only CryptoKit implements the cryptographic primitives.
enum RelayCrypto {
    static let maxCounter: UInt64 = 1 << 40
    static let maxPlaintext = 524_288
    static let maxFrame = maxPlaintext + 25

    static func hash(_ data: Data) -> Data { Data(SHA256.hash(data: data)) }
    static func room(_ machine: Data) -> Data { hash(machine).prefix(16) }
    static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
    static func b64(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    static func unb64(_ text: String) throws -> Data {
        guard text.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0)
            || (48...57).contains($0) || $0 == 45 || $0 == 95 }), text.count % 4 != 1,
              let data = Data(base64Encoded: text.replacingOccurrences(of: "-", with: "+")
                .replacingOccurrences(of: "_", with: "/")
                + String(repeating: "=", count: (4 - text.count % 4) % 4)), b64(data) == text
        else { throw RelayFailure.malformed }
        return data
    }
    static func be64(_ number: UInt64) -> Data {
        Data((0..<8).map { UInt8(truncatingIfNeeded: number >> (56 - $0 * 8)) })
    }
    static func number(_ data: Data) -> UInt64 {
        data.reduce(0) { ($0 << 8) | UInt64($1) }
    }
    static func tuple(_ parts: Data...) throws -> Data { try tuple(parts) }
    static func tuple(_ parts: [Data]) throws -> Data {
        var output = Data()
        for part in parts {
            guard part.count <= 65_535 else { throw RelayFailure.malformed }
            output.append(contentsOf: [UInt8(part.count >> 8), UInt8(part.count & 255)])
            output.append(part)
        }
        return output
    }
    static func text(_ value: String) -> Data { Data(value.utf8) }
    static func random(_ count: Int) throws -> Data {
        guard count > 0 else { throw RelayFailure.malformed }
        var data = Data(count: count)
        let result = data.withUnsafeMutableBytes {
            guard $0.count == count, let address = $0.baseAddress else { return errSecParam }
            return SecRandomCopyBytes(kSecRandomDefault, count, address)
        }
        guard result == errSecSuccess else { throw RelayFailure.io }
        return data
    }
    static func verify(_ signature: Data, input: Data, key: Data) -> Bool {
        guard !ClientIdentity.isSmallOrderPublicKey(key),
              let publicKey = try? Curve25519.Signing.PublicKey(rawRepresentation: key)
        else { return false }
        return publicKey.isValidSignature(signature, for: input)
    }
    static func derive(_ input: Data, salt: Data, label: String) -> SymmetricKey {
        HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: input), salt: salt,
            info: text(label), outputByteCount: 32)
    }
    static func nonce(_ counter: UInt64) -> Data { Data(repeating: 0, count: 4) + be64(counter) }
    static func aad(_ type: UInt8, _ direction: UInt8, _ counter: UInt64) -> Data {
        text("remi-relay-v2") + Data([2, type, direction]) + be64(counter)
    }
    static func seal(_ plaintext: Data, key: SymmetricKey, type: UInt8, direction: UInt8, counter: UInt64) throws -> Data {
        let box = try AES.GCM.seal(plaintext, using: key, nonce: AES.GCM.Nonce(data: nonce(counter)),
            authenticating: aad(type, direction, counter))
        return box.ciphertext + box.tag
    }
    static func open(_ ciphertext: Data, key: SymmetricKey, type: UInt8, direction: UInt8, counter: UInt64) throws -> Data {
        guard ciphertext.count >= 16 else { throw RelayFailure.decrypt }
        do {
            let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce(counter)),
                ciphertext: ciphertext.dropLast(16), tag: ciphertext.suffix(16))
            return try AES.GCM.open(box, using: key, authenticating: aad(type, direction, counter))
        } catch { throw RelayFailure.decrypt }
    }

    /// Canonical reconstruction rejects duplicate keys, whitespace, key order and alternate escapes.
    static func control(_ frame: String, type: String, fields: [(String, ClosedRange<Int>)]) throws -> [Data] {
        guard frame.utf8.count <= 512 else { throw RelayFailure.oversize }
        guard let object = try? JSONSerialization.jsonObject(with: text(frame)) as? [String: Any] else {
            throw RelayFailure.malformed
        }
        guard let number = object["v"] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue.rounded(.towardZero) == number.doubleValue
        else { throw RelayFailure.malformed }
        guard number.doubleValue == 2 else { throw RelayFailure.version }
        guard object["t"] as? String == type else { throw RelayFailure.type }
        let values = try fields.map { name, range in
            let bytes = try unb64(try field(object, name))
            guard range.contains(bytes.count) else { throw RelayFailure.malformed }
            return bytes
        }
        guard encodeControl(type, fields: zip(fields.map(\.0), values).map { ($0, b64($1)) }) == frame else {
            throw RelayFailure.malformed
        }
        return values
    }
    static func field(_ object: [String: Any], _ key: String) throws -> String {
        guard let value = object[key] as? String else { throw RelayFailure.malformed }
        return value
    }
    static func encodeControl(_ type: String, fields: [(String, String)]) -> String {
        "{\"v\":2,\"t\":\"\(type)\"" + fields.map { ",\"\($0)\":\"\($1)\"" }.joined() + "}"
    }
}
