// Verifies the relay v2 test vectors with Apple CryptoKit (ADR 0034 section 13).
//
//   swift scripts/verify-relay-v2-vectors.swift
//
// This is the check that the primitives the iOS Notification Service Extension
// and the native answer path need exist in CryptoKit with the exact shapes the
// protocol uses: P-256 ECDH, Ed25519 verification, HKDF-SHA256 with a salt,
// AES-256-GCM with a 96-bit counter nonce and associated data, and opening a
// sealed push. It also runs the receiver rules of the data channel and the
// negative cases that only need those primitives. It reads the same file as the
// TypeScript tests and the Python verifier and needs no network.

import CryptoKit
import Foundation

// MARK: helpers

var passed = 0
var failures: [String] = []
var perKind: [String: Int] = [:]

func check(_ ok: Bool, _ what: @autoclosure () -> String, kind: String = "positive") {
    if ok {
        passed += 1
        perKind[kind, default: 0] += 1
    } else {
        failures.append(what())
    }
}

func unhex(_ s: String) -> Data {
    var out = Data()
    var i = s.startIndex
    while i < s.endIndex {
        let j = s.index(i, offsetBy: 2)
        out.append(UInt8(s[i..<j], radix: 16)!)
        i = j
    }
    return out
}

func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

func be16(_ n: Int) -> Data { Data([UInt8(n >> 8), UInt8(n & 0xff)]) }

func be64(_ n: UInt64) -> Data {
    Data((0..<8).map { UInt8((n >> UInt64(56 - 8 * $0)) & 0xff) })
}

/// lps(a, b, ...): each part as be16(length) || bytes.
func lps(_ parts: [Data]) -> Data {
    parts.reduce(Data()) { $0 + be16($1.count) + $1 }
}

func ascii(_ s: String) -> Data { s.data(using: .utf8)! }

func b64urlDecode(_ s: String) -> Data? {
    var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while t.count % 4 != 0 { t += "=" }
    return Data(base64Encoded: t)
}

func sha256(_ d: Data) -> Data { Data(SHA256.hash(data: d)) }

func hkdf(ikm: Data, salt: Data, info: Data, length: Int = 32) -> Data {
    HKDF<SHA256>.deriveKey(
        inputKeyMaterial: SymmetricKey(data: ikm), salt: salt, info: info, outputByteCount: length
    ).withUnsafeBytes { Data($0) }
}

func gcmOpen(key: Data, nonce: Data, aad: Data, body: Data) -> Data? {
    guard body.count >= 16, nonce.count == 12,
        let n = try? AES.GCM.Nonce(data: nonce),
        let box = try? AES.GCM.SealedBox(
            nonce: n, ciphertext: Data(body.prefix(body.count - 16)), tag: Data(body.suffix(16)))
    else { return nil }
    return try? AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad)
}

func gcmSeal(key: Data, nonce: Data, aad: Data, plaintext: Data) -> Data? {
    guard let n = try? AES.GCM.Nonce(data: nonce),
        let box = try? AES.GCM.seal(
            plaintext, using: SymmetricKey(data: key), nonce: n, authenticating: aad)
    else { return nil }
    return box.ciphertext + box.tag
}

func frameNonce(_ counter: UInt64) -> Data { Data(count: 4) + be64(counter) }

func frameAad(type: UInt8, direction: UInt8, counter: UInt64) -> Data {
    ascii("remi-relay-v2") + Data([2, type, direction]) + be64(counter)
}

func ecdh(scalar: Data, peer: Data) -> Data? {
    guard let priv = try? P256.KeyAgreement.PrivateKey(rawRepresentation: scalar),
        let pub = try? P256.KeyAgreement.PublicKey(x963Representation: peer),
        let secret = try? priv.sharedSecretFromKeyAgreement(with: pub)
    else { return nil }
    return secret.withUnsafeBytes { Data($0) }
}

