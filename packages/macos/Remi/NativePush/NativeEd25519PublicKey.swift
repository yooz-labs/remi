import Foundation

/// Public-only reviewed Ed25519 refusal encodings shared by app and NSE.
/// This file contains no private identity or Keychain store.
enum NativeEd25519PublicKey {
    /// Cross-language copy of the reviewed 14 encodings in shared/relay/small-order.ts.
    /// ClientIdentityTests validates this against helper-generated public fixtures;
    /// no new curve algorithm is implemented here (#873).
    private static let smallOrderEncodings: Set<String> = [
        "0100000000000000000000000000000000000000000000000000000000000000",
        "0100000000000000000000000000000000000000000000000000000000000080",
        "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
        "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
        "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "0000000000000000000000000000000000000000000000000000000000000000",
        "0000000000000000000000000000000000000000000000000000000000000080",
        "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
        "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
        "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
        "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
        "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
    ]

    static func isSmallOrder(_ raw: Data) -> Bool {
        smallOrderEncodings.contains(raw.map { String(format: "%02x", $0) }.joined())
    }

}
