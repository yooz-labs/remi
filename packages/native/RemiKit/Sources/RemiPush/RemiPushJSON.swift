import Foundation

/// Package-only adapter: registration replies reuse the bounded original-byte
/// duplicate-field decoder, without exposing it as a notification authority API.
package enum RemiPushJSON {
    package static func object(_ bytes: Data, maximum: Int) throws -> [String: Any] {
        try NativePushCodec.strictObject(bytes, maximum: maximum)
    }
}