func p256Public(scalar: Data) -> Data? {
    (try? P256.KeyAgreement.PrivateKey(rawRepresentation: scalar))?.publicKey.x963Representation
}

func edVerify(publicKey: Data, signature: Data, message: Data) -> Bool {
    guard let key = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKey) else {
        return false
    }
    return key.isValidSignature(signature, for: message)
}

func deriveKeys(z: Data, h1: Data, psk: Data?) -> (c2h: Data, h2c: Data) {
    let ikm = z + (psk ?? Data())
    return (
        hkdf(ikm: ikm, salt: h1, info: ascii("remi-relay-v2 c2h")),
        hkdf(ikm: ikm, salt: h1, info: ascii("remi-relay-v2 h2c"))
    )
}

typealias Obj = [String: Any]

func str(_ o: Obj, _ k: String) -> String { o[k] as! String }
func data(_ o: Obj, _ k: String) -> Data { unhex(o[k] as! String) }
func optData(_ o: Obj, _ k: String) -> Data? {
    if let s = o[k] as? String { return unhex(s) }
    return nil
}
func int(_ o: Obj, _ k: String) -> Int { (o[k] as! NSNumber).intValue }
func u64(_ o: Obj, _ k: String) -> UInt64 { (o[k] as! NSNumber).uint64Value }

// MARK: load

let scriptURL = URL(fileURLWithPath: CommandLine.arguments[0])
let root =
    CommandLine.arguments.count > 1
    ? URL(fileURLWithPath: CommandLine.arguments[1])
    : scriptURL.deletingLastPathComponent().deletingLastPathComponent()
let path =
    root.appendingPathComponent("packages/shared/tests/fixtures/relay-v2/vectors.json")
let fileData = try Data(contentsOf: path)
let V = try JSONSerialization.jsonObject(with: fileData) as! Obj
let constants = V["constants"] as! Obj
let maxCounter = u64(constants, "maxCounter")
let maxFrame = int(constants, "maxFrame")
let minFrame = int(constants, "minFrame")
let maxPush = int(constants, "maxPushPlaintext")
let identities = V["identities"] as! Obj
let machinePk = data(identities["machine"] as! Obj, "publicKey")
let devicePk = data(identities["device"] as! Obj, "publicKey")
let rid = unhex(str(V, "rid"))

// MARK: identities

for name in ["machine", "device", "impostorMachine"] {
    let id = identities[name] as! Obj
    let key = try Curve25519.Signing.PrivateKey(rawRepresentation: data(id, "seed"))
    check(hex(key.publicKey.rawRepresentation) == str(id, "publicKey"), "ed25519 public key of \(name)")
}
check(hex(Data(sha256(machinePk).prefix(16))) == str(V, "rid"), "rid derivation")

// MARK: sessions

let sessions = V["sessions"] as! Obj
for mode in ["pair", "resume"] {
    let s = sessions[mode] as! Obj
    let psk = optData(s, "psk")
    let client = s["clientEphemeral"] as! Obj
    let host = s["hostEphemeral"] as! Obj

    check(p256Public(scalar: data(client, "scalar")).map(hex) == str(client, "publicKey"), "\(mode) client public key")
    check(p256Public(scalar: data(host, "scalar")).map(hex) == str(host, "publicKey"), "\(mode) host public key")
    let zc = ecdh(scalar: data(client, "scalar"), peer: data(host, "publicKey"))
    let zh = ecdh(scalar: data(host, "scalar"), peer: data(client, "publicKey"))
    check(zc.map(hex) == str(s, "z") && zh.map(hex) == str(s, "z"), "\(mode) ECDH from both sides")

    // H1 and the host signature
    let modeByte: UInt8 = mode == "pair" ? 1 : 2
    let h1 = sha256(
        lps([
            ascii("remi-relay-v2 H1"), rid, Data([2]), Data([modeByte]),
            data(client, "publicKey"), data(s, "clientNonce"), data(host, "publicKey"), data(s, "hostNonce"),
        ]))
    check(hex(h1) == str(s, "h1"), "\(mode) H1")
    let hostInput = lps([ascii("remi-relay-v2 host"), h1])
    check(hex(hostInput) == str(s, "hostSigningInput"), "\(mode) host signing input")
    check(edVerify(publicKey: machinePk, signature: data(s, "hostSignature"), message: hostInput), "\(mode) host signature verifies")

    // key schedule
    let keys = deriveKeys(z: unhex(str(s, "z")), h1: h1, psk: psk)
    let recorded = s["keys"] as! Obj
    check(hex(keys.c2h) == str(recorded, "c2h") && hex(keys.h2c) == str(recorded, "h2c"), "\(mode) HKDF keys")

    // H2 and the client signature
    let name = ascii(str(s, "deviceName"))
    let h2 = sha256(lps([ascii("remi-relay-v2 H2"), h1, data(s, "hostSignature"), devicePk, name]))
    check(hex(h2) == str(s, "h2"), "\(mode) H2")
    let clientInput = lps([ascii("remi-relay-v2 client"), h2])
    check(edVerify(publicKey: devicePk, signature: data(s, "clientSignature"), message: clientInput), "\(mode) client signature verifies")

    // auth and ready: counter-0 AEAD frames
    let authAad = frameAad(type: 1, direction: 1, counter: 0)
    check(hex(authAad) == str(s, "authAad") && hex(frameNonce(0)) == str(s, "authNonce"), "\(mode) auth nonce and AAD")
    let authOpen = gcmOpen(key: keys.c2h, nonce: frameNonce(0), aad: authAad, body: data(s, "authCiphertext"))
    check(authOpen.map(hex) == str(s, "authPlaintext"), "\(mode) auth opens")
    check(gcmSeal(key: keys.c2h, nonce: frameNonce(0), aad: authAad, plaintext: data(s, "authPlaintext")).map(hex) == str(s, "authCiphertext"), "\(mode) auth seals to the same bytes")
    let readyAad = frameAad(type: 2, direction: 2, counter: 0)
    check(hex(readyAad) == str(s, "readyAad"), "\(mode) ready AAD")
    check(gcmOpen(key: keys.h2c, nonce: frameNonce(0), aad: readyAad, body: data(s, "readyCiphertext")).map(hex) == str(s, "readyPlaintext"), "\(mode) ready opens")

    // data frames in both directions: 96-bit counter nonce, 24-byte AAD
    let dataSection = s["data"] as! Obj
    for (dirName, dir, key) in [("c2h", UInt8(1), keys.c2h), ("h2c", UInt8(2), keys.h2c)] {
        for entry in dataSection[dirName] as! [Obj] {
            let counter = u64(entry, "counter")
            let frame = data(entry, "frame")
            let aad = frameAad(type: 3, direction: dir, counter: counter)
            check(hex(aad) == str(entry, "aad") && hex(frameNonce(counter)) == str(entry, "nonce"), "\(mode) \(dirName) \(counter) nonce and AAD")
            check(frame[0] == 3 && frame.subdata(in: 1..<9) == be64(counter), "\(mode) \(dirName) \(counter) header")
            let opened = gcmOpen(key: key, nonce: frameNonce(counter), aad: aad, body: frame.subdata(in: 9..<frame.count))
            check(opened.map(hex) == str(entry, "plaintext"), "\(mode) \(dirName) \(counter) opens")
            // the same key under the other direction's AAD must not open it
            let swapped = frameAad(type: 3, direction: 3 - dir, counter: counter)
            check(gcmOpen(key: key, nonce: frameNonce(counter), aad: swapped, body: frame.subdata(in: 9..<frame.count)) == nil, "\(mode) \(dirName) \(counter) refuses the other direction", kind: "direction")
        }
    }
}

// MARK: sealed push

func sealLps(_ recipientPublic: Data) -> Data { lps([ascii("remi-relay-v2 seal"), recipientPublic]) }

/// Returns the plaintext, or nil on any failure (the format's single DECRYPT outcome).
func openSeal(scalar: Data, aad: Data, sealed: Data) -> Data? {
    guard sealed.count >= 65 + 12 + 16 + 1, sealed.count <= 65 + 12 + 16 + maxPush,
        let priv = try? P256.KeyAgreement.PrivateKey(rawRepresentation: scalar)
    else { return nil }
    let ephemeral = Data(sealed.prefix(65))
    guard let shared = ecdh(scalar: scalar, peer: ephemeral) else { return nil }
    let recipientPublic = priv.publicKey.x963Representation
    let key = hkdf(ikm: shared, salt: ephemeral, info: sealLps(recipientPublic))
    return gcmOpen(
        key: key, nonce: Data(sealed.subdata(in: 65..<77)), aad: aad,
        body: Data(sealed.suffix(from: 77)))
}

let seal = V["seal"] as! Obj
let sealed = openSeal(scalar: data(seal, "recipientScalar"), aad: data(seal, "aad"), sealed: data(seal, "sealed"))
check(sealed.map(hex) == str(seal, "plaintext"), "sealed push opens")
check(p256Public(scalar: data(seal, "recipientScalar")).map(hex) == str(seal, "recipientPublicKey"), "seal recipient public key")
check(hex(rid + ascii(str(seal, "questionId"))) == str(seal, "aad"), "push AAD is rid then question id")

// MARK: negative cases that need only the primitives

var skipped: [String: Int] = [:]
for n in V["negative"] as! [Obj] {
    let kind = str(n, "kind")
    let name = str(n, "name")
    let accept = str(n, "expect") == "accept"
    switch kind {
    case "ec_point":
        let ok = (try? P256.KeyAgreement.PublicKey(x963Representation: data(n, "publicKey"))) != nil
        check(ok == accept, "\(kind): \(name)", kind: kind)

    case "seal_open":
        let ok = openSeal(scalar: data(n, "recipientScalar"), aad: data(n, "aad"), sealed: data(n, "sealed")) != nil
        check(ok == accept, "\(kind): \(name)", kind: kind)

    case "admission_verify":
        let role = str(n, "role")
        let nonce = data(n, "nonce")
        let ridValue = data(n, "rid")
        let pk = data(n, "publicKey")
        var ok = ridValue.count == 16 && nonce.count == 32
        if ok && role == "host" { ok = Data(sha256(pk).prefix(16)) == ridValue }
        if ok {
            let label = role == "host" ? "remi-relay-v2 admit host" : "remi-relay-v2 admit client"
            ok = edVerify(publicKey: pk, signature: data(n, "signature"), message: lps([ascii(label), ridValue, nonce]))
        }
        check(ok == accept, "\(kind): \(name)", kind: kind)

    case "frame_length":
        let len = int(n, "length")
        let ok = len >= minFrame && len <= maxFrame
        check(ok == accept, "\(kind): \(name)", kind: kind)

    case "auth_open":
        let hostPsk = optData(n, "psk")
        let keys = deriveKeys(z: data(n, "z"), h1: data(n, "h1"), psk: hostPsk)
        let frame = try JSONSerialization.jsonObject(with: ascii(str(n, "auth"))) as! Obj
        let body = b64urlDecode(str(frame, "c"))!
        let opened = gcmOpen(key: keys.c2h, nonce: frameNonce(0), aad: frameAad(type: 1, direction: 1, counter: 0), body: body)
        check((opened != nil) == accept, "\(kind): \(name)", kind: kind)
        if n["senderPsk"] != nil {
            let sender = n["senderPsk"] is NSNull ? nil : unhex(n["senderPsk"] as! String)
            let senderKeys = deriveKeys(z: data(n, "z"), h1: data(n, "h1"), psk: sender)
            let control = gcmOpen(key: senderKeys.c2h, nonce: frameNonce(0), aad: frameAad(type: 1, direction: 1, counter: 0), body: body)
            check(control != nil, "\(kind) control: \(name)", kind: "auth_open control")
        }

    case "ready_open":
        let keys = deriveKeys(z: data(n, "z"), h1: data(n, "h1"), psk: optData(n, "psk"))
        let frame = try JSONSerialization.jsonObject(with: ascii(str(n, "ready"))) as! Obj
        let body = b64urlDecode(str(frame, "c"))!
        let opened = gcmOpen(key: keys.h2c, nonce: frameNonce(0), aad: frameAad(type: 2, direction: 2, counter: 0), body: body)
        let wanted: UInt8 = str(n, "mode") == "pair" ? 1 : 2
        let ok = opened != nil && opened!.count == 1 && opened![0] == wanted
        check(ok == accept, "\(kind): \(name)", kind: kind)

    case "hello_ack_verify":
        let hello = try JSONSerialization.jsonObject(with: ascii(str(n, "clientHello"))) as! Obj
        let ack = try JSONSerialization.jsonObject(with: ascii(str(n, "helloAck"))) as! Obj
        let pk = data(n, "machinePublicKey")
        let mode: UInt8 = str(hello, "m") == "pair" ? 1 : 2
        let h1 = sha256(
            lps([
                ascii("remi-relay-v2 H1"), Data(sha256(pk).prefix(16)), Data([2]), Data([mode]),
                b64urlDecode(str(hello, "e"))!, b64urlDecode(str(hello, "n"))!,
                b64urlDecode(str(ack, "e"))!, b64urlDecode(str(ack, "n"))!,
            ]))
        let ok = edVerify(publicKey: pk, signature: b64urlDecode(str(ack, "s"))!, message: lps([ascii("remi-relay-v2 host"), h1]))
        check(ok == accept, "\(kind): \(name)", kind: kind)

    case "data_sequence":
        let key = data(n, "key")
        let direction = UInt8(int(n, "direction"))
        var next = u64(n, "startRecv")
        var accepted = 0
        var code: String? = nil
        for f in n["frames"] as! [String] {
            let b = unhex(f)
            if b.count < minFrame { code = "MALFORMED"; break }
            if b.count > maxFrame { code = "OVERSIZE"; break }
            if b[0] != 3 { code = "TYPE"; break }
            let counter = b.subdata(in: 1..<9).reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
            if counter > maxCounter { code = "COUNTER_LIMIT"; break }
            if counter != next { code = "COUNTER"; break }
            let aad = frameAad(type: 3, direction: direction, counter: counter)
            if gcmOpen(key: key, nonce: frameNonce(counter), aad: aad, body: b.subdata(in: 9..<b.count)) == nil { code = "DECRYPT"; break }
            next = counter + 1
            accepted += 1
        }
        let wantedCode = n["code"] as? String
        check(accepted == int(n, "accepted") && code == wantedCode, "\(kind): \(name) (accepted \(accepted), code \(code ?? "none"))", kind: kind)

    default:
        // control_decode, token_decode and auth_check need JSON canonicalization, URL rules and
        // the whole auth layout; the extension does not parse them, so they are the Python and
        // TypeScript verifiers' to cover.
        skipped[kind, default: 0] += 1
    }
}

// MARK: report

print("checks passed: \(passed)")
for (k, v) in perKind.sorted(by: { $0.key < $1.key }) { print("  \(k): \(v)") }
print("negative kinds not covered here (covered by the Python and TypeScript verifiers): \(skipped.sorted(by: { $0.key < $1.key }).map { "\($0.key)=\($0.value)" }.joined(separator: ", "))")
if failures.isEmpty {
    print("ALL OK")
} else {
    print("FAILURES (\(failures.count)):")
    for f in failures { print("  \(f)") }
    exit(1)
}
